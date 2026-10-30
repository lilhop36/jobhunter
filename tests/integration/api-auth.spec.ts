import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { mintApiCredential, mintLoginCode } from '@application/auth/credentials';
import {
  createSession,
  csrfSetCookie,
  sessionSetCookie,
} from '@application/web/session';
import {
  applyTestMigrations,
  createTestPrismaClient,
  truncateAll,
} from '../support/db';
import { authorized, TEST_AUTH_SECRET, testApiConfig } from '../support/api';
import { buildApi } from '../../apps/api/main';

/**
 * Who may ask (SRS 8.1, 8.2, 8.5; ADR-0011).
 *
 * The audit's H2 finding was that any loopback caller could name any `userId`, so every route
 * answered for whoever the request claimed. What is pinned here is the other side of that: a
 * request that proves nothing gets nothing, a request that proves *which* candidate it speaks for
 * gets that candidate's data, and a request addressed to some other host or origin is refused
 * before it reaches a handler.
 *
 * Sessions are created through the real store rather than by logging in, because the login flow is
 * the web pages' business and has its own suite (`web-sign-in`); the guard only reads the cookie.
 */

const prisma = createTestPrismaClient();
/** The `Host` a locally bound API answers for; the port is part of the header, not the policy. */
const HOST = '127.0.0.1:3001';

let app: FastifyInstance;
let appPrisma: PrismaClient;
let counter = 0;
let userId: string;

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  applyTestMigrations();
});

beforeEach(async () => {
  await truncateAll(prisma);
  userId = (
    await prisma.user.create({
      data: { email: `auth-${Date.now()}-${counter++}@example.test` },
      select: { id: true },
    })
  ).id;

  const api = await buildApi(testApiConfig({ TELEGRAM_BOT_USERNAME: 'testbot' }));
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

/** The cookies a signed-in browser sends, from the same store the guard reads. */
function sessionCookies(forUserId: string): { cookie: string; csrfToken: string } {
  const { sessionToken, csrfToken } = createSession(forUserId);
  return {
    cookie: [sessionSetCookie(sessionToken), csrfSetCookie(csrfToken)]
      .map((raw) => raw.split(';')[0])
      .join('; '),
    csrfToken,
  };
}

describe('anonymous requests', () => {
  it('refuses a read with the SRS error envelope and 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/matches' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: 'UNAUTHENTICATED',
        message: 'Sign in, or present an Authorization: Bearer credential',
      },
    });
  });

  it('refuses a write before it can reach the store', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/telegram/link' });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHENTICATED');
    expect(await prisma.telegramLinkToken.count()).toBe(0);
  });

  it('leaves /health public, because a probe names no candidate and carries no secret', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });
});

