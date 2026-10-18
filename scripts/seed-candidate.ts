import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import {
  EmploymentType,
  LocationCategory,
  RelocationPreference,
  RemotePreference,
  SalaryPeriod,
  SkillEvidence,
} from '@domain/enums';
import { asDecimalAmount, asProbability, type DecimalAmount, type Probability } from '@domain/types';
import { UnversionedCandidateProfile } from '@domain/matching/profile-version';
import { PrismaCandidateProfileRepository } from '@infrastructure/ingestion/prisma-candidate-profile-repository';

/**
 * Operator-run seed: writes one or more candidate matching profiles (FR-012, SRS 4.5, 5.2).
 *
 *   npm run seed:candidate                          # reads ./candidate-profiles.json
 *   npm run seed:candidate -- --file ./mine.json    # reads an explicit file
 *   npm run seed:candidate -- --template            # prints the file format and exits
 *
 * The file holds the candidates' declared facts — JobHunter never invents
 * candidate information (ENG-001). The file may be a single profile object or an
 * array of them; every entry is one candidate identified by their email, and
 * re-running replaces that candidate's profile in place.
 *
 * The vocabulary is field-agnostic: skills are canonical names, roles are titles
 * with aliases, locations are categories. This seed works the same for software,
 * health, construction, finance or any other field — nothing here is
 * domain-specific, and adding a field means adding a profile, not changing code.
 *
 * Validation is strict and runs before anything is written, so a malformed file
 * cannot leave a half-seeded profile behind. Skills, target roles and location
 * preferences are replaced wholesale on re-seed: a fact the candidate no longer
 * lists is removed rather than left behind.
 *
 * The profile's revision is derived from its content, not from a counter
 * (src/domain/matching/profile-version), so a stored JobMatch always stays
 * explainable after a re-seed.
 *
 * The file must stay out of version control: it holds personal data.
 */

/** Two examples in deliberately different fields, to show nothing is tech-specific. */
const TEMPLATE = [
  {
    user: { email: 'candidate-a@example.com' },
    experienceYears: 3,
    remotePreference: 'NO_PREFERENCE',
    relocationPreference: 'WILLING',
    salaryPreference: { min: '20000.00', currency: 'ETB', period: 'MONTH', requireDisclosed: false },
    employmentPreferences: ['FULL_TIME'],
    skills: [
      { canonicalSkill: 'TypeScript', skillType: 'EXACT_MATCH', confidence: 0.95 },
      { canonicalSkill: 'PostgreSQL', skillType: 'EXACT_MATCH', confidence: 0.9 },
    ],
    targetRoles: [{ title: 'Software Engineer', aliases: ['Backend Engineer', 'Software Developer'] }],
    locationPreferences: [{ category: 'ADDIS_ABABA', text: null }],
  },
  {
    user: { email: 'candidate-b@example.com' },
    experienceYears: 5,
    remotePreference: 'ONSITE_ONLY',
    relocationPreference: 'NOT_WILLING',
    salaryPreference: { min: '15000.00', currency: 'ETB', period: 'MONTH', requireDisclosed: true },
    employmentPreferences: ['FULL_TIME', 'PART_TIME'],
    skills: [
      { canonicalSkill: 'Patient Care', skillType: 'EXACT_MATCH', confidence: 0.95 },
      { canonicalSkill: 'BLS Certification', skillType: 'EXACT_MATCH', confidence: 1 },
    ],
    targetRoles: [{ title: 'Registered Nurse', aliases: ['Staff Nurse', 'Clinical Nurse'] }],
    locationPreferences: [{ category: 'ADDIS_ABABA', text: null }],
  },
];

interface ParsedProfile {
  email: string;
  profile: UnversionedCandidateProfile;
}

function fail(message: string): never {
  throw new Error(message);
}

function expectObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectOptionalInteger(value: unknown, path: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || !Number.isFinite(value)) {
    fail(`${path} must be a non-negative integer or null`);
  }
  return value;
}

function expectEnum<T extends object>(
  value: unknown,
  enumObject: T,
  path: string,
  allowNull: boolean = false,
): T[keyof T] | null {
  if (value === null || value === undefined) {
    if (allowNull) return null;
    fail(`${path} is required`);
  }
  if (typeof value !== 'string' || !(value in enumObject)) {
    fail(`${path} must be one of ${Object.keys(enumObject).join(', ')}`);
  }
  return value as T[keyof T];
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(`${path} must be a non-empty string`);
  return value;
}

