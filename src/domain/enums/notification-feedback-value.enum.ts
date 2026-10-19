/**
 * The verdict a user can give a delivered alert (SRS 4.8 / FR-018, AC-017).
 *
 * Three values, as the SRS names them ("relevant / not relevant / unsure"). `NOT_RELEVANT` is
 * not merely a metric: it is the user's rejection, and SRS 3.2's eligibility rule reads it to
 * suppress further notification about that job. There is no "unknown" member on purpose — the
 * absence of feedback is the absence of a row, not a fourth verdict.
 */
export enum NotificationFeedbackValue {
  RELEVANT = 'RELEVANT',
  NOT_RELEVANT = 'NOT_RELEVANT',
  UNSURE = 'UNSURE',
}
