import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { mintApiCredential, mintLoginCode } from '@application/auth/credentials';
import {
  applyTestMigrations,
  createTestPrismaClient,
  truncateAll,
} from '../support/db';
import { TEST_AUTH_SECRET, testApiConfig } from '../support/api';
import { cookieHeader, cookiesOf, loginCode, signIn } from '../support/web';
import { buildApi } from '../../apps/api/main';

/**
 * How a browser becomes somebody (SRS 8.1; ADR-0011 §3).
 *
 * The audit's H2 finding had a second half that the JSON API fix could not reach: `/login?userId=`
 * handed a session and a CSRF token to anyone who could name a stored candidate, so "authenticated"
 * meant "you typed a uuid". What is pinned here is the replacement — a code that only a process
 * holding `AUTH_SECRET` can mint, that is worth one click, and whose refusal tells the browser
 * nothing about the candidate it did not open.
 */

const prisma = createTestPrismaClient();

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
      data: { email: `signin-${Date.now()}-${counter++}@example.test` },
      select: { id: true },
    })
  ).id;

  const api = await buildApi(testApiConfig());
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

const get = (url: string, cookies?: Record<string, string>) =>
  app.inject({
    method: 'GET',
    url,
    ...(cookies === undefined ? {} : { headers: { cookie: cookieHeader(cookies) } }),
  });

describe('opening a sign-in link', () => {
  it('trades a minted code for a session and lands on the dashboard', async () => {
    const response = await get(`/login?code=${loginCode(userId)}`);

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/dashboard');

    const cookies = cookiesOf(response);
    expect(cookies.jh_session).toBeTruthy();
    expect(cookies.jh_csrf).toBeTruthy();

    const dashboard = await get('/dashboard', cookies);
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.body).toContain('No candidate profile yet');
    expect(dashboard.body).toContain('You are signed in');
  });

  it('refuses the same code a second time, so a copied link is worth one click', async () => {
    const code = loginCode(userId);
    expect((await get(`/login?code=${code}`)).statusCode).toBe(302);

    const replay = await get(`/login?code=${code}`);

    expect(replay.statusCode).toBe(401);
    expect(replay.body).toContain('already been opened');
    expect(replay.cookies).toEqual([]);
  });

  it('refuses a code that has passed its minute', async () => {
    const stale = mintLoginCode(TEST_AUTH_SECRET, userId, new Date(Date.now() - 120_000));

    const response = await get(`/login?code=${stale}`);

    expect(response.statusCode).toBe(401);
    expect(response.body).toContain('expired');
  });

  it('refuses a code another deployment signed', async () => {
    const foreign = mintLoginCode('c'.repeat(64), userId);

    const response = await get(`/login?code=${foreign}`);

    expect(response.statusCode).toBe(401);
    expect(response.body).toContain('not signed by this deployment');
  });

  it('refuses a bearer credential used as a sign-in link, whatever its signature says', async () => {
    // Same secret, same format, different purpose: the `kind` inside the payload is what separates a
    // token a script presents from a link a browser opens.
    const asCode = mintApiCredential(TEST_AUTH_SECRET, userId);

    const response = await get(`/login?code=${asCode}`);

    expect(response.statusCode).toBe(401);
    expect(response.body).toContain('API credential, not a sign-in link');
  });

  it('refuses a string that is not a code at all', async () => {
    const response = await get('/login?code=not-a-code');

    expect(response.statusCode).toBe(401);
    expect(response.body).toContain('could not be read');
  });

  it('quotes none of what it refused, because that string is a credential', async () => {
    // SRS 8.5: nothing the app prints carries a token — and a refusal page is the one thing an
    // operator might screenshot while asking about it.
    const presented = loginCode(userId);
    await get(`/login?code=${presented}`);

    const replay = await get(`/login?code=${presented}`);
    expect(replay.body).not.toContain(presented);
    expect(replay.body).not.toContain('v1.');
  });
});

describe('the sign-in page with nothing to open', () => {
  it('explains the local command instead of listing candidates', async () => {
    const other = await prisma.user.create({ data: { email: `second-${counter++}@example.test` } });

    const response = await get('/login');

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('npm run login');
    // The chooser is gone: a page that lists stored candidates is a page that hands out sessions for
    // any of them to whoever reaches the port.
    expect(response.body).not.toContain(userId);
    expect(response.body).not.toContain(other.id);
    expect(response.body).not.toContain('/login?userId=');
  });

  it('stays reachable with no session, because that is what it is for', async () => {
    expect((await get('/login')).statusCode).toBe(200);
    expect((await get('/health')).statusCode).toBe(200);
  });

  it('ends the browser session on logout and sends it back to sign in', async () => {
    const cookies = await signIn(app, userId);
    expect((await get('/dashboard', cookies)).statusCode).toBe(200);

    const logout = await get('/logout', cookies);
    expect(logout.statusCode).toBe(302);
    expect(logout.headers.location).toBe('/login');
    expect(JSON.stringify(logout.headers['set-cookie'])).toContain('Max-Age=0');

    // Gone from the store, not merely re-sent: the same cookie value buys nothing now.
    expect((await get('/dashboard', cookies)).statusCode).toBe(302);
  });
});

describe('a page reached with no session', () => {
  it('sends the browser to sign in rather than answering about anybody', async () => {
    for (const url of ['/', '/dashboard', '/matches', '/profile', '/settings', '/jobs']) {
      const response = await get(url);

      expect(`${url} → ${response.statusCode}`).toBe(`${url} → 302`);
      expect(response.headers.location).toBe('/login');
    }
  });

  it('sends a mutating page the same way, before its form body is ever read', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/profile',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'experienceYears=9',
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/login');
  });

  it('sends a page that matches no route the same way, so nothing is public by accident', async () => {
    // The guard is deny-by-path: an unknown URL is a page like any other, and a 404 that names the
    // method and path is the most a caller who proved nothing is owed.
    const anonymous = await get('/nowhere');
    const signedIn = await get('/nowhere', await signIn(app, userId));

    expect(anonymous.statusCode).toBe(302);
    expect(anonymous.headers.location).toBe('/login');
    expect(signedIn.statusCode).toBe(404);
    expect(signedIn.json().error.message).toBe('No route for GET /nowhere');
  });

  it('refuses a signed-in page that still names a candidate in its own address', async () => {
    // ADR-0011 removed the parameter from the pages too, and a stale bookmark is refused rather than
    // quietly answered about the wrong person.
    const cookies = await signIn(app, userId);

    const response = await get(
      `/dashboard?userId=0b6b5934-b42d-4b06-b203-5ddd4475d100`,
      cookies,
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });
});
