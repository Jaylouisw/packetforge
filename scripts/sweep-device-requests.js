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
    // stderr is discarded: a checkout with no 'github' remote is the normal case here, and
    // git's "error: No such remote 'github'" printed above our own diagnosis read like a
    // crash. The only error a user should see is the one that tells them what to do.
    try {
      url = execFileSync('git', ['remote', 'get-url', remote], {
        cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
    } catch (e) { continue; }
    const m = /^[a-z]+:\/\/([^@]+)@/.exec(url);
    if (m) {
      const cred = m[1];
      const idx = cred.indexOf(':');
      if (idx !== -1) return cred.slice(idx + 1);
    }
  }
  throw new Error([
    'no token: this script needs a Forgejo token to read the issue tracker.',
    '',
    'Fix it one of these ways:',
    '  1. export FORGEJO_TOKEN=<your token>        (also accepts GITHUB_TOKEN or GH_TOKEN)',
    '  2. put a token in the git remote URL:       https://<user>:<token>@git.jayw.uk/jaylouisw/packetforge.git',
    '',
    'A token with read access to issues is enough for a report run; closing requests',
    '(--close N) additionally needs write access.',
    'Stuck? Report it: https://git.jayw.uk/jaylouisw/packetforge/issues/new?template=bug_report.yml'
  ].join('\n'));
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
// Titles on the tracker are full of typographic hyphens - Ubiquiti writes "UF&#8209;OLT" and
// "LBE‑5AC‑Gen2" - and a code split at U+2011 is not a code. Fold every dash onto ASCII '-'
// before anything else looks at the string.
// Issue titles were imported from a scraper that left HTML entities in place: Ubiquiti's
// "UF&#8209;OLT" is a literal string, not an en dash. A code split on "&#8209;" is not a code.
function deEntity(s) {
  return String(s == null ? '' : s)
    .replace(/&#x([0-9a-fA-F]+);/g, function (m, h) { try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return m; } })
    .replace(/&#(\d+);/g, function (m, d) { try { return String.fromCodePoint(parseInt(d, 10)); } catch (e) { return m; } })
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function deDash(s) {
  return deEntity(s).replace(/[‐‑‒–—―−]/g, '-');
}

function norm(s) {
  return deDash(s || '')
    .toLowerCase()
    .replace(/\+\+/g, ' plusplus ')
    .replace(/\+/g, ' plus ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// A part number, as opposed to any short token. Aruba/HPE quote J9781A, JL355A, R2W96A, S1T37A -
// one to three letters, at least three digits, optional trailing letter. "M4" and "NSM3" are not
// part numbers, and indexing them as if they were made a NetEngine router match an Apple iPad.
function looksLikePartNumber(code) {
  // Three or more digits anywhere in the code, at most three leading letters. That admits
  // J9781A and JL355A (letters, digits, optional letter) and also R2W96A and S1T37A, where the
  // letters are interleaved - while still rejecting M4, NSM3, MIMO and UX.
  return /^(?=(?:.*\d){3,})[a-z]{1,3}[a-z0-9]{1,7}$/.test(norm(code));
}

// A model name that is itself a product code: at least one digit and at least one hyphen, so
// "LBE-5AC-Gen2", "US-8-60W", "IS-M5" and "ES-12F" qualify while "5GHz", "802" and "M4" do not.
// Requests quote these verbatim, which makes them the safest key in the whole catalogue.
function looksLikeModelCode(model) {
  const raw = String(model || '').trim();
  return /^(?=.*\d)[A-Za-z0-9][A-Za-z0-9+/-]{2,}$/.test(raw) && raw.indexOf('-') !== -1;
}

// --- Hints: the tiers below exactness -------------------------------------------------------
//
// Exactness is right: closing somebody's request by pointing at a different product tells them
// their hardware is modelled when it is not. But exactness alone is why #842 ("Amazon Fire TV
// Stick") and #843 ("Microsoft Xbox") sat open for months after the devices were imported - a
// person writes the name they say out loud, and the catalogue stores the model. A sweep that can
// only see exact matches therefore reports "nothing to do" while the backlog fills with requests
// that are already answered.
//
// So: report a hint, never act on one. Nothing here closes an issue.

// Prepositions that make the device the *target* of the request rather than the request itself.
// "Iso-Beam-19 RF Isolator Shield for NBE-M5-19" is an accessory, and matching it to the radio it
// clips onto is how this script closed an accessory request as "already modelled" (#246).
const ACCESSORY_FRAME = /\b(?:for|compatible\s+with|fits|to\s+fit|works\s+with|mounts?\s+on)\s+([A-Za-z0-9][A-Za-z0-9+\/.-]{2,})/gi;

function accessoryTargets(title) {
  const out = [];
  const raw = deDash(title || '');
  ACCESSORY_FRAME.lastIndex = 0;
  let m;
  while ((m = ACCESSORY_FRAME.exec(raw)) !== null) {
    const key = norm(m[1]);
    if (key && out.indexOf(key) === -1) out.push(key);
  }
  return out;
}

// True when the matched device is the thing this request attaches to, not the thing it asks for.
//
// Position decides, not vocabulary: if the matched model appears in the title *after* an accessory
// preposition, the request is about something that fits it. #246 reads "Iso-Beam-19 RF Isolator
// Shield for NanoBeam NBE-M2-13, NBE-M5-19" - the shield is the subject, the radios are the target,
// and the one-token reader above only sees "NanoBeam".
function isAccessoryFor(title, model) {
  const raw = deDash(title || '');
  const modelRaw = String(model || '');
  if (!raw || !modelRaw) return false;
  const lower = raw.toLowerCase();
  let modelAt = lower.indexOf(modelRaw.toLowerCase());
  if (modelAt === -1) {
    // The catalogue model can carry a series prefix the reporter leaves out: the title says
    // "NanoBeam M5-19" and the catalogue says "NBE-M5-19". Fall back to the last two code tokens,
    // hyphenated or spaced, and only then give up.
    const parts = modelRaw.split(/[\s\-_]+/).filter(Boolean);
    const tail = parts.slice(-2).join('-').toLowerCase();
    if (tail) {
      modelAt = lower.indexOf(tail);
      if (modelAt === -1) modelAt = lower.indexOf(tail.replace(/-/g, ' '));
    }
  }
  // The device is not named in the title at all: nothing to compare positions with, so a match
  // elsewhere is not suppressed. A guard that fires on uncertainty would silence real requests.
  if (modelAt === -1) return false;
  ACCESSORY_FRAME.lastIndex = 0;
  let m;
  while ((m = ACCESSORY_FRAME.exec(raw)) !== null) {
    // The model is named after the preposition, so it is what the request attaches to. When the
    // model is named first ("NBE-M5-19 shield kit for outdoor use") this stays false.
    if (m.index < modelAt) return true;
  }
  return false;
}

// Catalogue entries a request is plausibly asking for without naming exactly, from the same
// vendor: the request's words are a prefix of the model ("Fire TV Stick" -> "Fire TV Stick 4K
// Max (2nd gen)") or of one of its words. Same-vendor is not negotiable - "Ultra" is a Ubiquiti
// gateway and a Roku.
//
// Exact matches are excluded: those are the sweeper's own job, and a hint that duplicates a hit
// teaches the reader to skim.
function familyCandidates(rawSubject, vendor, entries) {
  const subject = norm(rawSubject);
  if (!subject || !Array.isArray(entries)) return [];
  let words = subject.split(' ');
  // Drop a leading vendor word: "Microsoft Xbox" -> "xbox", "Amazon Fire TV Stick" -> "fire tv stick".
  if (vendor && words.length > 1 && words[0] === norm(vendor)) words = words.slice(1);
  const key = words.join(' ');
  if (key.length < 3) return [];
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    if (!e || !e.model) continue;
    if (vendor && norm(e.vendor) !== norm(vendor)) continue;
    const model = norm(e.model);
    if (!model || model === key) continue;
    if (model.indexOf(key + ' ') !== 0 && model !== key + 's') continue;
    const id = (e.vendor || '') + '/' + (e.model || '');
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ vendor: e.vendor, model: e.model, file: e.file || null, category: e.category });
    if (out.length >= 3) break;
  }
  return out;
}

function loadCatalogue() {
  const { loadCatalog } = require(path.join(ROOT, 'devices', 'registry'));
  const specs = loadCatalog(path.join(ROOT, 'devices'));
  const byModel = new Map();
  const byVendorModel = new Map();
  const byCode = new Map(); // part number -> entry, from "2530-48 (J9781A)" style models
  for (const s of specs) {
    const vendor = norm(s.vendor), model = norm(s.model);
    if (!model) continue;
    if (!byModel.has(model)) byModel.set(model, []);
    byModel.get(model).push({ vendor: s.vendor, model: s.model, file: s.file || null, category: s.category });
    const vm = vendor + model;
    if (!byVendorModel.has(vm)) byVendorModel.set(vm, []);
    byVendorModel.get(vm).push({ vendor: s.vendor, model: s.model, file: s.file || null, category: s.category });
    // The part number in brackets is the identifier people actually quote: Aruba "2530-48 (J9781A)"
    // is requested as "Aruba 2530-48 Switch (J9781A)". Without this index those 28 requests read
    // as missing while their specs sit in the catalogue.
    for (const group of String(s.model || '').match(/\(([^)]*)\)/g) || []) {
      const code = norm(group.slice(1, -1));
      // Part-number shape only: letters then at least three digits (J9781A, JL355A, R2W96A,
      // S1T37A). Without this, short tokens like "M4" or "NSM3" index whole unrelated products
      // and a request for a NetEngine router matches an Apple iPad.
      if (code && looksLikePartNumber(code) && !byCode.has(code)) {
        byCode.set(code, { vendor: s.vendor, model: s.model, file: s.file || null, category: s.category });
      }
    }
    // Not every vendor brackets its part number. Ubiquiti names the model itself in code form -
    // "LBE-5AC-Gen2", "US-8-60W", "IS-M5", "ES-12F" - so the model name is the code, and a
    // request that quotes "LBE-5AC-Gen2" is quoting the catalogue key exactly.
    if (looksLikeModelCode(String(s.model))) {
      const bare = norm(s.model);
      if (bare && !byCode.has(bare)) {
        byCode.set(bare, { vendor: s.vendor, model: s.model, file: s.file || null, category: s.category });
      }
    }
  }
  const vendorNames = new Map();
  for (const s of specs) vendorNames.set(norm(s.vendor), s.vendor);
  return { specs: specs, byModel: byModel, byVendorModel: byVendorModel, byCode: byCode, vendorNames: vendorNames };
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

// Every form of the subject worth trying against the catalogue.
//
// The model code lives in the parentheses more often than not, and the catalogue is keyed
// on the code rather than the marketing name around it: "Ubiquiti UniFi Switch Pro XG 24
// (USW-Pro-XG-24)" normalises to the whole sentence, which matches nothing, while
// "USW-Pro-XG-24" is in the catalogue verbatim. Both forms are tried, plus the title with
// its parentheticals removed, because a note like "(EOL, replaced by X)" is noise.
function requestCandidates(rawSubject) {
  const subjects = [rawSubject];
  const noParen = String(rawSubject || '').replace(/\s*\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (noParen && subjects.indexOf(noParen) === -1) subjects.push(noParen);
  for (const group of String(rawSubject || '').match(/\(([^)]*)\)/g) || []) {
    const inner = group.slice(1, -1);
    for (const part of inner.split(/[,/]| and /i)) {
      const p = part.trim();
      if (p && subjects.indexOf(p) === -1) subjects.push(p);
    }
  }
  // And the model code as a bare word, because it is not always in brackets and not
  // always at the end: "Teltonika RUT241 Industrial 4G LTE Wi-Fi Router" has RUT241 in
  // the middle, and the suffix search below never reaches it. Only tokens with a digit
  // and at least three characters are worth trying - "5-Pack" and "48-Port" are not
  // model codes, and the catalogue lookup still has to find an exact match.
  for (const token of String(rawSubject || '').split(/[\s,()\[\]]+/)) {
    const t = token.trim();
    // A code with a digit is always worth trying. An ALL-CAPS token ("LAP-GPS", "GBE") is
    // worth trying too: it is how reporters write codes that have no digit at all.
    const looksLikeCode = /[0-9]/.test(t) || /^[A-Z][A-Z0-9\-\+\.\/]{1,}$/.test(t);
    if (t.length < 3 || !looksLikeCode) continue;
    if (subjects.indexOf(t) === -1) subjects.push(t);
  }
  return subjects;
}

// Qualifiers that turn a model into a *different* product.
// "RUT951 POE+" is not a RUT951: the PoE variant adds power outputs and a budget that the
// plain unit does not have. Closing that request by pointing at the RUT951 spec told a
// reporter their hardware was modelled when it was not, which is the one mistake this script
// exists to avoid.
const VARIANT_QUALIFIERS = ['poe', 'plus', 'pro', 'max', 'hd', 'lr', 'kit', 'pack', 'bundle'];

// True when the request names a code that *begins* with the catalogue model and keeps going -
// "RUT951-POE" against "RUT951", or "RUT951 POE+" as a separate word. An exact code is fine;
// a longer one is a different device.
function variantOfSameCode(title, model) {
  const key = norm(model);
  if (!key) return false;
  const raw = String(title || '');
  const codes = [];
  for (const group of raw.match(/\(([^)]*)\)/g) || []) codes.push(group.slice(1, -1));
  for (const token of raw.split(/[\s,()\[\]]+/)) if (token && /[-\/]/.test(token)) codes.push(token);
  for (const code of codes) {
    const n = norm(code);
    if (!n || n === key) continue;
    if (n.indexOf(key + ' ') === 0) return true;
  }
  const words = norm(raw).split(' ');
  const keyWords = key.split(' ');
  for (let i = 0; i + keyWords.length < words.length; i++) {
    let match = true;
    for (let j = 0; j < keyWords.length; j++) {
      if (words[i + j] !== keyWords[j]) { match = false; break; }
    }
    if (!match) continue;
    if (VARIANT_QUALIFIERS.indexOf(words[i + keyWords.length]) !== -1) return true;
  }
  return false;
}

// Codes the reporter wrote *explicitly*: anything in brackets, plus ALL-CAPS tokens like
// "GBE" or "UX". These are trusted to name a product even when they are a single word with
// no digit, which the general guard below requires - without this, models named GBE, UBB,
// UDW, UX, EFG, UTR and LAP-GPS all read as "not in the catalogue" while sitting in it.
// The vendor guard still applies, so "UniFi Mobile Router Ultra" does not land on roku/Ultra.
function explicitCodes(title) {
  const codes = new Set();
  for (const group of String(title || '').match(/\(([^)]*)\)/g) || []) {
    for (const part of group.slice(1, -1).split(/[,/]| and /i)) {
      const n = norm(part.trim());
      if (n) codes.add(n);
    }
  }
  for (const token of String(title || '').match(/\b[A-Z][A-Z0-9\-\+\.\/]{1,}\b/g) || []) {
    const n = norm(token);
    if (n) codes.add(n);
  }
  return codes;
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
    const hints = [];
    const deviceRequests = [];
    for (const it of issues) {
      const title = String(it.title || '');
      const isRequest = /^\[(device|hardware)\]/i.test(title) || /^\[device\]/i.test(title);
      if (isRequest) deviceRequests.push(it);
      // The subject as written, and the same subject with any parenthetical removed. Both
      // are tried: a model code lives in the parentheses as often as not, while a title
      // like "Aruba 2530-48 (EOL, replaced by X)" only matches once the note is dropped.
      const rawSubject = requestSubject(title);
      const subjects = requestCandidates(rawSubject);
      // The vendor comes from the *title*, not from whichever candidate is being tried. Reading it
      // off the candidate let a bare token ("M4", "MIMO") bypass the vendor guard entirely, which is
      // how "NetEngine 8000 M4" matched an Apple iPad Pro.
      const titleVendor = cat.vendorNames.get(norm(rawSubject.split(/\s+/)[0])) || null;

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
        const subjectVendor = titleVendor || cat.vendorNames.get(norm(parts[0])) || null;
        const codes = explicitCodes(title);
        const codeTokens = (deDash(title).match(/\b[A-Za-z0-9]+(?:[-\/][A-Za-z0-9]+)+\b/g) || [])
          .filter(function (t) { return /[0-9]/.test(t) && t.length >= 4; })
          .map(norm);

        const acceptable = function (info) {
          if (!info) return false;
          // The vendor in the title must agree with the catalogue entry's vendor. "Ubiquiti UniFi
          // Cloud Gateway Ultra" once matched roku/Ultra on the shared word "Ultra".
          if (subjectVendor && norm(info.vendor) !== norm(subjectVendor)) return false;
          // A model key worth matching has a digit in it, or at least two words. Single generic words
          // ("ultra", "ac", "pro") identify lines, not products.
          const modelKey = norm(info.model).split(' ');
          const hasDigit = modelKey.some(function (w) { return /[0-9]/.test(w); });
          if (!hasDigit && modelKey.length < 2) {
            // ...unless the reporter wrote that exact code themselves: "(UX)", "(GBE)", "(UDW)".
            return codes.has(norm(info.model));
          }
          return true;
        };

        const whole = cat.byVendorModel.get(key) || cat.byModel.get(key);
        if (whole && acceptable(whole[0]) && !variantOfSameCode(title, whole[0].model)) hit = whole;
        if (!hit) {
          // A bracketed part number is the identifier the reporter actually quotes, and the
          // catalogue stores it inside the model name ("2530-48 (J9781A)"). Exact code match
          // only - a different part number is a different switch.
          // Bracketed codes first, then any hyphenated code the reporter typed in the title -
          // Ubiquiti requests write "LiteBeam 5AC Gen2 - LBE-5AC-Gen2" without brackets, and
          // "LBE-5AC-Gen2" is the catalogue's own key.
          const allCodes = Array.from(codes).concat(codeTokens);
          // A request that names two products - "ASUS RT-AX89U - the actual router model, catalogue
          // only has RT-AX89X" - must not be closed against the one the catalogue happens to have.
          // If any code-shaped candidate in the title is absent from the catalogue, the reporter is
          // asking for something this catalogue does not model, and the match is ambiguous.
          const named = allCodes.filter(function (c) { return /[0-9]/.test(c) && c.split(' ').length >= 2; });
          const absent = named.filter(function (c) { return !cat.byCode.get(c); });
          // A prefix is not a contradiction: "LBE-5AC" is how the caps-token scan splits
          // "LBE-5AC-Gen2", and "US-8-5" is a five-pack of the US-8. Only an unrelated absent code
          // - "RT-AX89U" next to a catalogue "RT-AX89X" - makes the request ambiguous.
          const ambiguous = named.length > 1 && absent.some(function (a) {
            return !named.some(function (p) {
              return cat.byCode.get(p) && (a.indexOf(p) === 0 || p.indexOf(a) === 0);
            });
          });
          if (!ambiguous) {
            for (const code of allCodes) {
              const cand = cat.byCode.get(code);
              if (cand && acceptable(cand) && !variantOfSameCode(title, cand.model)) { hit = [cand]; break; }
            }
          }
        }
        if (!hit) {
          // "MikroTik Cloud Core Router CCR2004-16G-2S+" -> the model is a trailing run of tokens.
          // Only suffixes that pass the same guards are considered, longest first.
          for (let i = 1; i < parts.length && !hit; i++) {
            const tail = norm(parts.slice(i).join(' '));
            const cand = cat.byVendorModel.get(norm(parts[0]) + ' ' + tail) || cat.byModel.get(tail);
            if (cand && acceptable(cand[0]) && !variantOfSameCode(title, cand[0].model)) hit = cand;
          }
        }
        if (hit) break;
      }
      if (hit && hit.length) {
        // An accessory request names the device it fits, and that name is in the catalogue. It is
        // not a request for that device, so anything shaped "... for <model>" is reported and
        // never closed.
        if (isAccessoryFor(title, hit[0].model)) {
          hints.push({ issue: it, subject: rawSubject, candidates: [], note: 'reads as an accessory for ' + hit[0].vendor + ' ' + hit[0].model });
        } else {
          matched.push({ issue: it, subject: subject, device: hit[0] });
        }
      } else {
        // No exact match. If the request is written the way a person says it - "Microsoft Xbox",
        // "Amazon Fire TV Stick" - name the catalogue entries that plausibly answer it. Reported
        // only: a hint is a question for a human, not a close.
        const fam = familyCandidates(rawSubject, titleVendor, cat.specs);
        if (fam.length) hints.push({ issue: it, subject: rawSubject, candidates: fam });
      }
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

    // The hint tier. It exists because "nothing to do" was wrong: 139 requests were open while
    // some of them were already answered under a different name. Nothing here is ever closed, and
    // `--close` does not read this list - a hint is a question for a human, not an answer.
    if (hints.length) {
      console.log('');
      console.log('possibly covered, needs a human : ' + hints.length);
      for (const h of hints.slice(0, 40)) {
        const where = h.candidates.length
          ? h.candidates.map(function (c) { return c.vendor + '/' + c.model; }).join(', ')
          : h.note;
        console.log('  #' + String(h.issue.number).padEnd(5) + ' ' + String(h.subject).slice(0, 40).padEnd(41) + '-> ' + where);
      }
      if (hints.length > 40) console.log('  ... and ' + (hints.length - 40) + ' more');
      console.log('  (reported only - --close never touches these)');
    }

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
  module.exports = {
    looksLikePartNumber: looksLikePartNumber,
    looksLikeModelCode: looksLikeModelCode,
    deEntity: deEntity,
    deDash: deDash,
    requestSubject: requestSubject,
    requestCandidates: requestCandidates,
    variantOfSameCode: variantOfSameCode,
    explicitCodes: explicitCodes,
    accessoryTargets: accessoryTargets,
    isAccessoryFor: isAccessoryFor,
    familyCandidates: familyCandidates,
    norm: norm
  };
}
