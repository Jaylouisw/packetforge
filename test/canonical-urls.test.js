#!/usr/bin/env node
/**
 * The canonical-URL guard has to be able to fail.
 *
 * `scripts/check-canonical-urls.js` exists because the project moved to Forgejo and the links did
 * not follow: the README said to clone from GitHub, the hardware-request button opened a GitHub
 * issue form, and SECURITY.md sent vulnerability reports to a GitHub advisory page. Nothing failed
 * when that happened, because a stale URL is invisible to every other test.
 *
 * A guard nobody has seen fail is a guard that might be checking nothing - this repo has been bitten
 * by exactly that (a cage invariant comparing a port to itself, which could never fail). So this
 * plants real drift in the working tree, asserts the checker catches it, and cleans up.
 *
 * "Cleans up" is the part that had to be rebuilt; see the block below the requires.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { check } = require('../scripts/check-canonical-urls');
// The extension is mandatory: CommonJS resolves '', '.js', '.json', '.node' - never '.ts' -
// so a converted sibling is loaded by spelling it.
const canonical = require('../scripts/canonical.ts');

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  \u2713 ' + name); }
  else { failed++; console.log('  \u2717 ' + name); }
}

const ROOT = path.join(__dirname, '..');
const rel = function (p) { return path.relative(ROOT, p).replace(/\\/g, '/'); };

// ===========================================================================================
// Putting the README back - the half of this suite that used to be a hope
//
// Every probe below writes drift into README.md and then removes it. That cleanup used to be the
// last statement of a `try` block, which is fine right up until the run is interrupted - a killed
// process, a timed-out terminal, a ctrl-C - because then the last statement is one that never runs.
// A tree left with `M README.md` made the NEXT suite run report six failures that were one dirty
// file: three tool calls and one wrong diagnosis, before `git checkout -- .` turned 6 failures into
// 52 passed. The runner now refuses to start on a dirty tree, so the next run cannot be lied to;
// this is the other half - the suite cannot leave the tree dirty in the first place, and says so
// when it fails to put it back.
//
// Restoration here is therefore not a statement after the probe, it is a property of touching the
// file:
//
//   * the original bytes are read once, at start, and restored from memory - never re-read, because
//     a re-read of a file the probe already overwrote is not the original;
//   * every mutation goes through `withReadme`, whose `finally` restores whatever the probe did,
//     including throwing;
//   * before README.md is touched, the original bytes are also written to a marker file, so an
//     interruption this process cannot catch (SIGKILL, TerminateProcess, the machine going away)
//     still leaves the truth on disk for the next run, which heals from it and says one line. That
//     is not a hypothetical: `scripts/run-tests.js` SIGKILLs a suite that overruns its 300 s budget,
//     and this suite's `check()` calls make it a slow one;
//   * SIGINT/SIGTERM/SIGHUP, uncaughtException, unhandledRejection and plain `exit` all restore
//     before the process goes;
//   * and the last section of this file compares README.md with the bytes it captured, so a restore
//     that did not happen is a failure here, named, instead of six failures in another suite.
// ===========================================================================================

const README_REL = 'README.md';
const README = path.join(ROOT, README_REL);

// The durable copy lives under tmp/, which .gitignore already covers, so a marker that outlives a
// killed run cannot itself make the worktree dirty: it is the notice, not the defect. Its extension
// is not one `check-canonical-urls` scans, so a marker sitting in the tree cannot be read as
// documentation drift either - the guard must not fail on its own first-aid kit.
const STATE_DIR = path.join(ROOT, 'tmp', 'canonical-urls-restore');
const MARKER = path.join(STATE_DIR, 'README.md.restore');
const MARKER_VERSION = 1;

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// One file, one write: a header line carrying the length and checksum, then the bytes themselves.
// The header is what lets the next run refuse a marker that was itself half-written - healing from a
// truncated copy would be a second dirtying, not a repair.
function encodeMarker(bytes) {
  const head = JSON.stringify({
    v: MARKER_VERSION, target: README_REL, bytes: bytes.length,
    sha256: sha256(bytes), pid: process.pid, at: new Date().toISOString()
  });
  return Buffer.concat([Buffer.from(head + '\n', 'utf8'), bytes]);
}

function decodeMarker(raw) {
  const nl = raw.indexOf(0x0a);
  if (nl === -1) return null;
  let head;
  try { head = JSON.parse(raw.slice(0, nl).toString('utf8')); } catch (e) { return null; }
  const body = raw.slice(nl + 1);
  if (!head || head.v !== MARKER_VERSION || head.target !== README_REL) return null;
  if (head.bytes !== body.length) return null;
  if (head.sha256 !== sha256(body)) return null;
  return { head: head, bytes: body };
}

function writeMarker(bytes) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(MARKER, encodeMarker(bytes));
}

function clearMarker() {
  try { fs.unlinkSync(MARKER); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

// Runs before the original bytes are captured, so what this process considers "the original" is
// always a file that has already been healed if the last run left it dirty.
function selfHeal() {
  let raw;
  try {
    raw = fs.readFileSync(MARKER);
  } catch (e) {
    if (e.code === 'ENOENT') return { healed: false, reason: 'no-marker', line: null };
    return {
      healed: false, reason: 'unreadable',
      line: '  [heal] ' + rel(MARKER) + ' exists but could not be read (' + e.message + ')'
    };
  }
  const marker = decodeMarker(raw);
  if (!marker) {
    clearMarker();
    const line = '  [heal] ' + rel(MARKER) + ' was not a usable restore marker (bad header or ' +
      'checksum); discarded rather than written into ' + README_REL;
    console.log(line);
    return { healed: false, reason: 'unusable', line: line };
  }
  let current = null;
  try { current = fs.readFileSync(README); } catch (e) { current = null; }
  if (current && current.equals(marker.bytes)) {
    // The marker outlived a run that did restore - the process died on its way out, not mid-probe.
    clearMarker();
    return { healed: false, reason: 'already-clean', line: null };
  }
  fs.writeFileSync(README, marker.bytes);
  clearMarker();
  const line = '  [heal] ' + README_REL + ' was left modified by an interrupted run (pid ' +
    marker.head.pid + ', ' + marker.head.at + '); restored ' + marker.bytes.length +
    ' bytes from ' + rel(MARKER);
  console.log(line);
  return { healed: true, reason: 'healed', line: line };
}

const healOnStart = selfHeal();
// Captured once. Every restore below writes this, so "restored" cannot come to mean "whatever was
// on disk when the probe finished", which is how a second corruption hides a first.
const ORIGINAL = fs.readFileSync(README);
// True only while a mutation is on disk: it is what the exit hook and the signal handlers read to
// know there is something to put back.
let pending = false;

function beginMutation(mutated) {
  // The marker goes down first. Between this write and the restore is the window a killed process
  // can die in, and this is what the next run reads to climb back out of it. A marker we cannot
  // write (a read-only checkout) must not stop the probe - `withReadme`'s finally is still what
  // guarantees the restore in-process - but it is worth one line, because then a hard kill would
  // be unrecoverable.
  try { writeMarker(ORIGINAL); } catch (e) {
    console.log('      note: could not write the restore marker (' + e.message + ')');
  }
  pending = true;
  fs.writeFileSync(README, mutated);
}

function endMutation() {
  fs.writeFileSync(README, ORIGINAL);  // from the captured bytes, never a re-read
  clearMarker();                      // only after the file is back: a failed restore keeps the marker
  pending = false;
}

function withReadme(mutated, body) {
  beginMutation(mutated);
  try {
    return body();
  } finally {
    endMutation();
  }
}

// The single body of the interruption path: signals, uncaught throws, unhandled rejections, the exit
// hook and the test below all come through here, so what a ctrl-C does is proved by assertion rather
// than assumed from the fact that a handler was registered.
function salvage(reason) {
  if (!pending) return null;
  try {
    endMutation();
  } catch (e) {
    return {
      ok: false, reason: reason,
      line: '[restore] ' + reason + ' - ' + README_REL + ' could not be rewritten (' + e.message +
        '); ' + rel(MARKER) + ' still holds the original bytes for the next run'
    };
  }
  return {
    ok: true, reason: reason,
    line: '[restore] ' + reason + ' - ' + README_REL + ' put back from the bytes captured at ' +
      'start (' + ORIGINAL.length + ' bytes)'
  };
}

// A signal a process can catch. A hard kill is the case no handler sees, which is what the marker is
// for - so both halves exist, and neither is claimed to cover the other.
['SIGINT', 'SIGTERM', 'SIGHUP'].forEach(function (sig) {
  process.on(sig, function () {
    const r = salvage(sig);
    fs.writeSync(1, '  ' + (r ? r.line : '[restore] ' + sig + ' - no mutation was open') + '\n');
    process.exit(r && r.ok ? 130 : 1);
  });
});
function unexpected(what, err) {
  const r = salvage(what);
  fs.writeSync(2, '  ' + (r ? r.line : '[restore] ' + what + ' - no mutation was open') + '\n');
  fs.writeSync(2, '  ' + what + ': ' + (err && err.stack ? err.stack : String(err)) + '\n');
  process.exit(1);
}
process.on('uncaughtException', function (err) { unexpected('uncaught exception', err); });
process.on('unhandledRejection', function (err) { unexpected('unhandled rejection', err); });
// The fallback of the fallback, for any exit path that is not one of the above: the handler for
// `exit` cannot be skipped by a throw, and sync fs writes are still allowed inside it.
process.on('exit', function (code) {
  if (!pending) return;
  try {
    endMutation();
    fs.writeSync(1, '  [restore] exit(' + code + ') with a mutation still open - ' + README_REL +
      ' put back\n');
  } catch (e) {
    fs.writeSync(2, '  [restore] exit(' + code + ') could not put ' + README_REL + ' back (' +
      e.message + '); ' + rel(MARKER) + ' holds the original bytes for the next run\n');
  }
});

// A post-probe assertion may only claim what its own probe could have caused. `check()` answers for
// the whole tree, so asking it `ok()` after a probe was removed turns a stale URL in some unrelated
// file into "the probe left residue" - a failure that names the wrong cause and costs a triage.
// These two scope the claim to the thing the probe actually touched. The whole-tree guard is the
// one at the top of this file, which is where a stray URL should be reported: once, with its file.
function problemsFor(rel) {
  return check().problems.filter(function (p) { return p.file === rel; });
}
function problemsWithCode(code) {
  return check().problems.filter(function (p) { return p.code === code; });
}

console.log('\nThe canonical home is defined in exactly one place');
{
  ok(/^https:\/\//.test(canonical.BASE), 'the base is an absolute URL');
  ok(canonical.BASE.indexOf(canonical.OWNER) !== -1, 'and names the owner');
  ok(canonical.BASE.indexOf(canonical.NAME) !== -1, 'and the repository');
  ok(canonical.FORBIDDEN.length > 0, 'the old location is recorded as forbidden');
  ok(canonical.clone() === canonical.BASE + '.git', 'clone() appends .git');
  ok(canonical.source('docs/CLI.md') === canonical.BASE + '/src/branch/main/docs/CLI.md',
    'source() uses the branch path form, not GitHub\'s /blob/');
  ok(canonical.issue('device_request.yml') === canonical.BASE + '/issues/new?template=device_request.yml',
    'issue() builds a template URL');
  ok(canonical.badge('ci.yml').indexOf('/badges/workflows/ci.yml/badge.svg') !== -1,
    'badge() uses the workflow badge path');
}

console.log('\nThe repository is clean right now');
{
  const res = check();
  ok(res.ok, 'no file points at the old repository (' + res.problems.length + ' problems)');
  if (!res.ok) {
    for (const p of res.problems) console.log('      ' + p.file + ' ' + p.code + ' — ' + p.detail);
  }
  ok(res.scanned > 100, 'and the scan actually looked at files (' + res.scanned + ')');
}

console.log('\nA stale URL outside the probe paths is reported once, and blames only itself');
{
  // The probes below plant a file, delete it, and then ask whether the tree recovered. That question
  // has to be answered about the tree, not about the probes - so this pins the property those
  // assertions rely on: one stale URL is one problem, in the file it is actually in, and it does not
  // get attributed to a probe that was never on disk. Before this, one such URL made three
  // post-probe assertions fail and each named the wrong cause.
  const stray = path.join(ROOT, 'docs', '__stray_stale.md');
  try {
    fs.writeFileSync(stray, 'Clone from https://github.com/Jaylouisw/packetforge.git instead.\n');
    const res = check();
    // Counted against the planted file, not the tree: this assertion must hold whether or not some
    // other file is also stale, for the same reason the probes' cleanup checks do.
    const mine = res.problems.filter(function (p) { return p.file === 'docs/__stray_stale.md'; });
    ok(mine.length === 1, 'one stale URL is one problem, not one per assertion that looks (' +
      mine.length + ')');
    ok(mine.length === 1 && mine[0].code === 'E_STALE_REPO_URL' && mine[0].line === 1,
      'and it is reported against the file and the line it is written on');
    ok(res.problems.every(function (p) {
      return p.file !== 'docs/__drift_probe.md' && p.file !== 'docs/__tooling_probe.md';
    }), 'and no report is filed against a probe that is not on disk');
  } finally {
    try { fs.unlinkSync(stray); } catch (e) { /* nothing to clean */ }
  }
  ok(problemsFor('docs/__stray_stale.md').length === 0,
    'and the stray file leaves no trace in the report once it is removed');
}

