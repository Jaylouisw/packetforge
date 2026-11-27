'use strict';
/**
 * The project's tracker, spoken to properly: GitHub's REST API.
 *
 * This module used to be `scripts/forgejo-api.js`, and it asked `github.com/api/v1/...` for two
 * days because its base was derived from `canonical.WEB` - the *web* host, with Forgejo's path
 * hung off it. GitHub answers that path `410 Gone` with an HTML apology, so `request-queue.js`
 * and `missing-devices.js` both died at run time while every suite passed: nothing in the tree
 * read the tracker, so nothing noticed. `test/github-api-client.test.js` is the check that would
 * have caught it, and it is offline - it asserts the base is `api.github.com` and that a 410 is
 * an error, not an empty list.
 *
 * No dependency, no CLI: Node has `fetch`. Shelling out to `gh` is what the first version of these
 * tools did, and on a machine with `gh` authenticated it answers about whichever repository `gh`
 * thinks you mean - a plausible answer about the wrong tracker, which is worse than a failure.
 *
 *   GITHUB_TOKEN / GH_TOKEN   a token. A *read* does not need one: GitHub answers anonymous reads
 *                             at 60 requests an hour, and this module uses that rather than
 *                             refusing to look. A write needs one, and says so by name.
 *   GITHUB_API_URL            GitHub's host, set for every Actions run. Defaults to api.github.com.
 *   PF_REPO                   "owner/name" override, default from scripts/canonical.ts
 *
 * `FORGEJO_TOKEN` is deliberately *not* accepted, for the reason `sweep-device-requests.js` gives:
 * it is a token for the read-only archive, GitHub answers it with 401, and a stale export from the
 * months the project lived there would read as "no access" rather than "wrong token".
 *
 * This is `.ts` because the repo asks for TypeScript in new code and this file needs no build step:
 * node strips the annotations at load time, and the `.js` callers require it as
 * `require('./github-api.ts')` - extension and all, because CommonJS resolves `.js`, `.json` and
 * `.node` and never a bare `.ts`. That is the same arrangement `scripts/canonical.ts` uses.
 */

/** The part of `scripts/canonical.ts` this module reads. Annotated because a CommonJS `require` of
 *  a `.ts` file arrives untyped, and an untyped value here would be `any` by another name. */
interface CanonicalModule {
  readonly OWNER: string;
  readonly NAME: string;
  readonly BASE: string;
}

const canonical: CanonicalModule = require('./canonical.ts');

/** Where development happens, not where the API answers: those are two different hosts and
 *  conflating them is the bug this module was rewritten to fix. */
const DEFAULT_API: string = 'https://api.github.com';

/** The API host, without a trailing slash so a path can be appended to it. */
const API: string = (process.env.GITHUB_API_URL || DEFAULT_API).replace(/\/+$/, '');

/** The token variables, in the order they are read. `GH_TOKEN` is the name the CLI uses and the
 *  one the error messages name; `GITHUB_TOKEN` is what a workflow provides. */
const TOKEN_ENV: readonly string[] = ['GITHUB_TOKEN', 'GH_TOKEN'];

/** GitHub caps `per_page` at 100 and quietly returns 100 for anything larger, which would make a
 *  caller that asked for 200 believe every page was short. Clamped here, once, and the caller's
 *  pagination compares against the same clamped number. */
const MAX_PER_PAGE: number = 100;

// ---------------------------------------------------------------------------
// The shapes. Only the fields this module reads are declared; everything else
// GitHub sends is ignored rather than guessed at.

interface RawLabel { name?: string | null }
interface RawUser { login?: string | null }

/** An issue as GitHub returns it. `pull_request` is present only on pull requests - see
 *  `isIssueRow`. */
interface RawIssue {
  number: number;
  title?: string | null;
  html_url?: string | null;
  body?: string | null;
  labels?: Array<string | RawLabel> | null;
  state?: string | null;
  state_reason?: string | null;
  user?: RawUser | null;
  created_at?: string | null;
  updated_at?: string | null;
  closed_at?: string | null;
  pull_request?: unknown;
}

interface RawComment {
  user?: RawUser | null;
  created_at?: string | null;
  body?: string | null;
}

/** One issue, in the shape both callers already read. */
export interface Issue {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly body: string;
  readonly labels: string[];
  readonly state: string | null;
  /** GitHub's word for *why* an issue was closed: `completed` or `not_planned`. */
  readonly stateReason: string | null;
  readonly author: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly closedAt: string | null;
}

