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
 *
 * Set BACKUP_COPY_DIR to also place a verified copy on another disk or machine. The copy is
 * compared byte for byte and re-read with `pg_restore --list` before the run reports success.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, chmodSync, createReadStream, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, parse as parsePath, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { connectionArgs, parseDatabaseUrl, resolvePgBinary, runPg } from './lib/pg.mjs';

const DEFAULT_BACKUP_DIR = 'backups';
const BACKUP_NAME_PATTERN = /\.dump$/;
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

/** SHA-256 of a file, streamed so a large archive need not fit in memory. */
export function sha256File(file) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolveHash(hash.digest('hex')));
  });
}

/** Same filesystem root: the closest portable approximation of "same disk". */
export function isSameVolume(a, b) {
  return parsePath(resolve(a)).root.toLowerCase() === parsePath(resolve(b)).root.toLowerCase();
}

function normalizeForComparison(path) {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

export function isInside(parent, child) {
  const relativePath = normalizeForComparison(relative(resolve(parent), resolve(child)));
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

/**
 * Refuse copy destinations that defeat the purpose: the archive's own directory, or a path inside
 * the repository. The copy exists to survive a disk or host failure, so a sibling folder in the
 * working tree is not a second copy worth reporting as verified.
 */
export function assertCopyDestination(copyDir, { outDir, repoRoot = REPOSITORY_ROOT } = {}) {
  const dir = resolve(copyDir);
  if (dir === resolve(outDir)) {
    throw new Error('BACKUP_COPY_DIR must differ from BACKUP_DIR; the copy must not overwrite the archive.');
  }
  if (isInside(repoRoot, dir)) {
    throw new Error(
      `BACKUP_COPY_DIR must be outside the repository (got ${dir}); a copy inside the working tree ` +
        'does not survive losing the machine.',
    );
  }
  return dir;
}

/**
 * Copy the archive and prove the copy is usable: byte-identical to the source and readable by
 * pg_restore. A failed copy is deleted so a partial file cannot be mistaken for a second copy.
 */
async function copyVerified(file, { copyDir, outDir, repoRoot, database }) {
  const dir = assertCopyDestination(copyDir, { outDir, repoRoot });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const destination = uniqueBackupPath(dir, basename(file));

  try {
    copyFileSync(file, destination);
    if (process.platform !== 'win32') chmodSync(destination, 0o600);

    const [sourceHash, copyHash] = await Promise.all([sha256File(file), sha256File(destination)]);
    if (sourceHash !== copyHash) {
      throw new Error('the copy is not byte-identical to the archive');
    }
    const { size } = statSync(destination);
    if (size === 0) throw new Error('the copy is empty.');
    runPg(resolvePgBinary('pg_restore'), ['--list', destination], { database });

    return { file: destination, size, sha256: copyHash, sameVolume: isSameVolume(file, destination) };
  } catch (error) {
    try {
      if (existsSync(destination)) unlinkSync(destination);
    } catch {
      // The original error names the failure; a leftover copy is deleted by the operator.
    }
    throw new Error(`Off-machine copy to "${dir}" failed: ${error.message}`);
  }
}

/**
 * Dump the database and prove the archive is readable before reporting success.
 * A failed or empty dump is deleted so a partial file can never be mistaken for a backup.
 * With `copyDir` set, a verified second copy is written before the run returns.
 */
export async function createBackup({
  database = parseDatabaseUrl(),
  outDir = process.env.BACKUP_DIR || DEFAULT_BACKUP_DIR,
  copyDir = process.env.BACKUP_COPY_DIR,
  repoRoot = REPOSITORY_ROOT,
} = {}) {
  const dir = resolve(outDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = uniqueBackupPath(dir, backupFileName());
  let size = 0;

  // Fail on a misconfigured destination before spending time on the dump.
  if (copyDir) assertCopyDestination(copyDir, { outDir: dir, repoRoot });

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

    size = statSync(file).size;
    if (size === 0) throw new Error('pg_dump produced an empty archive.');

    // A truncated or corrupt archive still leaves a plausible file behind; listing its
    // table of contents is a cheap restore-readiness check.
    runPg(resolvePgBinary('pg_restore'), ['--list', file]);
  } catch (error) {
    try {
      if (existsSync(file)) unlinkSync(file);
    } catch {
      // A leftover partial file is reported through the original error; do not mask it.
    }
    throw error;
  }

  // The archive is valid at this point. A copy that fails verification fails the run, but the
  // verified local archive is kept: it is still the best available backup.
  const copy = copyDir ? await copyVerified(file, { copyDir, outDir: dir, repoRoot, database }) : null;

  return { file, size, database: database.database, copy };
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  try {
    const result = await createBackup();
    const megabytes = (result.size / (1024 * 1024)).toFixed(2);
    console.log(`[backup] wrote ${relative(process.cwd(), result.file)} (${megabytes} MB, database ${result.database})`);

    if (result.copy) {
      console.log(
        `[backup] verified copy at ${relative(process.cwd(), result.copy.file)} ` +
          `(sha256 ${result.copy.sha256.slice(0, 12)}..., pg_restore --list passed)`,
      );
      if (result.copy.sameVolume) {
        console.warn(
          '[backup] warning: the copy is on the same volume as the archive; one disk failure loses both. ' +
            'Point BACKUP_COPY_DIR at another disk, machine or storage service.',
        );
      }
    } else {
      console.log(
        '[backup] no BACKUP_COPY_DIR set: this archive exists on one machine only. ' +
          'A second copy is what survives losing this host.',
      );
    }

    console.log('[backup] The archive contains candidate and notification data; store it encrypted.');
    console.log(`[backup] Verify it with: npm run backup:drill -- "${relative(process.cwd(), result.file)}"`);
  } catch (error) {
    console.error(`[backup] failed: ${error.message}`);
    process.exitCode = 1;
  }
}
