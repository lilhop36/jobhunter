import { createHash } from 'node:crypto';

/**
 * Versioned job fingerprints (ADR-0001).
 *
 * Three questions, three answers:
 *   - `rawContentHash`          - is this capture byte-equivalent to one already stored?
 *   - `contentFingerprintV1`    - is this normalised job content equivalent?
 *   - `sourceRecordIdentityKey` - is this the same posting on this source?
 *
 * Only the last is an identity, and it is never derived from content alone unless no
 * better basis exists.
 *
 * Every value is prefixed `v1:<kind>:`, so values produced by a different algorithm,
 * different normalisation, or answering a different question are never compared as if
 * equivalent.
 */

/** Bump when inputs, normalisation or algorithm change, so a re-fingerprint can target a version. */
export const FINGERPRINT_VERSION = 'v1';

export type FingerprintKind = 'raw' | 'content' | 'identity';

export interface RawContentFingerprintInput {
  sourceUrl?: string | null;
  rawTitle?: string | null;
  rawCompany?: string | null;
  rawLocation?: string | null;
  rawDescription?: string | null;
  rawPublishedDateText?: string | null;
  rawSalaryText?: string | null;
}

export interface JobContentFingerprintInput {
  title?: string | null;
  company?: string | null;
  locationText?: string | null;
  description?: string | null;
  canonicalUrl?: string | null;
}

export interface SourceRecordIdentityInput {
  /**
   * Identifier the adapter has *verified* is stable for this source. Case is
   * preserved: source identifiers are opaque and may be case-sensitive.
   */
  stableSourceJobIdentifier?: string | null;
  /** Canonical URL the adapter has verified is trustworthy for this source. */
  trustworthyCanonicalUrl?: string | null;
  title?: string | null;
  company?: string | null;
  locationText?: string | null;
}

/**
 * Normalise human-facing text: NFKC, unify line endings, collapse whitespace, trim,
 * lowercase. Case folding is appropriate here because these are display strings, not
 * keys.
 */
function normalizeTextField(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Normalise an opaque value (source identifier, URL). Case is preserved: identifiers
 * may be case-sensitive, and URL paths certainly are. Lowercasing here could merge two
 * genuinely different postings.
 */
function normalizeOpaqueField(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.normalize('NFKC').trim();
}

/**
 * Build a fingerprint from tagged fields joined with NUL.
 *
 * Tags make field boundaries unambiguous - `{"Acme Corp", "Ltd"}` and
 * `{"Acme", "Corp Ltd"}` no longer encode identically - and a missing field emits no
 * segment while an empty field emits `tag=`, so UNKNOWN stays distinguishable from an
 * empty value.
 */
function fingerprintFromSegments(
  kind: FingerprintKind,
  segments: ReadonlyArray<readonly [string, string | null | undefined]>,
  normalise: (value: string | null | undefined) => string | null,
): { value: string; nonEmptyFieldCount: number } {
  const encoded: string[] = [];
  let nonEmptyFieldCount = 0;
  for (const [tag, value] of segments) {
    const normalized = normalise(value);
    if (normalized === null) continue;
    // Length-prefixed: the segment is self-delimiting, so no captured value can forge
    // a field boundary, even if it contains a tag name, '=' or the NUL separator.
    // Captured text is untrusted input, so this is not theoretical.
    encoded.push(`${tag}${normalized.length}:${normalized}`);
    if (normalized !== '') nonEmptyFieldCount += 1;
  }
  const digest = createHash('sha256').update(encoded.join('\u0000'), 'utf8').digest('hex');
  return {
    value: `${FINGERPRINT_VERSION}:${kind}:${digest}`,
    nonEmptyFieldCount,
  };
}

/** Identity of the captured raw fields. Detects that a capture was already stored (ENG-002). */
export function rawContentHash(input: RawContentFingerprintInput): string {
  return fingerprintFromSegments(
    'raw',
    [
      ['t', input.rawTitle],
      ['c', input.rawCompany],
      ['l', input.rawLocation],
      ['d', input.rawDescription],
      ['s', input.rawSalaryText],
      ['p', input.rawPublishedDateText],
      ['u', input.sourceUrl],
    ],
    normalizeTextField,
  ).value;
}

/**
 * Identity of the normalised job content (SRS 5.2 `Job.contentFingerprint`).
 *
 * Includes the description: this is a content-equality signal, not an identity.
 * Deliberately NOT a uniqueness constraint - see ADR-0001.
 */
export function contentFingerprintV1(input: JobContentFingerprintInput): string {
  return fingerprintFromSegments(
    'content',
    [
      ['t', input.title],
      ['c', input.company],
      ['l', input.locationText],
      ['d', input.description],
      ['u', input.canonicalUrl],
    ],
    normalizeTextField,
  ).value;
}

/**
 * Last-resort identity basis: title + company + location only.
 *
 * The description is excluded on purpose. Descriptions are edited in place, and if
 * they contributed here an edited posting would become a new job instead of an update.
 * `canonicalUrl` is excluded too, so a re-post with a changed URL does not fork the
 * identity.
 *
 * Returns null when no basis exists, which is the signal for "undeduplicable".
 */
function identityFallbackFingerprint(input: SourceRecordIdentityInput): string | null {
  const { value, nonEmptyFieldCount } = fingerprintFromSegments(
    'identity',
    [
      ['t', input.title],
      ['c', input.company],
      ['l', input.locationText],
    ],
    normalizeTextField,
  );
  // Whitespace-only text is not usable text: UNKNOWN is not a basis for identity.
  return nonEmptyFieldCount === 0 ? null : value;
}

/**
 * Resolve the source-record identity of one record (ADR-0001 concept 1).
 *
 * Order: a verified stable source identifier, then a trustworthy canonical URL, then a
 * content fallback, then null.
 *
 * The `sid:` / `url:` / `fp:` prefix makes the basis of the key visible, so a URL can
 * never collide with a source-provided identifier and the weakest basis is
 * identifiable by inspection rather than assumed equivalent to a real identifier.
 */
export function sourceRecordIdentityKey(input: SourceRecordIdentityInput): string | null {
  const identifier = normalizeOpaqueField(input.stableSourceJobIdentifier);
  if (identifier) return `sid:${identifier}`;

  const url = normalizeOpaqueField(input.trustworthyCanonicalUrl);
  if (url) return `url:${url}`;

  const fallback = identityFallbackFingerprint(input);
  return fallback === null ? null : `fp:${fallback}`;
}
