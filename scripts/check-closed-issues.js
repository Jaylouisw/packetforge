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
//   unmatched  - nothing in the catalogue matches the subject. Not a finding: most closed
//                issues are duplicates of other requests, or devices nobody has built yet.
//
// Usage:
//   FORGEJO_TOKEN=... node scripts/check-closed-issues.js [--limit 200] [--max-age-days 45]
//                                                        [--json] [--strict]
//
// --strict exits non-zero when a "silent" finding appears, for wiring into CI as a gate later.

const path = require('path');
const { loadCatalog } = require(path.join(__dirname, '..', 'devices', 'registry'));
const sweeper = require(path.join(__dirname, 'sweep-device-requests.js'));

const requestSubject = sweeper.requestSubject;
const requestCandidates = sweeper.requestCandidates;
const norm = sweeper.norm;

// A closing comment counts as evidence when it names a spec file or says the device is in the
// catalogue in words. A bare "done" is not evidence - the next person cannot check it.
const EVIDENCE = /(devices\/[a-z0-9._-]+\/[a-z0-9._-]+\.json)|(already in the catalogue)|(is in the catalogue)|(modelled as)|(landed in #\d+)/i;

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
function auditClosedIssue(issue, index, comments) {
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

  const specs = loadCatalog(path.join(__dirname, '..', 'devices'));
  const index = buildIndex(specs);
  const cutoff = Date.now() - maxAgeDays * 24 * 3600 * 1000;

  const issues = [];
  for (let page = 1; issues.length < limit; page++) {
    const batch = await fetchJson(base + '/repos/' + repo + '/issues?state=closed&type=issues&limit=50&page=' + page, tok);
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
    const finding = auditClosedIssue(issue, index, comments);
    if (finding.verdict === 'answered') answered.push(finding);
    else if (finding.verdict === 'silent') silent.push(finding);
    else unmatched.push(finding);
  }

  if (asJson) {
    console.log(JSON.stringify({ answered: answered, silent: silent, unmatched: unmatched.length }, null, 2));
  } else {
    console.log('closed requests checked        : ' + recent.length + ' (last ' + maxAgeDays + ' days)');
    console.log('answered, with the file named  : ' + answered.length);
    console.log('possibly answered, no evidence : ' + silent.length);
    console.log('nothing in the catalogue       : ' + unmatched.length);
    if (silent.length) {
      console.log('');
      console.log('worth a look - the catalogue has a match, the close did not say where:');
      for (const f of silent) {
        console.log('  #' + String(f.number).padEnd(5) + ' ' + String(f.title).slice(0, 52).padEnd(53) + '-> ' + f.file);
      }
      console.log('  (reported only - this script never reopens or closes anything)');
    }
  }

  if (strict && silent.length) process.exit(1);
}

module.exports = { buildIndex, matchClosedIssue, auditClosedIssue, hasEvidence };

if (require.main === module) {
  main().catch(function (e) {
    console.error('closed-issue audit failed: ' + e.message);
    process.exit(2);
  });
}
