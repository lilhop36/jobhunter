import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_RETRY_POLICY_V1,
  nextAttemptAt,
} from '@domain/notification';

/**
 * SRS 3.2 "Rate limits": a Telegram failure or a 429 is handled by outbox retry/backoff.
 *
 * The SRS fixes no numbers, so these cases pin the *shape* of the policy rather than its exact
 * ladder: bounded attempts, a growing wait, a channel hint that is honoured when it asks for
 * longer, and a hard terminal outcome so a permanently broken destination cannot retry forever.
 */

const NOW = new Date('2026-10-19T00:00:00.000Z');

function secondsFrom(now: Date, result: Date | null): number | null {
  return result === null ? null : (result.getTime() - now.getTime()) / 1000;
}

describe('nextAttemptAt', () => {
  it('schedules the first retry one minute out', () => {
    expect(secondsFrom(NOW, nextAttemptAt({ attemptCount: 1, now: NOW }))).toBe(60);
  });

  it('waits longer after every further attempt', () => {
    const waits = [1, 2, 3, 4].map((attemptCount) =>
      secondsFrom(NOW, nextAttemptAt({ attemptCount, now: NOW })),
    );

    expect(waits).toEqual([60, 300, 1800, 7200]);
    expect(waits).toEqual([...waits].sort((a, b) => (a ?? 0) - (b ?? 0)));
  });

  it('becomes terminal once the attempts are exhausted', () => {
    const { maxAttempts } = NOTIFICATION_RETRY_POLICY_V1;

    expect(nextAttemptAt({ attemptCount: maxAttempts - 1, now: NOW })).not.toBeNull();
    expect(nextAttemptAt({ attemptCount: maxAttempts, now: NOW })).toBeNull();
    expect(nextAttemptAt({ attemptCount: maxAttempts + 3, now: NOW })).toBeNull();
  });

  it('honours a longer channel hint, because waiting less only burns an attempt', () => {
    const result = nextAttemptAt({ attemptCount: 1, now: NOW, retryAfterSeconds: 900 });

    expect(secondsFrom(NOW, result)).toBe(900);
  });

  it('ignores a shorter channel hint rather than retrying sooner than the ladder allows', () => {
    const result = nextAttemptAt({ attemptCount: 3, now: NOW, retryAfterSeconds: 1 });

    expect(secondsFrom(NOW, result)).toBe(1800);
  });

  it('caps a hostile or absurd hint, so the channel cannot park a row indefinitely', () => {
    const result = nextAttemptAt({ attemptCount: 1, now: NOW, retryAfterSeconds: 86_400 * 365 });

    expect(secondsFrom(NOW, result)).toBe(NOTIFICATION_RETRY_POLICY_V1.maxRetryAfterSeconds);
  });

  it('treats a missing or negative hint as no hint', () => {
    expect(secondsFrom(NOW, nextAttemptAt({ attemptCount: 1, now: NOW, retryAfterSeconds: null }))).toBe(60);
    expect(secondsFrom(NOW, nextAttemptAt({ attemptCount: 1, now: NOW, retryAfterSeconds: -5 }))).toBe(60);
  });
});
