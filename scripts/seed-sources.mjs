/**
 * Operator-run seed: creates the `JobSource` row for an approved source.
 *
 * Run once per environment after `prisma migrate deploy`:
 *   DATABASE_URL=postgres://... node scripts/seed-sources.mjs
 *
 * The row is created, never clobbered: `enabled`, `schedule` and health state are
 * operational fields an operator may have changed after creation, and re-seeding must not
 * silently flip them back. Approval itself lives in `docs/sources/effoysira.md` and the
 * production adapter registry (ADR-0004) - this row only names the source the worker
 * resolves (SRS Appendix E: a source without a recorded approval has no adapter).
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

await prisma.jobSource.upsert({
  where: { name: 'EffoySira' },
  // Operational fields (enabled, schedule) are left untouched on re-run.
  update: {},
  create: {
    name: 'EffoySira',
    adapterType: 'EFFOYSIRA_STATIC_HTML',
    adapterVersion: '1.0.0',
    enabled: true,
    // Points at the signed approval record; inert to the runtime (ADR-0003: approval is
    // enforced by the registry, not by DB state).
    accessPolicy: { approvalRecord: 'docs/sources/effoysira.md' },
    // Posting site, updated daily; four collections a day is ample and polite.
    schedule: '6h',
  },
});

console.log('seeded JobSource: EffoySira (EFFOYSIRA_STATIC_HTML 1.0.0, enabled, schedule 6h)');

await prisma.jobSource.upsert({
  where: { name: 'Ethiojobs' },
  update: {},
  create: {
    name: 'Ethiojobs',
    adapterType: 'ETHIOJOBS_STATIC_HTML',
    adapterVersion: '1.0.0',
    enabled: true,
    accessPolicy: { approvalRecord: 'docs/sources/ethiojobs.md' },
    schedule: '6h',
  },
});

console.log('seeded JobSource: Ethiojobs (ETHIOJOBS_STATIC_HTML 1.0.0, enabled, schedule 6h)');

await prisma.jobSource.upsert({
  where: { name: 'JobWebEthiopia' },
  update: {},
  create: {
    name: 'JobWebEthiopia',
    adapterType: 'JOBWEBETHIOPIA_STATIC_HTML',
    adapterVersion: '1.0.0',
    enabled: true,
    accessPolicy: { approvalRecord: 'docs/sources/jobwebethiopia.md' },
    // The publisher asks for one request per 30 s, so a run reads only the newest few
    // postings; a shorter schedule - not a bigger page budget - keeps coverage current.
    schedule: '3h',
  },
});

console.log('seeded JobSource: JobWebEthiopia (JOBWEBETHIOPIA_STATIC_HTML 1.0.0, enabled, schedule 3h)');
await prisma.$disconnect();
