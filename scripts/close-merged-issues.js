#!/usr/bin/env node
'use strict';
// Close the issues that a merge actually answered.
//
// Two kinds of issue stay open after the work lands, and each has a different reason:
//
//   1. The pull request did not say "Fixes #N". Forgejo honours closing keywords in a merged
//      pull request body - #1635 closed #1526 that way, so the mechanism works - but it only
//      fires when somebody remembers to write the keyword. Nothing catches the forgetful PR,
//      and the issue sits open above work that shipped months ago.
//
//   2. The issue is a `[Device]:` request and the device landed later, in an unrelated pull
//      request. No pull request body ever cited the request, so no keyword could ever match.
//      `scripts/sweep-device-requests.js` answers "is this already modelled?" but it is a
//      manual run with a `--close N` budget, so the answer is only acted on when somebody
//      runs it. The backlog of seven open requests is what "nobody ran it" looks like.
//
// So: on every push to main, read the commits that just landed, take the ones a closing
// keyword cites, and close those issues; then ask the catalogue about every open `[Device]:`
// request and close the ones the catalogue demonstrably has. `.forgejo/workflows/
// close-merged-issues.yml` runs this on merge; `closed-audit.yml` is the opposite guard (it
// catches a close the catalogue contradicts), and the two together mean a wrong close is
// visible and a forgotten close is not permanent.
//
// What it will not do, on purpose:
//
//   - reopen anything, ever;
//   - close an issue that a keyword did not cite and that is not present in `devices/`;
//   - treat a bare "#N" as a citation - "see #12" and "related to #12" name an issue without
//     claiming to fix it, and the whole point here is that only a fix claim closes;
//   - read a negated or hypothetical keyword as a claim. "Does **not** close #743" and
//     "What would close #742" are real pull request bodies in this repository, both merged,
//     both naming a number right after a keyword, and neither one closed anything. A keyword
//     has to open a line or a sentence here, which is the rule those three bodies forced;
//   - post the same comment twice for the same commit (the marker in each comment is how it
//     tells, which also means an issue a human reopened is left alone rather than re-closed);
//   - guess a device. The matcher is `scripts/sweep-device-requests.js`'s: its normaliser,
//     its candidate generator and its guards are imported here rather than reimplemented,
//     because a second matcher is a second opinion about whether somebody's hardware exists.
//
// Usage:
//   node scripts/close-merged-issues.js                        # dry run, last commit on HEAD
//   node scripts/close-merged-issues.js --limit 20             # dry run over 20 commits
//   node scripts/close-merged-issues.js --from <sha> --to <sha> # dry run over pushed range
//   node scripts/close-merged-issues.js --explain              # and say why each one stayed open
//   node scripts/close-merged-issues.js --apply                # actually comment and close
//   node scripts/close-merged-issues.js --device-only          # one sweep or the other
//   node scripts/close-merged-issues.js --keywords-only
//
// Credentials: FORGEJO_TOKEN (or GITHUB_TOKEN / GH_TOKEN). API base: FORGEJO_URL, PF_API,
// GITHUB_API_URL, or the instance address this repository's other scripts already default to.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// The matcher, not a copy of it. Everything that decides "is this the same product" lives in
// the sweeper: the dash/entity folding, the '+' handling, the candidate generator, the variant
// qualifier guard, the accessory guard, the part-number and model-code shapes. Importing them
// is the only way the two can be trusted to agree - a close is reported by `closed-audit.yml`
// if the catalogue disagrees with it, so they must not be allowed to drift.
const sweeper = require('./sweep-device-requests.js');
const norm = sweeper.norm;
const requestSubject = sweeper.requestSubject;
const requestCandidates = sweeper.requestCandidates;
const explicitCodes = sweeper.explicitCodes;
const variantOfSameCode = sweeper.variantOfSameCode;
const isAccessoryFor = sweeper.isAccessoryFor;
const looksLikePartNumber = sweeper.looksLikePartNumber;
const looksLikeModelCode = sweeper.looksLikeModelCode;