/** One comment, oldest first, in the shape `blockerLine()` reads. */
export interface Comment {
  readonly author: string | null;
  readonly createdAt: string | null;
  readonly body: string;
}

export interface ListOptions {
  readonly max?: number;
  readonly perPage?: number;
  readonly labels?: string;
}

export interface CommentOptions {
  readonly limit?: number;
  readonly page?: number;
}

export interface ScanOptions extends ListOptions {
  readonly filter?: ((issue: Issue) => boolean) | null;
}

export interface ScanResult {
  readonly available: boolean;
  readonly reason: string | null;
  readonly count: number;
  readonly requests: Issue[];
}

export interface Availability {
  readonly available: boolean;
  readonly reason: string | null;
}

/** An `Error` carrying the `code` the old module's callers and readers already knew. */
interface CodedError extends Error { code: string }

function fail(code: string, message: string): CodedError {
  const err = new Error(message) as CodedError;
  err.code = code;
  return err;
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Who, and with what.

function repoParts(): { owner: string; name: string } {
  const override = String(process.env.PF_REPO || '').trim();
  const parts = override.split('/');
  if (parts.length === 2 && parts[0] && parts[1]) return { owner: parts[0], name: parts[1] };
  return { owner: canonical.OWNER, name: canonical.NAME };
}

const REPO: { owner: string; name: string } = repoParts();
const OWNER: string = REPO.owner;
const NAME: string = REPO.name;

/** The token, or the empty string. A read works without one; the callers say which they need. */
function token(): string {
  for (const name of TOKEN_ENV) {
    const value = process.env[name];
    if (value && value.trim()) return value.trim();
  }
  return '';
}

/**
 * The token, or an error that names the variable to set.
 *
 * Only writes need this. The message names `GH_TOKEN` because that is the variable a reader can
 * `export` (and the one `gh auth token` fills); it also mentions `GITHUB_TOKEN`, which a workflow
 * already has. A message that said "no token" would send the next person to the source to find out
 * which one.
 */
function requireToken(what: string): string {
  const tok = token();
  if (tok) return tok;
  throw fail('E_NO_TOKEN', 'GitHub needs a token to ' + what + ' on ' + OWNER + '/' + NAME +
    ', and neither GH_TOKEN nor GITHUB_TOKEN is set.\n' +
    '\n' +
    'Fix it one of these ways:\n' +
    '  export GH_TOKEN=$(gh auth token)   # or GITHUB_TOKEN=<a token with issues: write>\n' +
    '\n' +
    'A read needs no token - GitHub answers anonymous reads at 60 requests an hour - so\n' +
    'node scripts/request-queue.js works as it is.');
}

/**
 * Whether a read can be attempted at all, and why not when it cannot.
 *
 * Since the tracker is GitHub, the answer is yes: an anonymous read is allowed. The old module had
 * to refuse here without a token, which meant "we did not look" and "nothing to do" shared an exit
 * code - so this reports available and lets the real HTTP status be the answer. A 401 or a spent
 * rate limit still comes back from `scanRequests()` as unavailable *with the reason*, never as an
 * empty queue.
 */
function availability(): Availability {
  return { available: true, reason: null };
}

// ---------------------------------------------------------------------------
// The transport.

interface RequestOptions {
  readonly method?: string;
  readonly body?: string;
}

/** Whether GitHub refused this request because the window is spent rather than because the caller
 *  may not look. Both are 403, and reading them as the same thing is how "set a token" becomes the
 *  advice for a problem a token cannot fix. */
function rateLimited(res: Response): boolean {
  if (res.status !== 403 && res.status !== 429) return false;
  if (res.headers.get('x-ratelimit-remaining') === '0') return true;
  return res.headers.get('retry-after') !== null;
}

/** What the body said, if it said anything: GitHub's errors are `{message, documentation_url}`, and
 *  the 410 apology from a non-API path is HTML. */
function errorDetail(json: unknown, text: string): string {
  if (json && typeof json === 'object') {
    const message = (json as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return ': ' + message.trim();
  }
  const trimmed = String(text || '').replace(/\s+/g, ' ').trim();
  if (!trimmed) return '';
  return ': ' + (trimmed.length > 160 ? trimmed.slice(0, 157) + '...' : trimmed);
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    return null;   // an HTML apology is not JSON, and saying so here hides the real status
  }
}

function httpError(res: Response, url: string, json: unknown, text: string): CodedError {
  const status = res.status;
  const detail = errorDetail(json, text);

  if (rateLimited(res)) {
    const reset = res.headers.get('x-ratelimit-reset');
    const when = reset && /^\d+$/.test(reset)
      ? new Date(Number(reset) * 1000).toISOString()
      : 'when the window rolls over';
    return fail('E_RATE', 'GitHub rate limit exhausted on ' + OWNER + '/' + NAME + ' (HTTP ' + status +
      (token() ? '' : ' - an anonymous read is allowed 60 requests an hour') +
      '); the window resets at ' + when + '. Set GH_TOKEN (or GITHUB_TOKEN) for 5,000 an hour.');
  }
  if (status === 401 || status === 403) {
    return fail('E_AUTH', 'not authorised to read ' + OWNER + '/' + NAME + ' (HTTP ' + status + ')' +
      (token() ? ' - check GH_TOKEN/GITHUB_TOKEN' : ' - set GH_TOKEN (or GITHUB_TOKEN)') + detail);
  }
  if (status === 410) {
    // The exact failure this module was rewritten for: GitHub answers a Forgejo-shaped path with
    // 410 Gone and an HTML apology, and the old code handed that to `res.json()`, which reported a
    // JSON parse error several frames away from the truth.
    return fail('E_HTTP', 'GitHub answered HTTP 410 Gone for ' + url +
      ' - the tracker is ' + DEFAULT_API + '/repos/' + OWNER + '/' + NAME +
      ', and a /api/v1 path there answers nothing' + detail);
  }
  return fail('E_HTTP', 'tracker returned HTTP ' + status + ' for ' + url + detail);
}

/**
 * One request, one parsed body, one error shape.
 *
 * A GET may go out unauthenticated; anything else goes through `requireToken()` first, so a write
 * without a token fails here, by name, rather than as a 401 from far away.
 */
async function request(pathAndQuery: string, opts?: RequestOptions): Promise<unknown> {
  const o = opts || {};
  const method = String(o.method || 'GET').toUpperCase();
  const url = API + '/repos/' + OWNER + '/' + NAME + pathAndQuery;
  const tok = method === 'GET' || method === 'HEAD' ? token() : requireToken(method + ' ' + pathAndQuery);

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'packetforge-tracker'
  };
  if (tok) headers.Authorization = 'Bearer ' + tok;
  if (o.body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(url, { method: method, headers: headers, body: o.body });
  } catch (e) {
    throw fail('E_NETWORK', 'could not reach ' + url + ': ' + describe(e));
  }

  const text = await res.text();
  const json = parseJson(text);
  if (!res.ok) throw httpError(res, url, json, text);
  return json;
}

