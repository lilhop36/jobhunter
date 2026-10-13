import {
  FINGERPRINT_VERSION,
  contentFingerprintV1,
  rawContentHash,
  resolveSourceRecordIdentity,
  sourceRecordIdentityKey,
  type SourceIdentityPolicy,
  type SourceRecordIdentityInput,
} from '@domain/normalizers/job-identity';
import { urlIdentityValue } from '@domain/normalizers/url-normalizer';

const HEX64 = /^[0-9a-f]{64}$/;

function digestOf(value: string): string {
  const parts = value.split(':');
  return parts[parts.length - 1] as string;
}

describe('rawContentHash', () => {
  it('is deterministic', () => {
    const evidence = {
      sourceUrl: 'https://example.com/jobs/1',
      rawTitle: 'Senior Engineer',
      rawCompany: 'Acme',
      rawDescription: 'Build things.',
    };
    expect(rawContentHash(evidence)).toBe(rawContentHash({ ...evidence }));
  });

  it('carries the version and kind, and is a full SHA-256 digest', () => {
    const hash = rawContentHash({ rawTitle: 'x' });
    // A 32-bit hash would be short and base36. This guards the regression.
    expect(hash.startsWith(`${FINGERPRINT_VERSION}:raw:`)).toBe(true);
    expect(digestOf(hash)).toMatch(HEX64);
  });

  it('normalises whitespace, line endings and case', () => {
    const a = rawContentHash({ rawDescription: 'Hello  World\r\n\r\nTest' });
    const b = rawContentHash({ rawDescription: 'hello world test' });
    expect(a).toBe(b);
  });

  it('does not depend on the order fields are supplied', () => {
    const a = rawContentHash({ rawTitle: 'A', rawCompany: 'B' });
    const b = rawContentHash({ rawCompany: 'B', rawTitle: 'A' });
    expect(a).toBe(b);
  });

  it('treats a missing field differently from an empty field', () => {
    expect(rawContentHash({ rawTitle: 'x' })).not.toBe(
      rawContentHash({ rawTitle: 'x', rawCompany: '' }),
    );
  });

  it('treats omitted and null fields the same', () => {
    expect(rawContentHash({ rawTitle: 'x' })).toBe(
      rawContentHash({ rawTitle: 'x', rawCompany: null }),
    );
  });

  it('keeps field boundaries unambiguous', () => {
    const a = rawContentHash({ rawTitle: 'Acme Corp', rawCompany: 'Ltd' });
    const b = rawContentHash({ rawTitle: 'Acme', rawCompany: 'Corp Ltd' });
    expect(a).not.toBe(b);
  });

  it('changes when the description changes', () => {
    expect(rawContentHash({ rawDescription: 'before' })).not.toBe(
      rawContentHash({ rawDescription: 'after' }),
    );
  });

  it('cannot be forged by a value that mimics another field', () => {
    // With tags joined by a separator alone these encode identically, which would let
    // untrusted text hide one posting behind another.
    const twoFields = rawContentHash({ rawTitle: 'x', rawCompany: 'y' });
    const oneField = rawContentHash({ rawTitle: 'x\u0000c=y' });
    expect(twoFields).not.toBe(oneField);
  });
});

describe('contentFingerprintV1', () => {
  it('is a distinct kind from rawContentHash for the same text', () => {
    const raw = rawContentHash({ rawTitle: 'Engineer', rawCompany: 'Acme' });
    const content = contentFingerprintV1({ title: 'Engineer', company: 'Acme' });
    expect(raw).not.toBe(content);
    expect(content.startsWith(`${FINGERPRINT_VERSION}:content:`)).toBe(true);
    expect(digestOf(content)).toMatch(HEX64);
  });

  it('includes the description, because it measures content equality', () => {
    const base = { title: 'Engineer', company: 'Acme' };
    expect(contentFingerprintV1(base)).not.toBe(
      contentFingerprintV1({ ...base, description: 'edited' }),
    );
  });

  it('includes the canonical url', () => {
    const base = { title: 'Engineer', company: 'Acme' };
    expect(contentFingerprintV1(base)).not.toBe(
      contentFingerprintV1({ ...base, canonicalUrl: 'https://example.com/a' }),
    );
  });
});

