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
 *
 * A batch is only safe to abandon mid-way because nothing here may leave a row in `PROCESSING`
 * with no record of it: rendering and delivery are both inside the per-row `try`, and a status
 * write that fails ends the pass after handing this pass's own rows back to `PENDING`. A row in
 * `PROCESSING` is invisible to the next claim, so an unhandled throw would strand it until the
 * process restarted (audit M3).
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
    // Eligibility can decay between reservation and delivery (FR-016): cancel what the job's own
    // state no longer supports before claiming, so this pass never sends a posting the candidate
    // cannot act on. Cancelled rows keep their recorded verdict instead of becoming FAILED.
    await this.deps.outbox.cancelIneligible({ now: input.now });

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

    // Every row this pass owns and has not yet recorded an outcome for.
    const unresolved = new Set(claimed.map((notification) => notification.id));

    try {
      for (const notification of claimed) {
        let delivered = false;
        let retryable = true;
        let reason = 'the channel did not report an outcome';
        let retryAfterSeconds: number | null = null;

        try {
          // Rendering is inside the try because it reads stored, unverified JSON: a payload this
          // revision cannot render is one bad message, not a batch abandoned mid-way with rows
          // still in `PROCESSING` (audit M3).
          const text = renderNotificationMessage(notification.content);
          const outcome = await this.deps.sender.send({
            notificationId: notification.id,
            userId: notification.userId,
            text,
            jobId: notification.jobId,
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
          unresolved.delete(notification.id);
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
        unresolved.delete(notification.id);
        if (next === null) result.failed += 1;
        else result.retried += 1;
      }
    } catch (error) {
      // Only a status write can get here, so the database is the thing that just failed. Hand
      // back the rows this pass claimed but could not record: left in `PROCESSING` they are
      // invisible to the next claim and would wait for a restart (`recoverAbandoned` runs at
      // process start, and cannot run here without disturbing a row another dispatcher holds).
      // Best effort: if this write fails too the caller still sees the one that ended the pass.
      await this.deps.outbox.releaseUnsent({ ids: [...unresolved] }).catch(() => undefined);
      throw error;
    }

    return result;
  }
}
