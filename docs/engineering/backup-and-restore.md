# Backup and restore

FR-021 requires scheduled database backups; AC-019 requires that a backup can be restored;
ENG-020 requires a verified backup before a destructive migration. This page records what the
repository provides, how to schedule it, how to prove a backup restores, and what remains an
operator responsibility.

Status: the backup, restore-drill, retention and schedule scripts exist. The schema-aware drill
passed on 2026-10-30 against the local `jobhunter` database (17 tables, 565 rows, 15 migrations,
scheduler query answered). **AC-019 is still PARTIAL**: no encrypted off-machine copy has been
recorded, because this host has one volume (`C:`) and it is nearly full, so there is nowhere on
this machine to put a copy that would survive losing it. Scheduling is one command that the
operator has not yet installed. There is no `BackupRun` table; see [Why files, not a `BackupRun`
table](#why-files-not-a-backuprun-table).

## What exists

| Piece | Purpose |
| --- | --- |
| `scripts/backup.mjs` | `pg_dump` in custom format, compression 9, `--no-owner --no-privileges`; validates the archive with `pg_restore --list`; deletes a failed/empty file; with `BACKUP_COPY_DIR`, writes and verifies a second copy |
| `scripts/restore-drill.mjs` | restores an archive into a uniquely named disposable database, compares the table set, the Prisma migration ledger and exact row counts, runs the scheduler's own query against the restore, and drops the database in a `finally` block |
| `scripts/prune-backups.mjs` | retention: newest archive per day (14) and per week (8); dry run unless `--apply` |
| `scripts/install-backup-schedule.mjs` | prints the daily schedule; `--apply` registers the Windows task |
| `scripts/lib/pg.mjs` | parses the Prisma URL into libpq arguments; locates PostgreSQL's binaries; runs `psql` queries including the migration ledger |
| `npm run backup` | write `backups/jobhunter-<UTC timestamp>.dump` |
| `npm run backup:drill` | take a fresh backup and verify it restores |
| `npm run backup:drill -- <archive>` | verify an existing archive restores |
| `npm run backup:prune` | show which archives fall outside the retention windows |
| `npm run backup:schedule` | show (or, with `--apply`, install) the daily task |

`backups/` is git-ignored. The archive contains candidate, match, notification and Telegram
destination data — personal data, not the bot token (secrets live in `.env`) — so it must be
encrypted and stored off-machine. One-time Telegram link tokens are stored only as SHA-256 hashes.

## Prerequisites

- **PostgreSQL client tools, same major version as the server.** `pg_dump` refuses to dump a newer
  server. On Windows the scripts auto-detect the highest installed version under
  `C:\Program Files\PostgreSQL\<major>\bin`. Otherwise put the tools on `PATH` or set `PG_BIN`
  (e.g. `PG_BIN="C:/Program Files/PostgreSQL/16/bin"`).
- **Role rights.** `pg_dump` needs read access to the database. The drill additionally needs
  `CREATEDB`; it only reads the source. No superuser is required: the dump and restore use
  `--no-owner --no-privileges`, so objects are owned by the restoring role. The drill also needs
  free disk space for a second copy of the database.
- **Password transport.** The password is read from `DATABASE_URL` and passed to libpq through
  `PGPASSWORD`; it never appears on a command line or in script output. All tools run with
  `--no-password`, so a wrong password fails instead of prompting.
- **A second location, if you want a copy.** `BACKUP_COPY_DIR` needs write access somewhere that is
  not the repository and, to be worth having, not the same volume. Restrict that directory's access:
  the archive holds personal data.
- **Disk space.** A fresh drill restores a second full copy of the database, so it needs room for
  one. `scripts/check-disk-space.mjs` (run by `npm run verify`) reports how little margin is left.

## Take a backup

```bash
npm run backup
# [backup] wrote backups\jobhunter-20261030T074719Z.dump (0.34 MB, database jobhunter)
# [backup] no BACKUP_COPY_DIR set: this archive exists on one machine only. ...
```

`BACKUP_DIR` moves the output; point it at another disk, not the repository volume:

```bash
BACKUP_DIR="D:/jobhunter-backups" npm run backup
```

Windows:

```powershell
$env:BACKUP_DIR = 'D:\jobhunter-backups'; npm run backup
```

Properties:

- `pg_dump` reads from one MVCC snapshot, so a backup is consistent while the API and worker keep
  running. Writes after the snapshot are not in the archive.
- `--lock-wait-timeout=30s` makes an unattended run fail rather than hang behind a conflicting DDL
  lock.
- A non-zero exit, an empty file, or an unreadable archive deletes the file and exits 1. A partial
  file is never left looking like a backup.
- File names use UTC to the second; two backups in the same second get a `-1`, `-2` suffix.
- The archive is PostgreSQL's custom format (`PGDMP`), restorable with `pg_restore`, and supports
  selective restores.

### Put a copy somewhere else

`BACKUP_COPY_DIR` writes a second copy of the verified archive and proves the copy is usable before
the run reports success: the copy must be byte-identical (SHA-256), non-empty, and readable by
`pg_restore --list`. A copy that fails any of those is deleted and the run exits 1 — while the local
archive, which already passed validation, is kept.

```bash
BACKUP_COPY_DIR="D:/jobhunter-backups" npm run backup
```

Verified on 2026-10-30 against a temporary directory (the only writable second location on this
host, which is why the warning appears):

```text
[backup] wrote backups\jobhunter-20261030T074719Z.dump (0.34 MB, database jobhunter)
[backup] verified copy at ..\..\AppData\Local\Temp\jobhunter-backups-copy\jobhunter-20261030T074719Z.dump (sha256 f17d865f9e67..., pg_restore --list passed)
[backup] warning: the copy is on the same volume as the archive; one disk failure loses both. Point BACKUP_COPY_DIR at another disk, machine or storage service.
```

The destination has to be a real second location, and the script refuses destinations that are not:

- it must be outside the repository — a copy inside the working tree does not survive losing the
  machine;
- it must differ from `BACKUP_DIR`;
- if it resolves to the same filesystem root as the archive, the run succeeds but prints a warning,
  because one disk failure would take both.

**On the current host there is nowhere to put a copy.** Only `C:` exists and it is at capacity, so
`BACKUP_COPY_DIR` can only ever warn here. Until the archive is copied to another machine, a
network volume, or an encrypted storage service and a drill is run against that copy, AC-019 stays
PARTIAL. The SRS risk table names "off-machine backup plus restore test" as the mitigation for
backup failure, so the copy and the drill are one action, not two. Encrypt it before it leaves the
host (`age`, GPG, or a BitLocker-protected volume) — the scripts do not encrypt, because this
project has no key management to verify a decryption against, and an untested cipher is not
security.

Prune the copy directory separately; retention is per directory:

```bash
npm run backup:prune -- --dir "D:/jobhunter-backups"
```

## Verify a backup (restore drill)

A backup is not evidence until it has been restored. The drill restores into a disposable database
on the same server.

```bash
# Take a fresh backup, then restore it and compare against the live database.
# Stop the API and worker first: exact row counts require a quiescent source.
npm run backup:drill

# Restore an existing archive. This is a point-in-time snapshot, so table, row and migration
# differences from today's database are reported as notes, not failures.
npm run backup:drill -- backups/jobhunter-20261025T065807Z.dump
```

What it does:

1. Validates the archive with `pg_restore --list` **before** creating anything.
2. Creates `jobhunter_restore_drill_<UTC timestamp>_<6 hex>` on the same server (role needs
   `CREATEDB`). A strict name guard makes it impossible to drop anything else.
3. Restores with `--exit-on-error --no-owner --no-privileges`.
4. Compares the public table set and exact per-table row counts with the source.
5. Compares Prisma's migration ledger — names **and** checksums — with the source, and checks the
   restored ledger against the migrations in this checkout.
6. Runs the scheduler's own query (`job_sources` joined to `source_runs`, as
   `PrismaJobSourceRepository.listSchedulable` does) against the restored database.
