import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  CreateTelegramLinkToken,
  ResolveTelegramDeepLink,
  TELEGRAM_LINK_TOKEN_TTL_SECONDS,
} from '../../src/application/telegram/telegram-linking';

/**
 * In-memory stand-ins: the routes over these use cases behave like their fakes here, so the
 * only Prisma-specific integration test is the repository contract test (tests/integration).
 */

interface TokenRow {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
}

class FakeTokenStore {
  rows: TokenRow[] = [];

  async issue(input: { userId: string; tokenHash: string; expiresAt: Date }): Promise<void> {
    this.rows.push({ ...input, usedAt: null });
  }

  /** Same one-statement semantics the port requires: claim or null, never twice. */
  async takePending(input: { tokenHash: string; now: Date }): Promise<{ userId: string } | null> {
    const row = this.rows.find(
      (candidate) =>
        candidate.tokenHash === input.tokenHash &&
        candidate.usedAt === null &&
        candidate.expiresAt > input.now,
    );
    if (row === undefined) return null;
    row.usedAt = input.now;
    return { userId: row.userId };
  }
}

class FakeDestinationStore {
  byUser = new Map<string, string>();

  async setDestination(input: { userId: string; chatId: string }): Promise<'linked' | 'relinked'> {
    const outcome = this.byUser.has(input.userId) ? 'relinked' : 'linked';
    this.byUser.set(input.userId, input.chatId);
    return outcome;
  }
}

const NOW = new Date('2026-10-20T12:00:00.000Z');
const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');

describe('CreateTelegramLinkToken', () => {
  it('returns the plaintext token once and stores only its hash, expiring in ten minutes', async () => {
    const tokens = new FakeTokenStore();
    const created = await new CreateTelegramLinkToken({ tokens }).run({ userId: 'u1', now: NOW });

    expect(created.expiresAt.getTime()).toBe(NOW.getTime() + TELEGRAM_LINK_TOKEN_TTL_SECONDS * 1000);

    // The plaintext reaches the caller but never the store: the row only knows the hash.
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{24,}$/);
    expect(tokens.rows).toHaveLength(1);
    expect(tokens.rows[0].tokenHash).toBe(hashOf(created.token));
    expect(JSON.stringify(tokens)).not.toContain(created.token);
  });

  it('issues two independent tokens for the same user', async () => {
    const tokens = new FakeTokenStore();
    const useCase = new CreateTelegramLinkToken({ tokens });
    const first = await useCase.run({ userId: 'u1', now: NOW });
    const second = await useCase.run({ userId: 'u1', now: NOW });

    expect(first.token).not.toBe(second.token);
    expect(tokens.rows).toHaveLength(2);
    expect(tokens.rows[0].tokenHash).not.toBe(tokens.rows[1].tokenHash);
  });
});

describe('ResolveTelegramDeepLink', () => {
  it('links the claiming token to the chat once, then the same token is invalid', async () => {
    const tokens = new FakeTokenStore();
    const destinations = new FakeDestinationStore();
    const created = await new CreateTelegramLinkToken({ tokens }).run({ userId: 'u1', now: NOW });
    const resolve = (now: Date) =>
      new ResolveTelegramDeepLink({ tokens, destinations }).run({
        token: created.token,
        chatId: '483920',
        now,
      });

    expect(await resolve(NOW)).toBe('linked');
    expect(destinations.byUser.get('u1')).toBe('483920');
    // One-time: the second use reports invalid and does not rewrite the destination.
    expect(await resolve(new Date(NOW.getTime() + 1000))).toBe('invalid');
    expect(destinations.byUser.get('u1')).toBe('483920');
  });

  it('rejects an expired token and writes nothing', async () => {
    const tokens = new FakeTokenStore();
    const destinations = new FakeDestinationStore();
    const created = await new CreateTelegramLinkToken({ tokens }).run({ userId: 'u1', now: NOW });

    const late = new Date(NOW.getTime() + TELEGRAM_LINK_TOKEN_TTL_SECONDS * 1000 + 1);
    expect(
      await new ResolveTelegramDeepLink({ tokens, destinations }).run({
        token: created.token,
        chatId: '483920',
        now: late,
      }),
    ).toBe('invalid');
    expect(destinations.byUser.size).toBe(0);
  });

  it('rejects a token that was never issued and a wrong token outright', async () => {
    const tokens = new FakeTokenStore();
    const destinations = new FakeDestinationStore();
    const resolve = new ResolveTelegramDeepLink({ tokens, destinations });

    expect(await resolve.run({ token: 'no-such-token', chatId: '483920', now: NOW })).toBe('invalid');
    expect(destinations.byUser.size).toBe(0);
  });

  it('relinks when the user holds an older destination (one destination per user)', async () => {
    const tokens = new FakeTokenStore();
    const destinations = new FakeDestinationStore();
    destinations.byUser.set('u1', '111111');
    const created = await new CreateTelegramLinkToken({ tokens }).run({ userId: 'u1', now: NOW });

    const outcome = await new ResolveTelegramDeepLink({ tokens, destinations }).run({
      token: created.token,
      chatId: '483920',
      now: NOW,
    });
    expect(outcome).toBe('relinked');
    expect(destinations.byUser.get('u1')).toBe('483920');
  });
});
