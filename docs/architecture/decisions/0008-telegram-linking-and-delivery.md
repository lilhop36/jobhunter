# ADR-0008: Telegram linking and delivery

- **Status:** Accepted — 2026-10-22. All §5 items accepted: token TTL 10 min, claim-then-link order, no-destination ⇒ permanent failure, 30s dispatch cadence, resolver as operator command. Milestone 3 implemented against this policy.
- **Date:** 2026-10-20
- **Context:** SRS 3.2 (linking, content, rate limits, duplicate suppression), SRS 3.4 route table, SRS 2.2/2.4 (one candidate, one destination), FR-016/FR-017, ENG-027, M3. ADR-0006 fixed *eligibility* and left linking/delivery/retry open; this ADR closes that gap. The owner supplied the bot credential for `@jobhunterethiobot` (rooted live with `getMe`), which unlocked this work.

## 1. Decisions made here (in force until the owner objects)

### 1.1 The link is a token, not a form

`POST /api/telegram/link` (SRS 3.4) issues a random one-time token (24 bytes, base64url) plus the deep link `https://t.me/<bot>?start=<token>`. The response carries the plaintext exactly once; only its SHA-256 is stored. Consequences:

- A database leak cannot mint links (SRS 8.3).
- The token encodes nothing about the candidate but which user it was issued for — no private profile data (SRS 3.2).
- Determinism is irrelevant here; a link token is an opaque credential, not a fingerprint.

Expiry is fixed at **10 minutes** (`TELEGRAM_LINK_TOKEN_TTL_SECONDS` in `src/application/telegram/telegram-linking.ts`), not configured: the useful lifetime ends when the deep link is opened, and a longer window buys exposure, not flexibility.

### 1.2 Consumption order: claim, then link

The destination write follows the token claim (`takePending` is one `UPDATE … RETURNING` statement: unexpired, unused → used, atomically). Both outcomes of a crash between the two steps are bounded and honest:

- Token claimed, destination not written → the link is dead; the operator re-issues (cheap, no orphans serviceable later, zero replay window).
- Destination written, "used" not recorded → impossible: the claim ran first.

The reverse order (link, then claim) would keep a hijackable token alive for up to the full TTL after a successful resolution; on a personal system with no authentication that tightened window was judged more valuable than the slightly friendlier crash recovery.

### 1.3 One destination per user, relinking is a replacement

`telegram_destinations` is keyed on the user (SRS 2.2/2.4). A new deep link for the same user moves the destination; the old chat is dropped at the moment of the new claim. Chat ids are stored as text — Telegram ids may be negative (channels/groups) and can exceed 32 bits; the decimal wire form is preserved verbatim.

### 1.4 Sender behaviour is the channel's judgement

`TelegramNotificationSender` (`src/infrastructure/notification/telegram-notification-sender.ts`) posts `sendMessage` with `chat_id` + `text` and nothing else:

- **No `parse_mode`.** Notification text is rendered from untrusted listing evidence; turning on Telegram's markdown/HTML parsing would make their parsers a second, silent injection surface for hostile job content.
- **429 → transient**, and the row waits Telegram's own `parameters.retry_after` (or the standard `Retry-After` header), capped at 1 hour; **other 4xx → permanent** (unknown chat, blocked bot, bad payload do not heal); **5xx and transport failures → transient.** The dispatcher's retry ladder and the outbox row absorb these (FR-017, AC-017).
- The bot token never reaches a log line or an error `reason` (SRS 8.5); reasons are `telegram sendMessage failed with HTTP <status>`.
- A user with **no linked destination → permanent failure** with a named reason. Rationale: notifications announce *new* high-confidence matches; an outbox row that burned its ladder waiting for a link that may never come would keep retrying for days. The operator's normal order — issue link, press Start, *then* collect — makes this edge rare; the match itself is untouched by any of it (SRS 3.2 "Rate limits").

### 1.5 No credential, no dispatcher — never a placeholder send

