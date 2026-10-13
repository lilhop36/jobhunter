import { Prisma, PrismaClient } from '@prisma/client';
import {
  ObserveRawJobInput,
  ObserveRawJobResult,
  RawJobRecord,
  RawJobRepository,
} from '@ports/raw-job-repository';

/**
 * Database clock as a `timestamp(3)` UTC wall-clock value. See
 * PrismaSourceRunRepository for why a bare `now()` must not be used: the timestamp
 * columns are without time zone, so a `timestamptz` would be written in the session's
 * zone and silently shift every value.
 */
const NOW_UTC = Prisma.raw("date_trunc('milliseconds', now() AT TIME ZONE 'UTC')");

const RAW_JOB_COLUMNS = Prisma.raw(`
  "id", "sourceId", "sourceRunId", "sourceJobIdentifier", "sourceUrl", "rawTitle",
  "rawCompany", "rawLocation", "rawDescription", "rawPublishedDateText", "rawSalaryText",
  "contentHash", "collectedAt", "lastSeenAt", "createdAt"
`);

interface RawJobRow {
  id: string;
  sourceId: string;
  sourceRunId: string | null;
  sourceJobIdentifier: string | null;
  sourceUrl: string | null;
  rawTitle: string | null;
  rawCompany: string | null;
  rawLocation: string | null;
  rawDescription: string | null;
  rawPublishedDateText: string | null;
  rawSalaryText: string | null;
  contentHash: string;
  collectedAt: Date | string;
  lastSeenAt: Date | string;
  createdAt: Date | string;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toRecord(row: RawJobRow): RawJobRecord {
  return {
    id: row.id,
    sourceId: row.sourceId,
    sourceRunId: row.sourceRunId,
    sourceJobIdentifier: row.sourceJobIdentifier,
    sourceUrl: row.sourceUrl,
    rawTitle: row.rawTitle,
    rawCompany: row.rawCompany,
    rawLocation: row.rawLocation,
    rawDescription: row.rawDescription,
    rawPublishedDateText: row.rawPublishedDateText,
    rawSalaryText: row.rawSalaryText,
    contentHash: row.contentHash,
    collectedAt: toDate(row.collectedAt),
    lastSeenAt: toDate(row.lastSeenAt),
    createdAt: toDate(row.createdAt),
  };
}

/**
 * Append-only PostgreSQL store of raw source evidence (ENG-002, ADR-0001).
 *
 * There are deliberately **two** insert statements rather than one. A partial unique
 * index is only inferred by an `ON CONFLICT` whose predicate it can satisfy, so the
 * repository picks the statement that matches which index actually covers the row:
 * a record with an identifier is covered by `one_raw_observation_per_identifier`, a
 * record without one by `one_raw_observation_per_content`. The predicate text is
 * identical to the index predicate on purpose; a mismatch makes PostgreSQL raise
 * `42P10` rather than silently conflict on the wrong guarantee.
 *
 * Concurrency: the pipeline holds at most one active run per source
 * (`one_active_run_per_source`), and an `(sourceId, identityKey)` row has a single
 * writer within that run, so the check-then-act below is not racy in practice.
 */
export class PrismaRawJobRepository implements RawJobRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async observe(input: ObserveRawJobInput): Promise<ObserveRawJobResult> {
    const { sourceId, sourceRunId = null, evidence, contentHash } = input;
    const identifier = evidence.sourceJobIdentifier ?? null;
    // Route on null-ness, matching which index actually covers the row: `''` is NOT NULL
    // in PostgreSQL, so it is covered by the identifier index, not the content index.
    const hasIdentifier = identifier !== null;
    const payload =
      evidence.rawPayload === null || evidence.rawPayload === undefined
        ? null
        : JSON.stringify(evidence.rawPayload);
    const collectedAt = evidence.collectedAt ? evidence.collectedAt.toISOString() : null;

