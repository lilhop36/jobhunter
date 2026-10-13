import { classifyLocation } from '@domain/normalizers/location/location-classifier';

describe('location classifier', () => {
  it('hybrid', () => {
    const r = classifyLocation({ text: 'hybrid role' });
    expect(r.category).toBe('HYBRID');
    expect(r.remoteStatus).toBe('HYBRID');
  });

  it('remote ethiopia', () => {
    const r = classifyLocation({ text: 'Remote - Ethiopia' });
    expect(r.category).toBe('ETHIOPIA_REMOTE');
    expect(r.remoteStatus).toBe('REMOTE');
  });

  it('remote international', () => {
    const r = classifyLocation({ text: 'remote global' });
    expect(r.category).toBe('INTERNATIONAL_REMOTE');
  });

  it('remote with no geography stays UNKNOWN category but REMOTE status', () => {
    const r = classifyLocation({ text: 'remote' });
    expect(r.category).toBe('UNKNOWN');
    expect(r.remoteStatus).toBe('REMOTE');
  });

  it('addis ababa', () => {
    const r = classifyLocation({ text: 'Addis Ababa' });
    expect(r.category).toBe('ADDIS_ABABA');
  });

  it('addis ababa with country wrapper', () => {
    const r = classifyLocation({ text: 'Addis Ababa, Ethiopia' });
    expect(r.category).toBe('ADDIS_ABABA');
  });

  it('ethiopian city', () => {
    const r = classifyLocation({ text: 'Hawassa' });
    expect(r.category).toBe('ETHIOPIA_CITY');
  });

  it('ethiopian region', () => {
    const r = classifyLocation({ text: 'Oromia Region' });
    expect(r.category).toBe('ETHIOPIA_REGION');
  });

  it('multiple ethiopian places lower confidence', () => {
    const r = classifyLocation({ text: 'Adama / Hawassa' });
    expect(r.category).toBe('ETHIOPIA_CITY');
    expect(r.confidence).toBeLessThan(80);
  });

  it('international on-site', () => {
    const r = classifyLocation({ text: 'Nairobi, Kenya' });
    expect(r.category).toBe('INTERNATIONAL_ON_SITE');
  });

  it('conflicting signals -> UNKNOWN', () => {
    const r = classifyLocation({ text: 'Addis Ababa / London' });
    expect(r.category).toBe('UNKNOWN');
    expect(r.signals).toContain('CONFLICTING');
  });

  it('empty -> unknown', () => {
    const r = classifyLocation({ text: '' });
    expect(r.category).toBe('UNKNOWN');
    expect(r.confidence).toBe(0);
  });
});
