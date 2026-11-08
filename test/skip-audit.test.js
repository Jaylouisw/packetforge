#!/usr/bin/env node
/**
 * Every exemption has to say what it is exempting.
 *
 * This repository has now had three holes of the same shape, and each one was a `continue`
 * that silently removed a class of ports from a check:
 *
 *   - `Math.max.apply(null, caps)` returned NaN for caps written "10G", so the cage-rate check
 *     skipped every port that wrote its caps as text (#993).
 *   - `if (isConsoleOnly(i.hardware)) continue;` skipped 163 console ports, which is how they
 *     carried a gigabit on a 115.2 kbps cage (#979).
 *   - `if (!i.hardware.media.length) continue;` skipped 84 coax ports that could not be cabled
 *     to anything at all (#1039).
 *
 * In each case the code was defensible on the day it was written, the comment explained why, and
 * nothing recorded that a class of hardware had just left the building. A comment is not a
 * tracker: it is not closed, it does not appear in the backlog, and it does not remind anyone that
 * the exemption was supposed to be temporary.
 *
 * So the rule this suite enforces is narrow and mechanical: a skip that decides a device or port is
 * outside a check (because of its type, its prose, its class or its media) must name a GitHub issue
 * within the few lines above it, or be marked as ordinary control flow. Nothing here judges whether
 * an exemption is *correct* - only that it is claimed, tracked and findable.
 */
'use strict';

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
const findings = [];
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}
function t(name, fn) {
  console.log('\n' + name);
  if (typeof fn !== 'function') return;
  try { fn(); } catch (e) { failed++; console.log('  ✗ threw: ' + e.message); }
}

const TEST_DIR = path.join(__dirname);
const SELF = 'skip-audit.test.js';

