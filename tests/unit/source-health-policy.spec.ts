import { HealthStatus, SourceRunStatus } from '@domain/enums';
import {
  SOURCE_HEALTH_POLICY_VERSION,
  classifySourceHealth,
} from '@domain/health/source-health-policy';
import type { YieldDriftVerdict } from '@domain/health/source-yield-drift';

function classify(
  runStatus: SourceRunStatus,
  overrides: {
    unexpectedZeroResults?: boolean;
    attributableToSource?: boolean;
    yieldDrift?: YieldDriftVerdict | null;
  } = {},
) {
  return classifySourceHealth({
    runStatus,
    unexpectedZeroResults: overrides.unexpectedZeroResults ?? false,
    attributableToSource: overrides.attributableToSource ?? true,
    yieldDrift: overrides.yieldDrift ?? null,
  });
}

const COLLAPSED: YieldDriftVerdict = {
  drifted: true,
  reason: 'extraction yield collapsed: 1 of 1 listed records parsed, against a recent baseline of 18',
  baselineParsed: 18,
};

describe('classifySourceHealth', () => {
  it('names its policy version', () => {
    expect(SOURCE_HEALTH_POLICY_VERSION).toBe('FR-020_SOURCE_HEALTH_V2');
  });

  it('marks a clean run healthy and counts it as the last success', () => {
    expect(classify(SourceRunStatus.SUCCEEDED)).toEqual({
      status: HealthStatus.HEALTHY,
      countsAsSuccess: true,
      reason: 'the most recent collection completed successfully',
    });
  });

  it('marks a failed run failing, dated as an error rather than a success', () => {
    expect(classify(SourceRunStatus.FAILED)).toMatchObject({
      status: HealthStatus.FAILING,
      countsAsSuccess: false,
    });
  });

  it('degrades a partial run without counting it as a success', () => {
    // A partial run is not a success: if it counted, `lastSuccessfulRunAt` could no longer
    // answer "when did this source last work".
    expect(classify(SourceRunStatus.PARTIAL)).toMatchObject({
      status: HealthStatus.DEGRADED,
      countsAsSuccess: false,
    });
  });

  it('names the AC-018 anomaly when a zero-result run degradates a source', () => {
    expect(classify(SourceRunStatus.PARTIAL, { unexpectedZeroResults: true })?.reason).toContain(
      'zero results',
    );
    expect(classify(SourceRunStatus.PARTIAL)?.reason).not.toContain('zero results');
  });

  it('degrades a clean run whose yield collapsed, without calling it an error', () => {
    // SRS 7.8: the run worked, the source stopped delivering. `HEALTHY` here is the silence
    // the audit found; `lastErrorAt` would be a claim that something errored.
    const verdict = classify(SourceRunStatus.SUCCEEDED, { yieldDrift: COLLAPSED });
    expect(verdict).toEqual({
      status: HealthStatus.DEGRADED,
      countsAsSuccess: true,
      reason: COLLAPSED.reason,
    });
  });

  it('leaves a clean run healthy when the yield comparison found no drift', () => {
    expect(
      classify(SourceRunStatus.SUCCEEDED, {
        yieldDrift: { drifted: false, reason: null, baselineParsed: 18 },
      }),
    ).toMatchObject({ status: HealthStatus.HEALTHY });
  });

  it('does not let a yield collapse disguise a worse run status', () => {
    // Drift is evidence about a *completed* run. A failed run is FAILING whatever its yield.
    expect(classify(SourceRunStatus.FAILED, { yieldDrift: COLLAPSED })).toMatchObject({
      status: HealthStatus.FAILING,
    });
    expect(classify(SourceRunStatus.PARTIAL, { yieldDrift: COLLAPSED })).toMatchObject({
      status: HealthStatus.DEGRADED,
      countsAsSuccess: false,
    });
  });

  it('concludes nothing from a run that is still in flight', () => {
    expect(classify(SourceRunStatus.RUNNING)).toBeNull();
  });

  it('records nothing for an outcome that was not the source doing', () => {
    // A worker shutdown is not evidence about the source, whatever status the run ended in:
    // blaming the source would make a healthy source look degraded on every restart.
    for (const status of Object.values(SourceRunStatus)) {
      expect(classify(status, { attributableToSource: false })).toBeNull();
    }
  });

  it('classifies every terminal status and never disguises an unknown one as healthy', () => {
    for (const status of Object.values(SourceRunStatus)) {
      const verdict = classify(status);
      if (status === SourceRunStatus.RUNNING) {
        expect(verdict).toBeNull();
        continue;
      }
      expect(verdict).not.toBeNull();
      expect(verdict?.countsAsSuccess).toBe(status === SourceRunStatus.SUCCEEDED);
    }
  });
});
