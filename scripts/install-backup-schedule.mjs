#!/usr/bin/env node
/**
 * Show, or install, the daily backup schedule (FR-021).
 *
 *   npm run backup:schedule                          # print the command; change nothing
 *   npm run backup:schedule -- --apply               # register the Windows scheduled task
 *   npm run backup:schedule -- --time 03:30          # a different local start time
 *   npm run backup:schedule -- --task-name "JobHunter backup"
 *
 * On Windows the task runs `npm run backup` from the repository root and appends both streams to
 * `backups/backup.log`. It runs as the account that creates it and only while that account is
 * signed in, so no password is stored. On other platforms the equivalent cron line is printed;
 * this script does not edit a crontab.
 *
 * Installing is deliberate: without --apply this script only prints what it would run.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TASK_NAME = 'JobHunter backup';
const DEFAULT_TIME = '02:00';
const DEFAULT_LOG_FILE = 'backups/backup.log';
const TASK_RUN_LIMIT = 261; // schtasks /TR: longer values are rejected (or truncated by some shells).

/** Validate a local 24-hour start time. */
export function assertTime(time) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new Error(`Start time must be HH:MM in 24-hour form (got "${time}").`);
  }
  return time;
}

/**
 * The `schtasks /Create` invocation for a daily backup. `cmd /c` is needed because /TR runs a
 * program, not a shell command line, and the redirection must append rather than truncate.
 */
export function buildWindowsTaskCommand({
  repoRoot = REPOSITORY_ROOT,
  time = DEFAULT_TIME,
  taskName = DEFAULT_TASK_NAME,
  logFile = DEFAULT_LOG_FILE,
} = {}) {
  assertTime(time);
  if (!taskName || taskName.length > 200) {
    throw new Error('The task name must be a non-empty string of at most 200 characters.');
  }

  const log = resolve(repoRoot, logFile);
  const run = `cmd /c cd /d "${resolve(repoRoot)}" && npm run backup >> "${log}" 2>&1`;
  if (run.length > TASK_RUN_LIMIT) {
    throw new Error(
      `The scheduled command is ${run.length} characters; Task Scheduler accepts at most ` +
        `${TASK_RUN_LIMIT}. Move the repository to a shorter path, or register a .cmd wrapper ` +
        'manually and point /TR at it.',
    );
  }

  return {
    binary: 'schtasks',
    args: ['/Create', '/SC', 'DAILY', '/ST', time, '/TN', taskName, '/TR', run, '/F'],
    run,
    log,
  };
}

/** The cron equivalent; installing a crontab is left to the account owner. */
export function buildCronLine({ repoRoot = REPOSITORY_ROOT, time = DEFAULT_TIME, logFile = DEFAULT_LOG_FILE } = {}) {
  assertTime(time);
  const [hour, minute] = time.split(':').map(Number);
  return `${minute} ${hour} * * * cd "${resolve(repoRoot)}" && npm run backup >> "${resolve(repoRoot, logFile)}" 2>&1`;
}

/**
 * Render the invocation for a terminal. `/TR` itself contains double quotes, so they are escaped
 * the way the script passes them; a hand-typed copy in cmd.exe needs different quoting, which is
 * why --apply, not the printed line, is the supported way to install the task.
 */
export function displayCommand({ binary, args }) {
  return [binary, ...args.map((arg) => (/\s|"/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg))].join(' ');
}

const USAGE =
  'usage: npm run backup:schedule [-- --apply] [--time HH:MM] [--task-name "<name>"] [--log-file <path>]';

function parseArguments(argv) {
  const options = { apply: false, time: DEFAULT_TIME, taskName: DEFAULT_TASK_NAME, logFile: DEFAULT_LOG_FILE };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') {
      options.apply = true;
    } else if (argument === '--time' || argument === '--task-name' || argument === '--log-file') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${argument} needs a value.\n${USAGE}`);
      index += 1;
      if (argument === '--time') options.time = value;
      if (argument === '--task-name') options.taskName = value;
      if (argument === '--log-file') options.logFile = value;
    } else {
      throw new Error(`Unknown argument "${argument}".\n${USAGE}`);
    }
  }
  return options;
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const repoRoot = REPOSITORY_ROOT;

    if (process.platform === 'win32') {
      const task = buildWindowsTaskCommand({ repoRoot, ...options });
      console.log(`[schedule] task:   ${options.taskName}`);
      console.log(`[schedule] runs:   daily at ${options.time} (local time, while the user is signed in)`);
      console.log(`[schedule] log:    ${task.log}`);
      console.log(`[schedule] command: ${displayCommand(task)}`);

      if (!options.apply) {
        console.log('[schedule] dry run: re-run with --apply to register the task');
      } else {
        const result = spawnSync(task.binary, task.args, { encoding: 'utf8' });
        if (result.error) throw result.error;
        if (result.status !== 0) {
          throw new Error(`schtasks exited with code ${result.status}: ${(result.stderr || result.stdout).trim()}`);
        }
        console.log('[schedule] registered. Check it with:');
        console.log(`[schedule]   schtasks /Query /TN "${options.taskName}"`);
        console.log('[schedule] and run it once with /Run to confirm a fresh .dump appears.');
      }
    } else {
      console.log(`[schedule] add this line with \`crontab -e\`:\n${buildCronLine({ repoRoot, ...options })}`);
      console.log(
        '[schedule] cron does not load a login shell: make sure PATH includes Node and the PostgreSQL ' +
          'client tools, or set PG_BIN and BACKUP_DIR in .env.',
      );
      if (options.apply) {
        throw new Error('--apply supports Windows Task Scheduler only; add the cron line above yourself.');
      }
    }
  } catch (error) {
    console.error(`[schedule] failed: ${error.message}`);
    process.exitCode = 1;
  }
}
