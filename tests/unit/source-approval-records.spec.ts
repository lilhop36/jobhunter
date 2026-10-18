import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CalendarType, SourceRunTrigger, WorkTaskStatus } from '@domain/enums';
import type { WorkTaskRecord } from '@domain/types';
import {
  SOURCE_COLLECTION_TASK_TYPE,
  createSourceCollectionHandler,
  type RunSourceCollection,
} from '@application/ingestion';
import { PermanentWorkTaskError } from '@application/worker';
import {
  PRODUCTION_ADAPTERS,
  createAdapterRegistryResolver,
  type ProductionAdapterRegistration,
} from '@app/worker/adapters';
import { FakeSourceAdapter } from '../support/fake-source-adapter';

/**
 * SRS Appendix E: "A source without a recorded approval has no adapter." The approval
 * convention lives in `docs/sources`; these tests make an adapter registration fail loudly
 * when its record is missing or not explicitly APPROVED.
 */

const RECORDS_DIR = path.resolve('docs/sources');
const STATUS_LINE = /^-\s*\*\*Status:\*\*\s*(\S+)\s*$/m;
const NON_RECORDS = new Set(['README.md', 'TEMPLATE.md']);

function readStatus(file: string): string | null {
  const match = STATUS_LINE.exec(readFileSync(path.join(RECORDS_DIR, file), 'utf8'));
  return match ? (match[1] as string) : null;
}

const files = readdirSync(RECORDS_DIR).filter((name) => name.endsWith('.md'));

describe('source approval records (SRS Appendix E)', () => {
  it('ships a template that defaults to PENDING and is not an approval', () => {
    expect(files).toContain('TEMPLATE.md');
    expect(readStatus('TEMPLATE.md')).toBe('PENDING');
  });

  it('rejects a record without an explicit recognised status', () => {
    for (const file of files.filter((name) => !NON_RECORDS.has(name))) {
      expect(['APPROVED', 'PENDING', 'REJECTED']).toContain(readStatus(file));
    }
  });

  it('registers production adapters under unique, non-empty source names', () => {
    const names = PRODUCTION_ADAPTERS.map((registration) => registration.sourceName);
    expect(names.every((name) => name.trim() !== '')).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every production adapter an explicit APPROVED record', () => {
    for (const registration of PRODUCTION_ADAPTERS) {
      expect(files).toContain(registration.approvalRecord);
      expect(readStatus(registration.approvalRecord)).toBe('APPROVED');
    }
  });
});

/**
 * The runtime half of the invariant: `createAdapterRegistryResolver` is the worker's
 * production `resolveAdapter` (ADR-0004). These tests inject a registration list so the
 * wiring is exercised without approving a real source (PRODUCTION_ADAPTERS stays empty).
 */
describe('adapter registry resolver (SRS 7.2, Appendix E; ADR-0004)', () => {
  const REGISTERED_ROW = { id: '11111111-1111-1111-1111-111111111111', name: 'Acme Careers' };
  const UNREGISTERED_ROW = { id: '22222222-2222-2222-2222-222222222222', name: 'Not Approved' };

  const registration: ProductionAdapterRegistration = {
    sourceName: 'Acme Careers',
    approvalRecord: 'acme-careers.md',
    config: {
      adapterType: 'ACME_FEED',
      adapterVersion: '1.0.0',
      accessMechanism: 'FEED',
      declaredCalendar: CalendarType.UNKNOWN,
      declaredDateFormat: null,
      declaredCurrency: null,
      canonicalUrlIdentityTrusted: false,
      options: { feedUrl: 'https://acme.test/jobs.rss' },
    },
    create: (config) => new FakeSourceAdapter(config),
  };

  function lookup(rows: Array<{ id: string; name: string }>) {
    return { findById: async (id: string) => rows.find((row) => row.id === id) ?? null };
  }

  function resolveWith(
    rows: Array<{ id: string; name: string }>,
    registrations: readonly ProductionAdapterRegistration[] = [registration],
  ) {
    return createAdapterRegistryResolver({ sources: lookup(rows), registrations });
  }

  it('builds the adapter for a source whose name has an approved registration', async () => {
    const adapter = await resolveWith([REGISTERED_ROW])(REGISTERED_ROW.id);

    expect(adapter).not.toBeNull();
    // The id comes from the row; the declarations come from the registration.
    expect(adapter?.config.sourceId).toBe(REGISTERED_ROW.id);
    expect(adapter?.config.adapterType).toBe('ACME_FEED');
    expect(adapter?.config.options).toEqual({ feedUrl: 'https://acme.test/jobs.rss' });
  });

  it('resolves nothing for a source whose name has no approved registration', async () => {
    await expect(resolveWith([UNREGISTERED_ROW])(UNREGISTERED_ROW.id)).resolves.toBeNull();
  });

  it('resolves nothing for an unknown source id', async () => {
    await expect(resolveWith([REGISTERED_ROW])('99999999-9999-9999-9999-999999999999')).resolves.toBeNull();
  });

  it('matches against the production registry by default, not a supplied one', async () => {
    // No `registrations` argument: the resolver reads PRODUCTION_ADAPTERS, which cannot
    // serve a source it does not list.
    await expect(
      createAdapterRegistryResolver({ sources: lookup([UNREGISTERED_ROW]) })(UNREGISTERED_ROW.id),
    ).resolves.toBeNull();
  });

  it('skips the source lookup entirely while nothing is registered', async () => {
    const resolver = createAdapterRegistryResolver({
      registrations: [],
      sources: {
        findById: async () => {
          throw new Error('the source lookup must not run when no adapter is registered');
        },
      },
    });

    await expect(resolver(REGISTERED_ROW.id)).resolves.toBeNull();
  });

  /**
   * The two halves composed, which is how the worker runs them: the registry resolver reports
   * "no adapter", and the collection handler turns that into a PERMANENT failure. Retrying an
   * unregistered source can never conjure an adapter, so it must not be retried until it
   * dead-letters in front of an operator (SRS 7.2). The collection must not start either.
   */
  it('fails the task permanently, without collecting, when the source has no approved adapter', async () => {
    const handler = createSourceCollectionHandler({
      resolveAdapter: resolveWith([UNREGISTERED_ROW]),
      collection: {
        run: async () => {
          throw new Error('a source without an adapter must not be collected');
        },
      } as unknown as RunSourceCollection,
      staleRunSeconds: 60,
      acquisitionTimeoutMs: 1_000,
    });

    await expect(
      handler({ task: queuedCollection(UNREGISTERED_ROW.id), signal: new AbortController().signal }),
    ).rejects.toThrow(new PermanentWorkTaskError(`no adapter is configured for source ${UNREGISTERED_ROW.id}`));
  });
});

/** A task row shaped like one the queue would hand the worker; only `payload` is read. */
function queuedCollection(sourceId: string): WorkTaskRecord {
  const at = new Date(0);
  return {
    id: '11111111-1111-1111-1111-111111111111',
    type: SOURCE_COLLECTION_TASK_TYPE,
    payload: { sourceId, trigger: SourceRunTrigger.SCHEDULE },
    dedupeKey: null,
    status: WorkTaskStatus.PENDING,
    priority: 0,
    attempts: 1,
    maxAttempts: 5,
    runAfter: at,
    lockedAt: null,
    lockedBy: null,
    leaseToken: null,
    leaseExpiresAt: null,
    sourceRunId: null,
    lastError: null,
    lastErrorAt: null,
    createdAt: at,
    updatedAt: at,
    startedAt: null,
    finishedAt: null,
  };
}
