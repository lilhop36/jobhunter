-- SRS 3.2, 4.8, 5.2 and 5.6 "Recommended indexes"; FR-016, FR-017, FR-018;
-- ENG-027, AC-015/016/017; Milestone 3 (ADR-0006).
-- Written by hand because this repo has no `prisma migrate dev` path; verified
-- against the Prisma schema with `prisma migrate diff` (see the repository
-- integration test).
--
-- Persistence only: nothing writes these rows yet. `notificationType` and `event`
-- are plain strings rather than enums because Appendix A defines no value set for
-- the former and v1 has exactly one of the latter; they become enums when a second
-- value exists (ENG-014: a notification-eligibility change is a versioned change).

CREATE TYPE "NotificationFeedbackValue" AS ENUM ('RELEVANT', 'NOT_RELEVANT', 'UNSURE');

CREATE TABLE "notification_outbox" (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "jobId" UUID NOT NULL,
  "jobMatchId" UUID,
  "notificationType" TEXT NOT NULL,
  event TEXT NOT NULL,
  payload JSONB NOT NULL,
  status "NotificationStatus" NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sentAt" TIMESTAMP(3),

  CONSTRAINT "notification_outbox_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "notification_feedback" (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  "notificationId" UUID NOT NULL,
  value "NotificationFeedbackValue" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "notification_feedback_pkey" PRIMARY KEY ("id")
);

-- ENG-027 / AC-016: the event key is unique per user, job, notification type and event,
-- so an equivalent event is rejected by the database instead of by a read-then-write
-- check. Plain (never partial): a partial index would let the same event back in once
-- the first row reached SENT. Guarded by tests/integration/partial-indexes.spec.ts.
CREATE UNIQUE INDEX "one_notification_per_event"
  ON "notification_outbox"("userId", "jobId", "notificationType", event);

-- SRS 5.6 "Recommended indexes": NotificationOutbox(status, nextAttemptAt).
CREATE INDEX "notification_outbox_status_nextAttemptAt_idx"
  ON "notification_outbox"(status, "nextAttemptAt");

-- One verdict per notification: feedback replaces the previous verdict (FR-018).
CREATE UNIQUE INDEX "one_feedback_per_notification"
  ON "notification_feedback"("notificationId");

ALTER TABLE "notification_outbox"
  ADD CONSTRAINT "notification_outbox_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notification_outbox"
  ADD CONSTRAINT "notification_outbox_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The match is the reason for the notification, not part of its identity: deleting a
-- match must not erase the record that the user was told about the job.
ALTER TABLE "notification_outbox"
  ADD CONSTRAINT "notification_outbox_jobMatchId_fkey"
  FOREIGN KEY ("jobMatchId") REFERENCES "job_matches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "notification_feedback"
  ADD CONSTRAINT "notification_feedback_notificationId_fkey"
  FOREIGN KEY ("notificationId") REFERENCES "notification_outbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;
