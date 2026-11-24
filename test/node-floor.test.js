'use strict';

// The workflows have to run the code on the runtime `package.json` says it may be run on.
//
// The floor is not a preference: `engines.node` is `>=22.18.0`, and 22.18 is the release where
// node strips the types off a `.ts` file with no flag. `engine/segment.ts` is on the server's
// require graph, so a job below the floor cannot load the tree it is testing at all - the smoke
// job went red with `simulator.js:116:20` in the stack while its image build stayed green
// (issue #2488), and the typecheck job died under 20 in the same shape (run 10054).
//
// #2491 gave both of those jobs a pinned tarball and an assertion. The assertion is what these
// tests are about, because the first version of it was `case "$(node --version)" in v22.*)`:
// that accepted 22.0.0 through 22.17.9, every one of which is below the floor and reproduces
// exactly the failure the assertion exists to catch. A gate that names 22.18 in its message and
// compares the major number is worse than no gate - it reports the floor as held.
//
// The comparison lives in `scripts/check-node-floor.js` so it can be run against a version
// string here, on a machine that is not the runner.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'check-node-floor.js');
const WORKFLOW = path.join(ROOT, '.forgejo', 'workflows', 'ci.yml');

function floor() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const m = />=\s*(\d+)\.(\d+)\.(\d+)/.exec(pkg.engines.node);
  return { declared: pkg.engines.node, version: m[1] + '.' + m[2] + '.' + m[3] };
}

function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT].concat(args), { encoding: 'utf8' });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || ''), err: r.error };
}

test('the floor these tests hold the workflows to is the one package.json declares', function () {
  const f = floor();
  assert.strictEqual(f.version, '22.18.0',
    'package.json engines.node reads ' + JSON.stringify(f.declared) +
    '; these tests assert 22.18.0 because that is where type stripping is on with no flag');
});

test('a runtime below the floor is refused, and the message carries both versions', function () {
  const r = run(['--version', '22.17.9']);
  assert.ok(!r.err, 'could not run scripts/check-node-floor.js: ' + (r.err && r.err.message));
  assert.strictEqual(r.status, 1, '22.17.9 is below 22.18.0 and must fail, got ' + JSON.stringify(r.out));
  assert.match(r.out, /22\.17\.9/, 'the message must name the runtime it found: ' + JSON.stringify(r.out));
  assert.match(r.out, /22\.18\.0/, 'the message must name the floor it found it below: ' + JSON.stringify(r.out));
});

test('the floor itself is accepted', function () {
  const r = run(['--version', '22.18.0']);
  assert.strictEqual(r.status, 0, '22.18.0 is the floor, so it must pass, got ' + JSON.stringify(r.out));
});

test('the minor is compared as a number, not as a prefix', function () {
  // The exact shape of the bug the glob had: `v22.*` sorts "22.9.0" in front of "22.18.0".
  const low = run(['--version', '22.9.0']);
  assert.strictEqual(low.status, 1, '22.9.0 is nine minors below the floor, got ' + JSON.stringify(low.out));
  const high = run(['--version', '22.20.0']);
  assert.strictEqual(high.status, 0, '22.20.0 is above the floor, got ' + JSON.stringify(high.out));
  const belowMajor = run(['--version', '21.99.0']);
  assert.strictEqual(belowMajor.status, 1, '21.99.0 is a whole major below the floor, got ' + JSON.stringify(belowMajor.out));
});

test('a `v` prefix is what `node --version` prints, so it is accepted', function () {
  const r = run(['--version', 'v22.23.5']);
  assert.strictEqual(r.status, 0, 'v22.23.5 is what the pinned tarball prints, got ' + JSON.stringify(r.out));
});

test('an unreadable version is a failure, not a pass', function () {
  // The failure direction matters: a comparison that cannot parse must never answer "at or above".
  for (const junk of ['banana', '', '22', 'v22.18']) {
    const r = run(['--version', junk]);
    assert.strictEqual(r.status, 1,
      'the version ' + JSON.stringify(junk) + ' cannot be compared and must fail, got ' + JSON.stringify(r.out));
    assert.doesNotMatch(r.out, /at or above/, 'nothing unreadable may be reported as held: ' + JSON.stringify(r.out));
  }
});

test('with no version argument it checks the interpreter that is running it', function () {
  const r = run([]);
  assert.strictEqual(r.status, 0,
    'this host runs ' + process.version + '; the check must read the running interpreter and pass it, got ' +
    JSON.stringify(r.out));
  assert.match(r.out, /22\.18\.0/, 'the log must say which floor it applied: ' + JSON.stringify(r.out));
});

