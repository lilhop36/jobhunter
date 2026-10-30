import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { MATCHER_VERSION } from '@domain/matching';
import { NOTIFICATION_ELIGIBILITY_VERSION, NOTIFICATION_THRESHOLDS_V1 } from '@domain/notification';
import type { MatchFactorScores } from '@domain/types';
import { LOGIN_CODE_TTL_MS, type NonceRegistry } from '@application/auth/credentials';
import { openSignInCode } from '@application/auth/sign-in';
import { CreateTelegramLinkToken } from '@application/telegram';
import {
  clearSetCookie,
  createSession,
  csrfSetCookie,
  deleteSession,
  parseCookies,
  sessionSetCookie,
  verifyCsrf,
  CSRF_COOKIE,
  SESSION_COOKIE,
} from '@application/web/session';
import type {
  CandidateProfileRepository,
  StoredCandidateProfile,
} from '@ports/candidate-profile-repository';
import type { JobCursor, JobDetail, JobReader, JobSummary } from '@ports/job-reader';
import type { JobMatchRecord, JobMatchRepository, MatchCursor } from '@ports/job-match-repository';
import type { JobSourceRepository, SourceDetail } from '@ports/job-source-repository';
import type { NotificationRecord, NotificationRepository } from '@ports/notification-repository';
import type { TelegramLinkTokenStore } from '@ports/telegram-linking';
import { encodeCursor } from '../cursor';
import { principalOf, sessionOf } from '../auth';
import { UUID_PATTERN } from '../schemas';
import { errorPage, html, page, sendPage, type Html, type NavKey } from '../web/html';
import { formValuesFromInput, parseProfileForm, profileForm, toFormValues } from '../web/profile-form';
import { decodeJobCursor } from './jobs';
import { decodeMatchCursor, unknownFactors } from './matches';
import { saveProfile, toProfile, type ProfileRoutesDeps } from './profile';

/**
 * The web pages (SRS 3.1; ADR-0007 read-only, ADR-0009 mutations, ADR-0011 sign-in): `/dashboard`,
 * `/jobs`, `/jobs/:id`, `/matches`, `/matches/:id`, `/profile`, `/settings`, `/settings/telegram`,
 * `/login`, `/logout`.
 *
 * The read pages never show a fact the JSON API would not publish, every stored value is escaped by
 * the template, and a URL only becomes a link when it is http(s) — job text is untrusted input.
 *
 * Every page below is behind the session guard in `apps/api/auth.ts`: a handler reads its candidate
 * from the principal the guard proved and never from a parameter, so a page cannot be aimed at
 * somebody else by editing its URL. The two mutating form posts add the double-submit CSRF token on
 * top of that (ADR-0009): `jh_session` is HttpOnly, `jh_csrf` is readable and echoed into each form,
 * and a POST is accepted only when the two agree.
 *
 * There is no password, and there is no candidate chooser either: a session starts when the operator
 * opens a one-time link that only a local command can mint (ADR-0011 §3). The candidate is never
 * hard-coded — the session names one, and a second candidate is a second sign-in.
 */
export interface WebRoutesDeps {
  profiles: CandidateProfileRepository;
  jobs: JobReader;
  matches: JobMatchRepository;
  notifications: NotificationRepository;
  sources: JobSourceRepository;
  /** The `PROFILE_CHANGED` entry point, shared with `PUT /api/profile` (ADR-0009). */
  rescore: ProfileRoutesDeps['rescore'];
  /** ADR-0008: minting a one-use linking token. */
  telegramTokens: TelegramLinkTokenStore;
  /** The bot's public username, from configuration; absent means linking is not configured. */
  botUsername?: string;
  /** The key a sign-in code must have been signed with to open a session (ADR-0011). */
  authSecret: string;
  /** Which codes have already been opened, so a second click of one link buys nothing. */
  loginCodes: NonceRegistry;
}

const PAGE_LIMIT = 25;
const DASHBOARD_MATCHES = 20;
const DASHBOARD_TOP = 5;

