import type { FastifyInstance, FastifyReply } from 'fastify';
import { MATCHER_VERSION } from '@domain/matching';
import { NOTIFICATION_ELIGIBILITY_VERSION, NOTIFICATION_THRESHOLDS_V1 } from '@domain/notification';
import type { MatchFactorScores } from '@domain/types';
import type {
  CandidateProfileRepository,
  StoredCandidateProfile,
} from '@ports/candidate-profile-repository';
import type { JobCursor, JobDetail, JobReader, JobSummary } from '@ports/job-reader';
import type { JobMatchRecord, JobMatchRepository, MatchCursor } from '@ports/job-match-repository';
import type { JobSourceRepository, SourceDetail } from '@ports/job-source-repository';
import type { NotificationRecord, NotificationRepository } from '@ports/notification-repository';
import { encodeCursor } from '../cursor';
import { UUID_PATTERN } from '../schemas';
import { errorPage, html, page, sendPage, type Html, type NavKey } from '../web/html';
import { decodeJobCursor } from './jobs';
import { decodeMatchCursor, unknownFactors } from './matches';

/**
 * The read-only web pages (SRS 3.1, ADR-0007): `/dashboard`, `/jobs`, `/jobs/:id`, `/matches` and
 * `/matches/:id`, server-rendered, no client JavaScript, no assets.
 *
 * Every page reads through the same ports the JSON routes use, so a page cannot show a fact the
 * API would not publish, and every stored value is escaped by the template. Job text is untrusted
 * (SRS: external content is hostile input): escaping plus the CSP in `sendPage` is why an
 * interpolation is never trusted, and why a URL is only rendered as a link when it is http(s).
 *
 * The candidate is resolved from the stored profiles rather than assumed: v1 seeds one (FR-012),
 * but a page that hard-coded "the candidate" would have to be rewritten the day a second profile
 * exists. One profile is used directly; several produce a chooser.
 */
export interface WebRoutesDeps {
  profiles: CandidateProfileRepository;
  jobs: JobReader;
  matches: JobMatchRepository;
  notifications: NotificationRepository;
  sources: JobSourceRepository;
}

const PAGE_LIMIT = 25;
const DASHBOARD_MATCHES = 20;
const DASHBOARD_TOP = 5;

export async function registerWebRoutes(app: FastifyInstance, deps: WebRoutesDeps): Promise<void> {
  // SRS 3.1 requires `/dashboard`; `/` simply sends the browser there.
  app.get('/', async (_request, reply) => reply.redirect('/dashboard'));

  app.get('/dashboard', async (request, reply) => {
    const { userId } = request.query as { userId?: string };
    const candidate = await resolveCandidate(deps.profiles, userId);
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
<p><a href="/matches?userId=${profile.userId}">All matches</a></p>

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
    const { userId, cursor } = request.query as { userId?: string; cursor?: string };
    const candidate = await resolveCandidate(deps.profiles, userId);
    const early = earlyResponse(reply, candidate, 'matches');
    if (early !== null) return early;

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
${nextPageLink('/matches', { userId: profile.userId }, result.nextCursor && encodeCursor(result.nextCursor))}`;

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
    if (match === null) {
      return sendPage(reply, 404, errorPage(404, 'That match was not found.'));
    }
    // The SRS 3.1 match detail includes the job's own facts; the match row alone has none of them.
    const job = await deps.jobs.findJob(match.jobId);

    const body = html`<p><a href="/matches?userId=${match.userId}">Back to matches</a></p>
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
${nextPageLink('/jobs', {}, result.nextCursor && encodeCursor({
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
}

// ---------------------------------------------------------------------------------------------
// Candidate resolution
// ---------------------------------------------------------------------------------------------

type CandidateResolution =
  | { kind: 'one'; profile: StoredCandidateProfile }
  | { kind: 'none' }
  | { kind: 'choose'; profiles: StoredCandidateProfile[] }
  | { kind: 'missing'; userId: string };

async function resolveCandidate(
  profiles: CandidateProfileRepository,
  userId: string | undefined,
): Promise<CandidateResolution> {
  if (userId !== undefined) {
    if (!isUuid(userId)) return { kind: 'missing', userId };
    const profile = await profiles.findForUser(userId);
    return profile === null ? { kind: 'missing', userId } : { kind: 'one', profile };
  }

  const stored = await profiles.listProfiles();
  const [only] = stored;
  if (only === undefined) return { kind: 'none' };
  if (stored.length === 1) return { kind: 'one', profile: only };
  return { kind: 'choose', profiles: stored };
}

/**
 * The pages that need a candidate share three early answers: no profile yet, an unknown candidate,
 * and "which candidate?". Returns `null` when the caller may render the page.
 */
function earlyResponse(
  reply: FastifyReply,
  resolution: CandidateResolution,
  current: NavKey,
): FastifyReply | null {
  if (resolution.kind === 'missing') {
    return sendPage(reply, 404, errorPage(404, 'No profile exists for that candidate.'));
  }

  if (resolution.kind === 'none') {
    return sendPage(
      reply,
      200,
      page({
        title: 'No candidate profile',
        heading: 'No candidate profile yet',
        current,
        body: html`<p>
No candidate profile is stored, so there is nothing to score against. Seed one with
<code>npm run seed:candidate</code>, or save it through <code>PUT /api/profile</code>.
</p>`,
      }),
    );
  }

  if (resolution.kind === 'choose') {
    return sendPage(
      reply,
      200,
      page({
        title: 'Choose a candidate',
        heading: 'Choose a candidate',
        current,
        body: html`<p>More than one candidate profile is stored. Choose one:</p>
<ul>
${resolution.profiles.map(
  (profile) =>
    html`<li><a href="/dashboard?userId=${profile.userId}">Profile ${profile.profileVersion}</a></li>`,
)}
</ul>`,
      }),
    );
  }

  return null;
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

function nextPageLink(base: string, params: Record<string, string>, cursor: string | null): Html {
  if (cursor === null) return html``;
  const query = new URLSearchParams({ ...params, cursor });
  return html`<p><a href="${`${base}?${query.toString()}`}">Next page</a></p>`;
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

function applicationHtml(job: JobDetail): Html {
  const { method, applyUrl, applyEmail } = job.application;
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
