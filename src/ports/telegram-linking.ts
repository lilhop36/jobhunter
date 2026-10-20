/**
 * Ports for the Telegram link (SRS 3.2 "Linking", 3.4 `POST /api/telegram/link`) and the
 * destination the sender delivers to (SRS 2.2/2.4; FR-017).
 *
 * Linking is split from sending on purpose: the token's lifetime is seconds-to-minutes while
 * the destination is forever (until relinked), and the two surfaces are driven by different
 * processes (the API issues; the operator-run resolver consumes; the worker's dispatcher
 * reads).
 */

import type { TelegramLinkToken, TelegramDestination } from '@prisma/client';

/** A token row as a port consumer sees it. The plaintext token is never stored. */
export type TelegramLinkTokenRecord = Pick<TelegramLinkToken, 'id' | 'userId' | 'tokenHash' | 'createdAt' | 'expiresAt' | 'usedAt'>;

/**
 * Store for the deep-link tokens the resolver will consume.
 *
 * `issue` stores only the SHA-256 of the token (SRS 3.2 "secure"); `takePending` is the
 * one-time consumption: it atomically flips an unexpired, unused row to used and answers with
 * the user, or null when the token is unknown/expired/already used. Hash-not-Token is why the
 * consumers only ever see hashes too.
 */
export interface TelegramLinkTokenStore {
  issue(input: { userId: string; tokenHash: string; expiresAt: Date }): Promise<void>;
  /**
   * Consume-and-return: UPDATE … WHERE used AND unexpired … RETURNING in one statement, so the
   * same token cannot satisfy two lookups no matter how the resolver crashed in between.
   */
  takePending(input: { tokenHash: string; now: Date }): Promise<Pick<TelegramLinkTokenRecord, 'userId'> | null>;
}

export interface TelegramDestinationStore {
  /** Idempotent relink: the user's single destination is replaced, never duplicated. */
  setDestination(input: { userId: string; chatId: string; linkedAt: Date }): Promise<'linked' | 'relinked'>;
}

/** As the sender sees the destination: one lookup keyed by the outbox row's user. */
export interface TelegramDestinationReader {
  /**
   * The chat id, or null when the user has never completed the deep link. Delivery treats null
   * as a permanent failure: notifications are not sent, and the underlying match is untouched
   * (SRS 3.2 "Rate limits"). Relinking later applies to new notifications only.
   */
  forUser(userId: string): Promise<string | null>;
}

/** The destination row as a port consumer sees it. */
export type TelegramDestinationRecord = Pick<TelegramDestination, 'userId' | 'chatId' | 'linkedAt'>;
