import {
  LOGIN_CODE_TTL_MS,
  verifyCredential,
  type CredentialRefusal,
  type NonceRegistry,
} from './credentials';

/**
 * Opening a sign-in code (SRS 8.1; ADR-0011 §3).
 *
 * This is the whole authority a browser has to become somebody: a locally minted, signed, 60-second,
 * one-use string, checked here and turned into a session by the caller. It is a separate module from
 * the HTTP layer because the rules — signature, lifetime, kind, single use — deserve their own
 * failures, and a page that gets them wrong should be able to say *which* one.
 *
 * Nothing here stores a candidate or a credential: the verdict names a `userId`, and the session
 * store (`@application/web/session`) is the thing that remembers it from then on.
 *
 * A refusal message never quotes the presented string. It is a credential, and SRS 8.5 keeps
 * credentials out of whatever the app prints — which includes a page an operator might screenshot.
 */

export type SignInVerdict =
  | { readonly ok: true; readonly userId: string }
  | { readonly ok: false; readonly message: string };

/** The one action that fixes every refusal below. */
const MINT_AGAIN = 'Run `npm run login` again for a fresh link.';

/**
 * Does this string open a session, and for whom?
 *
 * The order is the order of cost: parse and verify the signature, then the lifetime and kind, then
 * the single-use check — which is the only one that mutates anything, so a code that was never valid
 * cannot consume the registry's memory.
 */
export function openSignInCode(
  secret: string,
  usedCodes: NonceRegistry,
  presented: unknown,
  now: Date = new Date(),
): SignInVerdict {
  const result = verifyCredential(secret, presented, now, 'login');
  if (!result.ok) return { ok: false, message: refusal(result.reason) };

  const { nonce, userId } = result.credential;
  if (nonce === undefined) {
    // Minted by a build that did not give codes a nonce: it cannot be proven unused, so it is
    // treated as forged rather than trusted forever.
    return { ok: false, message: `That link is not a sign-in code this deployment issues. ${MINT_AGAIN}` };
  }
  if (!usedCodes.consume(nonce)) {
    return { ok: false, message: `That link has already been opened. ${MINT_AGAIN}` };
  }

  return { ok: true, userId };
}

function refusal(reason: CredentialRefusal): string {
  switch (reason) {
    case 'expired':
      return `That sign-in link has expired — a link is good for ${LOGIN_CODE_TTL_MS / 1000} seconds. ${MINT_AGAIN}`;
    case 'kind':
      return `That is an API credential, not a sign-in link. ${MINT_AGAIN}`;
    case 'signature':
      return `That link was not signed by this deployment. ${MINT_AGAIN}`;
    default:
      return `That link could not be read. ${MINT_AGAIN}`;
  }
}
