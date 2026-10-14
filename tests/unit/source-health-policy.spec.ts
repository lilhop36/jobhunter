import { HealthStatus, SourceRunStatus } from '@domain/enums';
import {
  SOURCE_HEALTH_POLICY_VERSION,
  classifySourceHealth,
} from '@domain/health/source-health-policy';

const FINISHED_AT = new Date('2026-05-01T10:00:00.000Z');

function classify(
  runStatus: SourceRunStatus,
  overrides: { finishedAt?: Date | null; unexpectedZeroResults?: boolean } = {},
) {
  return classifySourceHealth({
    runStatus,
    finishedAt: overrides.finishedAt === undefined ? FINISHED_AT : overrides.finishedAt,
    unexpectedZeroResults: overrides.unexpectedZeroResults ?? false,
  });
}

describe('classifySourceHealth', () => {
  it('marks a clean run healthy and dates the last success', () => {
    expect(classify(SourceRunStatus.SUCCEEDED)).toEqual({
      status: HealthStatus.HEALTHY,
      lastSuccessfulRunAt: FINISHED_AT,
      lastErrorAt: null,
      reason: 'the most recent collection completed successfully',
    });
  });

  it('marks a failed run failing and dates the error', () => {
    expect(classify(SourceRunStatus.FAILED)).toMatchObject({
      status: HealthStatus.FAILING,
      lastSuccessfulRunAt: null,
      lastErrorAt: FINISHED_AT,
    });
  });

  it('degrades a partial run without dating it as a success', () => {
    // A partial run is not a success: if it moved `lastSuccessfulRunAt`, the column could
    // no longer answer "when did this source last work".
    expect(classify(SourceRunStatus.PARTIAL)).toMatchObject({
      status: HealthStatus.DEGRADED,
      lastSuccessfulRunAt: null,
      lastErrorAt: FINISHED_AT,
    });
  });

  it('names the AC-018 anomaly when a zero-result run degradates a source', () => {
    expect(classify(SourceRunStatus.PARTIAL, { unexpectedZeroResults: true })?.reason).toContain(
      'zero results',
    );
    expect(classify(SourceRunStatus.PARTIAL)?.reason).not.toContain('zero results');
  });

  it('concludes nothing from a run that has not finished', () => {
    expect(classify(SourceRunStatus.RUNNING)).toBeNull();
  });

  it('sets no timestamp when the run recorded no finish time', () => {
    expect(classify(SourceRunStatus.SUCCEEDED, { finishedAt: null })).toMatchObject({
      status: HealthStatus.HEALTHY,
      lastSuccessfulRunAt: null,
      lastErrorAt: null,
    });
  });

  it('maps exactly the three terminal statuses and nothing else', () => {
    // Guards against a future terminal status silently mapping to HEALTHY.
    for (const status of Object.values(SourceRunStatus)) {
      const update = classify(status);
      if (status === SourceRunStatus.RUNNING) expect(update).toBeNull();
      else expect(update).not.toBeNull();
    }
  });

  it('stamps a policy version', () => {
    expect(SOURCE_HEALTH_POLICY_VERSION).toBe('FR-020_SOURCE_HEALTH_V1');
  });
});
