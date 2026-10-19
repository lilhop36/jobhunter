/**
 * Retry policy for notification delivery (SRS 3.2 "Rate limits": "Telegram failures and 429
 * responses shall be handled by persistent outbox retry/backoff"; FR-017; AC-015).
 *
 * The SRS requires bounded retry with backoff but fixes no numbers, so the ladder is recorded
 * here rather than scattered through the dispatcher, and it is stamped by
 * `NOTIFICATION_RETRY_POLICY_VERSION` so a stored row's attempt count can be read against the
 * policy that produced it.
 *
 * Delivery is at-least-once (ENG-027): a crash between sending and recording `SENT` may produce
 * one duplicate, which the SRS accepts as documented. Nothing here tries to make it exactly-once,
 * because that would need a transactional send, which no HTTP channel offers.
 */
export const NOTIFICATION_RETRY_POLICY_VERSION = '1.0.0';

export interface NotificationRetryPolicy {
  /** Attempts after which the row becomes terminal `FAILED` instead of being rescheduled. */
  maxAttempts: number;
  /** Seconds to wait before attempt `n + 1`, ceilinged at the last entry. */
  backoffSeconds: readonly number[];
  /** Cap on a sender-supplied `retryAfterSeconds`, so a hostile header cannot park a row forever. */
  maxRetryAfterSeconds: number;
}

/**
 * Five attempts: 1 minute, 5, 30, 2 hours, 6 hours — about nine hours from first try to terminal.
 * Long enough for a Telegram outage or a 429 window, short enough that a genuinely broken
 * destination surfaces the same day.
 */
export const NOTIFICATION_RETRY_POLICY_V1: Readonly<NotificationRetryPolicy> = {
  maxAttempts: 5,
  backoffSeconds: [60, 300, 1800, 7200, 21600],
  maxRetryAfterSeconds: 21600,
};

/**
 * When attempt `attemptCount + 1` may run, or `null` when the row has exhausted its attempts and
 * must fail terminally.
 *
 * `retryAfterSeconds` is what the sender asked for (a 429's `retry_after`, typically). It is
 * honoured when it exceeds the ladder — waiting *less* would just burn an attempt — and capped,
 * because an unbounded hint would let the channel decide how long the user waits.
 */
export function nextAttemptAt(input: {
  attemptCount: number;
  now: Date;
  retryAfterSeconds?: number | null;
  policy?: NotificationRetryPolicy;
}): Date | null {
  const policy = input.policy ?? NOTIFICATION_RETRY_POLICY_V1;
  if (input.attemptCount >= policy.maxAttempts) return null;

  const index = Math.min(input.attemptCount - 1, policy.backoffSeconds.length - 1);
  const ladder = policy.backoffSeconds[Math.max(index, 0)];
  const asked = input.retryAfterSeconds ?? 0;
  const bounded = Math.min(Math.max(asked, 0), policy.maxRetryAfterSeconds);
  const seconds = Math.max(ladder, bounded);

  return new Date(input.now.getTime() + seconds * 1000);
}
