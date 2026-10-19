import {
  CalendarType,
  DescriptionQuality,
  EmploymentType,
  LocationCategory,
  RelocationPreference,
  RemotePreference,
  RemoteStatus,
  SalaryPeriod,
  SalaryType,
  SkillEvidence,
} from '@domain/enums';
import { MATCH_FACTORS, MATCH_FACTOR_WEIGHTS, MATCHER_VERSION, scoreMatch, skillCredit } from '@domain/matching';
import {
  asDecimalAmount,
  asProbability,
  CandidateProfile,
  DecimalAmount,
  MatchableJob,
  MatchableJobSkill,
} from '@domain/types';

/**
 * The matcher's contract (FR-013/FR-014/FR-015, AC-009, AC-010, ENG-004,
 * ENG-012, ENG-028). Expected numbers are derived by hand in the comments so a
 * scoring change cannot silently pass by regenerating a snapshot.
 */

const NOW = new Date('2026-10-17T00:00:00Z');

function profile(overrides: Partial<CandidateProfile> = {}): CandidateProfile {
  return {
    profileVersion: 'test-1',
    experienceYears: 3,
    remotePreference: RemotePreference.NO_PREFERENCE,
    relocationPreference: RelocationPreference.WILLING,
    salaryPreference: {
      min: asDecimalAmount('20000.00'),
      currency: 'ETB',
      period: SalaryPeriod.MONTH,
      requireDisclosed: false,
    },
    employmentPreferences: [EmploymentType.FULL_TIME],
    skills: [
      { canonicalSkill: 'TypeScript', skillType: SkillEvidence.EXACT_MATCH, confidence: asProbability(1) },
      { canonicalSkill: 'Node.js', skillType: SkillEvidence.EXACT_MATCH, confidence: asProbability(1) },
      { canonicalSkill: 'Kubernetes', skillType: SkillEvidence.EXACT_MATCH, confidence: asProbability(1) },
    ],
    targetRoles: [{ title: 'Software Engineer', aliases: ['Software Developer', 'Backend Engineer'] }],
    locationPreferences: [
      { category: LocationCategory.ADDIS_ABABA, text: null },
      { category: LocationCategory.ETHIOPIA_REMOTE, text: null },
    ],
    ...overrides,
  };
}

function job(overrides: Partial<MatchableJob> = {}): MatchableJob {
  return {
    title: 'Software Engineer',
    descriptionQuality: DescriptionQuality.SUFFICIENT,
    locationText: 'Addis Ababa',
    locationCategory: LocationCategory.ADDIS_ABABA,
    remoteStatus: RemoteStatus.ONSITE,
    employmentType: EmploymentType.FULL_TIME,
    salary: {
      type: SalaryType.RANGE,
      min: asDecimalAmount('25000.00'),
      max: asDecimalAmount('35000.00'),
      currency: 'ETB',
      period: SalaryPeriod.MONTH,
      evidence: '25,000–35,000 ETB',
      confidence: asProbability(0.9),
    },
    publishedDate: {
      calendar: CalendarType.GREGORIAN,
      publishedAt: new Date('2026-10-15T00:00:00Z'),
      originalText: null,
      confidence: asProbability(1),
      conversionMethod: null,
    },
    skills: [
      { canonicalSkill: 'TypeScript', evidence: SkillEvidence.EXACT_MATCH, confidence: asProbability(0.95) },
      { canonicalSkill: 'Node.js', evidence: SkillEvidence.CANONICAL_ALIAS, confidence: asProbability(0.9) },
    ],
    requiredExperience: { years: 2, confidence: asProbability(0.8) },
    ...overrides,
  };
}

describe('matcher weights (SRS 4.6)', () => {
  it('sums the seven published weights to 100 and exposes a matcher version', () => {
    const total = MATCH_FACTORS.reduce((sum, factor) => sum + MATCH_FACTOR_WEIGHTS[factor], 0);
    expect(total).toBe(100);
    expect(MATCH_FACTORS).toHaveLength(7);
    expect(MATCHER_VERSION).toBe('1.0.0');
  });
});

