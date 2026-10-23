import { WorkTaskFailure, WorkTaskRecord } from '@domain/types';

/**
 * Context handed to a task handler. `signal` is aborted when the worker is
 * shutting down or detects that the lease was lost; handlers must stop promptly
 * and, if they cannot finish, throw so the attempt is reported as failed. A
 * handler that resolves after the signal is aborted is still treated as an
 * incomplete attempt, never as success.
 */
export interface WorkTaskHandlerContext {
  task: WorkTaskRecord;
  signal: AbortSignal;
}

export type WorkTaskHandler = (context: WorkTaskHandlerContext) => Promise<void>;

/**
 * Transient failure: the task may succeed if retried (network blip, 5xx, rate
 * limit, lock contention).
 */
export class RetryableWorkTaskError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RetryableWorkTaskError';
  }
}

/**
 * Permanent failure: retrying will not help (invalid payload, unsupported task
 * type, a 4xx that will not change). The task goes straight to FAILED.
 */
export class PermanentWorkTaskError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PermanentWorkTaskError';
  }
}

/** A message longer than this is truncated; a log line is not an evidence store. */
const MAX_ERROR_DESCRIPTION_LENGTH = 500;

/** How many nested `cause`s are followed before the chain is cut. */
const MAX_CAUSE_DEPTH = 3;

function describeOne(error: unknown): string {
  if (error instanceof Error) {
    return error.name && error.name !== 'Error' ? `${error.name}: ${error.message}` : error.message;
  }
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/**
 * A one-line description of a thrown value, including its `cause` chain.
 *
 * `cause` is where Node puts the diagnosis a bare `TypeError: fetch failed` hides:
 * `ECONNRESET`, `ENOTFOUND`, `CERT_HAS_EXPIRED`, a connect timeout. Without it an acquisition
 * failure is unactionable, which is exactly the state the EffoySira run history was in
 * (six identical `fetch failed` rows). Bounded in both depth and length because the text
 * ends up in a log line and a bounded `errorSummary` column.
 */
function describeError(error: unknown, depth = 0): string {
  const text = describeOne(error);
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause === undefined || cause === null || depth >= MAX_CAUSE_DEPTH) {
    return text.length <= MAX_ERROR_DESCRIPTION_LENGTH
      ? text
      : `${text.slice(0, MAX_ERROR_DESCRIPTION_LENGTH - 3)}...`;
  }
  const described = `${text} (cause: ${describeError(cause, depth + 1)})`;
  return described.length <= MAX_ERROR_DESCRIPTION_LENGTH
    ? described
    : `${described.slice(0, MAX_ERROR_DESCRIPTION_LENGTH - 3)}...`;
}

export { describeError };

/**
 * Turn a thrown value into failure evidence for the repository.
 *
 * The worker never decides retry limits or backoff — it only classifies the
 * error as retryable or permanent. Unrecognised errors default to retryable:
 * retrying transient infrastructure faults is safer than discarding work, and
 * the repository's attempt limit still bounds it.
 */
export function classifyWorkTaskError(error: unknown): WorkTaskFailure {
  if (error instanceof PermanentWorkTaskError) {
    return { message: describeError(error), retryable: false };
  }
  if (error instanceof RetryableWorkTaskError) {
    return { message: describeError(error), retryable: true };
  }
  return { message: describeError(error), retryable: true };
}
