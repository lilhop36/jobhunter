import type { FastifyReply } from 'fastify';

/**
 * HTML for the server-rendered pages (ADR-0007): escaping by default, no client JavaScript, no
 * assets.
 *
 * Job titles, descriptions and evidence are untrusted input, so an interpolation is **escaped
 * unless it is already a built fragment**. `raw()` is the only way to emit markup without escaping,
 * and the pages use it for documents they built themselves, never for stored data.
 *
 * A missing value renders as nothing rather than as the text "undefined" or "null": a page must not
 * turn an UNKNOWN field into a displayed fact.
 */
export interface Html {
  readonly text: string;
}

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character] as string);
}

export function raw(markup: string): Html {
  return { text: markup };
}

export function html(strings: TemplateStringsArray, ...values: readonly unknown[]): Html {
  let output = strings[0] ?? '';
  for (let index = 0; index < values.length; index += 1) {
    output += render(values[index]) + (strings[index + 1] ?? '');
  }
  return { text: output };
}

function render(value: unknown): string {
  if (value === null || value === undefined || typeof value === 'boolean') return '';
  if (isHtml(value)) return value.text;
  if (Array.isArray(value)) return value.map(render).join('');
  return escapeHtml(String(value));
}

function isHtml(value: unknown): value is Html {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { text?: unknown }).text === 'string'
  );
}

/**
 * One small stylesheet, inline: no request of its own, no fonts to download, no images.
 *
 * Colour is never the only signal (SRS 3.1): statuses and unknown values are words first. The
 * palette follows the operating system's light/dark preference and keeps body text at a contrast
 * ratio that survives both.
 */
const STYLES = `
:root{color-scheme:light dark;--fg:#1a1a1a;--bg:#ffffff;--muted:#555555;--line:#c8c8c8;--accent:#0b4fd0}
@media (prefers-color-scheme:dark){:root{--fg:#e9e9e9;--bg:#101010;--muted:#a9a9a9;--line:#3b3b3b;--accent:#8ab4f8}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:1rem/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
header,main{max-width:60rem;margin:0 auto;padding:0 1rem}
header{border-bottom:1px solid var(--line);padding-top:.5rem}
nav ul{display:flex;flex-wrap:wrap;gap:.25rem;list-style:none;margin:0;padding:0}
nav a{display:inline-block;padding:.65rem .6rem;color:var(--accent);text-decoration:underline}
nav a[aria-current=page]{color:var(--fg);font-weight:700;text-decoration:none}
main{padding-bottom:3rem}
h1{font-size:1.6rem;margin:1.25rem 0 .75rem}
h2{font-size:1.2rem;margin:1.75rem 0 .5rem}
a{color:var(--accent)}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.skip{position:absolute;left:-999px}
.skip:focus{position:static;display:inline-block;margin:.5rem 0}
table{border-collapse:collapse;width:100%;margin:.25rem 0 1rem}
th,td{text-align:left;padding:.45rem .5rem;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:.9rem}
.muted{color:var(--muted)}
.unknown{font-style:italic;color:var(--muted)}
.description{white-space:pre-wrap;overflow-wrap:anywhere}
dl{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem;margin:.5rem 0 1rem}
dt{font-weight:600}
dd{margin:0}
ul.plain{padding-left:1.1rem;margin:.25rem 0 1rem}
`;

const NAV = [
  { href: '/dashboard', label: 'Dashboard', key: 'dashboard' },
  { href: '/jobs', label: 'Jobs', key: 'jobs' },
  { href: '/matches', label: 'Matches', key: 'matches' },
] as const;

export type NavKey = (typeof NAV)[number]['key'];

export interface PageInput {
  title: string;
  heading: string;
  body: Html;
  current?: NavKey;
}

/**
 * The one document shell. `lang` is set because the page is English text (SRS 5.5: English is the
 * MVP UI language), and the skip link lets a keyboard user reach the content past the navigation.
 */
export function page({ title, heading, body, current }: PageInput): Html {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · JobHunter</title>
<style>${raw(STYLES)}</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header>
<nav aria-label="Main">
<ul>
${NAV.map(
  (item) =>
    html`<li><a href="${item.href}"${raw(
      current === item.key ? ' aria-current="page"' : '',
    )}>${item.label}</a></li>`,
)}
</ul>
</nav>
</header>
<main id="main">
<h1>${heading}</h1>
${body}
</main>
</body>
</html>`;
}

/**
 * A page response. The CSP is the second line of defence behind escaping: even a template bug that
 * emitted a script tag could not execute it, and `form-action 'none'` states that these pages carry
 * no forms (ADR-0007 §5 decides what one would need).
 */
export function sendPage(reply: FastifyReply, status: number, document: Html): FastifyReply {
  return reply
    .code(status)
    .type('text/html; charset=utf-8')
    .header(
      'content-security-policy',
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    )
    .header('x-content-type-options', 'nosniff')
    .header('referrer-policy', 'no-referrer')
    .send(document.text);
}

/** An error page for a browser: a status, a sentence, and a way back. */
export function errorPage(status: number, message: string): Html {
  return page({ title: String(status), heading: String(status), body: html`<p>${message}</p>
<p><a href="/dashboard">Back to the dashboard</a></p>` });
}
