import {
  FINGERPRINT_VERSION,
  contentFingerprintV1,
  rawContentHash,
  sourceRecordIdentityKey,
  type SourceRecordIdentityInput,
} from '@domain/normalizers/job-identity';

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
});
