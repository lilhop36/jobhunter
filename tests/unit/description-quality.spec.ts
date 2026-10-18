import { DescriptionQuality, ProvenanceSource } from '@domain/enums';
import {
  DESCRIPTION_QUALITY_POLICY,
  DESCRIPTION_QUALITY_VERSION,
  applyDescriptionQuality,
  classifyDescriptionQuality,
  defineDescriptionQualityPolicy,
} from '@domain/normalizers/description-quality';
import { FakeSourceAdapter, makeFakeConfig, makeRawJob } from '../support/fake-source-adapter';

/** A description with `count` distinct, non-boilerplate words. */
function words(count: number): string {
  return Array.from({ length: count }, (_, index) => `word${index}`).join(' ');
}

describe('classifyDescriptionQuality', () => {
  it('classifies non-string input as UNUSABLE (R0)', () => {
    expect(classifyDescriptionQuality(null)).toBe(DescriptionQuality.UNUSABLE);
    expect(classifyDescriptionQuality(undefined)).toBe(DescriptionQuality.UNUSABLE);
    expect(classifyDescriptionQuality(42)).toBe(DescriptionQuality.UNUSABLE);
    expect(classifyDescriptionQuality({})).toBe(DescriptionQuality.UNUSABLE);
  });

  it('classifies empty and whitespace-only text as UNUSABLE (R1)', () => {
    expect(classifyDescriptionQuality('')).toBe(DescriptionQuality.UNUSABLE);
    expect(classifyDescriptionQuality('   \n\t  ')).toBe(DescriptionQuality.UNUSABLE);
  });

  it('classifies invisible characters alone as UNUSABLE (R1)', () => {
    // Zero-width space, zero-width joiner, BOM, soft hyphen: present but not content.
    expect(classifyDescriptionQuality('\u200B\u200D\uFEFF\u00AD')).toBe(
      DescriptionQuality.UNUSABLE,
    );
  });

  it('classifies letterless content as UNUSABLE (R2)', () => {
    expect(classifyDescriptionQuality('123 456 7890')).toBe(DescriptionQuality.UNUSABLE);
    expect(classifyDescriptionQuality('*** --- ###')).toBe(DescriptionQuality.UNUSABLE);
    expect(classifyDescriptionQuality('🎉 🚀')).toBe(DescriptionQuality.UNUSABLE);
  });

  it('classifies an all-boilerplate description as UNUSABLE (R3)', () => {
    expect(classifyDescriptionQuality('Apply Submit Cancel')).toBe(DescriptionQuality.UNUSABLE);
    expect(classifyDescriptionQuality('Home Login Register')).toBe(DescriptionQuality.UNUSABLE);
    expect(classifyDescriptionQuality('lorem ipsum dolor sit amet')).toBe(
      DescriptionQuality.UNUSABLE,
    );
  });

  it('does not fire R3 when real content sits beside a boilerplate word', () => {
    // "Apply" is boilerplate, but "directly" is real content: this is PARTIAL, not UNUSABLE.
    expect(classifyDescriptionQuality('Apply directly')).toBe(DescriptionQuality.PARTIAL);
  });

  it('classifies short prose as PARTIAL (R4)', () => {
    expect(classifyDescriptionQuality('Build reliable backend services for our team')).toBe(
      DescriptionQuality.PARTIAL,
    );
  });

  it('treats the word floor as a boundary: floor-1 words PARTIAL, floor words SUFFICIENT', () => {
    const floor = DESCRIPTION_QUALITY_POLICY.sufficientMinWords;
    expect(classifyDescriptionQuality(words(floor - 1))).toBe(DescriptionQuality.PARTIAL);
    expect(classifyDescriptionQuality(words(floor))).toBe(DescriptionQuality.SUFFICIENT);
  });

  it('ignores punctuation-only and numeric tokens when counting words', () => {
    const floor = DESCRIPTION_QUALITY_POLICY.sufficientMinWords;
    // 24 real words plus letterless tokens: still one short of SUFFICIENT.
    const text = `${words(floor - 1)} ${'### 1,234 +5 $ ###'.repeat(2)}`;
    expect(classifyDescriptionQuality(text)).toBe(DescriptionQuality.PARTIAL);
  });

  it('is deterministic and locale-independent', () => {
    const text = 'Design, build and operate distributed services for the platform team';
    expect(classifyDescriptionQuality(text)).toBe(classifyDescriptionQuality(text));
    expect(classifyDescriptionQuality(text)).toBe(DescriptionQuality.PARTIAL);
  });

  it('rejects raw-evidence-like hostile input without throwing', () => {
    const hostile = `${'<script>alert(1)</script> '.repeat(50)}\u0000\u0001`;
    expect(() => classifyDescriptionQuality(hostile)).not.toThrow();
  });
});

