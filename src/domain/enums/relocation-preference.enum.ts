/**
 * Candidate relocation willingness (SRS 5.2 `CandidateProfile.relocationPreference`).
 *
 * Value set is an engineering decision recorded in ADR-0005. `UNDECIDED` is a
 * real state: it is not willingness, so relocation is never assumed from it.
 */
export enum RelocationPreference {
  WILLING = 'WILLING',
  NOT_WILLING = 'NOT_WILLING',
  UNDECIDED = 'UNDECIDED',
}
