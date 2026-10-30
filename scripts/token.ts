import { PrismaClient } from '@prisma/client';
import {
  API_CREDENTIAL_DEFAULT_TTL_MS,
  API_CREDENTIAL_MAX_TTL_MS,
  mintApiCredential,
} from '@application/auth/credentials';
import { baseUrlFromEnv, findTargetUser, readFlag, rejectUnknownFlags, UsageError } from './lib/credential-cli';

/**
 * Operator-run: mint a bearer credential for the JSON API (SRS 8.1; ADR-0011 §4).
 *
 *   npm run token -- --email candidate@example.com        # the only candidate: the flag is optional
 *   npm run token -- --user <uuid> --ttl-days 7
 *
 * The output is a secret, and unlike a login code it is *reusable* until it expires — that is the
 * trade for scripting against `/api/*` without a browser session. Copy it into the caller's own
 * secret store; do not paste it into a shell history you intend to share, and do not commit it.
 * Rotating `AUTH_SECRET` invalidates every credential this command ever minted at once, which is
 * the revocation path v1 has.
 */

const USAGE = [
  'usage: npm run token -- [--email <address> | --user <uuid>] [--ttl-days <n>]',
  `  the lifetime defaults to ${Math.round(API_CREDENTIAL_DEFAULT_TTL_MS / 86_400_000)} days ` +
    `and may not exceed ${Math.round(API_CREDENTIAL_MAX_TTL_MS / 86_400_000)}`,
].join('\n');

/** `--ttl-days 7`; the ceiling is the primitive's, so a typo here cannot mint a decade. */
function ttlFrom(args: string[]): number | undefined {
  const raw = readFlag(args, 'ttl-days');
  if (raw === null) return undefined;
  const days = Number(raw);
  if (!Number.isInteger(days) || days <= 0) {
    throw new UsageError(`--ttl-days must be a positive whole number of days, got "${raw}"`);
  }
  return days * 86_400_000;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  rejectUnknownFlags(args, ['email', 'user', 'ttl-days', 'help']);

  const secret = process.env['AUTH_SECRET'] ?? '';
  const ttlMs = ttlFrom(args);
  const { url } = baseUrlFromEnv();
  const prisma = new PrismaClient();

  try {
    const user = await findTargetUser(prisma, {
      email: readFlag(args, 'email'),
      user: readFlag(args, 'user'),
    });

    const credential = mintApiCredential(secret, user.id, ttlMs === undefined ? {} : { ttlMs });
    const expiresAt = new Date(Date.now() + (ttlMs ?? API_CREDENTIAL_DEFAULT_TTL_MS)).toISOString();

    process.stdout.write(
      `bearer credential for ${user.email}, valid until ${expiresAt}\n\n${credential}\n\n` +
        `use it as:\n  curl -H "Authorization: Bearer ${credential}" ${url}/api/matches\n\n` +
        'this value is a secret: it acts as this candidate for every /api/* route until it expires.\n',
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n\n${USAGE}\n`);
  } else {
    process.stderr.write(`token failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
});
