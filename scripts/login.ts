import { PrismaClient } from '@prisma/client';
import { LOGIN_CODE_TTL_MS, mintLoginCode } from '@application/auth/credentials';
import { baseUrlFromEnv, findTargetUser, readFlag, rejectUnknownFlags, UsageError } from './lib/credential-cli';

/**
 * Operator-run: print a one-time local sign-in link (SRS 8.1; ADR-0011 §3).
 *
 *   npm run login                                    # the only candidate on this deployment
 *   npm run login -- --email candidate@example.com   # one of several
 *   npm run login -- --user <uuid>
 *
 * The link opens a browser session for exactly the candidate its signature names, and it is worth
 * one click: the code is valid for 60 seconds and the API refuses it a second time. That is what
 * lets a *local* command stand in for a password — nothing secret is typed into a browser, nothing
 * is stored in the database, and the only thing an onlooker can copy is a code that is already used.
 *
 * `AUTH_SECRET` is read from the environment, like the API reads it (SRS 8.3); the secret itself is
 * never printed, and neither is anything about the candidate beyond the email they seeded.
 */

const USAGE = [
  'usage: npm run login -- [--email <address> | --user <uuid>]',
  '  the credential minted is valid for 60 seconds and opens exactly one session',
].join('\n');

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  rejectUnknownFlags(args, ['email', 'user', 'help']);

  const secret = process.env['AUTH_SECRET'] ?? '';
  const { url, loopback } = baseUrlFromEnv();
  const prisma = new PrismaClient();

  try {
    const user = await findTargetUser(prisma, {
      email: readFlag(args, 'email'),
      user: readFlag(args, 'user'),
    });

    // Minted last: everything that can be wrong (flags, environment, which user) has already
    // failed, so a half-printed run never leaves an unused code sitting in a scrollback.
    const code = mintLoginCode(secret, user.id);
    const seconds = Math.round(LOGIN_CODE_TTL_MS / 1000);

    process.stdout.write(`sign in as ${user.email}\n\n${url}/login?code=${code}\n\n`);
    process.stdout.write(`this link works once and expires in ${seconds} seconds\n`);
    if (!loopback) {
      process.stdout.write(
        `\nwarning: API_HOST is not a loopback address, so the code crosses the network in a URL. ` +
          'Serve the API over TLS before relying on this.\n',
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n\n${USAGE}\n`);
  } else {
    process.stderr.write(`login failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
});
