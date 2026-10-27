import { describe, expect, it } from 'vitest';
import { CalendarType } from '@domain/enums';
import { DEADLINE_EXTRACTION_VERSION, parseDeadline } from '@domain/normalizers/deadline';

/**
 * Deadline extraction (FR-019). What is pinned here is the evidence boundary: a deadline is
 * what a label plus a readable date say, and everything else stays UNKNOWN. A false positive
 * here invents a deadline and later retires a live posting, so the near-miss inputs are tested
 * as deliberately as the positives.
 */

const UTC = (dateIso: string): Date => new Date(dateIso);

describe('parseDeadline', () => {
  it('reads a labelled named-month date', () => {
    const parsed = parseDeadline({
      description: 'Please send your CV.\nDeadline: October 30, 2026',
    });
    expect(parsed.deadlineAt).toEqual(new Date('2026-10-30T00:00:00.000Z'));
    expect(parsed.evidence).toBe('Deadline: October 30, 2026');
    expect(parsed.conversionMethod).toBe('GREGORIAN_NAMED_MONTH_V1');
  });

  it('reads a day-first phrase and keeps the label in the evidence', () => {
    const parsed = parseDeadline({
      description: 'Application deadline 15 Nov 2026. Only shortlisted candidates are contacted.',
    });
    expect(parsed.deadlineAt).toEqual(UTC('2026-11-15'));
    // The evidence is the clause the label introduced, not the rest of the line: the sentence
    // about shortlisted candidates is not part of the deadline statement.
    expect(parsed.evidence).toBe('Application deadline 15 Nov 2026');
  });

  it('reads an ISO date after a closing-date label', () => {
    const parsed = parseDeadline({
      description: 'Closing date: 2026-11-05',
    });
    expect(parsed.deadlineAt).toEqual(UTC('2026-11-05T00:00:00.000Z'));
  });

  it('takes the first labelled date in document order', () => {
    const parsed = parseDeadline({
      description: 'Start date: 1 Dec 2026. Deadline: 30 Nov 2026. Salary negotiable.',
    });
    expect(parsed.deadlineAt).toEqual(UTC('2026-11-30'));
  });

  it('prefers the first label occurrence over a later, more specific label', () => {
    const parsed = parseDeadline({
      description: 'Deadline: 5 Nov 2026 for CVs. Application deadline: 20 Nov 2026.',
    });
    // The earlier *label* wins, not the more specific one: the scan is document order.
    expect(parsed.deadlineAt).toEqual(UTC('2026-11-05'));
    expect(parsed.evidence).toMatch(/^Deadline: 5 Nov 2026/);
  });

  it('stays UNKNOWN without a label, even with an unlabelled date in the text', () => {
    const parsed = parseDeadline({
      description: 'We published this on 30 October 2026. Apply soon.',
    });
    expect(parsed.deadlineAt).toBeNull();
    expect(parsed.evidence).toBeNull();
    expect(parsed.conversionMethod).toBeNull();
  });

  it('never resolves a duration or relative phrase, because that would invent the start date', () => {
    for (const text of [
      'Deadline: within 7 working days',
      'Applications close in two weeks',
      'Deadline: as soon as possible',
      'apply before the end of the month',
      'The deadline has passed for this role',
    ]) {
      const parsed = parseDeadline({ description: text });
      expect(parsed.deadlineAt, text).toBeNull();
      expect(parsed.evidence, text).toBeNull();
      expect(parsed.conversionMethod, text).toBeNull();
    }
  });

  it('leaves a numeric date UNKNOWN without a declared format, like every other date field', () => {
    expect(parseDeadline({ description: 'Deadline: 30/10/2026' }).deadlineAt).toBeNull();
  });

  it('accepts a numeric date when the source declared calendar and format', () => {
    const parsed = parseDeadline({
      description: 'Deadline: 30/10/2026',
      sourceCalendarHint: CalendarType.GREGORIAN,
      declaredDateFormat: 'DD/MM/YYYY',
    });
    expect(parsed.deadlineAt).toEqual(UTC('2026-10-30'));
    expect(parsed.conversionMethod).toBe('GREGORIAN_DECLARED_FORMAT_V1');
  });

  it('reads a stated Ethiopian-calendar deadline through the shared calendar parser', () => {
    // A labelled EC date routes to the Ethiopian parser exactly as a publication date does;
    // the value itself is pinned by tests/unit/ethiopian-calendar.spec.ts.
    const parsed = parseDeadline({
      description: 'Deadline: Meskerem 5, 2018 E.C.',
      sourceCalendarHint: CalendarType.ETHIOPIAN,
    });
    expect(parsed.deadlineAt).toEqual(UTC('2025-09-15'));
    expect(parsed.conversionMethod).toBe('ETHIOPIAN_CALENDAR_V1');
    expect(parsed.evidence).toBe('Deadline: Meskerem 5, 2018 E.C.');
  });

  it('never reads an unlabelled date', () => {
    const parsed = parseDeadline({
      description: 'Posted on 30 Oct 2026. We review applications as they arrive.',
    });
    expect(parsed.deadlineAt).toBeNull();
  });

  it('never reads a date that belongs to a sentence after the deadline clause', () => {
    // The reproduced fabrication (audit H5): the label states there is no deadline, and the
    // next sentence carries the posting date. V1 scanned the whole line and returned 30 Oct.
    const parsed = parseDeadline({
      description: 'Deadline: until filled. Posted 30 Oct 2026',
    });
    expect(parsed.deadlineAt).toBeNull();
    expect(parsed.evidence).toBeNull();
    expect(parsed.conversionMethod).toBeNull();
  });

  it('keeps a no-deadline statement UNKNOWN when an unrelated date follows in the same clause', () => {
    for (const text of [
      'Deadline: until filled, applications reviewed after 30 Oct 2026',
      'Application deadline: rolling; the shortlisting round closes 12 Nov 2026',
      'Deadline: to be announced. Register interest before 1 Dec 2026',
    ]) {
      const parsed = parseDeadline({ description: text });
      expect(parsed.deadlineAt, text).toBeNull();
    }
  });

  it('does not discard a real deadline that merely mentions "until filled" later', () => {
    const parsed = parseDeadline({
      description: 'Deadline: 30 Nov 2026 (or until filled)',
    });
    expect(parsed.deadlineAt).toEqual(UTC('2026-11-30'));
  });

  it('does not cut a declared dotted numeric date at its own separators', () => {
    const parsed = parseDeadline({
      description: 'Deadline: 30.10.2026',
      sourceCalendarHint: CalendarType.GREGORIAN,
      declaredDateFormat: 'DD.MM.YYYY',
    });
    expect(parsed.deadlineAt).toEqual(UTC('2026-10-30'));
  });

  it('reads a comma-form month-day-year date whole', () => {
    const parsed = parseDeadline({
      description: 'Last date for application: October 30, 2026 by email.',
    });
    expect(parsed.deadlineAt).toEqual(UTC('2026-10-30'));
  });

  it('reports nothing for an empty description', () => {
    expect(parseDeadline({ description: null }).deadlineAt).toBeNull();
    expect(parseDeadline({ description: '   ' }).deadlineAt).toBeNull();
  });

  it('reports the version constant for provenance callers', () => {
    expect(DEADLINE_EXTRACTION_VERSION).toBe('DEADLINE_EXTRACTION_V2');
  });
});
