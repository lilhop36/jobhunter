import { CalendarType } from '@domain/enums';
import { GREGORIAN_RELATIVE_VERSION, parseDate, parseGregorianDate } from '@domain/normalizers/calendar';

const iso = (date: Date | null): string | null => date?.toISOString() ?? null;

describe('Gregorian date parser - unambiguous forms', () => {
  it('accepts an ISO 8601 calendar date', () => {
    const r = parseGregorianDate({ text: '2025-09-15' });
    expect(r.calendar).toBe(CalendarType.GREGORIAN);
    expect(iso(r.publishedAt)).toBe('2025-09-15T00:00:00.000Z');
  });

  it('takes the date from a full ISO timestamp without a timezone shift', () => {
    const r = parseGregorianDate({ text: '2025-09-15T23:30:00Z' });
    expect(iso(r.publishedAt)).toBe('2025-09-15T00:00:00.000Z');
  });

  it('accepts a day-first month name', () => {
    expect(iso(parseGregorianDate({ text: '15 Sep 2025' }).publishedAt)).toBe('2025-09-15T00:00:00.000Z');
  });

  it('accepts a month-first month name', () => {
    expect(iso(parseGregorianDate({ text: 'September 15, 2025' }).publishedAt)).toBe('2025-09-15T00:00:00.000Z');
  });

  it('accepts a month name embedded in a sentence', () => {
    expect(iso(parseGregorianDate({ text: 'Posted on 3 March 2026' }).publishedAt)).toBe('2026-03-03T00:00:00.000Z');
  });
});

describe('Gregorian date parser - ambiguous numeric dates', () => {
  it('keeps a numeric-only date UNKNOWN without a declaration', () => {
    const r = parseGregorianDate({ text: '05/01/2025' });
    expect(r.calendar).toBe(CalendarType.UNKNOWN);
    expect(r.publishedAt).toBeNull();
  });

  it('requires both the calendar and the format declarations', () => {
    expect(parseGregorianDate({ text: '05/01/2025', declaredDateFormat: 'DD/MM/YYYY' }).publishedAt).toBeNull();
    expect(parseGregorianDate({ text: '05/01/2025', sourceCalendarHint: CalendarType.GREGORIAN }).publishedAt).toBeNull();
  });

  it('resolves day/month order from the declared format', () => {
    const dayFirst = parseGregorianDate({
      text: '05/01/2025',
      sourceCalendarHint: CalendarType.GREGORIAN,
      declaredDateFormat: 'DD/MM/YYYY',
    });
    expect(iso(dayFirst.publishedAt)).toBe('2025-01-05T00:00:00.000Z');

    const monthFirst = parseGregorianDate({
      text: '05/01/2025',
      sourceCalendarHint: CalendarType.GREGORIAN,
      declaredDateFormat: 'MM/DD/YYYY',
    });
    expect(iso(monthFirst.publishedAt)).toBe('2025-05-01T00:00:00.000Z');
  });

  it('does not let a value above 12 settle the calendar on its own', () => {
    expect(parseGregorianDate({ text: '13/01/2025' }).publishedAt).toBeNull();
  });
});

describe('Gregorian date parser - relative dates', () => {
  const collectedAt = new Date('2025-09-18T09:00:00.000Z');

  it('resolves days ago against collectedAt with reduced confidence', () => {
    const r = parseGregorianDate({ text: '3 days ago', collectedAt });
    expect(iso(r.publishedAt)).toBe('2025-09-15T00:00:00.000Z');
    expect(r.conversionMethod).toBe(GREGORIAN_RELATIVE_VERSION);
    expect(r.confidence).toBeLessThan(0.9);
  });

  it('resolves weeks and yesterday', () => {
    expect(iso(parseGregorianDate({ text: '2 weeks ago', collectedAt }).publishedAt)).toBe('2025-09-04T00:00:00.000Z');
    expect(iso(parseGregorianDate({ text: 'yesterday', collectedAt }).publishedAt)).toBe('2025-09-17T00:00:00.000Z');
  });

  it('cannot resolve a relative date without collectedAt', () => {
    const r = parseGregorianDate({ text: '3 days ago' });
    expect(r.calendar).toBe(CalendarType.UNKNOWN);
    expect(r.publishedAt).toBeNull();
  });
});

describe('Gregorian date parser - never fabricates or throws', () => {
  it('returns null publishedAt for an impossible date', () => {
    const r = parseGregorianDate({ text: '2025-02-30' });
    expect(r.calendar).toBe(CalendarType.GREGORIAN);
    expect(r.publishedAt).toBeNull();
  });

  it('stays UNKNOWN for unparseable text', () => {
    for (const text of [null, undefined, '', '   ', 'not a date', 'ASAP', '12345']) {
      expect(parseGregorianDate({ text }).publishedAt).toBeNull();
    }
  });

  it('declines a source that declares the Ethiopian calendar', () => {
    const r = parseGregorianDate({ text: '2025-09-15', sourceCalendarHint: CalendarType.ETHIOPIAN });
    expect(r.calendar).toBe(CalendarType.UNKNOWN);
  });
});

describe('parseDate facade', () => {
  it('routes explicit Ethiopian signals to the Ethiopian parser', () => {
    const r = parseDate({ text: 'Meskerem 5, 2018 E.C.' });
    expect(r.calendar).toBe(CalendarType.ETHIOPIAN);
    expect(iso(r.publishedAt)).toBe('2025-09-15T00:00:00.000Z');
  });

  it('routes declared Ethiopian sources to the Ethiopian parser', () => {
    const r = parseDate({ text: 'Meskerem 1, 2018 E.C.', sourceCalendarHint: CalendarType.ETHIOPIAN });
    expect(iso(r.publishedAt)).toBe('2025-09-11T00:00:00.000Z');
  });

  it('routes everything else to the Gregorian parser', () => {
    expect(iso(parseDate({ text: '2025-09-15' }).publishedAt)).toBe('2025-09-15T00:00:00.000Z');
    expect(iso(parseDate({ text: '3 days ago', collectedAt: new Date('2025-09-18T00:00:00Z') }).publishedAt)).toBe(
      '2025-09-15T00:00:00.000Z',
    );
  });
});
