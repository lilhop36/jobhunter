import { canonicalizeUrl, contentFingerprint } from '@domain/normalizers/url-normalizer';

describe('canonicalizeUrl', () => {
  it('lowercases host', () => {
    const url = 'https://Example.com/Path';
    expect(canonicalizeUrl(url)).toBe('https://example.com/Path');
  });

  it('handles protocol relative', () => {
    expect(canonicalizeUrl('//example.com/test')).toBe('https://example.com/test');
  });

  it('adds https if missing', () => {
    expect(canonicalizeUrl('example.com/page')).toBe('https://example.com/page');
  });

  it('removes tracking params', () => {
    const url = 'https://example.com/page?utm_source=x&utm_medium=y&keep=z';
    expect(canonicalizeUrl(url)).toBe('https://example.com/page?keep=z');
  });

  it('removes trailing slash except root', () => {
    expect(canonicalizeUrl('https://example.com/page/')).toBe('https://example.com/page');
    expect(canonicalizeUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('handles empty', () => {
    expect(canonicalizeUrl('')).toBeNull();
    expect(canonicalizeUrl(null as any)).toBeNull();
    expect(canonicalizeUrl(undefined as any)).toBeNull();
  });
});

describe('contentFingerprint', () => {
  it('is deterministic', () => {
    const a = contentFingerprint('Hello  World\n\nTest');
    const b = contentFingerprint('hello world test');
    expect(a).toBe(b);
  });

  it('empty gives empty string', () => {
    expect(contentFingerprint('')).toBe('');
    expect(contentFingerprint(null as any)).toBe('');
  });
});