7. Drops the disposable database in a `finally` block. If cleanup fails, the drill exits 1 and
   names the database so it can be dropped manually.

Matching table sets and row counts is not enough: an archive taken from a database that is behind
the code restores perfectly, counts match, and is then unusable by the application. That is why
steps 5 and 6 exist, and they are what the 2026-10-25 drills could not have detected.

A **fresh-backup** run is strict: every source table must be present with the same row count, the
ledgers must be identical, the source must already be migrated to this checkout, and the scheduler
query must answer. If the API or worker was writing during the drill, counts can legitimately
differ; stop them and re-run. An **existing archive** must restore without error and contain tables;
differences from the live database, migrations it predates, and a scheduler query it cannot answer
are reported as notes, because the archive is from an earlier point in time and `npx prisma migrate
deploy` is part of recovering onto it.

### Recorded drills

| Date (UTC) | Archive | Mode | Result |
| --- | --- | --- | --- |
| 2026-10-25 | `backups/jobhunter-20261025T065843Z.dump` | fresh | **PASS** — 17/17 tables, 484/484 rows; drill database `jobhunter_restore_drill_20261025T065844Z_37d1b3` dropped |
| 2026-10-25 | `backups/jobhunter-20261025T065807Z.dump` | existing | **PASS** — 17 tables, 484 rows restored; no differences observed; drill database dropped |
| 2026-10-25 | `backups/jobhunter-20261025T072155Z.dump` | fresh | **PASS** — re-ran against the final scripts: 17/17 tables, 484/484 rows; drill database dropped |
| 2026-10-25 | missing archive | existing | Correctly exits 1 before creating a database |
| 2026-10-25 | non-archive text file | existing | Correctly exits 1 at validation, before creating a database |
| 2026-10-30 | `backups/jobhunter-20261030T074806Z.dump` | fresh | **PASS** — 17/17 tables, 565/565 rows, ledgers identical, 15 migrations applied and current with the checkout, scheduler query answered with 3 sources; drill database `jobhunter_restore_drill_20261030T074808Z_f0bb85` dropped |
| 2026-10-30 | `backups/jobhunter-20261025T065807Z.dump` (the 13-migration archive) | existing | **PASS with notes** — restored 17 tables, 484 rows; reported the 2 migrations missing against today's ledger, reported them pending against this checkout, and still answered the scheduler query. The pre-2026-10-30 drill certified this archive as a clean match |
| 2026-10-30 | the same archive forced through **fresh** mode | fresh | Correctly exits 1: "The restored migration ledger does not match the source database", listing both migrations; drill database dropped by `finally` |

