/**
 * A scheme-like prefix. Used only to decide whether a value may be treated as an HTTP URL.
 */
const URL_SCHEME = /^([a-z][a-z0-9+.-]*):/i;

/**
 * `example.com:8080/jobs` parses as scheme `example.com`, but is really a host and port.
 * Digits after the colon are accepted so a schemeless host:port is not misread as a scheme.
 */
const PORT_AFTER_SCHEME = /^\d+(\/|$)/;

/**
 * Canonical form of a URL when used as a source-record identity basis (ADR-0001 concept 1).
 *
 * Delegates to `canonicalizeUrl` so the identity and the stored `Job.canonicalUrl` agree,
 * then applies the two rules identity needs on top of it:
 *
 *   - the fragment is dropped. `#apply` is client-side navigation, not a different
 *     resource, so keeping it would fork the identity of a single posting;
 *   - a URL that addresses no resource (a bare host, i.e. a site root) is rejected, because
 *     every posting reachable from that URL would otherwise collapse into one identity.
 *
 * Returns null when the value cannot be trusted to identify a posting, so the caller falls
 * through to the next basis instead of asserting an identity the URL does not support.
 *
 * Policy, not parsing:
 *   - **redirects** are never resolved. Remembering a redirect would require a network call,
 *     and identity resolution is a pure function (ENG-012). A source whose job URLs redirect
 *     must therefore be declared untrustworthy, or its URLs canonicalised by the adapter.
 *   - **listing and pagination URLs** are not detected here. Recognising them needs
 *     source-specific knowledge, and guessing would put source assumptions in shared domain
 *     code (ENG-016). `SourceAdapterConfig.canonicalUrlIdentityTrusted` is the declaration
 *     that a source's URLs are job-detail URLs; this function only enforces what is
 *     provable from the URL alone.
 *   - **a changed URL** on the same posting yields a different identity. That is why the URL
 *     basis is weaker than a stable source identifier, and why trust must be declared.
 *
 * Preserved: scheme, host, port, path (case preserved, trailing slash removed) and
 * non-tracking query parameters. Removed: the fragment and the known tracking parameters
 * `canonicalizeUrl` already strips. The path is never rewritten.
 */
export function urlIdentityValue(url: string | null | undefined): string | null {
  if (url === null || url === undefined) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  const scheme = URL_SCHEME.exec(trimmed);
  if (scheme && !/^https?$/i.test(scheme[1]) && !PORT_AFTER_SCHEME.test(trimmed.slice(scheme[0].length))) {
    // Rewriting a non-HTTP scheme into HTTPS would invent a URL the source never published.
    return null;
  }

  const canonical = canonicalizeUrl(trimmed);
  if (canonical === null) return null;

  let parsed: URL;
  try {
    parsed = new URL(canonical);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.pathname === '' || parsed.pathname === '/') return null;
  parsed.hash = '';
  return parsed.toString();
}

export function canonicalizeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let trimmed = url.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('//')) {
    trimmed = 'https:' + trimmed;
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    trimmed = 'https://' + trimmed;
  }
  try {
    const u = new URL(trimmed);
    u.hostname = u.hostname.toLowerCase();
    const remove = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'fbclid']);
    for (const k of Array.from(u.searchParams.keys())) {
      if (remove.has(k)) u.searchParams.delete(k);
    }
    let path = u.pathname;
    if (path.endsWith('/') && path.length > 1) {
      path = path.slice(0, -1);
    }
    u.pathname = path;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * @deprecated Unsafe as a uniqueness key: this is a 32-bit non-cryptographic hash,
 * which collides with roughly 50% probability by about 77k distinct values. Use the
 * versioned SHA-256 fingerprints in `job-identity.ts` (ADR-0001) instead. Retained
 * only until the source adapter is migrated.
 */
export function contentFingerprint(input: string | null | undefined): string {
  if (!input) return '';
  const s = input.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim().toLowerCase();
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}