function expectOptionalString(value: unknown, path: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.trim() === '') fail(`${path} must be a non-empty string or null`);
  return value;
}

function expectBoolean(value: unknown, path: string, defaultValue: boolean = false): boolean {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'boolean') fail(`${path} must be a boolean`);
  return value;
}

function expectStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) fail(`${path} must be an array of strings`);
  return value.map((entry, index) => expectString(entry, `${path}[${index}]`));
}

function expectDecimal(value: unknown, path: string): DecimalAmount | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') fail(`${path} must be a decimal string or null`);
  try {
    return asDecimalAmount(value);
  } catch (error) {
    fail(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseOneProfile(entry: unknown, path: string): ParsedProfile {
  const root = expectObject(entry, path);
  const allowedTop = new Set([
    'user',
    'experienceYears',
    'remotePreference',
    'relocationPreference',
    'salaryPreference',
    'employmentPreferences',
    'skills',
    'targetRoles',
    'locationPreferences',
  ]);
  for (const key of Object.keys(root)) {
    if (!allowedTop.has(key)) fail(`${path}: unknown key "${key}"`);
  }

  const user = expectObject(root.user, `${path}.user`);
  if (Object.keys(user).length !== 1 || !('email' in user)) fail(`${path}.user must contain only "email"`);
  const email = expectString(user.email, `${path}.user.email`);

  const experienceYears = expectOptionalInteger(root.experienceYears, `${path}.experienceYears`);

  const remotePreference = expectEnum(root.remotePreference, RemotePreference, `${path}.remotePreference`);
  const relocationPreference = expectEnum(
    root.relocationPreference,
    RelocationPreference,
    `${path}.relocationPreference`,
  );

  let salaryPreference: UnversionedCandidateProfile['salaryPreference'] = null;
  if (root.salaryPreference !== null && root.salaryPreference !== undefined) {
    const sp = expectObject(root.salaryPreference, `${path}.salaryPreference`);
    const allowedSp = new Set(['min', 'currency', 'period', 'requireDisclosed']);
    for (const key of Object.keys(sp)) {
      if (!allowedSp.has(key)) fail(`${path}.salaryPreference: unknown key "${key}"`);
    }
    salaryPreference = {
      min: expectDecimal(sp.min, `${path}.salaryPreference.min`),
      currency: expectOptionalString(sp.currency, `${path}.salaryPreference.currency`),
      period: expectEnum(sp.period, SalaryPeriod, `${path}.salaryPreference.period`, true),
      requireDisclosed: expectBoolean(sp.requireDisclosed, `${path}.salaryPreference.requireDisclosed`, false),
    };
  }

  const employmentPreferences = expectStringArray(
    root.employmentPreferences === undefined ? [] : root.employmentPreferences,
    `${path}.employmentPreferences`,
  ).map((value, index) => {
    if (!(value in EmploymentType)) fail(`${path}.employmentPreferences[${index}] must be a valid EmploymentType`);
    return value as EmploymentType;
  });

  const skillsRaw = root.skills === undefined ? [] : root.skills;
  if (!Array.isArray(skillsRaw)) fail(`${path}.skills must be an array`);
  const skills = skillsRaw.map((entry, index) => {
    const skillPath = `${path}.skills[${index}]`;
    const skill = expectObject(entry, skillPath);
    const allowed = new Set(['canonicalSkill', 'skillType', 'confidence']);
    for (const key of Object.keys(skill)) {
      if (!allowed.has(key)) fail(`${skillPath}: unknown key "${key}"`);
    }
    const canonicalSkill = expectString(skill.canonicalSkill, `${skillPath}.canonicalSkill`);
    const skillType = expectEnum(skill.skillType, SkillEvidence, `${skillPath}.skillType`);
    if (skillType === null) fail(`${skillPath}.skillType is required`);
    let confidence: Probability;
    try {
      confidence = asProbability(skill.confidence as number);
    } catch (error) {
      fail(`${skillPath}.confidence: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { canonicalSkill, skillType: skillType as SkillEvidence, confidence };
  });

  // Case-insensitive duplicate check (the DB unique is case-sensitive).
  const skillNames = new Set<string>();
  for (const skill of skills) {
    const key = skill.canonicalSkill.toLowerCase();
    if (skillNames.has(key)) fail(`${path}: duplicate skill "${skill.canonicalSkill}"`);
    skillNames.add(key);
  }

  const rolesRaw = root.targetRoles === undefined ? [] : root.targetRoles;
  if (!Array.isArray(rolesRaw)) fail(`${path}.targetRoles must be an array`);
  const targetRoles = rolesRaw.map((entry, index) => {
    const rolePath = `${path}.targetRoles[${index}]`;
    const role = expectObject(entry, rolePath);
    const allowed = new Set(['title', 'aliases']);
    for (const key of Object.keys(role)) {
      if (!allowed.has(key)) fail(`${rolePath}: unknown key "${key}"`);
    }
    return {
      title: expectString(role.title, `${rolePath}.title`),
      aliases: expectStringArray(role.aliases === undefined ? [] : role.aliases, `${rolePath}.aliases`),
    };
  });

  const roleTitles = new Set<string>();
  for (const role of targetRoles) {
    const key = role.title.toLowerCase();
    if (roleTitles.has(key)) fail(`${path}: duplicate target role "${role.title}"`);
    roleTitles.add(key);
  }

  const locationsRaw = root.locationPreferences === undefined ? [] : root.locationPreferences;
  if (!Array.isArray(locationsRaw)) fail(`${path}.locationPreferences must be an array`);
  const locationPreferences = locationsRaw.map((entry, index) => {
    const locationPath = `${path}.locationPreferences[${index}]`;
    const location = expectObject(entry, locationPath);
    const allowed = new Set(['category', 'text']);
    for (const key of Object.keys(location)) {
      if (!allowed.has(key)) fail(`${locationPath}: unknown key "${key}"`);
    }
    const category = expectEnum(location.category, LocationCategory, `${locationPath}.category`);
    if (category === null) fail(`${locationPath}.category is required`);
    return {
      category: category as LocationCategory,
      text: expectOptionalString(location.text, `${locationPath}.text`),
    };
  });

  const locationKeys = new Set<string>();
  for (const location of locationPreferences) {
    const key = `${location.category}:${location.text ?? ''}`.toLowerCase();
    if (locationKeys.has(key)) fail(`${path}: duplicate location preference "${location.category}"`);
    locationKeys.add(key);
  }

  return {
    email,
    profile: {
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

/** Accepts a single profile object or an array of them. */
function parseProfileFile(text: string): ParsedProfile[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const entries = Array.isArray(parsed) ? parsed : [parsed];
  if (entries.length === 0) fail('the file contains no profiles');

  const parsedProfiles = entries.map((entry, index) =>
    parseOneProfile(entry, entries.length === 1 ? 'profile' : `profiles[${index}]`),
  );

  const emails = new Set<string>();
  for (const parsedProfile of parsedProfiles) {
    const key = parsedProfile.email.toLowerCase();
    if (emails.has(key)) fail(`duplicate profile for "${parsedProfile.email}"`);
    emails.add(key);
  }

  return parsedProfiles;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--template')) {
    process.stderr.write('example file: two candidates in different fields — keep one, or add more\n');
    process.stdout.write(`${JSON.stringify(TEMPLATE, null, 2)}\n`);
    return;
  }

  const fileIndex = args.indexOf('--file');
  const file = fileIndex >= 0 ? args[fileIndex + 1] : 'candidate-profiles.json';
  if (!file) fail('--file requires a path');

  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    fail(`cannot read "${file}": ${error instanceof Error ? error.message : String(error)}`);
  }

  const parsedProfiles = parseProfileFile(text);

  const prisma = new PrismaClient();
  try {
    const repository = new PrismaCandidateProfileRepository(prisma);
    for (const { email, profile } of parsedProfiles) {
      const user = await prisma.user.upsert({
        where: { email },
        update: {},
        create: { email },
        select: { id: true, email: true },
      });
      const stored = await repository.saveForUser({ userId: user.id, profile });
      process.stdout.write(`seeded ${user.email}: profile ${stored.profileVersion}\n`);
      process.stdout.write(
        `  skills ${profile.skills.length}, target roles ${profile.targetRoles.length}, ` +
          `locations ${profile.locationPreferences.length}, experience ${profile.experienceYears ?? 'unknown'}\n`,
      );
    }
    process.stdout.write(`${parsedProfiles.length} profile(s) written\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`seed:candidate failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
