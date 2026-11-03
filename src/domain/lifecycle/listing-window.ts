/**
 * The FR-019 coverage-window claim, as it is built (audit M6, third half).
 *
 * A collection run may claim a window — "every posting published after this floor was among
 * the listing entries I read" — and the lifecycle policy uses that claim to retire jobs it did
 * not see. The claim is only true if the source served its listing newest-first: an
 * out-of-order page can put postings newer than the floor beyond the pages the run read, and
 * the sweep would then retire live jobs with their match and notification history.
 *
 * "Newest-first" is a property of the source's output on the day, not of this code, so it is
 * *checked* per run instead of assumed: each entry read must be no newer than the one before
 * it. One violation voids the claim for the whole run and says why, and the run falls back to
 * making no coverage claim at all — the safe direction, since no evidence is not negative
 * evidence (ENG-001).
 *
 * `ponytail:` the check is per-run and per-source, across the entries that run read. If a
 * source turns out to be permanently unordered, revisit a per-source declaration in its
 * approval record rather than voiding every one of its runs.
 */
export interface ListingWindow {
  /** Oldest publication date among the entries read so far — the proposed window floor. */
  oldestPublishedAt: Date | null;
  /** Publication date of the immediately preceding entry, for the newest-first check. */
  previousPublishedAt: Date | null;
  /** False once the run can no longer support a window claim. */
  claimable: boolean;
  /** True once an entry was read *newer* than the entry before it: the listing is not newest-first. */
  listingNotNewestFirst: boolean;
}

export function emptyListingWindow(): ListingWindow {
  return {
    oldestPublishedAt: null,
    previousPublishedAt: null,
    claimable: true,
    listingNotNewestFirst: false,
  };
}

/**
 * Fold one read entry into the claim.
 *
 * An entry with no usable publication date voids the claim the same way an out-of-order one
 * does — the run can no longer place an unobserved posting outside the window it saw — but it
 * is not an ordering violation, so it does not set `listingNotNewestFirst`.
 */
export function observeListingEntry(window: ListingWindow, publishedAt: Date | null): void {
  if (publishedAt === null) {
    window.claimable = false;
    return;
  }
  if (window.previousPublishedAt !== null && publishedAt.getTime() > window.previousPublishedAt.getTime()) {
    window.claimable = false;
    window.listingNotNewestFirst = true;
  }
  window.previousPublishedAt = publishedAt;
  if (window.oldestPublishedAt === null || publishedAt.getTime() < window.oldestPublishedAt.getTime()) {
    window.oldestPublishedAt = publishedAt;
  }
}
