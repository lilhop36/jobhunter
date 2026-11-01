import { describe, expect, it } from 'vitest';
import { parseWorkerConfig } from '../../apps/worker/config';

/**
 * The token's absence semantics are the no-dispatch guarantee: empty means absent, and the
 * composition tree must agree with config the way the runtime branch checks it.
 */
const BASE = {
  DATABASE_URL: 'postgresql://user:secret@localhost:6543/db',
  SOURCE_STALE_RUN_SECONDS: '900',
  SOURCE_ACQUISITION_TIMEOUT_MS: '300000',
} as const;

describe('parseWorkerConfig · run liveness (audit M2)', () => {
  it('leaves the heartbeat to the use case when unset', () => {
    expect(parseWorkerConfig(BASE).sourceRunHeartbeatMs).toBeUndefined();
  });

  it('passes through an interval that reports inside the stale window', () => {
    const config = parseWorkerConfig({ ...BASE, SOURCE_RUN_HEARTBEAT_MS: '15000' });
    expect(config.sourceRunHeartbeatMs).toBe(15_000);
  });

  it('refuses an interval that the stale window would outlive', () => {
    // The window is a bound on silence. A beat that cannot land inside it is not a tuning choice,
    // it is the reaper reclaiming a run that is still working - so the worker refuses to start
    // rather than running for days with a heartbeat that proves nothing.
    expect(() => parseWorkerConfig({ ...BASE, SOURCE_RUN_HEARTBEAT_MS: '900000' })).toThrow(
      /SOURCE_RUN_HEARTBEAT_MS/,
    );
    expect(() => parseWorkerConfig({ ...BASE, SOURCE_RUN_HEARTBEAT_MS: '900000' })).toThrow(
      /stale window/,
    );
    // And at the real deployed pair: a 30-second window cannot be proved against a
    // minute-between-beats, however sensible each number looks on its own.
    expect(() =>
      parseWorkerConfig({
        ...BASE,
        SOURCE_STALE_RUN_SECONDS: '30',
        SOURCE_ACQUISITION_TIMEOUT_MS: '1000',
        SOURCE_RUN_HEARTBEAT_MS: '60000',
      }),
    ).toThrow(/SOURCE_RUN_HEARTBEAT_MS/);
  });

  it('refuses a non-positive interval like every other bound', () => {
    expect(() => parseWorkerConfig({ ...BASE, SOURCE_RUN_HEARTBEAT_MS: '0' })).toThrow();
    expect(() => parseWorkerConfig({ ...BASE, SOURCE_RUN_HEARTBEAT_MS: 'soon' })).toThrow();
  });
});

describe('parseWorkerConfig · telegram delivery configuration', () => {
  it('treats an empty TELEGRAM_BOT_TOKEN as absent, so nothing dispatches', () => {
    const config = parseWorkerConfig({ ...BASE, TELEGRAM_BOT_TOKEN: '   ' });
    expect(config.telegramBotToken).toBeUndefined();
  });

  it('passes a set token through untouched for the sender', () => {
    const config = parseWorkerConfig({ ...BASE, TELEGRAM_BOT_TOKEN: 'n0t-a-real-token' });
    expect(config.telegramBotToken).toBe('n0t-a-real-token');
  });

  it('leaves the dispatch cadence at the runtime default when unset', () => {
    const config = parseWorkerConfig(BASE);
    expect(config.notificationDispatchIntervalMs).toBeUndefined();
  });

  it('refuses a non-positive dispatch cadence like every other bound', () => {
    expect(() => parseWorkerConfig({ ...BASE, NOTIFICATION_DISPATCH_INTERVAL_MS: '0' })).toThrow();
  });
});
