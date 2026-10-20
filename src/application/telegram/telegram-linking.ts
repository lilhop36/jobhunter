import { createHash, randomBytes } from 'node:crypto';
import type { TelegramDestinationStore, TelegramLinkTokenStore } from '@ports/telegram-linking';

/**
 * The two linking use cases (SRS 3.2 "Linking"; ADR-0008).
 *
 * - `CreateTelegramLinkToken` is the `POST /api/telegram/link` flow: issue a random one-time
 *   token, return it to the caller (the plaintext exists only in memory and the API response)
 *   and persist only its SHA-256, so the database cannot mint links (SRS 8.3). "Short-lived"
 *   is fixed at ten minutes here rather than configured: the window shrinks to nothing the
 *   moment the user opens the deep link, and a longer window buys exposure, not flexibility.
 *
 * - `ResolveTelegramDeepLink` is the token's one use: Telegram delivered the `start` payload
 *   back. Order matters — the token is claimed atomically *before* the destination is
 *   written, so once the user's own resolution ran, the link is dead (no replay/re-hijack
 *   window at all, SRS 3.2 "secure"). The cost is a crash between claim and link, which burns
 *   the token with no destination present: recovery is re-issuing, and the resolver runs the
 *   two statements milliseconds apart. Writing the destination after an expired-used claim is
 *   a bug, not a feature, so `invalid` short-circuits before any write.
 */

/** The token lives ten minutes: long enough to type/click, short enough to reduce exposure. */
export const TELEGRAM_LINK_TOKEN_TTL_SECONDS = 600;

export interface CreatedLinkToken {
  /** Random base64url one-time token. Returned once; afterwards only the hash exists. */
  token: string;
  expiresAt: Date;
}

export class CreateTelegramLinkToken {
  constructor(private readonly deps: { tokens: TelegramLinkTokenStore }) {}

  async run(input: { userId: string; now: Date }): Promise<CreatedLinkToken> {
    // 24 bytes ≈ 192 bits of entropy: no enumeration risk on a personal-system surface an
    // unauthenticated loopback caller could otherwise hit (SRS 3.4 specifies no auth).
    const token = randomBytes(24).toString('base64url');
    const expiresAt = new Date(input.now.getTime() + TELEGRAM_LINK_TOKEN_TTL_SECONDS * 1000);
    await this.deps.tokens.issue({ userId: input.userId, tokenHash: hashOf(token), expiresAt });
    return { token, expiresAt };
  }
}

export type ResolveOutcome = 'linked' | 'relinked' | 'invalid';

export class ResolveTelegramDeepLink {
  constructor(
    private readonly deps: { tokens: TelegramLinkTokenStore; destinations: TelegramDestinationStore },
  ) {}

  async run(input: { token: string; chatId: string; now: Date }): Promise<ResolveOutcome> {
    const claimed = await this.deps.tokens.takePending({ tokenHash: hashOf(input.token), now: input.now });
    if (claimed === null) return 'invalid';

    return this.deps.destinations.setDestination({
      userId: claimed.userId,
      chatId: input.chatId,
      linkedAt: input.now,
    });
  }
}

function hashOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
