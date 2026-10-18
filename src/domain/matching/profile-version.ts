import { createHash } from 'node:crypto';
import type { CandidateProfile } from '@domain/types';

/**
 * Content-derived revision of the candidate profile (SRS 5.2 `profileVersion`).
 *
 * A `JobMatch` records the profile revision it was scored against, so the same
 * stored job can be re-scored offline and the result stays explainable
 * (ENG-012, ENG-013). Deriving the revision from the profile's content means a
 * profile edit *cannot* reuse a previous revision by accident: the version
 * changes exactly when the scoring input changes, and identical input keeps the
 * same version. An operator-maintained counter would silently break that.
 *
 * The digest is over a canonical encoding, not over the stored rows, so the
 * version is independent of key order, of the order of the skill/role/location
 * lists (the matcher sorts its own output), and of PostgreSQL's column layout.
 *
 * Property tests live in `tests/unit/profile-version.spec.ts`.
 */

export const PROFILE_VERSION_SCHEME = 'v1';

/** The profile before its revision is derived — what a writer may supply. */
export type UnversionedCandidateProfile = Omit<CandidateProfile, 'profileVersion'>;

function canonical(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    // A list is a set here: the candidate declaring skills in another order has
    // declared the same profile, and must keep the same version.
    return `[${value.map(canonical).sort().join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonical(entryValue)}`)
    .join(',')}}`;
}

/** Revision of `profile`, e.g. `v1:3f2a…` (SRS 5.2 `CandidateProfile.profileVersion`). */
export function profileVersionOf(profile: UnversionedCandidateProfile): string {
  const digest = createHash('sha256').update(canonical(profile), 'utf8').digest('hex');
  return `${PROFILE_VERSION_SCHEME}:${digest.slice(0, 16)}`;
}
