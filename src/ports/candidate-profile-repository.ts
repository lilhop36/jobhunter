import type { CandidateProfile } from '@domain/types';
import type { UnversionedCandidateProfile } from '@domain/matching/profile-version';

/**
 * One candidate matching profile as persistence returns it (FR-012, SRS 5.2).
 *
 * `profile` is the scoring view the matcher consumes, so a caller never has to
 * know the table layout. `profileVersion` is repeated alongside it because a
 * stored `JobMatch` must record the exact revision it was scored against.
 */
export interface StoredCandidateProfile {
  id: string;
  userId: string;
  profileVersion: string;
  profile: CandidateProfile;
}

export interface SaveCandidateProfileInput {
  userId: string;
  /**
   * The **unversioned** profile: the revision is derived from the content
   * (`profileVersionOf`) rather than supplied, so a writer cannot store a
   * version that disagrees with the facts it labels.
   */
  profile: UnversionedCandidateProfile;
}

/**
 * Candidate profile persistence.
 *
 * Deliberately **not** modelled as "the one profile": matching iterates whatever
 * profiles exist and keys every `JobMatch` by `userId` (SRS 5.6 recommends
 * `JobMatch(userId, jobId)` UNIQUE). v1 seeds a single candidate (FR-012,
 * Milestone 2), but nothing here or downstream may assume the list has one
 * element — a second candidate must not require changing the reader, the
 * matcher, or the persistence shape.
 *
 * The profile vocabulary is also field-agnostic: skills are canonical names,
 * roles are titles with aliases, and locations are categories. No job domain
 * (software, health, construction, …) is privileged anywhere in this model.
 */
export interface CandidateProfileRepository {
  /**
   * Every profile, in a stable order. An empty list is a normal state: matching
   * simply has nothing to score against yet.
   */
  listProfiles(): Promise<StoredCandidateProfile[]>;

  /**
   * One candidate's profile, or `null` when they have never saved one. `null` is a state, not an
   * error: SRS 3.4's `GET /api/profile` answers 404 for it rather than inventing an empty
   * profile, because a profile nobody stated is not a profile with no fields (ENG-001).
   */
  findForUser(userId: string): Promise<StoredCandidateProfile | null>;

  /**
   * Creates or replaces this user's profile. A save states the **whole**
   * profile: skills, target roles and location preferences that are no longer
   * claimed are removed rather than left behind, because a leftover row is a
   * fact the candidate no longer asserts (ENG-001).
   */
  saveForUser(input: SaveCandidateProfileInput): Promise<StoredCandidateProfile>;
}
