import {
  EmploymentType,
  HealthStatus,
  LocationCategory,
  NotificationFeedbackValue,
  NotificationStatus,
  RelocationPreference,
  RemotePreference,
  SalaryPeriod,
  SkillEvidence,
  SourceRunStatus,
  SourceRunTrigger,
} from '@domain/enums';

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

export const notificationIdParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', pattern: UUID_PATTERN } },
  additionalProperties: false,
} as const;

/**
 * `GET /api/notifications` filters. `userId` is optional for the same reason as on the matches
 * route: SRS 3.4 fixes no authentication, so the caller says whose notifications it wants, and
 * the running API binds to loopback until that is specified.
 */
export const listNotificationsQuery = {
  type: 'object',
  properties: {
    ...paginationProperties,
    userId: { type: 'string', pattern: UUID_PATTERN },
    status: { type: 'string', enum: Object.values(NotificationStatus) },
  },
  additionalProperties: false,
} as const;

/**
 * `POST /api/notifications/:id/feedback` (SRS 4.8 / FR-018).
 *
 * The three verdicts are the SRS's ("relevant / not relevant / unsure"), published as the enum
 * names the database stores, like every other enum this API exposes. `additionalProperties:
 * false` with `value` required means a client cannot send a fourth verdict or forget one.
 */
export const submitFeedbackBody = {
  type: 'object',
  required: ['value'],
  properties: { value: { type: 'string', enum: Object.values(NotificationFeedbackValue) } },
  additionalProperties: false,
} as const;

/**
 * `GET`/`PUT /api/profile` name the candidate in the query.
 *
 * Required here, unlike the list routes' optional `userId`: a profile belongs to exactly one
 * candidate, and a write with no owner would have to guess whose profile it replaces.
 */
export const profileQuery = {
  type: 'object',
  required: ['userId'],
  properties: { userId: { type: 'string', pattern: UUID_PATTERN } },
  additionalProperties: false,
} as const;

/** Every canonical monetary amount the domain accepts (DecimalAmount): at most two decimals. */
const DECIMAL_AMOUNT_PATTERN = '^(?:0|[1-9]\\d*)(?:\\.\\d{1,2})?$';

/**
 * `PUT /api/profile` (SRS 3.4, FR-012).
 *
 * Every field is **required**, including the ones that are explicitly null or empty: a save
 * states the whole profile, and `CandidateProfileRepository.saveForUser` replaces the child rows,
 * so a field the client omits would otherwise have to be guessed. Enums are derived from the
 * domain, and the amount pattern is the domain's own, so a value this schema accepts is a value
 * the domain constructor accepts.
 */
export const putProfileBody = {
  type: 'object',
  required: [
    'experienceYears',
    'remotePreference',
    'relocationPreference',
    'salaryPreference',
    'employmentPreferences',
    'skills',
    'targetRoles',
    'locationPreferences',
  ],
  properties: {
    experienceYears: { type: ['integer', 'null'], minimum: 0, maximum: 80 },
    remotePreference: { type: 'string', enum: Object.values(RemotePreference) },
    relocationPreference: { type: 'string', enum: Object.values(RelocationPreference) },
    salaryPreference: {
      oneOf: [
        { type: 'null' },
        {
          type: 'object',
          required: ['min', 'currency', 'period', 'requireDisclosed'],
          properties: {
            min: { type: ['string', 'null'], pattern: DECIMAL_AMOUNT_PATTERN },
            currency: { type: ['string', 'null'], pattern: '^[A-Z]{3}$' },
            period: {
              anyOf: [{ type: 'null' }, { type: 'string', enum: Object.values(SalaryPeriod) }],
            },
            requireDisclosed: { type: 'boolean' },
          },
          additionalProperties: false,
        },
      ],
    },
    employmentPreferences: {
      type: 'array',
      items: { type: 'string', enum: Object.values(EmploymentType) },
      uniqueItems: true,
    },
    skills: {
      type: 'array',
      items: {
        type: 'object',
        required: ['canonicalSkill', 'skillType', 'confidence'],
        properties: {
          canonicalSkill: { type: 'string', minLength: 1 },
          skillType: { type: 'string', enum: Object.values(SkillEvidence) },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
        additionalProperties: false,
      },
    },
    targetRoles: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'aliases'],
        properties: {
          title: { type: 'string', minLength: 1 },
          aliases: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true },
        },
        additionalProperties: false,
      },
    },
    locationPreferences: {
      type: 'array',
      items: {
        type: 'object',
        required: ['category', 'text'],
        properties: {
          category: { type: 'string', enum: Object.values(LocationCategory) },
          text: { type: ['string', 'null'], minLength: 1 },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const;
