import { describe, expect, it } from 'vitest';
import { emptyListingWindow, observeListingEntry } from '@domain/lifecycle/listing-window';

const day = (iso: string) => new Date(iso);

describe('listing window — the FR-019 coverage claim as it is built (audit M6)', () => {
  it('a newest-first listing keeps the claim and floors at the oldest entry read', () => {
    const window = emptyListingWindow();
    observeListingEntry(window, day('2026-11-02T00:00:00Z'));
    observeListingEntry(window, day('2026-11-01T00:00:00Z'));
    observeListingEntry(window, day('2026-10-29T00:00:00Z'));

    expect(window.claimable).toBe(true);
    expect(window.listingNotNewestFirst).toBe(false);
    expect(window.oldestPublishedAt).toEqual(day('2026-10-29T00:00:00Z'));
  });

  it('entries published on the same day are in order', () => {
    const window = emptyListingWindow();
    observeListingEntry(window, day('2026-11-01T00:00:00Z'));
    observeListingEntry(window, day('2026-11-01T00:00:00Z'));

    expect(window.claimable).toBe(true);
    expect(window.listingNotNewestFirst).toBe(false);
  });

  it('one entry newer than the entry before it voids the claim and says why', () => {
    const window = emptyListingWindow();
    observeListingEntry(window, day('2026-11-02T00:00:00Z'));
    observeListingEntry(window, day('2026-10-30T00:00:00Z'));
    // Read later, published later: the pages are not a newest-first prefix, so postings newer
    // than the floor may sit beyond the pages this run read.
    observeListingEntry(window, day('2026-11-01T00:00:00Z'));

    expect(window.claimable).toBe(false);
    expect(window.listingNotNewestFirst).toBe(true);
  });

  it('the violation is caught even when the out-of-order entry is the oldest so far', () => {
    const window = emptyListingWindow();
    observeListingEntry(window, day('2026-11-02T00:00:00Z'));
    observeListingEntry(window, day('2026-10-28T00:00:00Z'));
    observeListingEntry(window, day('2026-10-29T00:00:00Z'));

    expect(window.listingNotNewestFirst).toBe(true);
    expect(window.claimable).toBe(false);
  });

  it('an undated entry voids the claim without blaming the order', () => {
    // An entry the adapter could not parse a date from reaches the window as null: the run
    // can no longer place an unobserved posting outside its window, but nothing about the
    // listing's order is known to be wrong.
    const window = emptyListingWindow();
    observeListingEntry(window, day('2026-11-02T00:00:00Z'));
    observeListingEntry(window, null);

    expect(window.claimable).toBe(false);
    expect(window.listingNotNewestFirst).toBe(false);
  });

  it('an empty window makes no floor', () => {
    const window = emptyListingWindow();

    expect(window.claimable).toBe(true);
    expect(window.listingNotNewestFirst).toBe(false);
    expect(window.oldestPublishedAt).toBeNull();
  });
});