function asList(body: unknown, what: string): unknown[] {
  if (!Array.isArray(body)) {
    throw fail('E_SHAPE', 'tracker returned something other than ' + what +
      (body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string'
        ? ' (' + String((body as { message?: unknown }).message) + ')'
        : ''));
  }
  return body;
}

// ---------------------------------------------------------------------------
// Mapping GitHub's shape onto the one the callers read.

function labelNames(labels: Array<string | RawLabel> | null | undefined): string[] {
  if (!Array.isArray(labels)) return [];
  const out: string[] = [];
  for (const l of labels) {
    const name = typeof l === 'string' ? l : (l && l.name ? String(l.name) : '');
    if (name) out.push(name);
  }
  return out;
}

function login(user: RawUser | null | undefined): string | null {
  if (!user || !user.login) return null;
  return String(user.login);
}

function toIssue(raw: RawIssue): Issue {
  const number = Number(raw.number);
  return {
    number: number,
    title: raw.title == null ? '' : String(raw.title),
    // `html_url` is the web URL, which is where a reader should be sent. The fallback stays on the
    // canonical base rather than on the API host: an issue link a human cannot open is not a link.
    url: raw.html_url ? String(raw.html_url) : canonical.BASE + '/issues/' + number,
    body: raw.body == null ? '' : String(raw.body),
    labels: labelNames(raw.labels),
    state: raw.state == null ? null : String(raw.state),
    stateReason: raw.state_reason == null ? null : String(raw.state_reason),
    author: login(raw.user),
    createdAt: raw.created_at || null,
    updatedAt: raw.updated_at || null,
    closedAt: raw.closed_at || null
  };
}

