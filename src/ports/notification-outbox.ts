/**
 * Ports for the notification outbox (SRS 3.2, 4.8, 5.2; FR-016, FR-017; ENG-027).
 *
 * There is deliberately no `NotificationOutboxRepository.reserve` here. ENG-027 requires the
 * match row and its outbox row in one transaction, so a reservation is not an independent write:
 * it is part of the match write (`JobMatchRepository.saveIfChanged`) and travels as an input to
 * it. A separate reserve method with its own transaction would look like the requirement while
 * breaking it — a crash between the two writes would leave an eligible job unnotified forever.
 */

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
