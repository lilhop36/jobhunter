# ADR-0011: Signed credentials, session-derived identity, and request addressing

- **Status:** Accepted — 2026-10-30. Closes audit finding **H2**. Partly supersedes **ADR-0009 §2.3** (candidate chooser as login), **ADR-0009 §2.5** (`POST /api/telegram/link` open to loopback), and the reading of SRS §8.1 that treated "authenticated" as needing a password.
- **Date:** 2026-10-30
- **Relates to:** SRS 3.1, 3.4, 8.1, 8.2, 8.5; FR-012, FR-018; ENG-008; ADR-0007, ADR-0009, ADR-0010
- **Depends on:** the HMAC primitive in `src/application/auth/credentials.ts`, and `AUTH_SECRET` being configured (≥32 bytes, required at boot).

## 1. Context

Before this change the process answered about any candidate whoever asked, as long as they could name them. The audit (H2) listed the ways, all verified against the code then in `main`:

- `GET /api/matches` and `GET /api/notifications` omitted `userId` and returned **every** candidate's rows.
- `PUT /api/profile` trusted `?userId=`; source runs could be triggered anonymously.
- `/login?userId=<uuid>` minted a session *and* a CSRF cookie for any stored profile, and a page listing every stored id sat behind it.
- `POST /api/telegram/link` minted a link token for any body `userId`. Redeeming that token binds the redeemer's Telegram chat to the named candidate, so the attack redirects someone else's job alerts — the route comment's claim that the token "exposes nothing about them" was false in consequence.
- The HTML match detail checked no ownership, so a session for A could read B's evidence by id.
- No `Host` or `Origin` check existed, and `API_HOST` accepted any bind address: one environment variable moved the whole unauthenticated surface onto the LAN in cleartext, and DNS rebinding makes a hostile page same-origin with `127.0.0.1` regardless.

ADR-0009 §2.5 stated the posture plainly: the session cookie "only protects browser-initiated requests from *other* origins", because a loopback caller could already do anything. That is not an authorization boundary; it is a tie-breaker between two callers who are both already inside.

SRS §8.1 says "the seeded user shall be authenticated" and §8.2 says "ownership must be enforced server-side at the service layer". §8.1 adds "passwords … if used", which ADR-0009 read as permission to have no credential at all. This ADR records the other half of that reading: a credential is whatever is hard to forge and easy to check, and a locally-minted signed claim is exactly that. A password would have been the same mechanism with a secret the operator has to remember and a reset flow to maintain.

## 2. Decision

### 2.1 Identity comes from the guard, never from the request

One `preHandler` in `apps/api/auth.ts`, registered before any route, decides who is asking, deny-by-path:

- **`/api/*` (except `/health`)** needs a principal — an `Authorization: Bearer <credential>` the deployment signed, or the `jh_session` cookie of a signed-in browser. Bearer is tried *first and refused as a credential* when invalid; it does not fall through to the session, because a truncated token answered from an unintended cookie is worse than an error.
- **Every page that is not `/login`, `/logout`, or `/health`** needs a session, and gets one without one is redirected to `/login` before its handler runs — including a `POST` to a form page, whose body is never parsed, and including a path that matches no route.
- Handlers read the identity from `principalOf(request)` (or `sessionOf(request)` for the CSRF token) and nowhere else. A route added next month is covered without its author remembering to ask; opting out means editing this file.

Then, and ordered *after* the session/principal check so an unauthenticated caller is not taught the parameter rules: **any request naming `userId` — in the query (including a percent-encoded key) or as a top-level body key — is refused with 400**, not silently ignored. A silently ignored identity parameter is the worst outcome, because the request succeeds and the caller believes they asked about somebody else.

`/login` and `/logout` stay public by necessity: guarding the page that creates a session makes sign-in unreachable, and guarding the page that ends one makes an expired session unendable.

### 2.2 Ownership is enforced where the row is read

A principal's `userId` is the only place an identity may be read from, and every per-candidate query is filtered by it — `FindMatchesForUser`, `findForUser`, notifications by `userId`, and `/matches/:id`, which compares the row's `userId` to the principal's. A foreign row answers **404 exactly like a missing one**: a 403 would confirm the id exists and belongs to someone you are not, which is a fact about the candidate you asked about.

### 2.3 Two credentials, one key, one shape

`src/application/auth/credentials.ts` mints and verifies `v1.<base64url(JSON payload)>.<base64url(HMAC-SHA256)>` with `AUTH_SECRET`. The payload carries the candidate (`u`), an expiry (`e`), a kind (`k`: `login` or `api`), and for login codes a nonce (`n`). Verification is constant-time, and the kind is bound: an API credential presented at `/login` is refused as what it is, and vice versa.

- **Sign-in code** (`npm run login`, default `--kind login`): 60-second TTL, single-use through the in-process `NonceRegistry`, minted only from a terminal on the same machine as the database. Opening it at `/login?code=…` mints the session and CSRF cookies and redirects to `/dashboard`. `npm run login -- --email …` chooses among several candidates; the chooser page is gone, because a page that lists stored ids *is* a way to be handed a session for any of them.
- **API credential** (`npm run token`): default 30 days, capped at 365, for scripted callers.

**Signature buys unforgeability, not revocation.** A credential is valid until its `e` passes; there is no per-token revocation list. The consequence the operator must know: **rotating `AUTH_SECRET` invalidates every outstanding login code, API credential, and (through the same key) the sessions they minted**, and is therefore the only revocation mechanism available. It is also why `AUTH_SECRET` is required at boot rather than defaulted — a predictable key makes every claim in this section forgeable.

