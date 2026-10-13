import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyTestMigrations, createTestPrismaClient } from '../support/db';

/**
 * Guard for hand-written partial indexes (SRS 5.3, 7.5).
 *
 * Prisma cannot express partial indexes, so these live only in hand-written
 * migration SQL. A change that regenerates migrations from schema.prisma would
 * drop them silently and lose a DB-level guarantee that no application-level test
 * can substitute for. Every such index must be listed in
 * `GUARDED_PARTIAL_INDEXES`; the first case asserts the database contains exactly
 * that set, so both a dropped index and an unlisted new one fail the suite.
 */
interface PartialIndexGuard {
  name: string;
  table: string;
  /** Fragments that must appear in the index predicate (order-independent). */
  predicateIncludes: string[];
  /** The guarantee this index protects. */
  protects: string;
}

const GUARDED_PARTIAL_INDEXES: PartialIndexGuard[] = [
  {
    name: 'one_active_run_per_source',
    table: 'source_runs',
    predicateIncludes: [`status = 'RUNNING'::"SourceRunStatus"`],
    protects: 'at most one RUNNING SourceRun per source (FR-003, SRS 7.5)',
  },
  {
    name: 'one_active_task_per_dedupe_key',
    table: 'work_tasks',
    predicateIncludes: [
      `status = ANY (ARRAY['PENDING'::"WorkTaskStatus", 'RUNNING'::"WorkTaskStatus"])`,
      `"dedupeKey" IS NOT NULL`,
    ],
    protects: 'at most one active WorkTask per dedupeKey (SRS 7.5)',
  },
];

const prisma = createTestPrismaClient();

interface PartialIndexRow {
  index_name: string;
  table_name: string;
  predicate: string;
}

const PARTIAL_UNIQUE_INDEXES = `
  SELECT i.relname AS index_name,
         t.relname AS table_name,
         pg_get_expr(ix.indpred, ix.indrelid) AS predicate
  FROM pg_index ix
  JOIN pg_class i ON i.oid = ix.indexrelid
  JOIN pg_class t ON t.oid = ix.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND ix.indisunique
    AND ix.indpred IS NOT NULL
`;

beforeAll(() => {
  applyTestMigrations();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('hand-written partial indexes', () => {
  it('exist in the database exactly as listed', async () => {
    const rows = await prisma.$queryRawUnsafe<PartialIndexRow[]>(`${PARTIAL_UNIQUE_INDEXES} ORDER BY i.relname`);

    expect(rows.map((row) => `${row.table_name}.${row.index_name}`).sort()).toEqual(
      GUARDED_PARTIAL_INDEXES.map((index) => `${index.table}.${index.name}`).sort(),
    );
  });

  it.each(GUARDED_PARTIAL_INDEXES)(
    'index $name still enforces its predicate ($protects)',
    async ({ name, predicateIncludes }) => {
      const rows = await prisma.$queryRawUnsafe<PartialIndexRow[]>(
        `${PARTIAL_UNIQUE_INDEXES} AND i.relname = $1`,
        name,
      );

      expect(rows, `guarded partial index ${name} is missing`).toHaveLength(1);
      // pg_get_expr rendering may add line breaks; compare on collapsed whitespace.
      const predicate = rows[0].predicate.replace(/\s+/g, ' ');
      for (const fragment of predicateIncludes) {
        expect(predicate, `predicate of ${name}`).toContain(fragment.replace(/\s+/g, ' '));
      }
    },
  );
});
