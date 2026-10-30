import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Signed credentials (SRS 8.1, 8.3; ADR-0011).
 *
 * Two kinds share one primitive: a **login code** the operator opens once in the browser, and an
 * **API credential** a scripted caller presents in `Authorization`. Both are
 * `v1.<base64url(payload)>.<base64url(HMAC-SHA-256)>` — signed with `AUTH_SECRET`, never stored,
 * and verified by recomputing the signature. That keeps v1 free of a credentials table, a hashing
 * library and a token-issuance service, while still making a claim the API can check on its own.
 *
 * What the signature buys is *unforgeability*: only a process holding `AUTH_SECRET` can name a
 * `userId` and have the API believe it. What it does not buy is revocation — a bearer credential is
 * valid until its `exp`, and rotating `AUTH_SECRET` invalidates every one of them at once. That is
 * the documented trade for a single-operator, loopback tool (ADR-0011 §5).
 *
 * The two kinds are separated *inside* the payload, not merely by convention: a login code carries
 * `kind: "login"`, so replaying one as a bearer credential fails the kind check even though the
 * signature is perfect. Same secret, different purpose.
 */

/** The wire-format prefix, signed along with the payload so a future format cannot be misread. */
const FORMAT_PREFIX = 'v1';

/**
 * The minimum secret length. Shorter is refused rather than truncated: a five-character
 * `AUTH_SECRET` turns HMAC unforgeability into a brute-force exercise, and 32 bytes is the
 * SHA-256 block size it is being fed into anyway.
 */
export const MIN_SECRET_BYTES = 32;

/** A login code is openable once, for one minute (ADR-0011 §3). */
export const LOGIN_CODE_TTL_MS = 60_000;

/** A bearer credential is long-lived enough to script against, short enough to rotate. */
export const API_CREDENTIAL_DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The ceiling a caller cannot exceed, so a typo cannot mint a decade-long token. */
export const API_CREDENTIAL_MAX_TTL_MS = 365 * 24 * 60 * 60 * 1000;

export type CredentialKind = 'login' | 'api';

export interface Credential {
  readonly kind: CredentialKind;
  readonly userId: string;
  readonly expiresAt: Date;
  /** Present on a login code; the value the single-use registry consumes (see below). */
  readonly nonce?: string;
}

/** Why a credential was refused. `expired` and `invalid` are distinguished for the operator. */
export type CredentialRefusal = 'malformed' | 'signature' | 'expired' | 'kind' | 'used';

export type CredentialResult =
  | { readonly ok: true; readonly credential: Credential }
  | { readonly ok: false; readonly reason: CredentialRefusal };

/** Raised for configuration that would make minting or verifying unsafe. */
export class CredentialConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialConfigError';
  }
}

/**
 * Check a secret before it is used for anything.
 *
 * The message never echoes the secret. `AUTH_SECRET` is a credential like the database password
 * (SRS 8.3), and configuration errors are the one place a value ends up in a terminal scrollback
 * that later ends up in a bug report (SRS 8.5).
 */
export function assertSecretUsable(secret: string, name = 'AUTH_SECRET'): void {
  const trimmed = secret.trim();
  if (trimmed === '') {
    throw new CredentialConfigError(`${name} is required: it signs login codes and API credentials`);
  }
  if (Buffer.byteLength(trimmed, 'utf8') < MIN_SECRET_BYTES) {
    throw new CredentialConfigError(
      `${name} must be at least ${MIN_SECRET_BYTES} bytes; generate one with ` +
        '`node -e "console.log(require("crypto").randomBytes(32).toString("hex"))"`',
    );
  }
}

