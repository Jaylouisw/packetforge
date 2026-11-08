#!/usr/bin/env node
/**
 * Sweep the hardware-request backlog for devices the catalogue already has.
 *
 * The repository has ~830 open issues and most of them are device requests. A good fraction ask for
 * hardware that is already modelled, and those requests sit open for months because nobody reads all
 * of them. This script answers one question, mechanically: *is this request already satisfied?* - and
 * it never invents an answer. A match is an exact normalised model name (or a vendor + model name),
 * and the comment it posts names the file that satisfies it so the reporter can check.
 *
 * Usage:
 *   node scripts/sweep-device-requests.js                 # report only
 *   node scripts/sweep-device-requests.js --limit 300     # scan more pages
 *   node scripts/sweep-device-requests.js --close 10      # comment and close the first 10 matches
 *
 * Credentials come from the origin remote, the same way the other scripts here get them.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OWNER = 'jaylouisw', REPO = 'packetforge';
const API = 'http://10.0.10.20:3000/api/v1';

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const LIMIT_PER_PAGE = 50;
const MAX_ISSUES = Number(arg('limit', 200));
const CLOSE_BUDGET = Number(arg('close', 0));

function token() {
  // An environment token first, so this can run in CI where there is no remote URL
  // with credentials embedded in it. The workflow provides GITHUB_TOKEN; FORGEJO_TOKEN
  // is accepted so a local run does not have to pretend to be GitHub.
  for (const name of ['FORGEJO_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN']) {
    const value = process.env[name];
    if (value && value.trim()) return value.trim();
  }
  for (const remote of ['github', 'origin']) {
    let url = '';
    try { url = execFileSync('git', ['remote', 'get-url', remote], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch (e) { continue; }
    const m = /^[a-z]+:\/\/([^@]+)@/.exec(url);
    if (m) {
      const cred = m[1];
      const idx = cred.indexOf(':');
      if (idx !== -1) return cred.slice(idx + 1);
    }
  }
  throw new Error('no token: set FORGEJO_TOKEN (or put one in a git remote URL)');
}

async function api(tok, p, opts) {
  const res = await fetch(API + '/repos/' + OWNER + '/' + REPO + p, Object.assign({
    headers: { Authorization: 'token ' + tok, 'Content-Type': 'application/json' }
  }, opts || {}));
  const text = await res.text();
  if (!res.ok) throw new Error(res.status + ' ' + text.slice(0, 200));
  return text ? JSON.parse(text) : {};
}

// ---------------------------------------------------------------------------
// The catalogue, indexed the way a request is written rather than the way a spec stores it.

// A normalised key that keeps every distinguishing token. Stripping punctuation alone is not
// enough: "WiFi Mesh 3+" and "WiFi Mesh 3" are different products, and a sweep that closes the first
// citing the second has told a reporter their hardware is modelled when it is not. '+' becomes a
// word, and punctuation otherwise becomes a separator rather than disappearing.
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\+\+/g, ' plusplus ')
    .replace(/\+/g, ' plus ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function loadCatalogue() {
  const { loadCatalog } = require(path.join(ROOT, 'devices', 'registry'));
  const specs = loadCatalog(path.join(ROOT, 'devices'));
  const byModel = new Map();
  const byVendorModel = new Map();
  for (const s of specs) {
    const vendor = norm(s.vendor), model = norm(s.model);
    if (!model) continue;
    if (!byModel.has(model)) byModel.set(model, []);
    byModel.get(model).push({ vendor: s.vendor, model: s.model, file: s.file || null, category: s.category });
    const vm = vendor + model;
    if (!byVendorModel.has(vm)) byVendorModel.set(vm, []);
    byVendorModel.get(vm).push({ vendor: s.vendor, model: s.model, file: s.file || null, category: s.category });
  }
  const vendorNames = new Map();
  for (const s of specs) vendorNames.set(norm(s.vendor), s.vendor);
  return { specs: specs, byModel: byModel, byVendorModel: byVendorModel, vendorNames: vendorNames };
}

// "[Device]: TP-Link TL-SG105E — 5-port gigabit Easy Smart switch" -> "TP-Link TL-SG105E"
function requestSubject(title) {
  let t = String(title || '').replace(/^\[[^\]]*\]\s*:?\s*/, '');
  // cut at the em dash / hyphen / colon that starts the description
  // Deliberately not cut at "(" any more. A model code lives in the parentheses as often
  // as not - "HUAWEI 4G Mobile WiFi 3 (E5785)" - and cutting there threw away the one
  // token that distinguishes it from "4G Mobile WiFi 3 (E5783)". The caller tries the
  // parenthetical both with and without instead of destroying it here.
  const cut = t.search(/\s+[—–-]\s+|\s*:\s*/);
  if (cut > 0) t = t.slice(0, cut);
  return t.trim();
}

