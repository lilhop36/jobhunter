import { describe, expect, it, vi } from 'vitest';
import {
  MAX_SOURCE_RESPONSE_BYTES,
  createSourceHttp,
  resolveAllowedLink,
  type SourceHttpOutcome,
} from '@infrastructure/adapters/source-http';

/**
 * The adapter HTTP policy (audit M5): a source's pages are untrusted input, so the scheme, the
 * host, every redirect hop and the response size are decided here, once, for all three adapters.
 * These tests are the reason a hostile listing cannot make the worker fetch an internal address or
 * stream an unbounded body into memory.
 */

const HOST = 'jobs.example.test';
const BASE = `https://${HOST}`;
const UA = 'JobHunter/test';

/** A fetch that answers from `routes` and records every URL it was actually asked for. */
function fakeFetch(routes: Record<string, Response | (() => Response)>) {
  const requested: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input);
    requested.push(url);
    const route = routes[url];
    if (route === undefined) return new Response('not found', { status: 404 });
    return typeof route === 'function' ? route() : route;
  }) as unknown as typeof fetch;
  return { fetchImpl, requested };
}

function httpFor(routes: Record<string, Response | (() => Response)>, maxBytes?: number) {
  const { fetchImpl, requested } = fakeFetch(routes);
  const http = createSourceHttp({ fetchImpl, allowedHost: HOST, userAgent: UA, maxBytes });
  return { http, requested };
}

function html(body: string, init?: ResponseInit): Response {
  return new Response(body, { ...init, headers: { 'content-type': 'text/html', ...init?.headers } });
}

describe('createSourceHttp request policy', () => {
  it('returns the body of a page on the source host', async () => {
    const { http, requested } = httpFor({ [`${BASE}/jobs/`]: html('<ol>cards</ol>') });

    const outcome: SourceHttpOutcome = await http.get(`${BASE}/jobs/`);

    expect(outcome).toEqual({ kind: 'ok', url: `${BASE}/jobs/`, body: '<ol>cards</ol>' });
    expect(requested).toEqual([`${BASE}/jobs/`]);
  });

  it('sends the polite user agent and the caller abort signal', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_input: string | URL, init?: RequestInit) => {
      seen.push({ headers: init?.headers, redirect: init?.redirect, signal: init?.signal });
      return html('page');
    }) as unknown as typeof fetch;
    const controller = new AbortController();
    const http = createSourceHttp({
      fetchImpl,
      allowedHost: HOST,
      userAgent: UA,
    });

    await http.get(`${BASE}/jobs/`, controller.signal);

    expect(seen[0].headers).toEqual({ 'User-Agent': UA });
    expect(seen[0].signal).toBe(controller.signal);
    // Manual, so every hop can be re-validated instead of the platform following a stranger.
    expect(seen[0].redirect).toBe('manual');
  });

  it('reports a non-2xx answer as the source responding, not as a missing page', async () => {
    const { http } = httpFor({ [`${BASE}/jobs/`]: html('blocked', { status: 403 }) });

    expect(await http.get(`${BASE}/jobs/`)).toMatchObject({ kind: 'http', status: 403 });
    expect(await http.getText(`${BASE}/jobs/`)).toBeNull();
  });

  it('never asks for a URL that is not on the source host over https', async () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      `http://${HOST}/jobs/`,
      'https://metadata.internal.example/jobs/',
      'https://evil.test/@' + BASE + '/jobs/',
      'not a url',
    ]) {
      const { http, requested } = httpFor({});
      expect(await http.get(url)).toMatchObject({ kind: 'offpolicy' });
      expect(requested).toEqual([]);
    }
  });
});

describe('createSourceHttp redirects', () => {
  it('follows a same-host redirect and reads the target', async () => {
    const { http, requested } = httpFor({
      [`${BASE}/jobs`]: () =>
        new Response(null, { status: 308, headers: { location: '/jobs/' } }),
      [`${BASE}/jobs/`]: html('the page'),
    });

    expect(await http.get(`${BASE}/jobs`)).toEqual({
      kind: 'ok',
      url: `${BASE}/jobs/`,
      body: 'the page',
    });
    expect(requested).toEqual([`${BASE}/jobs`, `${BASE}/jobs/`]);
  });

  it('refuses a redirect that leaves the source host, and does not request the stranger', async () => {
    for (const location of [
      'http://169.254.169.254/latest/meta-data/',
      'https://other.example.test/jobs/',
      'javascript:alert(1)',
    ]) {
      const { http, requested } = httpFor({
        [`${BASE}/jobs/`]: () =>
          new Response(null, { status: 301, headers: { location } }),
      });

      expect(await http.get(`${BASE}/jobs/`)).toMatchObject({ kind: 'offpolicy' });
      expect(requested).toEqual([`${BASE}/jobs/`]);
    }
  });

  it('stops after five hops instead of walking a redirect loop', async () => {
    const { http, requested } = httpFor({
      [`${BASE}/jobs/`]: () =>
        new Response(null, { status: 302, headers: { location: '/jobs/' } }),
    });

    expect(await http.get(`${BASE}/jobs/`)).toMatchObject({ kind: 'offpolicy' });
    // The first request plus five followed hops; the sixth response is where it gives up.
    expect(requested).toHaveLength(6);
  });

  it('treats a 3xx with no Location as the answer', async () => {
    const { http, requested } = httpFor({
      [`${BASE}/jobs/`]: () => new Response(null, { status: 304 }),
    });

    expect(await http.get(`${BASE}/jobs/`)).toMatchObject({ kind: 'http', status: 304 });
    expect(requested).toHaveLength(1);
  });
});