test('no job asserts the floor with a major-version glob', function () {
  // Read line by line and ignore comments: the step that replaced the glob quotes it in a
  // comment, which is the record of why it went, and a gate that forbids naming its own past is
  // a gate nobody can explain. What must not come back is the executable line.
  const lines = fs.readFileSync(WORKFLOW, 'utf8').split('\n');
  (function () {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Skipping a comment is ordinary control flow, not an exemption: the scan is looking
      // for the shell line that declares the runtime, and a comment is not a candidate for
      // that rule. Nothing about a device or a hardware class is being decided here.
      if (/^\s*#/.test(line)) continue;
      if (/case\s+"\$\(node --version\)"/.test(line)) {
        throw new Error('the `case ... v22.*` assertion is back in ci.yml at line ' + (i + 1) +
          ': it accepts 22.0.0-22.17.x, every one of which is below the floor and cannot load ' +
          'engine/segment.ts - use `node scripts/check-node-floor.js`');
      }
    }
  })();
});

test('both jobs that run the source on a provisioned runtime use the shared comparison', function () {
  const text = fs.readFileSync(WORKFLOW, 'utf8');
  const uses = text.split('\n').filter(function (l) { return /node scripts\/check-node-floor\.js/.test(l); });
  assert.ok(uses.length >= 2,
    'the smoke job and the typecheck job each provision a runtime and each has to assert it, so ' +
    'ci.yml should call scripts/check-node-floor.js twice; found ' + uses.length);
  assert.match(text, /--title "Server smoke and Docker build"/,
    'the smoke job\'s assertion must still tag its failure with the job\'s title');
  assert.match(text, /--title Typecheck/,
    'the typecheck job\'s assertion must still tag its failure with `Typecheck`');
});

test('the smoke job provisions its runtime before it starts the smoke client', function () {
  const text = fs.readFileSync(WORKFLOW, 'utf8');
  const provision = text.indexOf('name: Provide the runtime the smoke client needs');
  const smoke = text.indexOf('node scripts/smoke-http.js');
  assert.ok(provision > -1, 'the smoke job no longer has a step that provides its runtime');
  assert.ok(smoke > -1, 'the smoke job no longer runs scripts/smoke-http.js');
  assert.ok(provision < smoke,
    'the runtime step must come before the smoke client, or the client runs on the image Node again');
});

test('the job title reaches the log, because that is the name on the check', function () {
  const r = run(['--version', '20.20.2', '--title', 'Server smoke and Docker build']);
  assert.strictEqual(r.status, 1, '20.20.2 is what the runner image ships, got ' + JSON.stringify(r.out));
  assert.ok(r.out.indexOf('::error title=Server smoke and Docker build::') !== -1,
    'a failing check must carry the job title Forgejo shows on the run: ' + JSON.stringify(r.out));
});

test('a floor this check cannot read is refused rather than assumed', function () {
  // engines.node is the one input this comparison trusts. A caret range or a `*` would be read
  // as "whatever runs", which is the direction that lets a 20 through - so readFloor refuses it
  // instead of finding a `>=` that is not there and calling the answer a pass.
  const text = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok(text.indexOf('cannot compare') !== -1,
    'check-node-floor.js no longer refuses an engines.node it cannot compare');
  assert.ok(text.indexOf('process.exit(1)') !== -1,
    'a refused floor has to be a failing exit, not a printed warning');
});

test('the roadmap names the legs the matrix actually runs', function () {
  // docs/ROADMAP.md said the suite runs on "Node 18, 20 and 22" long after 18 and 20 left the
  // matrix (#2548). It is the one sentence a reader trusts instead of opening the workflow, and
  // a reader who trusts it installs 18 - which cannot even require engine/simulator.js, because
  // line 116 pulls in engine/segment.ts. So the sentence is checked against the matrix here
  // rather than by eye.
  const workflow = fs.readFileSync(WORKFLOW, 'utf8');
  const matrix = /^\s*node:\s*\[([^\]]*)\]/m.exec(workflow);
  assert.ok(matrix, 'ci.yml no longer declares a `node: [...]` matrix for the test job');
  const legs = matrix[1].split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  assert.ok(legs.length > 0, 'the matrix declares no legs: ' + JSON.stringify(matrix[0]));

  const roadmap = fs.readFileSync(path.join(ROOT, 'docs', 'ROADMAP.md'), 'utf8');
  const line = roadmap.split('\n').filter(function (l) { return /runs the suite on Node/.test(l); })[0];
  assert.ok(line, 'docs/ROADMAP.md no longer has a CI row saying which Nodes the suite runs on');
  const at = line.indexOf('Node ') + 'Node '.length;
  // Up to the end of the version list: digits, spaces, commas and the word "and".
  const named = (line.slice(at).match(/^[\d\s,and]+/) || [''])[0].match(/\d+/g) || [];
  assert.deepStrictEqual(named, legs,
    'docs/ROADMAP.md says the suite runs on Node ' + named.join(', ') +
    '; .forgejo/workflows/ci.yml runs Node ' + legs.join(', ') + ' - the row has to name the same legs');
});