describe('sourceRecordIdentityKey', () => {
  it('prefers a verified stable source identifier', () => {
    const key = sourceRecordIdentityKey({
      stableSourceJobIdentifier: 'job-42',
      trustworthyCanonicalUrl: 'https://example.com/jobs/42',
      title: 'Engineer',
      company: 'Acme',
    });
    expect(key).toBe('sid:job-42');
  });

  it('preserves identifier case, because identifiers are opaque', () => {
    expect(sourceRecordIdentityKey({ stableSourceJobIdentifier: 'AbC' })).toBe('sid:AbC');
    expect(sourceRecordIdentityKey({ stableSourceJobIdentifier: 'abc' })).not.toBe(
      sourceRecordIdentityKey({ stableSourceJobIdentifier: 'AbC' }),
    );
  });

  it('treats a blank identifier as absent', () => {
    const key = sourceRecordIdentityKey({
      stableSourceJobIdentifier: '   ',
      trustworthyCanonicalUrl: 'https://example.com/jobs/42',
    });
    expect(key).toBe('url:https://example.com/jobs/42');
  });

  it('falls back to a trustworthy canonical url', () => {
    expect(sourceRecordIdentityKey({ trustworthyCanonicalUrl: 'https://example.com/jobs/42' })).toBe(
      'url:https://example.com/jobs/42',
    );
  });

  it('preserves url path case', () => {
    expect(sourceRecordIdentityKey({ trustworthyCanonicalUrl: 'https://example.com/Jobs/42' })).not.toBe(
      sourceRecordIdentityKey({ trustworthyCanonicalUrl: 'https://example.com/jobs/42' }),
    );
  });

  it('never lets a url collide with an identifier carrying the same text', () => {
    const asIdentifier = sourceRecordIdentityKey({ stableSourceJobIdentifier: 'https://x/1' });
    const asUrl = sourceRecordIdentityKey({ trustworthyCanonicalUrl: 'https://x/1' });
    expect(asIdentifier).not.toBe(asUrl);
  });

  it('falls back to a content fingerprint when no identifier or url is usable', () => {
    const key = sourceRecordIdentityKey({ title: 'Engineer', company: 'Acme', locationText: 'Addis' });
    expect(key).toBeTruthy();
    expect(key!.startsWith('fp:')).toBe(true);
    expect(digestOf(key!)).toMatch(HEX64);
  });

  it('excludes the description from the fallback, so edits do not fork identity', () => {
    const base: SourceRecordIdentityInput = { title: 'Engineer', company: 'Acme' };
    // The description is not part of the identity input by design. If it were ever
    // added, this test fails.
    const withDescription = { ...base, description: 'reworded posting' } as SourceRecordIdentityInput;
    expect(sourceRecordIdentityKey(withDescription)).toBe(sourceRecordIdentityKey(base));
  });

  it('normalises the text used by the fallback', () => {
    const a = sourceRecordIdentityKey({ title: 'Senior  Engineer', company: 'ACME' });
    const b = sourceRecordIdentityKey({ title: 'senior engineer', company: 'acme' });
    expect(a).toBe(b);
  });

  it('distinguishes boundaries in the fallback', () => {
    const a = sourceRecordIdentityKey({ title: 'Acme Corp', company: 'Ltd' });
    const b = sourceRecordIdentityKey({ title: 'Acme', company: 'Corp Ltd' });
    expect(a).not.toBe(b);
  });

  it('returns null when there is no usable basis', () => {
    expect(sourceRecordIdentityKey({})).toBeNull();
    expect(sourceRecordIdentityKey({ title: null, company: undefined })).toBeNull();
    expect(sourceRecordIdentityKey({ title: '   ', company: '\n\t' })).toBeNull();
  });

  it('is stable across calls for the same record', () => {
    const input = { title: 'Engineer', company: 'Acme' };
    expect(sourceRecordIdentityKey(input)).toBe(sourceRecordIdentityKey({ ...input }));
  });

  it('does not collide two employers posting the same title in the same place', () => {
    const a = sourceRecordIdentityKey({
      title: 'Software Engineer',
      company: 'Acme',
      locationText: 'Addis Ababa',
    });
    const b = sourceRecordIdentityKey({
      title: 'Software Engineer',
      company: 'Beta Corp',
      locationText: 'Addis Ababa',
    });
    expect(a).not.toBe(b);
  });

  it('collides records whose normalised fields are identical, and marks them with the fp: prefix', () => {
    // The documented limitation of the fallback (ADR-0001): these are indistinguishable
    // from the available evidence, so they share a key - and the prefix makes that
    // visible to an operator rather than silently equivalent to a real identifier.
    const a = sourceRecordIdentityKey({
      title: '  Software  Engineer ',
      company: 'ACME',
      locationText: 'Addis Ababa',
    });
    const b = sourceRecordIdentityKey({
      title: 'software engineer',
      company: 'acme',
      locationText: 'addis ababa',
    });
    expect(a).toBe(b);
    expect(a!.startsWith('fp:')).toBe(true);
  });

  it('folds Unicode compatibility forms before comparing', () => {
    expect(sourceRecordIdentityKey({ title: '\uFF21cme Engineer', company: 'Acme' })).toBe(
      sourceRecordIdentityKey({ title: 'Acme Engineer', company: 'Acme' }),
    );
  });

  it('ignores volatile fields, which are not part of the identity input', () => {
    const base: SourceRecordIdentityInput = { title: 'Engineer', company: 'Acme' };
    const withVolatile = {
      ...base,
      collectedAt: new Date('2026-01-01T00:00:00.000Z'),
      salaryText: 'ETB 1,000',
      runId: 'run-1',
    } as unknown as SourceRecordIdentityInput;
    expect(sourceRecordIdentityKey(withVolatile)).toBe(sourceRecordIdentityKey(base));
  });

  it('never lets the fallback collide with an identifier or url carrying the same text', () => {
    const asFallback = sourceRecordIdentityKey({ title: 'https://x/1', company: 'Acme' });
    expect(asFallback!.startsWith('fp:')).toBe(true);
    expect(asFallback).not.toBe(sourceRecordIdentityKey({ trustworthyCanonicalUrl: 'https://x/1' }));
    expect(asFallback).not.toBe(sourceRecordIdentityKey({ stableSourceJobIdentifier: 'https://x/1' }));
  });
});

