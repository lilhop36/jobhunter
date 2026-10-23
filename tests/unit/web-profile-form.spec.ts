import { describe, expect, it } from 'vitest';
import {
  EmploymentType,
  LocationCategory,
  RelocationPreference,
  RemotePreference,
  SalaryPeriod,
  SkillEvidence,
} from '@domain/enums';
import { asDecimalAmount, asProbability } from '@domain/types';
import type { UnversionedCandidateProfile } from '@domain/matching';
import {
  formValuesFromInput,
  parseProfileForm,
  profileForm,
  toFormValues,
  type ProfileFormValues,
} from '../../apps/api/web/profile-form';
import { toProfile } from '../../apps/api/routes/profile';

/**
 * The `/profile` form is a trust boundary (ADR-0009): a browser posts strings, but a crafted
 * request can post anything, so every field is validated here against the same rules the JSON
 * route gets from Ajv. These tests pin the acceptance rules, the "reject, don't silently drop"
 * behaviour, and the escaping of hostile input in the re-rendered form.
 */

function baseValues(overrides: Partial<ProfileFormValues> = {}): ProfileFormValues {
  return {
    experienceYears: '5',
    remotePreference: RemotePreference.NO_PREFERENCE,
    relocationPreference: RelocationPreference.UNDECIDED,
    salaryMin: '50000',
    salaryCurrency: 'ETB',
    salaryPeriod: SalaryPeriod.MONTH,
    requireDisclosed: false,
    employmentPreferences: [EmploymentType.FULL_TIME],
    skills: 'TypeScript | EXACT_MATCH | 0.9\nDocker',
    targetRoles: 'Backend Engineer | Backend Dev, API Engineer',
    locationPreferences: 'ADDIS_ABABA\nETHIOPIA_REMOTE | anywhere in Ethiopia',
    ...overrides,
  };
}

function storedProfile(): UnversionedCandidateProfile {
  return {
    experienceYears: 5,
    remotePreference: RemotePreference.REMOTE_PREFERRED,
    relocationPreference: RelocationPreference.WILLING,
    salaryPreference: {
      min: asDecimalAmount('50000.00'),
      currency: 'ETB',
      period: SalaryPeriod.MONTH,
      requireDisclosed: true,
    },
    employmentPreferences: [EmploymentType.FULL_TIME, EmploymentType.CONTRACT],
    skills: [
      { canonicalSkill: 'TypeScript', skillType: SkillEvidence.EXACT_MATCH, confidence: asProbability(0.9) },
      { canonicalSkill: 'Docker', skillType: SkillEvidence.RELATED_SKILL, confidence: asProbability(0.5) },
    ],
    targetRoles: [
      { title: 'Backend Engineer', aliases: ['Backend Dev', 'API Engineer'] },
      { title: 'Platform Engineer', aliases: [] },
    ],
    locationPreferences: [
      { category: LocationCategory.ADDIS_ABABA, text: null },
      { category: LocationCategory.ETHIOPIA_REMOTE, text: 'anywhere in Ethiopia' },
    ],
  };
}

