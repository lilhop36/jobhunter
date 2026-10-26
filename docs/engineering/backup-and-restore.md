# Backup and restore

FR-021 requires scheduled database backups; AC-019 requires that a backup can be restored;
ENG-020 requires a verified backup before a destructive migration. This page records what the
repository provides, how to schedule it, how to prove a backup restores, and what remains an
operator responsibility.

Status: the backup and restore-drill scripts exist and the drill passed on 2026-10-25 against the
local `jobhunter` database (17 tables, 484 rows). Scheduling and off-machine storage are deployment
steps and are **not yet installed**. There is no `BackupRun` table; see [Why files, not a
`BackupRun` table](#why-files-not-a-backuprun-table).

## What exists

| Piece | Purpose |
| --- | --- |
| `scripts/backup.mjs` | `pg_dump` in custom format, compression 9, `--no-owner --no-privileges`; validates the archive with `pg_restore --list`; deletes a failed/empty file |
| `scripts/restore-drill.mjs` | restores an archive into a uniquely named disposable database, compares table sets and exact row counts, and drops it in a `finally` block |
| `scripts/lib/pg.mjs` | parses the Prisma URL into libpq arguments; locates PostgreSQL's binaries; runs `psql` queries |
| `npm run backup` | write `backups/jobhunter-<UTC timestamp>.dump` |
| `npm run backup:drill` | take a fresh backup and verify it restores |
| `npm run backup:drill -- <archive>` | verify an existing archive restores |

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

## Take a backup

```bash
npm run backup
# [backup] wrote backups\jobhunter-20261025T065807Z.dump (0.28 MB, database jobhunter)
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

## Verify a backup (restore drill)

A backup is not evidence until it has been restored. The drill restores into a disposable database
on the same server.

```bash
# Take a fresh backup, then restore it and compare against the live database.
# Stop the API and worker first: exact row counts require a quiescent source.
npm run backup:drill

# Restore an existing archive. This is a point-in-time snapshot, so table-count
# differences from today's database are reported as notes, not failures.
npm run backup:drill -- backups/jobhunter-20261025T065807Z.dump
```

What it does:

1. Validates the archive with `pg_restore --list` **before** creating anything.
2. Creates `jobhunter_restore_drill_<UTC timestamp>_<6 hex>` on the same server (role needs
   `CREATEDB`). A strict name guard makes it impossible to drop anything else.
3. Restores with `--exit-on-error --no-owner --no-privileges`.
4. Compares the public table set and exact per-table row counts with the source.
5. Drops the disposable database in a `finally` block. If cleanup fails, the drill exits 1 and
   names the database so it can be dropped manually.

A **fresh-backup** run is strict: every source table must be present with the same row count. If
the API or worker was writing during the drill, counts can legitimately differ; stop them and
re-run. An **existing archive** must restore without error and contain tables; differences from the
live database are reported, because the archive is from an earlier point in time.

### Recorded drills

| Date (UTC) | Archive | Mode | Result |
| --- | --- | --- | --- |
| 2026-10-25 | `backups/jobhunter-20261025T065843Z.dump` | fresh | **PASS** — 17/17 tables, 484/484 rows; drill database `jobhunter_restore_drill_20261025T065844Z_37d1b3` dropped |
| 2026-10-25 | `backups/jobhunter-20261025T065807Z.dump` | existing | **PASS** — 17 tables, 484 rows restored; no differences observed; drill database dropped |
| 2026-10-25 | `backups/jobhunter-20261025T072155Z.dump` | fresh | **PASS** — re-ran against the final scripts: 17/17 tables, 484/484 rows; drill database dropped |
| 2026-10-25 | missing archive | existing | Correctly exits 1 before creating a database |
| 2026-10-25 | non-archive text file | existing | Correctly exits 1 at validation, before creating a database |

After the drills, `pg_database` contained no `jobhunter_restore_drill_%` rows. The drill archives
listed above are local, git-ignored artifacts, not the production backup set.

**Run a drill after every change to the schema or the scripts, and periodically thereafter** (for
example monthly) against the latest off-machine copy. Append the result to the table above.

## Schedule it

The repository does not install a schedule; on a single-operator deployment this is one operating
system task. A failed backup should be visible, so keep the log and check it.

### Windows Task Scheduler

Run from an elevated shell, adjusting the repository path and run time:

```powershell
schtasks /Create /SC DAILY /ST 02:00 /TN "JobHunter backup" /TR "cmd /c cd /d C:\Users\abdigr\Desktop\jobhunting && npm run backup >> backups\backup.log 2>&1"
schtasks /Query /TN "JobHunter backup"
```

The task runs as the account that created it. `BACKUP_DIR` and `PG_BIN` must be set for that
account (either in `.env`, which the npm script loads, or as user environment variables). Test the
task once with `schtasks /Run /TN "JobHunter backup"` and confirm a fresh `.dump` file appears.

### cron (Linux or macOS)

```cron
0 2 * * * cd /srv/jobhunter && /usr/bin/npm run backup >> backups/backup.log 2>&1
```

cron does not load a login shell's environment; make sure `PATH` includes Node and the PostgreSQL
client tools, or set `PG_BIN` in `.env`.

### Retention and off-machine storage

- Keep a rolling set (for example 14 daily and 8 weekly). Nothing prunes automatically: deleting
  backups is destructive and remains an operator decision.
- Copy each successful archive to a different machine or storage service. The SRS risk table names
  "off-machine backup plus restore test" as the mitigation for backup failure.
- Encrypt the archive before it leaves the host (BitLocker volume, `age`, or GPG) and restrict
  access: it contains candidate and notification data.
- Verify an off-machine copy periodically with `pg_restore --list`, and at least occasionally run a
  full drill against it on a machine that has PostgreSQL client tools.

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
   `npx prisma migrate status`. Do not run `prisma migrate reset`.
5. Start the API and worker. Check `/health`, that the worker claims tasks, and that the dashboard
   shows the expected sources and jobs.
6. Keep the old database until the recovered one has been validated.

The data-loss window is the time since the last good backup. This is archive-level recovery only:
there is no WAL archiving or point-in-time recovery.

## Destructive migrations (ENG-020)

Before a migration that drops or rewrites data:

1. `npm run backup`
2. `npm run backup:drill -- <that archive>` (with the API and worker stopped)
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

- Same-server drill: it proves the archive restores on this PostgreSQL cluster. It does not prove
  an off-machine copy is readable; verify that separately.
- No automatic scheduling, retention, encryption, or off-siting.
- The role in `DATABASE_URL` needs `CREATEDB` for the drill; if deployment uses a least-privilege
  app role, run the drill with a maintenance role instead (the scripts currently read only
  `DATABASE_URL`).
- Backups capture the database only. `.env` secrets, source fixtures, and repository files need
  their own recovery plan.
- If the drill process is killed between `CREATE DATABASE` and cleanup, a
  `jobhunter_restore_drill_<timestamp>_<hex>` database can remain. The prefix identifies it; drop
  it manually before the next drill.
