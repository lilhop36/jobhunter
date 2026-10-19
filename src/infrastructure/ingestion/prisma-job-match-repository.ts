import { Prisma, PrismaClient } from '@prisma/client';
import {
  asPercent,
  jobMatchEvidenceOf,
  parseJobMatchEvidence,
  type MatchFactorScores,
  type Percent,
} from '@domain/types';
import {
  JobMatchRecord,
  JobMatchRepository,
  ListMatchesOptions,
  ListMatchesPage,
  SaveJobMatchInput,
  SaveJobMatchOutcome,
} from '@ports/job-match-repository';

/** See PrismaJobRepository for why the row clock is UTC-naive `timestamp(3)`. */
const NOW_UTC = Prisma.raw("date_trunc('milliseconds', now() AT TIME ZONE 'UTC')");

interface MatchRow {
  id: string;
  userId: string;
  jobId: string;
  score: number;
  confidence: number;
  roleScore: number | null;
  skillScore: number | null;
  experienceScore: number | null;
  locationScore: number | null;
  employmentScore: number | null;
  freshnessScore: number | null;
  salaryScore: number | null;
  evidence: unknown;
  explanation: string;
  matcherVersion: string;
  profileVersion: string;
  inputHash: string;
  scoredAt: Date | string;
  createdAt: Date | string;
}

const MATCH_COLUMNS = Prisma.raw(`
  "id", "userId", "jobId", "score", "confidence",
  "roleScore", "skillScore", "experienceScore", "locationScore", "employmentScore",
  "freshnessScore", "salaryScore", "evidence", "explanation", "matcherVersion",
  "profileVersion", "inputHash", "scoredAt", "createdAt"
`);

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Bind a clock value as ISO-8601 text. The bucket columns are `timestamp(3)` *without* time
 * zone: a `Date` parameter is bound as `timestamptz` and then converted to the session's
 * zone by the cast, which silently shifts the instant (the same reason PrismaJobRepository
 * formats its timestamps by hand). ISO text parses directly, so the UTC instant is preserved.
 */
function asTimestamp(value: Date): string {
  return value.toISOString();
}

function nullablePercent(value: number | null): Percent | null {
  return value === null ? null : asPercent(value);
}

/**
 * Output fields in a fixed order, so "did anything change?" is a string equality and never
 * depends on JSON key ordering (neither ours nor jsonb's). The injected clock is absent
 * from this signature: `scoredAt` moving alone does not count as a change.
 */
function outputSignature(parts: {
  score: Percent;
  confidence: Percent;
  factors: MatchFactorScores;
  evidence: unknown;
  explanation: string;
}): string {
  return JSON.stringify([
    parts.score,
    parts.confidence,
    parts.factors.role,
    parts.factors.skills,
    parts.factors.experience,
    parts.factors.location,
    parts.factors.employment,
    parts.factors.freshness,
    parts.factors.salary,
    parts.evidence,
    parts.explanation,
  ]);
}

function toRecord(row: MatchRow): JobMatchRecord {
  const evidence = parseJobMatchEvidence(row.evidence);
  if (evidence === null) {
    throw new Error(`stored job match ${row.id} has an unrecognised evidence document`);
  }
  return {
    id: row.id,
    userId: row.userId,
    jobId: row.jobId,
    score: asPercent(row.score),
    confidence: asPercent(row.confidence),
    factors: {
      role: nullablePercent(row.roleScore),
      skills: nullablePercent(row.skillScore),
      experience: nullablePercent(row.experienceScore),
      location: nullablePercent(row.locationScore),
      employment: nullablePercent(row.employmentScore),
      freshness: nullablePercent(row.freshnessScore),
      salary: nullablePercent(row.salaryScore),
    },
    matchedSkills: evidence.skills.matched,
    missingSkills: evidence.skills.missing,
    uncertainSkills: evidence.skills.uncertain,
    matchedEvidence: evidence.matched,
    missingEvidence: evidence.missing,
    uncertainEvidence: evidence.uncertain,
    explanation: row.explanation,
    matcherVersion: row.matcherVersion,
    profileVersion: row.profileVersion,
    inputHash: row.inputHash,
    scoredAt: toDate(row.scoredAt),
    createdAt: toDate(row.createdAt),
  };
}