describe('parseProfileForm', () => {
  it('accepts a well-formed submission and maps every field', () => {
    const parsed = parseProfileForm(baseValues());

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.body.experienceYears).toBe(5);
    expect(parsed.body.remotePreference).toBe(RemotePreference.NO_PREFERENCE);
    expect(parsed.body.relocationPreference).toBe(RelocationPreference.UNDECIDED);
    expect(parsed.body.salaryPreference).toEqual({
      min: '50000',
      currency: 'ETB',
      period: SalaryPeriod.MONTH,
      requireDisclosed: false,
    });
    expect(parsed.body.employmentPreferences).toEqual([EmploymentType.FULL_TIME]);
    expect(parsed.body.skills).toEqual([
      { canonicalSkill: 'TypeScript', skillType: SkillEvidence.EXACT_MATCH, confidence: 0.9 },
      // A bare name defaults to a firmly held, exactly-matched skill.
      { canonicalSkill: 'Docker', skillType: SkillEvidence.EXACT_MATCH, confidence: 1 },
    ]);
    expect(parsed.body.targetRoles).toEqual([
      { title: 'Backend Engineer', aliases: ['Backend Dev', 'API Engineer'] },
    ]);
    expect(parsed.body.locationPreferences).toEqual([
      { category: LocationCategory.ADDIS_ABABA, text: null },
      { category: LocationCategory.ETHIOPIA_REMOTE, text: 'anywhere in Ethiopia' },
    ]);
  });

  it('round-trips a stored profile through the form and back unchanged', () => {
    const profile = storedProfile();
    const parsed = parseProfileForm(toFormValues({ ...profile, profileVersion: 'v1' }));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // toProfile canonicalises the amount the same way PUT /api/profile does.
    expect(toProfile(parsed.body)).toEqual(profile);
  });

  it('treats an empty salary group as "not declared", not as a stated blank', () => {
    const parsed = parseProfileForm(
      baseValues({ salaryMin: '', salaryCurrency: '', salaryPeriod: '' }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.body.salaryPreference).toBeNull();
  });

  it('rejects an experience value that is not a whole number of years', () => {
    for (const value of ['lots', '5.5', '-1', '81']) {
      const parsed = parseProfileForm(baseValues({ experienceYears: value }));
      expect(parsed.ok).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.errors.join(' ')).toContain('Experience years');
    }
  });

  it('rejects unknown enum values', () => {
    const remote = parseProfileForm(baseValues({ remotePreference: 'SOMETIMES' }));
    const relocation = parseProfileForm(baseValues({ relocationPreference: 'MAYBE' }));

    expect(remote.ok).toBe(false);
    expect(relocation.ok).toBe(false);
  });

  it('rejects a malformed salary floor, currency or period', () => {
    for (const value of ['12,000', '-5', '50.999', '.5']) {
      expect(parseProfileForm(baseValues({ salaryMin: value })).ok).toBe(false);
    }
    expect(parseProfileForm(baseValues({ salaryCurrency: 'ETB1' })).ok).toBe(false);
    expect(parseProfileForm(baseValues({ salaryPeriod: 'FORTNIGHT' })).ok).toBe(false);
  });

  it('rejects an unknown skill evidence type or an out-of-range confidence', () => {
    const type = parseProfileForm(baseValues({ skills: 'TypeScript | SORCERY' }));
    const confidence = parseProfileForm(baseValues({ skills: 'TypeScript | EXACT_MATCH | 5' }));
    const nameless = parseProfileForm(baseValues({ skills: ' | EXACT_MATCH | 0.5' }));

    expect(type.ok).toBe(false);
    expect(confidence.ok).toBe(false);
    expect(nameless.ok).toBe(false);
    if (!type.ok) expect(type.errors.join(' ')).toContain('SORCERY');
    if (!confidence.ok) expect(confidence.errors.join(' ')).toContain('confidence');
  });

  it('rejects a role without a title and a location with an unknown category', () => {
    const role = parseProfileForm(baseValues({ targetRoles: ' | alias' }));
    const location = parseProfileForm(baseValues({ locationPreferences: 'ATLANTIS' }));

    expect(role.ok).toBe(false);
    expect(location.ok).toBe(false);
    if (!location.ok) expect(location.errors.join(' ')).toContain('ADDIS_ABABA');
  });

  it('reports every problem at once and echoes the submitted values back', () => {
    const parsed = parseProfileForm(
      baseValues({ experienceYears: 'lots', remotePreference: 'SOMETIMES' }),
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.length).toBeGreaterThanOrEqual(2);
    // The values survive so the form can be shown again filled in.
    expect(parsed.values.experienceYears).toBe('lots');
  });
});

describe('formValuesFromInput', () => {
  it('normalises a raw form body, uppercasing the currency and reading the checkbox', () => {
    const values = formValuesFromInput(
      {
        experienceYears: ' 7 ',
        salaryCurrency: 'etb',
        employmentPreferences: [EmploymentType.FULL_TIME, EmploymentType.CONTRACT],
        skills: 'Go',
        requireDisclosed: 'on',
      },
      true,
    );

    expect(values.experienceYears).toBe('7');
    expect(values.salaryCurrency).toBe('ETB');
    expect(values.employmentPreferences).toEqual([EmploymentType.FULL_TIME, EmploymentType.CONTRACT]);
    expect(values.skills).toBe('Go');
    expect(values.requireDisclosed).toBe(true);
  });

  it('treats a single repeated key and a missing key alike', () => {
    const values = formValuesFromInput({ employmentPreferences: EmploymentType.INTERNSHIP }, false);

    expect(values.employmentPreferences).toEqual([EmploymentType.INTERNSHIP]);
    expect(values.requireDisclosed).toBe(false);
    expect(values.experienceYears).toBe('');
  });
});

describe('profileForm', () => {
  it('carries the CSRF token in a hidden field and posts to this origin', () => {
    const markup = profileForm(baseValues(), [], 'csrf-token-value').text;

    expect(markup).toContain('<form method="post" action="/profile">');
    expect(markup).toContain('name="_csrf" value="csrf-token-value"');
  });

  it('lists the problems when a submission was rejected', () => {
    const markup = profileForm(baseValues(), ['Experience years must be a whole number'], 't').text;

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Experience years must be a whole number');
  });

  it('escapes hostile textarea input rather than emitting it', () => {
    const markup = profileForm(
      baseValues({ targetRoles: `<script>alert('x')</script>` }),
      [],
      't',
    ).text;

    expect(markup).not.toContain('<script');
    expect(markup).toContain('&lt;script&gt;');
  });
});