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
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { check } = require('../scripts/check-canonical-urls');
const canonical = require('../scripts/canonical');

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  \u2713 ' + name); }
  else { failed++; console.log('  \u2717 ' + name); }
}

const ROOT = path.join(__dirname, '..');

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
  ok(check().ok, 'and the tree is clean again once the probe is removed');
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
  const readme = path.join(ROOT, 'README.md');
  const original = fs.readFileSync(readme, 'utf8');
  try {
    // The most-followed line in the project: remove it and the guard must notice, even though
    // nothing else about the file is wrong.
    fs.writeFileSync(readme, original.split(canonical.clone()).join('https://example.invalid/repo'));
    const res = check();
    ok(!res.ok, 'the check fails when README cannot be cloned from');
    ok(res.problems.some(function (p) { return p.code === 'E_NO_CANONICAL_CLONE'; }),
      'with E_NO_CANONICAL_CLONE');
  } finally {
    fs.writeFileSync(readme, original);
  }
  ok(check().ok, 'and the README is restored');
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
  // The two files that must never be allowed to advertise GitHub as the place to work.
  ok(!Object.prototype.hasOwnProperty.call(canonical.ALLOW, 'README.md'),
    'README is not exempt - it is the file everyone follows');
  ok(!Object.prototype.hasOwnProperty.call(canonical.ALLOW, 'CONTRIBUTING.md'),
    'CONTRIBUTING is not exempt - it is where contributors are told what to do');
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

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
