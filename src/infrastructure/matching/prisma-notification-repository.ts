import { Prisma, PrismaClient } from '@prisma/client';
import type { NotificationFeedbackValue, NotificationStatus } from '@domain/enums';
import type {
  ListNotificationsOptions,
  ListNotificationsPage,
  NotificationCursor,
  NotificationRecord,
  NotificationRepository,
} from '@ports/notification-repository';

/**
 * Bind a clock value as ISO-8601 text (see PrismaJobMatchRepository.asTimestamp): the bucket
 * columns are `timestamp(3)` without time zone, and a `Date` parameter would be bound as
 * `timestamptz` and shifted by the session's zone.
 */
function asTimestamp(value: Date): string {
  return value.toISOString();
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

interface NotificationRow {
  id: string;
  userId: string;
  jobId: string;
  jobMatchId: string | null;
  notificationType: string;
  event: string;
  status: string;
  attemptCount: number;
  lastError: string | null;
  createdAt: Date | string;
  sentAt: Date | string | null;
  payload: unknown;
  feedback: string | null;
}

/**
 * The columns the API publishes, plus the user's verdict read as a scalar subquery.
 *
 * A subquery rather than a join: one notification has at most one verdict
 * (`one_feedback_per_notification`), so a join would be a left join that cannot multiply rows
 * while looking like it could.
 */
const NOTIFICATION_COLUMNS = Prisma.sql`
  "n"."id", "n"."userId", "n"."jobId", "n"."jobMatchId", "n"."notificationType", "n"."event",
  "n"."status", "n"."attemptCount", "n"."lastError", "n"."createdAt", "n"."sentAt", "n"."payload",
  (SELECT "f"."value" FROM "notification_feedback" "f" WHERE "f"."notificationId" = "n"."id") AS "feedback"
`;

function toRecord(row: NotificationRow): NotificationRecord {
  return {
    id: row.id,
    userId: row.userId,
    jobId: row.jobId,
    jobMatchId: row.jobMatchId,
    notificationType: row.notificationType,
    event: row.event,
    status: row.status as NotificationStatus,
    attemptCount: row.attemptCount,
    lastError: row.lastError,
    createdAt: toDate(row.createdAt),
    sentAt: row.sentAt === null ? null : toDate(row.sentAt),
    payload: row.payload,
    feedback: row.feedback as NotificationFeedbackValue | null,
  };
}

/**
 * The read surface behind `GET /api/notifications` and the write behind
 * `POST /api/notifications/:id/feedback` (SRS 3.4; FR-018, AC-017).
 *
 * Reads only: no method here can change a delivery state. Delivery is the dispatcher's port, and
 * keeping the two apart is what stops a request from marking an unsent alert as sent.
 *
 * ponytail: the list reads `notification_outbox` sequentially and sorts it, because SRS 5.6
 * recommends only `(status, nextAttemptAt)` for the due-scan and the table is one row per
 * (candidate, job, event). Add a `("userId", "createdAt" DESC, "id" DESC)` index — and to the
 * schema, with a migration — when a page read stops being instant.
 */
export class PrismaNotificationRepository implements NotificationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listNotifications(options: ListNotificationsOptions): Promise<ListNotificationsPage> {
    const userClause =
      options.userId === undefined ? Prisma.empty : Prisma.sql`AND "n"."userId" = ${options.userId}::uuid`;
    const statusClause =
      options.status === undefined
        ? Prisma.empty
        : Prisma.sql`AND "n"."status" = ${options.status}::"NotificationStatus"`;
    const cursor = options.cursor ?? null;
    // Newest first, and the keyset runs the same way: skip everything at or after the cursor.
    const cursorClause =
      cursor === null
        ? Prisma.empty
        : Prisma.sql`AND ("n"."createdAt", "n"."id") < (${asTimestamp(cursor.createdAt)}::timestamp(3), ${cursor.id}::uuid)`;

    const rows = await this.prisma.$queryRaw<NotificationRow[]>`
      SELECT ${NOTIFICATION_COLUMNS} FROM "notification_outbox" "n"
      WHERE TRUE
        ${userClause}
        ${statusClause}
        ${cursorClause}
      ORDER BY "n"."createdAt" DESC, "n"."id" DESC
      LIMIT ${options.limit + 1}
    `;

    const page = rows.slice(0, options.limit).map(toRecord);
    const last = page[page.length - 1];
    const nextCursor: NotificationCursor | null =
      rows.length > options.limit && last !== undefined
        ? { createdAt: last.createdAt, id: last.id }
        : null;
    return { notifications: page, nextCursor };
  }

  async findById(id: string): Promise<NotificationRecord | null> {
    const rows = await this.prisma.$queryRaw<NotificationRow[]>`
      SELECT ${NOTIFICATION_COLUMNS} FROM "notification_outbox" "n" WHERE "n"."id" = ${id}::uuid
    `;
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async recordFeedback(input: {
    notificationId: string;
    value: NotificationFeedbackValue;
  }): Promise<NotificationRecord> {
    await this.prisma.notificationFeedback.upsert({
      where: { notificationId: input.notificationId },
      create: { notificationId: input.notificationId, value: input.value },
      update: { value: input.value },
    });

    const record = await this.findById(input.notificationId);
    // Cannot be null: the upsert's foreign key just proved the row exists and nothing deletes
    // notifications. Failing loudly beats returning a record that is not there.
    if (record === null) {
      throw new Error(`Notification ${input.notificationId} disappeared while recording feedback`);
    }
    return record;
  }
}