export async function registerWebRoutes(app: FastifyInstance, deps: WebRoutesDeps): Promise<void> {
  // The pages are read-only GETs except for two form POSTs, which are registered together at the
  // end in their own encapsulated scope so the form media type stays out of the JSON API.

  // SRS 3.1 requires `/dashboard`; `/` simply sends the browser there.
  app.get('/', async (_request, reply) => reply.redirect('/dashboard'));

  app.get('/dashboard', async (request, reply) => {
    const candidate = await resolveCandidateForPage(request, deps.profiles);
    const early = earlyResponse(reply, candidate, 'dashboard');
    if (early !== null) return early;

    const { profile } = candidate as { profile: StoredCandidateProfile };
    const [matches, notifications, sources] = await Promise.all([
      deps.matches.listMatches({
        matcherVersion: MATCHER_VERSION,
        userId: profile.userId,
        limit: DASHBOARD_MATCHES,
      }),
      deps.notifications.listNotifications({ userId: profile.userId, limit: DASHBOARD_TOP }),
      deps.sources.listSources({ includeDisabled: false, limit: DASHBOARD_TOP }),
    ]);

    const jobs = await deps.jobs.findJobsByIds(matches.matches.map((match) => match.jobId));
    const best = matches.matches.slice(0, DASHBOARD_TOP);
    const confident = matches.matches
      .filter((match) => match.confidence >= NOTIFICATION_THRESHOLDS_V1.minConfidence)
      .slice(0, DASHBOARD_TOP);

    const body = html`<p class="muted">
Profile revision ${profile.profileVersion}. Scores are on a 0–100 scale; confidence says how much
of the profile the evidence covers.
</p>

<h2>Best matches</h2>
${best.length === 0 ? html`<p class="muted">No jobs have been scored yet.</p>` : matchTable(best, jobs)}
<p><a href="/matches">All matches</a></p>

<h2>High-confidence matches</h2>
<p class="muted">
Confidence at or above ${NOTIFICATION_THRESHOLDS_V1.minConfidence} — the notification policy's own
attention threshold (eligibility version ${NOTIFICATION_ELIGIBILITY_VERSION}).
</p>
${confident.length === 0
  ? html`<p class="muted">None of the scored matches reaches that confidence yet.</p>`
  : matchTable(confident, jobs)}

<h2>Notification status</h2>
${notifications.notifications.length === 0
  ? html`<p class="muted">No notifications have been recorded.</p>`
  : notificationTable(notifications.notifications)}

<h2>Source health</h2>
${sources.sources.length === 0
  ? html`<p class="muted">No source is enabled.</p>`
  : sourceTable(sources.sources)}`;

    return sendPage(
      reply,
      200,
      page({ title: 'Dashboard', heading: 'Dashboard', body, current: 'dashboard' }),
    );
  });

  app.get('/matches', async (request, reply) => {
    const candidate = await resolveCandidateForPage(request, deps.profiles);
    const early = earlyResponse(reply, candidate, 'matches');
    if (early !== null) return early;

    const { cursor } = request.query as { cursor?: string };
    const { profile } = candidate as { profile: StoredCandidateProfile };
    let decoded: MatchCursor | undefined;
    try {
      decoded = cursor === undefined ? undefined : decodeMatchCursor(cursor);
    } catch {
      return sendPage(reply, 400, errorPage(400, 'That page link is not valid.'));
    }

    const result = await deps.matches.listMatches({
      matcherVersion: MATCHER_VERSION,
      userId: profile.userId,
      limit: PAGE_LIMIT,
      ...(decoded === undefined ? {} : { cursor: decoded }),
    });
    const jobs = await deps.jobs.findJobsByIds(result.matches.map((match) => match.jobId));

    const body = html`${result.matches.length === 0
      ? html`<p class="muted">No matches have been scored for this candidate.</p>`
      : matchTable(result.matches, jobs)}
${nextPageLink('/matches', result.nextCursor && encodeCursor(result.nextCursor))}`;

    return sendPage(
      reply,
      200,
      page({ title: 'Matches', heading: 'Matches', body, current: 'matches' }),
    );
  });

  app.get('/matches/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isUuid(id)) return sendPage(reply, 400, errorPage(400, 'That match id is not valid.'));

    const match = await deps.matches.findById(id);
    // Another candidate's match is answered exactly like no match at all. A different status would
    // be a fact about the id — that it exists, and belongs to somebody you are not (SRS 8.2).
    if (match === null || match.userId !== principalOf(request).userId) {
      return sendPage(reply, 404, errorPage(404, 'That match was not found.'));
    }
    // The SRS 3.1 match detail includes the job's own facts; the match row alone has none of them.
    const job = await deps.jobs.findJob(match.jobId);

    const body = html`<p><a href="/matches">Back to matches</a></p>
<dl>
<dt>Score</dt><dd>${formatPercent(match.score)} / 100</dd>
<dt>Confidence</dt><dd>${formatPercent(match.confidence)} / 100</dd>
<dt>Job</dt><dd>${job === null ? html`<span class="unknown">job not found</span>` : html`<a href="/jobs/${job.id}">${job.title ?? unknownMark()}</a>`}</dd>
<dt>Company</dt><dd>${job?.company ?? unknownMark()}</dd>
<dt>Source</dt><dd>${job?.sourceName ?? unknownMark()}</dd>
<dt>Location</dt><dd>${job === null ? unknownMark() : locationText(job)}</dd>
<dt>Salary</dt><dd>${job === null ? unknownMark() : salaryText(job)}</dd>
<dt>Description quality</dt><dd>${job?.descriptionQuality ?? unknownMark()}</dd>
<dt>Application</dt><dd>${job === null ? unknownMark() : applicationHtml(job)}</dd>
<dt>Scored against profile</dt><dd>${match.profileVersion}</dd>
<dt>Matcher version</dt><dd>${match.matcherVersion}</dd>
<dt>Scored at</dt><dd>${isoDate(match.scoredAt)}</dd>
</dl>

<h2>Factor breakdown</h2>
${factorTable(match.factors)}
<p class="muted">A factor shown as <span class="unknown">unknown</span> had no evidence. It is not
a low score, and it does not count against the job.</p>

<h2>Explanation</h2>
<p>${match.explanation}</p>

<h2>Skills</h2>
${listOrNone('Matched', match.matchedSkills)}
${listOrNone('Missing', match.missingSkills)}
${listOrNone('Uncertain', match.uncertainSkills)}

<h2>Evidence</h2>
${listOrNone('Matched evidence', match.matchedEvidence)}
${listOrNone('Missing evidence', match.missingEvidence)}
${listOrNone('Uncertain evidence', match.uncertainEvidence)}`;

    return sendPage(
      reply,
      200,
      page({ title: 'Match detail', heading: 'Match detail', body, current: 'matches' }),
    );
  });

  app.get('/jobs', async (request, reply) => {
    const { cursor } = request.query as { cursor?: string };
    let decoded: JobCursor | undefined;
    try {
      decoded = cursor === undefined ? undefined : decodeJobCursor(cursor);
    } catch {
      return sendPage(reply, 400, errorPage(400, 'That page link is not valid.'));
    }

    const result = await deps.jobs.listJobs({
      limit: PAGE_LIMIT,
      ...(decoded === undefined ? {} : { cursor: decoded }),
    });

    const body = html`${result.jobs.length === 0
      ? html`<p class="muted">No jobs have been collected yet.</p>`
      : jobTable(result.jobs)}
${nextPageLink('/jobs', result.nextCursor && encodeCursor({
  createdAt: result.nextCursor.createdAt.toISOString(),
  id: result.nextCursor.id,
}))}`;

    return sendPage(reply, 200, page({ title: 'Jobs', heading: 'Jobs', body, current: 'jobs' }));
  });

  app.get('/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isUuid(id)) return sendPage(reply, 400, errorPage(400, 'That job id is not valid.'));

    const job = await deps.jobs.findJob(id);
    if (job === null) return sendPage(reply, 404, errorPage(404, 'That job was not found.'));

    const body = html`<p><a href="/jobs">Back to jobs</a></p>
<dl>
<dt>Source</dt><dd>${job.sourceName}</dd>
<dt>Company</dt><dd>${job.company ?? unknownMark()}</dd>
<dt>Location</dt><dd>${locationText(job)}</dd>
<dt>Remote</dt><dd>${job.remoteStatus}</dd>
<dt>Employment</dt><dd>${job.employmentType}</dd>
<dt>Salary</dt><dd>${salaryText(job)}</dd>
<dt>Published</dt><dd>${publishedText(job)}</dd>
<dt>Deadline</dt><dd>${deadlineText(job)}</dd>
<dt>Description quality</dt><dd>${job.descriptionQuality}</dd>
<dt>Lifecycle</dt><dd>${job.lifecycleStatus}</dd>
<dt>Application</dt><dd>${applicationHtml(job)}</dd>
<dt>Canonical URL</dt><dd>${linkOrText(job.canonicalUrl)}</dd>
</dl>

<h2>Description</h2>
${job.description === null
  ? html`<p class="muted">No description was stored for this job.</p>`
  : html`<p class="description">${job.description}</p>`}

<h2>Provenance</h2>
<p class="muted">Where each value came from: source-provided, deterministic extraction, or AI
(SRS 5.4). Evidence is the text or rule the value was derived from.</p>
${provenanceHtml(job.provenance)}`;

    return sendPage(
      reply,
      200,
      page({
        title: job.title ?? 'Job',
        heading: job.title ?? 'Untitled job',
        body,
        current: 'jobs',
      }),
    );
  });

  // ---------------------------------------------------------------------------------------------
  // Sessions (ADR-0009, ADR-0011)
  // ---------------------------------------------------------------------------------------------

  /**
   * Opening a sign-in link is the only way a browser becomes somebody (SRS 8.1; ADR-0011 §3).
   *
   * This used to be `?userId=`: whoever reached the port could name any stored candidate and the
   * server handed out a session for them, which is the hole the audit called H2. The link carries a
   * signed claim instead, so the `userId` is one only `npm run login` can put there — and it is worth
   * one click, because the code is consumed here and expires a minute after it was minted.
   *
   * There is deliberately no list of candidates on this page. A chooser is a link anyone who can
   * reach the port can click, and clicking it *was* the login; with several candidates, signing in as
   * a particular one is `npm run login -- --email …`, which is the same local-command authority the
   * rest of the deployment already assumes.
   *
   * A refusal quotes nothing of what was presented: the string in this parameter is a credential, and
   * SRS 8.5 keeps credentials out of anything an operator might paste or screenshot.
   */
  app.get('/login', async (request, reply) => {
    const { code } = request.query as { code?: string };
    if (code === undefined) return sendPage(reply, 200, signInPage());

    const verdict = openSignInCode(deps.authSecret, deps.loginCodes, code);
    if (!verdict.ok) return sendPage(reply, 401, signInPage(verdict.message));

    const { sessionToken, csrfToken } = createSession(verdict.userId);
    return reply
      .header('set-cookie', [sessionSetCookie(sessionToken), csrfSetCookie(csrfToken)])
      .redirect('/dashboard');
  });

  /**
   * Logout clears both cookies. A GET is safe here: it destroys a session rather than performing an
   * action, so the worst a forged request does is end the operator's own session.
   */
  app.get('/logout', async (request, reply) => {
    deleteSession(parseCookies(request.headers.cookie)[SESSION_COOKIE]);
    return reply
      .header('set-cookie', [clearSetCookie(SESSION_COOKIE), clearSetCookie(CSRF_COOKIE)])
      .redirect('/login');
  });

  // ---------------------------------------------------------------------------------------------
  // /profile — the whole-profile editor (SRS 3.1, 3.4; ADR-0009)
  // ---------------------------------------------------------------------------------------------

  app.get('/profile', async (request, reply) => {
    const candidate = await resolveCandidateForPage(request, deps.profiles);
    const early = earlyResponse(reply, candidate, 'profile');
    if (early !== null) return early;
    const { profile } = candidate as { profile: StoredCandidateProfile };

    return sendPage(
      reply,
      200,
      page({
        title: 'Edit profile',
        heading: 'Edit profile',
        current: 'profile',
        body: profileForm(toFormValues(profile.profile), [], sessionOf(request).csrfToken),
      }),
    );
  });

  // ---------------------------------------------------------------------------------------------
  // /settings (SRS 3.1)
  // ---------------------------------------------------------------------------------------------

  app.get('/settings', async (request, reply) => {
    const candidate = await resolveCandidateForPage(request, deps.profiles);
    const early = earlyResponse(reply, candidate, 'settings');
    if (early !== null) return early;

    const body = html`<p>Settings for this deployment.</p>
<ul class="plain">
<li><a href="/settings/telegram">Telegram notifications</a></li>
</ul>`;
    return sendPage(
      reply,
      200,
      page({ title: 'Settings', heading: 'Settings', body, current: 'settings' }),
    );
  });

  app.get('/settings/telegram', async (request, reply) => {
    const candidate = await resolveCandidateForPage(request, deps.profiles);
    const early = earlyResponse(reply, candidate, 'settings');
    if (early !== null) return early;

    const csrfToken = sessionOf(request).csrfToken;
    const headings = { title: 'Telegram notifications', heading: 'Telegram notifications', current: 'settings' as NavKey };

    if (deps.botUsername === undefined) {
      return sendPage(
        reply,
        200,
        page({
          ...headings,
          body: html`<p>Telegram linking is not configured on this deployment
(<code>TELEGRAM_BOT_USERNAME</code> is unset).</p>`,
        }),
      );
    }

    const body = html`<p>Notifications are delivered by the
<a href="https://t.me/${deps.botUsername}">@${deps.botUsername}</a> bot.</p>
<form method="post" action="/settings/telegram">
<input type="hidden" name="_csrf" value="${csrfToken}">
<button type="submit">Link my Telegram account</button>
</form>
<p class="hint">You will be sent to Telegram to press Start. The link is one-use and expires in
10 minutes (ADR-0008).</p>`;
    return sendPage(reply, 200, page({ ...headings, body }));
  });

  // ---------------------------------------------------------------------------------------------
  // The form posts (ADR-0009)
  // ---------------------------------------------------------------------------------------------

  /**
   * The two mutating pages share one encapsulated scope (Fastify's `register`), for two reasons:
   *
   *  - the `application/x-www-form-urlencoded` parser belongs only to them. Registering it at the
   *    root would let the media type leak into the JSON API, where an unsupported content type must
   *    stay a 415 (a caller mistake) rather than being accepted and silently ignored;
   *  - both are guarded the same way, and by two different mechanisms doing different jobs: the
   *    session guard in `apps/api/auth.ts` decides *who* is posting before this handler runs, and
   *    the CSRF check below decides whether that someone is their own browser. A save therefore
   *    needs a session the guard proved and the token that session was issued, and the two must
   *    agree. Without the session the token cannot be forged from another origin, and without the
   *    token a cross-site form cannot ride the session cookie.
   *
   * A malformed submission is rejected and shown again filled in; a profile save then takes the
   * same path as `PUT /api/profile` (same repository, same re-score request), so the two write
   * paths cannot drift.
   */
  await app.register(async (form) => {
    // Repeated keys (a checkbox group shares one name) collect into an array instead of
    // overwriting, so the parser alone never loses part of a submission.
    form.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_request, body, done) => {
        const fields: Record<string, string | string[]> = {};
        for (const [key, value] of new URLSearchParams(String(body))) {
          const existing = fields[key];
          if (existing === undefined) fields[key] = value;
          else if (Array.isArray(existing)) existing.push(value);
          else fields[key] = [existing, value];
        }
        done(null, fields);
      },
    );

    form.post('/profile', async (request, reply) => {
      const session = sessionOf(request);
      const input = (request.body ?? {}) as Record<string, unknown>;
      if (!verifyCsrf(session, input['_csrf'])) {
        return sendPage(
          reply,
          403,
          errorPage(403, 'Your form token is missing or wrong. Reload the profile page and try again.'),
        );
      }

      const values = formValuesFromInput(input, input['requireDisclosed'] !== undefined);
      const parsed = parseProfileForm(values);
      if (!parsed.ok) {
        return sendPage(
          reply,
          400,
          page({
            title: 'Edit profile',
            heading: 'Edit profile',
            current: 'profile',
            body: profileForm(parsed.values, parsed.errors, session.csrfToken),
          }),
        );
      }

      await saveProfile(
        { profiles: deps.profiles, rescore: deps.rescore },
        session.userId,
        toProfile(parsed.body),
        request.log,
      );
      return reply.redirect('/dashboard');
    });

    /**
     * Mints a token for **the session's** candidate, never for a user named in the form: a forged
     * body could otherwise aim someone else's notifications at the attacker's chat.
     */
    form.post('/settings/telegram', async (request, reply) => {
      const session = sessionOf(request);
      const input = (request.body ?? {}) as Record<string, unknown>;
      if (!verifyCsrf(session, input['_csrf'])) {
        return sendPage(
          reply,
          403,
          errorPage(403, 'Your form token is missing or wrong. Reload the page and try again.'),
        );
      }
      if (deps.botUsername === undefined) {
        return sendPage(
          reply,
          500,
          errorPage(500, 'Telegram linking is not configured on this deployment.'),
        );
      }

      const created = await new CreateTelegramLinkToken({ tokens: deps.telegramTokens }).run({
        userId: session.userId,
        now: new Date(),
      });
      return reply.redirect(
        `https://t.me/${deps.botUsername}?start=${encodeURIComponent(created.token)}`,
      );
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Candidate resolution & the sign-in page
// ---------------------------------------------------------------------------------------------

type CandidateResolution =
  | { kind: 'one'; profile: StoredCandidateProfile }
  | { kind: 'none' };

/**
 * The candidate a page shows: the one the session names, and no other.
 *
 * A page used to fall back through an explicit `?userId=`, then to the single stored profile, then
 * to a chooser — three ways for a URL to decide whose data a page displays. The guard has already
 * sent anyone without a session to `/login`, so what is left is one lookup. A session whose profile
 * has since been deleted is the honest empty state, not a reason to show somebody else's.
 */
async function resolveCandidateForPage(
  request: FastifyRequest,
  profiles: CandidateProfileRepository,
): Promise<CandidateResolution> {
  const profile = await profiles.findForUser(principalOf(request).userId);
  return profile === null ? { kind: 'none' } : { kind: 'one', profile };
}

/**
 * The sign-in page, and the one failure it can show.
 *
 * The page prints no candidate list and quotes no presented code: the first would be a chooser again,
 * the second a credential in a page an operator might screenshot (SRS 8.5).
 */
function signInPage(refusal?: string): Html {
  const seconds = Math.round(LOGIN_CODE_TTL_MS / 1000);
  return page({
    title: 'Sign in',
    heading: 'Sign in',
    body: html`${refusal === undefined
      ? html``
      : html`<div class="errors"><p>${refusal}</p></div>`}
<p>There is no password here. A sign-in link is minted on the machine this API runs on, and opening
it starts one session for the candidate its signature names:</p>
<p><code>npm run login</code></p>
<p class="muted">A link works once and expires after ${seconds} seconds. To sign in as a different
candidate, name them: <code>npm run login -- --email you@example.com</code>. To let a script read
the JSON API instead, mint it a credential with <code>npm run token</code>.</p>`
  });
}

/**
 * The one early answer a candidate-bearing page shares: a session that names no stored profile.
 * Returns `null` when the caller may render the page.
 */
function earlyResponse(
  reply: FastifyReply,
  resolution: CandidateResolution,
  current: NavKey,
): FastifyReply | null {
  if (resolution.kind !== 'none') return null;

  return sendPage(
    reply,
    200,
    page({
      title: 'No candidate profile',
      heading: 'No candidate profile yet',
      current,
      body: html`<p>
You are signed in, but no candidate profile is stored for you, so there is nothing to score against.
Seed one with <code>npm run seed:candidate</code>, or save it through <code>PUT /api/profile</code>
or the <a href="/profile">profile editor</a>.
</p>`,
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// Fragments
// ---------------------------------------------------------------------------------------------

function matchTable(
  matches: readonly JobMatchRecord[],
  jobs: ReadonlyMap<string, JobSummary>,
): Html {
  return html`<table>
<thead>
<tr>
<th scope="col">Score</th>
<th scope="col">Confidence</th>
<th scope="col">Job</th>
<th scope="col">Company</th>
<th scope="col">Source</th>
<th scope="col">Factors without evidence</th>
</tr>
</thead>
<tbody>
${matches.map((match) => {
  const job = jobs.get(match.jobId);
  const missing = unknownFactors(match.factors).map(factorLabel);
  return html`<tr>
<td>${formatPercent(match.score)}</td>
<td>${formatPercent(match.confidence)}</td>
<td><a href="/matches/${match.id}">${job?.title ?? html`<span class="unknown">title unknown</span>`}</a></td>
<td>${job?.company ?? unknownMark()}</td>
<td>${job?.sourceName ?? unknownMark()}</td>
<td>${missing.length === 0 ? 'none' : missing.join(', ')}</td>
</tr>`;
})}
</tbody>
</table>`;
}

function jobTable(jobs: readonly JobSummary[]): Html {
  return html`<table>
<thead>
<tr>
<th scope="col">Title</th>
<th scope="col">Company</th>
<th scope="col">Source</th>
<th scope="col">Location</th>
<th scope="col">Salary</th>
<th scope="col">Lifecycle</th>
</tr>
</thead>
<tbody>
${jobs.map(
  (job) => html`<tr>
<td><a href="/jobs/${job.id}">${job.title ?? html`<span class="unknown">title unknown</span>`}</a></td>
<td>${job.company ?? unknownMark()}</td>
<td>${job.sourceName}</td>
<td>${locationText(job)}</td>
<td>${salaryText(job)}</td>
<td>${job.lifecycleStatus}</td>
</tr>`,
)}
</tbody>
</table>`;
}

function notificationTable(notifications: readonly NotificationRecord[]): Html {
  return html`<table>
<thead>
<tr>
<th scope="col">Status</th>
<th scope="col">Type</th>
<th scope="col">Created</th>
<th scope="col">Attempts</th>
<th scope="col">Match</th>
</tr>
</thead>
<tbody>
${notifications.map(
  (notification) => html`<tr>
<td>${notification.status}</td>
<td>${notification.notificationType}</td>
<td>${isoDate(notification.createdAt)}</td>
<td>${notification.attemptCount}</td>
<td>${notification.jobMatchId === null
  ? unknownMark()
  : html`<a href="/matches/${notification.jobMatchId}">Open</a>`}</td>
</tr>`,
)}
</tbody>
</table>`;
}

function sourceTable(sources: readonly SourceDetail[]): Html {
  return html`<table>
<thead>
<tr>
<th scope="col">Source</th>
<th scope="col">Health</th>
<th scope="col">Last success</th>
<th scope="col">Latest run</th>
<th scope="col">Zero results</th>
</tr>
</thead>
<tbody>
${sources.map(
  (source) => html`<tr>
<td>${source.name}</td>
<td>${source.healthStatus}</td>
<td>${source.lastSuccessfulRunAt === null ? unknownMark() : isoDate(source.lastSuccessfulRunAt)}</td>
<td>${source.latestRun === null ? unknownMark() : source.latestRun.status}</td>
<td>${source.latestRun !== null && source.latestRun.unexpectedZeroResults ? 'yes' : 'no'}</td>
</tr>`,
)}
</tbody>
</table>`;
}

/** Fixed SRS 4.6 order, so the breakdown reads the same way as the weights it came from. */
const FACTOR_LABELS: ReadonlyArray<readonly [keyof MatchFactorScores, string]> = [
  ['role', 'Role'],
  ['skills', 'Skills'],
  ['experience', 'Experience'],
  ['location', 'Location'],
  ['employment', 'Employment'],
  ['freshness', 'Freshness'],
  ['salary', 'Salary'],
];

function factorTable(factors: MatchFactorScores): Html {
  return html`<table>
<thead>
<tr>
<th scope="col">Factor</th>
<th scope="col">Score</th>
</tr>
</thead>
<tbody>
${FACTOR_LABELS.map(([key, label]) => {
  const value = factors[key];
  return html`<tr>
<th scope="row">${label}</th>
<td>${value === null ? unknownMark() : `${formatPercent(value)} / 100`}</td>
</tr>`;
})}
</tbody>
</table>`;
}

const FACTOR_LABEL_BY_KEY: Readonly<Record<string, string>> = Object.fromEntries(
  FACTOR_LABELS.map(([key, label]) => [key, label]),
);

function factorLabel(key: string): string {
  return FACTOR_LABEL_BY_KEY[key] ?? key;
}

interface ProvenanceRow {
  field: string;
  source: string;
  method: string | null;
  evidence: string | null;
}

/**
 * The stored provenance map, read defensively.
 *
 * It is JSON written by the pipeline revision that produced these facts, so this page shows what
 * it can read and says so when it cannot: a map it does not understand is reported as unreadable
 * rather than as absent, because "no provenance was recorded" would be a different (and false)
 * claim.
 */
function provenanceRows(provenance: unknown): ProvenanceRow[] {
  if (typeof provenance !== 'object' || provenance === null || Array.isArray(provenance)) return [];
  const rows: ProvenanceRow[] = [];
  for (const [field, entry] of Object.entries(provenance as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.provenance !== 'string') continue;
    rows.push({
      field,
      source: record.provenance,
      method: typeof record.conversionMethod === 'string' ? record.conversionMethod : null,
      evidence: typeof record.evidence === 'string' ? record.evidence : null,
    });
  }
  return rows.sort((left, right) => left.field.localeCompare(right.field));
}

function provenanceHtml(provenance: unknown): Html {
  if (provenance === null || provenance === undefined) {
    return html`<p class="muted">No provenance was recorded for this job.</p>`;
  }

  const rows = provenanceRows(provenance);
  if (rows.length === 0) {
    return html`<p class="muted">This job's provenance is stored in a form this page cannot read.</p>`;
  }

  return html`<table>
<thead>
<tr>
<th scope="col">Field</th>
<th scope="col">Origin</th>
<th scope="col">Method</th>
<th scope="col">Evidence</th>
</tr>
</thead>
<tbody>
${rows.map(
  (row) => html`<tr>
<th scope="row">${row.field}</th>
<td>${row.source}</td>
<td>${row.method ?? unknownMark()}</td>
<td class="description">${row.evidence ?? unknownMark()}</td>
</tr>`,
)}
</tbody>
</table>`;
}

function listOrNone(label: string, values: readonly string[]): Html {
  return html`<h3>${label}</h3>
${values.length === 0
  ? html`<p class="muted">None.</p>`
  : html`<ul class="plain">${values.map((value) => html`<li>${value}</li>`)}</ul>`}`;
}

/**
 * The next page of a list. The cursor is the only parameter a page link carries: an identity in a
 * URL would be an invitation to edit it, and the session already names the candidate.
 */
function nextPageLink(base: string, cursor: string | null): Html {
  if (cursor === null) return html``;
  return html`<p><a href="${`${base}?${new URLSearchParams({ cursor }).toString()}`}">Next page</a></p>`;
}

/** Unknown is rendered as a word, not as an empty cell or a dash (SRS 3.1: never colour alone). */
function unknownMark(): Html {
  return html`<span class="unknown">unknown</span>`;
}

function formatPercent(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function isoDate(value: Date): string {
  return value.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

function locationText(job: JobSummary): Html {
  const category = job.locationCategory;
  return job.locationText === null
    ? html`${category}`
    : html`${job.locationText} (${category})`;
}

function salaryText(job: JobSummary): Html {
  if (job.salaryMin === null && job.salaryMax === null) {
    // NEGOTIABLE, AS_PER_SCALE, NOT_DISCLOSED and UNKNOWN all carry no number; the type is the fact.
    return html`${job.salaryType}`;
  }
  const currency = job.salaryCurrency === null ? '' : ` ${job.salaryCurrency}`;
  const period = job.salaryPeriod === 'UNKNOWN' ? '' : ` per ${job.salaryPeriod.toLowerCase()}`;
  if (job.salaryMin !== null && job.salaryMax !== null) {
    return job.salaryMin === job.salaryMax
      ? html`${job.salaryMin}${currency}${period}`
      : html`${job.salaryMin} – ${job.salaryMax}${currency}${period}`;
  }
  return job.salaryMin !== null
    ? html`from ${job.salaryMin}${currency}${period}`
    : html`up to ${job.salaryMax}${currency}${period}`;
}

function publishedText(job: JobDetail): Html {
  const parts: Html[] = [];
  if (job.originalPublishedDateText !== null) {
    parts.push(html`${job.originalPublishedDateText}`);
  }
  if (job.publishedAt !== null) {
    parts.push(html`${job.publishedAt.toISOString().slice(0, 10)} (${job.publishedCalendar})`);
  }
  return parts.length === 0 ? unknownMark() : html`${parts.map((part, index) => (index === 0 ? part : html` · ${part}`))}`;
}

/** A stated deadline, or the word unknown: an empty cell would read as "no deadline". */
function deadlineText(job: JobDetail): Html {
  return job.applicationDeadline === null
    ? unknownMark()
    : html`${job.applicationDeadline.toISOString().slice(0, 10)}`;
}

function applicationHtml(job: JobDetail): Html {  const { method, applyUrl, applyEmail } = job.application;
  const parts: Html[] = [];
  if (applyUrl !== null) parts.push(linkOrText(applyUrl));
  if (applyEmail !== null) parts.push(html`<code>${applyEmail}</code>`);
  if (parts.length === 0) {
    return method === 'UNKNOWN'
      ? html`<span class="unknown">no usable application path was found</span>`
      : html`${method}`;
  }
  return html`${method}: ${parts.map((part, index) => (index === 0 ? part : html` · ${part}`))}`;
}

/**
 * A stored URL is external, untrusted text. Only http(s) becomes a link: a `javascript:` or `data:`
 * href would be an injection that escaping alone cannot stop (the CSP blocks execution too, but a
 * page should not depend on the header for that).
 */
function linkOrText(url: string | null): Html {
  if (url === null) return unknownMark();
  const safe = /^https?:\/\//i.test(url) ? url : null;
  return safe === null
    ? html`<span class="muted">${url} (not a web link)</span>`
    : html`<a href="${safe}" rel="noopener noreferrer external">${safe}</a>`;
}

function isUuid(value: string): boolean {
  return new RegExp(UUID_PATTERN).test(value);
}
