import type { FastifyInstance } from 'fastify';
import { mintLoginCode } from '@application/auth/credentials';
import { TEST_AUTH_SECRET } from './api';

/**
 * How a test drives the browser pages (SRS 3.1, 8.1; ADR-0011 §3).
 *
 * Every page now owes a session, so a spec that wants a dashboard has to sign in for one first —
 * which is the point of the change, and the reason these helpers exist rather than each spec
 * hand-writing its own cookie jar.
 *
 * `signIn` goes through the real flow: it mints a code with the signing primitive and opens it at
 * `/login?code=`, exactly as the link `npm run login` prints does. The session it returns therefore
 * came from the same guard a browser's does, not from a shortcut around it.
 */

export type Cookies = Record<string, string>;

export function cookieHeader(cookies: Cookies): string {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

export function cookiesOf(response: { cookies: Array<{ name: string; value: string }> }): Cookies {
  const jar: Cookies = {};
  for (const cookie of response.cookies) jar[cookie.name] = cookie.value;
  return jar;
}

/** The hidden CSRF field of a rendered form. */
export function csrfFrom(body: string): string {
  return /name="_csrf" value="([^"]*)"/.exec(body)?.[1] ?? '';
}

/** A signed one-time code for `userId`, for the tests that drive `/login` by hand. */
export function loginCode(userId: string, secret: string = TEST_AUTH_SECRET): string {
  return mintLoginCode(secret, userId);
}

/**
 * Sign in as `userId` through the link, and return the cookies the browser was left with.
 *
 * The redirect is asserted here rather than in the callers because a caller that reached this with a
 * refused code would otherwise go on testing an empty cookie jar and blame the page.
 */
export async function signIn(app: FastifyInstance, userId: string): Promise<Cookies> {
  const response = await app.inject({ method: 'GET', url: `/login?code=${loginCode(userId)}` });

  if (response.statusCode !== 302) {
    throw new Error(`sign-in failed with ${response.statusCode}: ${response.body.slice(0, 300)}`);
  }

  return cookiesOf(response);
}
