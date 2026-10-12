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
  });

  it('remote international', () => {
    const r = classifyLocation({ text: 'remote global' });
    expect(r.category).toBe('INTERNATIONAL_REMOTE');
  });

  it('remote with no geography', () => {
    const r = classifyLocation({ text: 'remote' });
    expect(r.category).toBe('UNKNOWN');
    expect(r.remoteStatus).toBe('REMOTE');
  });

  it('addis ababa', () => {
    const r = classifyLocation({ text: 'Addis Ababa' });
    expect(r.category).toBe('ADDIS_ABABA');
  });

  it('empty -> unknown', () => {
    const r = classifyLocation({ text: '' });
    expect(r.category).toBe('UNKNOWN');
  });
});
