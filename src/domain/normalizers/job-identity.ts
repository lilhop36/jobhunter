import { createHash } from 'node:crypto';
import type { NormalizedJob } from '../types';
import { urlIdentityValue } from './url-normalizer';

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
 * Text markers that stand in for "no value" in a structured field.
 *
 * Conservative on purpose: only values that are unambiguously placeholders appear here,
 * because discarding a real title or employer would make a genuine posting undeduplicable
 * and lose it. A placeholder is treated as *absent* rather than as a discriminator: a
 * shared value like `N/A` in a company field would otherwise make two different employers'
 * postings with the same title look identical.
 *
 * The list is compared after normalisation (`identityTextField`), so casing, internal
 * whitespace and surrounding spaces do not defeat it.
 */
const PLACEHOLDER_TEXT_VALUES = new Set([
  '-',
  '--',
  '---',
  '?',
  'n/a',
  'n.a.',
  'n.a',
  'na',
  'none',
  'null',
  'undefined',
  'unknown',
  'tbd',
  'tba',
  'to be determined',
  'not specified',
  'not available',
  'not applicable',
]);

/**
 * Identity value of one text field: normalised, with placeholders folded to absent.
 *
 * Deliberately different from the content fingerprints, which keep placeholder text
 * because it was really collected. Captured text is evidence even when it carries no
 * identity value.
 */
function identityTextField(value: string | null | undefined): string | null {
  const normalized = normalizeTextField(value);
  if (normalized === null || normalized === '') return null;
  return PLACEHOLDER_TEXT_VALUES.has(normalized) ? null : normalized;
}

/**
 * Last-resort identity basis: title + company + location only.
 *
 * The description is excluded on purpose. Descriptions are edited in place, and if
 * they contributed here an edited posting would become a new job instead of an update.
 * `canonicalUrl` is excluded too, so a re-post with a changed URL does not fork the
 * identity.
 *
 * Minimum evidence: a real title plus at least one other real field. One field is not a
 * discriminator - every "Software Engineer" on a source would collide into a single
 * posting and the rest would be silently discarded - and a title-less pair names an
 * employer/location group rather than a posting. When the evidence cannot distinguish
 * records this returns null, the signal for "undeduplicable", instead of guessing.
 *
 * This is a deduplication convenience, not proof of identity: two genuinely different
 * postings with identical normalised fields still collide (ADR-0001). The `fp:` prefix
 * keeps that weakness visible rather than making it look like a real identifier.
 */
function identityFallbackFingerprint(input: SourceRecordIdentityInput): string | null {
  const { value, nonEmptyFieldCount } = fingerprintFromSegments(
    'identity',
    [
      ['t', input.title],
      ['c', input.company],
      ['l', input.locationText],
    ],
    identityTextField,
  );
  if (nonEmptyFieldCount < 2) return null;
  if (identityTextField(input.title) === null) return null;
  return value;
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
function resolveIdentity(input: SourceRecordIdentityInput): SourceRecordIdentity {
  const identifier = normalizeOpaqueField(input.stableSourceJobIdentifier);
  if (identifier) return { key: `sid:${identifier}`, basis: 'sid' };

  // A URL is only a basis when it provably addresses a resource; see `urlIdentityValue`.
  const url = urlIdentityValue(input.trustworthyCanonicalUrl);
  if (url) return { key: `url:${url}`, basis: 'url' };

  const fallback = identityFallbackFingerprint(input);
  if (fallback === null) return { key: null, basis: null };
  return { key: `fp:${fallback}`, basis: 'fallback' };
}

export function sourceRecordIdentityKey(input: SourceRecordIdentityInput): string | null {
  return resolveIdentity(input).key;
}

/**
 * Resolve the source-record identity of a normalized record, applying the source's
 * declared policy (ADR-0001 concept 1).
 *
 * The URL basis is gated on an explicit declaration on purpose. A `sourceUrl` is present
 * on most records and is frequently *not* identity-worthy: a shared careers URL or a
 * paginated listing page would collapse many distinct postings into one identity and
 * silently discard all but the first. The pipeline does not assume that trust; the adapter
 * declares it. This is why the declaration is a domain-level policy type rather than
 * something the resolver infers from the URL.
 *
 * Deterministic and pure: it reads no clock or random source (ENG-012).
 */
export function resolveSourceRecordIdentity(
  request: SourceRecordIdentityRequest,
): SourceRecordIdentity {
  return resolveIdentity({
    // The identifier contract is what makes populating this field a declaration of
    // stability: `RawJobEvidence.sourceJobIdentifier` is documented as a *stable*
    // identifier, so an adapter that cannot verify stability leaves it null. That is why
    // there is no separate "identifier is stable" flag, while URL trust one is needed.
    stableSourceJobIdentifier: request.stableSourceJobIdentifier,
    trustworthyCanonicalUrl: request.policy.canonicalUrlIdentityTrusted
      ? request.job.canonicalUrl
      : null,
    title: request.job.title,
    company: request.job.company,
    locationText: request.job.locationText,
  });
}

/**
 * What the adapter has declared about a source's records (ADR-0001 concept 1).
 *
 * A domain type, not `SourceAdapterConfig`: the domain must not depend on the ports layer.
 * `SourceAdapterConfig` satisfies this structurally.
 */
export interface SourceIdentityPolicy {
  /**
   * True only when the source approval record has verified that the adapter's job URLs are
   * canonical *job-detail* URLs: stable across re-collection, not a listing or paginated
   * page, and not a shared careers URL fronting many postings.
   */
  canonicalUrlIdentityTrusted: boolean;
}

/** Which declared basis an identity came from, so the weakest basis stays observable. */
export type IdentityBasis = 'sid' | 'url' | 'fallback';

export interface SourceRecordIdentityRequest {
  /** Canonical fields of the normalized record. */
  job: Pick<NormalizedJob, 'canonicalUrl' | 'title' | 'company' | 'locationText'>;
  /**
   * Source-assigned identifier, present only when the adapter declares it stable. See
   * `RawJobEvidence.sourceJobIdentifier`.
   */
  stableSourceJobIdentifier: string | null;
  policy: SourceIdentityPolicy;
}

export interface SourceRecordIdentity {
  /** `sid:<id>` | `url:<canonical url>` | `fp:<digest>`, or null when undeduplicable. */
  key: string | null;
  basis: IdentityBasis | null;
}
