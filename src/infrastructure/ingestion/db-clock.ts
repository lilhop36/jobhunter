import { Prisma } from '@prisma/client';

/**
 * The two ways this layer talks about time to PostgreSQL, both expressed the way the
 * `timestamp(3)`-without-time-zone columns require (ENG-022).
 *
 * A naive column holds a UTC wall clock by convention. A `timestamptz` is what a bare `now()` and a
 * bound `Date` are, and PostgreSQL resolves those against the *session* zone when comparing or
 * storing them next to a naive value — so the instant shifts by whatever offset the connecting
 * session happens to have, silently. The offset here is +3: a fence that must refuse a source whose
 * last success was one minute old accepted it, because the stored value had been read three hours
 * into the past and the source looked dead when it was not.
 */

/** The database clock, already converted to the naive UTC form the columns hold. */
const NOW_UTC_SQL = "date_trunc('milliseconds', now() AT TIME ZONE 'UTC')";

/** Splice the DB clock into a raw query. Code-controlled SQL, never external input. */
export const nowUtc = (): Prisma.Sql => Prisma.raw(NOW_UTC_SQL);

/**
 * Bind a clock value as ISO-8601 text for a `::timestamp(3)` cast — the convention every other
 * repository in this layer already follows (`prisma-job-match-repository.asTimestamp`), so a
 * comparison against one of these columns stays naive-to-naive, which is what it means.
 *
 * Truncation to milliseconds matches the column precision, the same reason
 * `prisma-source-run-repository.ts` truncates its own copy of the clock; that file is left alone
 * because its constant is entangled with the run columns it stamps.
 */
export const asTimestamp = (value: Date): string => value.toISOString();
