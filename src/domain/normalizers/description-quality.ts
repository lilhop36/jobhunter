import { DescriptionQuality, ProvenanceSource } from '../enums';
import type { NormalizedJob } from '../types';

/**
 * Deterministic description-quality classification (FR-007; SRS 3.5, 4.3, 7.7, Appendix E).
 *
 * The SRS requires the *classification* (SUFFICIENT | PARTIAL | UNUSABLE) and "configurable
 * deterministic checks", but does not itself define the checks. This module is that policy:
 * pure, synchronous and version-stamped, so the same input always yields the same state and
 * the rule that produced it can be recorded in field provenance.
 *
 * Constraints taken from the SRS:
 *  - `descriptionQuality` is required on every Job and has no UNKNOWN value (Appendix E), so
 *    every input maps to exactly one of the three states.
 *  - Classification is not rejection. An UNUSABLE Job is still persisted for traceability and
 *    funnel metrics and is excluded from matching/notification later (Appendix E), so this
 *    module never authorises dropping a record during collection.
 *  - Missing or non-text descriptions are UNUSABLE, not a negative fact about the job; the raw
 *    evidence stays available for reprocessing (ENG-001, FR-004).
 *
 * `DESCRIPTION_QUALITY_V1` rules, in order (first match wins):
 *  - R0  not a string                 -> UNUSABLE  (no description text was collected)
 *  - R1  blank after normalisation    -> UNUSABLE  (empty / whitespace / zero-width only)
 *  - R2  no lexical token (no letter) -> UNUSABLE  (digits, punctuation, symbols only)
 *  - R3  every token is boilerplate   -> UNUSABLE  (navigation labels / placeholders)
 *  - R4  fewer than `sufficientMinWords` lexical tokens -> PARTIAL
 *  - R5  otherwise                    -> SUFFICIENT
 *
 * R3 fires only when *every* distinct token is in the lexicon: a description is never
 * declared UNUSABLE just for containing a boilerplate word next to real content.
 */

/** Identifier recorded in field provenance; bump with any change to the rules or lexicon. */
export const DESCRIPTION_QUALITY_VERSION = 'DESCRIPTION_QUALITY_V1';

/**
 * The knobs of a description-quality policy. Deliberately one numeric threshold plus a token
 * set: the SRS asks for "configurable deterministic checks", not for a scoring model.
 */
export interface DescriptionQualityPolicy {
  /** Recorded verbatim as the provenance `conversionMethod`. */
  readonly version: string;
  /**
   * Minimum number of lexical tokens for SUFFICIENT. Below this the description is PARTIAL.
   * 25 mirrors a short-but-real paragraph; it is the only numeric knob and is data, not a
   * branch, so it can be retuned without touching the classifier.
   */
  readonly sufficientMinWords: number;
  /** Lowercase single tokens that carry no description content (see `DEFAULT_UNUSABLE_LEXICON`). */
  readonly unusableLexicon: ReadonlySet<string>;
}

export interface DescriptionQualityPolicyInput {
  version: string;
  sufficientMinWords: number;
  unusableLexicon: Iterable<string>;
}

/**
 * Build and validate a policy. Validation happens once, at construction, so the classifier
 * itself stays branch-light and cannot be handed a policy that silently misclassifies
 * (e.g. a non-positive word floor or a multi-word lexicon entry that can never match a token).
 */
export function defineDescriptionQualityPolicy(
  input: DescriptionQualityPolicyInput,
): DescriptionQualityPolicy {
  if (typeof input.version !== 'string' || input.version.trim() === '') {
    throw new RangeError('description-quality policy version must be a non-empty string');
  }
  if (!Number.isInteger(input.sufficientMinWords) || input.sufficientMinWords < 1) {
    throw new RangeError('sufficientMinWords must be a positive integer');
  }

  const lexicon = new Set<string>();
  for (const raw of input.unusableLexicon) {
    const token = String(raw).trim().toLowerCase();
    if (token === '' || /\s/.test(token)) {
      throw new RangeError(
        `unusable lexicon entries must be single non-empty tokens: ${JSON.stringify(raw)}`,
      );
    }
    lexicon.add(token);
  }

  return Object.freeze({
    version: input.version,
    sufficientMinWords: input.sufficientMinWords,
    unusableLexicon: lexicon,
  });
}

/**
 * Tokens that on their own carry no job-description content: navigation/UI chrome and obvious
 * placeholder or test values. Kept narrow on purpose — only unambiguous non-prose tokens, so
 * R3 cannot fire on a genuine description that merely uses one of these words. This is data,
 * not logic; extend it here and bump `DESCRIPTION_QUALITY_VERSION`.
 */
