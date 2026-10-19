import { isMatchable, matchInputHashOf, scoreMatch } from '@domain/matching';
import {
  NOTIFICATION_ELIGIBILITY_VERSION,
  NOTIFICATION_EVENT_NEW_MATCH,
  NOTIFICATION_TYPE_NEW_MATCH,
  evaluateNotificationEligibility,
  type NotificationEligibilityDecision,
} from '@domain/notification';
import type { JobMatch } from '@domain/types';
import type { CandidateProfileRepository } from '@ports/candidate-profile-repository';
import type { JobMatchRepository } from '@ports/job-match-repository';
import type { MatchableJobReader } from '@ports/matchable-job-reader';
import type { NotificationFactsReader } from '@ports/notification-outbox';

/** Jobs read per page. Bounded so one run does not hold every matchable job in memory. */
const DEFAULT_PAGE_SIZE = 100;

export interface ScoreMatchesDeps {
  profiles: CandidateProfileRepository;
  jobs: MatchableJobReader;
  matches: JobMatchRepository;
  /** The SRS 3.2 predicates that live in the outbox and the feedback table. */
  facts: NotificationFactsReader;
}

export interface ScoreMatchesInput {
  /** Restrict scoring to one source (the matching trigger runs per source run). Omit for all. */
  sourceId?: string;
  /** Jobs read per page; defaults to {@link DEFAULT_PAGE_SIZE}. */
  pageSize?: number;
  /**
   * Cooperative cancellation (worker shutdown). Checked before each job, never mid-write, so an
   * aborted attempt stops promptly and leaves only complete rows behind — each of which a rerun
   * re-finds as unchanged.
   */
  signal?: AbortSignal;
  /**
   * Injected evaluation time (ENG-012): this use case never reads the clock, and the clock is
   * not part of the input hash, so scoring later updates a row instead of duplicating it.
   */
  now: Date;
}

/**
 * How many (profile, job) pairs were evaluated, and what each write did. `jobScores` is the
 * total, so `skipped + inserted + updated + unchanged === jobScores`.
 */
export interface ScoreMatchesResult {
  profiles: number;
  jobScores: number;
  /** Rejected by the matchable-job policy (`isMatchable`) before scoring. */
  skipped: number;
  inserted: number;
  updated: number;
  unchanged: number;
  /**
   * Outbox rows created in the same transaction as their match (ENG-027). Lower than
   * `jobScores` for three ordinary reasons: the job was not eligible, its event was already
   * reserved (AC-016), or the job was skipped.
   */
  notificationsReserved: number;
}

/**
 * Scores every matchable job against every candidate profile (FR-013, FR-014; SRS 11.2).
 *
 * ## Shape of the work
 *
 * Profiles are the outer loop and jobs are paged inside it. One profile is the v1 reality
 * (FR-012), but nothing here assumes it: a second profile multiplies the work rather than
 * requiring a redesign, and every stored match is keyed by `userId` (SRS 5.6).
 *
 * ## What this use case owns
 *
 * It decides *what* is scored, gives the domain the exact inputs, and hands persistence the
 * identity of those inputs. The profile revision and the input hash are computed here, in the
 * domain, and passed down — a repository never invents them (the same boundary rule ADR-0001
 * applies to fingerprints).
 *
 * ## Idempotence
 *
 * Re-running is safe: `saveIfChanged` is keyed by (user, job, matcherVersion, inputHash) and
 * only rewrites the row when the recomputed output actually differs, so a crash mid-run
 * followed by a rerun converges on one row per input set.
 *
 * ## Policy
 *
 * The reader filters to ACTIVE jobs with a usable description; that filter is re-applied here
 * through `isMatchable`, so a job obtained from anywhere else cannot bypass the policy.
 *
 * The re-check reads the status the reader returned, so it cannot catch a job that expires
 * *between* the page read and the write. Closing that window needs a conditional insert inside
 * the save transaction; not done until there is evidence it matters.
 *
 * ## Notification (ENG-027)
 *
 * A scored job is also evaluated for notification eligibility (SRS 3.2), and an eligible one
 * carries a reservation into the same save, so the match row and its outbox row are written in
 * one transaction. A crash before a reservation is therefore impossible to observe: either both
 * rows exist or neither does, and the retry re-derives the same decision because the eligibility
 * inputs are all stored facts.
 *
 * The reservation is a *row*, not a message: nothing is delivered here, and nothing reads these
 * rows yet. `payload` carries the eligibility verdict beside the evidence so a delivered message
 * can be rendered later without re-deriving why it was sent.
 */
