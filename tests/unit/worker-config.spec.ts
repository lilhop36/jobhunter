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
