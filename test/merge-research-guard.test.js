'use strict';
// scripts/merge-research.js must not be able to resurrect a merged duplicate.
//
// The script carries a hardcoded list of device specs and writes them straight into
// devices/, bypassing the importer. Its old guard was `fs.existsSync(<file>)`, which cannot
// see a device that is already in the catalogue under a different spelling - that is the
// whole point of a normalised key. So it held a second spelling of the Raspberry Pi 5
// (`RaspberryPi5` beside `Raspberry Pi 5`) and would have written it back out as a fresh
// file the moment anyone ran the script.
//
// What is locked here:
//   1. running the script adds nothing at all, because every spec it carries is already in
//      the catalogue;
//   2. it says so, naming the existing device and the normalised key, rather than silently
//      writing files;
//   3. it uses the shared modelKey() rather than comparing strings itself, so it cannot
//      drift from the catalogue invariant and the importer.
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.log('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + ' (expected ' + JSON.stringify(expected) +
    ', got ' + JSON.stringify(actual) + ')');
}
function section(name) { console.log('\n' + name); }

const root = path.join(__dirname, '..');
const script = path.join(root, 'scripts', 'merge-research.js');
const devicesDir = path.join(root, 'devices');

section('1. The script uses the shared normalisation');
{
  const src = fs.readFileSync(script, 'utf8');
  ok(/require\(['"]\.\.\/devices\/registry['"]\)/.test(src),
    'it requires devices/registry');
  ok(/\bmodelKey\b/.test(src), 'and calls modelKey()');
  // A second spelling of the Pi 5 is the specific thing that got merged; it must not be
  // sitting in the list waiting to be written again.
  ok(!/model:\s*'RaspberryPi5'/.test(src),
    'the superseded RaspberryPi5 spelling is not in the device list');
}

section('2. Running it adds nothing, and says why');
{
  let out;
  try {
    out = execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  } catch (e) {
    out = String((e && e.stdout) || '');
    ok(false, 'the script runs without throwing');
  }
  ok(/added 0 devices/.test(out), 'it adds zero devices');
  ok(/already in catalogue as /.test(out),
    'and reports each skip as already present, naming the existing device');
  ok(/\[key [a-z0-9]+\|[a-z0-9]+\]/.test(out),
    'with the normalised key it compared on');
  ok(/skipped \d+/.test(out), 'and counts them as skipped');
}

section('3. No duplicate file appeared on disk');
{
  const piFiles = fs.readdirSync(path.join(devicesDir, 'raspberrypi'));
  const dupes = piFiles.filter(function (f) {
    return /^raspberrypi5\.json$/i.test(f);
  });
  eq(dupes.length, 0, 'there is no raspberrypi/RaspberryPi5.json again');

  // And exactly one file normalises to the Pi 5 key.
  const { modelKey } = require(path.join(root, 'devices', 'registry'));
  const keys = piFiles.filter(function (f) { return f.endsWith('.json'); }).map(function (f) {
    let spec;
    try { spec = JSON.parse(fs.readFileSync(path.join(devicesDir, 'raspberrypi', f), 'utf8')); }
    catch (e) { return null; }
    return spec ? modelKey(spec) : null;
  }).filter(Boolean);
  const piKey = 'raspberrypi|raspberrypi5';
  eq(keys.filter(function (k) { return k === piKey; }).length, 1,
    'exactly one spec in the catalogue carries the Pi 5 key');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