    return this.prisma.$transaction(async (tx) => {
      const inserted = hasIdentifier
        ? await tx.$queryRaw<RawJobRow[]>`
            INSERT INTO "raw_jobs" (
              "id", "sourceId", "sourceRunId", "sourceJobIdentifier", "sourceUrl",
              "rawTitle", "rawCompany", "rawLocation", "rawDescription",
              "rawPublishedDateText", "rawSalaryText", "rawPayload", "contentHash",
              "collectedAt", "lastSeenAt", "createdAt"
            ) VALUES (
              gen_random_uuid(), ${sourceId}::uuid, ${sourceRunId}::uuid, ${identifier},
              ${evidence.sourceUrl}, ${evidence.rawTitle}, ${evidence.rawCompany},
              ${evidence.rawLocation}, ${evidence.rawDescription},
              ${evidence.rawPublishedDateText}, ${evidence.rawSalaryText},
              ${payload}::jsonb, ${contentHash},
              COALESCE(${collectedAt}::timestamp(3), ${NOW_UTC}), ${NOW_UTC}, ${NOW_UTC}
            )
            ON CONFLICT ("sourceId", "sourceJobIdentifier", "contentHash")
              WHERE "sourceJobIdentifier" IS NOT NULL
            DO NOTHING
            RETURNING ${RAW_JOB_COLUMNS}
          `
        : await tx.$queryRaw<RawJobRow[]>`
            INSERT INTO "raw_jobs" (
              "id", "sourceId", "sourceRunId", "sourceJobIdentifier", "sourceUrl",
              "rawTitle", "rawCompany", "rawLocation", "rawDescription",
              "rawPublishedDateText", "rawSalaryText", "rawPayload", "contentHash",
              "collectedAt", "lastSeenAt", "createdAt"
            ) VALUES (
              gen_random_uuid(), ${sourceId}::uuid, ${sourceRunId}::uuid, NULL,
              ${evidence.sourceUrl}, ${evidence.rawTitle}, ${evidence.rawCompany},
              ${evidence.rawLocation}, ${evidence.rawDescription},
              ${evidence.rawPublishedDateText}, ${evidence.rawSalaryText},
              ${payload}::jsonb, ${contentHash},
              COALESCE(${collectedAt}::timestamp(3), ${NOW_UTC}), ${NOW_UTC}, ${NOW_UTC}
            )
            ON CONFLICT ("sourceId", "contentHash")
              WHERE "sourceJobIdentifier" IS NULL
            DO NOTHING
            RETURNING ${RAW_JOB_COLUMNS}
          `;

      if (inserted.length === 1) {
        return { rawJob: toRecord(inserted[0]), isNewObservation: true };
      }

      // Not new: this exact capture is already stored. Advance only the observation
      // time - no captured field is ever rewritten.
      const observed = hasIdentifier
        ? await tx.$queryRaw<RawJobRow[]>`
            UPDATE "raw_jobs" SET "lastSeenAt" = ${NOW_UTC}
            WHERE "sourceId" = ${sourceId}::uuid
              AND "sourceJobIdentifier" = ${identifier}
              AND "contentHash" = ${contentHash}
            RETURNING ${RAW_JOB_COLUMNS}
          `
        : await tx.$queryRaw<RawJobRow[]>`
            UPDATE "raw_jobs" SET "lastSeenAt" = ${NOW_UTC}
            WHERE "sourceId" = ${sourceId}::uuid
              AND "sourceJobIdentifier" IS NULL
              AND "contentHash" = ${contentHash}
            RETURNING ${RAW_JOB_COLUMNS}
          `;

      return { rawJob: toRecord(observed[0]), isNewObservation: false };
    });
  }

  async findById(id: string): Promise<RawJobRecord | null> {
    const rows = await this.prisma.$queryRaw<RawJobRow[]>`
      SELECT ${RAW_JOB_COLUMNS} FROM "raw_jobs" WHERE "id" = ${id}::uuid
    `;
    return rows.length === 1 ? toRecord(rows[0]) : null;
  }

  async listForSourceRecord(
    sourceId: string,
    sourceJobIdentifier: string,
  ): Promise<RawJobRecord[]> {
    const rows = await this.prisma.$queryRaw<RawJobRow[]>`
      SELECT ${RAW_JOB_COLUMNS} FROM "raw_jobs"
      WHERE "sourceId" = ${sourceId}::uuid AND "sourceJobIdentifier" = ${sourceJobIdentifier}
      ORDER BY "collectedAt" ASC, "createdAt" ASC
    `;
    return rows.map(toRecord);
  }
}
