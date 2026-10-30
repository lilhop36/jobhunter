import { isIPv4 } from 'node:net';
import { assertSecretUsable, CredentialConfigError } from '@application/auth/credentials';

/**
 * API configuration (SRS 3.4; ENG-017).
 *
 * Parsed once at process start and rejected as a whole if it is wrong, mirroring the
 * worker's composition root: a process that has already bound a port is harder to notice
 * than one that refuses to start.
 */
export interface ApiConfig {
  databaseUrl: string;
  /**
   * Interface to bind. Defaults to 127.0.0.1. A non-loopback host is refused unless the
   * operator names it twice — once to allow the bind, once as the hostname browsers will
   * present in `Host` — because an interface open to a network turns every unauthenticated
   * route into a published one (SRS 8.1; ADR-0011).
   */
  host: string;
  port: number;
  /**
   * The bot's public username (`TELEGRAM_BOT_USERNAME`), the one credential-dependent input
   * of `POST /api/telegram/link`'s deep link. Optional: the link route reports its absence
   * when it is hit instead of the process refusing to start (SRS 8.3 keeps the bot token
   * itself away from the API process entirely — only the worker sends).
   */
  telegramBotUsername?: string;
  /**
   * Signs login codes and bearer credentials (SRS 8.1, 8.3). Required: the API cannot tell a
   * forged `userId` from a proven one without it, so a deployment that cannot prove identity
   * refuses to start rather than answers anonymously. Never logged, never echoed in an error.
   */
  authSecret: string;
  /** True when `host` is a loopback address, which is what makes `Host` checking automatic. */
  loopback: boolean;
  /**
   * Hostnames this deployment answers for, without ports. On loopback this is the fixed
   * loopback set; off loopback it comes from `API_ALLOWED_HOSTS` and is mandatory, because
   * `Host` is the only thing standing between this API and a DNS-rebinding page that can read
   * the operator's own candidate data back out of it.
   */
  allowedHosts: string[];
}

/** Raised for configuration that would make the API unsafe or unstartable. */
export class ApiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiConfigError';
  }
}

/** The hostnames a loopback-bound API may be addressed by, whatever `API_HOST` names it. */
export const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'] as const;

function requiredString(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ApiConfigError(`${name} is required`);
  return value;
}

function optionalString(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name]?.trim();
  return value ? value : fallback;
}

function optionalPort(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new ApiConfigError(`${name} must be an integer between 1 and 65535; received "${raw}"`);
  }
  return value;
}

/**
 * A hostname in the one form this deployment compares: lower-case, no surrounding brackets.
 *
 * `URL` keeps the brackets of an IPv6 literal (`[::1]`), while `API_ALLOWED_HOSTS` and the loopback
 * list are written without them, so comparing the two raw would refuse the operator's own machine.
 */
export function normalizeHostname(value: string): string {
  return value.trim().replace(/^\[|\]$/g, '').toLowerCase();
}

/**
 * Is this bind address loopback-only?
 *
 * All of `127.0.0.0/8`, not just `127.0.0.1`: `127.2.3.4` is as local as `127.0.0.1`, and a check
 * on the literal string would classify it as a network bind and refuse a perfectly safe default.
 * `0.0.0.0` and `::` bind every interface and so are deliberately not loopback.
 */
export function isLoopbackHost(host: string): boolean {
  const value = normalizeHostname(host);
  if (value === 'localhost' || value === '::1' || value === '0:0:0:0:0:0:0:1') return true;
  if (isIPv4(value)) return value.split('.')[0] === '127';
  return false;
}

/** `API_ALLOWED_HOSTS="a.example, [::1]"` → `['a.example', '::1']`. */
function parseAllowedHosts(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map(normalizeHostname)
    .filter((entry) => entry !== '');
}

/** Build the API configuration from the environment, or throw `ApiConfigError`. */
export function parseApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const host = optionalString(env, 'API_HOST', '127.0.0.1');
  const loopback = isLoopbackHost(host);
  const extraHosts = parseAllowedHosts(env['API_ALLOWED_HOSTS']);

  if (!loopback && env['API_ALLOW_EXTERNAL_BIND']?.trim().toLowerCase() !== 'true') {
    throw new ApiConfigError(
      `API_HOST "${host}" is not a loopback address. JobHunter is a single-operator tool that ` +
        'stores a real candidate profile, so binding it to a network interface is a decision of ' +
        'its own: set API_ALLOW_EXTERNAL_BIND=true and name the hostnames in API_ALLOWED_HOSTS.',
    );
  }
  if (!loopback && extraHosts.length === 0) {
    throw new ApiConfigError(
      'API_ALLOWED_HOSTS is required when the API is bound off loopback: without it no Host ' +
        'header can be validated, and a rebound domain would be served as if it were local',
    );
  }

  let authSecret: string;
  try {
    authSecret = requiredString(env, 'AUTH_SECRET');
    assertSecretUsable(authSecret);
  } catch (error) {
    // The two messages a secret can fail on are both configuration, and neither may quote the
    // value: `AUTH_SECRET` is a credential (SRS 8.3), and a config error is the one thing an
    // operator pastes into a bug report (SRS 8.5).
    if (error instanceof CredentialConfigError) throw new ApiConfigError(error.message);
    throw error;
  }

  return {
    databaseUrl: requiredString(env, 'DATABASE_URL'),
    host,
    port: optionalPort(env, 'API_PORT', 3001),
    telegramBotUsername: (() => {
      const value = env['TELEGRAM_BOT_USERNAME']?.trim();
      return value === undefined || value === '' ? undefined : value;
    })(),
    // Deliberately the trimmed value: a trailing space in `.env` would otherwise sign with a
    // different key than the minting script, and every credential would read as forged.
    authSecret: authSecret.trim(),
    loopback,
    allowedHosts: loopback ? [...LOOPBACK_HOSTS] : extraHosts,
  };
}
