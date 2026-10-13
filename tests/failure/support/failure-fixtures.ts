/**
 * Shared fixtures for failure tests (AC-014, ENG-031).
 *
 * The child process and the parent test must agree on the work task type and on
 * the worker identity/lease configuration, so both import these values instead of
 * duplicating literals that could silently drift apart.
 */

/** Task type whose handler never completes, so the attempt stays RUNNING. */
export const BLOCKING_TASK_TYPE = 'failure.blocking-task';

/** Identity of the worker process that is killed mid-attempt. */
export const KILLED_WORKER_ID = 'failure-test-killed-worker';

/** Identity of the fresh worker that recovers the abandoned attempt. */
export const RECOVERY_WORKER_ID = 'failure-test-recovery-worker';

/**
 * Lease held by the killed worker.
 *
 * A one-second lease keeps the recovery wait short while still exercising real
 * time-based expiry; the test deliberately does not force expiry with SQL, because
 * the claim under test is that the lease lapses *because the owner died*.
 */
export const KILLED_WORKER_LEASE_SECONDS = 1;

/** Heartbeat cadence for the killed worker; the worker requires it < the lease. */
export const KILLED_WORKER_HEARTBEAT_MS = 250;
