import { describe, expect, it } from 'vitest';
import { SourceResultExpectation, type WorkTaskRecord } from '@domain/types';
import { SourceRunStatus } from '@domain/enums';
import type { RunSourceCollection, RunSourceCollectionInput } from '@application/ingestion';
import {
  createSourceCollectionHandler,
  SOURCE_COLLECTION_TASK_TYPE,
} from '@application/ingestion';
import { PermanentWorkTaskError, describeError } from '@application/worker';
import type { WorkerLogger } from '@ports/worker-logger';
import type { JobSourceAdapter } from '@ports/source-adapter';
import { FakeSourceAdapter, makeFakeConfig } from '../support/fake-source-adapter';

/**
 * The handler is the only production caller of `RunSourceCollection`. Whatever it does not
 * forward is silently absent for every scheduled run, which is how the unexpected-zero-result
 * signal (AC-018) stayed inert: the use case supports it, the handler never passed it.
 */

const TASK = {
  id: 'task-1',
  type: SOURCE_COLLECTION_TASK_TYPE,
  payload: { sourceId: '00000000-0000-0000-0000-000000000001', trigger: 'SCHEDULE' },
} as WorkTaskRecord;
const SOURCE_ID = '00000000-0000-0000-0000-000000000001';

function adapterWithExpectation(
  expectation: SourceResultExpectation | undefined,
): JobSourceAdapter {
  const config =
    expectation === undefined
      ? makeFakeConfig()
      : makeFakeConfig({ resultExpectation: expectation });
  return new FakeSourceAdapter(config);
}

function handlerCapturingRun(
  adapter: JobSourceAdapter,
  overrides: {
    outcome?: Partial<{
      status: SourceRunStatus;
      catalogueExhausted: boolean;
      oldestListingPublishedAt: Date | null;
    }>;
    sweep?: (sourceId: string) => Promise<{ retired: number; restored: number; examined: number }>;
    logger?: WorkerLogger;
  } = {},
): {
  input(): RunSourceCollectionInput;
  handler: ReturnType<typeof createSourceCollectionHandler>;
} {
  let captured: RunSourceCollectionInput | undefined;
  const collection = {
    run: async (input: RunSourceCollectionInput) => {
      captured = input;
      return {
        run: {
          id: 'run-1',
          sourceId: SOURCE_ID,
          catalogueExhausted: overrides.outcome?.catalogueExhausted ?? false,
          oldestListingPublishedAt: overrides.outcome?.oldestListingPublishedAt ?? null,
        },
        funnel: {
          collected: 1,
          parsed: 1,
          valid: 1,
          unique: 1,
          duplicates: 0,
          undeduplicable: 0,
          fallbackIdentities: 0,
          parseFailures: 0,
          httpFailures: 0,
        },
        status: overrides.outcome?.status ?? SourceRunStatus.SUCCEEDED,
        unexpectedZeroResults: false,
      };
    },
  } as unknown as RunSourceCollection;

  const handler = createSourceCollectionHandler({
    resolveAdapter: async () => adapter,
    collection,
    staleRunSeconds: 300,
    acquisitionTimeoutMs: 120_000,
    sweep: overrides.sweep,
    logger: overrides.logger,
  });

  return {
    input: () => {
      if (captured === undefined) throw new Error('collection.run was not called');
      return captured;
    },
    handler,
  };
}

describe('source collection handler — approved expectations reach the run', () => {
  it('forwards RESULTS_EXPECTED declared by the source', async () => {
    const { input, handler } = handlerCapturingRun(
      adapterWithExpectation(SourceResultExpectation.RESULTS_EXPECTED),
    );

    await handler({ task: TASK, signal: new AbortController().signal });

    expect(input().resultExpectation).toBe(SourceResultExpectation.RESULTS_EXPECTED);
  });

  it('leaves the expectation absent when the source declares none, so the use case keeps UNKNOWN', async () => {
    const { input, handler } = handlerCapturingRun(adapterWithExpectation(undefined));

    await handler({ task: TASK, signal: new AbortController().signal });

    expect(input().resultExpectation).toBeUndefined();
  });

  it('still refuses a source with no adapter as a permanent failure', async () => {
    const handler = createSourceCollectionHandler({
      resolveAdapter: async () => null,
      collection: {} as RunSourceCollection,
      staleRunSeconds: 300,
      acquisitionTimeoutMs: 120_000,
    });

    await expect(
      handler({ task: TASK, signal: new AbortController().signal }),
    ).rejects.toBeInstanceOf(PermanentWorkTaskError);
  });
});