function main() {
  const tok = token();
  const cat = loadCatalogue();
  console.log('catalogue: ' + cat.specs.length + ' models, ' + cat.byModel.size + ' distinct normalised model names');
  console.log('scanning up to ' + MAX_ISSUES + ' open issues' + (CLOSE_BUDGET ? ', will close up to ' + CLOSE_BUDGET : '') + '\n');

  (async function () {
    const issues = [];
    for (let page = 1; issues.length < MAX_ISSUES; page++) {
      const batch = await api(tok, '/issues?state=open&type=issues&limit=' + LIMIT_PER_PAGE + '&page=' + page);
      if (!Array.isArray(batch) || !batch.length) break;
      for (const it of batch) {
        if (it.pull_request) continue;
        issues.push(it);
        if (issues.length >= MAX_ISSUES) break;
      }
      if (batch.length < LIMIT_PER_PAGE) break;
    }

    const matched = [];
    const deviceRequests = [];
    for (const it of issues) {
      const title = String(it.title || '');
      const isRequest = /^\[(device|hardware)\]/i.test(title) || /^\[device\]/i.test(title);
      if (isRequest) deviceRequests.push(it);
      // The subject as written, and the same subject with any parenthetical removed. Both
      // are tried: a model code lives in the parentheses as often as not, while a title
      // like "Aruba 2530-48 (EOL, replaced by X)" only matches once the note is dropped.
      const rawSubject = requestSubject(title);
      const subjects = [rawSubject];
      const noParen = rawSubject.replace(/\s*\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
      if (noParen && noParen !== rawSubject) subjects.push(noParen);

      let hit = null;
      let subject = rawSubject;

      for (const candidate of subjects) {
        subject = candidate;
        const key = norm(subject);
        if (!key) continue;

        // A candidate is only accepted if it survives every guard. The expensive mistake here is not
        // missing a match - it is closing someone's request by pointing at a different product, which
        // tells them their hardware is modelled when it is not.
        const parts = subject.split(/\s+/);
        const subjectVendor = cat.vendorNames.get(norm(parts[0])) || null;

        const acceptable = function (info) {
          if (!info) return false;
          // The vendor in the title must agree with the catalogue entry's vendor. "Ubiquiti UniFi
          // Cloud Gateway Ultra" once matched roku/Ultra on the shared word "Ultra".
          if (subjectVendor && norm(info.vendor) !== norm(subjectVendor)) return false;
          // A model key worth matching has a digit in it, or at least two words. Single generic words
          // ("ultra", "ac", "pro") identify lines, not products.
          const modelKey = norm(info.model).split(' ');
          const hasDigit = modelKey.some(function (w) { return /[0-9]/.test(w); });
          if (!hasDigit && modelKey.length < 2) return false;
          return true;
        };

        const whole = cat.byVendorModel.get(key) || cat.byModel.get(key);
        if (whole && acceptable(whole[0])) hit = whole;
        if (!hit) {
          // "MikroTik Cloud Core Router CCR2004-16G-2S+" -> the model is a trailing run of tokens.
          // Only suffixes that pass the same guards are considered, longest first.
          for (let i = 1; i < parts.length && !hit; i++) {
            const tail = norm(parts.slice(i).join(' '));
            const cand = cat.byVendorModel.get(norm(parts[0]) + ' ' + tail) || cat.byModel.get(tail);
            if (cand && acceptable(cand[0])) hit = cand;
          }
        }
        if (hit) break;
      }
      if (hit && hit.length) matched.push({ issue: it, subject: subject, device: hit[0] });
    }

    console.log('open issues scanned      : ' + issues.length);
    console.log('device/hardware requests : ' + deviceRequests.length);
    console.log('already in the catalogue : ' + matched.length);
    console.log('');
    for (const m of matched.slice(0, 40)) {
      console.log('  #' + String(m.issue.number).padEnd(5) + ' ' + m.subject.slice(0, 42).padEnd(43) +
        '-> ' + m.device.vendor + '/' + m.device.model + (m.device.file ? ' (' + path.basename(m.device.file) + ')' : ''));
    }
    if (matched.length > 40) console.log('  ... and ' + (matched.length - 40) + ' more');

    if (!CLOSE_BUDGET) {
      console.log('\nreport only. Re-run with --close N to comment and close N of these.');
      return;
    }

    let closed = 0;
    for (const m of matched.slice(0, CLOSE_BUDGET)) {
      const body = 'This device is in the catalogue: **' + m.device.vendor + ' ' + m.device.model + '**' +
        (m.device.file ? ' (`' + m.device.file.replace(/\\/g, '/') + '`)' : '') + '.' +
        '\n\nFiled under `' + (m.device.category || 'uncategorised') + '`. If the port count, cage or rate ' +
        'is wrong for your hardware, say so and it gets fixed - a spec that disagrees with the box is a bug ' +
        'here, not a preference.\n\nClosed as already modelled.';
      try {
        await api(tok, '/issues/' + m.issue.number + '/comments', { method: 'POST', body: JSON.stringify({ body: body }) });
        await api(tok, '/issues/' + m.issue.number, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) });
        closed++;
        console.log('  closed #' + m.issue.number + ' ' + m.device.vendor + ' ' + m.device.model);
      } catch (e) {
        console.log('  FAILED #' + m.issue.number + ': ' + e.message);
      }
    }
    console.log('\nclosed ' + closed + ' of ' + matched.length + ' matches');
  })().catch(function (e) {
    console.error('error: ' + e.message);
    process.exit(1);
  });
}


// Requiring the file gives a test the two pure functions without running a sweep against a
// live instance; running it is what the command line is for.
if (require.main === module) {
  main();
} else {
  module.exports = { requestSubject: requestSubject, norm: norm };
}
