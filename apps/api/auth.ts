import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  bearerTokenFromAuthorization,
  verifyCredential,
  type CredentialRefusal,
} from '@application/auth/credentials';
import {
  getSession,
  parseCookies,
  SESSION_COOKIE,
  verifyCsrf,
  type SessionData,
} from '@application/web/session';
import { normalizeHostname, type ApiConfig } from './config';
import { decodeQueryKey, pathOf, queryOf } from './url';
import { ApiError, ERROR_CODES } from './errors';

/**
 * Who is asking (SRS 8.1, 8.2; ADR-0011).
 *
 * Nothing in this process answers about a candidate until a hook has decided who the caller is. Two
 * surfaces, one rule: every `/api/*` route except `/health` answers a request only through a
 * principal, every browser page except the sign-in pair requires a session, and the `userId` a
 * handler acts on is the *only* place an identity may be read from. That inversion is the whole
 * change: before, the caller named the user it wanted to act as and the route believed it, which
 * made ownership unenforceable no matter how carefully each repository filtered by `userId`.
 *
 * Two ways to become a principal:
 *
 *   - **`Authorization: Bearer <credential>`** — a signed API credential, minted locally by
 *     `npm run token` and bound to one candidate. This is the scripted path.
 *   - **the `jh_session` cookie** — the browser's session (ADR-0009), which is why the JSON API
 *     needs no separate login and no CORS affordance. A browser gets that cookie only by opening a
 *     code minted by `npm run login`, which is what turned "whoever can reach the port is the
 *     candidate" into "whoever can run a local command is the candidate".
 *
 * A bearer credential is refused *as a credential* rather than falling through to the cookie: a
 * caller that presented something invalid is not the same as a caller that presented nothing, and
 * silently ignoring the bad one would let a truncated token be answered from a session nobody
 * meant to send.
 *
 * The refusal is shaped by the surface, not by the finding: an API caller gets the SRS error
 * envelope, a browser gets a redirect to the sign-in page. Neither is a fact about the candidate
 * they asked for.
 */
export interface Principal {
  readonly userId: string;
  readonly via: 'session' | 'bearer';
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the guard below before any guarded handler runs; absent on public routes. */
    principal?: Principal;
    /** Set by the guard below before any page handler runs; the session behind `principal`. */
    session?: SessionData;
  }
}

export interface AuthGuardsDeps {
  config: ApiConfig;
}

/** `/health` answers without a principal: it names no candidate data and a probe carries no secret. */
export function isGuarded(url: string): boolean {
  return pathOf(url).startsWith('/api/');
}

/**
 * The paths a browser may reach with no session at all.
 *
 * `/login` is the page that creates a session and `/logout` ends one that may already have expired,
 * so guarding either would make the sign-in flow unreachable — or, for logout, unendable. `/health`
 * is guarded by path instead, and listed here so it does not become a page. Everything else is a
 * page, including paths that match no route: an unknown URL is not allowed to answer as if it were
 * public.
 */
const PUBLIC_PAGE_PATHS = new Set(['/login', '/logout', '/health']);

/** Whether this request is for a browser page that owes a session. */
export function isPage(url: string): boolean {
  return !isGuarded(url) && !PUBLIC_PAGE_PATHS.has(pathOf(url));
}

const NON_MUTATING = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Install the hooks the authorization rests on.
 *
 * They are hooks rather than per-route `preHandler`s so that a route added next month is covered by
 * default. The guard is therefore deny-by-path: anything under `/api/` needs a principal, anything
 * that is not a public page needs a session, and opting out means editing this file.
 */
