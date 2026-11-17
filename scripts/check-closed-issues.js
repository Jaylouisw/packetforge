#!/usr/bin/env node
'use strict';
// Did we close a request for a device the catalogue already had?
//
// This exists because it happened six times in one go: #54, #167, #360, #362, #374 and #387
// were closed as "impossible to model - no Ethernet port", and every one of those devices was
// already in `devices/` with its ports modelled. Nothing noticed, because the sweeper only
// ever looks at OPEN issues: the moment a request is closed, for any reason, it leaves every
// automated view. A wrong close is therefore permanent and invisible, which is the worst
// combination a mistake can have.
//
// So this walks the other side of the ledger: closed issues, matched against the catalogue.
// It does not close or reopen anything. It reports, per issue, one of:
//
//   answered   - the catalogue has the device and the closing comment names the file. Correct.
//   silent     - the catalogue has the device and no comment names it. The close may still be
//                right (a human knew), but nobody left the evidence, so it is worth a look.
//   blocked    - the issue is listed in `research/open-device-requests.json`, which is this
//                project's own record that the vendor publishes no value to model yet. A close
//                there contradicts our own ledger, so one of the two is wrong and the issue is
//                off every open-issue view, exactly the blindness this script exists to end.
//   unmatched  - nothing in the catalogue matches the subject. Not a finding: most closed
//                issues are duplicates of other requests, or devices nobody has built yet.
//
// `blocked` was added on 2026-11-17, when #742 and #743 closed themselves. Nothing was built:
// both had a comment from minutes earlier saying the issue stays open. Forgejo parses
// `<keyword> #N` anywhere in a pull request's body, negation included, so PR #1867's
// "Does **not** close #743" and PR #1873's "## What would close #742" were both executed as
// instructions to close. The catalogue could not see it - there is no device to match - but the
// open-request mirror named both, and it is the file that says which closes are impossible.
//
// Usage:
//   FORGEJO_TOKEN=... node scripts/check-closed-issues.js [--limit 200] [--max-age-days 45]
//                                                        [--json] [--strict]
//
// --strict exits non-zero when a "silent" or "blocked" finding appears, for wiring into CI as a
// gate later.

const fs = require('fs');
const path = require('path');
const sweeper = require(path.join(__dirname, 'sweep-device-requests.js'));

const requestSubject = sweeper.requestSubject;
const requestCandidates = sweeper.requestCandidates;
const norm = sweeper.norm;

// A closing comment counts as evidence when it names a spec file or says the device is in the
// catalogue in words. A bare "done" is not evidence - the next person cannot check it.
const EVIDENCE = /(devices\/[a-z0-9._-]+\/[a-z0-9._-]+\.json)|(already in the catalogue)|(is in the catalogue)|(modelled as)|(landed in #\d+)/i;

// The open-request mirror: one entry per device this project has looked for and cannot model
// yet. Anything closed while it is still in here was closed against our own record.
const OPEN_REQUESTS = path.join(__dirname, '..', 'research', 'open-device-requests.json');

// Pure. Accepts the parsed file (or null when it could not be read) and returns the set of issue
// numbers it declares blocked. A malformed entry is skipped rather than thrown on: the audit is
// the last thing that runs, and it must not be the thing that breaks.
function blockedRequestNumbers(mirror) {
  const out = new Set();
  const requests = mirror && Array.isArray(mirror.requests) ? mirror.requests : [];
  for (const r of requests) {
    const n = Number(r && r.issue);
    if (Number.isInteger(n) && n > 0) out.add(n);
  }
  return out;
}

function loadBlockedRequests() {
  try {
    return { numbers: blockedRequestNumbers(JSON.parse(fs.readFileSync(OPEN_REQUESTS, 'utf8'))), error: null };
  } catch (e) {
    // Reported, not swallowed: an empty set here silently turns the newest check off, and a
    // check that is quietly off is the failure mode this whole script was written against.
    return { numbers: new Set(), error: e.message };
  }
}

// `loadCatalog()` returns the spec objects and drops the path that produced them, and this audit's
// entire output is *which file* - so every silent finding in production printed `-> null`, which
// is a report that cannot be acted on. The walk is repeated here for the one field the loader does
// not keep; only what the matching needs is read, and a file that will not parse is skipped
// because an unreadable spec is not an answer to a request.
function loadCatalogueFiles(dir) {
  const root = path.join(__dirname, '..');
  const out = [];
  (function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d); } catch (e) { return; }
    for (const entry of entries) {
      const full = path.join(d, entry);
      let st;
      try { st = fs.statSync(full); } catch (e) { continue; }
      if (st.isDirectory()) { walk(full); continue; }
      if (!entry.endsWith('.json')) continue;
      let spec;
      try { spec = JSON.parse(fs.readFileSync(full, 'utf8')); } catch (e) { continue; }
      if (!spec || typeof spec !== 'object' || Array.isArray(spec) || !spec.model) continue;
      out.push({ vendor: spec.vendor, model: spec.model, file: path.relative(root, full).split(path.sep).join('/') });
    }
  })(dir);
  return out;
}

