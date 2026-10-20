import { hostname } from 'node:os';

/**
 * Worker configuration (SRS 7.2 / 7.6, ENG-017).
 *
 * Parsed once at process start and rejected as a whole if it is wrong: a worker that comes
 * up with a guessed bound is worse than one that refuses to start, because it then runs for
 * days with the wrong recovery window.
 *
 * Two bounds are deliberately *required* and have no default, matching the use case that
 * consumes them (`RunSourceCollection`): the stale-run bound (ENG-025) and the acquisition
 * bound (ENG-031). A default would turn a safety decision into an accident.
 */
export interface WorkerConfig {
  databaseUrl: string;
  /** Recorded on every claimed task. Defaults to `host:pid`, which is unique per process. */
  workerId: string;
  /** Lease held per claimed task, in seconds. Defaults to 60. */
  leaseSeconds?: number;
  /** Idle wait between claims, in milliseconds. */
  pollIntervalMs?: number;
  /** How often abandoned task leases are recovered, in milliseconds. */
  reaperIntervalMs?: number;
  /** How often the scheduler re-evaluates due sources, in milliseconds. */
  schedulerIntervalMs?: number;
  /** An active collection run older than this many seconds is abandoned (ENG-025). */
  staleRunSeconds: number;
  /** Upper bound on one source acquisition, in milliseconds (ENG-031). */
  acquisitionTimeoutMs: number;
  /**
   * The Telegram bot credential (SRS 8.3: environment/secret-managed). When it is absent the
   * dispatcher deliberately does not run: there is no "send anyway" path, because a phoney
   * delivery status would be a lie in the outbox (ENG-008's spirit). Absence is announced at
   * start, not mistaken for health.
   */
  telegramBotToken?: string;
  /** How often the dispatcher sweeps the notification outbox, in milliseconds. */
  notificationDispatchIntervalMs?: number;
}

/** Raised for configuration that would make the worker unsafe or unstartable. */
export class WorkerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerConfigError';
  }
}

function requiredString(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new WorkerConfigError(`${name} is required`);
  return value;
}

function positiveNumber(env: NodeJS.ProcessEnv, name: string): number {
  const raw = requiredString(env, name);
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new WorkerConfigError(`${name} must be a positive number; received "${raw}"`);
  }
  return value;
}

function optionalPositiveNumber(env: NodeJS.ProcessEnv, name: string): number | undefined {
  if (env[name] === undefined || env[name]?.trim() === '') return undefined;
  return positiveNumber(env, name);
}

/** A credential the worker can legitimately run without; trimmed, and undefined when unset. */
function optionalString(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/**
 * Build the worker configuration from the environment, or throw `WorkerConfigError` naming
 * every offending variable. Nothing is defaulted here that the worker itself already
 * defaults, so there is one place per value.
 */
export function parseWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const databaseUrl = requiredString(env, 'DATABASE_URL');
  const staleRunSeconds = positiveNumber(env, 'SOURCE_STALE_RUN_SECONDS');
  const acquisitionTimeoutMs = positiveNumber(env, 'SOURCE_ACQUISITION_TIMEOUT_MS');

  // A run must never be reaped while it is legitimately still working. The acquisition bound
  // is part of every run, so if it is not shorter than the stale bound, an acquisition that
  // hangs is reaped before its own timeout can finalize the run - the outcome is discarded,
  // and a source that hangs on every attempt would look HEALTHY forever (FR-020), which is
  // exactly the silent false positive the recovery sweep exists to avoid.
  if (acquisitionTimeoutMs >= staleRunSeconds * 1000) {
    throw new WorkerConfigError(
      `SOURCE_ACQUISITION_TIMEOUT_MS (${acquisitionTimeoutMs}) must be shorter than ` +
        `SOURCE_STALE_RUN_SECONDS (${staleRunSeconds}s): otherwise a hanging acquisition is ` +
        'reaped as a dead run before its own bound can finalize it, discarding the outcome ' +
        'and leaving the source looking healthy',
    );
  }

  const heartbeat = optionalPositiveNumber(env, 'WORKER_HEARTBEAT_MS');
  if (heartbeat !== undefined) {
    const leaseSeconds = optionalPositiveNumber(env, 'WORKER_LEASE_SECONDS') ?? 60;
    if (heartbeat >= leaseSeconds * 1000) {
      // Fail here with the variable names rather than letting the worker throw a bare
      // RangeError about its resolved options.
      throw new WorkerConfigError(
        `WORKER_HEARTBEAT_MS (${heartbeat}) must be shorter than WORKER_LEASE_SECONDS (${leaseSeconds}s)`,
      );
    }
  }

  return {
    databaseUrl,
    workerId: env.WORKER_ID?.trim() || `${hostname()}:${process.pid}`,
    leaseSeconds: optionalPositiveNumber(env, 'WORKER_LEASE_SECONDS'),
    pollIntervalMs: optionalPositiveNumber(env, 'WORKER_POLL_INTERVAL_MS'),
    reaperIntervalMs: optionalPositiveNumber(env, 'WORKER_REAPER_INTERVAL_MS'),
    schedulerIntervalMs: optionalPositiveNumber(env, 'SOURCE_SCHEDULER_INTERVAL_MS'),
    telegramBotToken: optionalString(env, 'TELEGRAM_BOT_TOKEN'),
    notificationDispatchIntervalMs: optionalPositiveNumber(env, 'NOTIFICATION_DISPATCH_INTERVAL_MS'),
    staleRunSeconds,
    acquisitionTimeoutMs,
  };
}