const OWNER = process.env.PF_REPO ? process.env.PF_REPO.split('/')[0] : 'jaylouisw';
const NAME = process.env.PF_REPO ? process.env.PF_REPO.split('/')[1] : 'packetforge';

// ---------------------------------------------------------------------------------------------
// Closing keywords.

// fix / fixes / fixed / close / closes / closed / resolve / resolves / resolved, as whole words.
// GitHub and Forgejo both accept "close" and "resolve" families; the singular forms are here for
// the same reason they are there - "Fix #12" is what a person writes in a hurry.
const KEYWORD = /\b(fix|fixes|fixed|close|closes|closed|resolve|resolves|resolved)\b/gi;

// The citation that has to follow a keyword: `#N`, or another keyword and `#N` - "Fixes #12,
// closes #13 and #14". Nothing else is allowed inside the run, so a sentence that merely contains
// a number ("fixes the #12 workflow") does not match and a bare "#12" with no keyword never does.
const REFERENCE = /^(?:#(\d+)|(?:fix|fixes|fixed|close|closes|closed|resolve|resolves|resolved)[ \t]+#(\d+))/i;

// What may sit between two references in one claim: a comma or conjunction, nothing else.
const SEPARATOR = /^[ \t]*(?:[,;&/]|\band\b|\balso\b|\bthen\b)?[ \t]*/i;

// Where a claim may start: the beginning of a line (allowing a markdown bullet, quote or list
// number in front) or the beginning of a sentence. This is the rule that keeps real pull requests
// in this repository from being misread, and it was not guessed:
//
//   PR #1867: "Does **not** close #743 - the IOM census is still unpublished"
//   PR #1873: "Refs #742 - this PR records measurements; it does **not** close the issue."
//   PR #1873: "## What would close #742"                (a heading asking what is missing)
//
// All three name a number next to a keyword and none of them claims the issue is fixed. #743 and
// #742 are still open, and this sweep agrees that they should be: a keyword that does not open a
// line or a sentence is not a closing claim. Do not read those two merges as the forge's rule -
// on 2026-11-18 it closed #803 from "Why it cannot close #803" and #130 from "This PR does not
// close #130", the same shape, and both had to be reopened. The rule below is this sweep's, not
// the forge's; `scripts/check-closing-keywords.js` reports the difference before a body is pushed.
// The claim that *did* work - PR #1635's body, which begins "Fixes #1526." - still parses.
// The claim may also open a sentence that opens with a conjunction - "Fixes #12. Also closes #13"
// is two claims, and dropping the second would leave an issue open for no better reason than
// where the author put a full stop.
//
// Deliberately not a multiline regex: with `m`, `$` also matches at every earlier line end, so
// testing "does this text end at a claim start" would be satisfied by any full stop earlier in the
// body - which is how the heading "## What would close #742" got through on the first attempt. The
// `$` here means the end of the text before the keyword, and nothing else, so a newline has to be
// spelled out as a terminator.
const CLAIM_START = /(?:^|\n|[.!?:;])[ \t"'(]*(?:(?:also|additionally|furthermore|then|finally)\b[ \t]+)?$/i;

// And a belt for the same trousers: even at the start of a clause, a negated or hypothetical
// keyword is not a claim ("Not closing #5", "Never closes #5"). Emphasis markers are stripped
// before this runs, so "**not** close #743" reads as "not close #743".
const NEGATION = /(?:n't|\bnot|\bnever|\bcannot|\bno\s+longer)\s*$/i;

// Markdown emphasis and code ticks, removed before anything is read. They sit between the words
// that decide the meaning ("does **not** close") and would otherwise make the negation invisible.
// A line-leading bullet, quote marker or list number goes too, so "- Fixes #12" is as much a claim
// as "Fixes #12" - the marker is punctuation, not part of the sentence.
function stripEmphasis(s) {
  return String(s == null ? '' : s)
    .replace(/[*_`~]+/g, '')
    .replace(/^[ \t]*(?:[-+>]|\d+[.)])[ \t]+/gm, '');
}

/**
 * Issue numbers a closing claim cites, in the order written, deduplicated.
 *
 * `parseClosingKeywords('Fixes #12, closes #13')` -> `[12, 13]`
 * `parseClosingKeywords('see #12 for context')`   -> `[]`
 */
// The words before a keyword, read back to the last sentence boundary. A line break IS a boundary
// for CLAIM_START - a claim really can open a line - but it is not one for NEGATION: a body hard
// wrapped at 80 columns puts "does not" and "close #130" on different lines, and reading only the
// text after the break hands NEGATION an empty string, which turns a disclaimer into a claim. So
// when the text immediately before the keyword carries no word of its own, the clause continues on
// the line above. Measured on the shape that closed #803 and #130, wrapped at 79 columns.
function clauseBefore(text, index) {
  const segs = String(text).slice(Math.max(0, index - 40), index).split(/[.!?:;\n]/);
  let clause = segs.pop();
  while (!/[A-Za-z0-9]/.test(clause) && segs.length) clause = segs.pop() + ' ' + clause;
  return clause;
}

function parseClosingKeywords(text) {
  const s = stripEmphasis(text);
  const out = [];
  KEYWORD.lastIndex = 0;
  let m;
  while ((m = KEYWORD.exec(s)) !== null) {
    // The keyword has to open the line or the sentence.
    if (!CLAIM_START.test(s.slice(0, m.index))) continue;
    // ...and must not be negated.
    const clause = clauseBefore(s, m.index);
    if (NEGATION.test(clause)) continue;
    // Then the run of citations that belongs to it, which may carry further keywords with it:
    // "Fixes #12, closes #13 and #14" is one claim citing three issues.
    let rest = s.slice(m.index + m[0].length).replace(/^[ \t]*:?[ \t]*/, '');
    while (rest) {
      const ref = REFERENCE.exec(rest);
      if (!ref) break;
      const n = Number(ref[1] || ref[2]);
      if (n > 0 && out.indexOf(n) === -1) out.push(n);
      rest = rest.slice(ref[0].length);
      rest = rest.slice(SEPARATOR.exec(rest)[0].length);
    }
  }
  return out;
}

// A squashed merge on this forge keeps the pull request number in the subject: "... (#1897)".
// That is the only reliable link from a commit on main back to the pull request and its body -
// `/repos/{owner}/{repo}/commits/{sha}/pulls` is not served by this instance (404).
function prNumberFromSubject(message) {
  const first = String(message == null ? '' : message).split('\n')[0];
  const m = /\(#(\d+)\)\s*$/.exec(first);
  return m ? Number(m[1]) : null;
}

function subjectLine(message) {
  return String(message == null ? '' : message).split('\n')[0].trim();
}

// ---------------------------------------------------------------------------------------------
// The catalogue, indexed the way a request is written.

// `loadCatalog` returns the spec but not the file it came from, which is why the comments the
// manual sweeper posts name a model and no path - and a comment with no path is what
// `scripts/check-closed-issues.js` calls a "silent" close. A close here has to be checkable by
// the person whose request is being closed, so the paths are collected alongside.
function specFileMap(dir) {
  const out = new Map();
  (function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.json')) continue;
      try {
        const spec = JSON.parse(fs.readFileSync(full, 'utf8'));
        if (!spec || !spec.model) continue;
        const key = norm(spec.model);
        const rel = path.relative(ROOT, full).replace(/\\/g, '/');
        if (key && !out.has(key)) out.set(key, rel);
      } catch (err) { /* a broken spec is the loader's finding to report, not this one's */ }
    }
  })(dir);
  return out;
}

function push(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

/**
 * Vendor/model index with the same three keys the sweeper builds: the whole name, the
 * vendor-qualified name, and the code a reporter actually quotes (`J9781A`, `LBE-5AC-Gen2`).
 *
 * `specs` are catalogue specs; `files` is an optional model-key -> path map, and a spec carrying
 * its own `file` is used as-is so a test can hand in its own rows.
 */
function buildDeviceIndex(specs, files) {
  const byModel = new Map();
  const byVendorModel = new Map();
  const byCode = new Map();
  const vendors = new Map();
  for (const s of specs || []) {
    if (!s || s.error || !s.model) continue;
    const model = norm(s.model);
    if (!model) continue;
    const entry = {
      vendor: s.vendor || null,
      model: s.model,
      category: s.category || null,
      file: s.file || (files && files.get(model)) || null,
      label: s.label || null
    };
    push(byModel, model, entry);
    push(byVendorModel, norm(s.vendor) + ' ' + model, entry);
    if (s.vendor) vendors.set(norm(s.vendor), s.vendor);
    // The part number in brackets is the identifier people quote: Aruba "2530-48 (J9781A)" is
    // requested as "(J9781A)". Shapes come from the sweeper so the two indexes agree.
    for (const group of String(s.model).match(/\(([^)]*)\)/g) || []) {
      const code = norm(group.slice(1, -1));
      if (code && looksLikePartNumber(code) && !byCode.has(code)) byCode.set(code, entry);
    }
    if (looksLikeModelCode(String(s.model)) && !byCode.has(model)) byCode.set(model, entry);
  }
  return { byModel: byModel, byVendorModel: byVendorModel, byCode: byCode, vendors: vendors };
}

function loadDeviceIndex(dir) {
  const devices = dir || path.join(ROOT, 'devices');
  const { loadCatalog } = require(path.join(ROOT, 'devices', 'registry'));
  return buildDeviceIndex(loadCatalog(devices), specFileMap(devices));
}

// The vendor named first in the subject, as its normalised catalogue key, when it is one this
// catalogue knows. Reading it off the title is what stops "[Device]: Ubiquiti Ultra" landing on
// roku/Ultra; the sweeper learned that from a real close, so the same guard is used here rather
// than a fresh one.
function vendorInTitle(rawSubject, index) {
  const first = String(rawSubject || '').trim().split(/\s+/)[0];
  const key = norm(first);
  return (key && index.vendors.has(key)) ? key : null;
}

/**
 * The catalogue entry that answers this request, or null.
 *
 * Every guard is the sweeper's; nothing here decides sameness on its own. A near miss is a miss:
 * an issue asking for "OptiXtrans E6616X" is not answered by the catalogue's "OptiXtrans E6616",
 * and `variantOfSameCode` is what refuses to call it one.
 */
function deviceMatch(title, index) {
  const raw = requestSubject(String(title || ''));
  if (!raw) return null;
  const vendor = vendorInTitle(raw, index);
  const codes = explicitCodes(String(title || ''));
  for (const candidate of requestCandidates(raw)) {
    const key = norm(candidate);
    if (!key) continue;
    const list = (vendor && index.byVendorModel.get(vendor + ' ' + key)) ||
      index.byModel.get(key) ||
      (index.byCode.get(key) ? [index.byCode.get(key)] : null);
    for (const entry of list || []) {
      if (vendor && norm(entry.vendor) !== norm(vendor)) continue;
      // A single generic word ("ultra", "pro") names a line, not a product - unless the reporter
      // wrote that exact code in the title, which is the sweeper's own exception.
      const words = norm(entry.model).split(' ');
      const hasDigit = words.some(function (w) { return /[0-9]/.test(w); });
      if (!hasDigit && words.length < 2 && !codes.has(norm(entry.model))) continue;
      if (variantOfSameCode(String(title || ''), entry.model)) continue;
      if (isAccessoryFor(String(title || ''), entry.model)) continue;
      return entry;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Idempotency: the marker a comment carries so a second run can see this one already spoke.

function markerFor(sha) {
  return 'close-merged-issues: commit ' + String(sha || '');
}

function deviceMarker(vendor, model) {
  return 'close-merged-issues: device ' + String(vendor || '') + '/' + String(model || '');
}

function alreadyHandled(comments, marker) {
  for (const c of comments || []) {
    if (String((c && c.body) || '').indexOf(marker) !== -1) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// The two sweeps. Both take an API client and a log function, so the tests can drive them
// without a tracker: `api.get/post/patch(path)` in, decisions out.

function short(sha) {
  return String(sha || '').slice(0, 7);
}

function keywordComment(sha, prNumber, message) {
  const source = prNumber
    ? 'Closed by commit `' + short(sha) + '`, merged in #' + prNumber + '.'
    : 'Closed by commit `' + short(sha) + '`.';
  const subject = subjectLine(message);
  return source +
    (subject ? '\n\n> ' + subject : '') +
    '\n\nThe merge message names this issue with a closing keyword, so what it asked for is on ' +
    '`main`.\n\nIf that is not what this issue was about, reopen it and say what is still ' +
    'missing - a close that is wrong is worth correcting, not living with.\n\n' +
    '<!-- ' + markerFor(sha) + ' -->';
}

function deviceComment(entry) {
  return 'This device is in the catalogue: **' + entry.vendor + ' ' + entry.model + '**' +
    (entry.file ? ' (`' + entry.file + '`)' : '') + '.' +
    '\n\nFiled under `' + (entry.category || 'uncategorised') + '`. If the port count, cage or ' +
    'rate is wrong for your hardware, say so and it gets fixed - a spec that disagrees with the ' +
    'box is a bug here, not a preference.' +
    '\n\nClosed as already modelled.\n\n<!-- ' + deviceMarker(entry.vendor, entry.model) + ' -->';
}

function mergeNumbers(into, more) {
  for (const n of more) if (into.indexOf(n) === -1) into.push(n);
  return into;
}

/**
 * Keyword sweep: close the issues the pushed commits claim to fix.
 *
 * `commits` is `[{sha, message}]` in the order they landed. Returns
 * `{considered, closed, wouldClose, skipped, errors}`; in dry-run mode `closed` stays empty and
 * `wouldClose` carries the same entries, so a caller can assert that nothing was written.
 */
async function sweepKeywords(opts) {
  const api = opts.api;
  const index = opts.index;
  const dryRun = opts.dryRun !== false;
  const log = opts.log || function () {};
  const out = { considered: 0, closed: [], wouldClose: [], skipped: [], errors: [] };
  const seen = new Set();
  const prCache = new Map();

  for (const commit of opts.commits || []) {
    const sha = commit.sha;
    const message = commit.message || '';
    const numbers = parseClosingKeywords(message);
    const prNumber = prNumberFromSubject(message);

    let pr = null;
    if (prNumber) {
      if (prCache.has(prNumber)) pr = prCache.get(prNumber);
      else {
        try {
          pr = await api.get('/pulls/' + prNumber);
          prCache.set(prNumber, pr);
        } catch (e) {
          // The subject can carry a number that is not a pull request. Not an error: the commit
          // message itself may still cite an issue.
          pr = null;
        }
      }
    }

    // A squash subject is the PR title; the body is where the keyword usually is (#1635 wrote
    // "Fixes #1526"). Only a merged pull request can close anything, so only its body is read.
    const merged = pr && (pr.merged === true || pr.merged_at != null || pr.state === 'closed');
    if (pr && merged) mergeNumbers(numbers, parseClosingKeywords(pr.body));

    for (const number of numbers) {
      if (seen.has(number)) continue;      // first commit in the push that cites it owns the close
      seen.add(number);
      out.considered++;
      const label = '#' + number;

      let issue;
      try {
        issue = await api.get('/issues/' + number);
      } catch (e) {
        out.errors.push({ number: number, reason: e.message });
        log('  cannot read ' + label + ': ' + e.message);
        continue;
      }
      if (issue.pull_request) {
        out.skipped.push({ number: number, reason: 'is a pull request' });
        log('  skip ' + label + ': it is a pull request');
        continue;
      }
      // Never reopen, never re-close: an issue that is already closed was either closed by
      // Forgejo's own keyword handling or by a human, and either way there is nothing to do.
      if (String(issue.state) !== 'open') {
        out.skipped.push({ number: number, reason: 'already ' + issue.state });
        log('  skip ' + label + ': already ' + issue.state);
        continue;
      }

      const marker = markerFor(sha);
      let comments = [];
      try { comments = await api.get('/issues/' + number + '/comments'); } catch (e) { comments = []; }
      if (alreadyHandled(comments, marker)) {
        // This commit already closed it once. Somebody reopened it since, which is a decision
        // about the hardware, not about the merge - so it is left open and not commented again.
        out.skipped.push({ number: number, reason: 'already handled by ' + short(sha) + ' and reopened since' });
        log('  skip ' + label + ': this commit already closed it and somebody reopened it');
        continue;
      }

      const reason = 'cited by ' + short(sha) + ' (' + subjectLine(message) + ')' +
        (prNumber && merged ? ' in #' + prNumber : '');
      if (dryRun) {
        out.wouldClose.push({ number: number, reason: reason, commit: sha, pr: merged ? prNumber : null });
        log('  would close ' + label + ': ' + reason);
        continue;
      }
      try {
        await api.post('/issues/' + number + '/comments', { body: keywordComment(sha, merged ? prNumber : null, message) });
        await api.patch('/issues/' + number, { state: 'closed' });
        out.closed.push({ number: number, reason: reason, commit: sha });
        log('  closed ' + label + ': ' + reason);
      } catch (e) {
        out.errors.push({ number: number, reason: e.message });
        log('  FAILED ' + label + ': ' + e.message);
      }
    }
  }
  if (!out.considered) log('  no closing keyword in these commits');
  return out;
}

/**
 * Device sweep: close the `[Device]:` requests the catalogue demonstrably answers.
 *
 * `opts.issues` is the open issue list when the caller already has it (tests do); otherwise it is
 * fetched, bounded by `opts.limit`. Only `[Device]:` titles are considered - a bug report can
 * name a device without being a request for it, and closing on a shared word is the mistake
 * `closed-audit.yml` exists to find.
 */
async function sweepDevices(opts) {
  const api = opts.api;
  const index = opts.index;
  const dryRun = opts.dryRun !== false;
  const log = opts.log || function () {};
  const explain = !!opts.explain;
  const limit = Number(opts.limit || 300);
  const out = { examined: 0, closed: [], wouldClose: [], skipped: [], present: [], unreachable: [], errors: [] };

  let issues = opts.issues;
  if (!issues) {
    issues = [];
    for (let page = 1; issues.length < limit; page++) {
      const batch = await api.get('/issues?state=open&type=issues&limit=50&page=' + page);
      if (!Array.isArray(batch) || !batch.length) break;
      for (const it of batch) {
        if (it.pull_request) continue;
        issues.push(it);
        if (issues.length >= limit) break;
      }
      if (batch.length < 50) break;
    }
  }

  for (const issue of issues) {
    const title = String(issue.title || '');
    if (!/^\s*\[device\]/i.test(title)) continue;
    out.examined++;
    const entry = deviceMatch(title, index);
    if (!entry) {
      out.unreachable.push({ number: issue.number, title: title });
      if (explain) log('  left open #' + issue.number + ': no exact entry in devices/ for "' + requestSubject(title) + '"');
      continue;
    }
    out.present.push({ number: issue.number, title: title, device: entry });

    let comments = [];
    try { comments = await api.get('/issues/' + issue.number + '/comments'); } catch (e) { comments = []; }
    if (alreadyHandled(comments, deviceMarker(entry.vendor, entry.model))) {
      out.skipped.push({ number: issue.number, reason: 'already closed for ' + entry.vendor + '/' + entry.model + ' and reopened since' });
      log('  skip #' + issue.number + ': already closed for ' + entry.vendor + '/' + entry.model + ' and reopened since');
      continue;
    }

    const reason = 'modelled as ' + entry.vendor + '/' + entry.model + (entry.file ? ' (' + entry.file + ')' : '');
    if (dryRun) {
      out.wouldClose.push({ number: issue.number, reason: reason, device: entry });
      log('  would close #' + issue.number + ': ' + reason);
      continue;
    }
    try {
      await api.post('/issues/' + issue.number + '/comments', { body: deviceComment(entry) });
      await api.patch('/issues/' + issue.number, { state: 'closed' });
      out.closed.push({ number: issue.number, reason: reason, device: entry });
      log('  closed #' + issue.number + ': ' + reason);
    } catch (e) {
      out.errors.push({ number: issue.number, reason: e.message });
      log('  FAILED #' + issue.number + ': ' + e.message);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The tracker.

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

function token() {
  for (const name of ['FORGEJO_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN']) {
    const value = process.env[name];
    if (value && value.trim()) return value.trim();
  }
  return null;
}

// Candidate API bases, most likely first. The git remote on a workstation is an SSH alias that
// does not resolve to the web UI, so a base derived from it is guesswork; the instance address
// the other scripts here already use is the honest default, and every candidate is probed.
function apiCandidates() {
  const out = [];
  for (const raw of [process.env.FORGEJO_URL, process.env.PF_API, process.env.GITHUB_API_URL]) {
    if (!raw) continue;
    const base = raw.replace(/\/$/, '');
    const withApi = base.indexOf('/api/') === -1 ? base + '/api/v1' : base;
    if (out.indexOf(withApi) === -1) out.push(withApi);
  }
  for (const fallback of ['http://10.0.10.20:3000/api/v1', 'https://git.jayw.uk/api/v1']) {
    if (out.indexOf(fallback) === -1) out.push(fallback);
  }
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

function makeApi(base, tok) {
  async function call(method, p, body) {
    const res = await fetch(base + '/repos/' + OWNER + '/' + NAME + p, {
      method: method,
      headers: {
        Authorization: 'token ' + tok,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(method + ' ' + p + ' -> HTTP ' + res.status + ' ' + String(text).slice(0, 160));
      err.status = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : {};
  }
  return {
    get: function (p) { return call('GET', p); },
    post: function (p, body) { return call('POST', p, body || {}); },
    patch: function (p, body) { return call('PATCH', p, body || {}); }
  };
}

// Commits in a range, from the API: `/compare/{base}...{head}`. The workflow passes the push's
// before/after, which is the only range that means "this merge"; on a workstation a git range is
// used instead, because the tree is already here.
async function commitsFromCompare(api, from, to) {
  const cmp = await api.get('/compare/' + from + '...' + to);
  return (cmp.commits || []).map(function (c) {
    return { sha: c.sha, message: (c.commit && c.commit.message) || '' };
  });
}

function commitsFromGit(limit) {
  const from = process.env.PUSH_BEFORE || '';
  const fmt = '%H%x1f%B%x1e';
  const args = ['log', '--format=' + fmt, '-n', String(limit)];
  if (from && !/^0+$/.test(from)) args.push(from + '..HEAD');
  else args.push('HEAD');
  const raw = execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return raw.split('\x1e')
    .map(function (chunk) { return chunk.replace(/^\s+/, ''); })
    .filter(Boolean)
    .map(function (chunk) {
      const sep = chunk.indexOf('\x1f');
      return { sha: chunk.slice(0, sep).trim(), message: chunk.slice(sep + 1).replace(/\s+$/, '') };
    });
}

async function main() {
  const tok = token();
  if (!tok) {
    console.error('no token: set FORGEJO_TOKEN (or GITHUB_TOKEN / GH_TOKEN).');
    console.error('A token with read access is enough for a dry run; --apply also needs to write issues.');
    process.exit(2);
  }

  const apply = process.argv.includes('--apply');
  const dryRun = !apply;
  const explain = process.argv.includes('--explain');
  const limit = Number(arg('limit', 10));
  const issueLimit = Number(arg('issues', 300));
  const keywordsOnly = process.argv.includes('--keywords-only');
  const deviceOnly = process.argv.includes('--device-only');

  const base = await pickApiBase(tok);
  const api = makeApi(base, tok);
  const index = loadDeviceIndex();

  console.log('close-merged-issues');
  console.log('  repo      : ' + OWNER + '/' + NAME);
  console.log('  api       : ' + base);
  console.log('  catalogue : ' + index.byModel.size + ' distinct model names');
  console.log('  mode      : ' + (dryRun ? 'DRY RUN - nothing will be closed' : 'APPLY - issues will be closed and commented'));

  let commits = [];
  if (!deviceOnly) {
    const from = arg('from', null);
    const to = arg('to', process.env.PUSH_SHA || null);
    if (from && to && from !== true && to !== true && !/^0+$/.test(from)) {
      commits = await commitsFromCompare(api, from, to);
    } else {
      commits = commitsFromGit(limit);
    }
    console.log('  commits   : ' + commits.length +
      (commits.length ? ' (' + short(commits[0].sha) + '..' + short(commits[commits.length - 1].sha) + ')' : ''));
  }
  console.log('');

  let keywordResult = null;
  if (!deviceOnly) {
    console.log('keyword sweep - issues a merged commit claims to fix');
    keywordResult = await sweepKeywords({ api: api, index: index, commits: commits, dryRun: dryRun, log: console.log });
    console.log('');
  }

  let deviceResult = null;
  if (!keywordsOnly) {
    console.log('device sweep - [Device]: requests the catalogue already answers');
    deviceResult = await sweepDevices({
      api: api, index: index, dryRun: dryRun, log: console.log, explain: explain, limit: issueLimit
    });
    console.log('  open [Device] requests examined: ' + deviceResult.examined +
      ', present in devices/: ' + deviceResult.present.length);
    console.log('');
  }

  const wouldClose = [].concat(
    keywordResult ? keywordResult.wouldClose : [],
    deviceResult ? deviceResult.wouldClose : []
  );
  const closed = [].concat(
    keywordResult ? keywordResult.closed : [],
    deviceResult ? deviceResult.closed : []
  );
  console.log(dryRun
    ? 'dry run: ' + wouldClose.length + ' issue(s) would be closed, 0 were touched'
    : 'closed ' + closed.length + ' issue(s)');

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ dryRun: dryRun, wouldClose: wouldClose, closed: closed, keyword: keywordResult, device: deviceResult }, null, 2));
  }

  // A maintenance job does not fail a merge (docs/CI.md, "Why a maintenance job never fails a
  // pull request"): an error is reported with the reason and the exit stays 0. The one thing
  // that must not happen is a crash that looks like a clean run, so errors are printed loudly.
  const errors = [].concat(
    keywordResult ? keywordResult.errors : [],
    deviceResult && deviceResult.errors ? deviceResult.errors : []
  );
  if (errors.length) {
    console.log('');
    console.log('errors (' + errors.length + '):');
    for (const e of errors) console.log('  #' + e.number + ': ' + e.reason);
    if (errors.some(function (e) { return /\b(401|403)\b/.test(e.reason); })) {
      console.log('  the token could not write to the tracker - a run token may not carry issue write here;');
      console.log('  set the FORGEJO_TOKEN secret, as auto-rebase.yml and pr-rebase.yml do.');
    }
  }
}

module.exports = {
  parseClosingKeywords: parseClosingKeywords,
  prNumberFromSubject: prNumberFromSubject,
  buildDeviceIndex: buildDeviceIndex,
  loadDeviceIndex: loadDeviceIndex,
  specFileMap: specFileMap,
  deviceMatch: deviceMatch,
  markerFor: markerFor,
  deviceMarker: deviceMarker,
  alreadyHandled: alreadyHandled,
  sweepKeywords: sweepKeywords,
  sweepDevices: sweepDevices,
  keywordComment: keywordComment,
  deviceComment: deviceComment
};

if (require.main === module) {
  main().catch(function (e) {
    console.error('close-merged-issues failed: ' + e.message);
    process.exit(2);
  });
}