describe('a caller that names a candidate in its own parameters', () => {
  it('is refused on the query, rather than answered about itself while believing it asked elsewhere', async () => {
    const response = await authorized(app, userId, {
      method: 'GET',
      url: `/api/matches?userId=${'0b6b5934-b42d-4b06-b203-5ddd4475d100'}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('is refused on the body of a route that has none', async () => {
    const response = await authorized(app, userId, {
      method: 'POST',
      url: '/api/telegram/link',
      payload: { userId },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    // Refused before the store: the old route read this key and minted a link for whoever it named.
    expect(await prisma.telegramLinkToken.count()).toBe(0);
  });

  it('is answered as unauthenticated when it proved nothing, so the refusal leaks no parameter rules', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/profile?userId=0b6b5934-b42d-4b06-b203-5ddd4475d100',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('refuses a signed-in page the same way, and sends an anonymous one to sign in first', async () => {
    // The guard covers the pages too (ADR-0011 §3): `/dashboard?userId=` used to *be* the login, and
    // leaving it unrefused would leave a bookmark that silently shows somebody else's data.
    const { cookie } = sessionCookies(userId);

    const signedIn = await app.inject({
      method: 'GET',
      url: '/dashboard?userId=0b6b5934-b42d-4b06-b203-5ddd4475d100',
      headers: { cookie },
    });
    const anonymous = await app.inject({ method: 'GET', url: '/dashboard?userId=anything' });

    expect(signedIn.statusCode).toBe(400);
    expect(signedIn.json().error.code).toBe('VALIDATION_ERROR');
    // Proof of nothing comes before a lesson about parameters.
    expect(anonymous.statusCode).toBe(302);
    expect(anonymous.headers.location).toBe('/login');
  });
});

describe('bearer credentials', () => {
  it('answers for the candidate the credential names', async () => {
    const response = await authorized(app, userId, { method: 'GET', url: '/api/matches' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ matches: [], pagination: { nextCursor: null } });
  });

  it('refuses a credential this deployment did not sign', async () => {
    const forged = mintApiCredential('b'.repeat(64), userId);

    const response = await app.inject({
      method: 'GET',
      url: '/api/matches',
      headers: { authorization: `Bearer ${forged}` },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.message).toBe('That credential was not signed by this deployment');
  });

  it('refuses a credential past its lifetime', async () => {
    const stale = mintApiCredential(TEST_AUTH_SECRET, userId, {
      now: new Date(Date.now() - 60_000),
      ttlMs: 1_000,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/matches',
      headers: { authorization: `Bearer ${stale}` },
    });

    expect(response.json().error.message).toBe('That credential has expired');
  });

  it('refuses a login code used as an API credential', async () => {
    // Same secret, different purpose: a browser one-time code must not become a scripted key.
    const code = mintLoginCode(TEST_AUTH_SECRET, userId);

    const response = await app.inject({
      method: 'GET',
      url: '/api/matches',
      headers: { authorization: `Bearer ${code}` },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.message).toBe('That credential is not an API credential');
  });

  it('does not fall back to a session when the bearer half is broken', async () => {
    const { cookie } = sessionCookies(userId);

    const response = await app.inject({
      method: 'GET',
      url: '/api/matches',
      headers: { cookie, authorization: 'Bearer not-a-credential' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('reads the scheme case-insensitively and nothing else', async () => {
    const lower = await app.inject({
      method: 'GET',
      url: '/api/matches',
      headers: { authorization: `bearer ${mintApiCredential(TEST_AUTH_SECRET, userId)}` },
    });
    expect(lower.statusCode).toBe(200);

    const wrongScheme = await app.inject({
      method: 'GET',
      url: '/api/matches',
      headers: { authorization: `Token ${mintApiCredential(TEST_AUTH_SECRET, userId)}` },
    });
    expect(wrongScheme.statusCode).toBe(401);
  });
});

describe('the session cookie as an API credential', () => {
  it('answers a read for the signed-in candidate', async () => {
    const { cookie } = sessionCookies(userId);

    const response = await app.inject({ method: 'GET', url: '/api/matches', headers: { cookie } });

    expect(response.statusCode).toBe(200);
  });

  it('refuses a write that does not echo the CSRF token (ADR-0009 §2.2)', async () => {
    const { cookie } = sessionCookies(userId);

    const withoutToken = await app.inject({ method: 'POST', url: '/api/telegram/link', headers: { cookie } });
    expect(withoutToken.statusCode).toBe(403);
    expect(withoutToken.json().error.code).toBe('FORBIDDEN');
    expect(await prisma.telegramLinkToken.count()).toBe(0);

    const wrongToken = await app.inject({
      method: 'POST',
      url: '/api/telegram/link',
      headers: { cookie, 'x-csrf-token': 'not-the-token' },
    });
    expect(wrongToken.statusCode).toBe(403);
  });

  it('accepts a write that does echo it', async () => {
    const { cookie, csrfToken } = sessionCookies(userId);

    const response = await app.inject({
      method: 'POST',
      url: '/api/telegram/link',
      headers: { cookie, 'x-csrf-token': csrfToken },
    });

    expect(response.statusCode).toBe(201);
  });

  it('is not required for a bearer write, which has no cookie to ride', async () => {
    const response = await authorized(app, userId, { method: 'POST', url: '/api/telegram/link' });

    expect(response.statusCode).toBe(201);
  });

  it('refuses a session that names no candidate the store has', async () => {
    // The credential is the claim; a session for a deleted candidate still resolves, and the
    // route answers from that candidate's own (empty) data rather than another's.
    const { cookie } = sessionCookies('00000000-0000-0000-0000-000000000009');

    const response = await app.inject({ method: 'GET', url: '/api/matches', headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(response.json().matches).toEqual([]);
  });
});

describe('request addressing', () => {
  it('refuses a Host header that names another site, including a rebinding domain', async () => {
    // An empty `Host` is not in this list because no client sends one: an HTTP client drops the
    // empty value and its own default arrives instead. `hostnameOf` covers the absent case in
    // `tests/unit/api-addressing.spec.ts`.
    for (const host of ['evil.example', 'localhost.evil.example', 'evil.example:notaport']) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/matches',
        headers: { host, authorization: `Bearer ${mintApiCredential(TEST_AUTH_SECRET, userId)}` },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toBe(
        'This deployment does not accept requests for that host',
      );
    }
  });

  it('accepts the loopback names, with or without the port', async () => {
    const credential = mintApiCredential(TEST_AUTH_SECRET, userId);

    for (const host of ['127.0.0.1:3001', 'localhost', '[::1]:3001']) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/matches',
        headers: { host, authorization: `Bearer ${credential}` },
      });

      expect(`${host} → ${response.statusCode}`).toBe(`${host} → 200`);
    }
  });

  it('refuses a mutating request whose Origin is not this deployment', async () => {
    const { cookie, csrfToken } = sessionCookies(userId);

    const crossSite = await app.inject({
      method: 'POST',
      url: '/api/telegram/link',
      headers: { host: HOST, cookie, 'x-csrf-token': csrfToken, origin: 'https://evil.example' },
    });

    expect(crossSite.statusCode).toBe(403);
    expect(crossSite.json().error.code).toBe('FORBIDDEN');
    expect(await prisma.telegramLinkToken.count()).toBe(0);
  });

  it('accepts the same request from this deployment’s own origin', async () => {
    const { cookie, csrfToken } = sessionCookies(userId);

    const sameSite = await app.inject({
      method: 'POST',
      url: '/api/telegram/link',
      headers: { host: '127.0.0.1:3001', cookie, 'x-csrf-token': csrfToken, origin: 'http://127.0.0.1:3001' },
    });

    expect(sameSite.statusCode).toBe(201);
  });

  it('does not require an origin on a read, which is how a browser navigates here', async () => {
    // An `Origin` on a GET is a link clicked on someone else's page, not a mutation: the same
    // header only blocks a request that would change something.
    const response = await app.inject({
      method: 'GET',
      url: '/api/matches',
      headers: { origin: 'https://evil.example', authorization: `Bearer ${mintApiCredential(TEST_AUTH_SECRET, userId)}` },
    });

    expect(response.statusCode).toBe(200);
  });
});