The worker runtime starts a bounded dispatch loop (**default 30s**, `NOTIFICATION_DISPATCH_INTERVAL_MS`) only when `TELEGRAM_BOT_TOKEN` is configured. Absence:

- logs `TELEGRAM_BOT_TOKEN is not configured; notifications stay PENDING without delivery`,
- and dispatches nothing.

A no-op sender that answered `delivered: true` would poison `alreadyNotified` (ENG-027 reads the outbox) — notifications would then never be sent again. "System usable without Telegram" (ENG-008's spirit) is implemented by **not** pretending, not by marking imaginary successes.

The loop runs `recoverAbandoned()` once before its first send (single-dispatcher discipline, outbox port note) and posts no logging when a pass finds nothing due. Stop order: the dispatch loop joins *before* the scheduler and worker unwind so an in-flight send is left for the next start's recovery rather than torn from a closed pool.

### 1.6 The API never sees the bot token

The API process needs only `TELEGRAM_BOT_USERNAME` (to render the deep link). The token lives in the worker's environment. Split so that the token's blast radius is one process type, and the link route's misconfiguration (missing username) is a 500 with a nameable reason when hit, not a boot failure — the API boots without the credential it never needs.

## 2. The resolver is an operator command, not a bot process

Nothing in v1 long-polls Telegram as a standing component. `scripts/telegram-resolve.ts` polls `getUpdates` for a bounded wait (default 120s, cap 600s), resolves tokens from `start` payloads through the same use case the SRS route implies, and exits. Rationale: the loop needs exactly one message kind resolved; a standing bot receiver is new surface (update offsets, retries, onboarding UX) no SRS section defines. When one exists, this script retires.

## 3. What this does *not* do

- No bot receiver, no feedback ingestion from Telegram (VIEWS of the SRS content list's *Actions* row are recorded through `POST /api/notifications/:id/feedback`, not chat messages).
- No confirmation message back to the user on linking; the operator console reports the outcome.
- No multi-channel abstraction: one Telegram sender implementation of the port, as the SRS's "Local channels" rule (popularity alone does not justify an adapter) allows other channels to be *added*, not assumed.
- No rate-limit quota management beyond honouring 429: the v1 alert volume is one candidate's worth; a campaign-grade sender with token-bucket pacing is invented demand (YAGNI).

## 4. Reported, not patched

- **SRS 3.4 has no authentication**, so `POST /api/telegram/link` lets any loopback caller mint tokens for any userId. The token minted for another user is still *their* link — it exposes nothing — but an attacker with loopback access can tamper with everything already (PUT profile has the same standing).
- **Unlinked candidates reserve notifications that immediately fail permanently.** The eligibility gate has no "destination linked" predicate (SRS 3.2 does not list one). If the operator links *after* a collection, those rows are consumed ladder-first. Fix would be a reinstatement path for FAILED rows — deliberately not built; the order of operations covers v1.
- **`getUpdates` consumption moves the offset past *everything* before it**, not just `/start` messages. If a user has other bots... they don't; v1's bot serves this pipeline alone. A real bot receiver with per-update committing replaces this script.
- **API routes have no standardised "not configured" error code**; the link route answers plain `INTERNAL_ERROR` with a sentence stating the reason. An SRS-grade code would be an invented vocabulary (SRS 3.4 fixes the shape, we did not invent new codes beyond the four already added).

## 5. Review items (owner sign-off needed)

1. Token TTL of **10 minutes** (fixed, not configured) — acceptable?
2. **Claim-then-link** order (dead token over retained destination on a crash between the steps) — acceptable?
3. **No-destination ⇒ permanent notification failure** (row consumed rather than retried forever until the user links) — acceptable, given the operator links first?
4. Dispatch cadence default of **30s** — acceptable for a personal notification loop?
5. The resolver as an operator command rather than a standing bot process (§2) — replaceable when a bot receiver is designed.