After the drills, `pg_database` contained no `jobhunter_restore_drill_%` rows. The drill archives
listed above are local, git-ignored artifacts, not the production backup set.

**Run a drill after every change to the schema or the scripts, and periodically thereafter** (for
example monthly) against the latest off-machine copy. Append the result to the table above.

## Schedule it

FR-021 asks for scheduled backups. The repository can now install that schedule, but installing an
operating-system task is an operator action, so `npm run backup:schedule` **prints the command by
default** and only registers it with `--apply`. **Not installed on this host as of 2026-10-30.**

```bash
npm run backup:schedule                      # show what would run
npm run backup:schedule -- --apply           # register the Windows task (daily 02:00)
npm run backup:schedule -- --time 03:30 --task-name "JobHunter backup"
```

On Windows the task is:

```text
schtasks /Create /SC DAILY /ST 02:00 /TN "JobHunter backup" /TR "cmd /c cd /d "<repo>" && npm run backup >> "<repo>\backups\backup.log" 2>&1" /F
```

The printed line is a rendering of what `--apply` passes, not something to paste into cmd.exe; the
`/TR` value contains its own quotes, so use `--apply` rather than copy-paste. The task runs as the
account that registers it and only while that account is signed in, so no password is stored.
`BACKUP_DIR`, `BACKUP_COPY_DIR` and `PG_BIN` come from `.env`, which the npm script loads; make sure
`npm` is on that account's `PATH`. Check it with:

```powershell
schtasks /Query /TN "JobHunter backup"
schtasks /Run /TN "JobHunter backup"   # then confirm a fresh .dump and a line in backups\backup.log
```

On Linux or macOS the same script prints the cron line, and installing it stays with the account
owner (`crontab -e`) because cron does not load a login shell's `PATH`:

```cron
0 2 * * * cd /srv/jobhunter && /usr/bin/npm run backup >> backups/backup.log 2>&1
```

A failed backup has to be visible: the schedule appends to `backups/backup.log`, and nothing
watches that log. A backup nobody checks is not a backup.

## Retention

`npm run backup:prune` applies the rolling window without deleting anything until asked:

```bash
npm run backup:prune                        # dry run: what falls outside the windows
npm run backup:prune -- --apply             # delete those archives
npm run backup:prune -- --keep-daily 21 --keep-weekly 12
npm run backup:prune -- --dir "D:/jobhunter-backups" --apply
```

