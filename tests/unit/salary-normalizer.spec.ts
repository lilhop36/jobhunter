import { parseSalary } from '@domain/normalizers/salary-normalizer';

describe('salary parser - non-numeric states (AC-007)', () => {
  it('negotiable never fabricates numbers', () => {
    const r = parseSalary('Salary negotiable');
    expect(r.type).toBe('NEGOTIABLE');
    expect(r.min).toBeNull();
    expect(r.max).toBeNull();
    expect(r.currency).toBeNull();
  });

  it('as per scale never fabricates numbers', () => {
    const r = parseSalary('As per company scale');
    expect(r.type).toBe('AS_PER_SCALE');
    expect(r.min).toBeNull();
    expect(r.max).toBeNull();
    expect(r.currency).toBeNull();
  });

  it('not disclosed never fabricates numbers', () => {
    const r = parseSalary('Not disclosed');
    expect(r.type).toBe('NOT_DISCLOSED');
    expect(r.min).toBeNull();
    expect(r.currency).toBeNull();
  });

  it('empty / unknown stays UNKNOWN', () => {
    expect(parseSalary(null).type).toBe('UNKNOWN');
    expect(parseSalary('').type).toBe('UNKNOWN');
    expect(parseSalary('').min).toBeNull();
  });
});

describe('salary parser - numeric extraction', () => {
  it('exact amount with currency', () => {
    const r = parseSalary('50,000 ETB');
    expect(r.type).toBe('EXACT');
    expect(r.min).toBe('50000');
    expect(r.max).toBe('50000');
    expect(r.currency).toBe('ETB');
  });

  it('range with en dash', () => {
    const r = parseSalary('50,000\u201370,000 ETB/month');
    expect(r.type).toBe('RANGE');
    expect(r.min).toBe('50000');
    expect(r.max).toBe('70000');
    expect(r.currency).toBe('ETB');
    expect(r.period).toBe('MONTH');
  });

  it('starting from', () => {
    const r = parseSalary('Starting from 50,000 ETB');
    expect(r.type).toBe('STARTING_FROM');
    expect(r.min).toBe('50000');
    expect(r.max).toBeNull();
  });

  it('up to', () => {
    const r = parseSalary('Up to 70,000 ETB');
    expect(r.type).toBe('UP_TO');
    expect(r.min).toBeNull();
    expect(r.max).toBe('70000');
  });

  it('handles 50k shorthand', () => {
    const r = parseSalary('Salary 50k ETB');
    expect(r.min).toBe('50000');
  });

  it('parses currency aliases', () => {
    expect(parseSalary('30,000 birr').currency).toBe('ETB');
    expect(parseSalary('Salary $2,000/month').currency).toBe('USD');
  });

  it('does not treat a bare year as salary', () => {
    const r = parseSalary('Published 2018');
    expect(r.type).toBe('UNKNOWN');
    expect(r.min).toBeNull();
  });

  it('rejects min > max as conflicting UNKNOWN', () => {
    const r = parseSalary('70,000 - 50,000 ETB');
    expect(r.type).toBe('UNKNOWN');
    expect(r.min).toBeNull();
    expect(r.max).toBeNull();
  });

  it('keeps numeric value alongside negotiable with lower confidence', () => {
    const r = parseSalary('50,000 ETB negotiable');
    expect(r.min).toBe('50000');
    expect(r.confidence).toBeLessThan(0.9);
    expect(r.evidence).toBe('50,000 ETB negotiable');
  });
});

describe('salary parser - exact decimal amounts (ENG-006)', () => {
  it('preserves the written precision of a decimal amount', () => {
    const r = parseSalary('ETB 1,250.50');
    expect(r.type).toBe('EXACT');
    expect(r.min).toBe('1250.50');
    expect(r.max).toBe('1250.50');
  });

  it('scales 50k exactly without floating point', () => {
    expect(parseSalary('Salary 50k ETB').min).toBe('50000');
    expect(parseSalary('Salary 1.5k ETB').min).toBe('1500');
  });

  it('rejects amounts finer than the canonical 2-decimal scale', () => {
    // 1,250.505 is not representable as DECIMAL(14,2); reject rather than round.
    const r = parseSalary('ETB 1,250.505');
    expect(r.type).toBe('UNKNOWN');
    expect(r.min).toBeNull();
    expect(r.max).toBeNull();
  });

  it('does not lose cents through binary floating point', () => {
    // 0.1 + 0.2 style traps: the text value must survive exactly.
    expect(parseSalary('ETB 0.10').min).toBe('0.10');
    expect(parseSalary('ETB 999,999,999.99').min).toBe('999999999.99');
  });
});
