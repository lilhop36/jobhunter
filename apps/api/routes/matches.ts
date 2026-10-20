import type { FastifyInstance } from 'fastify';
import { MATCHER_VERSION } from '@domain/matching';
import { isPercent, type MatchFactorScores } from '@domain/types';
import type { JobMatchRecord, JobMatchRepository, MatchCursor } from '@ports/job-match-repository';
import { ApiError } from '../errors';
import { decodeCursor, encodeCursor } from '../cursor';
import { listMatchesQuery, matchIdParams } from '../schemas';

/**
 * The two match routes (SRS 3.4 `GET /api/matches` and `GET /api/matches/:id`).
 *
 * The SRS fixes the endpoints but no response body, so the shapes below are proposed from SRS
 * 5.2 and the SRS 3.1 match detail: the list carries score, confidence, the per-factor
 * breakdown, and the explanation, while the detail route adds the evidence the explanation was
 * derived from. The full evidence is deliberately kept out of the list — it is "why it matches"
 * text, and SRS 3.1 asks a low-bandwidth client not to fetch what it will not render.
 *
 * Only the running API binds (loopback by default, `API_HOST` in `./config`), so these routes
 * publish candidate-scoped data to the local machine until authentication is specified. The
 * same reason keeps `accessPolicy` unpublished on the source routes.
 */
export interface MatchRoutesDeps {
  matches: JobMatchRepository;
}

const DEFAULT_LIMIT = 20;

export async function registerMatchRoutes(
  app: FastifyInstance,
  deps: MatchRoutesDeps,
): Promise<void> {
  app.get('/api/matches', { schema: { querystring: listMatchesQuery } }, async (request) => {
    const query = request.query as {
      matcherVersion?: string;
      userId?: string;
      cursor?: string;
      limit?: number;
    };

    const page = await deps.matches.listMatches({
      // Unstated revision means "the rules in force now" (ENG-013); naming an older one is how
      // stored evidence stays readable after a matcher change.
      matcherVersion: query.matcherVersion ?? MATCHER_VERSION,
      ...(query.userId === undefined ? {} : { userId: query.userId }),
      ...(query.cursor === undefined ? {} : { cursor: decodeMatchCursor(query.cursor) }),
      limit: query.limit ?? DEFAULT_LIMIT,
    });

    return {
      matches: page.matches.map(serializeMatch),
      pagination: { nextCursor: page.nextCursor === null ? null : encodeCursor(page.nextCursor) },
    };
  });

  app.get('/api/matches/:id', { schema: { params: matchIdParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const match = await deps.matches.findById(id);
    if (match === null) throw ApiError.notFound(`Match ${id} was not found`);
    return serializeMatchEvidence(match);
  });
}

/**
 * The summary of one stored match, as the list publishes it.
 *
 * `unknownFactors` names the factors that were excluded because the evidence was absent
 * (SRS 4.6 / AC-010). They are also `null` in `factors`, but a client that renders `null` as
 * zero would turn "unknown" into "negative", so the exclusion is stated rather than implied.
 * `profileVersion` and `inputHash` are engineering-owned identity (SRS 5.2 records them as
 * additions): they are what makes a stored score reproducible, not part of the score.
 */
function serializeMatch(match: JobMatchRecord) {
  return {
    id: match.id,
    userId: match.userId,
    jobId: match.jobId,
    score: match.score,
    confidence: match.confidence,
    factors: { ...match.factors },
    unknownFactors: unknownFactors(match.factors),
    explanation: match.explanation,
    matcherVersion: match.matcherVersion,
    profileVersion: match.profileVersion,
    inputHash: match.inputHash,
    scoredAt: match.scoredAt.toISOString(),
  };
}

/** The same summary, plus the observations the explanation was built from (FR-015). */
function serializeMatchEvidence(match: JobMatchRecord) {
  return {
    ...serializeMatch(match),
    skills: {
      matched: [...match.matchedSkills],
      missing: [...match.missingSkills],
      uncertain: [...match.uncertainSkills],
    },
    evidence: {
      matched: [...match.matchedEvidence],
      missing: [...match.missingEvidence],
      uncertain: [...match.uncertainEvidence],
    },
  };
}

/** Fixed order: the factor keys are the SRS 5.2 column order, not the JSON key order. */
const FACTOR_NAMES = [
  'role',
  'skills',
  'experience',
  'location',
  'employment',
  'freshness',
  'salary',
] as const satisfies readonly (keyof MatchFactorScores)[];

/** Exported for the web pages (`apps/api/routes/web.ts`), which render the same fixed factor order. */
export function unknownFactors(factors: MatchFactorScores): string[] {
  return FACTOR_NAMES.filter((name) => factors[name] === null);
}

/**
 * A cursor is `{ score, id }`, the key the previous page ended at. `score` is validated as a
 * Percent so a cursor cannot ask for a page that no row could ever follow.
 *
 * Exported for the web pages, which page the same list and must reject the same bad cursors.
 */
export function decodeMatchCursor(raw: string): MatchCursor {
  const value = decodeCursor(raw);
  if (value === null || typeof value.id !== 'string' || !isPercent(value.score)) {
    throw ApiError.validation('The pagination cursor is not valid');
  }
  return { score: value.score, id: value.id };
}
