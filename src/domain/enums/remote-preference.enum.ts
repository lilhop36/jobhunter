/**
 * Candidate remote preference (SRS 5.2 `CandidateProfile.remotePreference`).
 *
 * The SRS fixes the attribute but not its value set, so the four states are an
 * engineering decision recorded in ADR-0005. The distinction that matters for
 * scoring (SRS 4.6 "Remote"): only the two *exclusive* states (`REMOTE_REQUIRED`,
 * `ONSITE_ONLY`) penalize a job that contradicts them; the two *permissive*
 * states never reject on remote grounds alone.
 */
export enum RemotePreference {
  /** Remote work is required: an on-site posting is penalized. */
  REMOTE_REQUIRED = 'REMOTE_REQUIRED',
  /** Remote work is preferred, but on-site is still acceptable. */
  REMOTE_PREFERRED = 'REMOTE_PREFERRED',
  /** No stated preference; remote and on-site score the same. */
  NO_PREFERENCE = 'NO_PREFERENCE',
  /** On-site work is required: a fully remote posting is penalized. */
  ONSITE_ONLY = 'ONSITE_ONLY',
}
