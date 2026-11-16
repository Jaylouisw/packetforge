#!/usr/bin/env node
/**
 * A suite may not give a server less than a minute to start.
 *
 * Every HTTP suite in this repository spawns `server/index.js` and polls until it answers. The poll is
 * a wall-clock deadline (#1242, #1714), and the number in it used to be sized for one server on an
 * idle machine: six seconds, fifteen, twenty. That is not the machine the suite runs on. At
 * PF_TEST_CONCURRENCY=10 ten suites start a server at the same moment, a cold start costs 3.5-4.8 s
 * measured, and one suite that restarts its server late in its own run spends ~27 s on the file.
 *
 * On 2026-11-16 a 10-way run of `f4e22080` came back 10227 assertions passed, 1 failed - and the
 * failure was not an assertion. `test/board-id-is-a-name.test.js` crashed in its restart half:
 *
 *   test crashed: Error: server did not answer: connect ECONNREFUSED 127.0.0.1:16131 |
 *
 * with nothing in the child's captured output, i.e. the second server had not reached `listen` inside
 * its twenty seconds. The same file had just passed inside the same run, at 26.8 s (#1720).
 *
 * #1715 fixed that class wherever it had already failed. This lint is the part that stops it coming
 * back: a deadline below a minute is not a slow machine being caught, it is a busy one being called
 * broken. The rule is mechanical on purpose - it does not judge the number, only that it is time the
 * machine actually gets.
 */
'use strict';

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function ok(cond, name, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + name); }
  else { failed++; console.error('  \u2717 ' + name + (detail ? '  [' + detail + ']' : '')); }
}
function t(name, fn) {
  console.log('\n' + name);
  if (typeof fn !== 'function') return;
  try { fn(); } catch (e) { failed++; console.error('  \u2717 threw: ' + e.message); }
}

const TEST_DIR = __dirname;
const SELF = 'server-start-deadline.test.js';

// A minute: the bound #1715 chose for the thirteen suites it fixed, and the one this lint holds the
// rest to. A wait that never gives up still fails (the server never answers), just later.
const MIN_MS = 60000;

// `const deadline = Date.now() + 20000;` and every spelling of it in the suite. The literal is what
// regressed; a wait that takes its deadline as a parameter is checked by its callers instead.
const WAIT = /Date\.now\(\)\s*\+\s*(\d+)/g;

function waitsIn(text) {
  const found = [];
  String(text).split('\n').forEach(function (line, i) {
    WAIT.lastIndex = 0;
    let m;
    while ((m = WAIT.exec(line)) !== null) {
      found.push({ line: i + 1, ms: Number(m[1]), text: line.trim() });
    }
  });
  return found;
}

function tooShort(text) {
  return waitsIn(text).filter(function (w) { return w.ms < MIN_MS; });
}

function suite() {
  const files = fs.readdirSync(TEST_DIR)
    .filter(function (f) { return f.endsWith('.test.js') && f !== SELF; })
    .sort();
  const sites = [];
  for (const f of files) {
    for (const w of waitsIn(fs.readFileSync(path.join(TEST_DIR, f), 'utf8'))) {
      sites.push({ file: f, line: w.line, ms: w.ms, text: w.text });
    }
  }
  return { files: files, sites: sites };
}

// ---------------------------------------------------------------------------
t('No suite waits less than a minute for a server to start');

const s = suite();
ok(s.files.length > 50, 'the scan covers the suite (' + s.files.length + ' test files)');
ok(s.sites.length > 20, 'and finds the start waits in it (' + s.sites.length + ' deadlines)');

const short = s.sites.filter(function (w) { return w.ms < MIN_MS; });
for (const w of short) console.error('    \u2717 ' + w.file + ':' + w.line + '  ' + w.ms + ' ms');
ok(short.length === 0,
  'every server start is given at least ' + MIN_MS + ' ms' +
  (short.length ? ' \u2014 ' + short.length + ' shorter, shortest ' + Math.min.apply(null, short.map(function (w) { return w.ms; })) + ' ms' : ''),
  short.map(function (w) { return w.file + ':' + w.ms; }).join(', '));

// ---------------------------------------------------------------------------
t('The lint knows what the shape that failed looks like');

// The two lines are the real ones: the twenty seconds that ran out on 2026-11-16, and the minute that
// replaced it. A lint that stopped recognising the first would pass this suite and catch nothing.
const FAILED = '    const deadline = Date.now() + 20000;';
const FIXED = '    const deadline = Date.now() + 60000;';

ok(tooShort(FAILED).length === 1, 'twenty seconds is flagged', JSON.stringify(tooShort(FAILED)));
ok(tooShort(FIXED).length === 0, 'a minute is not', JSON.stringify(tooShort(FIXED)));
ok(tooShort('const deadline = Date.now() + 400;').length === 1,
  'and so is a deliberately tiny deadline written as a literal (those take it as a parameter instead)');
ok(waitsIn('x = Date.now() + 60000 // not a declaration either').length === 1,
  'a wait written anywhere on the line is still a wait');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
