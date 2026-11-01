import { NotificationFeedbackValue, PrismaClient } from '@prisma/client';
import type { NotificationFacts, NotificationFactsReader } from '@ports/notification-outbox';

/**
 * Reads the notification predicates that live in tables rather than on the job: "already
 * notified for this event" and "rejected or suppressed by the user" (SRS 3.2).
 *
 * Both are `Set`s of job ids for one page of jobs. Absence is the answer for anything not in
 * them, so an unknown job is simply not notified and not rejected — never a guess.
 */
export class PrismaNotificationFactsReader implements NotificationFactsReader {
  constructor(private readonly prisma: PrismaClient) {}

  async factsForJobs(input: {
    userId: string;
    jobIds: readonly string[];
    notificationType: string;
    event: string;
  }): Promise<NotificationFacts> {
    const jobIds = [...input.jobIds];
    if (jobIds.length === 0) {
      return { alreadyNotified: new Set(), rejected: new Set() };
    }

    const [notified, rejected] = await Promise.all([
      // Every status counts, including `CANCELLED` and `FAILED`, and that is deliberate: this is
      // the mirror of the event key, not a count of delivered alerts. `one_notification_per_event`
      // is a plain unique index, so an equivalent event can never be inserted a second time
      // (AC-016, ENG-027) — filtering the read to `SENT` would only make the decision disagree
      // with the write, which answers with `ON CONFLICT DO NOTHING` and reserves nothing.
      // Re-notifying a job that became eligible again therefore needs a different event key (or
      // a re-arm of the cancelled row), which is a product decision, not a WHERE clause.
      this.prisma.notificationOutbox.findMany({
        where: {
          userId: input.userId,
          jobId: { in: jobIds },
          notificationType: input.notificationType,
          event: input.event,
        },
        select: { jobId: true },
      }),
      // "Suppressed/rejected" is a verdict on the job, delivered through a notification row:
      // the feedback itself hangs off the outbox row that prompted it (FR-018).
      this.prisma.notificationFeedback.findMany({
        where: {
          value: NotificationFeedbackValue.NOT_RELEVANT,
          notification: { userId: input.userId, jobId: { in: jobIds } },
        },
        select: { notification: { select: { jobId: true } } },
      }),
    ]);

    return {
      alreadyNotified: new Set(notified.map((row) => row.jobId)),
      rejected: new Set(rejected.map((row) => row.notification.jobId)),
    };
  }
}
