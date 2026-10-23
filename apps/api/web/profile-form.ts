import {
  EmploymentType,
  LocationCategory,
  RelocationPreference,
  RemotePreference,
  SalaryPeriod,
  SkillEvidence,
} from '@domain/enums';
import { isDecimalAmount, isProbability } from '@domain/types';
import type { CandidateProfile } from '@domain/types';
import { html, raw, type Html } from './html';
import type { ProfileBody } from '../routes/profile';

/**
 * The `/profile` editor (SRS 3.1, ADR-0009), in two halves: a form template and a
 * parser that turns the submitted fields back into a `ProfileBody`.
 *
 * The parser is the trust boundary. A browser form posts strings, and a form is
 * only a convenience — a crafted request can carry any value — so every field is
 * validated here against the **same** rules `PUT /api/profile` gets from its Ajv
 * schema (`apps/api/schemas.ts::putProfileBody`). The values are then handed to
 * the same `toProfile` the JSON route uses, so both paths store the same profile.
 *
 * A rejected field is reported, never dropped: silently saving a profile different
 * from the one submitted would be a fact the candidate never asserted (ENG-001).
 */

/** What the form holds: everything is a string because a form only ever sends strings. */
export interface ProfileFormValues {
  experienceYears: string;
  remotePreference: string;
  relocationPreference: string;
  salaryMin: string;
  salaryCurrency: string;
  salaryPeriod: string;
  requireDisclosed: boolean;
  employmentPreferences: string[];
  /** One `Name | skillType | confidence` per line; skillType and confidence optional. */
  skills: string;
  /** One `Title | alias, alias` per line; aliases optional. */
  targetRoles: string;
  /** One `CATEGORY | free text` per line; the text is optional. */
  locationPreferences: string;
}

export type ProfileFormParse =
  | { ok: true; body: ProfileBody }
  | { ok: false; values: ProfileFormValues; errors: string[] };

const REMOTE_VALUES = Object.values(RemotePreference);
const RELOCATION_VALUES = Object.values(RelocationPreference);
const EMPLOYMENT_VALUES = Object.values(EmploymentType);
const SALARY_PERIOD_VALUES = Object.values(SalaryPeriod);
const SKILL_EVIDENCE_VALUES = Object.values(SkillEvidence);
const LOCATION_VALUES = Object.values(LocationCategory);

const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const INTEGER_PATTERN = /^\d+$/;

function isOneOf<T extends string>(values: readonly T[], value: string): value is T {
  return (values as readonly string[]).includes(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Repeated form keys arrive as an array; a single key arrives as a string. */
function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value === 'string') return [value];
  return [];
}

function lines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** The stored profile as form values. Missing values are empty, never guessed. */
export function toFormValues(profile: CandidateProfile): ProfileFormValues {
  return {
    experienceYears: profile.experienceYears === null ? '' : String(profile.experienceYears),
    remotePreference: profile.remotePreference,
    relocationPreference: profile.relocationPreference,
    salaryMin: profile.salaryPreference?.min ?? '',
    salaryCurrency: profile.salaryPreference?.currency ?? '',
    salaryPeriod: profile.salaryPreference?.period ?? '',
    requireDisclosed: profile.salaryPreference?.requireDisclosed ?? false,
    employmentPreferences: [...profile.employmentPreferences],
    skills: profile.skills
      .map((skill) => `${skill.canonicalSkill} | ${skill.skillType} | ${skill.confidence}`)
      .join('\n'),
    targetRoles: profile.targetRoles
      .map((role) => (role.aliases.length === 0 ? role.title : `${role.title} | ${role.aliases.join(', ')}`))
      .join('\n'),
    locationPreferences: profile.locationPreferences
      .map((location) => (location.text === null ? location.category : `${location.category} | ${location.text}`))
      .join('\n'),
  };
}

/** The submitted fields, as they were sent, so a rejected form can be shown again filled in. */
export function formValuesFromInput(input: Record<string, unknown>, requireDisclosed: boolean): ProfileFormValues {
  return {
    experienceYears: asString(input['experienceYears']).trim(),
    remotePreference: asString(input['remotePreference']).trim(),
    relocationPreference: asString(input['relocationPreference']).trim(),
    salaryMin: asString(input['salaryMin']).trim(),
    salaryCurrency: asString(input['salaryCurrency']).trim().toUpperCase(),
    salaryPeriod: asString(input['salaryPeriod']).trim(),
    requireDisclosed,
    employmentPreferences: asStringArray(input['employmentPreferences']).map((value) => value.trim()),
    skills: asString(input['skills']),
    targetRoles: asString(input['targetRoles']),
    locationPreferences: asString(input['locationPreferences']),
  };
}

