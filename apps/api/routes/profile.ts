import type { FastifyInstance } from 'fastify';
import type {
  EmploymentType,
  LocationCategory,
  RelocationPreference,
  RemotePreference,
  SalaryPeriod,
  SkillEvidence,
} from '@domain/enums';
import type { UnversionedCandidateProfile } from '@domain/matching';
import { asDecimalAmount, asProbability } from '@domain/types';
import type { CandidateProfileRepository, StoredCandidateProfile } from '@ports/candidate-profile-repository';
import { ApiError } from '../errors';
import { profileQuery, putProfileBody } from '../schemas';

/**
 * The candidate profile routes (SRS 3.4 `GET /api/profile` and `PUT /api/profile`; FR-012).
 *
 * The SRS fixes the endpoints but no body, so the shape below is SRS 5.2's CandidateProfile
 * fields, flattened: the stored revision is published beside the facts it labels, because every
 * `JobMatch` names the revision it was scored against and a client comparing the two needs both.
 *
 * A save states the **whole** profile. Every field is required, including the ones that are
 * explicitly null or empty, because the repository replaces the child rows rather than merging
 * them: a field the client omits could only be guessed, and a guess is a fact the candidate never
 * asserted (ENG-001).
 *
 * ## Why a save enqueues work
 *
 * A changed profile invalidates every stored match — each row was scored against inputs that no
 * longer exist. So a save that changes the revision asks for a `PROFILE_CHANGED` re-score (SRS
 * 11.2; ADR-0005 §9). Only the *request* happens here: one task per enabled source, and the
 * worker does the scoring, which is the same division the manual source run uses (ENG-017).
 *
 * A failed request is logged, not fatal. The profile is already stored and a 5xx would invite a
 * retry against a profile that is already correct — and the delay is bounded anyway, because
 * every later collection of a source re-scores that source's jobs against the current revision.
 * Saving an identical profile enqueues nothing: the revision is content-derived, so the stored
 * matches are still valid.
 */
export interface ProfileRoutesDeps {
  profiles: CandidateProfileRepository;
  /** The `PROFILE_CHANGED` entry point. Structural, so a test can substitute one. */
  rescore: {
    run(input: { reason: 'PROFILE_CHANGED' }): Promise<{
      enqueued: string[];
      alreadyQueued: string[];
    }>;
  };
}

/** The request body, as Ajv has already validated it against `putProfileBody`. */
interface ProfileBody {
  experienceYears: number | null;
  remotePreference: RemotePreference;
  relocationPreference: RelocationPreference;
  salaryPreference: {
    min: string | null;
    currency: string | null;
    period: SalaryPeriod | null;
    requireDisclosed: boolean;
  } | null;
  employmentPreferences: EmploymentType[];
  skills: Array<{ canonicalSkill: string; skillType: SkillEvidence; confidence: number }>;
  targetRoles: Array<{ title: string; aliases: string[] }>;
  locationPreferences: Array<{ category: LocationCategory; text: string | null }>;
}

export async function registerProfileRoutes(
  app: FastifyInstance,
  deps: ProfileRoutesDeps,
): Promise<void> {
  app.get('/api/profile', { schema: { querystring: profileQuery } }, async (request) => {
    const { userId } = request.query as { userId: string };

    const stored = await deps.profiles.findForUser(userId);
    // No profile yet is a state, not an empty profile: answering `{}` would claim the candidate
    // has stated nothing about everything, which is a different fact from never having looked.
    if (stored === null) throw ApiError.notFound(`No profile exists for user ${userId}`);
    return serializeProfile(stored);
  });

  app.put(
    '/api/profile',
    { schema: { querystring: profileQuery, body: putProfileBody } },
    async (request) => {
      const { userId } = request.query as { userId: string };
      const profile = toProfile(request.body as ProfileBody);

      const before = await deps.profiles.findForUser(userId);
      const stored = await deps.profiles.saveForUser({ userId, profile });

      if (before?.profileVersion === stored.profileVersion) {
        request.log.info(
          { userId, profileVersion: stored.profileVersion },
          'profile saved with an unchanged revision; no re-score requested',
        );
        return serializeProfile(stored);
      }

      try {
        const result = await deps.rescore.run({ reason: 'PROFILE_CHANGED' });
        request.log.info(
          {
            userId,
            profileVersion: stored.profileVersion,
            enqueued: result.enqueued.length,
            alreadyQueued: result.alreadyQueued.length,
          },
          'requested a re-score after the profile changed',
        );
      } catch (error) {
        request.log.warn(
          { err: error, userId, profileVersion: stored.profileVersion },
          'the profile changed but the re-score could not be requested',
        );
      }

      return serializeProfile(stored);
    },
  );
}

/**
 * The validated body as the domain profile.
 *
 * The one transformation is the salary floor: the domain's canonical amount has at most two
 * decimals and no leading zeros, while a client may reasonably send `50000` or `50000.5`. Both
 * are padded to the canonical `50000.00` / `50000.50` **before** the revision is derived, so the
 * version stored labels exactly the facts stored — a version computed over `50000` would disagree
 * with the `50000.00` the table returns, and ENG-012's guarantee would be a lie.
 */
function toProfile(body: ProfileBody): UnversionedCandidateProfile {
  return {
    experienceYears: body.experienceYears,
    remotePreference: body.remotePreference,
    relocationPreference: body.relocationPreference,
    salaryPreference:
      body.salaryPreference === null
        ? null
        : {
            min:
              body.salaryPreference.min === null
                ? null
                : asDecimalAmount(canonicalAmount(body.salaryPreference.min)),
            currency: body.salaryPreference.currency,
            period: body.salaryPreference.period,
            requireDisclosed: body.salaryPreference.requireDisclosed,
          },
    employmentPreferences: body.employmentPreferences,
    skills: body.skills.map((skill) => ({
      canonicalSkill: skill.canonicalSkill,
      skillType: skill.skillType,
      confidence: asProbability(skill.confidence),
    })),
    targetRoles: body.targetRoles.map((role) => ({ title: role.title, aliases: role.aliases })),
    locationPreferences: body.locationPreferences,
  };
}

/** `50000` → `50000.00`, `50000.5` → `50000.50`. Whole amounts and up to two decimals only. */
function canonicalAmount(raw: string): string {
  const [integer, fraction = ''] = raw.split('.');
  return `${integer}.${fraction.padEnd(2, '0')}`;
}

function serializeProfile(stored: StoredCandidateProfile) {
  const { profile } = stored;
  return {
    id: stored.id,
    userId: stored.userId,
    profileVersion: stored.profileVersion,
    experienceYears: profile.experienceYears,
    remotePreference: profile.remotePreference,
    relocationPreference: profile.relocationPreference,
    salaryPreference:
      profile.salaryPreference === null
        ? null
        : {
            min: profile.salaryPreference.min,
            currency: profile.salaryPreference.currency,
            period: profile.salaryPreference.period,
            requireDisclosed: profile.salaryPreference.requireDisclosed,
          },
    employmentPreferences: [...profile.employmentPreferences],
    skills: profile.skills.map((skill) => ({ ...skill })),
    targetRoles: profile.targetRoles.map((role) => ({
      title: role.title,
      aliases: [...role.aliases],
    })),
    locationPreferences: profile.locationPreferences.map((preference) => ({ ...preference })),
  };
}