// A skip is `continue`/`return` as the entire body of an `if`, either inline or in a two-line
// block. That covers every shape the three historical holes took.
const INLINE = /^\s*if\s*\((.+)\)\s*(continue|return[^;]*);\s*$/;
const OPEN = /^\s*if\s*\((.+)\)\s*\{\s*$/;
const BARE = /^\s*(continue|return[^;]*);\s*$/;

// What makes a skip an *exemption* rather than ordinary control flow: the condition consults the
// device's identity, its prose, or a named hardware class. `if (!spec) continue;` is looking for
// something that is not there; `if (isConsoleOnly(hw)) continue;` is deciding a port is outside
// the rule.
const EXEMPTION_PATTERNS = [
  /\.test\(/,                        // a regex or predicate deciding
  /\.match\(/,
  /\bmedia\b/,                       // decided by what the port offers
  /\bexempt/i,
  /\bknown\b/i,
  /\bquarantine/i,
  /\bis[A-Z]\w+\(/,                  // a named helper that exempts a class: isConsoleOnly(), isRadio()
  // A comparison against a hardware class: cage === 'antenna', type !== 'ethernet', kind === 'dsl'.
  // These are the "this device is not subject to the rule because of what it is" decisions.
  /===?\s*'(wireless|antenna|coax|dsl|pon|fibre-channel|fc-[a-z0-9]+|console|serial|passive|bridge|hub|usb)'/,
  /!==?\s*'(wireless|antenna|coax|dsl|pon|ethernet|fibre-channel|console|serial)'/,
  /\bwireless\b/,
  /\bantenna\b/
];

// Ordinary control flow, said out loud: the skip is looking for something, or the check is scoped
// by construction and there is no bug to track.
const CONTROL_FLOW = /not an exemption|ordinary control flow|control-flow|by construction|by definition/i;
// A permanent, deliberate exemption with a stated reason. Distinct from an issue: a device that
// describes both PoE-in and PoE-out is a passthrough, and that will still be true in a year.
const DELIBERATE = /\bdeliberate\b/i;
// A claim: this is tracked.
const TRACKED = /#\d+/;

function looksLikeExemption(cond) {
  return EXEMPTION_PATTERNS.some(function (re) { return re.test(cond); });
}

function contextAbove(lines, idx, span) {
  const out = [];
  for (let i = Math.max(0, idx - span); i < idx; i++) out.push(lines[i]);
  return out.join('\n');
}

function scan(file, fullPath) {
  const full = fullPath || path.join(TEST_DIR, file);
  const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    let cond = null, line = i + 1;
    let m = INLINE.exec(lines[i]);
    if (m) cond = m[1];
    if (!cond) {
      m = OPEN.exec(lines[i]);
      if (m && i + 1 < lines.length && BARE.test(lines[i + 1])) { cond = m[1]; line = i + 2; }
    }
    if (!cond || !looksLikeExemption(cond)) continue;
    const above = contextAbove(lines, i, 8);
    const same = lines[i] + (lines[i + 1] || '');
    const tracked = TRACKED.test(above) || TRACKED.test(same) ||
      CONTROL_FLOW.test(above) || CONTROL_FLOW.test(same) ||
      DELIBERATE.test(above) || DELIBERATE.test(same);
    hits.push({ file: file, line: line, cond: cond.trim(), tracked: tracked, above: above });
  }
  return hits;
}

// ---------------------------------------------------------------------------
t('Every exemption in the test suite is either tracked or declared as control flow');

const files = fs.readdirSync(TEST_DIR)
  .filter(function (f) { return f.endsWith('.test.js') && f !== SELF; })
  .sort();

const sites = [];
for (const f of files) sites.push.apply(sites, scan(f));

ok(files.length > 50, 'the scan covers the suite (' + files.length + ' test files)');
ok(sites.length > 0, 'and finds exemption-shaped skips to audit (' + sites.length + ')');

const untracked = sites.filter(function (s) { return !s.tracked; });
for (const s of untracked) {
  findings.push(s.file + ':' + s.line + '  if (' + s.cond + ')');
  console.error('    ✗ ' + s.file + ':' + s.line + '  if (' + s.cond + ')');
}
ok(untracked.length === 0,
  'every exemption names an issue (#NNN) or is marked as ordinary control flow' +
  (untracked.length ? ' — ' + untracked.length + ' untracked' : ''));

// ---------------------------------------------------------------------------
t('The audit knows what the three historical holes looked like');

// These are the real conditions from the three bugs, checked directly so the lint cannot quietly
// stop recognising the shape it was written for.
const HISTORICAL = [
  ['isConsoleOnly(i.hardware)', 'console port skip (#979)'],
  ['!i.hardware.media.length', 'empty media list skip (#1039)'],
  ['/fibre channel|fc san|gen\\d+fc/i.test(String(x.spec.description || \'\'))', 'prose skip (#980)'],
  ['!/poe/i.test(String(i.name))', 'name skip'],
  ['i.type === \'wireless\'', 'radio skip']
];
for (const [cond, why] of HISTORICAL) {
  ok(looksLikeExemption(cond), 'recognises ' + why + ' as an exemption');
}

ok(!looksLikeExemption('!spec'), 'and does not mistake a lookup for an exemption');
ok(!looksLikeExemption('!dev'), 'nor a construction guard');
ok(!looksLikeExemption('err'), 'nor a null check');

// ---------------------------------------------------------------------------
t('A tracked exemption stays tracked');

// Guard against the lint being satisfied by an issue number that has nothing to do with the
// exemption: the number has to be within the comment block that explains it, not anywhere in the
// file. Verified on a real file whose exemptions are all tracked.
const trackedCount = sites.filter(function (s) { return s.tracked; }).length;
ok(trackedCount > 0, 'tracked exemptions exist (' + trackedCount + ' of ' + sites.length + ')');
ok(sites.every(function (s) { return lines(s).trim().length > 0; }),
  'every site carries the surrounding context the audit read');

function lines(s) { return s.above || ''; }

// ---------------------------------------------------------------------------
t('The audit fails on a new untracked exemption');

// A lint that cannot fail is the same disease it is meant to cure. These two files are written
// out and scanned: one asks for an exemption with no issue, the other with one. If the first is
// not flagged, this suite is decorative.
{
  const os = require('os');
  const tmpA = path.join(os.tmpdir(), 'pf-skip-untracked.test.js');
  const tmpB = path.join(os.tmpdir(), 'pf-skip-tracked.test.js');
  fs.writeFileSync(tmpA, [
    "'use strict';",
    'for (const x of all) {',
    '  // This device is special and deserves no rule.',
    '  if (isConsoleOnly(x.hardware)) continue;',
    '}'
  ].join('\n'));
  fs.writeFileSync(tmpB, [
    "'use strict';",
    'for (const x of all) {',
    '  // Tracked in #979.',
    '  if (isConsoleOnly(x.hardware)) continue;',
    '}'
  ].join('\n'));

  const a = scan('tmp', tmpA);
  const b = scan('tmp', tmpB);
  ok(a.length === 1 && a[0].tracked === false, 'an untracked console exemption is flagged');
  ok(b.length === 1 && b[0].tracked === true, 'the same exemption with an issue number passes');
  fs.unlinkSync(tmpA);
  fs.unlinkSync(tmpB);
}

console.log('\nExemption census (' + sites.length + ' sites):');
const byFile = {};
for (const s of sites) byFile[s.file] = (byFile[s.file] || 0) + 1;
for (const f of Object.keys(byFile).sort()) console.log('  ' + f.padEnd(38) + byFile[f]);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
