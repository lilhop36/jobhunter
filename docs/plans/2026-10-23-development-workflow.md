# Development-workflow verification — 2026-10-23

Phase 3 of the roadmap. Baseline `0e689b3`, Node `v26.4.0`, npm `11.5.2`.

## Blocking defect found and fixed

Both process entry points parse configuration **before** any Prisma Client exists, and Prisma
Client's implicit `.env` load is the only thing that used to read the file. `parseApiConfig` and
`parseWorkerConfig` both require `DATABASE_URL`, so:

```
npm run dev:api     # failed: DATABASE_URL missing
npm run dev:worker  # failed: DATABASE_URL missing
```

despite `.env.example` instructing "Copy to `.env`". Fixed by loading the file explicitly with
Node's built-in flag in every script that needs it:

| Script | Before | After |
| --- | --- | --- |
| `dev:api`, `dev:worker` | `tsx watch <file>` | `node --env-file=.env --watch --import tsx <file>` |
| `start:api`, `start:worker` | `node dist/...` | `node --env-file=.env dist/...` |
| `seed:sources` | `node scripts/...` | `node --env-file=.env scripts/...` |
| `seed:candidate`, `telegram:resolve` | `tsx scripts/...` | `node --env-file=.env --import tsx scripts/...` |

`engines.node` raised from `>=20` to `>=20.6`, the first version with `--env-file` and `--import`.
No dependency was added.

`telegram:resolve` was independently broken for the same reason: it reads `TELEGRAM_BOT_TOKEN`
before constructing a client, so it could never see `.env`.

## Verified

| Check | Command | Result |
| --- | --- | --- |
| Dependency tree intact | `npm ls --depth=0` | 9 declared packages, no missing/extraneous |
| Type check | `npm run typecheck` | exit 0 |
| Unit suite needs no services | `npm run test:unit` | 36 files / 446 tests, 46 s |
| Production build | `npm run build` | exit 0, `dist/` written |
| API starts from `.env` | `npm run dev:api` then `GET /health` | `200 {"status":"ok"}` |
| Worker enforces required bounds | `npm run dev:worker` | `WorkerConfigError: SOURCE_STALE_RUN_SECONDS is required` |
| Seed script runs | `npm run seed:candidate -- --template` | exit 0, prints the format, writes nothing |
| Full gate (earlier today) | `npm run verify` | 69 files / 791 tests |

Test-database safety was established in Phase 1 (commit `e9a8331`): `TEST_DATABASE_URL` must name a
database ending in `_test`, and `applyTestMigrations`, `createTestPrismaClient` and `truncateAll`
all validate before any Prisma process exists.

## Not verified, and why

- **Clean-room `npm ci`.** Verifying it requires removing `node_modules`, which is unrelated
  user state. `package-lock.json` is committed and `npm ls` reports a consistent tree.
- **Deployment / restore drill.** Out of scope for this phase; FR-021 (backup) is still
  unimplemented, so there is nothing to drill yet.
- **Live source collection and Telegram delivery.** Not touched in this phase.

## Remaining setup blockers

1. The local `.env` lacks `SOURCE_STALE_RUN_SECONDS` and `SOURCE_ACQUISITION_TIMEOUT_MS`, so the
   worker cannot start until the operator adds them. Correct behaviour, wrong default config.
2. No CI exists (no `.github/`), so nothing enforces type check, tests or the layering rule
   (ENG-015) automatically.
3. `AI_PROVIDER` is documented but unread (drift D17).

## Script hygiene

`test`, `test:ci` and `verify` overlap: `test:ci` is `vitest --run`, while `verify` adds the disk
check and `tsc --noEmit`. `verify` is the release gate; the README says so. No script was removed.

`npm run build` compiles both entry points; there is no separate frontend build because the UI is
server-rendered.
