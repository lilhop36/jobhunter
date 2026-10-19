import { describe, expect, it } from 'vitest';
import {
  MATCH_SCORING_TASK_TYPE,
  matchScoringDedupeKey,
  parseMatchScoringTaskPayload,
} from '@application/matching';
import { PermanentWorkTaskError } from '@application/worker';

/**
 * The scoring task's untrusted edges: the dedupe key that makes one hand-off per run (SRS 11.2)
 * and the payload parser that turns a malformed payload into a permanent failure instead of a
 * scoring pass that silently scores nothing.
 */

describe('matchScoringDedupeKey', () => {
  it('keys a run-scoped hand-off by the run alone', () => {
    expect(matchScoringDedupeKey({ sourceId: 'source-a', sourceRunId: 'run-a' })).toBe(
      `${MATCH_SCORING_TASK_TYPE}:run-a`,
    );
  });

  it('keys a backfill by the source, under a prefix no run id can produce', () => {
    expect(matchScoringDedupeKey({ sourceId: 'source-a', sourceRunId: null })).toBe(
      `${MATCH_SCORING_TASK_TYPE}:source:source-a`,
    );
  });

  it('never collides a source with a run of the same id', () => {
    const run = matchScoringDedupeKey({ sourceId: 'x', sourceRunId: 'x' });
    const backfill = matchScoringDedupeKey({ sourceId: 'x', sourceRunId: null });
    expect(run).not.toBe(backfill);
  });
});

describe('parseMatchScoringTaskPayload', () => {
  it('accepts a run-scoped payload', () => {
    expect(
      parseMatchScoringTaskPayload({ sourceId: 's-1', sourceRunId: 'r-1', trigger: 'SOURCE_RUN' }),
    ).toEqual({ sourceId: 's-1', sourceRunId: 'r-1', trigger: 'SOURCE_RUN' });
  });

  it('accepts a backfill payload and treats a missing sourceRunId as null', () => {
    expect(
      parseMatchScoringTaskPayload({ sourceId: 's-1', trigger: 'MATCHER_VERSION_CHANGED' }),
    ).toEqual({ sourceId: 's-1', sourceRunId: null, trigger: 'MATCHER_VERSION_CHANGED' });
  });

  it.each([
    ['a null payload', null],
    ['a missing sourceId', { sourceRunId: null, trigger: 'SOURCE_RUN' }],
    ['an empty sourceId', { sourceId: '', sourceRunId: null, trigger: 'SOURCE_RUN' }],
    ['an empty sourceRunId', { sourceId: 's-1', sourceRunId: '', trigger: 'SOURCE_RUN' }],
    ['an unknown trigger', { sourceId: 's-1', sourceRunId: null, trigger: 'WHENEVER' }],
    ['a missing trigger', { sourceId: 's-1', sourceRunId: null }],
  ])('rejects %s as a permanent failure', (_label, payload) => {
    expect(() => parseMatchScoringTaskPayload(payload)).toThrow(PermanentWorkTaskError);
  });
});
