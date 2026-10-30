import { Writable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerRequestLogging } from '../../apps/api/request-log';

/**
 * The request log keeps a credential out of the logs (SRS 8.5; ADR-0011 §3).
 *
 * The sign-in link that `npm run login` prints is a one-time token in a query parameter, and a
 * token that reaches a log line has leaked even on a single-operator machine: logs are pasted into
 * bug reports, and this one is 60 seconds of protection rather than none. So the app replaces
 * Fastify's default request logging, which serialises the whole URL, with these two lines.
 *
 * A bare Fastify instance is used rather than `buildApi`, because the thing under test is what the
 * logger writes and `buildApi` needs a database to have a logger at all.
 */

function loggedBy(level = 'info'): { app: FastifyInstance; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: unknown, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });

  const app = Fastify({
    // The `stream` destination is a pino option Fastify's own logger type does not carry, and
    // casting it poisons the inferred instance type — so the instance is named back afterwards.
    logger: { level, stream } as never,
    // What `buildApi` sets, and the reason these two lines have to exist.
    disableRequestLogging: true,
  }) as unknown as FastifyInstance;
  registerRequestLogging(app);

  return { app, text: () => chunks.join('') };
}

describe('the request log', () => {
  it('records the path and never the query string', async () => {
    const { app, text } = loggedBy();
    app.get('/login', async (_request, reply) => reply.send('ok'));

    await app.ready();
    await app.inject({ method: 'GET', url: '/login?code=ONE_TIME_SIGN_IN_CODE' });
    await app.close();

    const log = text();
    expect(log).not.toContain('ONE_TIME_SIGN_IN_CODE');
    expect(log).not.toContain('?code=');
    // The whole URL is gone, not merely the part after the `?`.
    expect(log).not.toContain('"url"');
    expect(log).toContain('"path":"/login"');
    expect(log).toContain('"remoteAddress":"127.0.0.1"');
    expect(log).toContain('incoming request');
    expect(log).toContain('request completed');
  });

  it('carries the status code and the response time an operator actually greps for', async () => {
    const { app, text } = loggedBy();
    app.get('/api/matches', async (_request, reply) => reply.code(401).send({ error: {} }));

    await app.ready();
    await app.inject({ method: 'GET', url: '/api/matches' });
    await app.close();

    expect(text()).toContain('"statusCode":401');
    expect(text()).toMatch(/"responseTime":\d+\.\d+/);
  });

  it('still logs a request that matched no route', async () => {
    const { app, text } = loggedBy();

    await app.ready();
    await app.inject({ method: 'GET', url: '/nowhere?code=STILL_NOT_LOGGED' });
    await app.close();

    expect(text()).toContain('"path":"/nowhere"');
    expect(text()).toContain('"statusCode":404');
    expect(text()).not.toContain('STILL_NOT_LOGGED');
  });
});
