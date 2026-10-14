/**
 * Deterministic parsing of `JobSource.schedule` (FR-001, FR-002, SRS 7.6).
 *
 * The SRS names the `schedule` attribute but fixes no format, so the format is an
 * engineering policy: a positive integer and a unit — `15m`, `6h`, `1d`, `90s`
 * (case-insensitive, surrounding whitespace ignored). There is deliberately **no default**:
 * an absent schedule means "not collected on a schedule" (manual or startup runs only),
 * because silently inventing an interval would decide how hard to hit someone else's server.
 *
 * Returns `null` for anything that is not exactly one `<count><unit>` token, so the caller
 * can tell "absent" (null/blank input) from "present but unparseable" and report the latter
 * rather than silently never collecting that source.
 *
 * `ponytail:` one unit token only. Add composite intervals (`1h30m`) or cron only when a
 * source genuinely needs them.
 */
const UNIT_MS: Readonly<Record<string, number>> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** No `g` flag: `exec` is stateless, so a module-level pattern cannot leak state. */
const SCHEDULE_PATTERN = /^(\d+)\s*([smhd])$/iu;

export function parseScheduleInterval(schedule: string | null | undefined): number | null {
  if (typeof schedule !== 'string') return null;
  const match = SCHEDULE_PATTERN.exec(schedule.trim());
  if (!match) return null;

  const count = Number(match[1]);
  if (!Number.isSafeInteger(count) || count <= 0) return null;

  const milliseconds = count * UNIT_MS[match[2].toLowerCase()];
  if (!Number.isSafeInteger(milliseconds)) return null;
  return milliseconds;
}
