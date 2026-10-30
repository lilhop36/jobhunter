import type { PrismaClient } from '@prisma/client';
import { isLoopbackHost } from '../../apps/api/config';

/**
 * The parts the two credential CLIs (`npm run login`, `npm run token`) share: reading a flag,
 * naming the candidate a credential is for, and rendering the local URL the operator opens.
 *
 * Kept out of the scripts themselves because the *rules* are the interesting part — which user a
 * bare invocation means, and what the operator must do when that is ambiguous — and two commands
 * that drift on those rules would mint credentials for the wrong candidate.
 */

/** A mistake the operator can fix, reported as one line of usage rather than a stack trace. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** `--email candidate@example.com` or `--email=candidate@example.com`; `null` when absent. */
export function readFlag(args: string[], name: string): string | null {
  const prefixed = args.find((argument) => argument.startsWith(`--${name}=`));
  if (prefixed !== undefined) return prefixed.slice(name.length + 3);

  const index = args.indexOf(`--${name}`);
  if (index === -1) return null;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new UsageError(`--${name} needs a value`);
  }
  return value;
}

/** Anything that is not a recognised flag is a typo, and a silent typo is a wrong credential. */
export function rejectUnknownFlags(args: string[], allowed: string[]): void {
  for (const argument of args) {
    if (!argument.startsWith('--')) continue;
    const name = argument.slice(2).split('=')[0] ?? '';
    if (!allowed.includes(name)) {
      throw new UsageError(`unknown option --${name}; the options are ${allowed.map((o) => `--${o}`).join(', ')}`);
    }
  }
}

export interface UserLocator {
  readonly email: string | null;
  readonly user: string | null;
}

/**
 * The candidate a credential names.
 *
 * With no flag, a single-user deployment means that user; more than one is a question the operator
 * answers explicitly, because "the first row" is not a rule anyone would recognise from the output
 * and guessing wrong sends their alerts somewhere else.
 */
export async function findTargetUser(
  prisma: PrismaClient,
  locator: UserLocator,
): Promise<{ id: string; email: string }> {
  if (locator.email !== null && locator.user !== null) {
    throw new UsageError('use either --email or --user, not both');
  }

  if (locator.email !== null) {
    const found = await prisma.user.findUnique({
      where: { email: locator.email },
      select: { id: true, email: true },
    });
    if (found === null) throw new UsageError(`no user has the email "${locator.email}"`);
    return found;
  }

  if (locator.user !== null) {
    const found = await prisma.user.findUnique({
      where: { id: locator.user },
      select: { id: true, email: true },
    });
    if (found === null) throw new UsageError(`no user has the id "${locator.user}"`);
    return found;
  }

  const users = await prisma.user.findMany({ select: { id: true, email: true }, orderBy: { email: 'asc' } });
  const [only] = users;
  if (users.length === 1 && only !== undefined) return only;
  if (users.length === 0) {
    throw new UsageError('no users exist; seed a candidate with `npm run seed:candidate`');
  }

  const listing = users.map((user) => `  ${user.email}  (${user.id})`).join('\n');
  throw new UsageError(
    `${users.length} users exist, so name one with --email or --user:\n${listing}`,
  );
}

/**
 * The address the operator's browser is told to use: `API_HOST`/`API_PORT`, exactly as the API
 * reads them.
 *
 * A non-loopback host is reported as it is: the pages are served over plain HTTP, so a printed
 * link to a public address is a credential travelling in clear text.
 */
export function baseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): { url: string; loopback: boolean } {
  const host = env['API_HOST']?.trim() || '127.0.0.1';
  const port = env['API_PORT']?.trim() || '3001';
  // The bare host answers the loopback question; brackets are only what a URL needs for IPv6.
  const loopback = isLoopbackHost(host);
  const inUrl = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return { url: `http://${inUrl}:${port}`, loopback };
}
