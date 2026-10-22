/**
 * Ports for the notification outbox (SRS 3.2, 4.8, 5.2; FR-016, FR-017; ENG-027).
 *
 * There is deliberately no `NotificationOutboxRepository.reserve` here. ENG-027 requires the
 * match row and its outbox row in one transaction, so a reservation is not an independent write:
 * it is part of the match write (`JobMatchRepository.saveIfChanged`) and travels as an input to
 * it. A separate reserve method with its own transaction would look like the requirement while
 * breaking it — a crash between the two writes would leave an eligible job unnotified forever.
 */

import type { NotificationMessageContent } from '@domain/notification';

/**
 * A reservation to make in the same transaction as the match it announces.
 *
 * `jobMatchId` is not here: the match row's id only exists inside that transaction, so the
 * writer fills it in from the row it just wrote.
 */
export interface ReserveNotificationInput {
  /** SRS 5.2 `notificationType` (v1: `NEW_MATCH`). */
  notificationType: string;
  /** The event within that type. With user, job and type it is the ENG-027 event key. */
  event: string;
  /** Rendered content for the dispatcher, stored at reservation time. */
  payload: unknown;
  /** Earliest time the dispatcher may attempt delivery. */
  nextAttemptAt: Date;
}

/** The two SRS 3.2 predicates that are not facts about the job itself. */
export interface NotificationFacts {
  /** Jobs whose equivalent event already has an outbox row, by job id. */
  alreadyNotified: ReadonlySet<string>;
  /** Jobs the user rejected or suppressed (`NOT_RELEVANT` feedback), by job id. */
  rejected: ReadonlySet<string>;
}

/**
 * Resolves those predicates for a page of jobs in one round trip per predicate, so evaluating
 * eligibility inside the scoring loop does not turn into two queries per job.
 */
export interface NotificationFactsReader {
  factsForJobs(input: {
    userId: string;
    jobIds: readonly string[];
    notificationType: string;
    event: string;
  }): Promise<NotificationFacts>;
}

/** A row the dispatcher has claimed, with everything the message needs already read. */
export interface ClaimedNotification {
  id: string;
  jobId: string;
  /** Destination lookup key for the channel (the row's user, SRS 2.2/2.4). */
  userId: string;
  /** Attempts made so far, *including* the claim that produced this row. */
  attemptCount: number;
  notificationType: string;
  event: string;
  content: NotificationMessageContent;
}

/**
 * The outbox as the delivery dispatcher sees it (SRS 3.2 "Rate limits", FR-017, AC-015).
 *
 * The status transitions are the repository's, the *policy* is not: whether an attempt is the
 * last one, and when the next one may run, are decided by the caller from the retry policy, and
 * arrive here as `nextAttemptAt` (null = terminal). A repository that decided that itself would
 * put delivery policy in SQL.
 */
export interface NotificationOutboxRepository {
  /**
   * Claim up to `limit` due rows, oldest first, moving them to `PROCESSING` and counting the
   * attempt. `FOR UPDATE SKIP LOCKED` keeps two dispatchers from claiming the same row; a row
   * already `PROCESSING` is invisible here, which is what stops a second send while one is in
   * flight.
   */
  claimDue(input: { now: Date; limit: number }): Promise<ClaimedNotification[]>;

  /** Record a delivery. `lastError` is cleared: the row carries only its current state. */
  markSent(input: { id: string; sentAt: Date }): Promise<void>;

  /** Record a failed attempt. `nextAttemptAt: null` makes the row terminal `FAILED`. */
  markFailed(input: {
    id: string;
    lastError: string;
    nextAttemptAt: Date | null;
  }): Promise<void>;

  /**
   * Return rows stuck in `PROCESSING` to `PENDING`: a dispatcher that died mid-send left them
   * there, and nothing else will ever look at them again.
   *
   * ponytail: this assumes one dispatcher, which is true while the only caller is the single
   * worker process, and it is why it must run *before* any send starts. With two dispatchers a
   * row being sent would be reset under the first one's feet, and the fix is a lease column
   * like `work_tasks` has rather than a blanket reset.
   */
  recoverAbandoned(): Promise<number>;

  /**
   * Cancel `PENDING` rows whose Job can no longer be notified (FR-016, SRS 3.2: "ACTIVE"), and
   * report how many were cancelled.
   *
   * A reservation is made at scoring time and may sit in the outbox through a retry ladder, so
   * the job's state at send time is the one that decides. Two things can change it: the job left
   * `ACTIVE`, or its stated deadline passed after the reservation.
   *
   * The deadline comparison is the same rule as `@domain/lifecycle`'s `isPastDeadline`, repeated
   * in SQL because this is a single-statement guard over a batch. `tests/integration/
   * deadline-expiry.spec.ts` pins the two to the same answer.
   */
  cancelIneligible(input: { now: Date }): Promise<number>;
}
