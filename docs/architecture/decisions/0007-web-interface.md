# ADR-0007 — Web interface: server-rendered HTML in the API process

- **Status:** Proposed — the approach needs owner review. The read-only pages described here
  are implemented and tested; the forms (`/profile`, `/settings`) are not, and are the part this
  ADR most needs a decision on (§5).
- **Date:** 2026-10-20
- **Requirement:** SRS 3.1 (required routes, dashboard, match detail, provenance, low bandwidth,
  accessibility), SRS 3.3; FR-011, FR-015, FR-018.

## 1. Context

SRS 3.1 names the required routes (`/dashboard`, `/jobs`, `/jobs/:id`, `/matches`, `/profile`,
`/settings`, `/settings/telegram`) and the behaviours those pages owe: a dashboard prioritising
new matches, high-confidence opportunities, notification status and basic source health; a match
detail showing score, confidence, factor breakdown, matched/missing/uncertain fields, source,
salary, location, description quality and application path; provenance that keeps source-provided,
deterministic and AI-derived values distinguishable; low bandwidth; and accessibility
(keyboard, touch, semantic labels, never colour alone).

Every fact those pages need is already served by the SRS 3.4 JSON API or by a port behind it.
Nothing about the interface requires a build tool, a client-side data layer or a second process.

## 2. Decision

1. **The web interface is server-rendered HTML served by the existing Fastify app.** No SPA, no
   client framework, no bundler, no build step, no client JavaScript at all in the first increment.
   A page is a request that reads through the same ports the JSON routes use and returns a
   complete document.
2. **No new dependencies.** HTML is produced with a tagged template that escapes every
   interpolation by default (`apps/api/web/html.ts`); the only way to emit markup unescaped is an
   explicit `raw()` call, which the pages use for already-built documents only.
3. **No assets.** One inline stylesheet, system font stack, no images, no web fonts, no icons.
   That is the low-bandwidth decision: a page is its own HTML plus a few hundred bytes of CSS, and
   a client fetches nothing else.
4. **Every response carries a restrictive CSP** (`default-src 'none'; style-src 'unsafe-inline';
   base-uri 'none'; form-action 'none'; frame-ancestors 'none'`) plus `nosniff` and
   `no-referrer`. With no scripts and an escaping-by-default template, XSS has to defeat both the
   escaping and a policy that forbids scripts outright. Job titles and descriptions are hostile
   input; that is the reason for the belt and braces, and it is tested.
5. **Pagination is links, not scripts.** Cursors are the same base64url keyset tuples the JSON API
   uses, rendered as `?cursor=` links.
6. **Accessibility is structural, not a later pass**: one `<h1>`, landmarks (`header`, `nav`,
   `main`), a skip link, real table headers with `scope`, key/value pairs as `<dl>`, state and
   unknown values as text, focus-visible outlines, touch-sized targets. No meaning is carried by
   colour alone.
7. **Read-only first.** This increment serves `/dashboard`, `/jobs`, `/jobs/:id`, `/matches` and
   `/matches/:id`. The mutating pages wait for the decision in §5.

## 3. Consequences

- One process, one deployment artefact, one logging configuration. Operators run what they
  already run.
- No client state to keep consistent with the server, so there is nothing to make stale.
- Interactivity is limited to navigation and links. Anything richer (live filtering, inline
  feedback) either becomes a form POST with a full page reload, or a deliberate decision to add
  JavaScript — which this ADR does not authorise.
- Every page must be built from server data, so a page that needs a query the ports do not expose
  needs a port change rather than a clever workaround. That is a feature: the gap is visible.
- The routes are published by the same process that publishes the JSON API. If the API were ever
  bound beyond loopback, the web pages would be exposed with it and would need the authentication
  the SRS does not yet specify.

## 4. Alternatives rejected

- **SPA + JSON API.** Adds a build toolchain, a second set of data shapes, client-side state, and
  a much larger payload — against SRS 3.1's low-bandwidth rule. It also duplicates validation and
  formatting that the server already owns.
- **A separate web server process.** A second deployment, a second configuration surface, and a
  second way to reach the database (or a self-call to the API) for no benefit at this size.
- **A templating dependency** (EJS, Nunjucks, Handlebars). Escaping and layout are ~60 lines here;
  a dependency would add a template language to audit for a page count in single digits.
- **A CSS framework.** The whole stylesheet is smaller than the framework's reset.

## 5. Not decided here (needs the owner)

- **Forms and CSRF.** `/profile` and `/settings` mutate state. The API has no authentication and
  binds loopback, but a browser on the same machine can be made to POST to `127.0.0.1:<port>` by
  any web page it visits. A form therefore needs an origin check *and* a token, or a same-site
  cookie with a session concept that does not exist yet. That is a security decision, not a
  styling one, and it is why this increment is read-only.
- **`/settings/telegram`.** It needs the linking token flow (SRS 3.2), which is blocked on the
  Telegram credential.
- **New-match ordering.** The dashboard's "best matches" uses the stored score order, because
  `JobMatchRepository.listMatches` has no recency order. "New matches" in SRS 3.1's sense needs a
  `(userId, scoredAt DESC)` order and probably an index; it is not implemented and is reported.
- **Multiple candidates.** v1 seeds one profile (FR-012). The pages resolve the candidate from the
  single stored profile, and render a chooser when several exist, rather than assuming one. How a
  logged-in user would be identified is the authentication question the SRS leaves open.
