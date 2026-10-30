import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  API_CREDENTIAL_MAX_TTL_MS,
  CredentialConfigError,
  LOGIN_CODE_TTL_MS,
  NonceRegistry,
  assertSecretUsable,
  bearerTokenFromAuthorization,
  mintApiCredential,
  mintLoginCode,
  verifyCredential,
} from '@application/auth/credentials';

/**
 * The signed-credential primitive behind SRS 8.1's "the seeded user shall be authenticated".
 *
 * What is pinned: only a holder of the secret can name a user; a credential is bound to the kind
 * it was minted for; a past lifetime is refused; and a login code is usable exactly once. Each of
 * those is the whole security argument for a passwordless local sign-in, so each gets a test
 * rather than a comment.
 */

const SECRET = 'a'.repeat(64);
const OTHER_SECRET = 'b'.repeat(64);
const USER = '3f1b6c2e-6f1a-4a55-8b9f-1d2c3e4f5a6b';
const NOW = new Date('2026-10-30T09:00:00.000Z');

describe('assertSecretUsable', () => {
  it('accepts a secret of the documented length', () => {
    expect(() => assertSecretUsable(SECRET)).not.toThrow();
  });

  it('refuses an empty secret instead of signing with nothing', () => {
    expect(() => assertSecretUsable('   ')).toThrow(CredentialConfigError);
  });

  it('refuses a short secret rather than padding it up to the block size', () => {
    expect(() => assertSecretUsable('hunter2')).toThrow(/at least 32 bytes/);
  });

  it('names the variable, never its value', () => {
    const message = (() => {
      try {
        assertSecretUsable('short', 'AUTH_SECRET');
        return '';
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect(message).toContain('AUTH_SECRET');
    expect(message).not.toContain('short');
  });
});

describe('mintLoginCode', () => {
  it('verifies against the same secret', () => {
    const code = mintLoginCode(SECRET, USER, NOW);
    const result = verifyCredential(SECRET, code, NOW);
    expect(result).toMatchObject({ ok: true, credential: { kind: 'login', userId: USER } });
  });

  it('is the only way to make a code that opens: a caller cannot assemble a payload', () => {
    const forged = Buffer.from(
      JSON.stringify({ k: 'login', u: USER, e: NOW.getTime() + 60_000, n: 'x' }),
      'utf8',
    ).toString('base64url');
    expect(verifyCredential(SECRET, `v1.${forged}.deadbeef`, NOW).ok).toBe(false);
  });

  it('differs per mint, so a replay of the same code is detectable', () => {
    expect(mintLoginCode(SECRET, USER, NOW)).not.toBe(mintLoginCode(SECRET, USER, NOW));
  });

  it('refuses to mint without a usable secret', () => {
    expect(() => mintLoginCode('too-short', USER, NOW)).toThrow(CredentialConfigError);
  });
});

describe('verifyCredential', () => {
  const code = mintLoginCode(SECRET, USER, NOW);

  it('refuses a credential signed by a different deployment', () => {
    expect(verifyCredential(OTHER_SECRET, code, NOW)).toEqual({ ok: false, reason: 'signature' });
  });

  it('refuses a truncated or garbled string as malformed, not as a wrong signature', () => {
    expect(verifyCredential(SECRET, 'not-a-credential', NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(verifyCredential(SECRET, `v2.${code.split('.').slice(1).join('.')}`, NOW).ok).toBe(false);
    expect(verifyCredential(SECRET, undefined, NOW).ok).toBe(false);
    expect(verifyCredential(SECRET, '', NOW).ok).toBe(false);
  });

  it('refuses a credential whose payload is not JSON', () => {
    const raw = `v1.${Buffer.from('hello', 'utf8').toString('base64url')}.sig`;
    expect(verifyCredential(SECRET, raw, NOW).ok).toBe(false);
  });

  it('refuses an unknown kind, so a payload cannot invent a third purpose', () => {
    const body = `v1.${Buffer.from(
      JSON.stringify({ k: 'admin', u: USER, e: NOW.getTime() + 60_000 }),
      'utf8',
    ).toString('base64url')}`;
    const signed = `${body}.${createHmac('sha256', SECRET)
      .update(body, 'utf8')
      .digest('base64url')}`;
    expect(verifyCredential(SECRET, signed, NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses a credential past its lifetime, and accepts it one millisecond before', () => {
    const expired = verifyCredential(SECRET, code, new Date(NOW.getTime() + LOGIN_CODE_TTL_MS));
    expect(expired).toEqual({ ok: false, reason: 'expired' });
    expect(
      verifyCredential(SECRET, code, new Date(NOW.getTime() + LOGIN_CODE_TTL_MS - 1)).ok,
    ).toBe(true);
  });

  it('publishes the expiry it signed, so a caller can report it without re-deriving it', () => {
    const result = verifyCredential(SECRET, code, NOW);
    expect(result.ok && result.credential.expiresAt.toISOString()).toBe(
      new Date(NOW.getTime() + LOGIN_CODE_TTL_MS).toISOString(),
    );
  });

  it('binds a credential to the kind it was minted for', () => {
    expect(verifyCredential(SECRET, code, NOW, 'api')).toEqual({ ok: false, reason: 'kind' });
    expect(verifyCredential(SECRET, code, NOW, 'login').ok).toBe(true);
  });
});

describe('mintApiCredential', () => {
  it('is not accepted where a login code is required, and the other way round', () => {
    const token = mintApiCredential(SECRET, USER, { now: NOW });
    expect(verifyCredential(SECRET, token, NOW, 'login')).toEqual({ ok: false, reason: 'kind' });
    expect(verifyCredential(SECRET, token, NOW, 'api').ok).toBe(true);
  });

  it('carries no nonce: it is replayable by design', () => {
    const result = verifyCredential(SECRET, mintApiCredential(SECRET, USER, { now: NOW }), NOW);
    expect(result.ok && result.credential.nonce).toBeUndefined();
  });

  it('refuses a lifetime longer than the ceiling rather than minting a decade-long token', () => {
    expect(() =>
      mintApiCredential(SECRET, USER, { now: NOW, ttlMs: API_CREDENTIAL_MAX_TTL_MS + 1 }),
    ).toThrow(CredentialConfigError);
    expect(() => mintApiCredential(SECRET, USER, { now: NOW, ttlMs: 0 })).toThrow(
      CredentialConfigError,
    );
  });
});

describe('bearerTokenFromAuthorization', () => {
  it('takes the token from a Bearer header, in any scheme case', () => {
    const token = mintApiCredential(SECRET, USER, { now: NOW });
    expect(bearerTokenFromAuthorization(`Bearer ${token}`)).toBe(token);
    expect(bearerTokenFromAuthorization(`bearer ${token}`)).toBe(token);
  });

  it('refuses every other shape, including a token split over two words', () => {
    expect(bearerTokenFromAuthorization(undefined)).toBeNull();
    expect(bearerTokenFromAuthorization('')).toBeNull();
    expect(bearerTokenFromAuthorization('Basic abc')).toBeNull();
    expect(bearerTokenFromAuthorization('Bearer')).toBeNull();
    expect(bearerTokenFromAuthorization('Bearer a b')).toBeNull();
  });
});

describe('NonceRegistry', () => {
  it('accepts a nonce once and refuses it again', () => {
    let clock = NOW;
    const registry = new NonceRegistry(() => clock);
    expect(registry.consume('abc')).toBe(true);
    expect(registry.consume('abc')).toBe(false);
  });

  it('refuses a code that expired while unopened, without remembering it forever', () => {
    let clock = NOW;
    const registry = new NonceRegistry(() => clock);
    const code = mintLoginCode(SECRET, USER, clock);
    const result = verifyCredential(SECRET, code, clock);
    expect(result.ok && registry.consume(result.credential.nonce ?? '')).toBe(true);

    clock = new Date(NOW.getTime() + LOGIN_CODE_TTL_MS + 1);
    expect(verifyCredential(SECRET, code, clock)).toEqual({ ok: false, reason: 'expired' });
    registry.consume('prune-me');
    expect(registry.size).toBe(1);
  });

  it('tracks distinct nonces separately', () => {
    const registry = new NonceRegistry(() => NOW);
    expect(registry.consume('one')).toBe(true);
    expect(registry.consume('two')).toBe(true);
    expect(registry.consume('one')).toBe(false);
  });
});