describe('sourceRecordIdentityKey minimum evidence', () => {
  /**
   * The fallback is a deduplication convenience, not proof of identity (ADR-0001), so it
   * only fires on evidence that can actually distinguish one posting from another.
   */
  it('refuses to build an identity from a single field', () => {
    expect(sourceRecordIdentityKey({ title: 'Engineer' })).toBeNull();
    expect(sourceRecordIdentityKey({ company: 'Acme' })).toBeNull();
    expect(sourceRecordIdentityKey({ locationText: 'Addis Ababa' })).toBeNull();
  });

  it('refuses a title-less pair, because company+location names a group of postings', () => {
    expect(sourceRecordIdentityKey({ company: 'Acme', locationText: 'Addis Ababa' })).toBeNull();
  });

  it('accepts a real title plus one other field', () => {
    expect(sourceRecordIdentityKey({ title: 'Engineer', company: 'Acme' })).toMatch(/^fp:/);
    expect(sourceRecordIdentityKey({ title: 'Engineer', locationText: 'Addis Ababa' })).toMatch(
      /^fp:/,
    );
  });

  it('treats placeholder text as absent rather than as a discriminator', () => {
    // A shared placeholder cannot distinguish employers, so keeping it would create
    // false confidence: "Engineer @ N/A" at two employers would look like one posting.
    expect(sourceRecordIdentityKey({ title: 'Engineer', company: 'N/A' })).toBeNull();
    expect(sourceRecordIdentityKey({ title: 'Engineer', company: 'unknown' })).toBeNull();
    expect(sourceRecordIdentityKey({ title: '-', company: 'Acme' })).toBeNull();
    expect(sourceRecordIdentityKey({ title: 'Engineer', company: '  TBD  ' })).toBeNull();
  });

  it('ignores a placeholder when comparing, so it cannot create a false distinction', () => {
    expect(
      sourceRecordIdentityKey({ title: 'Engineer', company: 'Acme', locationText: 'N/A' }),
    ).toBe(sourceRecordIdentityKey({ title: 'Engineer', company: 'Acme' }));
  });

  it('still fingerprints placeholder text as content, because it was really collected', () => {
    // The identity rule differs from the content rule on purpose: captured text is
    // evidence even when it carries no identity value.
    expect(contentFingerprintV1({ title: 'Engineer', company: 'N/A' })).not.toBe(
      contentFingerprintV1({ title: 'Engineer' }),
    );
  });

  it('keeps identity stable when the description changes but the basis does not', () => {
    const basis = { title: 'Engineer', company: 'Acme', locationText: 'Addis Ababa' };
    const before = contentFingerprintV1({ ...basis, description: 'first wording' });
    const after = contentFingerprintV1({ ...basis, description: 'second wording' });
    expect(after).not.toBe(before);
    expect(sourceRecordIdentityKey({ ...basis })).toBe(sourceRecordIdentityKey(basis));
  });
});