describe('skill credit ladder (SRS 4.6)', () => {
  it('gives full credit to exact and canonical-alias observations', () => {
    expect(skillCredit(SkillEvidence.EXACT_MATCH, asProbability(1))).toBe(1);
    expect(skillCredit(SkillEvidence.CANONICAL_ALIAS, asProbability(1))).toBe(1);
  });

  it('caps related and transferable credit below full', () => {
    expect(skillCredit(SkillEvidence.RELATED_SKILL, asProbability(1))).toBe(0.5);
    expect(skillCredit(SkillEvidence.TRANSFERABLE, asProbability(1))).toBe(0.25);
  });

  it('gates AI-suggested credit on confidence and caps it', () => {
    expect(skillCredit(SkillEvidence.AI_SUGGESTED, asProbability(0.59))).toBe(0);
    expect(skillCredit(SkillEvidence.AI_SUGGESTED, asProbability(0.6))).toBe(0.5);
    expect(skillCredit(SkillEvidence.AI_SUGGESTED, asProbability(1))).toBe(0.5);
  });

  it('gives no positive credit to UNKNOWN evidence', () => {
    expect(skillCredit(SkillEvidence.UNKNOWN, asProbability(1))).toBe(0);
  });
});

describe('scoreMatch — complete evidence', () => {
  it('scores a fully evidenced job and explains every factor', () => {
    const match = scoreMatch({ profile: profile(), job: job(), now: NOW });

    // role 100, skills round(100*2/3)=67, experience 100, location 100,
    // employment 100, freshness 100 (2 days), salary 100 -> (9010)/100 = 90.1
    expect(match.score).toBe(90);
    // certainty: .95*25 + .9*30 + .8*15 + .9*15 + .9*5 + 1*5 + .9*5 = 90.25
    expect(match.confidence).toBe(90);
    expect(match.factors).toEqual({
      role: 100,
      skills: 67,
      experience: 100,
      location: 100,
      employment: 100,
      freshness: 100,
      salary: 100,
    });
    expect(match.matcherVersion).toBe('1.0.0');
    expect(match.explanation).toContain('matcher 1.0.0');
    expect(match.explanation).toContain('known factors:');
  });

  it('reports matched, missing and uncertain skills separately (FR-015)', () => {
    const match = scoreMatch({
      profile: profile({
        skills: [
          { canonicalSkill: 'TypeScript', skillType: SkillEvidence.EXACT_MATCH, confidence: asProbability(1) },
          { canonicalSkill: 'Node.js', skillType: SkillEvidence.EXACT_MATCH, confidence: asProbability(1) },
          { canonicalSkill: 'React', skillType: SkillEvidence.EXACT_MATCH, confidence: asProbability(1) },
          { canonicalSkill: 'AWS', skillType: SkillEvidence.EXACT_MATCH, confidence: asProbability(1) },
          { canonicalSkill: 'Kubernetes', skillType: SkillEvidence.EXACT_MATCH, confidence: asProbability(1) },
        ],
      }),
      job: job({
        skills: [
          { canonicalSkill: 'TypeScript', evidence: SkillEvidence.EXACT_MATCH, confidence: asProbability(0.95) },
          { canonicalSkill: 'Node.js', evidence: SkillEvidence.CANONICAL_ALIAS, confidence: asProbability(0.9) },
          { canonicalSkill: 'React', evidence: SkillEvidence.RELATED_SKILL, confidence: asProbability(0.9) },
          { canonicalSkill: 'AWS', evidence: SkillEvidence.AI_SUGGESTED, confidence: asProbability(0.8) },
        ],
      }),
      now: NOW,
    });

    expect(match.matchedSkills).toEqual(['Node.js', 'React', 'TypeScript']);
    expect(match.missingSkills).toEqual(['Kubernetes']);
    expect(match.uncertainSkills).toEqual(['AWS']);
    // React (RELATED_SKILL) is matched but capped, so it still shows in the evidence lines.
    expect(match.matchedEvidence.some((line) => line.includes('React (RELATED_SKILL)'))).toBe(true);
  });
});

