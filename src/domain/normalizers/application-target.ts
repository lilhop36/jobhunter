import { ApplicationMethod } from '../enums';
import type { ApplicationTarget } from '../types/normalized-job';
import { canonicalizeUrl } from './url-normalizer';

/**
 * Deterministic application-target extraction and eligibility (FR-006, SRS 7.7 step 7).
 *
 * The SRS fixes the `ApplicationMethod` values (Appendix A) and the eligibility rule
 * "a job must have a usable application path before notification unless the notification
 * policy explicitly permits informational listings" (3.5 / 7.7, AC-004). It does **not**
 * define how a method is detected. This module is that policy.
 *
 * `APPLICATION_TARGET_V1` is deliberately *high precision, low recall*, matching the
 * no-fabrication stance of the other deterministic normalizers (ER-04): a method is
 * assigned only when the captured text carries an explicit, unambiguous signal —
 *
 *   - an HTTP(S) URL in application context  -> ONLINE_URL (or PDF_FORM for a `.pdf`);
 *   - an email address in application context, or any `mailto:` link -> EMAIL;
 *   - an explicit "apply in person" phrase -> IN_PERSON;
 *
 * and is UNKNOWN otherwise. `SOURCE_ACCOUNT` and `INSTRUCTIONS` are valid states the SRS
 * allows, but they are source-specific declarations (does applying require the source's own
 * account?) that shared domain code cannot infer from free text (ENG-016); an adapter will
 * declare them when a real source needs them. `hasUsableApplicationPath` already handles
 * them, so adding them later is an adapter change, not a policy rewrite.
 *
 * "Application context" is a window around the match containing an apply keyword, so a
 * general contact address ("questions? info@example.com") is not mistaken for the
 * application path. The window is a heuristic: a posting that mentions a URL near an
 * unrelated keyword could still be misdetected, so prefer a labeled field when one appears.
 *
 * `ponytail:` URL/email/IN_PERSON detection only. When a source's postings carry a labelled
 * "How to apply" field, parse that instead of widening the window, and bump the version.
 */

/** Bump with any change to the rules below. */
export const APPLICATION_TARGET_VERSION = 'APPLICATION_TARGET_V1';

/**
 * Version stamp for a target an adapter mapped from the source's own structured fields.
 *
 * Separate from `APPLICATION_TARGET_V1` because it is a different policy: a declared field
 * outranks text inference. The mapping itself stays in the adapter (ENG-016); this module
 * owns only the validation the mapping must pass, so a malformed declared email cannot
 * become a notifiable path.
 */
export const DECLARED_APPLICATION_TARGET_VERSION = 'APPLICATION_TARGET_DECLARED_V1';

/** Apply-ish keywords that qualify a nearby URL or email as the application path. */
const APPLY_CONTEXT = /\b(?:appl(?:y|ication|ications)|send|submit|email|e-mail|cv|resume|cover\s+letter)\b/iu;

/** How far around a match to look for application context, in characters. */
const CONTEXT_WINDOW = 80;

const IN_PERSON = /\bappl(?:y|ication)\s+in\s+person\b/iu;

const UNKNOWN_TARGET: ApplicationTarget = {
  method: ApplicationMethod.UNKNOWN,
  applyUrl: null,
  applyEmail: null,
  evidence: null,
};

export interface ApplicationTargetInput {
  title?: string | null;
  description?: string | null;
}

/** True when an apply keyword sits within `CONTEXT_WINDOW` chars of the match. */
function hasApplyContext(text: string, index: number, length: number): boolean {
  const start = Math.max(0, index - CONTEXT_WINDOW);
  const end = Math.min(text.length, index + length + CONTEXT_WINDOW);
  return APPLY_CONTEXT.test(text.slice(start, end));
}

/**
 * Whether a declared address is a syntactically usable application email. Exported because an
 * adapter that maps a source's own `application_email` field must apply the same check the
 * text extractor applies; a typo in a publisher field must not become a notifiable path.
 */
export function isValidApplicationEmail(value: string): boolean {
  return /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/iu.test(value);
}

