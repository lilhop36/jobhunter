import type { FastifyInstance } from 'fastify';
import { pathOf } from './url';

/**
 * One log line per request, with the query string withheld (SRS 8.5; ADR-0011 §3).
 *
 * Fastify's default request logging serialises `req.url` whole. Until now that was only a matter of
 * taste — no URL carried anything secret — but a local sign-in link is a one-time credential in a
 * query parameter, and a token that reaches `logs/`, a terminal scrollback or a bug report is a
 * token that has leaked. `disableRequestLogging` is therefore turned on in `buildApi` and these two
 * lines replace it: same messages, same shape for anything that greps them, and the path instead of
 * the URL.
 *
 * The alternative — redacting `req.url` through pino — replaces the whole value, which would take
 * the path with it and leave a log line that says a request happened somewhere. Fastify 5's
 * `requestLogCustomSerializer` is the cleaner version of this and belongs with that upgrade
 * (audit M8); this is what the current version allows.
 *
 * Nothing else in the app logs a URL: `request.log` children bind only `reqId`, and the error
 * handler logs the error, not the request target.
 *
 * The keys are `request` and `response`, not Fastify's own `req`/`res`: those two names are
 * intercepted by its log serializer, which substitutes its own view of the request — and a plain
 * object handed to it comes out as nothing but a method. The names are also the honest ones: these
 * are summaries of a request, not the objects themselves.
 */
export function registerRequestLogging(app: FastifyInstance): void {
  app.addHook('onRequest', async (request) => {
    request.log.info(
      { request: { method: request.method, path: pathOf(request.url), remoteAddress: request.ip } },
      'incoming request',
    );
  });

  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        request: { method: request.method, path: pathOf(request.url), remoteAddress: request.ip },
        response: { statusCode: reply.statusCode },
        responseTime: reply.elapsedTime,
      },
      'request completed',
    );
  });
}