describe('scoreMatch — deterministic and reproducible (AC-009, ENG-012)', () => {
  it('returns identical output for identical input and matcher version', () => {
    const first = scoreMatch({ profile: profile(), job: job(), now: NOW });
    const second = scoreMatch({ profile: profile(), job: job(), now: NOW });
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('does not read the system clock: only the injected time moves freshness', () => {
    const later = scoreMatch({ profile: profile(), job: job(), now: new Date('2026-12-17T00:00:00Z') });
    expect(later.factors.freshness).toBe(0);
    expect(later.score).toBeLessThan(scoreMatch({ profile: profile(), job: job(), now: NOW }).score);
  });

  it('accepts a repeated run without hidden state', () => {
    const matcher = () => scoreMatch({ profile: profile(), job: job(), now: NOW }).factors;
    expect(matcher()).toEqual(matcher());
  });
});

describe('scoreMatch — UNKNOWN is excluded, not negative (AC-010, SRS 4.6)', () => {
  const stripped = () =>
    job({
      requiredExperience: null,
      employmentType: EmploymentType.UNKNOWN,
      locationText: null,
      locationCategory: LocationCategory.UNKNOWN,
      remoteStatus: RemoteStatus.UNKNOWN,
      salary: {
        type: SalaryType.NEGOTIABLE,
        min: null,
        max: null,
        currency: null,
        period: null,
        evidence: 'Negotiable',
        confidence: asProbability(0.5),
      },
    });

  it('excludes factors with no evidence and renormalizes the remaining weights', () => {
    const match = scoreMatch({ profile: profile(), job: stripped(), now: NOW });

    expect(match.factors.experience).toBeNull();
    expect(match.factors.employment).toBeNull();
    expect(match.factors.location).toBeNull();
    expect(match.factors.salary).toBeNull();
    // known weight 60: (100*25 + 67*30 + 100*5) / 60 = 83.5
    expect(match.score).toBe(84);
    // 100 * (60/100) * ((.95*25 + .9*30 + 1*5)/60) = 55.75
    expect(match.confidence).toBe(56);
    expect(match.explanation).toContain('excluded (unknown evidence)');
  });

  it('scores an unknown factor above a factor the evidence contradicts', () => {
    const unknownLocation = scoreMatch({ profile: profile(), job: stripped(), now: NOW });
    const contradictedLocation = scoreMatch({
      profile: profile({ relocationPreference: RelocationPreference.NOT_WILLING }),
      job: job({ locationCategory: LocationCategory.ETHIOPIA_CITY, locationText: 'Jimma', remoteStatus: RemoteStatus.ONSITE }),
      now: NOW,
    });

    expect(contradictedLocation.factors.location).toBe(0);
    expect(unknownLocation.factors.location).toBeNull();
    expect(unknownLocation.score === 0).toBe(false);
    expect(unknownLocation.score).toBeGreaterThan(contradictedLocation.score);
  });

  it('lowers confidence, not score, when the posting is thinly described (ENG-028)', () => {
    const sufficient = scoreMatch({ profile: profile(), job: job(), now: NOW });
    const partial = scoreMatch({
      profile: profile(),
      job: job({ descriptionQuality: DescriptionQuality.PARTIAL }),
      now: NOW,
    });

    expect(partial.score).toBe(sufficient.score);
    expect(partial.factors.skills).toBe(sufficient.factors.skills);
    expect(partial.confidence).toBeLessThan(sufficient.confidence);
    expect(partial.confidence).toBe(81);
  });

  it('lowers confidence, not the other factors, when the posting evidences no skills (D3, ADR-0005 §2)', () => {
    // No stage extracts job-side skills yet, so every real job arrives with `skills: []` and the
    // Skills factor is UNKNOWN. The safeguard is that this reads as thin evidence about the
    // match, rather than as if the posting had been checked and lists no relevant skills.
    const evidencing = scoreMatch({ profile: profile(), job: job(), now: NOW });
    const withoutSkills = scoreMatch({ profile: profile(), job: job({ skills: [] }), now: NOW });

    expect(withoutSkills.factors.skills).toBeNull();
    expect(evidencing.factors.skills).toBe(67);

    for (const factor of ['role', 'experience', 'location', 'employment', 'freshness', 'salary'] as const) {
      expect(withoutSkills.factors[factor]).toBe(evidencing.factors[factor]);
    }

    expect(withoutSkills.confidence).toBeLessThan(evidencing.confidence);
    expect(withoutSkills.explanation).toContain('skills: the posting evidences no skills');
  });
});

describe('scoreMatch — role factor', () => {
  it('matches an alias of a target role', () => {
    const match = scoreMatch({ profile: profile(), job: job({ title: 'Backend Engineer' }), now: NOW });
    expect(match.factors.role).toBe(100);
  });

  it('gives partial credit when at least half the role tokens appear', () => {
    const match = scoreMatch({ profile: profile(), job: job({ title: 'Senior Software Engineer' }), now: NOW });
    expect(match.factors.role).toBe(100);

    const partial = scoreMatch({ profile: profile(), job: job({ title: 'Software Support Officer' }), now: NOW });
    // tokens {software, engineer}: one of two present -> 50
    expect(partial.factors.role).toBe(50);
  });

  it('scores zero only when the title is known and matches nothing', () => {
    const match = scoreMatch({ profile: profile(), job: job({ title: 'Sales Representative' }), now: NOW });
    expect(match.factors.role).toBe(0);
    expect(match.missingEvidence.some((line) => line.startsWith('role:'))).toBe(true);
  });

  it('excludes the factor when the title or the target roles are absent', () => {
    expect(scoreMatch({ profile: profile(), job: job({ title: null }), now: NOW }).factors.role).toBeNull();
    expect(scoreMatch({ profile: profile({ targetRoles: [] }), job: job(), now: NOW }).factors.role).toBeNull();
  });
});

describe('scoreMatch — skills factor', () => {
  const candidate = (name: string): { canonicalSkill: string; skillType: SkillEvidence; confidence: ReturnType<typeof asProbability> } => ({
    canonicalSkill: name,
    skillType: SkillEvidence.EXACT_MATCH,
    confidence: asProbability(1),
  });
  const jobSkill = (name: string, evidence: SkillEvidence, confidence = asProbability(1)): MatchableJobSkill => ({
    canonicalSkill: name,
    evidence,
    confidence,
  });

  const six = () =>
    profile({
      skills: ['A', 'B', 'C', 'D', 'E', 'F'].map(candidate),
    });

  it('applies the credit ladder across the whole candidate skill set', () => {
    const match = scoreMatch({
      profile: six(),
      job: job({
        skills: [
          jobSkill('A', SkillEvidence.EXACT_MATCH),
          jobSkill('B', SkillEvidence.RELATED_SKILL),
          jobSkill('C', SkillEvidence.TRANSFERABLE),
          jobSkill('D', SkillEvidence.AI_SUGGESTED, asProbability(0.5)),
          jobSkill('E', SkillEvidence.UNKNOWN),
        ],
      }),
      now: NOW,
    });

    // credits 1 + .5 + .25 + 0 (gated) + 0 = 1.75 of 6
    expect(match.factors.skills).toBe(29);
    expect(match.uncertainSkills).toEqual(['D']);
    expect(match.missingSkills).toEqual(['F']);
  });

  it('moves the score when an AI-suggested skill clears the confidence gate', () => {
    const gated = scoreMatch({
      profile: six(),
      job: job({ skills: [jobSkill('D', SkillEvidence.AI_SUGGESTED, asProbability(0.5))] }),
      now: NOW,
    });
    const cleared = scoreMatch({
      profile: six(),
      job: job({ skills: [jobSkill('D', SkillEvidence.AI_SUGGESTED, asProbability(0.9))] }),
      now: NOW,
    });

    expect(gated.factors.skills).toBe(0);
    expect(cleared.factors.skills).toBe(8);
  });

  it('excludes the factor when the posting evidences no skills', () => {
    const match = scoreMatch({ profile: profile(), job: job({ skills: [] }), now: NOW });
    expect(match.factors.skills).toBeNull();
    expect(match.missingSkills).toEqual([]);
  });

  it('excludes the factor when the profile has no skills', () => {
    expect(scoreMatch({ profile: profile({ skills: [] }), job: job(), now: NOW }).factors.skills).toBeNull();
  });

  it('matches skill names case- and punctuation-insensitively', () => {
    const match = scoreMatch({
      profile: profile({ skills: [candidate('Node JS')] }),
      job: job({ skills: [jobSkill('node.js', SkillEvidence.EXACT_MATCH)] }),
      now: NOW,
    });
    expect(match.factors.skills).toBe(100);
  });
});

describe('scoreMatch — experience factor', () => {
  it('gives full credit when the profile meets the requirement', () => {
    expect(scoreMatch({ profile: profile(), job: job(), now: NOW }).factors.experience).toBe(100);
  });

  it('scales partial credit by the shortfall', () => {
    const match = scoreMatch({
      profile: profile({ experienceYears: 3 }),
      job: job({ requiredExperience: { years: 5, confidence: asProbability(0.8) } }),
      now: NOW,
    });
    expect(match.factors.experience).toBe(60);
    expect(match.missingEvidence.some((line) => line.startsWith('experience:'))).toBe(true);
  });

  it('accepts a zero-experience posting for any candidate', () => {
    const match = scoreMatch({
      profile: profile({ experienceYears: 0 }),
      job: job({ requiredExperience: { years: 0, confidence: asProbability(0.9) } }),
      now: NOW,
    });
    expect(match.factors.experience).toBe(100);
  });

  it('excludes the factor when either side is unknown', () => {
    expect(scoreMatch({ profile: profile(), job: job({ requiredExperience: null }), now: NOW }).factors.experience).toBeNull();
    expect(scoreMatch({ profile: profile({ experienceYears: null }), job: job(), now: NOW }).factors.experience).toBeNull();
  });
});

describe('scoreMatch — location factor', () => {
  it('penalizes an on-site posting when remote work is required (SRS 4.6)', () => {
    const match = scoreMatch({
      profile: profile({ remotePreference: RemotePreference.REMOTE_REQUIRED }),
      job: job(),
      now: NOW,
    });
    expect(match.factors.location).toBe(0);
    expect(match.missingEvidence.some((line) => line.includes('remote work is required'))).toBe(true);
  });

  it('penalizes a remote posting when on-site work is required', () => {
    const match = scoreMatch({
      profile: profile({ remotePreference: RemotePreference.ONSITE_ONLY }),
      job: job({ remoteStatus: RemoteStatus.REMOTE, locationCategory: LocationCategory.ETHIOPIA_REMOTE, locationText: 'Remote' }),
      now: NOW,
    });
    expect(match.factors.location).toBe(0);
  });

  it('does not penalize on-site work when remote is only preferred', () => {
    const match = scoreMatch({
      profile: profile({ remotePreference: RemotePreference.REMOTE_PREFERRED }),
      job: job(),
      now: NOW,
    });
    expect(match.factors.location).toBe(100);
  });

  it('rates remote above hybrid for a remote-preferring candidate', () => {
    const hybrid = scoreMatch({
      profile: profile({ remotePreference: RemotePreference.REMOTE_PREFERRED }),
      job: job({ remoteStatus: RemoteStatus.HYBRID, locationCategory: LocationCategory.HYBRID, locationText: 'Hybrid' }),
      now: NOW,
    });
    expect(hybrid.factors.location).toBe(90);
  });

  it('scales an out-of-preference location by relocation willingness', () => {
    const outside = job({
      locationCategory: LocationCategory.ETHIOPIA_CITY,
      locationText: 'Hawassa',
      remoteStatus: RemoteStatus.ONSITE,
    });
    expect(scoreMatch({ profile: profile(), job: outside, now: NOW }).factors.location).toBe(50);
    expect(
      scoreMatch({ profile: profile({ relocationPreference: RelocationPreference.NOT_WILLING }), job: outside, now: NOW })
        .factors.location,
    ).toBe(0);
    expect(
      scoreMatch({ profile: profile({ relocationPreference: RelocationPreference.UNDECIDED }), job: outside, now: NOW })
        .factors.location,
    ).toBe(0);
  });

  it('matches an unrecognised place by preferred free text', () => {
    const match = scoreMatch({
      profile: profile({ locationPreferences: [{ category: LocationCategory.UNKNOWN, text: 'Bishoftu' }] }),
      job: job({ locationCategory: LocationCategory.UNKNOWN, locationText: 'Bishoftu, Oromia' }),
      now: NOW,
    });
    expect(match.factors.location).toBe(100);
  });

  it('excludes the factor when no place is stated at all (AC-008)', () => {
    const match = scoreMatch({
      profile: profile(),
      job: job({ locationText: null, locationCategory: LocationCategory.UNKNOWN, remoteStatus: RemoteStatus.UNKNOWN }),
      now: NOW,
    });
    expect(match.factors.location).toBeNull();
  });
});

describe('scoreMatch — employment factor', () => {
  it('scores a matching employment type full and a mismatching one zero', () => {
    expect(scoreMatch({ profile: profile(), job: job(), now: NOW }).factors.employment).toBe(100);
    const mismatch = scoreMatch({ profile: profile(), job: job({ employmentType: EmploymentType.PART_TIME }), now: NOW });
    expect(mismatch.factors.employment).toBe(0);
    expect(mismatch.missingEvidence.some((line) => line.startsWith('employment:'))).toBe(true);
  });

  it('excludes the factor when either side is unknown', () => {
    expect(scoreMatch({ profile: profile(), job: job({ employmentType: EmploymentType.UNKNOWN }), now: NOW }).factors.employment).toBeNull();
    expect(scoreMatch({ profile: profile({ employmentPreferences: [] }), job: job(), now: NOW }).factors.employment).toBeNull();
  });
});

describe('scoreMatch — freshness factor', () => {
  const publishedDaysAgo = (days: number) =>
    job({
      publishedDate: {
        calendar: CalendarType.GREGORIAN,
        publishedAt: new Date(NOW.getTime() - days * 86_400_000),
        originalText: null,
        confidence: asProbability(1),
        conversionMethod: null,
      },
    });

  it('scores a fresh posting full and decays monotonically to zero', () => {
    expect(scoreMatch({ profile: profile(), job: publishedDaysAgo(0), now: NOW }).factors.freshness).toBe(100);
    expect(scoreMatch({ profile: profile(), job: publishedDaysAgo(33.5), now: NOW }).factors.freshness).toBe(50);
    expect(scoreMatch({ profile: profile(), job: publishedDaysAgo(60), now: NOW }).factors.freshness).toBe(0);
    expect(scoreMatch({ profile: profile(), job: publishedDaysAgo(400), now: NOW }).factors.freshness).toBe(0);
  });

  it('treats a future publication date as brand new rather than throwing', () => {
    expect(scoreMatch({ profile: profile(), job: publishedDaysAgo(-5), now: NOW }).factors.freshness).toBe(100);
  });

  it('excludes the factor when the publication date is unknown', () => {
    const match = scoreMatch({
      profile: profile(),
      job: job({
        publishedDate: {
          calendar: CalendarType.UNKNOWN,
          publishedAt: null,
          originalText: null,
          confidence: asProbability(0),
          conversionMethod: null,
        },
      }),
      now: NOW,
    });
    expect(match.factors.freshness).toBeNull();
  });
});

describe('scoreMatch — salary factor', () => {
  const salary = (overrides: Partial<MatchableJob['salary']>): MatchableJob['salary'] => ({
    type: SalaryType.EXACT,
    min: asDecimalAmount('25000.00'),
    max: null,
    currency: 'ETB',
    period: SalaryPeriod.MONTH,
    evidence: null,
    confidence: asProbability(0.9),
    ...overrides,
  });

  it('scores a disclosed salary at or above the minimum full', () => {
    expect(
      scoreMatch({ profile: profile(), job: job({ salary: salary({ min: asDecimalAmount('20000.00') }) }), now: NOW }).factors
        .salary,
    ).toBe(100);
  });

  it('scales partial credit below the preferred minimum', () => {
    const match = scoreMatch({
      profile: profile(),
      job: job({ salary: salary({ min: asDecimalAmount('15000.00') }) }),
      now: NOW,
    });
    expect(match.factors.salary).toBe(75);
    expect(match.missingEvidence.some((line) => line.startsWith('salary:'))).toBe(true);
  });

  it('excludes undisclosed salaries unless the candidate requires disclosure', () => {
    const negotiable = salary({ type: SalaryType.NEGOTIABLE, min: null, max: null });
    const perScale = salary({ type: SalaryType.AS_PER_SCALE, min: null, max: null });

    expect(scoreMatch({ profile: profile(), job: job({ salary: negotiable }), now: NOW }).factors.salary).toBeNull();
    expect(scoreMatch({ profile: profile(), job: job({ salary: perScale }), now: NOW }).factors.salary).toBeNull();

    const demanding = profile({
      salaryPreference: {
        min: asDecimalAmount('20000.00'),
        currency: 'ETB',
        period: SalaryPeriod.MONTH,
        requireDisclosed: true,
      },
    });
    const forced = scoreMatch({ profile: demanding, job: job({ salary: negotiable }), now: NOW });
    expect(forced.factors.salary).toBe(0);
    expect(forced.missingEvidence.some((line) => line.includes('disclosed salary is required'))).toBe(true);
  });

  it('excludes a salary in another currency, period, or with no stated minimum', () => {
    const mismatched: DecimalAmount = asDecimalAmount('3000.00');
    expect(
      scoreMatch({
        profile: profile(),
        job: job({ salary: salary({ min: mismatched, currency: 'USD' }) }),
        now: NOW,
      }).factors.salary,
    ).toBeNull();
    expect(
      scoreMatch({
        profile: profile(),
        job: job({ salary: salary({ min: asDecimalAmount('90000.00'), period: SalaryPeriod.YEAR }) }),
        now: NOW,
      }).factors.salary,
    ).toBeNull();
    const noMinimum = profile({
      salaryPreference: { min: null, currency: 'ETB', period: null, requireDisclosed: false },
    });
    expect(scoreMatch({ profile: noMinimum, job: job(), now: NOW }).factors.salary).toBeNull();
  });

  it('excludes the factor when no salary preference is configured', () => {
    expect(scoreMatch({ profile: profile({ salaryPreference: null }), job: job(), now: NOW }).factors.salary).toBeNull();
  });
});

describe('scoreMatch — total function on hostile input (ENG-004)', () => {
  it('never throws and never yields an out-of-range score', () => {
    const hostile = scoreMatch({
      profile: profile({
        experienceYears: Number.NaN,
        profileVersion: '',
        skills: [{ canonicalSkill: '   ', skillType: SkillEvidence.UNKNOWN, confidence: asProbability(0) }],
        targetRoles: [{ title: '', aliases: [] }],
        locationPreferences: [],
        employmentPreferences: [],
        salaryPreference: null,
      }),
      job: job({
        title: '   ',
        requiredExperience: { years: -1, confidence: asProbability(1) },
        publishedDate: {
          calendar: CalendarType.UNKNOWN,
          publishedAt: new Date(Number.NaN),
          originalText: null,
          confidence: asProbability(0),
          conversionMethod: null,
        },
      }),
      now: new Date(Number.NaN),
    });

    expect(hostile.score).toBe(0);
    expect(hostile.confidence).toBe(0);
    expect(Number.isInteger(hostile.score)).toBe(true);
    expect(hostile.score).toBeGreaterThanOrEqual(0);
    expect(hostile.score).toBeLessThanOrEqual(100);
    expect(hostile.confidence).toBeLessThanOrEqual(100);
    expect(hostile.explanation).toContain('no factor had usable evidence');
  });

  it('ignores blank skill names on both sides without throwing', () => {
    const match = scoreMatch({
      profile: profile({
        skills: [
          { canonicalSkill: '', skillType: SkillEvidence.EXACT_MATCH, confidence: asProbability(1) },
          { canonicalSkill: 'TypeScript', skillType: SkillEvidence.EXACT_MATCH, confidence: asProbability(1) },
        ],
      }),
      job: job({
        skills: [
          { canonicalSkill: '   ', evidence: SkillEvidence.EXACT_MATCH, confidence: asProbability(1) },
          { canonicalSkill: 'TypeScript', evidence: SkillEvidence.CANONICAL_ALIAS, confidence: asProbability(1) },
        ],
      }),
      now: NOW,
    });
    expect(match.factors.skills).toBe(100);
  });
});
