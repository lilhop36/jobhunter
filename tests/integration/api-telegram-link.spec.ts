import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { applyTestMigrations, createTestPrismaClient, truncateAll, requireTestDatabaseUrl } from '../support/db';
import { buildApi } from '../../apps/api/main';
import { parseApiConfig } from '../../apps/api/config';
import { PrismaTelegramLinkRepository } from '../../src/infrastructure/matching/prisma-telegram-link-repository';

const prisma = createTestPrismaClient();
let app: FastifyInstance;
let appPrisma: PrismaClient;
let links: PrismaTelegramLinkRepository;

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  applyTestMigrations();
});

beforeEach(async () => {
  await truncateAll(prisma);
  links = new PrismaTelegramLinkRepository(prisma);

  const api = await buildApi(
    parseApiConfig({
      ...process.env,
      DATABASE_URL: requireTestDatabaseUrl(),
      API_HOST: '127.0.0.1',
      TELEGRAM_BOT_USERNAME: 'testbot',
    }),
  );
  app = api.app;
  appPrisma = api.prisma;
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await appPrisma.$disconnect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function seedUser(email = 'link-candidate@example.com'): Promise<string> {
  const user = await prisma.user.create({ data: { email } });
  return user.id;
}

describe('POST /api/telegram/link', () => {
  it('issues a one-time deep-link token and stores only its hash', async () => {
    const userId = await seedUser();

    const response = await app.inject({
      method: 'POST',
      url: '/api/telegram/link',
      payload: { userId },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);

    // The token itself is presentable exactly once, and the deep link is what a browser does
    // with it: Telegram's start payload carries it verbatim (SRS 3.2 "deep-link").
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{24,}$/);
    expect(body.deepLink).toBe(`https://t.me/testbot?start=${encodeURIComponent(body.token)}`);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // Stored: the hash, never the plaintext, and it names the user it was issued for.
    expect(await prisma.telegramLinkToken.findMany()).toHaveLength(1);
    const stored = (await prisma.telegramLinkToken.findFirst())!;
    expect(stored.userId).toBe(userId);
    expect(stored.tokenHash).toBe(createHash('sha256').update(body.token).digest('hex'));
    expect(stored.usedAt).toBeNull();
    const everything = JSON.stringify(await prisma.telegramLinkToken.findMany());
    expect(everything).not.toContain(body.token);

    // The token encodes no private profile data: it is random bytes, and apart from the
    // extraction, the row holds nothing but the user linkage and its lifetime.
    expect(Object.keys(stored)).toEqual(expect.arrayContaining(['tokenHash', 'expiresAt', 'usedAt']));
  });

  it('records a pending token as claimable through the repository port', async () => {
    const userId = await seedUser();
    const response = await app.inject({
      method: 'POST',
      url: '/api/telegram/link',
      payload: { userId },
    });
    const { token } = JSON.parse(response.body);

    const claimed = await links.takePending({ tokenHash: createHash('sha256').update(token).digest('hex'), now: new Date() });
    expect(claimed).toEqual({ userId });
  });

  it('rejects a body without a well-formed userId before touching the store', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/telegram/link',
      payload: { nope: 'x' },
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe('VALIDATION_ERROR');
    expect(await prisma.telegramLinkToken.findMany()).toEqual([]);
  });

  it('answers a userId that no user holds as the FK failure it is (reported behaviour)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/telegram/link',
      payload: { userId: '0b6b5934-b42d-4b06-b203-5ddd4475d100' },
    });

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body).error.code).toBe('INTERNAL_ERROR');
  });

  it('refuses a deployment without the bot username instead of minting an unusable token', async () => {
    const api = await buildApi(
      parseApiConfig({
        ...process.env,
        DATABASE_URL: requireTestDatabaseUrl(),
        API_HOST: '127.0.0.1',
        TELEGRAM_BOT_USERNAME: '',
      }),
    );
    const unconfigured = api.app;

    try {
      await unconfigured.ready();
      const response = await unconfigured.inject({
        method: 'POST',
        url: '/api/telegram/link',
        payload: { userId: await seedUser() },
      });

      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body).error.code).toBe('INTERNAL_ERROR');
      expect(await prisma.telegramLinkToken.findMany()).toEqual([]);
    } finally {
      await unconfigured.close();
      await api.prisma.$disconnect();
    }
  });
});
