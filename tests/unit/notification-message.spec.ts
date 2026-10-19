import { describe, expect, it } from 'vitest';
import { ApplicationMethod, SalaryPeriod, SalaryType } from '@domain/enums';
import {
  readNotificationEvidence,
  renderNotificationMessage,
  type NotificationMessageContent,
} from '@domain/notification';

/**
 * SRS 3.2 "Content", rendered at delivery time.
 *
 * What these pin: every content item appears; a fact the job does not have reads as UNKNOWN
 * rather than being omitted or guessed (ENG-001); and the stored payload — JSON written by an
 * earlier revision, so effectively untrusted input — can never crash the renderer or be read as
 * a zero score.
 */

function content(overrides: Partial<NotificationMessageContent> = {}): NotificationMessageContent {
  return {
    title: 'Backend Engineer',
    company: 'Acme',
    locationText: 'Addis Ababa',
    salary: {
      type: SalaryType.RANGE,
      min: '60000.00',
      max: '90000.00',
      currency: 'ETB',
      period: SalaryPeriod.MONTH,
    },
    application: {
      method: ApplicationMethod.EMAIL,
      applyUrl: null,
      applyEmail: 'jobs@example.test',
    },
    sourceName: 'EffoySira',
    evidence: {
      score: 90,
      confidence: 54,
      explanation: 'Role, location and employment type all match.',
      matcherVersion: '1.0.0',
      eligibilityExplanation: 'eligible: all SRS 3.2 predicates hold',
      matchedSkills: [],
      missingSkills: [],
      uncertainSkills: [],
    },
    ...overrides,
  };
}

describe('renderNotificationMessage', () => {
  it('renders every SRS 3.2 content item from the stored facts', () => {
    const text = renderNotificationMessage(content());

    expect(text).toContain('Job: Backend Engineer');
    expect(text).toContain('Company: Acme');
    expect(text).toContain('Location: Addis Ababa');
    expect(text).toContain('Match: 90/100 relevance, 54% confidence');
    expect(text).toContain('Why it matches: Role, location and employment type all match.');
    expect(text).toContain('Salary: 60000.00 ETB – 90000.00 ETB per month');
    expect(text).toContain('Apply: jobs@example.test');
    expect(text).toContain('Source: EffoySira');
  });

  it('renders an unknown field as UNKNOWN, never as a plausible value', () => {
    const text = renderNotificationMessage(content({ title: null, company: null, locationText: null }));

    expect(text).toContain('Job: UNKNOWN');
    expect(text).toContain('Company: UNKNOWN');
    expect(text).toContain('Location: UNKNOWN');
  });

  it('does not claim the job has no skills when none were extracted', () => {
    const text = renderNotificationMessage(content());

    // ADR-0005 §2: nothing extracts job-side skills yet, so an empty list means "not extracted".
    expect(text).toContain('Skills: not extracted from this posting yet');
    expect(text).not.toContain('Matched skills:');
  });

  it('lists the skills once they are known', () => {
    const text = renderNotificationMessage(
      content({
        evidence: {
          ...content().evidence,
          matchedSkills: ['TypeScript'],
          missingSkills: ['PostgreSQL'],
          uncertainSkills: ['Docker'],
        },
      }),
    );

    expect(text).toContain('Matched skills: TypeScript');
    expect(text).toContain('Missing skills: PostgreSQL');
    expect(text).toContain('Uncertain skills: Docker');
    expect(text).not.toContain('not extracted');
  });

  it('says a salary is not disclosed instead of leaving the amount to the reader', () => {
    const text = renderNotificationMessage(
      content({
        salary: {
          type: SalaryType.NOT_DISCLOSED,
          min: null,
          max: null,
          currency: null,
          period: SalaryPeriod.UNKNOWN,
        },
      }),
    );

    expect(text).toContain('Salary: not disclosed');
  });

  it('renders a half-stated range as not fully stated rather than inventing a bound', () => {
    const text = renderNotificationMessage(
      content({
        salary: {
          type: SalaryType.RANGE,
          min: '60000.00',
          max: null,
          currency: 'ETB',
          period: SalaryPeriod.MONTH,
        },
      }),
    );

    expect(text).toContain('Salary: range not fully stated');
  });

  it('renders UNKNOWN when the job has no usable application path', () => {
    const text = renderNotificationMessage(
      content({
        application: {
          method: ApplicationMethod.UNKNOWN,
          applyUrl: null,
          applyEmail: null,
        },
      }),
    );

    expect(text).toContain('Apply: UNKNOWN');
  });

  it('renders a method whose target was never parsed as UNKNOWN, not as the method alone', () => {
    const text = renderNotificationMessage(
      content({
        application: {
          method: ApplicationMethod.ONLINE_URL,
          applyUrl: null,
          applyEmail: null,
        },
      }),
    );

    expect(text).toContain('Apply: UNKNOWN (no URL recorded)');
  });

  it('is deterministic: the same stored rows always render the same text', () => {
    expect(renderNotificationMessage(content())).toBe(renderNotificationMessage(content()));
  });
});

describe('readNotificationEvidence', () => {
  it('reads a well-formed payload', () => {
    const evidence = readNotificationEvidence({
      score: 90,
      confidence: 54,
      explanation: 'why',
      matcherVersion: '1.0.0',
      eligibilityExplanation: 'eligible',
      matchedSkills: ['a'],
      missingSkills: [],
      uncertainSkills: ['b'],
    });

    expect(evidence).toEqual({
      score: 90,
      confidence: 54,
      explanation: 'why',
      matcherVersion: '1.0.0',
      eligibilityExplanation: 'eligible',
      matchedSkills: ['a'],
      missingSkills: [],
      uncertainSkills: ['b'],
    });
  });

  it('reads nothing out of an unrecognisable payload instead of throwing', () => {
    for (const payload of [null, 'a string', 42, [], { score: 'high', explanation: 7 }]) {
      const evidence = readNotificationEvidence(payload);

      expect(evidence.score).toBeNull();
      expect(evidence.confidence).toBeNull();
      expect(evidence.explanation).toBeNull();
      expect(evidence.matchedSkills).toEqual([]);
    }
  });

  it('rejects an out-of-range score rather than rendering a broken one', () => {
    expect(readNotificationEvidence({ score: 900, confidence: -4 }).score).toBeNull();
    expect(readNotificationEvidence({ score: 900, confidence: -4 }).confidence).toBeNull();
  });

  it('renders an unreadable payload as UNKNOWN rather than as a zero match', () => {
    const text = renderNotificationMessage(content({ evidence: readNotificationEvidence(null) }));

    expect(text).toContain('Match: UNKNOWN');
    expect(text).not.toContain('0/100');
  });
});
