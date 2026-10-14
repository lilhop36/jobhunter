import { ApplicationMethod } from '@domain/enums';
import {
  APPLICATION_TARGET_VERSION,
  hasUsableApplicationPath,
  resolveApplicationTarget,
} from '@domain/normalizers/application-target';

describe('resolveApplicationTarget', () => {
  it('returns UNKNOWN with no target when there is no signal', () => {
    expect(resolveApplicationTarget({})).toEqual({
      method: ApplicationMethod.UNKNOWN,
      applyUrl: null,
      applyEmail: null,
      evidence: null,
    });
    expect(
      resolveApplicationTarget({ title: 'Backend Engineer', description: 'Build things.' }).method,
    ).toBe(ApplicationMethod.UNKNOWN);
  });

  it('detects an online application URL in application context', () => {
    const result = resolveApplicationTarget({
      description: 'Apply at https://jobs.example.com/apply/42 today.',
    });
    expect(result.method).toBe(ApplicationMethod.ONLINE_URL);
    expect(result.applyUrl).toBe('https://jobs.example.com/apply/42');
    expect(result.evidence).toContain('https://jobs.example.com/apply/42');
  });

  it('canonicalizes the detected URL (lowercase host, tracking params removed)', () => {
    const result = resolveApplicationTarget({
      description: 'Apply online: https://Jobs.Example.com/apply?utm_source=x',
    });
    expect(result.applyUrl).toBe('https://jobs.example.com/apply');
  });

  it('classifies a .pdf application URL as PDF_FORM', () => {
    const result = resolveApplicationTarget({
      description: 'Download and submit the form: https://example.com/form.pdf',
    });
    expect(result.method).toBe(ApplicationMethod.PDF_FORM);
    expect(result.applyUrl).toBe('https://example.com/form.pdf');
  });

  it('detects an application email in application context', () => {
    const result = resolveApplicationTarget({ description: 'Send your CV to hr@example.com.' });
    expect(result.method).toBe(ApplicationMethod.EMAIL);
    expect(result.applyEmail).toBe('hr@example.com');
  });

  it('accepts a mailto: link as an application email', () => {
    const result = resolveApplicationTarget({
      description: 'Questions? mailto:careers@example.com',
    });
    expect(result.method).toBe(ApplicationMethod.EMAIL);
    expect(result.applyEmail).toBe('careers@example.com');
  });

  it('ignores a contact address that is not in application context', () => {
    // No apply keyword: absence of evidence is not a fabricated application path (ER-04).
    expect(resolveApplicationTarget({ description: 'Our team is at info@example.com.' }).method).toBe(
      ApplicationMethod.UNKNOWN,
    );
  });

  it('detects an explicit apply-in-person instruction', () => {
    const result = resolveApplicationTarget({
      description: 'Apply in person at our Addis Ababa office.',
    });
    expect(result.method).toBe(ApplicationMethod.IN_PERSON);
  });

  it('prefers a URL over an email, so the method matches the recorded target', () => {
    const result = resolveApplicationTarget({
      description: 'Apply at https://jobs.example.com/apply or email hr@example.com.',
    });
    expect(result.method).toBe(ApplicationMethod.ONLINE_URL);
    expect(result.applyEmail).toBeNull();
  });

  it('does not mistake a title for an application path', () => {
    expect(resolveApplicationTarget({ title: 'Apply Now - Engineer' }).method).toBe(
      ApplicationMethod.UNKNOWN,
    );
  });

  it('is deterministic and never throws on hostile input', () => {
    const hostile = { description: '<script>alert(1)</script>\u0000 https://' };
    expect(() => resolveApplicationTarget(hostile)).not.toThrow();
    expect(resolveApplicationTarget(hostile)).toEqual(resolveApplicationTarget(hostile));
    expect(
      resolveApplicationTarget({ description: 42 as unknown as string }).method,
    ).toBe(ApplicationMethod.UNKNOWN);
  });

  it('exposes a stable version stamp', () => {
    expect(APPLICATION_TARGET_VERSION).toBe('APPLICATION_TARGET_V1');
  });
});

describe('hasUsableApplicationPath', () => {
  const url = {
    method: ApplicationMethod.ONLINE_URL,
    applyUrl: 'https://jobs.example.com/apply',
    applyEmail: null,
    evidence: 'x',
  };
  const email = {
    method: ApplicationMethod.EMAIL,
    applyUrl: null,
    applyEmail: 'hr@example.com',
    evidence: 'hr@example.com',
  };
  const unknown = {
    method: ApplicationMethod.UNKNOWN,
    applyUrl: null,
    applyEmail: null,
    evidence: null,
  };

  it('is true only when the method carries its required target', () => {
    expect(hasUsableApplicationPath(url)).toBe(true);
    expect(hasUsableApplicationPath(email)).toBe(true);
    expect(hasUsableApplicationPath(unknown)).toBe(false);
    expect(hasUsableApplicationPath({ ...url, applyUrl: null })).toBe(false);
    expect(hasUsableApplicationPath({ ...email, applyEmail: null })).toBe(false);
  });

  it('treats listing-based and instructional methods as usable', () => {
    for (const method of [
      ApplicationMethod.SOURCE_ACCOUNT,
      ApplicationMethod.IN_PERSON,
      ApplicationMethod.INSTRUCTIONS,
    ]) {
      expect(
        hasUsableApplicationPath({ method, applyUrl: null, applyEmail: null, evidence: null }),
      ).toBe(true);
    }
  });

  it('honours the informational-listings escape hatch (SRS 3.5)', () => {
    expect(hasUsableApplicationPath(unknown, { allowInformationalListings: true })).toBe(true);
    expect(hasUsableApplicationPath(unknown, { allowInformationalListings: false })).toBe(false);
    expect(hasUsableApplicationPath(unknown)).toBe(false);
  });
});
