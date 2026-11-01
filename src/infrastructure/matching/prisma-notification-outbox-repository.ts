import { Prisma, PrismaClient } from '@prisma/client';
import { ApplicationMethod, SalaryPeriod, SalaryType } from '@domain/enums';
import { readNotificationEvidence } from '@domain/notification';
import type {
  ClaimedNotification,
  NotificationOutboxRepository,
} from '@ports/notification-outbox';

/** See PrismaJobRepository for why the row clock is UTC-naive `timestamp(3)`. */
const NOW_UTC = Prisma.raw("date_trunc('milliseconds', now() AT TIME ZONE 'UTC')");

/**
 * Bind a clock value as ISO-8601 text (see PrismaJobMatchRepository.asTimestamp).
 */function asTimestamp(value: Date): string {
  return value.toISOString();
}

function asAmount(value: Prisma.Decimal | null): string | null {
  // Exact decimal string, never a float: the stored amount is what the source said (ENG-006).
  return value === null ? null : value.toFixed(2);
}

const CLAIM_SELECT = {
  id: true,
  userId: true,
  jobId: true,
  attemptCount: true,
  notificationType: true,
  event: true,
  payload: true,
  job: {
    select: {
      title: true,
      company: true,
      locationText: true,
      salaryType: true,
      salaryMin: true,
      salaryMax: true,
      salaryCurrency: true,
      salaryPeriod: true,
      applicationMethod: true,
      applyUrl: true,
      applyEmail: true,
      source: { select: { name: true } },
    },
  },
} satisfies Prisma.NotificationOutboxSelect;

type ClaimRow = Prisma.NotificationOutboxGetPayload<{ select: typeof CLAIM_SELECT }>;

function toClaimed(row: ClaimRow): ClaimedNotification {
  return {
    id: row.id,
    userId: row.userId,
    jobId: row.jobId,
    attemptCount: row.attemptCount,
    notificationType: row.notificationType,
    event: row.event,
    content: {
      title: row.job.title,
      company: row.job.company,
      locationText: row.job.locationText,
      salary: {
        type: row.job.salaryType as SalaryType,
        min: asAmount(row.job.salaryMin),
        max: asAmount(row.job.salaryMax),
        currency: row.job.salaryCurrency,
        period: row.job.salaryPeriod as SalaryPeriod,
      },
      application: {
        method: row.job.applicationMethod as ApplicationMethod,
        applyUrl: row.job.applyUrl,
        applyEmail: row.job.applyEmail,
      },
      sourceName: row.job.source.name,
      // The payload is stored JSON from an earlier write: read it defensively, never trust it.
      evidence: readNotificationEvidence(row.payload),
    },
  };
}

/**
 * The dispatcher's view of `notification_outbox` (SRS 3.2 "Rate limits", FR-017, AC-015).
 *
 * Everything here is a status transition or a claim; no delivery policy lives in this file. The
 * one place that could have been is `markFailed`, which takes an already-decided
 * `nextAttemptAt` (null = terminal) rather than counting attempts itself.
 *
 * Claiming is a single statement: `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`
 * moves due rows to `PROCESSING` and increments `attemptCount` atomically, so a row is claimed
 * exactly once even if the process dies immediately afterwards — in which case `recoverAbandoned`
 * puts it back, which is the at-least-once behaviour ENG-027 documents as accepted.
 */
export class PrismaNotificationOutboxRepository implements NotificationOutboxRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async claimDue(input: { now: Date; limit: number }): Promise<ClaimedNotification[]> {
    if (input.limit <= 0) return [];

