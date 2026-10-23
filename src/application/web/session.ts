import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Sessions and CSRF for the browser UI (ADR-0009).
 *
 * Two cookies, parsed and serialised here rather than with a cookie plugin:
 * `jh_session` (HttpOnly) is the session, `jh_csrf` (readable) carries a token the
 * form echoes back as `_csrf`. The double-submit pair is defence in depth behind
 * `SameSite=Lax`; a request must present both, and they must agree.
 *
 * The store is a plain `Map`. The API is one process and v1 is a personal,
 * loopback tool, so a restart losing sessions costs the operator one click
 * (ADR-0009 §2.4). Nothing here imports Fastify, so the rules are unit-testable
 * without a server.
 */

export const SESSION_COOKIE = 'jh_session';
export const CSRF_COOKIE = 'jh_csrf';

/** 30 days, ADR-0009 §2.1. Refreshed on use, so an active operator is never logged out. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;

export interface SessionData {
  readonly userId: string;
  readonly csrfToken: string;
  lastSeenAt: number;
}

const sessions = new Map<string, SessionData>();

/** A fresh session for one candidate. A new login supersedes the old cookie, not the old entry. */
export function createSession(
  userId: string,
  now: Date = new Date(),
): { sessionToken: string; csrfToken: string } {
  const sessionToken = randomBytes(24).toString('base64url');
  const csrfToken = randomBytes(24).toString('base64url');
  sessions.set(sessionToken, { userId, csrfToken, lastSeenAt: now.getTime() });
  return { sessionToken, csrfToken };
}

/** The session for a token, or `null` when it is unknown or past its TTL. Touches the TTL. */
export function getSession(
  sessionToken: string | undefined,
  now: Date = new Date(),
): SessionData | null {
  if (sessionToken === undefined || sessionToken === '') return null;
  const data = sessions.get(sessionToken);
  if (data === undefined) return null;
  if (now.getTime() - data.lastSeenAt > SESSION_TTL_MS) {
    sessions.delete(sessionToken);
    return null;
  }
  data.lastSeenAt = now.getTime();
  return data;
}

export function deleteSession(sessionToken: string | undefined): void {
  if (sessionToken !== undefined) sessions.delete(sessionToken);
}

/**
 * Constant-time comparison, because a token check that returns early on the first
 * differing byte leaks the token one byte at a time to a caller who can time it.
 */
function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** True only when the session exists and the submitted `_csrf` matches it exactly. */
export function verifyCsrf(session: SessionData | null, submitted: unknown): boolean {
  if (session === null) return false;
  if (typeof submitted !== 'string' || submitted === '') return false;
  return constantTimeEquals(session.csrfToken, submitted);
}

/**
 * The cookies in a `Cookie:` header. Malformed pairs are skipped and a value that
 * is not valid percent-encoding is taken literally: a hostile header must not
 * throw inside the request path, and the values we set are base64url anyway.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (header === undefined) return cookies;
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 0) continue;
    const name = pair.slice(0, separator).trim();
    if (name === '') continue;
    const raw = pair.slice(separator + 1).trim();
    let value = raw;
    try {
      value = decodeURIComponent(raw);
    } catch {
      // Keep the literal value; it simply will not match a stored token.
    }
    cookies[name] = value;
  }
  return cookies;
}

/**
 * `Secure` is deliberately absent: the API binds loopback over plain HTTP
 * (ADR-0007), so a `Secure` cookie would never be sent back. Add it the day the
 * API is reachable over TLS.
 */
export function sessionSetCookie(token: string): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; SameSite=Lax`;
}

export function csrfSetCookie(token: string): string {
  return `${CSRF_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; SameSite=Lax`;
}

export function clearSetCookie(name: string): string {
  return `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
}