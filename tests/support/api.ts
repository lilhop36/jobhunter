import type { FastifyInstance, InjectOptions } from 'fastify';
import { mintApiCredential } from '@application/auth/credentials';
import { parseApiConfig, type ApiConfig } from '../../apps/api/config';
import { requireTestDatabaseUrl } from './db';

/**
 * How a test says "acting as this candidate" (SRS 8.1, 8.2; ADR-0011).
 *
 * Every `/api/*` route now answers only for a principal, so a test that used to write
 * `{ method: 'GET', url: '/api/matches' }` has to say who is asking. That is the point: the
 * identity a request carries is the identity it gets to act as, and a suite that never named one
 * would be a suite that never tested it.
 *
 * The credential is minted through the real primitive, not faked — the tests exercise the same
 * signature check a caller does, so a change to the format cannot silently pass here and break
 * the running API.
 */

/**
 * A fixed secret for the suite. It signs nothing outside a test process, and naming it here is
 * what keeps `AUTH_SECRET` out of every spec: the tests need a *key*, not a *secret*.
 */
export const TEST_AUTH_SECRET = 'jobhunter-test-signing-key-not-a-real-credential';

/** The configuration every API test builds: loopback bind, the disposable database, a fixed key. */
export function testApiConfig(overrides: NodeJS.ProcessEnv = {}): ApiConfig {
  return parseApiConfig({
    ...process.env,
    // The disposable-database guard runs first: a test that cannot say which database it is about
    // to TRUNCATE must not reach `parseApiConfig` at all.
    DATABASE_URL: requireTestDatabaseUrl(),
    API_HOST: '127.0.0.1',
    AUTH_SECRET: TEST_AUTH_SECRET,
    ...overrides,
  });
}

/** A signed bearer credential for one candidate. */
export function apiCredential(userId: string, secret: string = TEST_AUTH_SECRET): string {
  return mintApiCredential(secret, userId);
}

/** `app.inject` as an authenticated caller: the same options, plus a credential for `userId`. */
export function authorized(app: FastifyInstance, userId: string, options: InjectOptions | string) {
  const base: InjectOptions = typeof options === 'string' ? { url: options } : options;
  return app.inject({
    ...base,
    headers: { authorization: `Bearer ${apiCredential(userId)}`, ...(base.headers ?? {}) },
  });
}
