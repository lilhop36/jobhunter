import { parseEthiopianDate } from '@domain/normalizers/calendar/ethiopian-date-parser';

describe('Ethiopian calendar', () => {
  it('Meskerem 1, 2018 -> 2025-09-11', () => {
    const res = parseEthiopianDate({ text: 'Meskerem 1, 2018 E.C.' });
    expect(res.calendar).toBe('ETHIOPIAN');
    expect(res.publishedAt?.toISOString().slice(0, 10)).toBe('2025-09-11');
    expect(res.conversionMethod).toBe('ETHIOPIAN_CALENDAR_V1');
  });

  it('Meskerem 5, 2018 -> 2025-09-15', () => {
    const res = parseEthiopianDate({ text: 'መስከረም 5, 2018' });
    expect(res.publishedAt?.toISOString().slice(0, 10)).toBe('2025-09-15');
  });

  it('Pagume 6, 2015 (leap) -> 2023-09-11', () => {
    const res = parseEthiopianDate({ text: 'Pagume 6, 2015 E.C.' });
    expect(res.publishedAt?.toISOString().slice(0, 10)).toBe('2023-09-11');
  });

  it('Pagume 6, 2017 (non-leap) -> invalid UNKNOWN', () => {
    const res = parseEthiopianDate({ text: 'Pagume 6, 2017 E.C.' });
    expect(res.publishedAt).toBeNull();
    expect(res.calendar).toBe('ETHIOPIAN');
  });

  it('Pagume 7 -> invalid', () => {
    const res = parseEthiopianDate({ text: 'Pagume 7, 2017 E.C.' });
    expect(res.publishedAt).toBeNull();
  });

  it('numeric only with no marker -> UNKNOWN', () => {
    const res = parseEthiopianDate({ text: '05/01/2018' });
    expect(res.calendar).toBe('UNKNOWN');
    expect(res.publishedAt).toBeNull();
  });
});