export function registerAuthGuards(app: FastifyInstance, deps: AuthGuardsDeps): void {
  app.addHook('onRequest', async (request) => {
    rejectMisdirectedRequest(request, deps.config);
  });

  app.addHook('preHandler', async (request, reply) => {
    if (isGuarded(request.url)) {
      const principal = resolvePrincipal(request, deps.config);

      // Answered after the principal, not before: an unauthenticated caller is refused as such, and
      // is not owed a lesson about their parameters.
      refuseCallerNamedIdentity(request);

      request.principal = principal;
      return;
    }

    if (!isPage(request.url)) return;

    const session = getSession(parseCookies(request.headers.cookie)[SESSION_COOKIE]);
    if (session === null) return void reply.redirect('/login');

    // The same refusal the API owes a stale bookmark or an old script: a page that silently ignored
    // `?userId=` would show the signed-in candidate's data to someone who believes they asked for
    // somebody else's.
    refuseCallerNamedIdentity(request);

    // A page is a cookie-authenticated surface, so it gets the same principal shape as the API: the
    // handler reads an identity the guard proved, and cannot be aimed at anyone else.
    request.session = session;
    request.principal = { userId: session.userId, via: 'session' };
  });
}

/**
 * The identity this request proves, or a refusal.
 *
 * Exported because this is the only reading of these two headers: anything else that has to answer
 * "who is asking" calls this rather than re-deriving it from the cookie, and a second, laxer parser
 * is how the two drift apart.
 */
export function resolvePrincipal(request: FastifyRequest, config: ApiConfig): Principal {
  const bearer = bearerTokenFromAuthorization(request.headers.authorization);
  if (bearer !== null) {
    const result = verifyCredential(config.authSecret, bearer, new Date(), 'api');
    if (!result.ok) throw ApiError.unauthenticated(credentialRefusal(result.reason));
    return { userId: result.credential.userId, via: 'bearer' };
  }

  const session = getSession(parseCookies(request.headers.cookie)[SESSION_COOKIE]);
  if (session === null) {
    throw ApiError.unauthenticated('Sign in, or present an Authorization: Bearer credential');
  }

  // ADR-0009 §2.2: the session cookie authenticates a browser, and a browser sends it to a
  // cross-site form too. SameSite=Lax is the first defence; the echoed token is the second, and
  // it is required here because this is a cookie-authenticated *write*. A bearer caller has no
  // cookie to ride, so it is exempt — that is the difference between the two paths, not a loophole.
  if (!NON_MUTATING.has(request.method) && !verifyCsrf(session, request.headers['x-csrf-token'])) {
    throw ApiError.forbidden('A session-authenticated write must send a matching X-CSRF-Token');
  }

  return { userId: session.userId, via: 'session' };
}

/**
 * Refuse a request that still names a candidate in its own parameters.
 *
 * Before ADR-0011, `?userId=` and a body `userId` *were* the identity, and every route read them
 * first. Removing them from the schemas would leave a caller who still sends one getting an answer
 * about themselves while believing they asked about somebody else — a silently ignored parameter is
 * the worst outcome, because the request succeeds. So the parameter is rejected out loud instead,
 * on every route and page this guard covers, from here rather than from each route's schema: no
 * handler added later can forget to declare it, and none can accept it.
 */
export function refuseCallerNamedIdentity(request: FastifyRequest): void {
  if (queryNamesUserId(request.url) || bodyNamesUserId(request.body)) {
    throw ApiError.validation(
      'Identity comes from the credential; this route takes no userId. Sign in as the candidate ' +
        'or present their bearer credential.',
    );
  }
}

/** Whether the query string carries a `userId` key, whatever its value. */
function queryNamesUserId(url: string): boolean {
  for (const pair of queryOf(url).split('&')) {
    if (decodeQueryKey(pair.split('=')[0] ?? '') === 'userId') return true;
  }
  return false;
}

/** Whether a JSON body states a top-level `userId`; anything else has no such key to hold. */
function bodyNamesUserId(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    !Array.isArray(body) &&
    Object.prototype.hasOwnProperty.call(body, 'userId')
  );
}

function credentialRefusal(reason: CredentialRefusal): string {
  switch (reason) {
    case 'expired':
      return 'That credential has expired';
    case 'kind':
      return 'That credential is not an API credential';
    case 'signature':
      return 'That credential was not signed by this deployment';
    default:
      return 'That credential is not well formed';
  }
}

