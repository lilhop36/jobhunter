import { PrismaClient } from '@prisma/client';
import { ResolveTelegramDeepLink } from '../src/application/telegram';
import { PrismaTelegramLinkRepository } from '../src/infrastructure/matching/prisma-telegram-link-repository';

/**
 * Operator-run: turns the deep-link tokens that `POST /api/telegram/link` issued into linked
 * destinations, by polling Telegram's own `getUpdates` for the user's Start press (SRS 3.2).
 *
 *   npm run telegram:resolve                # listens for 120 seconds
 *   npm run telegram:resolve -- --wait=300  # listens longer (cap 600)
 *
 * Usage: issue a link token, hand the deep link to the user (or open it yourself), run this
 * while the user presses Start in the bot. Every pending token the bot observes resolves once;
 * anything that is not a Deep Link start press is skipped. Nothing here can print a secret:
 * the bot token stays in the environment, tokens resolve by hash, and outcomes name only a
 * user id and a chat id (SRS 8.5).
 *
 * This is deliberately an operator command, not a bot process: the v1 loop needs exactly one
 * message resolved, and a standing long-poll bot is surface ADR-0008 does not claim. When a
 * real bot receiver exists, this script retires.
 */

const TELEGRAM_BASE = 'https://api.telegram.org';
/** Each getUpdates request long-polls this long before returning "nothing new". */
const POLL_SECONDS = 25;
/** One `/start <token>` message; the token is the tail of the deep link. */
const START_PATTERN = /^\/start(?:\s+([A-Za-z0-9_-]{24,}))?$/;

const botToken = process.env['TELEGRAM_BOT_TOKEN']?.trim();
if (!botToken) {
  console.error('TELEGRAM_BOT_TOKEN is required (the worker uses the same credential)');
  process.exit(1);
}

const waitSeconds = Math.min(
  (() => {
    const raw = process.argv.find((argument) => argument.startsWith('--wait='));
    const parsed = raw === undefined ? 120 : Number(raw.split('=')[1]);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 120;
  })(),
  600,
);

interface TelegramUpdate {
  update_id: number;
  message?: { text?: string; chat?: { id?: number | string } };
}

const prisma = new PrismaClient();
const repo = new PrismaTelegramLinkRepository(prisma);
const resolveLink = new ResolveTelegramDeepLink({ tokens: repo, destinations: repo });

/** Confirm consumption by moving the offset past it: Telegram hides confirmed updates. */
async function fetchUpdates(horizontalOffset: number): Promise<TelegramUpdate[]> {
  const params = new URLSearchParams({
    timeout: String(POLL_SECONDS),
    offset: String(horizontalOffset),
    allowed_updates: '["message"]',
  });
  const response = await fetch(`${TELEGRAM_BASE}/bot${botToken}/getUpdates?${params.toString()}`, {
    signal: AbortSignal.timeout((POLL_SECONDS + 10) * 1000),
  });
  if (!response.ok) throw new Error(`getUpdates failed with HTTP ${response.status}`);
  const body = (await response.json()) as { result?: TelegramUpdate[] };
  return Array.isArray(body.result) ? body.result : [];
}

async function handleUpdates(updates: TelegramUpdate[]): Promise<number> {
  let highest = -1;
  for (const update of updates) {
    highest = Math.max(highest, update.update_id + 1);
    const chatId = update.message?.chat?.id;
    if (chatId === undefined) continue;

    const token = START_PATTERN.exec(update.message?.text ?? '')?.[1];
    if (token === undefined) {
      console.log(`chat ${chatId}: /start without a token — open the deep link instead`);
      continue;
    }
    const outcome = await resolveLink.run({ token, chatId: String(chatId), now: new Date() });
    console.log(
      outcome === 'invalid'
        ? `chat ${chatId}: token invalid (expired, already used, or never issued)`
        : `chat ${chatId}: candidate linked (${outcome})`,
    );
  }
  return highest;
}

async function main(): Promise<void> {
  const deadline = Date.now() + waitSeconds * 1000;
  let offset = 0;
  try {
    while (Date.now() < deadline) {
      try {
        const highest = await handleUpdates(await fetchUpdates(offset));
        if (highest > offset) offset = highest;
      } catch (error) {
        // A transient getUpdates failure neither aborts the wait nor resolves anything; the
        // deadline is the bound, so the wait cannot run away.
        console.error(error instanceof Error ? error.message : String(error));
      }
      await new Promise((resume) => setTimeout(resume, 2000));
    }
    console.log('wait elapsed; run the command again to keep listening');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(`telegram resolve failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
