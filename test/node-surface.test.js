#!/usr/bin/env node
/**
 * The local interpreter is not the CI floor.
 *
 * CI runs the suite on Node 18, 20 and 22. A dev machine on a newer Node can use an API the oldest
 * job cannot run, watch a green suite, and push a commit that fails twenty minutes later on a job
 * whose failure reads like a flaky runner. This suite runs the static guard, and proves the guard
 * can fail by pointing it at a file that uses a post-18 API.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}
function t(name, fn) {
  console.log('\n' + name);
  if (typeof fn !== 'function') return;
  try { fn(); } catch (e) { failed++; console.log('  ✗ threw: ' + e.message); }
}

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'check-node-surface.js');

function run(args) {
  try {
    const out = execFileSync(process.execPath, [SCRIPT].concat(args || []), { cwd: ROOT, encoding: 'utf8' });
    return { code: 0, out: out };
  } catch (e) {
    return { code: e.status || 1, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

// ---------------------------------------------------------------------------
t('The repository uses no API newer than the Node 18 floor');

const clean = run();
ok(clean.code === 0, 'the guard passes on the current tree' + (clean.code ? ': ' + clean.out.trim().split('\n')[0] : ''));
ok(/No API newer than Node 18/.test(clean.out), 'and says what it checked');

// ---------------------------------------------------------------------------
t('The guard can fail');

{
  const probe = path.join(ROOT, 'scripts', 'probe-surface.test-tmp.js');
  // The probe builds the banned token by concatenation. Writing it literally in this file would
  // trip the guard on the guard's own test - which is the guard working, and a good reason to keep
  // its input and its subject apart.
  const banned = 'to' + 'Sorted';
  const call = '.' + banned + '(';
  // The written file must contain a real call, while this source must not contain the literal
  // needle - so the call is assembled at write time.
  fs.writeFileSync(probe, "'use strict';\nconst a = [3, 1, 2]" + call + ");\nconsole.log(a);\n");
  try {
    const dirty = run();
    ok(dirty.code !== 0, 'a post-18 API fails the guard');
    ok(dirty.out.indexOf(banned) !== -1, 'and the message names the API');
    ok(/Node 18/.test(dirty.out), 'and names the floor it breaks');
  } finally {
    fs.unlinkSync(probe);
  }
}

// ---------------------------------------------------------------------------
t('The floor is documented where a contributor will look');

const listed = run(['--list']);
ok(listed.code === 0 && listed.out.indexOf('to' + 'Sorted') !== -1, '--list prints the APIs and their replacements');
ok(listed.out.indexOf('group' + 'By') !== -1, 'including the object-grouping helpers');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
ok(String(pkg.engines && pkg.engines.node || '').indexOf('18') !== -1,
  'package.json still declares the Node 18 floor');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