function buildIndex(specs) {
  const byModel = new Map();
  const byVendorModel = new Map();
  for (const s of specs) {
    if (!s || !s.model || s.error) continue;
    const m = norm(s.model);
    if (m && !byModel.has(m)) byModel.set(m, s);
    const vm = norm((s.vendor || '') + ' ' + s.model);
    if (vm && !byVendorModel.has(vm)) byVendorModel.set(vm, s);
  }
  return { byModel, byVendorModel, size: byModel.size };
}

// The catalogue entry this closed request was asking for, if any. Exact matches only: this
// audit must never claim an issue was answered by a device it did not name, or it becomes the
// same kind of wrong that it is looking for.
function matchClosedIssue(issue, index) {
  const title = String((issue && issue.title) || '');
  const raw = requestSubject(title);
  if (!raw) return null;
  for (const candidate of requestCandidates(raw)) {
    const key = norm(candidate);
    if (!key) continue;
    const hit = index.byModel.get(key) || index.byVendorModel.get(key);
    if (hit) return hit;
  }
  return null;
}

function hasEvidence(comments) {
  for (const c of comments || []) {
    if (EVIDENCE.test(String((c && c.body) || ''))) return true;
  }
  return false;
}

// Pure: one closed issue in, one finding out. `comments` is the list of comment objects, or
// null when the caller did not fetch them (in which case evidence is treated as unknown).
function auditClosedIssue(issue, index, comments, blocked) {
  const number = issue && issue.number;
  // Checked before the catalogue: an issue can be in the mirror *and* matched by a spec, and that
  // is two contradictions, not an answer. `answered` would bury it.
  if (blocked && blocked.has && blocked.has(Number(number))) {
    const hit = matchClosedIssue(issue, index);
    return {
      verdict: 'blocked',
      number: number,
      title: String((issue && issue.title) || ''),
      model: hit ? hit.model : null,
      vendor: hit ? hit.vendor : null,
      file: hit ? (hit.file || hit.path || null) : null
    };
  }
  const hit = matchClosedIssue(issue, index);
  if (!hit) return { verdict: 'unmatched', number: issue && issue.number, title: String((issue && issue.title) || '') };
  const documented = comments == null ? null : hasEvidence(comments);
  return {
    verdict: documented === false ? 'silent' : 'answered',
    number: issue && issue.number,
    title: String((issue && issue.title) || ''),
    model: hit.model,
    vendor: hit.vendor,
    file: hit.file || hit.path || null,
    documented: documented
  };
}

// --- CLI -------------------------------------------------------------------------------------

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

function token() {
  for (const name of ['FORGEJO_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN']) {
    if (process.env[name]) return process.env[name];
  }
  return null;
}

// Candidate API bases, most likely first. The remote tells us the host but not the web port:
// this instance answers on http://odin:3000 while git is reached on ssh://odin:2222, so a base
// derived from the remote alone gets the host right and the port wrong. Each candidate is
// probed before use rather than assumed.
function apiCandidates() {
  const out = [];
  const url = process.env.FORGEJO_URL || process.env.GITHUB_API_URL || '';
  if (url) out.push(url.replace(/\/$/, '') + (url.indexOf('/api/') === -1 ? '/api/v1' : ''));
  // Same default as scripts/sweep-device-requests.js. The git remote here is an SSH alias
  // ("ssh://forgejo/...") that does not resolve to the web UI, so deriving the API host from it
  // is guesswork; the instance's address is the honest default and FORGEJO_URL overrides it.
  const fallback = process.env.FORGEJO_API || 'http://10.0.10.20:3000/api/v1';
  if (out.indexOf(fallback) === -1) out.push(fallback);
  if (!out.length) throw new Error('cannot derive an API base; set FORGEJO_URL');
  return out;
}

async function pickApiBase(tok) {
  const tried = [];
  for (const base of apiCandidates()) {
    try {
      const res = await fetch(base + '/version', { headers: { Authorization: 'token ' + tok } });
      if (res.ok) return base;
      tried.push(base + ' -> HTTP ' + res.status);
    } catch (e) {
      tried.push(base + ' -> ' + e.message);
    }
  }
  throw new Error('no API base answered: ' + tried.join('; '));
}

// Closed issues, most recently updated first. The instance's default order is by number
// descending, and that is how a bad close stays invisible: #742 was closed on 2026-11-17 and sat
// about 1,100 rows below the newest 120 - the window the CI job reads - so no practical `--limit`
// reached it. The close is the most recent *update* by definition, so `recentupdate` puts it at
// the top of page 1, which is the only place a check that runs a minute after a merge can look.
function closedIssuesUrl(base, repo, page) {
  return base + '/repos/' + repo + '/issues?state=closed&type=issues&limit=50&page=' + page +
    '&sort=recentupdate&direction=desc';
}

