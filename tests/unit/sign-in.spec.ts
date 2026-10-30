import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  LOGIN_CODE_TTL_MS,
  mintApiCredential,
  mintLoginCode,
  NonceRegistry,
} from '@application/auth/credentials';
import { openSignInCode } from '@application/auth/sign-in';

/**
 * What it takes to become signed in (SRS 8.1; ADR-0011 §3).
 *
 * The web pages are the only caller, but the decision they make — whose session this opens, and
 * whether it opens at all — is the security boundary of the whole browser surface, so it is tested
 * against the real minting primitive rather than a stand-in: a change to the credential format that
 * silently broke sign-in would show up here, not in a report that nobody can sign in.
 */

const SECRET = 'a-signing-secret-of-plenty-of-bytes-for-hmac-sha-256';
const USER = '0b6b5934-b42d-4b06-b203-5ddd4475d100';
const OTHER = '1b6b5934-b42d-4b06-b203-5ddd4475d100';

function open(presented: unknown, used = new NonceRegistry(), now = new Date()) {
  return openSignInCode(SECRET, used, presented, now);
}

describe('a valid sign-in code', () => {
  it('opens a session for exactly the candidate it names', () => {
    const mine = mintLoginCode(SECRET, USER);
    const theirs = mintLoginCode(SECRET, OTHER);

    expect(open(mine)).toEqual({ ok: true, userId: USER });
    expect(open(theirs)).toEqual({ ok: true, userId: OTHER });
  });

  it('opens once: the second presentation is refused and names itself', () => {
    const code = mintLoginCode(SECRET, USER);
    const used = new NonceRegistry();

    expect(open(code, used)).toEqual({ ok: true, userId: USER });

    const second = open(code, used);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.message).toMatch(/already been opened/);
  });

  it('is worth opening at the last moment of its life', () => {
    const mintedAt = new Date('2026-10-30T09:00:00.000Z');
    const code = mintLoginCode(SECRET, USER, mintedAt);

    expect(open(code, new NonceRegistry(), new Date(mintedAt.getTime() + LOGIN_CODE_TTL_MS - 1))).toEqual(
      { ok: true, userId: USER },
    );
  });
});

describe('a presentation that is not a sign-in code', () => {
  it('refuses an expired link, and says the lifetime it missed', () => {
    const mintedAt = new Date('2026-10-30T09:00:00.000Z');
    const code = mintLoginCode(SECRET, USER, mintedAt);

    const verdict = open(code, new NonceRegistry(), new Date(mintedAt.getTime() + LOGIN_CODE_TTL_MS));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.message).toMatch(/expired[\s\S]*60 seconds/);
  });

  it('refuses a credential minted for the API, even though both are perfectly signed', () => {
    const verdict = open(mintApiCredential(SECRET, USER));

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.message).toMatch(/not a sign-in code|API credential/i);
  });

  it('refuses a link signed with a different secret', () => {
    const forged = mintLoginCode('another-signing-secret-also-long-enough-here', USER);

    const verdict = open(forged);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.message).toMatch(/not signed by this deployment/);
  });

  it('refuses the things an operator pastes by mistake', () => {
    for (const presented of ['', undefined, null, 'nonsense', 'v1..', 'v1.{}.{}']) {
      expect(open(presented).ok).toBe(false);
    }
  });
});

describe('what a refusal reveals', () => {
  it('never quotes the code it refused', () => {
    const used = new NonceRegistry();
    open(mintLoginCode(SECRET, USER), used);

    const code = mintLoginCode(SECRET, USER);
    const verdicts = [
      open(code, used),
      open(code, used),
      open(mintApiCredential(SECRET, USER)),
      open('v1.bm90LWEtY3JlZGVudGlhbA.nothing'),
    ];

    for (const verdict of verdicts) {
      if (verdict.ok) continue;
      expect(verdict.message).not.toContain(code);
      expect(verdict.message).not.toContain(USER);
    }
  });

  it('tells the operator what to do next, in the same breath', () => {
    const verdict = open('garbage');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.message).toContain('npm run login');
  });
});

describe('a code this build could not have minted', () => {
  /**
   * A correctly signed login payload with no nonce, as an older or a modified build would produce.
   *
   * It cannot be proven unused, so it must be refused — and refused *before* it touches the
   * registry, so a stream of them cannot fill memory with entries nothing will ever consume.
   */
  function signWithoutNonce(secret: string, userId: string, now: Date): string {
    const payload = Buffer.from(
      JSON.stringify({ k: 'login', u: userId, e: now.getTime() + LOGIN_CODE_TTL_MS }),
      'utf8',
    ).toString('base64url');
    const body = `v1.${payload}`;
    const signature = createHmac('sha256', secret).update(body, 'utf8').digest('base64url');
    return `${body}.${signature}`;
  }

  it('is refused, and consumes nothing', () => {
    const used = new NonceRegistry();
    const verdict = open(signWithoutNonce(SECRET, USER, new Date()), used);

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.message).toMatch(/not a sign-in code this deployment issues/);
    expect(used.size).toBe(0);
  });
});
