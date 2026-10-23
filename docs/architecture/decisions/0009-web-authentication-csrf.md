# ADR-0009: Web authentication and CSRF

- **Status:** Accepted — 2026-10-22. SameSite=Lax session cookie + double-submit CSRF token; no password; candidate chooser; in-memory store; 30-day TTL.
- **Date:** 2026-10-22
- **Relates to:** ADR-0007 (server-rendered HTML), SRS 3.1 (`/profile`, `/settings`, `/settings/telegram`), SRS 3.4 (`PUT /api/profile`, `POST /api/telegram/link`), FR-012, FR-018, ENG-008
- **Depends on:** ADR-0007 accepted; the read-only pages and JSON API already exist.

## 1. Context

SRS 3.1 names three mutating routes:
- `/profile` — edit the candidate profile (calls `PUT /api/profile`)
- `/settings` — global preferences (not yet in the API)
- `/settings/telegram` — link the Telegram bot (calls `POST /api/telegram/link`)

The API has **no authentication** and binds **loopback only** (`127.0.0.1`). But a browser on the same machine can be tricked into POSTing to `127.0.0.1:<port>` by any web page it visits (CSRF). A form therefore needs an origin check *and* a token, or a same-site cookie with a session concept.

## 2. Decision

### 2.1 Session cookie (same-site, httponly)

- A single session cookie `jh_session` identifies the browser's chosen candidate.
- Value: opaque random token (24 bytes, base64url), mapped server-side to a `userId`.
- Attributes: `HttpOnly; Secure` (when TLS); `SameSite=Lax`; `Path=/`; `Max-Age=30d`.
- `SameSite=Lax` means the cookie is sent on top-level navigations and form POSTs from the same site, but **not** on subresource requests from other origins — this is the primary CSRF defence.

### 2.2 Double-submit CSRF token as defence in depth

- A second cookie `jh_csrf` (non-HttpOnly, so JavaScript can read it) carries a per-session CSRF token.
- Every mutating form includes a hidden field `_csrf` with the same value.
- The server verifies `cookie === form` on every state-changing request (`PUT`, `POST`, `DELETE`).
- This works even if a future browser relaxes `SameSite` behaviour, and it protects the JSON API
  (which also requires the header `X-CSRF-Token: <value>` for non-browser callers).

### 2.3 No password, no login flow

- v1 is a **personal, single-machine** tool. The operator seeds the candidate (`npm run seed:candidate`).
- The web UI shows a **candidate chooser** when more than one profile exists (already implemented in `apps/api/routes/web.ts::resolveCandidate`).
- Selecting a candidate sets the session cookie; no password, no email, no OAuth.

### 2.4 Session store: in-memory, single-process

- The API is one process. A `Map<sessionToken, { userId, csrfToken, createdAt }>` is sufficient.
- On restart, sessions are lost — the user picks their candidate again. Acceptable for v1.
- If the API ever scales, the map moves to Redis without changing the cookie contract.

### 2.5 `POST /api/telegram/link` stays open to loopback callers

- The link route mints a token for *any* `userId` the caller names (SRS 3.4). It does not require the session cookie.
- The web page `/settings/telegram` calls it with the current session's `userId`.
- An attacker with loopback access can already `PUT /api/profile` for any user — the session cookie
  only protects browser-initiated requests from *other* origins.

## 3. Consequences

- **No authentication library**, no bcrypt, no JWT, no database table for sessions.
- **CSRF protection is two-layered**: `SameSite=Lax` (browser default) + double-submit token (explicit).
- **The JSON API is also protected**: non-browser callers must send `X-CSRF-Token` header.
- **Logout** = clear both cookies; the server forgets the session immediately.

## 4. Alternatives rejected

| Alternative | Why not |
|-------------|---------|
| Bearer token in `Authorization` header | Browser forms cannot set custom headers; would need JS, which ADR-0007 rejects. |
| Single `jh_session` cookie, no CSRF token | `SameSite=Lax` is strong but defence-in-depth costs ~10 lines; the token also protects the JSON API. |
| Full authentication (password, email, reset) | v1 is personal and loopback; the operator seeds the candidate. YAGNI. |
| Separate login page | Adds a route, a template, and state; the candidate chooser is already the "who am I" step. |

## 5. Open questions (owner sign-off needed)

1. **`SameSite=Lax` + double-submit** — acceptable as the v1 CSRF posture?
2. **No password, candidate chooser only** — acceptable for the personal, loopback scope?
3. **In-memory session store** — acceptable (lost on restart, user re-chooses)?
4. **30-day session TTL** — acceptable?

## 6. Implementation plan (after acceptance)

1. `src/application/web/session.ts` — cookie names, token generation, in-memory store, get/set/clear.
2. `apps/api/routes/web.ts` — session middleware, candidate resolution from session, login/chooser page, logout.
3. `apps/api/routes/profile.ts` — `PUT /api/profile` requires session; form page `GET /profile` renders editor.
4. `apps/api/routes/settings.ts` — `GET /settings`, `GET /settings/telegram`, `POST /settings/telegram` (calls link API).
4. Templates: `profileForm`, `settings`, `settingsTelegram`, `chooseCandidate`, `loggedInAs`.
5. Integration tests: session lifecycle, CSRF rejection, chooser flow, profile save round-trip.