export function parseProfileForm(values: ProfileFormValues): ProfileFormParse {
  const errors: string[] = [];

  const experienceYears = ((): number | null => {
    if (values.experienceYears === '') return null;
    if (!INTEGER_PATTERN.test(values.experienceYears)) {
      errors.push('Experience years must be a whole number of years, or empty.');
      return null;
    }
    const years = Number(values.experienceYears);
    if (years > 80) {
      errors.push('Experience years cannot exceed 80.');
      return null;
    }
    return years;
  })();

  const remotePreference = ((): RemotePreference | null => {
    if (!isOneOf(REMOTE_VALUES, values.remotePreference)) {
      errors.push(`Remote preference must be one of: ${REMOTE_VALUES.join(', ')}.`);
      return null;
    }
    return values.remotePreference;
  })();

  const relocationPreference = ((): RelocationPreference | null => {
    if (!isOneOf(RELOCATION_VALUES, values.relocationPreference)) {
      errors.push(`Relocation preference must be one of: ${RELOCATION_VALUES.join(', ')}.`);
      return null;
    }
    return values.relocationPreference;
  })();

  // Salary is one optional group: stating nothing at all is "not declared" (`null`), which is a
  // different fact from declaring a floor with no currency.
  const salaryStated =
    values.salaryMin !== '' || values.salaryCurrency !== '' || values.salaryPeriod !== '';
  const salaryPreference = ((): ProfileBody['salaryPreference'] => {
    if (!salaryStated) return null;
    if (values.salaryMin !== '' && !isDecimalAmount(values.salaryMin)) {
      errors.push('Salary floor must be a positive number with at most two decimals, or empty.');
    }
    if (values.salaryCurrency !== '' && !CURRENCY_PATTERN.test(values.salaryCurrency)) {
      errors.push('Salary currency must be a three-letter ISO 4217 code, or empty.');
    }
    if (values.salaryPeriod !== '' && !isOneOf(SALARY_PERIOD_VALUES, values.salaryPeriod)) {
      errors.push(`Salary period must be one of: ${SALARY_PERIOD_VALUES.join(', ')}.`);
    }
    return {
      min: values.salaryMin === '' ? null : values.salaryMin,
      currency: values.salaryCurrency === '' ? null : values.salaryCurrency,
      period: values.salaryPeriod === '' ? null : (values.salaryPeriod as SalaryPeriod),
      requireDisclosed: values.requireDisclosed,
    };
  })();

  const employmentPreferences = [...new Set(values.employmentPreferences)].flatMap((value) => {
    if (!isOneOf(EMPLOYMENT_VALUES, value)) {
      errors.push(`Employment type "${value}" is not recognised.`);
      return [];
    }
    return [value];
  });

  const skills = lines(values.skills).flatMap((line, index) => {
    const [name, type, confidence] = line.split('|').map((part) => part.trim());
    if (name === undefined || name === '') {
      errors.push(`Skill line ${index + 1}: a skill name is required.`);
      return [];
    }
    const skillType = type === undefined || type === '' ? SkillEvidence.EXACT_MATCH : (type as SkillEvidence);
    if (!isOneOf(SKILL_EVIDENCE_VALUES, skillType)) {
      errors.push(`Skill "${name}": evidence type "${String(type)}" is not one of ${SKILL_EVIDENCE_VALUES.join(', ')}.`);
      return [];
    }
    let probability = 1;
    if (confidence !== undefined && confidence !== '') {
      probability = Number(confidence);
      if (!isProbability(probability)) {
        errors.push(`Skill "${name}": confidence must be a number between 0 and 1.`);
        return [];
      }
    }
    return [{ canonicalSkill: name, skillType, confidence: probability }];
  });

  const targetRoles = lines(values.targetRoles).flatMap((line, index) => {
    const [title, aliasesText] = line.split('|').map((part) => part.trim());
    if (title === undefined || title === '') {
      errors.push(`Target role line ${index + 1}: a role title is required.`);
      return [];
    }
    const aliases = [
      ...new Set(
        (aliasesText ?? '')
          .split(',')
          .map((alias) => alias.trim())
          .filter((alias) => alias !== ''),
      ),
    ];
    return [{ title, aliases }];
  });

  const locationPreferences = lines(values.locationPreferences).flatMap((line, index) => {
    const [category, text] = line.split('|').map((part) => part.trim());
    if (category === undefined || !isOneOf(LOCATION_VALUES, category)) {
      errors.push(
        `Location line ${index + 1}: the category must be one of ${LOCATION_VALUES.join(', ')}.`,
      );
      return [];
    }
    return [{ category, text: text === undefined || text === '' ? null : text }];
  });

  if (errors.length > 0) return { ok: false, values, errors };

  return {
    ok: true,
    body: {
      experienceYears,
      remotePreference: remotePreference as RemotePreference,
      relocationPreference: relocationPreference as RelocationPreference,
      salaryPreference,
      employmentPreferences,
      skills,
      targetRoles,
      locationPreferences,
    },
  };
}

