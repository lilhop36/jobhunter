import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseDatabaseUrl, quoteIdentifier } from '../../scripts/lib/pg.mjs';
import { assertCopyDestination, backupFileName, isSameVolume, sha256File } from '../../scripts/backup.mjs';
import { assertDisposableDrillName, compareMigrationLedgers, drillDatabaseName, readRepositoryMigrations } from '../../scripts/restore-drill.mjs';
import { backupTimestamp, selectExpired } from '../../scripts/prune-backups.mjs';
import { buildCronLine, buildWindowsTaskCommand, displayCommand } from '../../scripts/install-backup-schedule.mjs';

describe('backup tooling URL parsing', () => {
  it('parses a Prisma URL and ignores Prisma-only query parameters', () => {
    expect(
      parseDatabaseUrl('postgresql://postgres:secret@localhost:5433/jobhunter?schema=public&connection_limit=5'),
    ).toEqual({
      host: 'localhost',
      port: '5433',
      user: 'postgres',
      password: 'secret',
      database: 'jobhunter',
      sslmode: undefined,
    });
  });

  it('decodes credentials and strips IPv6 brackets for libpq', () => {
    const parsed = parseDatabaseUrl('postgresql://us%40er:p%40ss@[::1]:5433/jobhunter');
    expect(parsed.host).toBe('::1');
    expect(parsed.user).toBe('us@er');
    expect(parsed.password).toBe('p@ss');
  });

  it('defaults the port to 5432 and passes sslmode through', () => {
    const parsed = parseDatabaseUrl('postgresql://u:p@db.internal/jobhunter?sslmode=require');
    expect(parsed.port).toBe('5432');
    expect(parsed.sslmode).toBe('require');
  });

  it('rejects a missing URL, wrong protocol, missing database, and missing user', () => {
    expect(() => parseDatabaseUrl('')).toThrow(/DATABASE_URL is not set/);
    expect(() => parseDatabaseUrl('mysql://u:p@localhost/jobhunter')).toThrow(/must use postgresql/);
    expect(() => parseDatabaseUrl('postgresql://u:p@localhost/')).toThrow(/does not name a database/);
    expect(() => parseDatabaseUrl('postgresql://localhost/jobhunter')).toThrow(/does not name a user/);
  });

  it('reports malformed percent-encoding instead of throwing a URIError', () => {
    expect(() => parseDatabaseUrl('postgresql://u:%ZZ@localhost/jobhunter')).toThrow(
      /invalid percent-encoding in its password/,
    );
  });

  it('refuses a non-public schema rather than backing up the wrong tables', () => {
    expect(() => parseDatabaseUrl('postgresql://u:p@localhost/jobhunter?schema=tenant')).toThrow(
      /only the public schema/,
    );
  });
});

describe('backup archive naming', () => {
  it('stamps the file in UTC without punctuation', () => {
    expect(backupFileName(new Date('2026-10-25T12:34:56.789Z'))).toBe('jobhunter-20261025T123456Z.dump');
  });
});

describe('restore-drill database names', () => {
  const now = new Date('2026-10-25T12:34:56.789Z');

  it('generates a disposable, identifiable name', () => {
    const name = drillDatabaseName(now);
    expect(name).toMatch(/^jobhunter_restore_drill_20261025T123456Z_[0-9a-f]{6}$/);
    expect(name.length).toBeLessThanOrEqual(63);
  });

  it('generates a different suffix for each run', () => {
    expect(drillDatabaseName(now)).not.toBe(drillDatabaseName(now));
  });

  it('accepts a generated name when it is not the source database', () => {
    expect(() => assertDisposableDrillName(drillDatabaseName(now), 'jobhunter')).not.toThrow();
  });

  it('refuses the source database and any hand-written name', () => {
    const generated = drillDatabaseName(now);
    expect(() => assertDisposableDrillName(generated, generated)).toThrow(/source database/);
    expect(() => assertDisposableDrillName('jobhunter', 'jobhunter')).toThrow(/not a generated/);
    expect(() => assertDisposableDrillName('jobhunter_restore_drill_evil', 'jobhunter')).toThrow(
      /not a generated/,
    );
    expect(() =>
      assertDisposableDrillName('jobhunter_restore_drill_20261025T123456Z_ABCDEF', 'jobhunter'),
    ).toThrow(/not a generated/);
  });
});

describe('SQL identifier quoting', () => {
  it('quotes and escapes table names', () => {
    expect(quoteIdentifier('Job')).toBe('"Job"');
    expect(quoteIdentifier('we"ird')).toBe('"we""ird"');
  });
});

describe('off-machine copy', () => {
  const temp = mkdtempSync(join(tmpdir(), 'jobhunter-copy-'));
  afterAll(() => rmSync(temp, { recursive: true, force: true }));

  it('accepts a destination outside the repository and refuses the ineffective ones', () => {
    const outDir = join(temp, 'backups');
    const repoRoot = join(temp, 'repo');
    expect(() => assertCopyDestination(join(temp, 'off-machine'), { outDir, repoRoot })).not.toThrow();
    expect(() => assertCopyDestination(repoRoot, { outDir, repoRoot })).toThrow(/outside the repository/);
    expect(() => assertCopyDestination(join(repoRoot, 'backups'), { outDir, repoRoot })).toThrow(
      /outside the repository/,
    );
    expect(() => assertCopyDestination(outDir, { outDir, repoRoot })).toThrow(/must differ/);
  });

  it('hashes a file so a copy can be compared byte for byte', async () => {
    const file = join(temp, 'sample.bin');
    writeFileSync(file, 'hello');
    await expect(sha256File(file)).resolves.toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });

  it('reports paths on the same volume', () => {
    expect(isSameVolume(join(temp, 'a'), join(temp, 'b'))).toBe(true);
  });

  it.skipIf(process.platform !== 'win32')('reports paths on different Windows volumes', () => {
    expect(isSameVolume('C:/backups', 'D:/backups')).toBe(false);
  });
});

