import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import {
  hostnameOf,
  isGuarded,
  refuseCallerNamedIdentity,
} from '../../apps/api/auth';

/**
 * The two questions the guard answers without a server (ADR-0011 §5).
 *
 * `Host` parsing is here rather than only in the integration suite because an HTTP client cannot be
 * made to send an empty or malformed `Host` — it substitutes its own — so the branch that refuses a
 * header the deployment cannot read is unreachable through `inject()`. The `userId` refusal is here
 * for the same reason in reverse: it is a string rule about a parameter no route uses any more, and
 * spelling out which spellings count is cheaper than discovering it from a 400 in six months.
 */

describe('the hostname a Host header names', () => {
  it('refuses a header that is absent, empty or unreadable', () => {
    expect(hostnameOf(undefined)).toBeNull();
    expect(hostnameOf('')).toBeNull();
    expect(hostnameOf('   ')).toBeNull();
    expect(hostnameOf('evil.example:notaport')).toBeNull();
  });

  it('takes the hostname out of a host:port and drops the port', () => {
    expect(hostnameOf('127.0.0.1:3001')).toBe('127.0.0.1');
    expect(hostnameOf('localhost:80')).toBe('localhost');
  });

  it('unbrackets an IPv6 literal so it can match a bare ::1 in the allowlist', () => {
    expect(hostnameOf('[::1]:3001')).toBe('::1');
    expect(hostnameOf('[::1]')).toBe('::1');
  });

  it('compares case-insensitively', () => {
    expect(hostnameOf('LocalHost')).toBe('localhost');
    expect(hostnameOf('EVIL.Example.')).toBe('evil.example.');
  });
});

describe('which routes need a principal', () => {
  it('guards everything under /api/, whatever the query string', () => {
    expect(isGuarded('/api/matches')).toBe(true);
    expect(isGuarded('/api/profile?userId=0b6b5934-b42d-4b06-b203-5ddd4475d100')).toBe(true);
  });

  it('leaves the pages and the probe alone', () => {
    expect(isGuarded('/health')).toBe(false);
    expect(isGuarded('/dashboard')).toBe(false);
    // A page whose path merely contains the letters is not the API.
    expect(isGuarded('/apifaux')).toBe(false);
  });
});

describe('a caller that names a candidate in its own parameters', () => {
  const request = (url: string, body?: unknown): FastifyRequest =>
    ({ url, ...(body === undefined ? {} : { body }) }) as unknown as FastifyRequest;

  it('refuses the parameter in the query, wherever it sits', () => {
    expect(() => refuseCallerNamedIdentity(request('/api/profile?userId=abc'))).toThrow(
      /takes no userId/,
    );
    expect(() => refuseCallerNamedIdentity(request('/api/matches?limit=5&userId=abc'))).toThrow(
      /takes no userId/,
    );
  });

  it('refuses a percent-encoded spelling of the key', () => {
    expect(() => refuseCallerNamedIdentity(request('/api/profile?user%49d=abc'))).toThrow(
      /takes no userId/,
    );
  });

  it('refuses a top-level body key, which is how the link route used to be aimed at anyone', () => {
    expect(() => refuseCallerNamedIdentity(request('/api/telegram/link', { userId: 'abc' }))).toThrow(
      /takes no userId/,
    );
    expect(() =>
      refuseCallerNamedIdentity(request('/api/telegram/link', { userId: undefined })),
    ).toThrow(/takes no userId/);
  });

  it('is not triggered by a similarly shaped parameter that is not the identity', () => {
    expect(() => refuseCallerNamedIdentity(request('/api/matches?limit=5'))).not.toThrow();
    // Case matters here for the same reason it matters to Ajv: `UserID` is not a key any route
    // reads, so refusing it would punish a caller for a parameter that cannot name anyone.
    expect(() => refuseCallerNamedIdentity(request('/api/matches?UserID=5'))).not.toThrow();
    expect(() => refuseCallerNamedIdentity(request('/api/jobs', ['a']))).not.toThrow();
    expect(() => refuseCallerNamedIdentity(request('/api/profile'))).not.toThrow();
  });
});
