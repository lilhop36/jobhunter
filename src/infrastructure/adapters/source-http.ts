/**
 * The one HTTP path the source adapters use (audit M5).
 *
 * Job listings are untrusted input (AGENTS.md "Data Quality"): a page can carry a link to
 * anywhere, and a host can answer with a redirect to anywhere else. Left on the platform
 * defaults, that turns the collector into a request-maker for `http://169.254.169.254/` or any
 * other address the listing chooses, and a large enough body into a memory problem. So the
 * policy lives here, once: the source's own origin only, redirects re-validated hop by hop, and
 * a byte cap enforced while reading rather than after.
 *
 * Residual, deliberately not closed here: the allowlist is a *hostname* check, so a host that
 * resolves to an internal address still passes. The approved hosts are the sources' own domains,
 * recorded in `docs/sources`; closing the rest needs DNS-pinning (or an egress proxy), which is
 * infrastructure the single-worker deployment does not have. See the audit's M5 resolution note.
 */

/** Larger than any listing or posting page these sources serve (observed: tens of KB). */
export const MAX_SOURCE_RESPONSE_BYTES = 2 * 1024 * 1024;

/** WordPress and the job boards both redirect; five hops is the browser's usual ceiling. */
const MAX_REDIRECT_HOPS = 5;

/**
 * What a request ended as. `http` is the source answering — including a 4xx/5xx the pipeline
 * must not read as "this record was missing" (audit M5); `offpolicy` and `oversized` are the
 * policy refusing to follow a listing's instructions.
 */
export type SourceHttpOutcome =
  | { kind: 'ok'; url: string; body: string }
  | { kind: 'http'; url: string; status: number }
  | { kind: 'offpolicy'; url: string; detail: string }
  | { kind: 'oversized'; url: string; bytes: number };

export interface SourceHttpDeps {
  /** Injectable for tests; production uses the global fetch. */
  fetchImpl: typeof fetch;
  /** The source's own host, from its approval record (SRS Appendix E). Exact match, no suffix. */
  allowedHost: string;
  /** The polite, fixed user agent the record was reviewed under. */
  userAgent: string;
  /** Defaults to {@link MAX_SOURCE_RESPONSE_BYTES}; tests use a tiny cap. */
  maxBytes?: number | undefined;
}

export interface SourceHttp {
  /** One request, policy-checked, redirect-followed only while it stays on-policy. */
  get(url: string, signal?: AbortSignal): Promise<SourceHttpOutcome>;
  /** The body of a page, or null: the "this could not be read" signal the adapters know. */
  getText(url: string, signal?: AbortSignal): Promise<string | null>;
}

/**
 * Resolve a link a page carried against that page's own URL, and keep it only if it lands on the
 * allowed host over https. Returns null for anything else — an off-site link, a `javascript:` or
 * `data:` URI, an unparseable value. A link that leaves the source describes some other site, so
 * fetching it would be the source's content making the worker's requests (AGENTS.md: treat
 * external content as potentially hostile input).
 */
export function resolveAllowedLink(
  link: string,
  pageUrl: string,
  allowedHost: string,
): string | null {
  const base = parseHttpUrl(pageUrl);
  if (base === null) return null;
  const target = link.trim();
  // An empty `href` is the page itself, not a posting: pages carry them on decorative anchors.
  if (target === '') return null;
  let resolved: URL;
  try {
    resolved = new URL(target, base);
  } catch {
    return null;
  }
  if (resolved.protocol !== 'https:' || resolved.hostname !== allowedHost) return null;
  resolved.hash = '';
  return resolved.toString();
}

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

/** A URL the policy permits fetching: https, and exactly the source's own host. */
function parseAllowedUrl(value: string, allowedHost: string): URL | null {
  const url = parseHttpUrl(value);
  if (url === null || url.protocol !== 'https:' || url.hostname !== allowedHost) return null;
  return url;
}

/** Read a body without letting an unbounded stream become an unbounded string. */
async function readCapped(res: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    // Release the connection instead of leaving a body nobody will read.
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  const stream = res.body;
  if (stream === null) {
    const text = await res.text();
    return Buffer.byteLength(text) > maxBytes ? null : text;
  }
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  const parts: string[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      return null;
    }
    parts.push(decoder.decode(value, { stream: true }));
  }
  parts.push(decoder.decode());
  return parts.join('');
}

/**
 * A policy-bound fetch for one source. Transport errors and aborts are not swallowed: they
 * propagate exactly as they did when the adapter called `fetch` itself, so an acquisition that
 * cannot reach its source still ends the run rather than pretending the page was empty.
 */
export function createSourceHttp(deps: SourceHttpDeps): SourceHttp {
  const maxBytes = deps.maxBytes ?? MAX_SOURCE_RESPONSE_BYTES;

  async function get(url: string, signal?: AbortSignal): Promise<SourceHttpOutcome> {
    const start = parseAllowedUrl(url, deps.allowedHost);
    if (start === null) {
      return { kind: 'offpolicy', url, detail: 'the requested URL is not on the source host' };
    }
    let current: URL | null = start;
    for (let hop = 0; current !== null; hop += 1) {
      const res = await deps.fetchImpl(current.toString(), {
        signal,
        redirect: 'manual',
        headers: { 'User-Agent': deps.userAgent },
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        // A 3xx with no Location is the source answering; there is nothing to follow.
        if (location === null) return { kind: 'http', url: current.toString(), status: res.status };
        const next: string | null =
          hop < MAX_REDIRECT_HOPS
            ? resolveAllowedLink(location, current.toString(), deps.allowedHost)
            : null;
        // Release the empty redirect body the way following it used to.
        await res.body?.cancel().catch(() => undefined);
        if (next === null) {
          return {
            kind: 'offpolicy',
            url: current.toString(),
            detail:
              hop < MAX_REDIRECT_HOPS
                ? `redirect ${res.status} leaves the source host`
                : `more than ${MAX_REDIRECT_HOPS} redirects`,
          };
        }
        current = new URL(next);
        continue;
      }
      if (!res.ok) return { kind: 'http', url: current.toString(), status: res.status };
      const body = await readCapped(res, maxBytes);
      if (body === null) {
        return { kind: 'oversized', url: current.toString(), bytes: maxBytes };
      }
      return { kind: 'ok', url: current.toString(), body };
    }
    return { kind: 'offpolicy', url, detail: 'the redirect chain did not land on a page' };
  }

  return {
    get,
    async getText(url, signal) {
      const outcome = await get(url, signal);
      return outcome.kind === 'ok' ? outcome.body : null;
    },
  };
}
