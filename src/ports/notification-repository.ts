import type { NotificationFeedbackValue, NotificationStatus } from '@domain/enums';

/**
 * The user-facing side of the outbox (SRS 3.4 `GET /api/notifications` and
 * `POST /api/notifications/:id/feedback`; FR-018, AC-017).
 *
 * This is a separate port from {@link NotificationOutboxRepository} on purpose. That one is the
 * dispatcher's: it claims rows and records attempts, and its methods are meaningless outside a
 * delivery pass. This one is a read surface plus the one write a user performs, and nothing here
 * can move a row between delivery states.
 */

/** One notification as the API publishes it, with the user's verdict if there is one. */
export interface NotificationRecord {
  id: string;
  userId: string;
  jobId: string;
  /** The match this alert was raised for; null for a policy that notifies unmatched jobs. */
  jobMatchId: string | null;
  notificationType: string;
  /** The event within the type; with user, job and type it is the delivery event key. */
  event: string;
  status: NotificationStatus;
  attemptCount: number;
  lastError: string | null;
  createdAt: Date;
  sentAt: Date | null;
  /** SRS 5.2 `payload`: the SRS 3.2 content stored when the match was written. */
  payload: unknown;
  /** Null until the user classifies it (SRS 4.8). */
  feedback: NotificationFeedbackValue | null;
}

/** Keyset position: `(createdAt, id)`, matching the newest-first order. */
export interface NotificationCursor {
  createdAt: Date;
  id: string;
}

export interface ListNotificationsOptions {
  /** Omitted lists every candidate's notifications; the API passes what it was asked for. */
  userId?: string;
  status?: NotificationStatus;
  cursor?: NotificationCursor | null;
  limit: number;
}

export interface ListNotificationsPage {
  notifications: NotificationRecord[];
  nextCursor: NotificationCursor | null;
}

export interface NotificationRepository {
  /** One page, newest first. */
  listNotifications(options: ListNotificationsOptions): Promise<ListNotificationsPage>;

  findById(id: string): Promise<NotificationRecord | null>;

  /**
   * Record a verdict, replacing any previous one for the same notification: SRS 4.8 records
   * feedback as a classification of a delivered alert, and a changed mind is still one verdict.
   *
   * The notification must already exist; the caller has checked, and the database's foreign key
   * is the backstop. Returns the notification with the stored verdict attached.
   */
  recordFeedback(input: {
    notificationId: string;
    value: NotificationFeedbackValue;
  }): Promise<NotificationRecord>;
}
