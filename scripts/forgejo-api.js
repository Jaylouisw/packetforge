'use strict';
/**
 * The project's tracker, spoken to properly.
 *
 * These scripts used to shell out to the GitHub CLI (`gh issue list ...`). On Forgejo that tool
 * does not exist - and worse, on a machine where it *is* installed and authenticated it succeeds
 * against the GitHub mirror, so triage silently reports a backlog that is not the one being worked
 * on. The failure mode is a plausible-looking answer, which is the worst kind.
 *
 * Node 18 has `fetch`, so this needs no dependency and no CLI.
 *
 *   FORGEJO_TOKEN   a token with read access to issues (required for anything but public repos on
 *                   an instance that allows anonymous reads)
 *   PF_REPO         "owner/name" override, default from scripts/canonical.js
 */

const canonical = require('./canonical');

const OWNER = process.env.PF_REPO ? process.env.PF_REPO.split('/')[0] : canonical.OWNER;
const NAME = process.env.PF_REPO ? process.env.PF_REPO.split('/')[1] : canonical.NAME;

// The API host. git.jayw.uk serves both the web UI and /api/v1, so one base is enough - but it is
// overridable because a runner inside the network may prefer the direct address.
const API = (process.env.PF_API || canonical.WEB) + '/api/v1';

function token() {
  return process.env.FORGEJO_TOKEN || process.env.PF_TOKEN || '';
}

/** Whether a request can be attempted at all, and why not when it cannot. */
function availability() {
  if (!token()) {
    return {
      available: false,
      reason: 'FORGEJO_TOKEN is not set - the tracker is not readable without it ' +
        '(this is not the same as "no open requests")'
    };
  }
  return { available: true, reason: null };
}

/**
 * One page of issues. `type=issues` excludes pull requests, which Forgejo shares the number space
 * with - without it every PR appears in the request queue as if someone had asked for hardware.
 */
async function listIssuesPage(opts) {
  const o = opts || {};
  const params = new URLSearchParams();
  params.set('state', o.state || 'open');
  params.set('type', 'issues');
  params.set('limit', String(o.limit || 50));
  params.set('page', String(o.page || 1));
  if (o.labels) params.set('labels', String(o.labels));

  const url = API + '/repos/' + OWNER + '/' + NAME + '/issues?' + params.toString();
  const res = await fetch(url, {
    headers: {
      Authorization: 'token ' + token(),
      Accept: 'application/json'
    }
  });

  if (res.status === 401 || res.status === 403) {
    const err = new Error('not authorised to read ' + OWNER + '/' + NAME +
      ' (HTTP ' + res.status + ') - check FORGEJO_TOKEN');
    err.code = 'E_AUTH';
    throw err;
  }
  if (!res.ok) {
    const err = new Error('tracker returned HTTP ' + res.status + ' for ' + url);
    err.code = 'E_HTTP';
    throw err;
  }

  const body = await res.json();
  if (!Array.isArray(body)) {
    const err = new Error('tracker returned something other than a list of issues');
    err.code = 'E_SHAPE';
    throw err;
  }

  return body.map(function (i) {
    return {
      number: i.number,
      title: i.title,
      url: i.html_url || (canonical.BASE + '/issues/' + i.number),
      body: i.body || '',
      labels: (i.labels || []).map(function (l) { return typeof l === 'string' ? l : l.name; }),
      state: i.state,
      author: (i.user && (i.user.login || i.user.username)) || null,
      createdAt: i.created_at || null,
      updatedAt: i.updated_at || null
    };
  });
}

/** Every open issue, following pagination. `limit` caps the total fetched. */
async function listOpenIssues(opts) {
  const o = opts || {};
  const max = o.max || 1000;
  const perPage = o.perPage || 50;
  const out = [];
  for (let page = 1; out.length < max; page++) {
    const batch = await listIssuesPage({
      page: page, limit: perPage, labels: o.labels, state: 'open'
    });
    out.push.apply(out, batch);
    if (batch.length < perPage) break;
    if (page > 200) break;             // a runaway guard, not a policy
  }
  return out.slice(0, max);
}

/**
 * The shape both triage scripts expect: `{available, reason, count, requests}`.
 *
 * A missing token is reported as unavailable *with a reason*, never as an empty queue - a script
 * that says "0 hardware requests" when it simply could not look is how a backlog grows unnoticed.
 */
async function scanRequests(opts) {
  const gate = availability();
  if (!gate.available) return { available: false, reason: gate.reason, count: 0, requests: [] };

  try {
    const all = await listOpenIssues(opts);
    const requests = (opts && opts.filter) ? all.filter(opts.filter) : all;
    return { available: true, reason: null, count: requests.length, requests: requests };
  } catch (e) {
    return {
      available: false,
      reason: String(e && e.message || e),
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
  availability: availability,
  listIssuesPage: listIssuesPage,
  listOpenIssues: listOpenIssues,
  scanRequests: scanRequests
};
