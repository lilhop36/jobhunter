#!/usr/bin/env node
/**
 * Retention for operator backups (FR-021): decide which archives to keep, and delete only
 * when asked.
 *
 *   npm run backup:prune                          # show what would be deleted; change nothing
 *   npm run backup:prune -- --apply               # delete the expired archives
 *   npm run backup:prune -- --keep-daily 21 --keep-weekly 12
 *   npm run backup:prune -- --dir "D:/jobhunter-backups" --apply
 *
 * Policy: for each of the last N UTC days keep the newest archive of that day, for each of the
 * last M Monday-based weeks keep the newest archive of that week, and always keep the newest
 * archive overall. Only names this project writes (`jobhunter-<UTC stamp>[-n].dump`) are
 * considered; any other file in the directory is left alone. Deletion is never implied.
 *
 * Run it against each directory that holds archives: BACKUP_DIR and, separately, BACKUP_COPY_DIR.
 */
import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_KEEP_DAILY = 14;
export const DEFAULT_KEEP_WEEKLY = 8;
const DAY_MS = 86_400_000;
const BACKUP_NAME = /^jobhunter-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z(-\d+)?\.dump$/;

/** The UTC instant encoded in an archive name, or `null` for any other file. */
export function backupTimestamp(name) {
  const match = BACKUP_NAME.exec(name);
  if (match === null) return null;

  const [, year, month, day, hour, minute, second] = match.map(Number);
  const at = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

  // Date.UTC rolls impossible values forward (31 February becomes 3 March); only an exact
  // round trip proves the name describes a real instant.
  if (
    at.getUTCFullYear() !== year ||
    at.getUTCMonth() !== month - 1 ||
    at.getUTCDate() !== day ||
    at.getUTCHours() !== hour ||
    at.getUTCMinutes() !== minute ||
    at.getUTCSeconds() !== second
  ) {
    return null;
  }
  return at;
}

function utcDay(at) {
  return Math.floor(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()) / DAY_MS);
}

/** A Monday-based week index; 1970-01-01 was a Thursday, so days 0-3 share week 0. */
function utcWeek(day) {
  return Math.floor((day + 3) / 7);
}

/**
 * Entries outside the retention windows. Pure: the caller decides whether to delete.
 * `entries` is `{ name, at: Date }`; the result preserves the input order.
 */
export function selectExpired(
  entries,
  { now = new Date(), keepDaily = DEFAULT_KEEP_DAILY, keepWeekly = DEFAULT_KEEP_WEEKLY } = {},
) {
  if (!Number.isInteger(keepDaily) || keepDaily < 1) {
    throw new RangeError('keepDaily must be a positive integer.');
  }
  if (!Number.isInteger(keepWeekly) || keepWeekly < 1) {
    throw new RangeError('keepWeekly must be a positive integer.');
  }

  const sorted = [...entries].sort((a, b) => b.at - a.at || b.name.localeCompare(a.name));
  const keep = new Set();
  const today = utcDay(now);
  const thisWeek = utcWeek(today);

  // Newest per day. `seenDays` is checked before the window so a day keeps only one archive.
  const seenDays = new Set();
  for (const entry of sorted) {
    const day = utcDay(entry.at);
    if (today - day >= keepDaily || seenDays.has(day)) continue;
    seenDays.add(day);
    keep.add(entry.name);
  }

  // Newest per week, covering the long tail the daily window drops.
  const seenWeeks = new Set();
  for (const entry of sorted) {
    const week = utcWeek(utcDay(entry.at));
    if (thisWeek - week >= keepWeekly || seenWeeks.has(week)) continue;
    seenWeeks.add(week);
    keep.add(entry.name);
  }

  // Clock skew or a gap in backups must never leave the directory without an archive.
  if (sorted.length > 0) keep.add(sorted[0].name);

  return entries.filter((entry) => !keep.has(entry.name));
}

/** Archives in a directory, newest first. Unrelated files are ignored, not listed as expired. */
export function listArchives(dir) {
  if (!existsSync(dir)) throw new Error(`Backup directory not found: ${dir}`);
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const at = backupTimestamp(entry.name);
      if (at === null) return null;
      const { size } = statSync(resolve(dir, entry.name));
      return { name: entry.name, at, size };
    })
    .filter((entry) => entry !== null)
    .sort((a, b) => b.at - a.at || b.name.localeCompare(a.name));
}

function formatMegabytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

const USAGE =
  'usage: npm run backup:prune [-- --dir <path>] [--keep-daily <n>] [--keep-weekly <n>] [--apply]';

function parseArguments(argv) {
  const options = {
    dir: resolve(process.env.BACKUP_DIR || 'backups'),
    keepDaily: DEFAULT_KEEP_DAILY,
    keepWeekly: DEFAULT_KEEP_WEEKLY,
    apply: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') {
      options.apply = true;
    } else if (argument === '--dir' || argument === '--keep-daily' || argument === '--keep-weekly') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${argument} needs a value.\n${USAGE}`);
      index += 1;
      if (argument === '--dir') options.dir = resolve(value);
      else options[argument === '--keep-daily' ? 'keepDaily' : 'keepWeekly'] = Number(value);
    } else {
      throw new Error(`Unknown argument "${argument}".\n${USAGE}`);
    }
  }

  for (const key of ['keepDaily', 'keepWeekly']) {
    if (!Number.isInteger(options[key]) || options[key] < 1) {
      throw new Error(`${key} must be a positive integer.\n${USAGE}`);
    }
  }
  return options;
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const archives = listArchives(options.dir);
    const expired = selectExpired(archives, options);

    const kept = archives.length - expired.length;
    console.log(
      `[prune] ${relative(process.cwd(), options.dir) || '.'}: ${archives.length} archive(s), ` +
        `keeping ${kept} (${options.keepDaily} daily / ${options.keepWeekly} weekly)`,
    );

    if (expired.length === 0) {
      console.log('[prune] nothing to delete');
    } else {
      for (const entry of expired) {
        console.log(
          `[prune] ${options.apply ? 'deleted' : 'would delete'} ${entry.name} ` +
            `(${formatMegabytes(entry.size)}, ${entry.at.toISOString()})`,
        );
        if (options.apply) unlinkSync(resolve(options.dir, entry.name));
      }
      console.log(
        options.apply
          ? `[prune] deleted ${expired.length} archive(s)`
          : `[prune] dry run: re-run with --apply to delete ${expired.length} archive(s)`,
      );
    }
  } catch (error) {
    console.error(`[prune] failed: ${error.message}`);
    process.exitCode = 1;
  }
}
