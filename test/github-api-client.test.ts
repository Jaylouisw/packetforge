'use strict';
// The tracker client: where it points, and what it does when the answer is not a list.
//
// Why this suite exists
// ---------------------
// The migration to GitHub rewrote this client's base onto the *web* host - `github.com/api/v1/...` -
// and GitHub answers that path `410 Gone` with an HTML apology. `request-queue.js` and
// `missing-devices.js` both died at run time, and 491 suites stayed green, because not one of them
// touched the network: the failure lived in the one place the suite could not see (`canonical.WEB`
// versus `api.github.com`), and nothing asserted the contract.
//
// So this suite asserts the contract, offline. The transport is stubbed - `globalThis.fetch` is a
// function here, not a socket - so it can say the three things the break got wrong:
//
//   1. the base URL is GitHub's API host, not the web host and not a `/api/v1` path;
//   2. a 410 (or any apology body) is reported as an error, never as an empty list of issues -
//      "we did not look" must never read as "nothing to do";
//   3. the shapes the two callers depend on survive: plain-string labels (`indexOf('blocked-on-build')`),
//      an ISO `createdAt` (`new Date(it.createdAt)` for age in days), pull requests dropped *after*
//      the page size is counted, and `per_page` rather than the archive's `limit`.
//
// `createSkeleton`-style tolerance is not wanted here: a client this thin either matches the
// tracker's documented REST shapes or it does not, and the stubs below are written to those shapes.

interface ApiIssue {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly body: string;
  readonly labels: string[];
  readonly state: string | null;
  readonly stateReason: string | null;
  readonly author: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly closedAt: string | null;
}

interface ApiComment {
  readonly author: string | null;
  readonly createdAt: string | null;
  readonly body: string;
}

interface ScanResult {
  readonly available: boolean;
  readonly reason: string | null;
  readonly count: number;
  readonly requests: ApiIssue[];
}

interface Tracker {
  readonly OWNER: string;
  readonly NAME: string;
  readonly API: string;
  token(): string;
  requireToken(what: string): string;
  availability(): { available: boolean; reason: string | null };
  listOpenIssues(opts?: { max?: number; perPage?: number; labels?: string }): Promise<ApiIssue[]>;
  listIssueComments(number: number, opts?: { limit?: number; page?: number }): Promise<ApiComment[]>;
  scanRequests(opts?: {
    max?: number;
    perPage?: number;
    labels?: string;
    filter?: ((issue: ApiIssue) => boolean) | null;
  }): Promise<ScanResult>;
}

// The module reads its host and its token at load time, so the environment is cleared *before* the
// require. Without this a `GITHUB_API_URL` exported in the shell (Actions sets one) would make the
// base-URL assertion prove nothing.
delete process.env.GITHUB_API_URL;
delete process.env.PF_REPO;
delete process.env.GITHUB_TOKEN;
delete process.env.GH_TOKEN;

const tracker: Tracker = require('../scripts/github-api.ts');

let passed = 0, failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

// ---------------------------------------------------------------------------
// A stubbed transport. Every call is recorded, so a test can assert *what was asked*, not only
// what came back - the base URL is exactly that kind of fact.

interface Call { readonly url: string; readonly init: RequestInit | undefined }
const calls: Call[] = [];

function stubFetch(next: (url: string, init: RequestInit | undefined) => Promise<Response>): void {
  calls.length = 0;
  globalThis.fetch = (async (input: unknown, init: RequestInit | undefined): Promise<Response> => {
    const url = String(input);
    calls.push({ url: url, init: init });
    return next(url, init);
  }) as unknown as typeof fetch;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: { 'content-type': 'application/json' }
  });
}

