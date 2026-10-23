# JobHunter

Ethiopia-first job discovery and notification pipeline. It collects postings from a small set of
approved sources, preserves the raw evidence, normalizes and validates each listing, matches it
against candidate profiles deterministically, and delivers eligible matches through Telegram.

- Requirements: [`docs/SRS/JobHunter-v1.1-SRS.md`](docs/SRS/JobHunter-v1.1-SRS.md)
- What exists vs. what the SRS requires: [`docs/engineering/srs-implementation-drift-2026-10-23.md`](docs/engineering/srs-implementation-drift-2026-10-23.md)
- Decisions: [`docs/architecture/decisions/`](docs/architecture/decisions/)

Two processes share one PostgreSQL database: the API (reads, profile edits, operational commands)
and the worker (collection, scoring, lifecycle, notification dispatch). Heavy work never runs in
an API request.

## Requirements

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | `>= 20.6` (`package.json` `engines`) | Verified on `v26.4.0`. The run scripts use `--env-file` and `--import`, which need 20.6+. |
| npm | 11.x verified | `npm ci` uses the committed `package-lock.json`. |
| PostgreSQL | 13+ | The schema relies on `gen_random_uuid()`. No Redis, no message broker. |

## Setup

```bash
npm ci

cp .env.example .env          # then fill in DATABASE_URL (and the rest you need)

createdb jobhunter            # or: CREATE DATABASE jobhunter;
createdb jobhunter_test       # integration tests; the name MUST end in _test

npx prisma generate
npx prisma migrate deploy     # applies the 12 versioned migrations

npm run seed:sources          # registers the 3 approved sources
npm run seed:candidate -- --template   # shows the profile file format, writes nothing
# write candidate-profiles.json (git-ignored), then:
npm run seed:candidate
```

`npm ci` does not delete `.env` or any database. It only replaces `node_modules`.

## Environment

`npm run dev:*`, `npm run start:*`, the seed scripts and `telegram:resolve` load `.env` through
Node's `--env-file`, so `.env` must exist. Tests load it themselves (`tests/support/load-env.ts`).

| Variable | Read by | Required | Meaning |
| --- | --- | --- | --- |
| `DATABASE_URL` | API, worker, Prisma CLI, seeds | yes | PostgreSQL connection string |
| `TEST_DATABASE_URL` | integration + failure tests | for those tests | Must name a database ending in `_test`; its rows are TRUNCATEd |
| `SHADOW_DATABASE_URL` | `prisma migrate dev` only | no | This project does not use `migrate dev` |
| `API_HOST` / `API_PORT` | API | no (defaults) | `127.0.0.1` / `3001` |
| `TELEGRAM_BOT_USERNAME` | API | no | Renders the `t.me` deep link |
| `TELEGRAM_BOT_TOKEN` | worker, `telegram:resolve` | no at start | Without it the worker runs but does not dispatch |
| `SOURCE_STALE_RUN_SECONDS` | worker | **yes** | Bound for reaping an abandoned source run |
| `SOURCE_ACQUISITION_TIMEOUT_MS` | worker | **yes** | Bound for a hanging acquisition; must be shorter than the stale window |
| `WORKER_LEASE_SECONDS`, `WORKER_HEARTBEAT_MS`, `WORKER_POLL_INTERVAL_MS`, `WORKER_REAPER_INTERVAL_MS`, `WORKER_ID` | worker | no | Defaults in `.env.example`; heartbeat must be shorter than the lease |
| `SOURCE_SCHEDULER_INTERVAL_MS`, `NOTIFICATION_DISPATCH_INTERVAL_MS` | worker | no | Default 30 s |
| `LOG_LEVEL` | API | no | Fastify level, default `info` |
| `AI_PROVIDER` | nothing yet | — | Reserved: documented but currently unread (drift report D17) |

Secrets belong in `.env` only. It is git-ignored; `.env.example` holds placeholders.

## Run

```bash
# terminal 1
npm run dev:api        # http://127.0.0.1:3001, /health, reloads on change

# terminal 2
npm run dev:worker
```

Production-style:

```bash
npm run build
npm run start:api
npm run start:worker
```

The JSON API has **no authentication**; it binds to loopback by default and must not be exposed
(drift report D1). The web pages use a session cookie plus a CSRF token (ADR-0009).

## Database

- Versioned migrations only: `npx prisma migrate deploy`.
- Never run `prisma migrate dev`, `prisma db push` or `prisma migrate reset` against a database you
  care about; `migrate dev` is also the only path that needs `SHADOW_DATABASE_URL`.
