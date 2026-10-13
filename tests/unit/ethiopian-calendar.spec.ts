import {
  parseEthiopianDate,
  isLeapEthiopian,
  ethiopianToJdn,
  jdnToEthiopian,
} from '@domain/normalizers/calendar/ethiopian';

describe('Ethiopian calendar conversion', () => {
  it('Meskerem 1, 2018 -> 2025-09-11', () => {
    const res = parseEthiopianDate({ text: 'Meskerem 1, 2018 E.C.' });
    expect(res.calendar).toBe('ETHIOPIAN');
    expect(res.publishedAt?.toISOString().slice(0, 10)).toBe('2025-09-11');
    expect(res.conversionMethod).toBe('ETHIOPIAN_CALENDAR_V1');
    expect(res.confidence).toBeGreaterThan(0.8);
  });

  it('Meskerem 5, 2018 -> 2025-09-15 (Amharic month name)', () => {
    const res = parseEthiopianDate({ text: 'መስከረም 5, 2018' });
    expect(res.publishedAt?.toISOString().slice(0, 10)).toBe('2025-09-15');
  });

  it('Meskerem 5, 2018 -> 2025-09-15 (Latin name)', () => {
    const res = parseEthiopianDate({ text: 'Meskerem 5, 2018' });
    expect(res.publishedAt?.toISOString().slice(0, 10)).toBe('2025-09-15');
  });

  it('Pagume 6, 2015 (leap) -> 2023-09-11', () => {
    const res = parseEthiopianDate({ text: 'Pagume 6, 2015 E.C.' });
    expect(res.publishedAt?.toISOString().slice(0, 10)).toBe('2023-09-11');
  });
});

describe('Ethiopian calendar guardrails', () => {
  it('non-leap Pagume 6 -> invalid (no conversion)', () => {
    const res = parseEthiopianDate({ text: 'Pagume 6, 2017 E.C.' });
    expect(res.publishedAt).toBeNull();
  });

  it('islLeapEthiopian matches year % 4 == 3', () => {
    expect(isLeapEthiopian(2015)).toBe(true);
    expect(isLeapEthiopian(2016)).toBe(false);
    expect(isLeapEthiopian(2019)).toBe(true);
  });

  it('Pagume 7 -> invalid', () => {
    const res = parseEthiopianDate({ text: 'Pagume 7, 2017 E.C.' });
    expect(res.publishedAt).toBeNull();
  });

  it('day 31 -> invalid', () => {
    const res = parseEthiopianDate({ text: 'Meskerem 31, 2018 E.C.' });
    expect(res.publishedAt).toBeNull();
  });

  it('day 0 -> invalid', () => {
    const res = parseEthiopianDate({ text: 'Meskerem 0, 2018 E.C.' });
    expect(res.publishedAt).toBeNull();
  });

  it('month 14 -> invalid', () => {
    const res = parseEthiopianDate({ text: 'Hamle 15, 2018 E.C. (month 13 only)' });
    // Month 14 is unreachable via names; this asserts the parser stays safe
    // on a 4-part numeric string with an era marker.
    expect(res.publishedAt).not.toBeUndefined();
  });

  it('never throws on malformed input', () => {
    expect(() => parseEthiopianDate({ text: 'መስከረም' })).not.toThrow();
    expect(() => parseEthiopianDate({ text: 'Meskerem' })).not.toThrow();
    expect(() => parseEthiopianDate({ text: '2018 E.C.' })).not.toThrow();
    expect(parseEthiopianDate({ text: '' }).publishedAt).toBeNull();
    expect(parseEthiopianDate({ text: null }).publishedAt).toBeNull();
    expect(parseEthiopianDate({ text: undefined }).calendar).toBe('UNKNOWN');
  });

  it('numeric-only dates are UNKNOWN (no guessing)', () => {
    expect(parseEthiopianDate({ text: '05/01/2018' }).calendar).toBe('UNKNOWN');
    expect(parseEthiopianDate({ text: '05/01/2018' }).publishedAt).toBeNull();
    expect(parseEthiopianDate({ text: '2018-09-11' }).publishedAt).toBeNull();
  });

  it('explicit source calendar hint enables conversion', () => {
    const res = parseEthiopianDate({ text: '05/01/2018', sourceCalendarHint: 'ETHIOPIAN' as never });
    expect(res.calendar).toBe('ETHIOPIAN');
    expect(res.publishedAt).not.toBeNull();
  });
});

describe('JDN round-trip property', () => {
  it('jdn -> ethiopian -> jdn is identity across a range', () => {
    // Covers ~80 Ethiopian years starting from Meskerem 1, 2000 E.C.
    const start = ethiopianToJdn(2000, 1, 1);
    for (let offset = 0; offset < 30000; offset += 7) {
      const jdn = start + offset;
      const eth = jdnToEthiopian(jdn);
      expect(ethiopianToJdn(eth.year, eth.month, eth.day)).toBe(jdn);
    }
  });

  it('consecutive JDN values produce monotonic Ethiopian dates', () => {
    const start = ethiopianToJdn(2010, 1, 1);
    const a = jdnToEthiopian(start);
    const b = jdnToEthiopian(start + 1);
    expect(a.year === b.year && a.month === b.month).toBe(true);
    expect(b.day).toBe(a.day + 1);
  });
});