The default is 14 daily and 8 weekly: for each of the last 14 UTC days the newest archive is kept,
for each of the last 8 Monday-based weeks the newest archive of that week is kept, and the single
newest archive is always kept, so a directory can never be emptied by a bad clock. Only names this
project writes (`jobhunter-<UTC stamp>[-n].dump`) are considered; other files are ignored rather
than reported as expired. Retention is per directory, so run it once for `BACKUP_DIR` and once for
`BACKUP_COPY_DIR`.

Deleting backups is destructive, so `--apply` is required and the script is never wired into the
schedule. Run it by hand after checking that a newer copy exists off-machine.

## Restore after data loss

These scripts deliberately do **not** restore over the live database.

1. Stop the API and worker (SIGTERM; both release in-flight work).
2. If the current database is still reachable, take a safety dump first:
   `npm run backup`.
3. Create a new empty database and restore the chosen archive into it:
   ```bash
   createdb -h localhost -p 5433 -U postgres jobhunter_recovered
   pg_restore --exit-on-error --no-owner --no-privileges \
     --dbname jobhunter_recovered backups/jobhunter-20261025T065807Z.dump
   ```
   Run these with the same environment the scripts use (PostgreSQL bin on `PATH` or `PG_BIN`,
   `PGPASSWORD` set). The drill script is the reference implementation.
4. Point `DATABASE_URL` at the recovered database. Check the migration state:
   `npx prisma migrate status`. An archive from before the newest migration restores cleanly and is
   still behind the code — `npm run backup:drill -- <archive>` names the pending migrations before
   you need them. Apply them with `npx prisma migrate deploy`. Do not run `prisma migrate reset`.
5. Start the API and worker. Check `/health`, that the worker claims tasks, and that the dashboard
   shows the expected sources and jobs.
6. Keep the old database until the recovered one has been validated.

The data-loss window is the time since the last good backup. This is archive-level recovery only:
there is no WAL archiving or point-in-time recovery.

## Destructive migrations (ENG-020)

Before a migration that drops or rewrites data:

1. `npm run backup` (with `BACKUP_COPY_DIR` set, so the pre-migration archive also leaves this host)
2. `npm run backup:drill -- <that archive>` with the API and worker stopped. This drills the archive
   you would actually restore, and since 2026-10-30 it also compares the migration ledger and answers
   the scheduler's query, so "counts match" is no longer the whole claim.
3. Apply the migration with `npx prisma migrate deploy`.

Migrations are forward-only. If a migration fails midway, Prisma records it in
`_prisma_migrations`; restore the verified backup rather than editing that table by hand.

## Why files, not a `BackupRun` table

SRS §5.1 lists `BackupRun` as an entity, but §5.2 defines no attributes for it, and this is a
single-operator MVP with no backup scheduler inside the application. The drift report's recommended
correction (D19) is a script plus a recorded restore drill, not a table that records backups the
application does not run. The drill log above is the record. If backup orchestration moves into the
application, add `BackupRun` together with the scheduler and retention job — not before.

## Limitations

- Same-server drill: it proves the archive restores on this PostgreSQL cluster. It does not prove an
  off-machine copy is readable; drill the copy from wherever it lives (`npm run backup:drill --
  <path to the copy>`).
- No encryption. The scripts copy and verify; they do not cipher. An off-machine copy of unencrypted
  candidate and notification data is a data exposure, so encryption at the destination is a
  prerequisite for using `BACKUP_COPY_DIR` in anger, not an extra.
- No self-running schedule or retention. `npm run backup:schedule` registers the OS task only with
  `--apply`, and `npm run backup:prune` deletes only with `--apply`; neither has been run on this
  host, and nothing watches `backups/backup.log` for failures.
- The drill compares ledger names and checksums, not the DDL itself: it proves the same migrations
  applied in the same state, and that one application query answers. Index and constraint drift that
  no migration introduced would still pass.
- The role in `DATABASE_URL` needs `CREATEDB` for the drill; if deployment uses a least-privilege
  app role, run the drill with a maintenance role instead (the scripts currently read only
  `DATABASE_URL`).
- Backups capture the database only. `.env` secrets, source fixtures, and repository files need
  their own recovery plan.
- If the drill process is killed between `CREATE DATABASE` and cleanup, a
  `jobhunter_restore_drill_<timestamp>_<hex>` database can remain. The prefix identifies it; drop
  it manually before the next drill.
