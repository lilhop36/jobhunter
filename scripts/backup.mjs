#!/usr/bin/env node
/**
 * Operator backup (FR-021): a consistent, restorable snapshot of the database.
 *
 *   npm run backup
 *   BACKUP_DIR=D:\jobhunter-backups npm run backup
 *
 * The archive is PostgreSQL's custom format, so it restores with pg_restore, supports
 * selective restores, and is usable by an operator restore drill (scripts/restore-drill.mjs).
 * `--no-owner --no-privileges` keeps it portable across roles and hosts. The archive contains
 * candidate and notification data: store it encrypted, off-machine, and outside this repo.
 *
 * pg_dump reads from a single transaction snapshot, so API and worker writes may continue
 * during a backup; they do not make the archive inconsistent. A restore drill compares
 * counts and therefore wants a quiescent database (see docs/engineering/backup-and-restore.md).
 */
import { chmodSync, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connectionArgs, parseDatabaseUrl, resolvePgBinary, runPg } from './lib/pg.mjs';

const DEFAULT_BACKUP_DIR = 'backups';
const BACKUP_NAME_PATTERN = /\.dump$/;

export function backupFileName(now = new Date()) {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
  return `jobhunter-${stamp}.dump`;
}

function uniqueBackupPath(dir, fileName) {
  const stem = fileName.replace(BACKUP_NAME_PATTERN, '');
  let candidate = resolve(dir, fileName);
  for (let suffix = 1; existsSync(candidate); suffix += 1) {
    candidate = resolve(dir, `${stem}-${suffix}.dump`);
  }
  return candidate;
}

/**
 * Dump the database and prove the archive is readable before reporting success.
 * A failed or empty dump is deleted so a partial file can never be mistaken for a backup.
 */
export function createBackup({
  database = parseDatabaseUrl(),
  outDir = process.env.BACKUP_DIR || DEFAULT_BACKUP_DIR,
} = {}) {
  const dir = resolve(outDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = uniqueBackupPath(dir, backupFileName());

  const args = [
    '--format=custom',
    '--compress=9',
    '--no-owner',
    '--no-privileges',
    // Fail rather than hang forever if a migration holds a conflicting lock.
    '--lock-wait-timeout=30s',
    '--file',
    file,
    '--dbname',
    database.database,
    ...connectionArgs(database),
  ];

  try {
    runPg(resolvePgBinary('pg_dump'), args, { database });

    // Personal data: do not inherit a permissive umask. Windows relies on the directory ACL,
    // which the operator must restrict; chmod only toggles the read-only bit there.
    if (process.platform !== 'win32') chmodSync(file, 0o600);

    const { size } = statSync(file);
    if (size === 0) throw new Error('pg_dump produced an empty archive.');

    // A truncated or corrupt archive still leaves a plausible file behind; listing its
    // table of contents is a cheap restore-readiness check.
    runPg(resolvePgBinary('pg_restore'), ['--list', file]);

    return { file, size, database: database.database };
  } catch (error) {
    try {
      if (existsSync(file)) unlinkSync(file);
    } catch {
      // A leftover partial file is reported through the original error; do not mask it.
    }
    throw error;
  }
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  try {
    const result = createBackup();
    const megabytes = (result.size / (1024 * 1024)).toFixed(2);
    console.log(`[backup] wrote ${relative(process.cwd(), result.file)} (${megabytes} MB, database ${result.database})`);
    console.log('[backup] The archive contains candidate and notification data; store it encrypted and off-machine.');
    console.log(`[backup] Verify it with: npm run backup:drill -- "${relative(process.cwd(), result.file)}"`);
  } catch (error) {
    console.error(`[backup] failed: ${error.message}`);
    process.exitCode = 1;
  }
}
