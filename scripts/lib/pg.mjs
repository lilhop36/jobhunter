/**
 * Shared helpers for the operator backup scripts, which use libpq's own binaries
 * (pg_dump, pg_restore, psql, createdb, dropdb) instead of Prisma.
 *
 * DATABASE_URL is a Prisma URL and may carry Prisma-only query parameters such as
 * `schema` and `connection_limit`, which libpq rejects. The URL is therefore decomposed
 * and the connection passed as discrete arguments. The password travels in PGPASSWORD,
 * never on a command line or in output.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

const CONNECT_TIMEOUT_SECONDS = '10';

function decodeComponent(value, label) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`DATABASE_URL has invalid percent-encoding in its ${label}.`);
  }
}

export function parseDatabaseUrl(raw = process.env.DATABASE_URL) {
  if (!raw) {
    throw new Error('DATABASE_URL is not set. Run through npm so `--env-file=.env` applies, or export it.');
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL.');
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new Error(`DATABASE_URL must use postgresql:// or postgres:// (got "${url.protocol}//").`);
  }

  const database = decodeComponent(url.pathname.replace(/^\/+/, ''), 'database name');
  if (!database) throw new Error('DATABASE_URL does not name a database.');
  if (!url.hostname) throw new Error('DATABASE_URL does not name a host.');

  const user = decodeComponent(url.username, 'user name');
  if (!user) {
    throw new Error('DATABASE_URL does not name a user; these scripts run non-interactively.');
  }

  // The scripts compare and restore the default schema. A different one would silently
  // back up the wrong tables, so refuse rather than guess.
  const schema = url.searchParams.get('schema');
  if (schema && schema !== 'public') {
    throw new Error(`These scripts support only the public schema (DATABASE_URL requests "${schema}").`);
  }

  return {
    // Node's URL keeps the brackets on an IPv6 literal; libpq wants the bare address.
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: url.port || '5432',
    user,
    password: decodeComponent(url.password, 'password'),
    database,
    sslmode: url.searchParams.get('sslmode') ?? undefined,
  };
}

function versionKey(version) {
  const [major, minor = '0'] = version.split('.');
  return Number(major) * 1000 + Number(minor);
}

/**
 * Locate a libpq tool. PostgreSQL's installer does not add its bin directory to PATH,
 * so on Windows the highest installed major version is used unless PG_BIN overrides it.
 * The tool must match the server's major version; pg_dump refuses newer servers.
 */
export function resolvePgBinary(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;

  const override = process.env.PG_BIN;
  if (override) {
    const candidate = join(override, exe);
    if (!existsSync(candidate)) {
      throw new Error(`PG_BIN="${override}" does not contain ${exe}. Point PG_BIN at the bin directory.`);
    }
    return candidate;
  }

  if (process.platform === 'win32') {
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
      .filter((root) => typeof root === 'string' && root.length > 0)
      .map((root) => join(root, 'PostgreSQL'));
    let best = null;
    for (const root of roots) {
      if (!existsSync(root)) continue;
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^\d+(\.\d+)?$/.test(entry.name)) continue;
        const candidate = join(root, entry.name, 'bin', exe);
        if (!existsSync(candidate)) continue;
        if (best === null || versionKey(entry.name) > versionKey(best.version)) {
          best = { version: entry.name, path: candidate };
        }
      }
    }
    if (best) return best.path;
  }

  // Fall back to PATH; runPg turns a missing binary into an actionable message.
  return exe;
}

/** Connection options shared by every libpq tool. `--no-password` prevents a prompt. */
export function connectionArgs(database) {
  return ['--host', database.host, '--port', database.port, '--username', database.user, '--no-password'];
}

export function connectionEnvironment(database) {
  const env = {};
  if (database?.password) env.PGPASSWORD = database.password;
  if (database?.sslmode) env.PGSSLMODE = database.sslmode;
  return env;
}

export function runPg(binary, args, { database, allowFailure = false } = {}) {
  const result = spawnSync(binary, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...connectionEnvironment(database),
      PGCONNECT_TIMEOUT: process.env.PGCONNECT_TIMEOUT || CONNECT_TIMEOUT_SECONDS,
    },
    maxBuffer: 128 * 1024 * 1024,
  });

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new Error(
        `Could not run ${binary}. Install the PostgreSQL client tools (same major version as the ` +
          'server) and put their bin directory on PATH, or set PG_BIN to it.',
      );
    }
    throw result.error;
  }

  if (result.status !== 0 && !allowFailure) {
    const detail = (result.stderr ?? '').trim();
    throw new Error(`${basename(binary)} exited with code ${result.status}${detail ? `:\n${detail}` : '.'}`);
  }

  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export function quoteIdentifier(name) {
  return `"${name.replace(/"/g, '""')}"`;
}

function psqlQuery(database, sql, target = database.database) {
  const { stdout } = runPg(
    resolvePgBinary('psql'),
    [
      '--no-psqlrc',
      '--no-align',
      '--tuples-only',
      '--field-separator',
      '\t',
      '--set',
      'ON_ERROR_STOP=1',
      '--dbname',
      target,
      ...connectionArgs(database),
      '--command',
      sql,
    ],
    { database },
  );
  return stdout.replace(/\r\n/g, '\n').trim();
}

export function listPublicTables(database, target = database.database) {
  const output = psqlQuery(
    database,
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name;`,
    target,
  );
  return output ? output.split('\n').filter(Boolean) : [];
}

/** Exact per-table counts, in one round trip, for a snapshot comparison. */
export function countRows(database, tables, target = database.database) {
  if (tables.length === 0) return new Map();
  const sql = tables
    .map(
      (table) =>
        `SELECT ${`'${table.replace(/'/g, "''")}'`} AS table_name, count(*)::bigint AS row_count FROM ${quoteIdentifier(table)}`,
    )
    .join('\nUNION ALL\n');
  const output = psqlQuery(database, `${sql};`, target);
  const counts = new Map();
  for (const line of output.split('\n')) {
    if (!line) continue;
    const [table, count] = line.split('\t');
    counts.set(table, Number(count));
  }
  return counts;
}
