import { EmploymentType } from '@domain/enums';
import {
  EMPLOYMENT_TYPE_VERSION,
  classifyEmploymentType,
} from '@domain/normalizers/employment-type';

describe('classifyEmploymentType', () => {
  it('returns UNKNOWN when there is no explicit signal', () => {
    expect(classifyEmploymentType({ title: 'Backend Engineer' }).type).toBe(
      EmploymentType.UNKNOWN,
    );
    expect(classifyEmploymentType({}).type).toBe(EmploymentType.UNKNOWN);
    expect(classifyEmploymentType({ title: null, description: null }).type).toBe(
      EmploymentType.UNKNOWN,
    );
  });

  it('reads an explicit token from the title', () => {
    expect(classifyEmploymentType({ title: 'Backend Engineer (Contract)' }).type).toBe(
      EmploymentType.CONTRACT,
    );
    expect(classifyEmploymentType({ title: 'Marketing Internship' }).type).toBe(
      EmploymentType.INTERNSHIP,
    );
    expect(classifyEmploymentType({ title: 'Part-Time Barista' }).type).toBe(
      EmploymentType.PART_TIME,
    );
    expect(classifyEmploymentType({ title: 'Senior Engineer - Full Time' }).type).toBe(
      EmploymentType.FULL_TIME,
    );
    expect(classifyEmploymentType({ title: 'Data Entry (Temporary)' }).type).toBe(
      EmploymentType.TEMPORARY,
    );
    expect(classifyEmploymentType({ title: 'Freelance Designer' }).type).toBe(
      EmploymentType.FREELANCE,
    );
  });

  it('prefers an explicit labeled field over a bare title token', () => {
    const result = classifyEmploymentType({
      title: 'Engineer',
      description: 'Employment Type: Full-time\nWe build things.',
    });
    expect(result.type).toBe(EmploymentType.FULL_TIME);
    expect(result.evidence).toContain('Employment Type');
  });

  it('accepts the common labeled-field spellings', () => {
    expect(
      classifyEmploymentType({ description: 'Job Type - Contract' }).type,
    ).toBe(EmploymentType.CONTRACT);
    expect(
      classifyEmploymentType({ description: 'Contract type – Temporary' }).type,
    ).toBe(EmploymentType.TEMPORARY);
    expect(
      classifyEmploymentType({ description: 'employment type: freelance' }).type,
    ).toBe(EmploymentType.FREELANCE);
  });

  it('does not scan the description body for bare tokens', () => {
    // "full-time benefits" is not evidence of the engagement type (ER-04).
    expect(
      classifyEmploymentType({
        title: 'Backend Engineer',
        description: 'We offer full-time benefits and a pension.',
      }).type,
    ).toBe(EmploymentType.UNKNOWN);
  });

  it('prefers engagement nature over the work-pattern split on co-occurrence', () => {
    expect(classifyEmploymentType({ title: 'Full-time Contract Engineer' }).type).toBe(
      EmploymentType.CONTRACT,
    );
    expect(classifyEmploymentType({ title: 'Part-time Internship' }).type).toBe(
      EmploymentType.INTERNSHIP,
    );
  });

  it('requires a word boundary, so similar words do not match', () => {
    // "internal"/"contractual" must not be read as intern/contract on their own.
    expect(classifyEmploymentType({ title: 'Internal Auditor' }).type).toBe(
      EmploymentType.UNKNOWN,
    );
    expect(classifyEmploymentType({ title: 'Full-Stack Engineer' }).type).toBe(
      EmploymentType.UNKNOWN,
    );
  });

  it('reports the evidence slice that determined the type', () => {
    const result = classifyEmploymentType({ title: 'Backend Engineer (Contract)' });
    expect(result.evidence?.toLowerCase()).toContain('contract');
  });

  it('is deterministic and never throws on hostile input', () => {
    const hostile = { title: '<script>alert(1)</script>\u0000', description: '\u200B' };
    expect(() => classifyEmploymentType(hostile)).not.toThrow();
    expect(classifyEmploymentType(hostile)).toEqual(classifyEmploymentType(hostile));
    expect(classifyEmploymentType({ title: 42 as unknown as string }).type).toBe(
      EmploymentType.UNKNOWN,
    );
  });

  it('exposes a stable version stamp', () => {
    expect(EMPLOYMENT_TYPE_VERSION).toBe('EMPLOYMENT_TYPE_V1');
  });
});
