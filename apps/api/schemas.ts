import { HealthStatus, SourceRunStatus, SourceRunTrigger } from '@domain/enums';

/**
 * Request schemas for the Phase 1 source endpoints.
 *
 * These are JSON Schema, not Zod: Fastify validates and coerces with the Ajv instance it
 * already ships, so the API adds no validation library. Fastify's defaults are what make this
 * work — `coerceTypes` turns `?limit=2` into the number 2 and `?includeDisabled=true` into a
 * boolean, and `useDefaults` applies each `default` below.
 *
 * Enums are derived from the domain enums, so a filter can never accept a status the system
 * does not have.
 */
const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

export const sourceIdParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', pattern: UUID_PATTERN } },
  additionalProperties: false,
} as const;

/** Shared by both list endpoints. 100 is the hard ceiling on page size. */
const paginationProperties = {
  limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  cursor: { type: 'string', minLength: 1 },
} as const;

export const listSourcesQuery = {
  type: 'object',
  properties: {
    ...paginationProperties,
    includeDisabled: { type: 'boolean', default: false },
    healthStatus: { type: 'string', enum: Object.values(HealthStatus) },
  },
  additionalProperties: false,
} as const;

export const listRunsQuery = {
  type: 'object',
  properties: {
    ...paginationProperties,
    status: { type: 'string', enum: Object.values(SourceRunStatus) },
    trigger: { type: 'string', enum: Object.values(SourceRunTrigger) },
  },
  additionalProperties: false,
} as const;

export const matchIdParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', pattern: UUID_PATTERN } },
  additionalProperties: false,
} as const;

/**
 * `GET /api/matches` filters. `matcherVersion` is optional here and defaults in the route to the
 * running `MATCHER_VERSION`, so a client that does not care about revisions gets the current
 * ones; asking for an older revision is how A/B evidence stays readable after a matcher change.
 */
export const listMatchesQuery = {
  type: 'object',
  properties: {
    ...paginationProperties,
    matcherVersion: { type: 'string', minLength: 1 },
    userId: { type: 'string', pattern: UUID_PATTERN },
  },
  additionalProperties: false,
} as const;
