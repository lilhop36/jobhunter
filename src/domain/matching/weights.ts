import { MatchFactor } from './match-factor';

/**
 * The version of the whole matcher (weights, thresholds and scoring logic).
 * ENG-013: any change to those requires a new value, so a stored match can
 * always be traced to the rules that produced it. Mirrors SRS Appendix B.3.
 */
export const MATCHER_VERSION = '1.0.0';

/**
 * SRS 4.6 "Initial weights" — a versioned hypothesis, not a tuned model. The
 * matcher divides by the weights it could actually evaluate, so these are
 * relative weights and their sum (100) is only a convenience.
 */
export const MATCH_FACTOR_WEIGHTS: Readonly<Record<MatchFactor, number>> = {
  role: 25,
  skills: 30,
  experience: 15,
  location: 15,
  employment: 5,
  freshness: 5,
  salary: 5,
};

/** Factor order used for evidence lines and for the score/confidence sums. */
export const MATCH_FACTORS: readonly MatchFactor[] = [
  'role',
  'skills',
  'experience',
  'location',
  'employment',
  'freshness',
  'salary',
];