    const claimed = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE "notification_outbox"
      SET "status" = 'PROCESSING'::"NotificationStatus",
          "attemptCount" = "attemptCount" + 1
      WHERE "id" IN (
        SELECT "id" FROM "notification_outbox"
        WHERE "status" = 'PENDING'::"NotificationStatus"
          AND "nextAttemptAt" <= ${asTimestamp(input.now)}::timestamp(3)
        ORDER BY "nextAttemptAt" ASC, "id" ASC
        LIMIT ${input.limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id"
    `;
    if (claimed.length === 0) return [];

    const rows = await this.prisma.notificationOutbox.findMany({
      where: { id: { in: claimed.map((row) => row.id) } },
      select: CLAIM_SELECT,
      // The due order is chosen by the subquery, but the outer `UPDATE … RETURNING` emits rows in
      // whatever order its scan produced, so the claim list carries no order at all. Sorting the
      // read-back is what actually delivers the oldest due first, which is what the dispatcher and
      // `tests/integration/notification-dispatch.spec.ts` rely on.
      orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
    });

    return rows.map((row) => toClaimed(row));
  }

  async markSent(input: { id: string; sentAt: Date }): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "notification_outbox"
      SET "status" = 'SENT'::"NotificationStatus",
          "sentAt" = ${asTimestamp(input.sentAt)}::timestamp(3),
          "lastError" = NULL
      WHERE "id" = ${input.id}::uuid
        AND "status" = 'PROCESSING'::"NotificationStatus"
    `;
  }

  async markFailed(input: {
    id: string;
    lastError: string;
    nextAttemptAt: Date | null;
  }): Promise<void> {
    const terminal = input.nextAttemptAt === null;
    const next = input.nextAttemptAt === null ? null : asTimestamp(input.nextAttemptAt);
    await this.prisma.$executeRaw`
      UPDATE "notification_outbox"
      SET "status" = CASE WHEN ${terminal} THEN 'FAILED'::"NotificationStatus"
                          ELSE 'PENDING'::"NotificationStatus" END,
          "lastError" = ${input.lastError},
          "nextAttemptAt" = CASE WHEN ${terminal} THEN "nextAttemptAt"
                                 ELSE ${next}::timestamp(3) END
      WHERE "id" = ${input.id}::uuid
        AND "status" = 'PROCESSING'::"NotificationStatus"
    `;
  }

  async recoverAbandoned(): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE "notification_outbox"
      SET "status" = 'PENDING'::"NotificationStatus"
      WHERE "status" = 'PROCESSING'::"NotificationStatus"
    `;
  }

  async releaseUnsent(input: { ids: readonly string[] }): Promise<number> {
    if (input.ids.length === 0) return 0;
    const ids = Prisma.join(input.ids);
    return this.prisma.$executeRaw`
      UPDATE "notification_outbox"
      SET "status" = 'PENDING'::"NotificationStatus"
      WHERE "id"::text IN (${ids})
        AND "status" = 'PROCESSING'::"NotificationStatus"
    `;
  }

  async cancelIneligible(input: { now: Date }): Promise<number> {
    // One statement, no read-then-write window: a row is cancelled only while it is still
    // PENDING, so this can never steal a row another dispatcher is sending.
    //
    // The path clause is `hasUsableApplicationPath` under the default policy (AC-004): the
    // reservation path calls the domain with no policy override, so `UNKNOWN` and a method whose
    // required target is missing are the only unusable states. If a policy ever permits
    // informational listings, this clause must stop cancelling on it.
    //
    // One `lastError` for every clause because a rejected alert is also, now, a not-notifiable
    // one; the reason an operator wants is which clause fired, and the job row plus this row's
    // feedback answer that without a second verdict column.
    return this.prisma.$executeRaw`
      UPDATE "notification_outbox" o
      SET "status" = 'CANCELLED'::"NotificationStatus",
          "lastError" = 'the job is no longer notifiable'
      WHERE o."status" = 'PENDING'::"NotificationStatus"
        AND (
          EXISTS (
            SELECT 1 FROM "jobs" j
            WHERE j."id" = o."jobId"
              AND (
                j."lifecycleStatus" <> 'ACTIVE'::"LifecycleStatus"
                OR (j."applicationDeadline" IS NOT NULL
                    AND j."applicationDeadline" + INTERVAL '1 day'
                        <= ${asTimestamp(input.now)}::timestamp(3))
                OR (j."applicationMethod" = 'UNKNOWN'::"ApplicationMethod"
                    OR (j."applicationMethod" IN ('ONLINE_URL'::"ApplicationMethod", 'PDF_FORM'::"ApplicationMethod")
                        AND j."applyUrl" IS NULL)
                    OR (j."applicationMethod" = 'EMAIL'::"ApplicationMethod"
                        AND j."applyEmail" IS NULL))
              )
          )
          OR EXISTS (
            SELECT 1 FROM "notification_feedback" f
            WHERE f."notificationId" = o."id"
              AND f."value" = 'NOT_RELEVANT'::"NotificationFeedbackValue"
          )
        )
    `;
  }
}
