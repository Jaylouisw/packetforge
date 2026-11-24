'use strict';
// poe-budget-gate.test.js -- a gate is only a gate if it can be called and it can fail.
//
// `scripts/audit-poe-budget.js` reports the devices that source PoE and cannot say how much. It was
// a bare `process.exit(main())`: no export, no `require.main` guard, so no suite could ask it what
// it counted, and nothing ran it in CI. `docs/plans/poe-budget-variants.md` step 1 and step 4 ask for
// the two halves of the fix - callable, and provably able to fail - because the cohort it could not
// express is the one that describes three real boxes:
//
//   * `poe.passthrough: true` - the port sources power that arrived from upstream. Ubiquiti prints
//     no ceiling for the F-POE-G2, the UDB-Pro or the UACC-LR-Endpoint output because the ceiling is
//     whatever supply is plugged into the box; a `budgetW` there would be a subtraction nobody
//     published, and "silent" was the wrong word for a device whose answer is genuinely elsewhere.
//   * `misdeclared` - the escape hatch the plan warned about. A `passthrough` flag beside a
//     `budgetW`, or on a box with no PSE port, describes nothing, so it fails `--strict` exactly
//     like a silent one instead of buying a quiet audit line for free.
//
// The fixtures below are synthetic on purpose: the catalogue is moving (the silent cohort went 128 ->
// 3 in five days), so the gate is pinned on shapes, and the real catalogue is only asked for
// internal consistency - one cohort per device, and the exit code agreeing with the cohorts it
// printed.
const path = require('path');
const { spawnSync } = require('child_process');
const audit = require('../scripts/audit-poe-budget');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.error('  ✗ ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
function section(name) { console.log('\n' + name); }

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'audit-poe-budget.js');

// One PSE socket, no budget, and a model name the name parser cannot read as a wattage.
function fixture(over) {
  const base = {
    vendor: 'gate',
    model: 'FIXTURE-A',
    label: 'gate fixture A',
    category: 'switch',
    capabilities: ['l2-forward', 'poe-pse'],
    interfaces: [
      { name: 'eth1', type: 'ethernet', connector: 'rj45', speed: '1G', poeOut: 15.4 }
    ]
  };
  return Object.assign({}, base, over || {});
}
function cohorts(report, model) {
  const names = ['silent', 'inferred', 'prose', 'passthrough', 'misdeclared', 'unknown'];
  return names.filter(function (k) {
    return (report[k] || []).some(function (r) { return r.model === model; });
  });
}
function bad(report) {
  return report.silent.length + report.orphan.length + report.misdeclared.length;
}

section('The audit is importable, and importing it does not run it');
{
  ok(typeof audit.auditPoeBudget === 'function', 'auditPoeBudget() is exported');
  ok(typeof audit.main === 'function', 'main() is exported beside it');
}

section('A PSE with no budget and no marker is still silent, and fails the gate');
{
  const report = audit.auditPoeBudget([fixture()]);
  ok(cohorts(report, 'gate/FIXTURE-A').join() === 'silent',
    'the fixture lands in silent and nowhere else', cohorts(report, 'gate/FIXTURE-A').join());
  ok(bad(report) === 1, 'and it counts against --strict (' + bad(report) + ')');
}

section('A vendor that publishes nothing is unknown, not silent');
{
  const report = audit.auditPoeBudget([fixture({ poe: { budgetUnknown: true, note: 'checked, prints nothing' } })]);
  ok(cohorts(report, 'gate/FIXTURE-A').join() === 'unknown',
    'budgetUnknown moves it to the unknown cohort', cohorts(report, 'gate/FIXTURE-A').join());
  ok(bad(report) === 0, 'and it does not fail --strict');
}

section('A passthrough box is counted, not called silent');
{
  const report = audit.auditPoeBudget([fixture({ poe: { passthrough: true, note: 'watts arrive from upstream' } })]);
  ok(cohorts(report, 'gate/FIXTURE-A').join() === 'passthrough',
    'poe.passthrough moves it to its own cohort', cohorts(report, 'gate/FIXTURE-A').join());
  ok(bad(report) === 0, 'and a real passthrough does not fail --strict');
  ok(report.sourcing === 1, 'while still counting as a box that sources power (' + report.sourcing + ')');
}

section('The flag cannot be used to quiet the audit');
{
  const both = audit.auditPoeBudget([fixture({ poe: { passthrough: true, budgetW: 60 } })]);
  ok(cohorts(both, 'gate/FIXTURE-A').join() === 'misdeclared',
    'passthrough beside budgetW is a contradiction, not a passthrough', cohorts(both, 'gate/FIXTURE-A').join());
  ok(bad(both) === 1, 'and it fails --strict like a silent one');

  const bare = audit.auditPoeBudget([fixture({
    poe: { passthrough: true },
    capabilities: ['l2-forward'],
    interfaces: [{ name: 'sfp1', type: 'ethernet', connector: 'sfp', speed: '1G', speedCaps: [1000] }]
  })]);
  ok(cohorts(bare, 'gate/FIXTURE-A').join() === 'misdeclared',
    'passthrough on a box with no PSE port describes nothing', cohorts(bare, 'gate/FIXTURE-A').join());
}

section('The real catalogue keeps one cohort per device');
{
  const cat = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
  const report = audit.auditPoeBudget(cat);
  ok(report.models === cat.length, 'every loaded model is audited (' + report.models + '/' + cat.length + ')');
  const seen = {};
  const twice = [];
  ['silent', 'inferred', 'passthrough', 'misdeclared', 'unknown', 'orphan'].forEach(function (k) {
    (report[k] || []).forEach(function (r) {
      if (seen[r.model]) twice.push(r.model + ' (' + seen[r.model] + '+' + k + ')');
      seen[r.model] = k;
    });
  });
  ok(twice.length === 0, 'no device is counted in two cohorts' + (twice.length ? ': ' + twice.join(', ') : ''));
  ok(report.sourcing > 300, 'and the PSE census is still the whole catalogue (' + report.sourcing + ' boxes)');
}

section('The exit code agrees with the cohorts the script printed');
{
  const cli = spawnSync(process.execPath, [SCRIPT, '--strict'], { cwd: ROOT, encoding: 'utf8' });
  const asJson = spawnSync(process.execPath, [SCRIPT, '--json'], { cwd: ROOT, encoding: 'utf8' });
  let report = null;
  try { report = JSON.parse(asJson.stdout); } catch (e) { report = null; }
  ok(!!report, '--json is machine-readable');
  if (report) {
    const want = bad(report) ? 1 : 0;
    ok(cli.status === want, '--strict exits ' + want + ' for ' + bad(report) + ' bad rows (it exited ' + cli.status + ')');
    ok(!!report.passthrough && !!report.misdeclared, 'and the new cohorts are in the JSON, not only in the printout');
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
