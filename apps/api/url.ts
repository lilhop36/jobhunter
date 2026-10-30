/**
 * The two halves of a request URL this app cares about, split without a `URL` object.
 *
 * `request.url` in Fastify is the raw request target — `/api/matches?limit=5` — and both the
 * authorization guard and the request log need to read it as a path plus an optional query.
 * Parsing it through `URL` would invent a base that is not the deployment's own address, so the
 * split is done on the one character that defines it.
 */

/** `/api/matches?limit=5` → `/api/matches`; a URL with no query is returned unchanged. */
export function pathOf(url: string): string {
  const marker = url.indexOf('?');
  return marker === -1 ? url : url.slice(0, marker);
}

/** `/api/matches?limit=5` → `limit=5`; empty when there is no query. */
export function queryOf(url: string): string {
  const marker = url.indexOf('?');
  return marker === -1 ? '' : url.slice(marker + 1);
}

/**
 * A query key as the framework would have decoded it, or the raw text when the escape is invalid.
 *
 * A malformed percent-escape must not throw inside a guard: a 500 caused by the check itself would
 * be a refusal that leaks more than the parameter it is refusing.
 */
export function decodeQueryKey(raw: string): string {
  try {
    return decodeURIComponent(raw.trim());
  } catch {
    return raw;
  }
}
