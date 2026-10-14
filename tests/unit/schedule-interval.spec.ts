import { parseScheduleInterval } from '@domain/scheduling/schedule-interval';

describe('parseScheduleInterval', () => {
  it('parses a count and a unit into milliseconds', () => {
    expect(parseScheduleInterval('90s')).toBe(90_000);
    expect(parseScheduleInterval('15m')).toBe(900_000);
    expect(parseScheduleInterval('6h')).toBe(21_600_000);
    expect(parseScheduleInterval('1d')).toBe(86_400_000);
  });

  it('is case-insensitive and ignores surrounding and inner whitespace', () => {
    expect(parseScheduleInterval('  6H  ')).toBe(21_600_000);
    expect(parseScheduleInterval('6 h')).toBe(21_600_000);
  });

  it('returns null for an absent schedule', () => {
    expect(parseScheduleInterval(null)).toBeNull();
    expect(parseScheduleInterval(undefined)).toBeNull();
    expect(parseScheduleInterval('')).toBeNull();
    expect(parseScheduleInterval('   ')).toBeNull();
  });

  it('returns null for anything that is not exactly one count and unit', () => {
    expect(parseScheduleInterval('every 6 hours')).toBeNull();
    expect(parseScheduleInterval('6')).toBeNull();
    expect(parseScheduleInterval('h')).toBeNull();
    expect(parseScheduleInterval('6w')).toBeNull();
    expect(parseScheduleInterval('1h30m')).toBeNull();
    expect(parseScheduleInterval('* * * * *')).toBeNull();
    expect(parseScheduleInterval('PT6H')).toBeNull();
  });

  it('rejects zero, negative, fractional and out-of-range counts', () => {
    expect(parseScheduleInterval('0m')).toBeNull();
    expect(parseScheduleInterval('-6h')).toBeNull();
    expect(parseScheduleInterval('1.5h')).toBeNull();
    expect(parseScheduleInterval('99999999999999999999d')).toBeNull();
  });
});