console.log('\nIt catches a stale repository URL');
{
  const probe = path.join(ROOT, 'docs', '__drift_probe.md');
  try {
    fs.writeFileSync(probe, 'Clone from https://github.com/Jaylouisw/packetforge.git and be happy.\n');
    const res = check();
    ok(!res.ok, 'the check fails on a planted GitHub URL');
    const hit = res.problems.filter(function (p) {
      return p.file === 'docs/__drift_probe.md' && p.code === 'E_STALE_REPO_URL';
    });
    ok(hit.length === 1, 'and names the file and the code');
    ok(hit.length === 1 && hit[0].line === 1, 'with the line number');
  } finally {
    try { fs.unlinkSync(probe); } catch (e) { /* nothing to clean */ }
  }
  const residue = problemsFor('docs/__drift_probe.md');
  ok(residue.length === 0, 'and nothing is reported for the probe once it is removed');
  ok(!fs.existsSync(probe), 'and the probe file is gone from disk');
}

console.log('\nIt catches GitHub-only tooling instructions');
{
  const probe = path.join(ROOT, 'docs', '__tooling_probe.md');
  try {
    fs.writeFileSync(probe, 'If this fails: gh auth status\n');
    const res = check();
    ok(!res.ok, 'the check fails on a `gh` instruction');
    const hit = res.problems.filter(function (p) {
      return p.file === 'docs/__tooling_probe.md' && p.code === 'E_GITHUB_ONLY_TOOLING';
    });
    ok(hit.length === 1, 'naming the GitHub-only tooling');
  } finally {
    try { fs.unlinkSync(probe); } catch (e) { /* nothing to clean */ }
  }
}

