import type { FastifyInstance } from 'fastify';
import { CreateTelegramLinkToken } from '@application/telegram';
import type { TelegramLinkTokenStore } from '@ports/telegram-linking';
import { principalOf } from '../auth';
import { ApiError, ERROR_CODES } from '../errors';

/**
 * `POST /api/telegram/link` (SRS 3.4, "Telegram link token"), for SRS 3.2's linking contract:
 * a secure, short-lived, one-time deep-link token that encodes no private profile data — the
 * plaintext token is returned to the caller here and stored nowhere, only its SHA-256 is.
 *
 * The token is consumed by Telegram itself: the user opens `t.me/<bot>?start=<token>`, presses
 * Start, and the operator-run resolver (`scripts/telegram-resolve.ts`) turns the `start`
 * payload the bot observes into the user's destination (ADR-0008). The route cannot resolve
 * its own token: a surface that accepted (token, chatId) pairs from anyone would let any
 * caller redirect a user's notifications.
 *
 * The token is minted for **the authenticated principal**, which takes the place of the `userId`
 * this route used to read out of its body (SRS 8.2; ADR-0011). That body was the clearest hole in
 * the old surface: a linking token names the account whose notifications are about to be
 * redirected, so a caller that could choose it could point another candidate's alerts at its own
 * chat. The route takes no identity from a request at all now.
 */
export interface TelegramLinkRoutesDeps {
  tokens: TelegramLinkTokenStore;
  /**
   * The bot's public username, from configuration — the only piece the API needs to render
   * the deep link. Absence is a deployment misconfiguration reported as it is hit, not boot
   * failure: an API that never issues links is thinner than one that refuses to start
   * without a credential it may never need.
   */
  botUsername?: string;
}

export async function registerTelegramLinkRoutes(
  app: FastifyInstance,
  deps: TelegramLinkRoutesDeps,
): Promise<void> {
  app.post('/api/telegram/link', async (request, reply) => {
    if (deps.botUsername === undefined) {
      throw new ApiError(
        ERROR_CODES.INTERNAL_ERROR,
        'Telegram linking is not configured on this deployment',
        500,
      );
    }

    const { userId } = principalOf(request);
    const created = await new CreateTelegramLinkToken({ tokens: deps.tokens }).run({
      userId,
      now: new Date(),
    });

    return reply.code(201).send({
      token: created.token,
      expiresAt: created.expiresAt.toISOString(),
      deepLink: `https://t.me/${deps.botUsername}?start=${encodeURIComponent(created.token)}`,
    });
  });
}
