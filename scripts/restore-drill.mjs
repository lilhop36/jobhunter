#!/usr/bin/env node
/**
 * Restore drill (AC-019): prove a backup actually restores.
 *
 *   npm run backup:drill                 # take a fresh backup, then restore it
 *   npm run backup:drill -- backups/x.dump   # restore an existing archive
 *
 * The archive is restored into a uniquely named disposable database on the same server,
 * compared with the source, and dropped again in a `finally` block. A fresh-backup run is
 * strict: the table set and every row count must match the source, which requires the API
 * and worker to be idle. An existing archive is a point-in-time snapshot, so differences
 * from the current database are reported rather than treated as corruption.
 *
 * The configured role needs CREATEDB for the drill (it only reads the source database).
 * See docs/engineering/backup-and-restore.md.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBackup } from './backup.mjs';
import {
  connectionArgs,
  countRows,
  listPublicTables,
  parseDatabaseUrl,
  resolvePgBinary,
  runPg,
} from './lib/pg.mjs';

const DRILL_PREFIX = 'jobhunter_restore_drill_';
const DRILL_NAME_PATTERN = /^jobhunter_restore_drill_\d{8}T\d{6}Z_[0-9a-f]{6}$/;
const MAX_IDENTIFIER_BYTES = 63;

export function drillDatabaseName(now = new Date()) {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
  return `${DRILL_PREFIX}${stamp}_${randomBytes(3).toString('hex')}`;
}

/** Last line of defence before DROP DATABASE: only names this module generates are disposable. */
export function assertDisposableDrillName(name, sourceDatabase = '') {
  if (name.length > MAX_IDENTIFIER_BYTES || !DRILL_NAME_PATTERN.test(name)) {
    throw new Error(`Refusing to treat "${name}" as a restore-drill database: it is not a generated disposable name.`);
  }
  if (name === sourceDatabase) {
    throw new Error(`Refusing to treat "${name}" as disposable: it is the source database.`);
  }
}

function createDrillDatabase(database, name) {
  runPg(
    resolvePgBinary('createdb'),
    [...connectionArgs(database), '--maintenance-db', 'postgres', name],
    { database },
  );
}

function dropDrillDatabase(database, name) {
  assertDisposableDrillName(name, database.database);
  runPg(
    resolvePgBinary('dropdb'),
    [...connectionArgs(database), '--maintenance-db', 'postgres', '--force', name],
    { database },
  );
}

function restoreArchive(database, name, archive) {
  runPg(
    resolvePgBinary('pg_restore'),
    ['--exit-on-error', '--no-owner', '--no-privileges', '--dbname', name, ...connectionArgs(database), archive],
    { database },
  );
}

function compareCounts(sourceCounts, restoredCounts, tables) {
  const differences = [];
  for (const table of tables) {
    const source = sourceCounts.get(table);
    const restored = restoredCounts.get(table);
    if (source !== restored) differences.push({ table, source, restored });
  }
  return differences;
}

function describeDifferences(differences, limit = 10) {
  const shown = differences.slice(0, limit).map((d) => `  ${d.table}: source ${d.source}, restored ${d.restored}`);
  if (differences.length > limit) shown.push(`  ... and ${differences.length - limit} more`);
  return shown.join('\n');
}

