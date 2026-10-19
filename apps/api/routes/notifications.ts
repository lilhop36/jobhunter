import type { FastifyInstance } from 'fastify';
import type { NotificationFeedbackValue, NotificationStatus } from '@domain/enums';
import type {
  NotificationCursor,
  NotificationRecord,
  NotificationRepository,
} from '@ports/notification-repository';
import { ApiError } from '../errors';
import { decodeCursor, encodeCursor } from '../cursor';
import { listNotificationsQuery, notificationIdParams, submitFeedbackBody } from '../schemas';

/**
 * The two notification routes (SRS 3.4 `GET /api/notifications` and
 * `POST /api/notifications/:id/feedback`).
 *
 * The SRS fixes the endpoints but no response body, so the shape below is proposed from SRS 5.2
 * (NotificationOutbox) plus the delivery state the dispatcher maintains. `payload` is published
 * as stored: it is the SRS 3.2 content captured when the match was written, and its own
 * `eligibilityVersion` says which rules produced it. A rendered `content` string is deliberately
 * not built here — that would need the job and source joined into a read the web UI has not asked
 * for yet.
 *
 * Feedback is the one write these routes allow, and it can only record a verdict. Nothing here
 * can move a notification between delivery states: that is the dispatcher's, so a request cannot
 * mark an unsent alert as sent.
 *
 * The same caveat as the match routes applies: no authentication is specified, so the feedback
 * route lets any caller classify any notification by id. Only the loopback binding and the
 * unpublished ids stand in the way until SRS 3.4's authentication gap is closed.
 */
export interface NotificationRoutesDeps {
  notifications: NotificationRepository;
}

const DEFAULT_LIMIT = 20;

export async function registerNotificationRoutes(
  app: FastifyInstance,
  deps: NotificationRoutesDeps,
): Promise<void> {
  app.get('/api/notifications', { schema: { querystring: listNotificationsQuery } }, async (request) => {
    const query = request.query as {
      userId?: string;
      status?: NotificationStatus;
      cursor?: string;
      limit?: number;
    };

    const page = await deps.notifications.listNotifications({
      ...(query.userId === undefined ? {} : { userId: query.userId }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.cursor === undefined ? {} : { cursor: decodeNotificationCursor(query.cursor) }),
      limit: query.limit ?? DEFAULT_LIMIT,
    });

    return {
      notifications: page.notifications.map(serializeNotification),
      pagination: { nextCursor: page.nextCursor === null ? null : encodeCursor(page.nextCursor) },
    };
  });

  app.post(
    '/api/notifications/:id/feedback',
    { schema: { params: notificationIdParams, body: submitFeedbackBody } },
    async (request) => {
      const { id } = request.params as { id: string };
      const { value } = request.body as { value: NotificationFeedbackValue };

      // The verdict is recorded against a notification, so an unknown id is a 404 rather than a
      // row created for a notification that does not exist.
      if ((await deps.notifications.findById(id)) === null) {
        throw ApiError.notFound(`Notification ${id} was not found`);
      }

      const updated = await deps.notifications.recordFeedback({ notificationId: id, value });
      return serializeNotification(updated);
    },
  );
}

/**
 * One notification, as the API publishes it.
 *
 * `attemptCount` and `lastError` are delivery state, not user-facing content: they are published
 * because SRS 4.9 asks for notification volume and failure visibility, and the web UI is the only
 * operational view this system has. `sentAt` is null for a row that has not been delivered, which
 * is how a client distinguishes "queued" from "delivered" without reading the status enum.
 */
function serializeNotification(record: NotificationRecord) {
  return {
    id: record.id,
    userId: record.userId,
    jobId: record.jobId,
    jobMatchId: record.jobMatchId,
    notificationType: record.notificationType,
    event: record.event,
    status: record.status,
    attemptCount: record.attemptCount,
    lastError: record.lastError,
    payload: record.payload,
    feedback: record.feedback,
    createdAt: record.createdAt.toISOString(),
    sentAt: record.sentAt === null ? null : record.sentAt.toISOString(),
  };
}

/**
 * A cursor is `{ createdAt, id }`, the keyset the previous page ended at, and `createdAt` is
 * validated as a parseable instant so a cursor cannot ask for a page no row could follow.
 */
function decodeNotificationCursor(raw: string): NotificationCursor {
  const value = decodeCursor(raw);
  const createdAt = typeof value?.createdAt === 'string' ? new Date(value.createdAt) : null;
  if (createdAt === null || Number.isNaN(createdAt.getTime()) || typeof value?.id !== 'string') {
    throw ApiError.validation('The pagination cursor is not valid');
  }
  return { createdAt, id: value.id as string };
}
