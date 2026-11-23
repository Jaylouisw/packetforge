'use strict';
// The push-time duplicate gate: does the spec this change adds describe a box the
// catalogue already has?
//
// The incident behind it: two workers added devices/huawei/oceanprotect-x8100.json and
// devices/huawei/oceanprotect-x9100.json in the same week. Each branch was green on its
// own base. The forge builds the pull_request run from a MERGE of head into main, so the
// branch reintroduced files main already had — `CONFLICT (add/add)`, three Node legs red
// before a single test ran.
//
// These cases hold the two answers the gate has to keep giving, and nothing else:
//   * the same model written differently (case, spacing, punctuation, an en dash for a
//     hyphen) is refused, and the message names BOTH paths so the author can see which
//     file to extend instead;
//   * a model that is genuinely new passes — a gate that refuses new hardware is worse
//     than the collision it prevents, because it stops the work rather than the duplicate.
//
// Fixtures are built in a temp directory and the script runs with --root, so this suite
// touches no network, no tracker and not the real catalogue. The matcher itself is
// test/sweep-requests.test.js's subject; this suite only asks whether the gate calls it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'check-new-devices.js');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  <- ' + detail : '')); }
}

function spec(vendor, model, label) {
  return JSON.stringify({
    vendor: vendor,
    model: model,
    label: label || (vendor + ' ' + model),
    category: 'router',
    interfaces: [{ name: 'Gi0/1', type: 'ethernet', speed: '1G', speedCaps: [1000] }],
    sources: []
  }, null, 2) + '\n';
}

function makeTree(files) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pfc-newdev-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof body === 'string' ? body : spec(body.vendor, body.model, body.label));
  }
  return tmp;
}

