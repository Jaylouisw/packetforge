#!/usr/bin/env node
'use strict';

// The runtime has a floor, and the floor is a fact about the source.
//
// `package.json` declares `engines.node: >=22.18.0`, and 22.18 is the release where node strips
// the types off a `.ts` file with no flag and no build step. `engine/segment.ts` is on the
// server's require graph (`simulator.js:116`), so a runtime below that line does not fail a test
// - it cannot load the tree at all. That is what happened to the smoke job (issue #2488): the
// runner image ships 20.20.2, the job went red with `require('./segment.ts')` in the stack while
// its image build stayed green, and the typecheck job had already died under 20 in the same
// shape (run 10054, `Missing initializer in const declaration`, 11 s in).
//
// #2491 gave both jobs a pinned tarball and an assertion. The assertion was this:
//
//     case "$(node --version)" in
//       v22.*|v23.*|v24.*|v25.*|v26.*) ;;
//       *) echo "::error ... below the 22.18 floor the repo declares"; exit 1 ;;
//     esac
//
// which is a major-number test wearing the floor's name. `v22.*` accepts 22.0.0 through 22.17.9,
// and every one of those is below the floor: they report the floor as held while being exactly
// the runtime the assertion exists to keep out. The same shape was in two jobs, so the
// comparison lives here once and both steps call it, which is also the only way it can be tested
// against a version string on a machine that is not the runner (`test/node-floor.test.js`).
//
// Usage:
//   node scripts/check-node-floor.js                       # assert the running interpreter
//   node scripts/check-node-floor.js --version 22.17.9      # assert a version string
//   node scripts/check-node-floor.js --title Typecheck      # tag the failure for the job log
//
// Exit 0 means at or above the floor. Exit 1 means below it, or a version this cannot compare -
// an unreadable answer is never "at or above", because that direction is the one that lets the
// broken runtime through.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const USAGE = 'usage: node scripts/check-node-floor.js [--version X.Y.Z] [--title NAME]';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readFloor() {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  } catch (e) {
    fail('cannot read package.json beside this script (' + e.message + '), so the floor is unknown');
  }
  const spec = pkg.engines && pkg.engines.node;
  if (!spec) fail('package.json declares no engines.node, so there is no floor to check against');
  // Only the `>=X.Y.Z` form is compared. Anything else (a range, `*`, a caret) is refused rather
  // than guessed at: a floor this script half-understands is the defect it was written to remove.
  const m = />=\s*(\d+)\.(\d+)\.(\d+)/.exec(String(spec));
  if (!m) {
    fail('package.json engines.node is ' + JSON.stringify(spec) + ', which this check cannot ' +
      'compare - it understands `>=X.Y.Z`. Teach the check, do not loosen the gate.');
  }
  return { spec: String(spec), order: [Number(m[1]), Number(m[2]), Number(m[3])], version: m[1] + '.' + m[2] + '.' + m[3] };
}

function parseVersion(text) {
  // `node --version` prints `vX.Y.Z`. A leading `v` is the only decoration accepted; `22.18` and
  // `22` are refused, because a version that cannot be compared must not be reported as a pass.
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(text).trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function below(found, floor) {
  for (let i = 0; i < 3; i++) {
    if (found[i] !== floor[i]) return found[i] < floor[i];
  }
  return false;
}

let version = null;
let title = 'Node floor';
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--version') version = args[++i];
  else if (arg.indexOf('--version=') === 0) version = arg.slice('--version='.length);
  else if (arg === '--title') title = args[++i];
  else if (arg.indexOf('--title=') === 0) title = arg.slice('--title='.length);
  else if (arg === '--help' || arg === '-h') { console.log(USAGE); process.exit(0); }
  else fail('unknown argument ' + JSON.stringify(arg) + ' - ' + USAGE);
  if (version === undefined && arg !== '--title') {
    if (arg === '--version') fail('--version needs a value - ' + USAGE);
  }
}
if (title === undefined) fail('--title needs a value - ' + USAGE);

const floor = readFloor();
if (version === null) version = process.version;
const found = parseVersion(version);
if (!found) {
  fail('::error title=' + title + '::' + JSON.stringify(version) + ' is not a version this check ' +
    'can compare against the ' + floor.version + ' floor (package.json engines.node ' + floor.spec + ')');
}
const running = (version.charAt(0) === 'v' ? version.trim() : 'v' + String(version).trim());
if (below(found, floor.order)) {
  fail('::error title=' + title + '::node ' + running + ' is below the ' + floor.version +
    ' floor package.json declares (engines.node ' + floor.spec + '), which is where node strips ' +
    'types with no flag - the source under test cannot load on it');
}
console.log('node ' + running + ' is at or above the ' + floor.version +
  ' floor package.json declares (engines.node ' + floor.spec + ')');
process.exit(0);