### 2.4 The sign-in code lives in a URL, so the URL never reaches the log

A one-time credential in a query parameter is a credential in the access log unless something is changed, and Fastify 4 serialises the whole `req.url` with no `redact` path onto `req.query`. So the process runs `disableRequestLogging: true` and logs its own lines (`apps/api/request-log.ts`): `request:{method,path,remoteAddress}` and `response:{statusCode,responseTime}` — the **path**, never the query string. The same reason applies to reflected error bodies: the 404 handler echoes `pathOf(request.url)`, so a code pasted into an address bar cannot be echoed back into a proxy log or a screenshot. Logs still carry no candidate content (SRS 8.5).

### 2.5 Addressing is checked, and the bind fails closed

- **`Host`** must match the allowlist: loopback defaults, plus `API_ALLOWED_HOSTS` when configured. One `normalizeHostname` handles ports, IPv6 brackets, case, and an absent or unparseable header — an empty `Host` is refused, not treated as a match, because the deployment cannot read what it cannot see. `X-Forwarded-Host` is ignored: this app is loopback-bound and must not let a header choose its own authority.
- **`Origin`**, when present on a mutating method, must equal the `Host`. Same-origin-by-construction is what DNS rebinding defeats.
- **A non-loopback bind fails closed**: `API_HOST` that is not loopback is refused at boot unless `API_ALLOW_EXTERNAL_BIND=true` *and* `API_ALLOWED_HOSTS` names the host it will answer to. Exposing the process is now an explicit, two-variable decision instead of a typo in one.

### 2.6 Mints require a session

`POST /api/telegram/link` and `POST /settings/telegram` take the candidate from the principal and accept no body `userId`. A caller that cannot prove who it is cannot mint a link token, so the redirect-someone-else's-alerts path from §1 needs the victim's own browser session.

## 3. Consequences

- **The trust boundary moves from "who can reach the port" to "who can run a local command".** Anyone with a shell on this machine can still mint a code — as they can already read the database, hold `AUTH_SECRET`, and stop the process. That is the threat model the SRS describes for a personal tool; what is closed is the *network* and *browser* paths in, which previously needed no credential at all.
- **A browser has no scripted fallback.** Pages get cookies; scripts get `npm run token`. There is no CORS affordance, because there is no cross-origin caller.
- **Restart costs a sign-in.** Sessions and consumed-code nonces are in-process maps (ADR-0009 §2.4 unchanged). A restart logs the browser out; a login code's 60-second life means the replay window a restart could have reopened is already closed.
- **`AUTH_SECRET` becomes a required deployment secret**, alongside the database URL, and `parseApiConfig` refuses to boot without it.
- **The tests sign in for real.** `tests/support/web.ts::signIn()` mints a genuine code and opens it, so the suite exercises the credential path rather than a fixture cookie.

## 4. Alternatives rejected

| Alternative | Why not |
|-------------|---------|
| Keep the chooser, gate it behind a confirm step | The gate is UI, not authority: any caller who can reach `/login?userId=` still gets a session for that id. Listing ids is the vulnerability. |
| Password + server-side session | Satisfies §8.1 literally, but adds a stored secret, a reset flow, and rate limiting for a single-operator loopback tool — and the resulting session cookie is the same object §2.1 already trusts. The owner chose the local code. |
| Opaque random token per credential, stored in the database | Revocable, at the cost of a table and a lookup per request. Signing buys unforgeability without storage; revocation here is `AUTH_SECRET` rotation, which is enough for two credential kinds an operator mints deliberately. Revisit if credentials are ever handed to third parties. |
| Unix socket for `/api/*` | Strongest for loopback, unavailable on the Windows host this runs on, and it would split the web and JSON surfaces across two transports. |
| `req.url` redaction instead of path-only logging | Fastify 4's `redact` addresses serialised values, not `req.query`; the whole URL is emitted before redaction can reach it. |
| Ignore a request's `userId` now that routes do not need it | The caller is not told anything went wrong, and gets their own data believing they got someone else's. Refusing is one line and teaches the rule out loud. |

## 5. Open questions (owner sign-off, 2026-10-30)

1. **Web sign-in = local one-time code** — answered: yes, "Local one-time login code".
2. **JSON API = session cookie plus a bearer token when not loopback** — answered: yes; the token is available at any bind and is the scripted path.
3. **365-day maximum credential life** — acceptable, or shorten? Nothing rotates automatically; an operator who leaves a token in a script has one year.
4. **`AUTH_SECRET` rotation as the only revocation** — acceptable for a personal deployment?

## 6. Follow-ups this ADR does not close

- **TLS is still not implemented.** §2.5 refuses a non-loopback bind that has not opted in and named its hosts, but `API_ALLOW_EXTERNAL_BIND=true` does not require a certificate. Do not set it on a routable interface.
- **Session and nonce stores stay in-process**, so a second API replica would double the login-code namespace and forget sessions on rebalance (ADR-0009 §2.4's Redis note still applies).
- **`/health` remains unauthenticated and answers only `{status:'ok}'`** — the connectivity and migration preflight halves of audit H1 are still open.
- SRS §1.7/§2.2 still describe one seeded candidate while the model holds N; drift D3 and §3 of the drift register need the v1.2 amendment, not more code.