describe('createSourceHttp response size cap', () => {
  it('refuses a body the source declared larger than the cap, without reading it', async () => {
    const text = vi.fn(() => 'x'.repeat(MAX_SOURCE_RESPONSE_BYTES + 1));
    const routes = {
      [`${BASE}/jobs/`]: () => {
        const res = new Response('small', { status: 200 });
        // A real server states the length; the cap is checked before the body is consumed.
        res.headers.set('content-length', String(MAX_SOURCE_RESPONSE_BYTES + 1));
        Object.defineProperty(res, 'text', { value: text });
        return res;
      },
    };
    const { http } = httpFor(routes);

    expect(await http.get(`${BASE}/jobs/`)).toMatchObject({
      kind: 'oversized',
      bytes: MAX_SOURCE_RESPONSE_BYTES,
    });
    expect(text).not.toHaveBeenCalled();
  });

  it('stops reading a stream that exceeds the cap without declaring a length', async () => {
    const huge = 'x'.repeat(64 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 8; i++) controller.enqueue(new TextEncoder().encode(huge));
        controller.close();
      },
    });
    const { http } = httpFor({ [`${BASE}/jobs/`]: () => new Response(stream) }, 100 * 1024);

    expect(await http.get(`${BASE}/jobs/`)).toMatchObject({
      kind: 'oversized',
      bytes: 100 * 1024,
    });
  });

  it('keeps a body that fits, including multibyte text split across chunks', async () => {
    const bytes = new TextEncoder().encode('vaccancy ሥራ ᎠᎴ');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 7));
        controller.enqueue(bytes.slice(7));
        controller.close();
      },
    });
    const { http } = httpFor({ [`${BASE}/jobs/`]: () => new Response(stream) }, 4096);

    expect(await http.getText(`${BASE}/jobs/`)).toBe('vaccancy ሥራ ᎠᎴ');
  });
});

describe('resolveAllowedLink', () => {
  const page = `${BASE}/jobs/page/2/`;

  it('resolves a relative link against the page that carried it', () => {
    expect(resolveAllowedLink('/jobs/backend-engineer/', page, HOST)).toBe(
      `${BASE}/jobs/backend-engineer/`,
    );
    expect(resolveAllowedLink('backend-engineer/', page, HOST)).toBe(
      `${BASE}/jobs/page/2/backend-engineer/`,
    );
    // Junk inside a same-host `href` stays on the host, where it can only become a 404 that the
    // pass records as an unreadable posting. It is not a request somewhere else.
    expect(resolveAllowedLink('not a link at all', page, HOST)).toBe(
      `${BASE}/jobs/page/2/not%20a%20link%20at%20all`,
    );
  });

  it('drops the fragment, which is page content and not a different document', () => {
    expect(resolveAllowedLink(`${BASE}/jobs/x/#apply`, page, HOST)).toBe(`${BASE}/jobs/x/`);
  });

  it('refuses anything that is not an https page on the source host', () => {
    for (const link of [
      'https://evil.test/jobs/x/',
      `http://${HOST}/jobs/x/`,
      'javascript:alert(1)',
      'data:text/html,evil',
      'mailto:hr@example.test',
      '//other.example.test/jobs/x/',
      '',
      '   ',
    ]) {
      expect(resolveAllowedLink(link, page, HOST)).toBeNull();
    }
  });

  it('refuses to resolve against a page URL that is itself off-policy', () => {
    expect(resolveAllowedLink('/jobs/x/', 'https://evil.test/jobs/', HOST)).toBeNull();
    expect(resolveAllowedLink(`${BASE}/jobs/x/`, 'not a url', HOST)).toBeNull();
  });
});
