import { isMatchable, matchInputHashOf, scoreMatch } from '@domain/matching';
import type { CandidateProfileRepository } from '@ports/candidate-profile-repository';
import type { JobMatchRepository } from '@ports/job-match-repository';
import type { MatchableJobReader } from '@ports/matchable-job-reader';

/** Jobs read per page. Bounded so one run does not hold every matchable job in memory. */
const DEFAULT_PAGE_SIZE = 100;

export interface ScoreMatchesDeps {
  profiles: CandidateProfileRepository;
  jobs: MatchableJobReader;
  matches: JobMatchRepository;
}

export interface ScoreMatchesInput {
  /** Restrict scoring to one source (the matching trigger runs per source run). Omit for all. */
  sourceId?: string;
  /** Jobs read per page; defaults to {@link DEFAULT_PAGE_SIZE}. */
  pageSize?: number;
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

        for (const batch of page) {
          result.jobScores += 1;

          // Re-applied policy: the query filtered, but the rule belongs to the domain.
          if (!isMatchable(batch.lifecycleStatus, batch.job)) {
            result.skipped += 1;
            continue;
          }

          const match = scoreMatch({ profile: stored.profile, job: batch.job, now: input.now });
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
          });
          result[outcome] += 1;
        }
      }
    }

    return result;
  }
}
