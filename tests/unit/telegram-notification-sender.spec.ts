import { describe, expect, it } from 'vitest';
import { TelegramNotificationSender } from '../../src/infrastructure/notification/telegram-notification-sender';

/**
 * Channel-specific behaviour, tested against a stubbed fetch rather than Telegram itself: the
 * contract being pinned is the sender's classification of what Telegram answers with (SRS 3.2
 * "Rate limits"), which the unit spec can express exactly.
 */

interface RecordedCall {
  url: string;
  init?: RequestInit;
  bodyText: string | undefined;
}

function senderOver(
  destinationByUser: Map<string, string | null>,
  respond: (call: RecordedCall) => Response | never | Promise<Response | never>,
) {
  const calls: RecordedCall[] = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const call: RecordedCall = {
      url: String(input),
      init,
      bodyText: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  const sender = new TelegramNotificationSender({
    token: 'FAKE-TOKEN',
    destinations: {
      forUser: async (userId) => destinationByUser.get(userId) ?? null,
    },
    fetchFn,
    baseUrl: 'https://telegram.example',
  });
  return { sender, calls };
}

const MESSAGE = {
  notificationId: 'n-1',
  userId: 'u-1',
  text: 'Software Engineer — 45/100, confidence 47%…',
  jobId: 'j-1',
} as const;

const OK = new Response('{"ok":true,"result":{"message_id":1}}', { status: 200 });

describe('TelegramNotificationSender', () => {
  it('sends the rendered text to the chat the user linked, over the bot endpoint', async () => {
    const { sender, calls } = senderOver(new Map([['u-1', '483920']]), () => OK);

    const outcome = await sender.send(MESSAGE);

    expect(outcome).toEqual({ delivered: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://telegram.example/botFAKE-TOKEN/sendMessage');
    expect(JSON.parse(calls[0].bodyText!, (key, value) => (key === 'text' ? MESSAGE.text : value))).toEqual({
      chat_id: '483920',
      text: MESSAGE.text,
    });
  });

  it('treats a user with no linked destination as permanent, and asks Telegram nothing', async () => {
    const { sender, calls } = senderOver(new Map(), () => OK);

    const outcome = await sender.send(MESSAGE);

    expect(outcome.delivered).toBe(false);
    expect('retryable' in outcome && outcome.retryable).toBe(false);
    expect('reason' in outcome && outcome.reason).toContain('no linked Telegram destination');
    expect(calls).toHaveLength(0);
  });

  it('follows the 429 hint: transient, with the wait Telegram reports', async () => {
    const { sender } = senderOver(new Map([['u-1', '483920']]), () =>
      new Response('{"ok":false,"error_code":429,"description":"Too Many Requests","parameters":{"retry_after":7}}', {
        status: 429,
      }),
    );

    const outcome = await sender.send(MESSAGE);

    expect(outcome).toEqual({
      delivered: false,
      retryable: true,
      reason: 'telegram sendMessage failed with HTTP 429',
      retryAfterSeconds: 7,
    });
  });

  it('falls back to the standard Retry-After header when the body has no hint', async () => {
    const { sender } = senderOver(new Map([['u-1', '483920']]), () =>
      new Response('{}', { status: 429, headers: { 'retry-after': '3' } }),
    );

    const outcome = await sender.send(MESSAGE);

    expect('retryAfterSeconds' in outcome && outcome.retryAfterSeconds).toBe(3);
  });

  it('treats a non-429 4xx (chat not found, blocked bot) as permanent', async () => {
    const { sender } = senderOver(new Map([['u-1', '483920']]), () =>
      new Response('{"ok":false,"error_code":400,"description":"chat not found"}', { status: 400 }),
    );

    const outcome = await sender.send(MESSAGE);

    expect(outcome).toEqual({
      delivered: false,
      retryable: false,
      reason: 'telegram sendMessage failed with HTTP 400',
      retryAfterSeconds: null,
    });
  });

  it('treats a 5xx as transient', async () => {
    const { sender } = senderOver(new Map([['u-1', '483920']]), () =>
      new Response('{"ok":false}', { status: 502 }),
    );

    const outcome = await sender.send(MESSAGE);

    expect(outcome).toEqual({
      delivered: false,
      retryable: true,
      reason: 'telegram sendMessage failed with HTTP 502', // a 5xx: transient
      retryAfterSeconds: null,
    });
  });

  it('treats a transport failure (timeout, connect) as transient', async () => {
    const { sender } = senderOver(new Map([['u-1', '483920']]), () => {
      throw new Error('network down');
    });

    const outcome = await sender.send(MESSAGE);

    expect(outcome.delivered).toBe(false);
    expect('retryable' in outcome && outcome.retryable).toBe(true);
  });

  it('never exposes the bot token in a reported reason', async () => {
    const { sender } = senderOver(new Map([['u-1', '483920']]), () =>
      new Response('{"ok":false,"error_code":403,"description":"Forbidden"}', { status: 403 }),
    );

    const outcome = await sender.send(MESSAGE);

    expect('reason' in outcome && outcome.reason).not.toContain('FAKE-TOKEN');
  });
});