describe('defineDescriptionQualityPolicy', () => {
  it('builds the active policy with the version stamp', () => {
    expect(DESCRIPTION_QUALITY_POLICY.version).toBe(DESCRIPTION_QUALITY_VERSION);
    expect(DESCRIPTION_QUALITY_POLICY.sufficientMinWords).toBeGreaterThan(0);
  });

  it('rejects a non-positive word floor', () => {
    expect(() =>
      defineDescriptionQualityPolicy({ version: 'v', sufficientMinWords: 0, unusableLexicon: [] }),
    ).toThrow(RangeError);
    expect(() =>
      defineDescriptionQualityPolicy({ version: 'v', sufficientMinWords: 1.5, unusableLexicon: [] }),
    ).toThrow(RangeError);
  });

  it('rejects a lexicon entry that can never match a token', () => {
    expect(() =>
      defineDescriptionQualityPolicy({ version: 'v', sufficientMinWords: 1, unusableLexicon: [''] }),
    ).toThrow(RangeError);
    expect(() =>
      defineDescriptionQualityPolicy({
        version: 'v',
        sufficientMinWords: 1,
        unusableLexicon: ['two words'],
      }),
    ).toThrow(RangeError);
  });

  it('rejects an empty version', () => {
    expect(() =>
      defineDescriptionQualityPolicy({ version: '  ', sufficientMinWords: 1, unusableLexicon: [] }),
    ).toThrow(RangeError);
  });

  it('normalises custom lexicon entries and honours a custom floor', () => {
    const policy = defineDescriptionQualityPolicy({
      version: 'TEST_V1',
      sufficientMinWords: 2,
      unusableLexicon: ['  Boilerplate '],
    });
    expect(classifyDescriptionQuality('BOILERPLATE', policy)).toBe(DescriptionQuality.UNUSABLE);
    expect(classifyDescriptionQuality('alpha beta', policy)).toBe(DescriptionQuality.SUFFICIENT);
  });
});

describe('applyDescriptionQuality (shared policy is authoritative, FR-007)', () => {
  /** A `NormalizedJob` as an adapter would produce it, before the pipeline re-derives. */
  async function normalized(description: string | null) {
    const adapter = new FakeSourceAdapter(makeFakeConfig());
    return adapter.normalize(makeRawJob({ rawDescription: description }));
  }

  it('overwrites an adapter claim that promotes an UNUSABLE description', async () => {
    const job = await normalized('\u200B'); // invisible only: actually UNUSABLE
    const applied = applyDescriptionQuality({
      ...job,
      descriptionQuality: DescriptionQuality.SUFFICIENT,
    });

    expect(applied.descriptionQuality).toBe(DescriptionQuality.UNUSABLE);
    expect(applied.descriptionQuality).toBe(classifyDescriptionQuality('\u200B'));
  });

  it('overwrites an adapter claim that downgrades real prose', async () => {
    const job = await normalized(words(DESCRIPTION_QUALITY_POLICY.sufficientMinWords));
    const applied = applyDescriptionQuality({
      ...job,
      descriptionQuality: DescriptionQuality.UNUSABLE,
    });

    expect(applied.descriptionQuality).toBe(DescriptionQuality.SUFFICIENT);
  });

  it('agrees with the shared classifier on both sides of the threshold', async () => {
    const floor = DESCRIPTION_QUALITY_POLICY.sufficientMinWords;
    expect(applyDescriptionQuality(await normalized(words(floor - 1))).descriptionQuality).toBe(
      DescriptionQuality.PARTIAL,
    );
    expect(applyDescriptionQuality(await normalized(words(floor))).descriptionQuality).toBe(
      DescriptionQuality.SUFFICIENT,
    );
  });

  it('treats a missing description as UNUSABLE and still records provenance', async () => {
    const applied = applyDescriptionQuality(await normalized(null));

    expect(applied.descriptionQuality).toBe(DescriptionQuality.UNUSABLE);
    expect(applied.provenance.descriptionQuality).toEqual({
      provenance: ProvenanceSource.DETERMINISTIC,
      conversionMethod: DESCRIPTION_QUALITY_VERSION,
      evidence: null,
    });
  });

  it('stamps the policy version over any adapter-supplied provenance', async () => {
    const job = await normalized('Design and build the platform for our engineering team.');
    const applied = applyDescriptionQuality({
      ...job,
      provenance: {
        ...job.provenance,
        descriptionQuality: {
          provenance: ProvenanceSource.AI,
          conversionMethod: 'ADAPTER_GUESS',
          evidence: 'something else',
        },
      },
    });

    expect(applied.provenance.descriptionQuality).toEqual({
      provenance: ProvenanceSource.DETERMINISTIC,
      conversionMethod: DESCRIPTION_QUALITY_VERSION,
      evidence: null,
    });
  });

  it('does not mutate its input', async () => {
    const job = await normalized('');
    const before = job.descriptionQuality;

    applyDescriptionQuality({ ...job, descriptionQuality: DescriptionQuality.SUFFICIENT });

    expect(job.descriptionQuality).toBe(before);
  });
});
