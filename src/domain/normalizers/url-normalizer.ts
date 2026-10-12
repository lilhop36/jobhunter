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

export function contentFingerprint(input: string | null | undefined): string {
  if (!input) return '';
  const s = input.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim().toLowerCase();
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}
