import { HealthStatus, SourceRunStatus } from '@domain/enums';
import {
  SOURCE_HEALTH_POLICY_VERSION,
  classifySourceHealth,
} from '@domain/health/source-health-policy';

function classify(
  runStatus: SourceRunStatus,
  overrides: { unexpectedZeroResults?: boolean; attributableToSource?: boolean } = {},
) {
  return classifySourceHealth({
    runStatus,
    unexpectedZeroResults: overrides.unexpectedZeroResults ?? false,
    attributableToSource: overrides.attributableToSource ?? true,
  });
}

describe('classifySourceHealth', () => {
  it('names its policy version', () => {
    expect(SOURCE_HEALTH_POLICY_VERSION).toBe('FR-020_SOURCE_HEALTH_V1');
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
