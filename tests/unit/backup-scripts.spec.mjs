import { describe, expect, it } from 'vitest';
import { parseDatabaseUrl, quoteIdentifier } from '../../scripts/lib/pg.mjs';
import { backupFileName } from '../../scripts/backup.mjs';
import { assertDisposableDrillName, drillDatabaseName } from '../../scripts/restore-drill.mjs';

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