describe('source collection handler — post-collection lifecycle sweep (FR-019)', () => {
  it('sweeps after a SUCCEEDED run that read the whole listing', async () => {
    const swept: string[] = [];
    const { handler } = handlerCapturingRun(adapterWithExpectation(undefined), {
      outcome: { status: SourceRunStatus.SUCCEEDED, catalogueExhausted: true },
      sweep: async (sourceId) => {
        swept.push(sourceId);
        return { retired: 2, restored: 0, examined: 5 };
      },
    });

    await handler({ task: TASK, signal: new AbortController().signal });

    expect(swept).toEqual([SOURCE_ID]);
  });

  it('sweeps after a SUCCEEDED run that recorded a dated coverage window', async () => {
    const swept: string[] = [];
    const { handler } = handlerCapturingRun(adapterWithExpectation(undefined), {
      outcome: {
        status: SourceRunStatus.SUCCEEDED,
        catalogueExhausted: false,
        oldestListingPublishedAt: new Date('2026-10-21T00:00:00.000Z'),
      },
      sweep: async (sourceId) => {
        swept.push(sourceId);
        return { retired: 1, restored: 0, examined: 5 };
      },
    });

    await handler({ task: TASK, signal: new AbortController().signal });
    expect(swept).toEqual([SOURCE_ID]);
  });

  it('does not sweep when the run left part of the listing unread and claimed no window', async () => {
    const swept: string[] = [];
    const { handler } = handlerCapturingRun(adapterWithExpectation(undefined), {
      outcome: {
        status: SourceRunStatus.SUCCEEDED,
        catalogueExhausted: false,
        oldestListingPublishedAt: null,
      },
      sweep: async (sourceId) => {
        swept.push(sourceId);
        return { retired: 0, restored: 0, examined: 5 };
      },
    });

    await handler({ task: TASK, signal: new AbortController().signal });
    expect(swept).toEqual([]);
  });

  it('does not sweep a partial run even if the adapter reported coverage', async () => {
    const swept: string[] = [];
    const { handler } = handlerCapturingRun(adapterWithExpectation(undefined), {
      outcome: { status: SourceRunStatus.PARTIAL, catalogueExhausted: true },
      sweep: async (sourceId) => {
        swept.push(sourceId);
        return { retired: 0, restored: 0, examined: 5 };
      },
    });

    await handler({ task: TASK, signal: new AbortController().signal });
    expect(swept).toEqual([]);
  });

  it('swallows a sweep error and still resolves the task', async () => {
    const { handler } = handlerCapturingRun(adapterWithExpectation(undefined), {
      outcome: { status: SourceRunStatus.SUCCEEDED, catalogueExhausted: true },
      sweep: async () => {
        throw new Error('sweep blew up');
      },
    });

    await expect(
      handler({ task: TASK, signal: new AbortController().signal }),
    ).resolves.toBeUndefined();
  });
});

describe('describeError — the cause chain is the diagnosis', () => {
  it('includes the nested cause a bare TypeError hides', () => {
    const error = new TypeError('fetch failed', {
      cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    });

    expect(describeError(error)).toBe(
      'TypeError: fetch failed (cause: read ECONNRESET)',
    );
  });

  it('bounds the depth and the length so one hostile cause cannot fill a log line', () => {
    let deep = new Error('level 4');
    for (const level of [3, 2, 1, 0]) deep = new Error(`level ${level}`, { cause: deep });
    expect(describeError(deep)).toContain('level 3');
    expect(describeError(deep)).not.toContain('level 4');

    const long = describeError(new Error('x'.repeat(2000)));
    expect(long.length).toBe(500);
    expect(long.endsWith('...')).toBe(true);
  });

  it('keeps a non-Error cause readable', () => {
    expect(describeError(new Error('upload failed', { cause: { code: 'EPIPE' } }))).toBe(
      'upload failed (cause: {"code":"EPIPE"})',
    );
  });
});
