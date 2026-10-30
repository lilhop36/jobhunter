import { describe, expect, it } from 'vitest';
import { ApiConfigError, LOOPBACK_HOSTS, isLoopbackHost, parseApiConfig } from '../../apps/api/config';

/**
 * API configuration as a security boundary (SRS 8.1, 8.3; ADR-0011).
 *
 * These are the rules that decide whether a process is allowed to exist, so they are tested as
 * pure parsing rather than through a server: what matters is that a dangerous configuration is
 * refused before a port is bound, and that is a fact about this function alone.
 */

const SECRET = 'a'.repeat(64);
const BASE = { DATABASE_URL: 'postgresql://user:pass@localhost:5433/jobhunter', AUTH_SECRET: SECRET };

describe('parseApiConfig: signing secret', () => {
  it('requires the secret that proves a caller’s identity', () => {
    expect(() => parseApiConfig({ DATABASE_URL: 'postgresql://test' })).toThrow(ApiConfigError);
    expect(() => parseApiConfig({ DATABASE_URL: 'postgresql://test' })).toThrow(
      'AUTH_SECRET is required',
    );
  });

  it('refuses a secret too short to be unforgeable', () => {
    expect(() =>
      parseApiConfig({ DATABASE_URL: 'postgresql://test', AUTH_SECRET: 'hunter2' }),
    ).toThrow(/at least 32 bytes/);
  });

  it('never quotes the secret it is refusing', () => {
    const leaked = 'too-short-to-sign-with';
    let message = '';
    try {
      parseApiConfig({ DATABASE_URL: 'postgresql://test', AUTH_SECRET: leaked });
    } catch (error) {
      message = (error as Error).message;
    }
    // A configuration error is the one thing an operator pastes into a report (SRS 8.5).
    expect(message).toContain('AUTH_SECRET');
    expect(message).not.toContain(leaked);
  });

  it('signs with the trimmed value, so a trailing space in .env cannot forge every credential', () => {
    const padded = parseApiConfig({ ...BASE, AUTH_SECRET: `  ${SECRET}  ` });
    expect(padded.authSecret).toBe(SECRET);
  });
});

describe('parseApiConfig: bind interface', () => {
  it('defaults to loopback and accepts the loopback names', () => {
    const config = parseApiConfig(BASE);
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(3001);
    expect(config.loopback).toBe(true);
    expect(config.allowedHosts).toEqual([...LOOPBACK_HOSTS]);
  });

  it('treats every address in 127.0.0.0/8, localhost and ::1 as loopback', () => {
    for (const host of ['127.0.0.1', '127.2.3.4', 'localhost', '::1', '[::1]']) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const host of ['0.0.0.0', '::', '192.168.1.20', '10.0.0.5']) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });

  it('refuses to bind a network interface without being told to', () => {
    expect(() => parseApiConfig({ ...BASE, API_HOST: '0.0.0.0' })).toThrow(
      /not a loopback address/,
    );
    expect(() => parseApiConfig({ ...BASE, API_HOST: '192.168.1.20' })).toThrow(ApiConfigError);
  });

  it('accepts an explicit external bind that names the hostnames it answers for', () => {
    const config = parseApiConfig({
      ...BASE,
      API_HOST: '0.0.0.0',
      API_ALLOW_EXTERNAL_BIND: 'true',
      API_ALLOWED_HOSTS: 'jobs.example.com, 192.168.1.20',
    });
    expect(config.loopback).toBe(false);
    expect(config.allowedHosts).toEqual(['jobs.example.com', '192.168.1.20']);
  });

  it('refuses an external bind whose Host header could not be validated', () => {
    expect(() =>
      parseApiConfig({ ...BASE, API_HOST: '0.0.0.0', API_ALLOW_EXTERNAL_BIND: 'true' }),
    ).toThrow(/API_ALLOWED_HOSTS is required/);
  });

  it('rejects an out-of-range port', () => {
    expect(() => parseApiConfig({ ...BASE, API_PORT: '70000' })).toThrow('API_PORT');
  });
});