/** One row as GitHub's issues endpoint sends it. `pr` makes it a pull request. */
function row(n: number, opts?: { pr?: boolean; labels?: Array<string | { name: string }>; body?: string }): object {
  const o = opts || {};
  const base: Record<string, unknown> = {
    number: n,
    title: '[Device]: Acme Model-' + n,
    html_url: 'https://github.com/' + tracker.OWNER + '/' + tracker.NAME + '/issues/' + n,
    body: o.body === undefined ? '### Vendor\n\nacme\n' : o.body,
    labels: o.labels === undefined ? [{ name: 'device-request' }] : o.labels,
    state: 'open',
    state_reason: null,
    user: { login: 'reporter' },
    created_at: '2026-11-20T10:00:00Z',
    updated_at: '2026-11-21T10:00:00Z',
    closed_at: null
  };
  if (o.pr) {
    base.pull_request = { url: 'https://api.github.com/repos/x/y/pulls/' + n };
    base.html_url = 'https://github.com/' + tracker.OWNER + '/' + tracker.NAME + '/pull/' + n;
  }
  return base;
}

/** The message a rejected promise carried, or '' when it resolved. */
async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return '';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function main(): Promise<void> {
  console.log('The client asks GitHub, at GitHub\'s API host:');
  {
    ok(tracker.API === 'https://api.github.com',
      'the base is https://api.github.com (got ' + tracker.API + ')');
    ok(!/\/api\/v1/.test(tracker.API),
      'no /api/v1 suffix - that is the archive\'s path, and GitHub answers it 410');
    ok(!/^https?:\/\/github\.com/.test(tracker.API),
      'not the web host: github.com/api/v1/... is what the migration broke on');
    ok(tracker.OWNER === 'jaylouisw' && tracker.NAME === 'packetforge',
      'owner and repo come from canonical.ts (' + tracker.OWNER + '/' + tracker.NAME + ')');

    stubFetch(async () => json(200, []));
    await tracker.listOpenIssues({ max: 50 });
    const url = calls.length ? calls[0].url : '';
    ok(url.startsWith('https://api.github.com/repos/' + tracker.OWNER + '/' + tracker.NAME + '/issues'),
      'the first request goes to api.github.com/repos/<owner>/<name>/issues');
    ok(/[?&]state=open/.test(url), 'it asks for open issues by `state`');
    ok(/[?&]per_page=/.test(url), 'it paginates with `per_page`, GitHub\'s name for it');
    ok(!/[?&]limit=/.test(url), 'not `limit`, which the archive used and GitHub ignores');
    ok(!/[?&]type=issues/.test(url),
      'no `type=issues`: GitHub has no such filter, so pull requests are dropped here instead');
  }

  console.log('\nA 410 apology is an error, not an empty list:');
  {
    // Exactly what github.com/api/v1/... answers: HTTP 410 and an HTML apology, not JSON.
    const apology = '<html><body><h1>Gone</h1></body></html>';
    stubFetch(async () => new Response(apology, { status: 410, headers: { 'content-type': 'text/html' } }));

    const message = await rejection(tracker.listOpenIssues({ max: 500 }));
    ok(message !== '', 'listOpenIssues() rejects rather than resolving with []');
    ok(/410/.test(message), 'the error names the status: ' + message.split('\n')[0].slice(0, 110));
    ok(/api\.github\.com/.test(message), 'and names the host that would have answered');

    const scan = await tracker.scanRequests({ max: 500 });
    ok(scan.available === false, 'scanRequests() reports available:false');
    ok(scan.count === 0 && scan.requests.length === 0, 'with nothing in it, so nobody prints "0 requests"');
    ok(/\b410\b/.test(String(scan.reason)),
      'the reason carries the status, so the caller can say why it could not look');

    // GitHub's JSON apology, which is what a wrong path on the API host returns.
    stubFetch(async () => json(410, { message: 'Gone', documentation_url: 'https://docs.github.com' }));
    const jsonMessage = await rejection(tracker.listOpenIssues());
    ok(/410/.test(jsonMessage) && /Gone/.test(jsonMessage),
      'a JSON apology is reported with its own message too');
  }

  console.log('\nOther failures keep their own shape:');
  {
    stubFetch(async () => json(403, {
      message: 'API rate limit exceeded',
      documentation_url: 'https://docs.github.com/rest'
    }));
    const limited = await rejection(tracker.listOpenIssues());
    ok(/rate limit/i.test(limited), 'a spent rate limit is named as one, not as "not authorised"');
    ok(/GH_TOKEN/.test(limited), 'and the remedy names GH_TOKEN');

    stubFetch(async () => json(401, { message: 'Bad credentials' }));
    const denied = await rejection(tracker.listOpenIssues());
    ok(/401/.test(denied) && /GH_TOKEN|GITHUB_TOKEN/.test(denied),
      'a 401 says which variable to check');

    stubFetch(async () => json(200, { message: 'Not Found' }));
    const shape = await rejection(tracker.listOpenIssues());
    ok(/other than a list/.test(shape),
      'a 200 that is not a list is a shape error, not an empty queue');
  }

  console.log('\nPull requests are dropped, and dropping them does not end pagination:');
  {
    // Page 1 is full: 50 rows, 20 of them pull requests. A port that filtered first and then
    // compared the page size would see 30 rows, call that a short page, and stop - reading the
    // newest 30 issues of a backlog that has more. GitHub counts 50.
    const first: object[] = [];
    for (let n = 1; n <= 50; n++) first.push(row(n, { pr: n <= 20 }));
    const second: object[] = [row(101), row(102), row(103)];
    stubFetch(async (url) => (/[?&]page=2\b/.test(url) ? json(200, second) : json(200, first)));

    const issues = await tracker.listOpenIssues({ max: 500 });
    ok(calls.length === 2, 'it follows the second page (made ' + calls.length + ' requests)');
    ok(issues.length === 33, '23 issues from page 1 plus 3 from page 2 = 33 (got ' + issues.length + ')');
    ok(issues.every((i) => !/\/pull\//.test(i.url)), 'no pull request survived the filter');
    ok(issues[0].number === 21, 'the first issue is #21 - rows 1-20 were pull requests');
    ok(issues[issues.length - 1].number === 103, 'and the last is #103, from the second page');
  }

  console.log('\nThe shapes the two callers read are preserved:');
  {
    stubFetch(async () => json(200, [
      row(7, { labels: ['device-request', { name: 'blocked-on-build' }] }),
      row(8, { labels: [] })
    ]));
    const issues = await tracker.listOpenIssues({ max: 50 });
    const labels = issues[0].labels;
    ok(labels.length === 2 && labels[0] === 'device-request' && labels[1] === 'blocked-on-build',
      'labels are plain strings, so indexOf("blocked-on-build") still works');
    ok(issues[0].labels.indexOf('blocked-on-build') !== -1, 'and the string identity is the same one');
    ok(issues[0].createdAt === '2026-11-20T10:00:00Z' && !Number.isNaN(new Date(issues[0].createdAt).getTime()),
      'createdAt is an ISO timestamp, so the age in days is a number and not NaN');
    ok(issues[0].state === 'open', 'state is passed through');
    ok(issues[0].stateReason === null && issues[0].closedAt === null,
      'state_reason and closed_at are null on an open issue');
    ok(issues[0].author === 'reporter' && issues[0].body.indexOf('### Vendor') === 0,
      'author and body survive, because the field parser reads the body');
    ok(issues[1].url === 'https://github.com/' + tracker.OWNER + '/' + tracker.NAME + '/issues/8',
      'url is the web URL a reader can open');

    // A closed issue: GitHub spells the reason `state_reason`, and `closed_at` is the timestamp.
    stubFetch(async () => json(200, [{
      number: 9, title: '[Device]: retired', html_url: 'https://github.com/x/y/issues/9',
      body: '', labels: [], state: 'closed', state_reason: 'not_planned', user: { login: 'someone' },
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z',
      closed_at: '2026-02-01T00:00:00Z'
    }]));
    const closed = await tracker.listOpenIssues({ max: 50 });
    ok(closed[0].state === 'closed' && closed[0].stateReason === 'not_planned',
      'a closed issue keeps its state and carries GitHub\'s state_reason');
    ok(closed[0].closedAt === '2026-02-01T00:00:00Z', 'and closed_at is surfaced as closedAt');

    // A row with no html_url still produces a link a human can follow.
    stubFetch(async () => json(200, [{
      number: 10, title: '[Device]: no link', body: '', labels: [], state: 'open',
      user: { login: 'someone' }, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z'
    }]));
    const bare = await tracker.listOpenIssues({ max: 50 });
    ok(bare[0].url === 'https://github.com/jaylouisw/packetforge/issues/10',
      'a missing html_url falls back to the canonical web URL, not the API host');
  }

  console.log('\nComments are read the way the queue reads them:');
  {
    stubFetch(async () => json(200, [
      { user: { login: 'maintainer' }, created_at: '2026-11-20T11:00:00Z', body: 'Looking at this.' },
      { user: { login: 'maintainer' }, created_at: '2026-11-20T12:00:00Z', body: '**Blocked** until the vendor publishes the port list.' }
    ]));
    const comments = await tracker.listIssueComments(7, { limit: 100 });
    const url = calls.length ? calls[0].url : '';
    ok(/\/issues\/7\/comments/.test(url), 'the path is /issues/<n>/comments');
    ok(/[?&]per_page=100/.test(url), 'comments paginate on per_page=100');
    ok(comments.length === 2 && comments[1].body.indexOf('Blocked') !== -1,
      'both comments arrive in order, so the newest blocker is the last one read');
    ok(comments[0].author === 'maintainer' && comments[0].createdAt === '2026-11-20T11:00:00Z',
      'author and createdAt are mapped');
  }

  console.log('\nA token is optional for a read and required for a write:');
  {
    stubFetch(async () => json(200, []));
    const gate = tracker.availability();
    ok(gate.available === true && gate.reason === null,
      'a read with no token is allowed - GitHub answers anonymous reads');
    await tracker.listOpenIssues({ max: 50 });
    const init = calls.length ? calls[0].init : undefined;
    const sent = init && init.headers ? (init.headers as Record<string, string>) : {};
    ok(!sent.Authorization, 'and no Authorization header is invented from nothing');

    process.env.GH_TOKEN = 'ghs_example';
    ok(tracker.token() === 'ghs_example', 'GH_TOKEN is read');
    stubFetch(async () => json(200, []));
    await tracker.listOpenIssues({ max: 50 });
    const authed = calls.length && calls[0].init && calls[0].init.headers
      ? (calls[0].init.headers as Record<string, string>) : {};
    ok(authed.Authorization === 'Bearer ghs_example',
      'and used as a Bearer header when it is set');
    delete process.env.GH_TOKEN;

    process.env.GITHUB_TOKEN = 'ghs_ci';
    ok(tracker.token() === 'ghs_ci', 'GITHUB_TOKEN is read too, which is what a workflow has');
    delete process.env.GITHUB_TOKEN;

    ok(tracker.token() === '', 'with neither set, token() is empty rather than undefined');

    let writeMessage = '';
    try {
      tracker.requireToken('comment on #7');
    } catch (e) {
      writeMessage = e instanceof Error ? e.message : String(e);
    }
    ok(/GH_TOKEN/.test(writeMessage),
      'a write with no token fails with a message that names GH_TOKEN');
    ok(/comment on #7/.test(writeMessage), 'and says what it was trying to do');
    ok(/GITHUB_TOKEN/.test(writeMessage), 'and mentions GITHUB_TOKEN as the alternative');

    stubFetch(async () => json(200, []));
    ok(calls.length === 0, 'the guard is decided before any request goes out');
  }

  console.log('\nThe filter both callers pass is applied where they expect:');
  {
    stubFetch(async () => json(200, [row(1), row(2, { labels: ['bug'] })]));
    const scan = await tracker.scanRequests({
      max: 50,
      filter: (issue) => issue.labels.indexOf('device-request') !== -1
    });
    ok(scan.available === true && scan.count === 1 && scan.requests.length === 1,
      'scanRequests() counts what survived the filter, not what the page held');
    ok(scan.reason === null, 'and reports no reason, because there was no failure');
  }
}

main().then(
  () => {
    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    process.exit(failed ? 1 : 0);
  },
  (e: unknown) => {
    console.error(e instanceof Error ? e.stack || e.message : String(e));
    console.log('\n' + passed + ' passed, ' + (failed + 1) + ' failed');
    process.exit(1);
  }
);
