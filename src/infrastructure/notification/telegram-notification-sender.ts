import type { NotificationMessage, NotificationSender, SendOutcome } from '@ports/notification-sender';
import type { TelegramDestinationReader } from '@ports/telegram-linking';

/**
 * The Telegram channel (SRS 3.2 "Content"/"Rate limits"; FR-017; ADR-0008; Milestone 11.3).
 *
 * One message per outbox row, addressed with the chat the user confirmed by deep link. The
 * bot token is configured per deployment, read once at the composition root; the sender never
 * logs it and never returns it in an error reason (SRS 8.3/8.5).
 *
 * Failure classification is the channel's own judgement (the port is explicit about this):
 * a `429` is transient and carries Telegram's own wait, any other 4xx is permanent (an
 * unlinked or blocked chat does not heal), and transport failures — timeouts, 5xx, dropped
 * connections — are transient. The underlying match is never touched by any of this.
 *
 * Plain text only, no `parse_mode`: the text is rendered from untrusted listing evidence, and
 * anything but no-formatting makes Telegram's own parsers a second, silent attack surface.
 */

/** SendMessage bound so a wedged Telegram cannot hold the dispatcher's pass. */
const DEFAULT_SEND_TIMEOUT_MS = 10_000;

export interface TelegramNotificationSenderDeps {
  /** The bot credential from the operator's secret store. Never logged, never echoed. */
  token: string;
  destinations: TelegramDestinationReader;
  /**
   * HTTP fetch. Defaults to the global; tests inject one stubbed per scenario, so no
   * channel-specific behaviour is tested against the real Telegram (SRS 9.2 discourages it).
   */
  fetchFn?: typeof fetch;
  baseUrl?: string;
  sendTimeoutMs?: number;
}

export class TelegramNotificationSender implements NotificationSender {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly sendTimeoutMs: number;

  constructor(private readonly deps: TelegramNotificationSenderDeps) {
    this.baseUrl = deps.baseUrl ?? 'https://api.telegram.org';
    this.fetchFn = deps.fetchFn ?? globalThis.fetch;
    this.sendTimeoutMs = deps.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
  }

  async send(message: NotificationMessage): Promise<SendOutcome> {
    const chatId = await this.deps.destinations.forUser(message.userId);
    if (chatId === null) {
      return {
        delivered: false,
        retryable: false,
        reason: 'the candidate has no linked Telegram destination',
      };
    }

    let response: Response;
    try {
      response = await this.fetchFn(
        `${this.baseUrl}/bot${this.deps.token}/sendMessage`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            // chat_id as a decimal string: matches the stored destination format exactly and
            // sidesteps any numeric-encoding ambiguity on Telegram's side.
            chat_id: chatId,
            text: message.text,
          }),
          signal: AbortSignal.timeout(this.sendTimeoutMs),
        },
      );
    } catch {
      // Timeout, abort, DNS, connect: transport, not decision — the row is kept PENDING and
      // rescheduled by the dispatcher with the policy's backoff.
      return { delivered: false, retryable: true, reason: 'telegram sendMessage request failed to transport' };
    }

    if (response.ok) return { delivered: true };

    const retryAfterSeconds = await telegramRetryAfter(response);
    return {
      delivered: false,
      // 429 is the rate limit; any 5xx is Telegram-side and time heals both. The remaining
      // 4xxes are the request itself (unknown chat, blocked bot, malformed payload), which
      // does not heal by waiting.
      retryable: response.status === 429 || response.status >= 500,
      reason: `telegram sendMessage failed with HTTP ${response.status}`,
      retryAfterSeconds,
    };
  }
}

/**
 * Telegram returned an error; if it told us how long to wait, keep it. `parameters.retry_after`
 * in the body is Telegram's channel-specific hint (429 and flood-control 400s); the standard
 * header is the fallback.
 */
async function telegramRetryAfter(response: Response): Promise<number | null> {
  try {
    const body = (await response.json()) as { parameters?: { retry_after?: unknown } };
    const hinted = body.parameters?.retry_after;
    if (typeof hinted === 'number' && Number.isFinite(hinted) && hinted >= 0) {
      return Math.min(Math.round(hinted), 3600);
    }
  } catch {
    // Not JSON, or not the shape: fall through to the header.
  }
  // Missing header reads as null: turn it into NaN explicitly — `Number(null)` is 0, which
  // would otherwise masquerade as a legitimate "try again immediately, in 0 seconds" hint.
  const headerRaw = response.headers.get('retry-after');
  if (headerRaw === null) return null;
  const header = Number(headerRaw);
  return Number.isFinite(header) && header >= 0 ? Math.min(Math.round(header), 3600) : null;
}