describe('backup retention', () => {
  const now = new Date('2026-10-30T12:00:00Z');
  const dayAgo = (days) => new Date(Date.UTC(2026, 9, 30, 2) - days * 86_400_000);

  it('parses only the archive names this project writes', () => {
    expect(backupTimestamp('jobhunter-20261025T065807Z.dump')).toEqual(new Date('2026-10-25T06:58:07Z'));
    expect(backupTimestamp('jobhunter-20261025T065807Z-2.dump')).toEqual(new Date('2026-10-25T06:58:07Z'));
    expect(backupTimestamp('notes.txt')).toBeNull();
    expect(backupTimestamp('jobhunter-latest.dump')).toBeNull();
    expect(backupTimestamp('jobhunter-20260231T000000Z.dump')).toBeNull();
  });

  it('keeps one archive per day inside the daily window', () => {
    const entries = Array.from({ length: 20 }, (_, index) => ({
      name: `jobhunter-day${index}.dump`,
      at: dayAgo(index),
    }));
    const expired = selectExpired(entries, { now, keepDaily: 14, keepWeekly: 1 });
    expect(expired.map((entry) => entry.name).sort()).toEqual(
      entries.slice(14).map((entry) => entry.name).sort(),
    );
  });

  it('keeps only the newest archive of a day', () => {
    const entries = [
      { name: 'newer.dump', at: dayAgo(0) },
      { name: 'older.dump', at: new Date(dayAgo(0).getTime() - 3_600_000) },
    ];
    expect(selectExpired(entries, { now, keepDaily: 14, keepWeekly: 8 }).map((entry) => entry.name)).toEqual([
      'older.dump',
    ]);
  });

  it('keeps the weekly long tail and drops what both windows covered', () => {
    const entries = [
      { name: 'today.dump', at: dayAgo(0) },
      { name: 'week1.dump', at: dayAgo(8) },
      { name: 'week2.dump', at: dayAgo(15) },
      { name: 'ancient.dump', at: dayAgo(45) },
    ];
    const expired = selectExpired(entries, { now, keepDaily: 2, keepWeekly: 3 });
    expect(expired.map((entry) => entry.name)).toEqual(['ancient.dump']);
  });

  it('never expires the only archive, however old', () => {
    const entries = [{ name: 'only.dump', at: dayAgo(400) }];
    expect(selectExpired(entries, { now })).toEqual([]);
  });

  it('rejects retention windows that make no sense', () => {
    expect(() => selectExpired([], { keepDaily: 0 })).toThrow(RangeError);
    expect(() => selectExpired([], { keepWeekly: 1.5 })).toThrow(RangeError);
  });
});

describe('migration ledger comparison', () => {
  it('reads this checkout’s migrations in order', () => {
    const migrations = readRepositoryMigrations(process.cwd());
    expect(migrations.length).toBeGreaterThanOrEqual(15);
    expect(migrations.every((name) => /^\d{14}_/.test(name))).toBe(true);
    expect([...migrations].sort()).toEqual(migrations);
    expect(migrations.at(-1)).toBe('20261024150000_source_run_listing_coverage_floor_timestamptz');
  });

  it('reports a missing, altered or unexpected migration', () => {
    const source = [
      { name: 'a', checksum: '1' },
      { name: 'b', checksum: '2' },
    ];
    const restored = [
      { name: 'b', checksum: 'changed' },
      { name: 'c', checksum: '3' },
    ];
    expect(compareMigrationLedgers(source, restored)).toEqual({
      missing: ['a'],
      altered: ['b'],
      unexpected: ['c'],
    });
    expect(compareMigrationLedgers(source, source)).toEqual({ missing: [], altered: [], unexpected: [] });
  });
});

describe('backup schedule command', () => {
  it('builds a daily schtasks invocation that appends to a log', () => {
    const task = buildWindowsTaskCommand({ repoRoot: 'C:/repo', time: '03:30' });
    expect(task.binary).toBe('schtasks');
    expect(task.args).toContain('/Create');
    expect(task.args[task.args.indexOf('/ST') + 1]).toBe('03:30');
    expect(task.run).toContain('npm run backup >>');
    expect(task.run).toContain('2>&1');
    expect(task.run.startsWith('cmd /c cd /d ')).toBe(true);
  });

  it('rejects an invalid time and a command too long for /TR', () => {
    expect(() => buildWindowsTaskCommand({ repoRoot: 'C:/repo', time: '25:00' })).toThrow(/HH:MM/);
    expect(() => buildWindowsTaskCommand({ repoRoot: `C:/${'x'.repeat(300)}` })).toThrow(/at most 261/);
  });

  it('prints the cron equivalent at the same minute', () => {
    expect(buildCronLine({ repoRoot: '/srv/jobhunter', time: '03:05' })).toMatch(/^5 3 \* \* \* cd /);
  });

  it('escapes the /TR quotes when rendering the command for a terminal', () => {
    const displayed = displayCommand(buildWindowsTaskCommand({ repoRoot: '/srv/job hunter', time: '02:00' }));
    expect(displayed.startsWith('schtasks /Create /SC DAILY /ST 02:00')).toBe(true);
    // The /TR value contains its own quoted paths, so the wrapper quotes must be escaped.
    expect(displayed).toContain('\\"');
  });
});