function toComment(raw: RawComment): Comment {
  return {
    author: login(raw.user),
    createdAt: raw.created_at || null,
    body: raw.body == null ? '' : String(raw.body)
  };
}

/** GitHub returns pull requests from the issues endpoint. The archive excluded them with
 *  `type=issues`; here they are dropped, and they are dropped *after* the page size is known so
 *  that a page of 50 holding 20 pull requests does not read as a final page. */
function isIssueRow(raw: RawIssue): boolean {
  return raw.pull_request === undefined || raw.pull_request === null;
}

// ---------------------------------------------------------------------------
// Reading.

function clampPerPage(n?: number): number {
  const value = Number(n === undefined ? 50 : n);
  if (!Number.isFinite(value) || value < 1) return 50;
  return Math.min(Math.floor(value), MAX_PER_PAGE);
}

interface PageOptions {
  readonly page?: number;
  readonly perPage?: number;
  readonly labels?: string;
  readonly state?: string;
}

/** One page as GitHub sent it: the number of rows it returned, and the issues among them. */
interface Page {
  readonly raw: number;
  readonly issues: Issue[];
}

async function issuePage(opts: PageOptions): Promise<Page> {
  const params = new URLSearchParams();
  params.set('state', opts.state || 'open');
  params.set('per_page', String(clampPerPage(opts.perPage)));
  params.set('page', String(opts.page || 1));
  if (opts.labels) params.set('labels', String(opts.labels));

  const rows = asList(await request('/issues?' + params.toString()), 'a list of issues') as RawIssue[];
  return { raw: rows.length, issues: rows.filter(isIssueRow).map(toIssue) };
}

/**
 * Every open issue, following pagination. `max` caps the total returned.
 *
 * The loop continues while GitHub keeps filling pages, and stops on a *short* page measured in rows
 * returned, not in rows that survived the pull-request filter - otherwise a repository with many
 * open pull requests would be read only as far as the first page they appear on.
 */
async function listOpenIssues(opts?: ListOptions): Promise<Issue[]> {
  const o = opts || {};
  const max = o.max && o.max > 0 ? Math.floor(o.max) : 1000;
  const perPage = clampPerPage(o.perPage);
  const out: Issue[] = [];
  for (let page = 1; out.length < max; page++) {
    const batch = await issuePage({ page: page, perPage: perPage, labels: o.labels, state: 'open' });
    for (const issue of batch.issues) out.push(issue);
    if (batch.raw < perPage) break;
    if (page > 200) break;             // a runaway guard, not a policy
  }
  return out.slice(0, max);
}

/**
 * Every comment on one issue, oldest first.
 *
 * The request queue needs this for one reason: a request labelled `blocked-on-build` carries its
 * reason in prose, in the thread, and the tool quotes that sentence instead of inventing a summary.
 * Reading it costs a second request per *blocked* issue only - a healthy queue makes none.
 */
async function listIssueComments(number: number, opts?: CommentOptions): Promise<Comment[]> {
  const o = opts || {};
  const params = new URLSearchParams();
  params.set('per_page', String(clampPerPage(o.limit)));   // GitHub says per_page, the archive said limit
  params.set('page', String(o.page || 1));

  const rows = asList(await request('/issues/' +
    encodeURIComponent(String(Number(number))) + '/comments?' + params.toString()),
  'a list of comments') as RawComment[];
  return rows.map(toComment);
}

/**
 * The shape both triage scripts expect: `{available, reason, count, requests}`.
 *
 * A failure to look is reported as unavailable *with a reason*, never as an empty queue - a script
 * that says "0 hardware requests" when it simply could not look is how a backlog grows unnoticed.
 */
async function scanRequests(opts?: ScanOptions): Promise<ScanResult> {
  const gate = availability();
  if (!gate.available) return { available: false, reason: gate.reason, count: 0, requests: [] };

  try {
    const all = await listOpenIssues(opts);
    const requests = (opts && opts.filter) ? all.filter(opts.filter) : all;
    return { available: true, reason: null, count: requests.length, requests: requests };
  } catch (e) {
    return {
      available: false,
      reason: describe(e),
      count: 0,
      requests: []
    };
  }
}

module.exports = {
  OWNER: OWNER,
  NAME: NAME,
  API: API,
  token: token,
  requireToken: requireToken,
  availability: availability,
  listOpenIssues: listOpenIssues,
  listIssueComments: listIssueComments,
  scanRequests: scanRequests
};