export function runRestoreDrill({ database = parseDatabaseUrl(), archivePath, fresh = false, logger = console } = {}) {
  if (!archivePath) throw new Error('A backup archive path is required.');
  const archive = resolve(archivePath);
  if (!existsSync(archive)) throw new Error(`Backup archive not found: ${archive}`);
  if (statSync(archive).size === 0) throw new Error(`Backup archive is empty: ${archive}`);

  // Validate the archive before creating a database. A corrupt file must fail here, not
  // after a restore has already written partial objects.
  runPg(resolvePgBinary('pg_restore'), ['--list', archive]);

  const sourceTables = listPublicTables(database);
  if (sourceTables.length === 0) {
    throw new Error(`No public tables found in "${database.database}"; there is nothing to compare against.`);
  }

  const name = drillDatabaseName();
  assertDisposableDrillName(name, database.database);

  let created = false;
  let failure = null;
  let restoredTables = [];
  let sourceCounts = new Map();
  let restoredCounts = new Map();

  try {
    logger.log(`[drill] creating ${name}`);
    createDrillDatabase(database, name);
    created = true;

    restoreArchive(database, name, archive);
    logger.log('[drill] pg_restore completed without error');

    restoredTables = listPublicTables(database, name);
    if (restoredTables.length === 0) {
      throw new Error('The restore produced no public tables.');
    }

    const restoredSet = new Set(restoredTables);
    const sourceSet = new Set(sourceTables);
    const missing = sourceTables.filter((table) => !restoredSet.has(table));
    const extra = restoredTables.filter((table) => !sourceSet.has(table));

    if (fresh && (missing.length > 0 || extra.length > 0)) {
      throw new Error(
        [
          'The restored table set does not match the source database.',
          missing.length > 0 ? `  missing: ${missing.join(', ')}` : '',
          extra.length > 0 ? `  unexpected: ${extra.join(', ')}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }
    if (!fresh && (missing.length > 0 || extra.length > 0)) {
      logger.warn(
        `[drill] note: the archive's table set differs from the current database` +
          `${missing.length > 0 ? ` (missing: ${missing.join(', ')})` : ''}` +
          `${extra.length > 0 ? ` (unexpected: ${extra.join(', ')})` : ''}`,
      );
    }

    sourceCounts = countRows(database, sourceTables);
    restoredCounts = countRows(
      database,
      sourceTables.filter((table) => restoredSet.has(table)),
      name,
    );

    const differences = compareCounts(sourceCounts, restoredCounts, sourceTables);
    if (fresh && differences.length > 0) {
      throw new Error(
        [
          'Restored row counts differ from the source database.',
          describeDifferences(differences),
          'If the API or worker was writing during the drill, re-run it while they are stopped.',
        ].join('\n'),
      );
    }
    if (!fresh && differences.length > 0) {
      logger.warn(
        `[drill] note: the archive is a point-in-time snapshot; ${differences.length} table(s) differ from today's database`,
      );
    }
  } catch (error) {
    failure = error;
  } finally {
    if (created) {
      try {
        dropDrillDatabase(database, name);
        logger.log(`[drill] dropped ${name}`);
      } catch (error) {
        const cleanup = new Error(
          `Restore drill database "${name}" could not be dropped: ${error.message}\n` +
            `Drop it manually before the next drill.`,
        );
        failure = failure ? new Error(`${failure.message}\n${cleanup.message}`) : cleanup;
      }
    }
  }

  if (failure) throw failure;

  return {
    archive,
    drillDatabase: name,
    dropped: created,
    sourceTables: sourceTables.length,
    restoredTables: restoredTables.length,
    sourceRows: [...sourceCounts.values()].reduce((total, count) => total + count, 0),
    restoredRows: [...restoredCounts.values()].reduce((total, count) => total + count, 0),
    countDifferences: compareCounts(sourceCounts, restoredCounts, sourceTables),
  };
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  try {
    if (process.argv.length > 3) {
      throw new Error('usage: npm run backup:drill [-- <archive.dump>]');
    }
    const database = parseDatabaseUrl();
    const requestedArchive = process.argv[2];
    let archivePath;
    let fresh = false;

    if (requestedArchive) {
      archivePath = requestedArchive;
    } else {
      const backup = createBackup({ database });
      console.log(`[drill] fresh backup: ${relative(process.cwd(), backup.file)}`);
      archivePath = backup.file;
      fresh = true;
    }

    const result = runRestoreDrill({ database, archivePath, fresh });
    console.log(
      `[drill] verified ${relative(process.cwd(), result.archive)}: ` +
        `${result.restoredTables} table(s), ${result.restoredRows} row(s) restored`,
    );
    console.log(
      fresh
        ? `[drill] table set and row counts matched the source (${result.sourceRows} rows)`
        : '[drill] archive is a point-in-time snapshot; row counts were not required to match today',
    );
    console.log('[drill] the disposable restore database was dropped');
  } catch (error) {
    console.error(`[drill] failed: ${error.message}`);
    process.exitCode = 1;
  }
}