console.log('\nIt catches a README that lost the canonical clone URL');
{
  // The most-followed line in the project: remove it and the guard must notice, even though nothing
  // else about the file is wrong.
  const withoutClone = ORIGINAL.toString('utf8')
    .split(canonical.clone()).join('https://example.invalid/repo');
  withReadme(Buffer.from(withoutClone, 'utf8'), function () {
    const res = check();
    ok(!res.ok, 'the check fails when README cannot be cloned from');
    ok(res.problems.some(function (p) { return p.code === 'E_NO_CANONICAL_CLONE'; }),
      'with E_NO_CANONICAL_CLONE');
  });
  const residue = problemsWithCode('E_NO_CANONICAL_CLONE');
  ok(residue.length === 0, 'and no E_NO_CANONICAL_CLONE problem remains');
  ok(fs.readFileSync(README).equals(ORIGINAL), 'and the README is back byte for byte');
  ok(!fs.existsSync(MARKER), 'and the probe took its restore marker with it');
}

console.log('\nEvery exception says why');
{
  const entries = Object.keys(canonical.ALLOW);
  ok(entries.length > 0, 'there are reasoned exceptions (' + entries.length + ')');
  for (const rel of entries) {
    ok(typeof canonical.ALLOW[rel] === 'string' && canonical.ALLOW[rel].length > 20,
      rel + ' has a reason a reader can judge');
    ok(fs.existsSync(path.join(ROOT, rel)), rel + ' exists');
  }
  // README must never be allowed to advertise GitHub as the place to work: it is the file everyone
  // follows, and it is where a stale clone instruction does the most damage.
  ok(!Object.prototype.hasOwnProperty.call(canonical.ALLOW, 'README.md'),
    'README is not exempt - it is the file everyone follows');

  // CONTRIBUTING is different now, and the difference is deliberate rather than convenient:
  // contributions arrive through the GitHub mirror, so this file has to be able to name it. What must
  // stay true is that it still sends people to the forge to read and to clone, and that the exemption
  // says why rather than being a silent skip.
  ok(Object.prototype.hasOwnProperty.call(canonical.ALLOW, 'CONTRIBUTING.md'),
    'CONTRIBUTING may name the mirror, and the exemption is reasoned');
  ok(/github/i.test(canonical.ALLOW['CONTRIBUTING.md'] || ''),
    'and the reason says GitHub means the shopfront, not the workshop');
  const contributing = fs.readFileSync(path.join(ROOT, 'CONTRIBUTING.md'), 'utf8');
  ok(contributing.indexOf(canonical.BASE) !== -1,
    'CONTRIBUTING still points at the forge as the canonical home');
  ok(/mirror/i.test(contributing),
    'and calls GitHub what it is: the mirror, not a second source of truth');
}