/**
 * Store for deterministic match results (SRS 5.2 JobMatch).
 *
 * Writes are idempotent per canonical input set: the unique index
 * `one_match_per_user_job_input` keys a row by (user, job, matcherVersion, inputHash), and
 * `saveIfChanged` only rewrites the row when the recomputed output actually differs. A
 * rerun after a crash therefore converges to exactly one row per input set, while a profile
 * edit or a changed job produces a new row instead of erasing the previous score.
 *
 * The evidence document is validated on the way back out (`parseJobMatchEvidence`): a row
 * written by an unknown evidence version fails loudly rather than reading as a blank match.
 */
export class PrismaJobMatchRepository implements JobMatchRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async saveIfChanged(input: SaveJobMatchInput): Promise<SaveJobMatchOutcome> {
    const { match } = input;
    const factors = match.factors;
    const evidence = jobMatchEvidenceOf(match);
    const evidenceJson = JSON.stringify(evidence);
    const signature = outputSignature({
      score: match.score,
      confidence: match.confidence,
      factors,
      evidence,
      explanation: match.explanation,
    });

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "job_matches"
        WHERE "userId" = ${input.userId}::uuid
          AND "jobId" = ${input.jobId}::uuid
          AND "matcherVersion" = ${match.matcherVersion}
          AND "inputHash" = ${input.inputHash}
        FOR UPDATE
      `;

      if (existing.length === 0) {
        await tx.$executeRaw`
          INSERT INTO "job_matches" (
            "id", "userId", "jobId", "score", "confidence",
            "roleScore", "skillScore", "experienceScore", "locationScore", "employmentScore",
            "freshnessScore", "salaryScore", "evidence", "explanation", "matcherVersion",
            "profileVersion", "inputHash", "scoredAt", "createdAt"
          ) VALUES (
            gen_random_uuid(), ${input.userId}::uuid, ${input.jobId}::uuid,
            ${match.score}::int, ${match.confidence}::int,
            ${factors.role}::int, ${factors.skills}::int, ${factors.experience}::int,
            ${factors.location}::int, ${factors.employment}::int, ${factors.freshness}::int,
            ${factors.salary}::int, ${evidenceJson}::jsonb, ${match.explanation},
            ${match.matcherVersion}, ${input.profileVersion}, ${input.inputHash},
            ${asTimestamp(input.scoredAt)}::timestamp(3), ${NOW_UTC}
          )
        `;
        return 'inserted';
      }

      const stored = await tx.$queryRaw<MatchRow[]>`
        SELECT ${MATCH_COLUMNS} FROM "job_matches" WHERE "id" = ${existing[0].id}::uuid
      `;
      const current = toRecord(stored[0]);
      const currentSignature = outputSignature({
        score: current.score,
        confidence: current.confidence,
        factors: current.factors,
        evidence: jobMatchEvidenceOf(current),
        explanation: current.explanation,
      });
      if (currentSignature === signature) return 'unchanged';

      await tx.$executeRaw`
        UPDATE "job_matches" SET
          "score" = ${match.score}::int,
          "confidence" = ${match.confidence}::int,
          "roleScore" = ${factors.role}::int,
          "skillScore" = ${factors.skills}::int,
          "experienceScore" = ${factors.experience}::int,
          "locationScore" = ${factors.location}::int,
          "employmentScore" = ${factors.employment}::int,
          "freshnessScore" = ${factors.freshness}::int,
          "salaryScore" = ${factors.salary}::int,
          "evidence" = ${evidenceJson}::jsonb,
          "explanation" = ${match.explanation},
          "scoredAt" = ${asTimestamp(input.scoredAt)}::timestamp(3)
        WHERE "id" = ${existing[0].id}::uuid
      `;
      return 'updated';
    });
  }

  async findById(id: string): Promise<JobMatchRecord | null> {
    const rows = await this.prisma.$queryRaw<MatchRow[]>`
      SELECT ${MATCH_COLUMNS} FROM "job_matches" WHERE "id" = ${id}::uuid
    `;
    return rows.length === 1 ? toRecord(rows[0]) : null;
  }

  /**
   * One page of matches, best score first, keyset-paginated on (score DESC, id ASC).
   *
   * A row read here is validated like any other (`parseJobMatchEvidence`), so a page cannot
   * publish a corrupt row as a mostly-empty match.
   *
   * ponytail: reads `job_matches` sequentially and sorts it. The table holds one row per
   * (candidate, job, input set), so that is small for v1 — add a
   * `("matcherVersion", "score" DESC, "id")` index (and to the guard test's list) when a page
   * read stops being instant.
   */
  async listMatches(options: ListMatchesOptions): Promise<ListMatchesPage> {
    const { matcherVersion, userId, cursor } = options;
    // Fragments rather than a single over-conditional query: an omitted filter is absent from
    // the SQL, so nothing has to be bound to a placeholder value it does not mean.
    const userClause =
      userId === undefined ? Prisma.empty : Prisma.sql`AND "userId" = ${userId}::uuid`;
    const cursorClause =
      cursor === undefined || cursor === null
        ? Prisma.empty
        : Prisma.sql`AND ("score" < ${cursor.score}::int OR ("score" = ${cursor.score}::int AND "id" > ${cursor.id}::uuid))`;

    // `limit + 1` is how a keyset page knows there is a next one without a second count.
    const rows = await this.prisma.$queryRaw<MatchRow[]>`
      SELECT ${MATCH_COLUMNS} FROM "job_matches"
      WHERE "matcherVersion" = ${matcherVersion}
        ${userClause}
        ${cursorClause}
      ORDER BY "score" DESC, "id" ASC
      LIMIT ${options.limit + 1}
    `;

    const page = rows.slice(0, options.limit).map(toRecord);
    const last = page[page.length - 1];
    return {
      matches: page,
      nextCursor:
        rows.length > options.limit && last !== undefined
          ? { score: last.score, id: last.id }
          : null,
    };
  }

  async findByInput(input: {
    userId: string;
    jobId: string;
    matcherVersion: string;
    inputHash: string;
  }): Promise<JobMatchRecord | null> {
    const rows = await this.prisma.$queryRaw<MatchRow[]>`
      SELECT ${MATCH_COLUMNS} FROM "job_matches"
      WHERE "userId" = ${input.userId}::uuid
        AND "jobId" = ${input.jobId}::uuid
        AND "matcherVersion" = ${input.matcherVersion}
        AND "inputHash" = ${input.inputHash}
    `;
    return rows.length === 1 ? toRecord(rows[0]) : null;
  }

  /**
   * `EXISTS` rather than a count: one row under another revision is already the whole answer, so
   * nothing here depends on how many stale rows there are.
   *
   * ponytail: the predicate is "any row at another revision", and `job_matches` keeps a
   * previous revision's rows on purpose (a profile edit or an input change adds history instead
   * of overwriting it). So after a matcher upgrade this stays true, and each worker start asks
   * for one backfill per enabled source. That is a bounded, idempotent scoring pass per start,
   * not a loop — narrowing it to "a live job with no row at this revision" needs the matchable
   * policy expressed in SQL, which is not worth duplicating until the extra pass is measurable.
   */
  async hasMatchesForOtherMatcherVersion(matcherVersion: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ stale: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM "job_matches" WHERE "matcherVersion" <> ${matcherVersion}
      ) AS "stale"
    `;
    return rows[0]?.stale === true;
  }
}