describe('urlIdentityValue', () => {
  it('canonicalises host, trailing slash and tracking parameters deterministically', () => {
    expect(urlIdentityValue('https://Example.com/jobs/42/?utm_source=newsletter')).toBe(
      'https://example.com/jobs/42',
    );
    expect(urlIdentityValue('https://example.com/jobs/42')).toBe(
      urlIdentityValue('https://example.com/jobs/42'),
    );
  });

  it('preserves path case and non-tracking query parameters', () => {
    expect(urlIdentityValue('https://example.com/Jobs/42?ref=abc')).toBe(
      'https://example.com/Jobs/42?ref=abc',
    );
  });

  it('drops the fragment, which is navigation state rather than resource identity', () => {
    expect(urlIdentityValue('https://example.com/jobs/42#apply')).toBe(
      'https://example.com/jobs/42',
    );
  });

  it('rejects a missing or blank url', () => {
    expect(urlIdentityValue(null)).toBeNull();
    expect(urlIdentityValue(undefined)).toBeNull();
    expect(urlIdentityValue('   ')).toBeNull();
  });

  it('rejects a url that addresses no resource', () => {
    // A bare host is a site root, not a posting. Treating it as identity would merge
    // every posting on the source into one.
    expect(urlIdentityValue('https://example.com/')).toBeNull();
    expect(urlIdentityValue('https://example.com')).toBeNull();
  });

  it('rejects malformed urls instead of asserting an identity from them', () => {
    expect(urlIdentityValue('http://')).toBeNull();
  });
});

describe('resolveSourceRecordIdentity', () => {
  const TRUSTING: SourceIdentityPolicy = { canonicalUrlIdentityTrusted: true };
  const DISTRUSTING: SourceIdentityPolicy = { canonicalUrlIdentityTrusted: false };
  const record = {
    canonicalUrl: 'https://example.com/jobs/42',
    title: 'Engineer',
    company: 'Acme',
    locationText: 'Addis Ababa',
  };

  it('prefers a stable source identifier and reports its basis', () => {
    expect(
      resolveSourceRecordIdentity({
        job: record,
        stableSourceJobIdentifier: 'job-42',
        policy: TRUSTING,
      }),
    ).toEqual({ key: 'sid:job-42', basis: 'sid' });
  });

  it('uses the canonical url only when the adapter declares it trustworthy', () => {
    expect(
      resolveSourceRecordIdentity({ job: record, stableSourceJobIdentifier: null, policy: TRUSTING }),
    ).toEqual({ key: 'url:https://example.com/jobs/42', basis: 'url' });

    const untrusted = resolveSourceRecordIdentity({
      job: record,
      stableSourceJobIdentifier: null,
      policy: DISTRUSTING,
    });
    expect(untrusted.basis).toBe('fallback');
    expect(untrusted.key!.startsWith('fp:')).toBe(true);
  });

  it('does not assert a url identity from an undeclared url', () => {
    expect(
      resolveSourceRecordIdentity({
        job: { canonicalUrl: 'https://example.com/jobs/42', title: null, company: null, locationText: null },
        stableSourceJobIdentifier: null,
        policy: DISTRUSTING,
      }),
    ).toEqual({ key: null, basis: null });
  });

  it('falls through a trusted but unusable url to the text fallback', () => {
    const resolved = resolveSourceRecordIdentity({
      job: { canonicalUrl: 'https://example.com/', title: 'Engineer', company: 'Acme', locationText: null },
      stableSourceJobIdentifier: null,
      policy: TRUSTING,
    });
    expect(resolved.basis).toBe('fallback');
  });

  it('returns null, not a guess, when nothing reliable is available', () => {
    expect(
      resolveSourceRecordIdentity({
        job: { canonicalUrl: null, title: 'Engineer', company: null, locationText: null },
        stableSourceJobIdentifier: null,
        policy: TRUSTING,
      }),
    ).toEqual({ key: null, basis: null });
  });

  it('treats a blank identifier as absent and moves to the next basis', () => {
    expect(
      resolveSourceRecordIdentity({
        job: record,
        stableSourceJobIdentifier: '   ',
        policy: TRUSTING,
      }).basis,
    ).toBe('url');
  });

  it('is deterministic for the same record', () => {
    const input = { job: record, stableSourceJobIdentifier: null, policy: TRUSTING };
    expect(resolveSourceRecordIdentity(input)).toEqual(resolveSourceRecordIdentity(input));
  });
});
