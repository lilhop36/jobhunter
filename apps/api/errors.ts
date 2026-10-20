import type { FastifyInstance } from 'fastify';

/**
 * The SRS 3.4 error format, verbatim:
 *
 * {
 *   "error": {
 *     "code": "SOURCE_RUN_ACTIVE",
 *     "message": "Source collection is already running"
 *   }
 * }
 *
 * `details` is the one addition: the SRS fixes `code` and `message` but not how to explain a
 * bad request, and a validation error with no field name is not actionable.
 */
export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export const ERROR_CODES = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  SOURCE_RUN_ACTIVE: 'SOURCE_RUN_ACTIVE',
  SOURCE_DISABLED: 'SOURCE_DISABLED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** A failure the API can describe to the caller. Anything else becomes a generic 500. */
export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly statusCode: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static validation(message: string, details?: unknown): ApiError {
    return new ApiError(ERROR_CODES.VALIDATION_ERROR, message, 400, details);
  }

  static notFound(message: string): ApiError {
    return new ApiError(ERROR_CODES.NOT_FOUND, message, 404);
  }

  /**
   * SRS 3.4: a manual run while one is already in flight is a conflict. The message is the
   * SRS example's message word for word.
   */
  static sourceRunActive(sourceId: string): ApiError {
    return new ApiError(ERROR_CODES.SOURCE_RUN_ACTIVE, 'Source collection is already running', 409, {
      sourceId,
    });
  }

  /**
   * ADR-0003 / SRS 3.4: a disabled source is out of service and is never collected, by
   * schedule or by a manual run. A conflict (409), like the active-run refusal: the request
   * is well-formed but conflicts with the source's current state.
   */
  static sourceDisabled(sourceId: string): ApiError {
    return new ApiError(ERROR_CODES.SOURCE_DISABLED, 'Source is disabled', 409, { sourceId });
  }
}

function envelope(code: string, message: string, details?: unknown): ApiErrorEnvelope {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

/**
 * Make every response — including 404s and 500s — use the SRS envelope, and keep internal
 * detail out of it. Validation failures report the offending field; everything unexpected is
 * logged server-side and answered with one fixed sentence, so no stack trace, SQL or
 * credential can reach the client.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send(envelope(error.code, error.message, error.details));
    }

    // Fastify/Ajv request-validation failures carry `validation`; their `message` echoes the
    // schema, so it is replaced with a fixed sentence and only the field path is reported.
    if (error.validation) {
      const details = error.validation.map((issue) => ({
        path: issue.instancePath === '' ? '(request)' : issue.instancePath,
        message: issue.message ?? 'invalid',
      }));
      return reply
        .code(400)
        .send(envelope(ERROR_CODES.VALIDATION_ERROR, 'Request validation failed', details));
    }

    // Fastify's own request-level errors (unsupported media type, empty JSON body, payload
    // too large...) carry their target status. A caller mistake must not be reported as a
    // server failure, so it keeps that status with the generic malformed-request code; the
    // message is Fastify's and names no internals. Anything 4xx↑ that reaches here unrelated
    // to the request stays a 500 below.
    if (
      typeof error.statusCode === 'number' &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    ) {
      return reply.code(error.statusCode).send(envelope(ERROR_CODES.VALIDATION_ERROR, error.message));
    }

    request.log.error({ err: error }, 'Unhandled API error');
    return reply
      .code(500)
      .send(envelope(ERROR_CODES.INTERNAL_ERROR, 'An unexpected error occurred'));
  });

  app.setNotFoundHandler((request, reply) =>
    reply
      .code(404)
      .send(envelope(ERROR_CODES.NOT_FOUND, `No route for ${request.method} ${request.url}`)),
  );
}
