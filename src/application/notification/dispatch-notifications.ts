import { nextAttemptAt, renderNotificationMessage } from '@domain/notification';
import type { NotificationOutboxRepository } from '@ports/notification-outbox';
import type { NotificationSender } from '@ports/notification-sender';

/** Rows claimed per pass. Bounded so one pass cannot hold the whole outbox in memory. */
const DEFAULT_BATCH_SIZE = 20;

export interface DispatchNotificationsDeps {
  outbox: NotificationOutboxRepository;
  /** The delivery channel. `NOTIFICATION_SENDER=noop` keeps the system usable without one. */
  sender: NotificationSender;
}

export interface DispatchNotificationsInput {
  now: Date;
  /** Rows per pass; defaults to {@link DEFAULT_BATCH_SIZE}. */
  limit?: number;
}

export interface DispatchNotificationsResult {
  attempted: number;
  sent: number;
  /** Failed this attempt but rescheduled; the next pass may pick them up. */
  retried: number;
  /** Terminal: attempts exhausted, or the channel said the failure is permanent. */
  failed: number;
}

/**
 * Delivery: claim due outbox rows, hand each to the channel, record what happened (SRS 3.2
 * "Rate limits", FR-017, AC-015).
 *
 * The dispatcher is deliberately thin. The two decisions worth naming are elsewhere: *when* a
 * retry may run is `nextAttemptAt` in the domain retry policy, and *what the message says* is
 * `renderNotificationMessage`. This class only sequences claim → send → record, which is what
 * makes it testable against a fake sender with no channel present.
 *
 * A pass is not a loop: it claims one bounded batch and returns, so the caller decides the
 * cadence and a long backlog cannot monopolise a worker tick. A row that fails is rescheduled by
 * the policy, not retried inline; a row that was delivered is never claimed again, because its
 * status is no longer `PENDING`.
 */
export class DispatchNotifications {
  constructor(private readonly deps: DispatchNotificationsDeps) {}

  /**
   * Return rows a previous, dead dispatcher left in `PROCESSING` to `PENDING`.
   *
   * Must run before the first send of a process. With one dispatcher that is safe (see the port's
   * note); it is also why this is a separate call rather than something `run` does every pass —
   * a blanket reset during a live pass would reset a row that is in flight *right now*.
   */
  async recoverAbandoned(): Promise<number> {
    return this.deps.outbox.recoverAbandoned();
  }

  async run(input: DispatchNotificationsInput): Promise<DispatchNotificationsResult> {
    const claimed = await this.deps.outbox.claimDue({
      now: input.now,
      limit: input.limit ?? DEFAULT_BATCH_SIZE,
    });
    const result: DispatchNotificationsResult = {
      attempted: claimed.length,
      sent: 0,
      retried: 0,
      failed: 0,
    };

    for (const notification of claimed) {
      const text = renderNotificationMessage(notification.content);

      let delivered = false;
      let retryable = true;
      let reason = 'the channel did not report an outcome';
      let retryAfterSeconds: number | null = null;

      try {
        const outcome = await this.deps.sender.send({
          notificationId: notification.id,
          jobId: notification.jobId,
          text,
        });
        if (outcome.delivered) {
          delivered = true;
        } else {
          retryable = outcome.retryable;
          reason = outcome.reason;
          retryAfterSeconds = outcome.retryAfterSeconds ?? null;
        }
      } catch (error) {
        // A sender that throws is a channel problem, not a decision to give up: reschedule it
        // like any other transient failure so a buggy adapter cannot silently drop a row into
        // PROCESSING forever.
        reason = error instanceof Error ? error.message : String(error);
      }

      if (delivered) {
        await this.deps.outbox.markSent({ id: notification.id, sentAt: input.now });
        result.sent += 1;
        continue;
      }

      const next = retryable
        ? nextAttemptAt({
            attemptCount: notification.attemptCount,
            now: input.now,
            retryAfterSeconds,
          })
        : null;

      await this.deps.outbox.markFailed({
        id: notification.id,
        lastError: reason,
        nextAttemptAt: next,
      });
      if (next === null) result.failed += 1;
      else result.retried += 1;
    }

    return result;
  }
}
