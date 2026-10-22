import { CalendarType } from '@domain/enums';
import type { JobSourceAdapter, SourceAdapterConfig } from '@ports/source-adapter';
import { createEffoySiraAdapter } from '@infrastructure/adapters/effoysira';
import { createEthiojobsAdapter } from '@infrastructure/adapters/ethiojobs';

/**
 * One production source adapter, admitted only by an APPROVED record in `docs/sources`
 * (SRS Appendix E: "A source without a recorded approval has no adapter").
 */
export interface ProductionAdapterRegistration {
  /** `JobSource.name` the adapter serves; must match the approval record's `Source`. */
  readonly sourceName: string;
  /** Approval record filename under `docs/sources`, e.g. `acme-careers.md`. */
  readonly approvalRecord: string;
  /**
   * The source's approved declarations (SRS Appendix E): everything `SourceAdapterConfig`
   * needs except `sourceId`, which is resolved from the `JobSource` row at run time.
   *
   * These live here, beside the registration, rather than being parsed from the Markdown
   * record: the record is signed documentation, not runtime data, and a declaration that
   * changes must change under review in the same commit as the record it mirrors.
   */
  readonly config: Omit<SourceAdapterConfig, 'sourceId'>;
  /** Builds the adapter for an approved source from its resolved configuration. */
  readonly create: (config: SourceAdapterConfig) => JobSourceAdapter;
}

/**
 * Every adapter the worker may resolve in production. One entry per APPROVED record in
 * `docs/sources`; today EffoySira (effoysira.com) and Ethiojobs (ethiojobs.net).
 *
 * An entry here is a claim that `docs/sources/<approvalRecord>` exists and reads
 * `Status: APPROVED`; `tests/unit/source-approval-records.spec.ts` enforces that, so an
 * adapter cannot be registered without an approval record.
 *
 * {@link createAdapterRegistryResolver} is the runtime half of the same invariant: a source
 * is matched to its registration by `JobSource.name`, and a source with no registration has
 * no adapter. See ADR-0004.
 */
export const PRODUCTION_ADAPTERS: readonly ProductionAdapterRegistration[] = [
  {
    sourceName: 'EffoySira',
    approvalRecord: 'effoysira.md',
    config: {
      adapterType: 'EFFOYSIRA_STATIC_HTML',
      adapterVersion: '1.0.0',
      accessMechanism: 'STATIC_HTML',
      declaredCalendar: CalendarType.GREGORIAN,
      declaredDateFormat: null,
      declaredCurrency: null,
      canonicalUrlIdentityTrusted: true,
      options: { delayMs: 800, maxListingPages: 2 },
    },
    create: (config) => createEffoySiraAdapter(config),
  },
  {
    sourceName: 'Ethiojobs',
    approvalRecord: 'ethiojobs.md',
    config: {
      adapterType: 'ETHIOJOBS_STATIC_HTML',
      adapterVersion: '1.0.0',
      accessMechanism: 'STATIC_HTML',
      declaredCalendar: CalendarType.GREGORIAN,
      declaredDateFormat: null,
      declaredCurrency: null,
      canonicalUrlIdentityTrusted: true,
      options: { delayMs: 800, maxListingPages: 2 },
    },
    create: (config) => createEthiojobsAdapter(config),
  },
];

/** The only slice of the source repository the resolver needs: a source id and its name. */
export interface AdapterSourceLookup {
  findById(id: string): Promise<{ id: string; name: string } | null>;
}

export interface AdapterRegistryResolverOptions {
  /** Source rows, consulted by id (SRS Appendix E approvals are keyed by name). */
  sources: AdapterSourceLookup;
  /** Defaults to {@link PRODUCTION_ADAPTERS}; injectable so tests can exercise the wiring. */
  registrations?: readonly ProductionAdapterRegistration[];
}

/**
 * Builds the worker's `resolveAdapter` (SRS 7.2, Appendix E; ADR-0004): look up the source,
 * match its name to an approved registration, and build the adapter from the registration's
 * declarations plus the row's id. Returns null - which the collection handler reports as a
 * clear permanent failure - when the id is unknown or the source is not approved.
 */
export function createAdapterRegistryResolver(
  options: AdapterRegistryResolverOptions,
): (sourceId: string) => Promise<JobSourceAdapter | null> {
  const registrations = options.registrations ?? PRODUCTION_ADAPTERS;
  const byName = new Map(
    registrations.map((registration) => [registration.sourceName, registration]),
  );

  // No source is approved yet: nothing can resolve, so skip the lookup entirely.
  if (byName.size === 0) return async () => null;

  return async (sourceId) => {
    const source = await options.sources.findById(sourceId);
    if (source === null) return null;
    const registration = byName.get(source.name);
    if (registration === undefined) return null;
    return registration.create({ ...registration.config, sourceId: source.id });
  };
}
