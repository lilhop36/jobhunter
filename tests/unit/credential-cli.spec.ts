import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  baseUrlFromEnv,
  findTargetUser,
  readFlag,
  rejectUnknownFlags,
  UsageError,
} from '../../scripts/lib/credential-cli';

/**
 * The rules the credential CLIs stand on (ADR-0011 §3/§4).
 *
 * These functions decide *which candidate* a printed secret names, and a wrong answer there is not
 * recoverable by reading the output — the operator opens the link and the session is for somebody
 * else. So the flag grammar, the single-user shortcut, and the address the link points at are
 * pinned here rather than left to a script nobody can call from a test.
 */

/** Only the three user reads the CLI performs; nothing else is reachable from these paths. */
function fakePrisma(users: Array<{ id: string; email: string }>): PrismaClient {
  return {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string; email?: string } }) =>
        users.find((user) => user.id === where.id || user.email === where.email) ?? null,
      ),
      findMany: vi.fn(async () => users),
    },
  } as unknown as PrismaClient;
}

describe('flag reading', () => {
  it('accepts both --name value and --name=value', () => {
    expect(readFlag(['--email', 'a@b.test'], 'email')).toBe('a@b.test');
    expect(readFlag(['--email=a@b.test'], 'email')).toBe('a@b.test');
    expect(readFlag(['--user', 'x'], 'email')).toBeNull();
  });

  it('refuses a flag with no value instead of reading the next flag as one', () => {
    expect(() => readFlag(['--email', '--help'], 'email')).toThrow(UsageError);
    expect(() => readFlag(['--email'], 'email')).toThrow(/needs a value/);
  });

  it('names the recognised options when an unknown one appears', () => {
    expect(() => rejectUnknownFlags(['--emial', 'a@b.test'], ['email', 'user'])).toThrow(
      /unknown option --emial; the options are --email, --user/,
    );
    expect(() => rejectUnknownFlags(['--email=a@b.test', 'positional'], ['email'])).not.toThrow();
  });
});

describe('choosing the candidate', () => {
  const one = { id: '11111111-1111-4111-8111-111111111111', email: 'solo@example.test' };
  const two = { id: '22222222-2222-4222-8222-222222222222', email: 'other@example.test' };

  it('uses the only user when a single-user deployment names none', async () => {
    expect(await findTargetUser(fakePrisma([one]), { email: null, user: null })).toEqual(one);
  });

  it('resolves an explicit email or id', async () => {
    const prisma = fakePrisma([one, two]);
    expect(await findTargetUser(prisma, { email: two.email, user: null })).toEqual(two);
    expect(await findTargetUser(prisma, { email: null, user: one.id })).toEqual(one);
  });

  it('refuses to choose between two locators', async () => {
    await expect(
      findTargetUser(fakePrisma([one]), { email: one.email, user: one.id }),
    ).rejects.toThrow(/not both/);
  });

  it('lists the candidates rather than picking one when several exist', async () => {
    const error = await findTargetUser(fakePrisma([one, two]), { email: null, user: null }).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(UsageError);
    expect(String(error)).toContain('2 users exist');
    // The listing is the fix: the operator copies the email they meant straight out of the error.
    expect(String(error)).toContain(`${two.email}  (${two.id})`);
  });

  it('says what to do when there is nobody to sign in as', async () => {
    await expect(
      findTargetUser(fakePrisma([]), { email: null, user: null }),
    ).rejects.toThrow(/seed a candidate with `npm run seed:candidate`/);
  });

  it('refuses a locator that names no user, rather than falling back to the only one', async () => {
    await expect(
      findTargetUser(fakePrisma([one]), { email: 'ghost@example.test', user: null }),
    ).rejects.toThrow(/no user has the email/);
  });
});

describe('the address the printed link points at', () => {
  it('defaults to the loopback address and port the API itself uses', () => {
    expect(baseUrlFromEnv({})).toEqual({ url: 'http://127.0.0.1:3001', loopback: true });
  });

  it('follows API_HOST and API_PORT', () => {
    expect(baseUrlFromEnv({ API_HOST: 'localhost', API_PORT: '4000' })).toEqual({
      url: 'http://localhost:4000',
      loopback: true,
    });
    expect(baseUrlFromEnv({ API_HOST: '127.0.0.5' })).toEqual({
      url: 'http://127.0.0.5:3001',
      loopback: true,
    });
  });

  it('brackets an IPv6 host and still calls it loopback', () => {
    expect(baseUrlFromEnv({ API_HOST: '::1' })).toEqual({ url: 'http://[::1]:3001', loopback: true });
  });

  it('reports a non-loopback host so the caller can warn about a clear-text link', () => {
    expect(baseUrlFromEnv({ API_HOST: '0.0.0.0' })).toEqual({
      url: 'http://0.0.0.0:3001',
      loopback: false,
    });
  });
});