/**
 * An application URL: an HTTP(S) URL in application context. Patterns are created per call
 * so a module-level `lastIndex` cannot leak between invocations.
 */
function findApplicationUrl(text: string): { url: string; evidence: string; isPdf: boolean } | null {
  const pattern = /https?:\/\/[^\s<>"')\]]+/giu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    // Trailing sentence punctuation is not part of the URL.
    const raw = match[0].replace(/[.,;:)\]]+$/u, '');
    if (!hasApplyContext(text, match.index, raw.length)) continue;
    const canonical = canonicalizeUrl(raw);
    if (canonical === null) continue;
    let parsed: URL;
    try {
      parsed = new URL(canonical);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    return { url: canonical, evidence: raw, isPdf: /\.pdf$/iu.test(parsed.pathname) };
  }
  return null;
}

/**
 * An application email: a `mailto:` link, or an address in application context. A bare
 * address with no apply keyword nearby is not treated as the application path.
 */
function findApplicationEmail(text: string): { email: string; evidence: string } | null {
  const mailto = /mailto:\s*([^\s"'<>?,]+)/iu.exec(text);
  if (mailto && isValidApplicationEmail(mailto[1])) {
    return { email: mailto[1], evidence: mailto[0].trim() };
  }
  const pattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (!isValidApplicationEmail(match[0])) continue;
    if (!hasApplyContext(text, match.index, match[0].length)) continue;
    return { email: match[0], evidence: match[0] };
  }
  return null;
}

/**
 * Resolve the application target from captured evidence. Pure and deterministic (ENG-012),
 * and untrusted input never throws (ER-24). A URL outranks an email because a link is the
 * more direct path; at most one method is reported, so the recorded method always matches
 * the recorded target.
 */
export function resolveApplicationTarget(input: ApplicationTargetInput): ApplicationTarget {
  const text = [input.description, input.title]
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    .join('\n');

  if (text === '') return { ...UNKNOWN_TARGET };

  const url = findApplicationUrl(text);
  if (url) {
    return {
      method: url.isPdf ? ApplicationMethod.PDF_FORM : ApplicationMethod.ONLINE_URL,
      applyUrl: url.url,
      applyEmail: null,
      evidence: url.evidence,
    };
  }

  const email = findApplicationEmail(text);
  if (email) {
    return {
      method: ApplicationMethod.EMAIL,
      applyUrl: null,
      applyEmail: email.email,
      evidence: email.evidence,
    };
  }

  const inPerson = IN_PERSON.exec(text);
  if (inPerson) {
    return {
      method: ApplicationMethod.IN_PERSON,
      applyUrl: null,
      applyEmail: null,
      evidence: inPerson[0],
    };
  }

  return { ...UNKNOWN_TARGET };
}

/** The notification policy knobs that bear on eligibility (SRS 3.2 / 3.5 / 7.7). */
export interface NotificationPolicy {
  /**
   * "unless the notification policy explicitly permits informational listings" (SRS 3.5).
   * Off by default: an informational listing with no usable path is not notifiable (AC-004).
   */
  allowInformationalListings?: boolean;
}

/**
 * Whether a job with this application target may be notified (AC-004).
 *
 * A path is usable when the method is known and its required target is present. Methods
 * whose path is the listing or its instructions (SOURCE_ACCOUNT, IN_PERSON, INSTRUCTIONS)
 * are usable by virtue of having been detected at all; UNKNOWN never is.
 */
export function hasUsableApplicationPath(
  target: ApplicationTarget,
  policy: NotificationPolicy = {},
): boolean {
  if (policy.allowInformationalListings === true) return true;
  switch (target.method) {
    case ApplicationMethod.ONLINE_URL:
    case ApplicationMethod.PDF_FORM:
      return target.applyUrl !== null;
    case ApplicationMethod.EMAIL:
      return target.applyEmail !== null;
    case ApplicationMethod.SOURCE_ACCOUNT:
    case ApplicationMethod.IN_PERSON:
    case ApplicationMethod.INSTRUCTIONS:
      return true;
    case ApplicationMethod.UNKNOWN:
      return false;
  }
}