console.log('\nThe changelog keeps its history');
{
  // Rewriting a changelog to pretend the move never happened would be a worse lie than a stale
  // link in a historical entry, so CHANGELOG.md is exempt - deliberately, and visibly.
  ok(canonical.EXEMPT_FILES.has('CHANGELOG.md'), 'CHANGELOG.md is exempt from the URL rule');
  const text = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  ok(text.indexOf('github.com') !== -1 || text.indexOf('GitHub') !== -1,
    'and it still records what happened on GitHub');
}

console.log('\nThe triage scripts do not depend on the GitHub CLI');
{
  for (const rel of ['scripts/request-queue.js', 'scripts/missing-devices.js']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    ok(!/execFileSync\(\s*['"]gh['"]/.test(src), rel + ' does not shell out to gh');
    ok(src.indexOf("require('./forgejo-api')") !== -1, rel + ' uses the Forgejo client');
  }
  const api = fs.readFileSync(path.join(ROOT, 'scripts/forgejo-api.js'), 'utf8');
  ok(/type', 'issues'/.test(api) || /params.set\('type', 'issues'\)/.test(api),
    'the client excludes pull requests from the issue queue (they share a number space)');
  ok(api.indexOf('token ' + "' + token" + "'") !== -1 || api.indexOf('Authorization') !== -1,
    'and authenticates');
}

console.log('\nA badge for a workflow that does not exist is caught');
{
  // Forgejo draws a workflow badge it cannot find as `failure` in crimson, forever. The README
  // carried one for codeql.yml - a workflow deleted with the move off GitHub - so the front page
  // told every visitor the build was broken while the build was green. A link to a file that is not
  // there is the same defect this checker exists for, so the checker has to be able to catch it.
  const original = ORIGINAL.toString('utf8');
  // Built by concatenation on purpose: a contiguous literal here would be a real dead badge link
  // inside this test file, and the checker scans .js too - it would fail the tree it is testing.
  const wfPath = 'actions/' + 'workflows/' + ('codeql' + '.yml');
  const planted = original.replace('[![License: MIT]',
    '[![CodeQL](' + canonical.BASE + '/' + wfPath + '/badge.svg)]\n[![License: MIT]');
  ok(planted !== original, 'the probe actually changed the README');
  withReadme(Buffer.from(planted, 'utf8'), function () {
    const res = check();
    const hit = res.problems.filter(p => p.code === 'E_BADGE_NO_WORKFLOW');
    ok(hit.length === 1, 'the checker reports the dead badge', JSON.stringify(hit.map(h => h.detail)));
    ok(hit.length === 1 && hit[0].file === 'README.md', 'and names the file to fix');
    ok(hit.length === 1 && /codeql\.yml/.test(hit[0].detail), 'and names the workflow');
    ok(res.ok === false, 'so the tree is not called clean with a dead badge in it');
  });
  const residue = problemsWithCode('E_BADGE_NO_WORKFLOW');
  ok(residue.length === 0, 'and no E_BADGE_NO_WORKFLOW problem remains');
  ok(fs.readFileSync(README).equals(ORIGINAL), 'and the README is restored byte for byte');
  ok(!fs.existsSync(path.join(ROOT, '.forgejo', 'workflows', 'codeql.yml')),
    'this repository genuinely has no codeql.yml, so the badge pointed at nothing');
  ok(fs.existsSync(path.join(ROOT, '.forgejo', 'workflows', 'ci.yml')),
    'and it does have the ci.yml workflow the remaining badge names');
}

console.log('\nA check that throws mid-probe still puts the README back');
{
  // The old cleanup was the last statement of a `try`, so anything that skipped it skipped the
  // restore. A throw is the interruption this suite can create on demand: begin the mutation, fail
  // inside it, and the file still has to come back - from the bytes captured at start, not from a
  // re-read of the file the probe has already overwritten.
  const dirty = Buffer.from('# README, mid-probe, about to fail\n', 'utf8');
  let inside = null, thrown = null;
  try {
    withReadme(dirty, function () {
      inside = fs.readFileSync(README);
      throw new Error('the probe blew up half way');
    });
  } catch (e) { thrown = e; }
  ok(inside !== null && inside.equals(dirty), 'the probe really had the README modified when it threw');
  ok(thrown !== null && /blew up/.test(thrown.message),
    'and the error still reaches the caller - the finally does not swallow the failure');
  ok(fs.readFileSync(README).equals(ORIGINAL), 'and the throw still restored the captured bytes');
  ok(!fs.existsSync(MARKER), 'and cleared the marker, so nothing is left for the next run to heal');
}

console.log('\nA run killed mid-probe is healed by the next run');
{
  const onDisk = Buffer.from('# README as a killed run left it\n', 'utf8');
  try {
    // The one interruption no handler sees: the bytes are on disk, the process is gone, and nothing
    // in this file runs again. Simulated by opening the mutation and then dropping it - no finally,
    // exactly like a SIGKILL - so what is left is the state the next run would actually find.
    beginMutation(onDisk);
    pending = false;  // the process is gone; no finally and no exit hook will run
    ok(fs.existsSync(MARKER),
      'a killed run leaves a marker behind, not just a dirty README (' + rel(MARKER) + ')');
    ok(fs.readFileSync(README).equals(onDisk), 'and the README it left in the tree is the dirty one');
    const healed = selfHeal();
    ok(healed.healed === true, 'so the next run heals from the marker (' + healed.reason + ')');
    ok(healed.line !== null && /interrupted/.test(healed.line) &&
      healed.line.indexOf(README_REL) !== -1, 'and says so in one line: ' + healed.line);
    ok(fs.readFileSync(README).equals(ORIGINAL),
      'restoring the bytes captured before the killed run, not the half-written file');
    ok(!fs.existsSync(MARKER), 'and consuming the marker, so the heal happens exactly once');
    const again = selfHeal();
    ok(again.healed === false && again.reason === 'no-marker',
      'a second run finds nothing to heal (' + again.reason + ')');
  } finally {
    pending = false;
    try { endMutation(); } catch (e) { /* the file is already back */ }
  }
}

console.log('\nA marker that cannot be trusted is thrown away, not written into the README');
{
  try {
    // A marker is a file written by a process that was then killed, so the realistic corruption is
    // a truncated one: killed between the header and the body. Healing from that would be a second
    // dirtying dressed up as a repair, so the checksum in the header is the gate.
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(MARKER, encodeMarker(ORIGINAL).slice(0, 40));
    const cut = selfHeal();
    ok(cut.healed === false, 'a half-written marker heals nothing (' + cut.reason + ')');
    fs.writeFileSync(MARKER, 'this is not a restore marker at all\n');
    const bad = selfHeal();
    ok(bad.healed === false && bad.reason === 'unusable',
      'and a marker that fails its own header check is not used (' + bad.reason + ')');
    ok(fs.readFileSync(README).equals(ORIGINAL), 'and the README is left alone rather than written from it');
    ok(!fs.existsSync(MARKER), 'and the bad marker is removed so it cannot fail every run from here on');
  } finally {
    try { clearMarker(); } catch (e) { /* nothing left */ }
  }
}

console.log('\nThe interruption hooks restore, and this file proves it rather than assuming it');
{
  ok(process.listenerCount('SIGINT') > 0, 'SIGINT is handled, so a ctrl-C restores before dying');
  ok(process.listenerCount('SIGTERM') > 0, 'SIGTERM is handled, so CI\'s timeout --signal=TERM restores');
  ok(process.listenerCount('uncaughtException') > 0, 'an uncaught exception is handled');
  ok(process.listenerCount('exit') > 0, 'and plain exit is handled, which every other path goes through');
  ok(healOnStart.healed === false && healOnStart.reason === 'no-marker',
    'and this run started on a tree no earlier run left dirty (' + healOnStart.reason + ')');
  // What a handler runs, run in the state a handler would find it in. No real signal is sent: on
  // Windows a kill is TerminateProcess and no handler runs at all, so a test that sent one would
  // prove the platform rather than this file.
  try {
    beginMutation(Buffer.from('# dirty at the moment the signal arrives\n', 'utf8'));
    const r = salvage('simulated SIGINT');
    ok(r !== null && r.ok === true, 'a signal arriving mid-mutation restores the README');
    ok(fs.readFileSync(README).equals(ORIGINAL), 'from the bytes captured at start');
    ok(!pending && !fs.existsSync(MARKER),
      'and clears the marker in the same breath, so the next run has nothing to heal');
    ok(r !== null && /SIGINT/.test(r.line), 'and names what stopped it: ' + (r ? r.line : 'nothing'));
    ok(salvage('simulated SIGINT') === null, 'and a signal with nothing open writes nothing at all');
  } finally {
    pending = false;
    try { endMutation(); } catch (e) { /* the file is already back */ }
  }
}

console.log('\nThis run leaves the tree exactly as it found it');
{
  // The invariant, asserted here instead of hoped for: if the restore above did not happen, this is
  // one named failure in the suite that caused it, not six failures in the next suite that runs.
  const after = fs.readFileSync(README);
  ok(after.equals(ORIGINAL),
    'README.md is byte for byte the file this run started with (' + after.length + ' bytes)');
  ok(!pending, 'no mutation is left open');
  ok(!fs.existsSync(MARKER), 'and no restore marker is left behind for the next run to heal');
  // The claim that matters to the rest of the repo is not "this suite thinks it tidied up" but "git
  // agrees the file is untouched": the runner refuses to start on a dirty tree, so a leftover here
  // would stop the next run saying anything at all.
  const st = spawnSync('git', ['status', '--porcelain', '--', README_REL], {
    cwd: ROOT, encoding: 'utf8'
  });
  if (st.error || st.status !== 0) {
    console.log('      note: git status was not available (' +
      (st.error ? st.error.message : 'exit ' + st.status) + '), so the worktree-level claim was not made');
  } else {
    ok(st.stdout.trim() === '',
      'and git agrees README.md is unmodified' + (st.stdout.trim() ? ' (it says: ' + st.stdout.trim() + ')' : ''));
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