function run(args, opts) {
  const r = spawnSync(process.execPath, [SCRIPT].concat(args), {
    encoding: 'utf8',
    input: opts && opts.input,
    cwd: opts && opts.cwd
  });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// ---------------------------------------------------------------------------
// (a) The same model, spelled differently, is refused — and both paths are named.
//
// The catalogue stores slugs ("edge-router-900"); a worker types or files the vendor's
// spelling ("Edge–Router 900"). An exact-string comparator calls those two devices, which
// is exactly how the same box gets catalogued twice.

console.log('A second spelling of an existing model is refused, naming both files:');
{
  const t = makeTree({
    'devices/acme/edge-router-900.json': { vendor: 'acme', model: 'edge-router-900' },
    'devices/acme/Edge–Router 900.json': { vendor: 'Acme', model: 'Edge\u2013Router 900' }
  });
  const r = run(['--root', t, 'devices/acme/Edge\u2013Router 900.json']);
  ok(r.status === 1, 'the gate refuses it (exit 1)', 'exit ' + r.status + '\n' + r.out);
  ok(r.out.includes('devices/acme/Edge\u2013Router 900.json'), 'the message names the file being added', r.out);
  ok(r.out.includes('devices/acme/edge-router-900.json'), 'and the file that already holds the model', r.out);
  ok(/Edge\u2013Router 900/.test(r.out), 'and quotes the model string it compared', r.out);
  ok(/already modelled by/.test(r.out), 'saying plainly that it is already modelled', r.out);
  fs.rmSync(t, { recursive: true, force: true });
}

console.log('\nCase and punctuation alone are enough to collide:');
{
  const t = makeTree({
    'devices/acme/edge-router-900.json': { vendor: 'acme', model: 'edge-router-900' },
    'devices/acme/edge_router_900.json': { vendor: 'ACME', model: 'EDGE ROUTER 900' }
  });
  const r = run(['--root', t, 'devices/acme/edge_router_900.json']);
  ok(r.status === 1, 'EDGE ROUTER 900 is refused against edge-router-900', 'exit ' + r.status + '\n' + r.out);
  ok(r.out.includes('devices/acme/edge-router-900.json'), 'and the existing path is still named', r.out);
  fs.rmSync(t, { recursive: true, force: true });
}

console.log('\nTwo specs added by the same change collide with each other:');
{
  const t = makeTree({
    'devices/acme/edge-router-900.json': { vendor: 'acme', model: 'edge-router-900' },
    'devices/acme/Edge Router 900.json': { vendor: 'acme', model: 'Edge Router 900' }
  });
  const r = run(['--root', t,
    'devices/acme/edge-router-900.json', 'devices/acme/Edge Router 900.json']);
  ok(r.status === 1, 'the second of the two is refused', 'exit ' + r.status + '\n' + r.out);
  ok(r.out.includes('devices/acme/edge-router-900.json') && r.out.includes('devices/acme/Edge Router 900.json'),
    'both added paths appear in the message', r.out);
  fs.rmSync(t, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// (b) A model that is genuinely new passes. This is the case that keeps the gate usable:
// the answer to "is this hardware here?" is usually no, and the device stream has to be
// able to add it.

console.log('\nA genuinely new model passes:');
{
  const t = makeTree({
    'devices/acme/edge-router-900.json': { vendor: 'acme', model: 'edge-router-900' },
    'devices/acme/edge-router-950.json': { vendor: 'acme', model: 'edge-router-950' }
  });
  const r = run(['--root', t, 'devices/acme/edge-router-950.json']);
  ok(r.status === 0, 'exit 0: a different model in the same vendor is new hardware', 'exit ' + r.status + '\n' + r.out);
  ok(/none is already modelled/.test(r.out), 'and it says so', r.out);
  fs.rmSync(t, { recursive: true, force: true });
}

console.log('\nThe same code under a different vendor is not a duplicate:');
{
  // "ES-12F" is one vendor's switch; another vendor's identical-looking code is another
  // box. The gate answers "already modelled?" about a vendor AND a model, because a
  // refusal that merges two vendors' hardware is worse than a miss (a false duplicate
  // tells a contributor their new device is unnecessary).
  const t = makeTree({
    'devices/acme/es-12f.json': { vendor: 'acme', model: 'es-12f' },
    'devices/zenith/es-12f.json': { vendor: 'zenith', model: 'es-12f' }
  });
  const r = run(['--root', t, 'devices/zenith/es-12f.json']);
  ok(r.status === 0, 'a different vendor with the same code passes', 'exit ' + r.status + '\n' + r.out);
  fs.rmSync(t, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// (c) An empty change set passes. A gate that goes red because it found nothing to do
// would be turned off within a week, and `--files-from` is what a hook feeds it.

console.log('\nAn empty change set passes:');
{
  const t = makeTree({ 'devices/acme/edge-router-900.json': { vendor: 'acme', model: 'edge-router-900' } });
  const list = path.join(t, 'added.txt');
  fs.writeFileSync(list, '# nothing added by this change\n\n');
  const r = run(['--root', t, '--files-from', list]);
  ok(r.status === 0, 'an empty file list exits 0', 'exit ' + r.status + '\n' + r.out);
  ok(/nothing to check|no added device specs/.test(r.out), 'and reports that there was nothing to check', r.out);

  const viaStdin = run(['--root', t, '--files-from', '-'], { input: '' });
  ok(viaStdin.status === 0, 'so does an empty list on stdin', 'exit ' + viaStdin.status + '\n' + viaStdin.out);
  fs.rmSync(t, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// The wiring is checked as text, the way scripts/check-rebase-push-guard.js checks the
// workflows: the gate only exists if the run that builds a merge tree carries it, and
// nothing in this script may carry a second copy of the matcher.

console.log('\nThe gate runs where a merge tree is already built, and it shares the matcher:');
{
  const premerge = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'premerge-check.js'), 'utf8');
  ok(/scripts\/check-new-devices\.js/.test(premerge),
    'scripts/premerge-check.js runs it on the merge tree it builds for every branch');
  ok(/--files-from/.test(premerge), 'and hands it the specs the branch adds, rather than guessing');

  // AGENTS.md is the machine-facing pre-push list; docs/MAINTAINING.md is the human one.
  // The gate is worth nothing if a worker never learns to type it.
  const maintaining = fs.readFileSync(path.join(__dirname, '..', 'docs', 'MAINTAINING.md'), 'utf8');
  ok(/node scripts\/check-new-devices\.js/.test(maintaining),
    'docs/MAINTAINING.md names it where a spec gets written');

  const src = fs.readFileSync(SCRIPT, 'utf8');
  ok(/require\('\.\/sweep-device-requests\.js'\)/.test(src),
    'the script imports the normaliser rather than declaring one',
    'no require of sweep-device-requests.js');
  ok(!/function\s+norm\s*\(/.test(src) && !/function\s+deDash\s*\(/.test(src) && !/function\s+deEntity\s*\(/.test(src),
    'and defines no normaliser of its own');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