/** `payload` as the exact bytes that go into the signature. */
function encodePayload(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function signature(secret: string, body: string): string {
  return createHmac('sha256', secret.trim()).update(body, 'utf8').digest('base64url');
}

/**
 * Mint a one-time login code for one candidate.
 *
 * The nonce makes two codes minted in the same millisecond different, which is what lets the
 * consuming side detect a replay (see {@link NonceRegistry}). The TTL is not a parameter: a code
 * is a "click this now" artifact, and lengthening it moves the risk from the operator's clipboard
 * to anyone who can read the same loopback interface.
 */
export function mintLoginCode(secret: string, userId: string, now: Date = new Date()): string {
  assertSecretUsable(secret);
  return sign(secret, {
    k: 'login',
    u: userId,
    e: now.getTime() + LOGIN_CODE_TTL_MS,
    n: randomBytes(8).toString('base64url'),
  });
}

/** Mint a bearer API credential for one candidate. */
export function mintApiCredential(
  secret: string,
  userId: string,
  options: { now?: Date; ttlMs?: number } = {},
): string {
  assertSecretUsable(secret);
  const now = options.now ?? new Date();
  const ttl = options.ttlMs ?? API_CREDENTIAL_DEFAULT_TTL_MS;
  if (!Number.isInteger(ttl) || ttl <= 0) {
    throw new CredentialConfigError(`the credential lifetime must be a positive integer of ms`);
  }
  if (ttl > API_CREDENTIAL_MAX_TTL_MS) {
    throw new CredentialConfigError(
      `the credential lifetime may not exceed ${API_CREDENTIAL_MAX_TTL_MS} ms`,
    );
  }
  return sign(secret, { k: 'api', u: userId, e: now.getTime() + ttl });
}

function sign(secret: string, payload: Record<string, unknown>): string {
  const body = `${FORMAT_PREFIX}.${encodePayload(payload)}`;
  return `${body}.${signature(secret, body)}`;
}

/** Constant-time compare of two base64url signatures of the same length. */
function signaturesMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Verify a credential's format, signature, lifetime and kind — everything except whether a login
 * code has already been used, which is the caller's state to know ({@link NonceRegistry}).
 *
 * A payload this code cannot parse is `malformed`, not `signature`: both refuse the request, but
 * the distinction is what tells an operator "you pasted the wrong string" from "that string was
 * not signed by this deployment".
 */
export function verifyCredential(
  secret: string,
  presented: unknown,
  now: Date = new Date(),
  expectedKind?: CredentialKind,
): CredentialResult {
  if (typeof presented !== 'string' || presented === '') return refuse('malformed');

  const parts = presented.split('.');
  if (parts.length !== 3 || parts[0] !== FORMAT_PREFIX) return refuse('malformed');

  const body = `${parts[0]}.${parts[1]}`;
  if (!signaturesMatch(parts[2] ?? '', signature(secret, body))) return refuse('signature');

  let payload: Record<string, unknown>;
  try {
    const decoded = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'));
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
      return refuse('malformed');
    }
    payload = decoded as Record<string, unknown>;
  } catch {
    return refuse('malformed');
  }

  const kind = payload['k'];
  const userId = payload['u'];
  const expiresAt = payload['e'];
  const nonce = payload['n'];
  if (typeof userId !== 'string' || userId === '' || typeof expiresAt !== 'number') {
    return refuse('malformed');
  }
  if (typeof kind !== 'string') return refuse('malformed');
  if (kind !== 'login' && kind !== 'api') return refuse('malformed');

  if (expectedKind !== undefined && kind !== expectedKind) return refuse('kind');
  if (expiresAt <= now.getTime()) return refuse('expired');

  return {
    ok: true,
    credential: {
      kind,
      userId,
      expiresAt: new Date(expiresAt),
      ...(typeof nonce === 'string' ? { nonce } : {}),
    },
  };
}

function refuse(reason: CredentialRefusal): CredentialResult {
  return { ok: false, reason };
}

/**
 * The `Authorization: Bearer …` form of an API credential.
 *
 * Exported so a route, a script and a test all parse the header the same way — a second parser is
 * a second set of rules, and the one that drifts is the one that accepts something the other
 * rejects.
 */
export function bearerTokenFromAuthorization(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (rest.length !== 1) return null;
  return scheme?.toLowerCase() === 'bearer' ? (rest[0] ?? null) : null;
}

/**
 * The record of which login codes have been consumed.
 *
 * Single-use is what makes a code safe to put in a URL, a terminal and a browser history: once
 * opened it is worthless. The registry is in-memory for the same reason the session store is
 * (ADR-0009 §2.4) — one process, and a restart only re-opens codes minted before it, which are
 * already past their 60-second life. Codes minted and opened across a restart are therefore the
 * only thing the process cannot see, and that window is bounded by the TTL.
 */
export class NonceRegistry {
  private readonly used = new Map<string, number>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** True when `nonce` had not been seen; records it either way so a retry loses. */
  consume(nonce: string): boolean {
    this.prune();
    const expiry = this.now().getTime() + LOGIN_CODE_TTL_MS;
    const already = this.used.get(nonce);
    const fresh = already !== undefined && already > this.now().getTime();
    this.used.set(nonce, expiry);
    return !fresh;
  }

  /** Entries older than any code could still be valid; the map cannot grow without bound. */
  private prune(): void {
    const now = this.now().getTime();
    for (const [nonce, until] of this.used) {
      if (until <= now) this.used.delete(nonce);
    }
  }

  get size(): number {
    return this.used.size;
  }
}
