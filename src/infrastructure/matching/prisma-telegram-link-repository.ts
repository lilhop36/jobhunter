import { PrismaClient, Prisma } from '@prisma/client';
import type {
  TelegramLinkTokenRecord,
  TelegramDestinationReader,
  TelegramDestinationStore,
  TelegramLinkTokenStore,
} from '@ports/telegram-linking';

/**
 * Prisma persistence for the Telegram deep-link tokens and destinations (SRS 3.2; ADR-0008).
 *
 * One repository for all three port views: issuing, consuming and reading share the concern
 * "who is linked to what, and which links are claimable", and the one non-trivial statement
 * (`takePending`) is a plain UPDATE on the same rows `issue` writes.
 */

const DESTINATION_SELECT = {
  userId: true,
  chatId: true,
  linkedAt: true,
} satisfies Prisma.TelegramDestinationSelect;

export class PrismaTelegramLinkRepository
  implements TelegramLinkTokenStore, TelegramDestinationStore, TelegramDestinationReader
{
  constructor(private readonly prisma: PrismaClient) {}

  async issue(input: { userId: string; tokenHash: string; expiresAt: Date }): Promise<void> {
    await this.prisma.telegramLinkToken.create({
      data: { userId: input.userId, tokenHash: input.tokenHash, expiresAt: input.expiresAt },
    });
  }

  async takePending(input: {
    tokenHash: string;
    now: Date;
  }): Promise<Pick<TelegramLinkTokenRecord, 'userId'> | null> {
    // One statement, not read-then-write: two operator runs resolving the same printed token
    // must not both succeed, and a crash between the claim and the marking otherwise leaves a
    // row claimable twice. `expiresAt` is evaluated here so "short-lived" is the database's
    // judgement, not the caller's remember-y one.
    const used = await this.prisma.$queryRaw<Array<{ userId: string }>>`
      UPDATE "telegram_link_tokens"
      SET "usedAt" = ${asTimestamp(input.now)}::timestamp(3)
      WHERE "tokenHash" = ${input.tokenHash}
        AND "usedAt" IS NULL
        AND "expiresAt" > ${asTimestamp(input.now)}::timestamp(3)
      RETURNING "userId"
    `;
    return used.length === 0 ? null : { userId: used[0].userId };
  }

  async setDestination(input: {
    userId: string;
    chatId: string;
    linkedAt: Date;
  }): Promise<'linked' | 'relinked'> {
    const existing = await this.prisma.telegramDestination.findUnique({
      where: { userId: input.userId },
      select: { userId: true },
    });
    await this.prisma.telegramDestination.upsert({
      where: { userId: input.userId },
      create: { userId: input.userId, chatId: input.chatId, linkedAt: input.linkedAt },
      update: { chatId: input.chatId, linkedAt: input.linkedAt },
      select: DESTINATION_SELECT,
    });
    // Answer honestly: the webhook-less first link is not "the first time" in SRS terms; the
    // linked/relinked verdict matters only to whoever is relinking on purpose.
    return existing === null ? 'linked' : 'relinked';
  }

  async forUser(userId: string): Promise<string | null> {
    const row = await this.prisma.telegramDestination.findUnique({
      where: { userId },
      select: DESTINATION_SELECT,
    });
    return row?.chatId ?? null;
  }
}

function asTimestamp(value: Date): string {
  return value.toISOString();
}