export class ScoreMatches {
  constructor(private readonly deps: ScoreMatchesDeps) {}

  async run(input: ScoreMatchesInput): Promise<ScoreMatchesResult> {
    const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
    const profiles = await this.deps.profiles.listProfiles();
    const result: ScoreMatchesResult = {
      profiles: profiles.length,
      jobScores: 0,
      skipped: 0,
      inserted: 0,
      updated: 0,
      unchanged: 0,
      notificationsReserved: 0,
    };

    for (const stored of profiles) {
      let cursor: string | null = null;
      for (;;) {
        const page = await this.deps.jobs.listMatchableJobs({
          limit: pageSize,
          afterJobId: cursor,
          ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
        });
        if (page.length === 0) break;

        const nextCursor = page[page.length - 1].jobId;
        // The keyset is strictly ascending (pinned by the reader's own test); this only stops a
        // runaway loop from hammering the database if that ever stops being true.
        if (nextCursor === cursor) break;
        cursor = nextCursor;

        // One round trip per predicate for the whole page: eligibility is evaluated per job, but
        // the facts it needs are not per-job queries.
        const facts = await this.deps.facts.factsForJobs({
          userId: stored.userId,
          jobIds: page.map((batch) => batch.jobId),
          notificationType: NOTIFICATION_TYPE_NEW_MATCH,
          event: NOTIFICATION_EVENT_NEW_MATCH,
        });

        for (const batch of page) {
          // Worker shutdown: stop at a job boundary. Everything already written is complete and
          // will be re-found as 'unchanged' on the retry, so nothing is half-done.
          if (input.signal?.aborted === true) {
            throw new Error('match scoring was aborted before completing');
          }

          result.jobScores += 1;

          // Re-applied policy: the query filtered, but the rule belongs to the domain.
          if (!isMatchable(batch.lifecycleStatus, batch.job)) {
            result.skipped += 1;
            continue;
          }

          const match = scoreMatch({ profile: stored.profile, job: batch.job, now: input.now });
          const decision = evaluateNotificationEligibility({
            lifecycleStatus: batch.lifecycleStatus,
            applicationTarget: batch.applicationTarget,
            score: match.score,
            confidence: match.confidence,
            alreadyNotified: facts.alreadyNotified.has(batch.jobId),
            rejectedByUser: facts.rejected.has(batch.jobId),
          });

          const outcome = await this.deps.matches.saveIfChanged({
            userId: stored.userId,
            jobId: batch.jobId,
            profileVersion: stored.profileVersion,
            inputHash: matchInputHashOf({
              profileVersion: stored.profileVersion,
              matcherVersion: match.matcherVersion,
              job: batch.job,
            }),
            scoredAt: input.now,
            match,
            notification: decision.eligible
              ? {
                  notificationType: NOTIFICATION_TYPE_NEW_MATCH,
                  event: NOTIFICATION_EVENT_NEW_MATCH,
                  payload: notificationPayloadOf(match, decision),
                  nextAttemptAt: input.now,
                }
              : null,
          });
          result[outcome.status] += 1;
          if (outcome.notificationReserved) result.notificationsReserved += 1;
        }
      }
    }

    return result;
  }
}

/**
 * What the outbox row carries (SRS 5.2 `payload`).
 *
 * It records *why* the user is about to be told about this job — the eligibility verdict and the
 * evidence it was made from — rather than a rendered message. Rendering SRS 3.2's content list
 * needs the job's company and source name, which the scoring view does not carry, so the message
 * itself belongs to the delivery increment; storing a half-rendered one now would freeze in the
 * wrong shape.
 */
function notificationPayloadOf(match: JobMatch, decision: NotificationEligibilityDecision): unknown {
  return {
    eligibilityVersion: NOTIFICATION_ELIGIBILITY_VERSION,
    eligibilityExplanation: decision.explanation,
    matcherVersion: match.matcherVersion,
    score: match.score,
    confidence: match.confidence,
    explanation: match.explanation,
    matchedSkills: [...match.matchedSkills],
    missingSkills: [...match.missingSkills],
    uncertainSkills: [...match.uncertainSkills],
  };
}
