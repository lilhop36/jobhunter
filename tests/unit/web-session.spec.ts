import { describe, expect, it } from 'vitest';
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  clearSetCookie,
  createSession,
  csrfSetCookie,
  deleteSession,
  getSession,
  parseCookies,
  sessionSetCookie,
  verifyCsrf,
} from '@application/web/session';

/**
 * Session and CSRF rules (ADR-0009) are pure functions over a `Map`, so they are pinned here
 * without a server: the cookie header a browser sends is untrusted input, the TTL is a clock
 * decision, and a CSRF check that answered "true" for the wrong token would be a hole.
 */

describe('parseCookies', () => {
  it('reads the pairs a browser sends', () => {
    expect(parseCookies(`${SESSION_COOKIE}=abc; other=1; ${CSRF_COOKIE}=def`)).toEqual({
      [SESSION_COOKIE]: 'abc',
      other: '1',
      [CSRF_COOKIE]: 'def',
    });
  });

  it('answers with nothing when there is no header', () => {
    expect(parseCookies(undefined)).toEqual({});
  });

  it('skips malformed pairs instead of throwing', () => {
    expect(parseCookies('nonsense; =v; good=1')).toEqual({ good: '1' });
  });

  it('keeps a value that is not valid percent-encoding literally', () => {
    // A hostile cookie must not throw inside the request path.
    expect(parseCookies('bad=%E0%A4%A')).toEqual({ bad: '%E0%A4%A' });
  });

  it('decodes a percent-encoded value', () => {
    expect(parseCookies('name=a%20b')).toEqual({ name: 'a b' });
  });
});

describe('session lifecycle', () => {
  it('finds a session it created and forgets one it deleted', () => {
    const { sessionToken } = createSession('user-1');

    expect(getSession(sessionToken)?.userId).toBe('user-1');

    deleteSession(sessionToken);
    expect(getSession(sessionToken)).toBeNull();
  });

  it('does not confuse one session token with another, or with an unknown token', () => {
    const a = createSession('user-a');
    const b = createSession('user-b');

    expect(getSession(a.sessionToken)?.userId).toBe('user-a');
    expect(getSession(b.sessionToken)?.userId).toBe('user-b');
    expect(getSession('not-a-token')).toBeNull();
    expect(getSession('')).toBeNull();
    expect(getSession(undefined)).toBeNull();
  });

  it('expires a session past its 30-day horizon', () => {
    const start = new Date('2026-01-01T00:00:00Z');
    const { sessionToken } = createSession('user-1', start);

    // Exactly 30 days is still inside the window.
    expect(getSession(sessionToken, new Date('2026-01-31T00:00:00Z'))).not.toBeNull();
    // Reading it refreshed the clock to 31 Jan; 35 days later it is gone.
    expect(getSession(sessionToken, new Date('2026-03-07T00:00:00Z'))).toBeNull();
  });
});

describe('verifyCsrf', () => {
  it('accepts only the token that belongs to the session', () => {
    const { sessionToken, csrfToken } = createSession('user-1');
    const session = getSession(sessionToken);

    expect(verifyCsrf(session, csrfToken)).toBe(true);
    expect(verifyCsrf(session, 'wrong-token')).toBe(false);
    expect(verifyCsrf(session, undefined)).toBe(false);
    expect(verifyCsrf(session, '')).toBe(false);
    expect(verifyCsrf(null, csrfToken)).toBe(false);
  });

  it('rejects a valid token presented with a different session', () => {
    const a = createSession('user-a');
    const b = createSession('user-b');

    expect(verifyCsrf(getSession(a.sessionToken), b.csrfToken)).toBe(false);
  });
});

describe('cookie serialisation', () => {
  it('marks the session HttpOnly and same-site, and the CSRF token readable', () => {
    const session = sessionSetCookie('abc');
    expect(session).toContain(`${SESSION_COOKIE}=abc`);
    expect(session).toContain('HttpOnly');
    expect(session).toContain('SameSite=Lax');

    // The page must be able to echo the CSRF token into a form, so it is not HttpOnly.
    const csrf = csrfSetCookie('def');
    expect(csrf).toContain(`${CSRF_COOKIE}=def`);
    expect(csrf).not.toContain('HttpOnly');
  });

  it('clears a cookie with an immediate expiry', () => {
    expect(clearSetCookie(SESSION_COOKIE)).toContain('Max-Age=0');
    expect(clearSetCookie(CSRF_COOKIE)).toContain('Max-Age=0');
  });
});