/**
 * Reject a request that was not addressed to this deployment.
 *
 * Two headers, one failure each. `Host` is checked first because DNS rebinding makes a remote
 * page look like `127.0.0.1` to the browser while answering for an attacker's domain — the loopback
 * binding does not help once the name resolves to it. `Origin` is then required to agree with the
 * `Host` on any mutating request, which is what a cross-site form cannot fake.
 *
 * No proxy support: `X-Forwarded-Host` is deliberately ignored, so putting this behind one means
 * naming the public hostname in `API_ALLOWED_HOSTS` (ADR-0007 keeps the API loopback; ADR-0011 §6).
 */
export function rejectMisdirectedRequest(request: FastifyRequest, config: ApiConfig): void {
  const host = hostnameOf(request.headers.host);
  if (host === null || !config.allowedHosts.includes(host)) {
    throw ApiError.validation('This deployment does not accept requests for that host');
  }

  if (NON_MUTATING.has(request.method) || request.headers.origin === undefined) return;

  const origin = hostnameOfOrigin(request.headers.origin);
  if (origin === null || origin !== host) {
    throw ApiError.forbidden('The request origin is not this deployment');
  }
}

/**
 * The hostname a `Host` header names, without the port and without an IPv6 literal's brackets.
 *
 * Parsed through `URL` rather than split on `:` because an IPv6 literal contains colons itself;
 * `URL` is the thing that already knows the difference between `[::1]:3001` and `example.com:3001`.
 * Anything it cannot parse — an absent, empty or malformed header — is `null`, which no allowlist
 * contains.
 *
 * Exported because the empty-and-malformed cases cannot be driven through `app.inject()`: an HTTP
 * client drops an empty `Host` and sends its own default instead, so the wire never shows the value
 * the parser is being asked about.
 */
export function hostnameOf(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === '') return null;
  try {
    // A scheme is invented, not asserted: these are not URLs, but `URL` will not parse a bare
    // host:port and the port is the one part we do not care about.
    return normalizeHostname(new URL(`http://${raw}`).hostname);
  } catch {
    return null;
  }
}

/** The hostname an `Origin` names. `null` — a sandboxed or `file:` page — has no hostname, and is refused. */
function hostnameOfOrigin(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The identity a route acts for.
 *
 * A route reaching this without a principal is a bug in {@link isGuarded}, not a caller error, so
 * it is a 500: answering such a request with the caller's own `userId` is exactly the hole this
 * module closes.
 */
export function principalOf(request: FastifyRequest): Principal {
  if (request.principal === undefined) {
    throw new ApiError(
      ERROR_CODES.INTERNAL_ERROR,
      'This route was reached without an authenticated principal',
      500,
    );
  }
  return request.principal;
}

/**
 * The browser session behind a page's principal.
 *
 * A page handler needs one thing from it that the principal does not carry: the CSRF token to put
 * in the form, so the POST coming back can be recognised as the same browser's. Identity still comes
 * from `principalOf` — this is the token, not the candidate.
 *
 * Absent session means the guard was skipped, which is a bug in this file rather than a caller
 * error, so it is a 500 and not a redirect: a page that rendered a form with no session would show
 * a token nobody can echo.
 */
export function sessionOf(request: FastifyRequest): SessionData {
  if (request.session === undefined) {
    throw new ApiError(
      ERROR_CODES.INTERNAL_ERROR,
      'This page was reached without a browser session',
      500,
    );
  }
  return request.session;
}

/**
 * Ownership, checked at the point of use (SRS 8.2).
 *
 * A row belonging to another candidate is answered as **absent**, not as forbidden: a 403 confirms
 * the id exists and names someone else, which is a fact this API has no business publishing. The
 * repositories still filter list reads by `userId` — this is the second check, on the row that
 * came back, so a route that fetches by id cannot answer across candidates.
 */
export function ownedBy<T extends { userId: string }>(
  resource: T | null,
  principal: Principal,
  label: string,
): T {
  if (resource === null || resource.userId !== principal.userId) {
    throw ApiError.notFound(`${label} was not found`);
  }
  return resource;
}