const DEFAULT_UNUSABLE_LEXICON: readonly string[] = [
  // Navigation / page chrome.
  'home',
  'menu',
  'navigation',
  'nav',
  'login',
  'logout',
  'signin',
  'signup',
  'register',
  'subscribe',
  'newsletter',
  'cookie',
  'cookies',
  'privacy',
  'terms',
  'conditions',
  'advertisement',
  'ads',
  'loading',
  'please',
  'wait',
  'enable',
  'javascript',
  'browser',
  'sitemap',
  'rss',
  'faq',
  'accessibility',
  'search',
  'apply',
  'submit',
  'cancel',
  'close',
  'skip',
  'footer',
  'header',
  'sidebar',
  'toggle',
  'print',
  'download',
  'bookmark',
  'share',
  // Placeholder / test values.
  'test',
  'testing',
  'tbd',
  'tba',
  'todo',
  'na',
  'n/a',
  'nil',
  'none',
  'null',
  'undefined',
  'unknown',
  'lorem',
  'ipsum',
  'dolor',
  'sit',
  'amet',
  'consectetur',
  'adipiscing',
  'elit',
  'placeholder',
  'dummy',
  'sample',
  'foo',
  'bar',
  'baz',
  'asdf',
  'qwerty',
  'xxx',
  'xxxx',
  'yyyy',
];

/** The active policy. Injected into the classifier so callers and tests can vary it. */
export const DESCRIPTION_QUALITY_POLICY: DescriptionQualityPolicy = defineDescriptionQualityPolicy({
  version: DESCRIPTION_QUALITY_VERSION,
  sufficientMinWords: 25,
  unusableLexicon: DEFAULT_UNUSABLE_LEXICON,
});

/** Invisible formatting characters (zero-width space/joiners, BOM, soft hyphen, ...). */
const FORMAT_CHARACTERS = /\p{Cf}/gu;
/** Any Unicode letter; distinguishes real words from digits/punctuation/symbol-only tokens. */
const HAS_LETTER = /\p{L}/u;

/**
 * Classify one captured description. Pure and deterministic: it reads no clock, locale or
 * random source (ENG-012), so the same input yields the same state on every run.
 */
export function classifyDescriptionQuality(
  description: unknown,
  policy: DescriptionQualityPolicy = DESCRIPTION_QUALITY_POLICY,
): DescriptionQuality {
  // R0: no text was collected at all.
  if (typeof description !== 'string') return DescriptionQuality.UNUSABLE;

  const normalized = description
    .normalize('NFKC')
    .replace(FORMAT_CHARACTERS, '')
    .replace(/\s+/gu, ' ')
    .trim();

  // R1: blank once invisible characters and whitespace are removed.
  if (normalized === '') return DescriptionQuality.UNUSABLE;

  // R2: something was captured, but nothing that is prose.
  const tokens = normalized.split(' ');
  const lexicalTokens = tokens.filter((token) => HAS_LETTER.test(token));
  if (lexicalTokens.length === 0) return DescriptionQuality.UNUSABLE;

  // R3: every token is boilerplate/placeholder, so there is no description content. Firing on
  // ALL tokens (not ANY) is what keeps a real description out of UNUSABLE.
  const isAllBoilerplate = lexicalTokens.every((token) =>
    policy.unusableLexicon.has(token.toLowerCase()),
  );
  if (isAllBoilerplate) return DescriptionQuality.UNUSABLE;

  // R4: real prose, but too short to be a sufficient description.
  if (lexicalTokens.length < policy.sufficientMinWords) return DescriptionQuality.PARTIAL;

  // R5: real, sufficient prose.
  return DescriptionQuality.SUFFICIENT;
}

/**
 * Apply the shared policy to one normalized job (FR-007; SRS Appendix E).
 *
 * The ingestion pipeline calls this immediately before persistence, so a Job's
 * `descriptionQuality` is always the shared classifier's verdict on the description that is
 * actually persisted - never whatever the adapter supplied. An adapter may still set the
 * field (the `NormalizedJob` contract requires it), but its value is overwritten here, so a
 * source-specific implementation can neither promote garbage to SUFFICIENT nor downgrade
 * real prose contrary to the policy.
 *
 * The provenance entry is stamped with {@link DESCRIPTION_QUALITY_VERSION} so the recorded
 * basis of the classification stays recoverable after the policy changes. `evidence` is null
 * because the description is already stored on the Job and its raw text on the RawJob
 * (ENG-002); copying it here would be a second copy to keep in sync.
 */
export function applyDescriptionQuality(job: NormalizedJob): NormalizedJob {
  return {
    ...job,
    descriptionQuality: classifyDescriptionQuality(job.description),
    provenance: {
      ...job.provenance,
      descriptionQuality: {
        provenance: ProvenanceSource.DETERMINISTIC,
        conversionMethod: DESCRIPTION_QUALITY_VERSION,
        evidence: null,
      },
    },
  };
}