- Some invariants are hand-written SQL (partial unique indexes, the `SKIP LOCKED` claim query).
  They live in `prisma/migrations/**/migration.sql` and are covered by
  `tests/integration/partial-indexes.spec.ts`.
- No automated backup exists yet (FR-021 open). Take manual dumps: `pg_dump "$DATABASE_URL" > dump.sql`.

## Tests

| Command | Touches the database? | Use |
| --- | --- | --- |
| `npm run typecheck` | no | `tsc --noEmit` |
| `npm run test:unit` | no | Unit suite, no services required |
| `npm run test:integration` | **yes — TRUNCATEs `TEST_DATABASE_URL`** | Routes, repositories, queue, lifecycle |
| `npm run test:failure` | **yes** (spawns API/worker processes) | Kill/restart and shutdown behaviour |
| `npm run verify` | **yes** | Release gate: disk check + `tsc --noEmit` + the whole suite |
| `npm test` | watch mode | Local iteration |

Safety rule: `tests/support/db.ts` refuses to run unless `TEST_DATABASE_URL` names a PostgreSQL
database ending in `_test`. A normal development database is rejected before any Prisma process
starts.

## Build

`npm run build` compiles to `dist/` (`tsc --build` + `tsc-alias`). There is no separate frontend
build: the UI is server-rendered HTML.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `Cannot find module '.env'` / `ERR_FAILED_TO_LOAD_ENV_FILE` at start | The run scripts pass `--env-file=.env`; copy `.env.example` to `.env` |
| `Refusing to run tests: TEST_DATABASE_URL names the database "jobhunter", which is not marked disposable` | Point it at a `*_test` database |
| `TEST_DATABASE_URL is not set` | Add it to `.env` |
| `WorkerConfigError: SOURCE_STALE_RUN_SECONDS is required` | Set both required worker bounds |
| `WORKER_HEARTBEAT_MS (...) must be shorter than WORKER_LEASE_SECONDS` | Lower the heartbeat or raise the lease |
| `415 Unsupported Media Type` on `/api/*` | The JSON API accepts `application/json` only; only `POST /profile` and `POST /settings/telegram` accept form bodies |
| `Prisma CLI not found` in tests | `npm ci` |
| Outbound fetches fail behind a corporate proxy | Node 24+: `NODE_USE_ENV_PROXY=1` so `fetch` honours `HTTPS_PROXY` |
| Port already in use | Set `API_PORT` |
| A dev process exits at once | Run without `--watch` or read the first error line; `--watch` keeps the wrapper alive after a failed start |

## Recovering from a failed run or deployment

1. Stop the API and worker (SIGTERM; both shut down gracefully and release their in-flight work).
2. Migrations are forward-only. Roll back the code, not the database; an already-applied migration
   stays applied. If a migration failed midway, Prisma records it in `_prisma_migrations`; restore
   from a `pg_dump` and re-apply.
3. Restarting the worker is safe. On start it reaps expired leases and stale `RUNNING` source runs
   (`SOURCE_STALE_RUN_SECONDS`) before claiming new work, so a killed process cannot wedge a source.
4. Stuck work is inspectable:
   ```sql
   SELECT id, type, status, attempts, lease_expires_at FROM work_tasks ORDER BY created_at DESC LIMIT 20;
   SELECT id, source_id, status, started_at FROM source_runs WHERE status = 'RUNNING';
   SELECT status, count(*) FROM notification_outbox GROUP BY status;
   ```
5. Notifications are at-least-once. A crash between sending and recording `SENT` can produce one
   duplicate; the outbox unique event key prevents a second row for the same event.
6. Do not hand-edit lifecycle or match rows. Re-run collection/scoring instead.

## Known gaps

No API authentication, no backup automation, no AI provider, no CI, and no cross-source
deduplication. See the [drift report](docs/engineering/srs-implementation-drift-2026-10-23.md) for
evidence and the smallest correction for each.

## Layout

```
apps/api            Fastify API + server-rendered pages
apps/worker         worker runtime, scheduler, dispatcher
src/domain          pure rules: normalization, matching, lifecycle, notification eligibility
src/application     use cases (collection, scoring, dispatch, web session)
src/ports           interfaces the application depends on
src/infrastructure  Prisma repositories, Telegram sender, source adapters
prisma              schema + versioned migrations
tests               unit / integration / failure suites
scripts             operator commands (seeds, telegram resolve, disk check)
docs                SRS, ADRs, source approvals, reports
```