function selectField(name: string, values: readonly string[], chosen: string, humanise = false): Html {
  return html`<select name="${name}">${values.map(
    (value) =>
      html`<option value="${value}"${raw(value === chosen ? ' selected' : '')}>${
        humanise ? value.replace(/_/g, ' ').toLowerCase() : value
      }</option>`,
  )}</select>`;
}

function errorSummary(errors: string[]): Html {
  if (errors.length === 0) return html``;
  return html`<div class="errors" role="alert">
<p><strong>Nothing was saved. Please correct the following:</strong></p>
<ul>${errors.map((error) => html`<li>${error}</li>`)}</ul>
</div>`;
}

/**
 * The whole-profile editor. A save states the whole profile (SRS 3.4), so every
 * field is present; `values` is either the stored profile or the rejected
 * submission, which makes the same template serve both the first render and the
 * "fix these fields" re-render.
 */
export function profileForm(values: ProfileFormValues, errors: string[], csrfToken: string): Html {
  return html`${errorSummary(errors)}
<form method="post" action="/profile">
<input type="hidden" name="_csrf" value="${csrfToken}">

<fieldset>
<legend>Experience and preferences</legend>
<label>Years of professional experience
<input type="number" name="experienceYears" min="0" max="80" step="1" value="${values.experienceYears}">
</label>
<label>Remote preference
${selectField('remotePreference', REMOTE_VALUES, values.remotePreference, true)}
</label>
<label>Relocation
${selectField('relocationPreference', RELOCATION_VALUES, values.relocationPreference, true)}
</label>
</fieldset>

<fieldset>
<legend>Salary expectation (leave empty if you have not stated one)</legend>
<label>Minimum acceptable amount
<input type="text" name="salaryMin" inputmode="decimal" value="${values.salaryMin}" placeholder="e.g. 50000">
</label>
<label>Currency (ISO 4217 code)
<input type="text" name="salaryCurrency" value="${values.salaryCurrency}" maxlength="3">
</label>
<label>Period
${selectField('salaryPeriod', ['', ...SALARY_PERIOD_VALUES], values.salaryPeriod, true)}
</label>
<label class="checkbox">
<input type="checkbox" name="requireDisclosed"${raw(values.requireDisclosed ? ' checked' : '')}>
Treat an undisclosed salary as a negative signal
</label>
</fieldset>

<fieldset>
<legend>Employment types accepted</legend>
<p class="hint">None selected means you have not stated a preference.</p>
${EMPLOYMENT_VALUES.map(
  (value) =>
    html`<label class="checkbox">
<input type="checkbox" name="employmentPreferences" value="${value}"${raw(
      values.employmentPreferences.includes(value) ? ' checked' : '',
    )}>
${value.replace(/_/g, ' ').toLowerCase()}
</label>`,
)}
</fieldset>

<fieldset>
<legend>Skills</legend>
<p class="hint">One per line: <code>Name</code>, or <code>Name | evidence | confidence</code> where
evidence is one of ${SKILL_EVIDENCE_VALUES.join(', ')} (default ${SkillEvidence.EXACT_MATCH}) and
confidence is 0&ndash;1 (default 1).</p>
<textarea name="skills" rows="6">${values.skills}</textarea>
</fieldset>

<fieldset>
<legend>Target roles</legend>
<p class="hint">One per line: <code>Title</code>, or <code>Title | alias, alias</code>.</p>
<textarea name="targetRoles" rows="5">${values.targetRoles}</textarea>
</fieldset>

<fieldset>
<legend>Location preferences</legend>
<p class="hint">One per line: <code>CATEGORY</code>, or <code>CATEGORY | free text</code>. Categories:
${LOCATION_VALUES.join(', ')}.</p>
<textarea name="locationPreferences" rows="5">${values.locationPreferences}</textarea>
</fieldset>

<button type="submit">Save profile</button>
</form>`;
}