async function fetchJson(url, tok) {
  const res = await fetch(url, { headers: { Authorization: 'token ' + tok, Accept: 'application/json' } });
  if (!res.ok) throw new Error(url + ' -> HTTP ' + res.status);
  return res.json();
}

async function main() {
  const tok = token();
  if (!tok) {
    console.error('no token: set FORGEJO_TOKEN (or GITHUB_TOKEN / GH_TOKEN).');
    process.exit(2);
  }
  const repo = process.env.FORGEJO_REPO || 'jaylouisw/packetforge';
  const base = await pickApiBase(tok);
  const limit = Number(arg('limit', 150));
  const maxAgeDays = Number(arg('max-age-days', 60));
  const strict = process.argv.includes('--strict');
  const asJson = process.argv.includes('--json');

  const index = buildIndex(loadCatalogueFiles(path.join(__dirname, '..', 'devices')));
  const blockedRequests = loadBlockedRequests();
  if (blockedRequests.error) {
    // Printed before anything else, so a run that reports zero blocked closes cannot be mistaken
    // for a run that checked them.
    console.log('open-request mirror unreadable (' + blockedRequests.error + ') - closes of blocked requests are NOT being checked');
  }
  const cutoff = Date.now() - maxAgeDays * 24 * 3600 * 1000;

  const issues = [];
  for (let page = 1; issues.length < limit; page++) {
    const batch = await fetchJson(closedIssuesUrl(base, repo, page), tok);
    if (!batch.length) break;
    issues.push(...batch.filter(function (i) { return !i.pull_request; }));
    if (batch.length < 50) break;
  }

  // A bug report can name a device without being a request for it - "OLTs promise 10G SFP+
  // uplinks they do not model" matched an OLT and produced a finding that meant nothing. Device
  // requests have a shape on this tracker ("[Device]: ..."), so the audit uses it by default and
  // --all widens the net when somebody wants the noise.
  const allTitles = process.argv.includes('--all');
  const recent = issues
    .filter(function (i) { return !i.closed_at || Date.parse(i.closed_at) >= cutoff; })
    .filter(function (i) { return allTitles || /^\s*\[device\]/i.test(String(i.title || '')); })
    .slice(0, limit);

  const answered = [];
  const silent = [];
  const blocked = [];
  const unmatched = [];
  for (const issue of recent) {
    // Evidence lives in the comments, so they have to be fetched: a close with no comment at
    // all is exactly the case this audit is looking for.
    let comments = null;
    try {
      comments = await fetchJson(base + '/repos/' + repo + '/issues/' + issue.number + '/comments', tok);
    } catch (e) {
      comments = null;
    }
    const finding = auditClosedIssue(issue, index, comments, blockedRequests.numbers);
    if (finding.verdict === 'answered') answered.push(finding);
    else if (finding.verdict === 'silent') silent.push(finding);
    else if (finding.verdict === 'blocked') blocked.push(finding);
    else unmatched.push(finding);
  }

  if (asJson) {
    console.log(JSON.stringify({
      answered: answered,
      silent: silent,
      blocked: blocked,
      mirrorReadable: !blockedRequests.error,
      unmatched: unmatched.length
    }, null, 2));
  } else {
    console.log('closed requests checked        : ' + recent.length + ' (last ' + maxAgeDays + ' days)');
    console.log('answered, with the file named  : ' + answered.length);
    console.log('possibly answered, no evidence : ' + silent.length);
    console.log('closed while still blocked     : ' + blocked.length);
    console.log('nothing in the catalogue       : ' + unmatched.length);
    if (blocked.length) {
      console.log('');
      console.log('closed against our own record - research/open-device-requests.json still lists these:');
      for (const f of blocked) {
        const where = f.file ? 'present in the catalogue at ' + f.file : 'no spec exists';
        console.log('  #' + String(f.number).padEnd(5) + ' ' + String(f.title).slice(0, 44).padEnd(45) + '-> ' + where);
      }
      console.log('  (reported only - this script never reopens or closes anything; reopen by hand)');
    }
    if (silent.length) {
      console.log('');
      console.log('worth a look - the catalogue has a match, the close did not say where:');
      for (const f of silent) {
        console.log('  #' + String(f.number).padEnd(5) + ' ' + String(f.title).slice(0, 52).padEnd(53) + '-> ' + f.file);
      }
      console.log('  (reported only - this script never reopens or closes anything)');
    }
  }

  if (strict && (silent.length || blocked.length)) process.exit(1);
}

module.exports = { buildIndex, loadCatalogueFiles, matchClosedIssue, auditClosedIssue, blockedRequestNumbers, loadBlockedRequests, closedIssuesUrl, hasEvidence };

if (require.main === module) {
  main().catch(function (e) {
    console.error('closed-issue audit failed: ' + e.message);
    process.exit(2);
  });
}
