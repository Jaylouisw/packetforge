'use strict';

// Open hardware requests, for the app.
//
// The catalogue and the request backlog have been two silos: what is modelled lives in
// this server, and what has been *asked for* lives in the issue tracker where nobody
// using the app can see it. That is how sixty-plus people ended up filing requests for
// hardware that was already in the catalogue — nobody could check.
//
// This reads the open `[Device]:` issues and hands back just enough to answer one
// question: "has someone already asked for this, and is it in yet?"
//
// Two rules shape it:
//
//   * It never invents a request. If the forge is unreachable the answer is an empty
//     list marked unavailable — not a cached guess presented as current.
//   * It never blocks the app. The palette renders from the catalogue first; this is
//     enrichment that arrives late or not at all.

const DEFAULT_API = process.env.FORGE_API_URL || 'http://10.0.10.20:3000';
const DEFAULT_REPO = process.env.FORGE_REPO || 'jaylouisw/packetforge';
const PAGE_SIZE = 50;
const MAX_PAGES = 20;
const TTL_MS = 10 * 60 * 1000;

// "[Device]: MikroTik hEX Refresh Router (E50UG) — the S version is in" -> "MikroTik hEX
// Refresh Router (E50UG)". Same rule the sweeper uses: cut at the dash or colon that
// starts the explanation, but keep a bracketed model code, because that is the model.
function requestSubject(title) {
  let t = String(title == null ? '' : title).replace(/^\[[^\]]*\]\s*:?\s*/, '');
  const cut = t.search(/\s+[\u2014\u2013-]\s+|\s*:\s*/);
  if (cut > 0) t = t.slice(0, cut);
  return t.trim();
}

function isDeviceRequest(title) {
  return /^\[(device|hardware)\]/i.test(String(title == null ? '' : title));
}

function toRequest(issue, baseUrl, repo) {
  const title = String(issue.title || '');
  return {
    number: issue.number,
    subject: requestSubject(title),
    title: title,
    url: (baseUrl || '').replace(/\/+$/, '') + '/' + repo + '/issues/' + issue.number,
    createdAt: issue.created_at || null,
    comments: issue.comments || 0
  };
}

async function fetchOpenRequests(options) {
  const opts = options || {};
  const api = (opts.api || DEFAULT_API).replace(/\/+$/, '');
  const repo = opts.repo || DEFAULT_REPO;
  const fetchImpl = opts.fetch || (typeof fetch === 'function' ? fetch : null);
  if (!fetchImpl) throw new Error('no fetch available');

  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = api + '/api/v1/repos/' + repo + '/issues?state=open&type=issues&limit=' +
      PAGE_SIZE + '&page=' + page;
    const res = await fetchImpl(url, { headers: Object.assign({ Accept: 'application/json' }, opts.headers || {}) });
    if (!res || !res.ok) throw new Error('forge answered ' + (res ? res.status : 'nothing'));
    const batch = await res.json();
    if (!Array.isArray(batch) || !batch.length) break;
    for (const issue of batch) {
      if (issue.pull_request) continue;
      if (!isDeviceRequest(issue.title)) continue;
      out.push(toRequest(issue, opts.baseUrl || api, repo));
    }
    if (batch.length < PAGE_SIZE) break;
  }
  return out;
}

// A cache that never serves a stale answer as if it were current. `get()` returns the
// last good list with its age; when the forge fails and there is nothing cached the
// answer is `available: false` and an empty list, which the UI renders as silence
// rather than as "nobody has asked for anything".
function createRequestCache(options) {
  const opts = options || {};
  const ttlMs = opts.ttlMs == null ? TTL_MS : opts.ttlMs;
  const now = opts.now || Date.now;
  const fetcher = opts.fetcher || fetchOpenRequests;
  let requests = null;
  let fetchedAt = 0;
  let inflight = null;
  let lastError = null;

  async function refresh() {
    if (inflight) return inflight;
    inflight = (async function () {
      try {
        requests = await fetcher();
        fetchedAt = now();
        lastError = null;
      } catch (error) {
        lastError = String((error && error.message) || error);
      } finally {
        inflight = null;
      }
      return requests;
    })();
    return inflight;
  }

  return {
    async get() {
      const age = now() - fetchedAt;
      const fresh = requests !== null && age < ttlMs;
      if (!fresh) await refresh();
      const have = requests !== null;
      return {
        available: have,
        stale: have && (now() - fetchedAt) >= ttlMs,
        fetchedAt: have ? new Date(fetchedAt).toISOString() : null,
        error: have ? null : lastError,
        requests: have ? requests : []
      };
    },
    // Tests drive the cache without waiting on wall-clock time.
    _setForTest: function (list, at) { requests = list; fetchedAt = at == null ? now() : at; }
  };
}

module.exports = {
  requestSubject,
  isDeviceRequest,
  toRequest,
  fetchOpenRequests,
  createRequestCache,
  DEFAULT_API,
  DEFAULT_REPO,
  TTL_MS
};
