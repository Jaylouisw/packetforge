#!/usr/bin/env node
'use strict';

// Refuse a new device spec that describes a box the catalogue already has.
//
// Two independent workers wrote devices/huawei/oceanprotect-x8100.json and
// devices/huawei/oceanprotect-x9100.json in the same week. Both branches were green
// on their own base, because a base does not contain the other branch. The forge
// builds the pull_request run from a MERGE of head into main, so once main held those
// two files the branch reintroduced them: `CONFLICT (add/add)` on both, and all three
// Node legs red before a single test executed. Nothing in the repository asked the one
// question that would have stopped it at the push: *is this model already here?*
//
// scripts/sweep-device-requests.js answers that question for the issue tracker, with a
// normaliser built over the incident the last time it was answered wrongly (a slug, a
// typographic dash, a `+` that is a different product). This script asks it of a diff,
// and shares the matcher rather than owning a second copy of it: if `norm()` and
// `sweep-device-requests.js` ever disagree about "same model", one of the two callers
// is wrong, and the fix belongs in the matcher.
//
// What counts as a collision, in the order they are checked:
//   1. the added path is already on the base — git refuses that merge as add/add, and
//      the run is red before any test runs;
//   2. the added spec's vendor + normalised model is already in this tree at another
//      path — one box catalogued twice, which is what #60 and test/duplicate-models is
//      about, except caught before the push instead of after the merge;
//   3. the same, against the base ref, for files main has that this tree does not (a
//      branch cut before main gained the device);
//   4. two specs added by this same change describe one model — the two-stream case
//      that started this.
//
// Usage:
//   node scripts/check-new-devices.js                  # added vs origin/main, plus untracked
//   node scripts/check-new-devices.js --staged         # additions in the index (pre-commit)
//   node scripts/check-new-devices.js --base origin/main
//   node scripts/check-new-devices.js devices/huawei/oceanprotect-x9100.json
//   node scripts/check-new-devices.js --root /some/tree devices/v/m.json   # no git
//
// Exit code: 0 nothing collides, 1 a collision, 2 usage or git failure.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// The matcher. norm() folds entities, typographic dashes and punctuation onto one key,
// keeps `+` as the word "plus" (WiFi Mesh 3+ is not WiFi Mesh 3), and is the comparator
// the catalogue's duplicate rules were measured against. Not reimplemented here on
// purpose — scripts/sweep-device-requests.js exports it for exactly this.
const { norm } = require('./sweep-device-requests.js');

const ROOT = path.join(__dirname, '..');
const DEFAULT_BASE = 'origin/main';

function usage() {
  return [
    'usage: node scripts/check-new-devices.js                # added device specs vs origin/main',
    '       node scripts/check-new-devices.js --staged       # additions staged for commit',
    '       node scripts/check-new-devices.js --base <ref>   # compare against another ref',
    '       node scripts/check-new-devices.js <file> [...]   # named device specs',
    '       node scripts/check-new-devices.js --files-from <list>  # one path per line, `-` for stdin',
    '       node scripts/check-new-devices.js --root <dir> <file> [...]  # a tree, not a checkout'
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Arguments

function parseArgs(argv) {
  const opts = { base: null, staged: false, root: ROOT, files: [], fileList: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--staged') opts.staged = true;
    else if (a === '--base') opts.base = argv[++i];
    else if (a.startsWith('--base=')) opts.base = a.slice('--base='.length);
    else if (a === '--root') opts.root = argv[++i];
    else if (a.startsWith('--root=')) opts.root = a.slice('--root='.length);
    else if (a === '--files-from') opts.fileList = argv[++i];
    else if (a.startsWith('--files-from=')) opts.fileList = a.slice('--files-from='.length);
    else if (a.startsWith('--')) throw new Error('unknown option ' + a);
    else opts.files.push(a);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Git, only where it is asked for

function git(args) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function lines(text) {
  return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
}

function isDeviceSpec(p) {
  return /^devices\/.+\.json$/.test(p);
}

// Paths as git writes them: forward slashes, relative to the tree root, so a message
// reads the same on Windows as it does in CI.
function relative(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '');
}

function resolveBase(ref) {
  try {
    return git(['rev-parse', '--verify', '--quiet', ref + '^{commit}']).trim();
  } catch (e) {
    throw new Error('cannot resolve ' + ref + ': run `git fetch origin` first — ' + ref +
      ' is the branch this check compares against.\n' + usage());
  }
}

// The base's device paths, so an add/add is caught by path alone and no content has to
// be read to name it.
function baseDevicePaths(baseRef) {
  try {
    return new Set(lines(git(['ls-tree', '-r', '--name-only', baseRef, '--', 'devices'])).filter(isDeviceSpec));
  } catch (e) {
    return null;
  }
}

function baseSpec(baseRef, file) {
  try {
    return JSON.parse(git(['show', baseRef + ':' + file]));
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The identity of a device: vendor + normalised model, the sweep's key

function keyOf(spec, file) {
  if (!spec || typeof spec !== 'object') return null;
  const vendor = norm(spec.vendor || path.basename(path.dirname(file)));
  const model = norm(spec.model);
  if (!model) return null;
  return vendor + '|' + model;
}

function describe(spec, file) {
  const vendor = spec && spec.vendor ? String(spec.vendor) : path.basename(path.dirname(file));
  const model = spec && spec.model ? String(spec.model) : '(no model)';
  return vendor + ' "' + model + '"';
}

function readList(from) {
  let text;
  if (from === '-') {
    text = fs.readFileSync(0, 'utf8');
  } else {
    try {
      text = fs.readFileSync(from, 'utf8');
    } catch (e) {
      throw new Error('cannot read the file list ' + from + ': ' + e.message);
    }
  }
  return lines(text.replace(/#.*$/gm, ''));
}

function readSpec(rootDir, file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(rootDir, file), 'utf8'));
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The tree being checked, indexed by the same key

function indexTree(rootDir, exclude) {
  const byKey = new Map();
  const paths = new Set();
  const devices = path.join(rootDir, 'devices');
  if (!fs.existsSync(devices)) return { byKey, paths };

  (function walk(dir) {
    for (const entry of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      let st;
      try { st = fs.statSync(full); } catch (e) { continue; }
      if (st.isDirectory()) { walk(full); continue; }
      if (!entry.endsWith('.json')) continue;
      const file = relative(path.relative(rootDir, full));
      paths.add(file);
      if (exclude.has(file)) continue;
      const spec = readSpec(rootDir, file);
      const key = keyOf(spec, file);
      if (!key) continue;
      if (!byKey.has(key)) byKey.set(key, { path: file, spec });
    }
  })(devices);

  return { byKey, paths };
}

// ---------------------------------------------------------------------------
// The two ways to name a change

function addedFromGit(opts) {
  const baseName = opts.base || DEFAULT_BASE;
  const baseRef = resolveBase(baseName);
  if (opts.staged) {
    return {
      baseRef,
      baseName,
      files: lines(git(['diff', '--cached', '--name-only', '--diff-filter=A', '--no-renames', '--', 'devices']))
        .filter(isDeviceSpec)
    };
  }
  // Merge base, not the base tip: that is the tree the pull request is built from. A file
  // both sides added after the branch point is an addition here — which is the collision
  // this exists for, and the reason `git diff origin/main HEAD` would miss it.
  const mergeBase = git(['merge-base', baseRef, 'HEAD']).trim();
  const committed = lines(git(['diff', '--name-only', '--diff-filter=A', '--no-renames', mergeBase, 'HEAD', '--', 'devices']));
  // A worker's new spec is untracked until it is staged; checking it then is the whole
  // point of running before the push.
  const untracked = lines(git(['ls-files', '--others', '--exclude-standard', '--', 'devices']));
  return { baseRef, baseName, files: committed.concat(untracked).filter(isDeviceSpec) };
}

// ---------------------------------------------------------------------------
// The check

function check(opts) {
  let baseRef = null;
  // The ref as the user named it, for messages; baseRef is the commit git needs.
  let baseName = null;
  let candidates;
  let useGit;

  if (opts.fileList || opts.files.length) {
    // A list from a hook or from scripts/premerge-check.js. An empty list is an empty
    // change set, which passes: nothing was added, so nothing collides.
    const named = opts.fileList
      ? readList(opts.fileList).concat(opts.files)
      : opts.files;
    candidates = named.map(relative);
    useGit = Boolean(opts.base);
    if (useGit) { baseRef = resolveBase(opts.base); baseName = opts.base; }
  } else if (opts.staged || relative(path.resolve(opts.root)) === relative(path.resolve(ROOT))) {
    const fromGit = addedFromGit(opts);
    baseRef = fromGit.baseRef;
    baseName = fromGit.baseName;
    candidates = fromGit.files;
    useGit = true;
  } else {
    throw new Error('no files named and --root is not this checkout.\n' + usage());
  }

  candidates = Array.from(new Set(candidates.filter(isDeviceSpec))).sort();

  if (candidates.length === 0) {
    console.log('no added device specs under devices/ to check.');
    return 0;
  }

  const candidateSet = new Set(candidates);
  const tree = indexTree(opts.root, candidateSet);

  // Files the base carries that this tree does not: the branch was cut before main gained
  // the device, or the model was renamed into another file. Read only those, which is
  // normally none of them.
  let baseByKey = null;
  function baseIndex() {
    if (baseByKey || !useGit) return baseByKey;
    baseByKey = new Map();
    const basePaths = baseDevicePaths(baseRef);
    if (!basePaths) return baseByKey;
    for (const file of basePaths) {
      if (tree.paths.has(file) || candidateSet.has(file)) continue;
      const spec = baseSpec(baseRef, file);
      const key = keyOf(spec, file);
      if (key && !baseByKey.has(key)) baseByKey.set(key, { path: file, spec });
    }
    return baseByKey;
  }

  const findings = [];
  const addedByKey = new Map();
  // Resolved once: one `git ls-tree` per run, not one per candidate.
  const basePaths = useGit ? baseDevicePaths(baseRef) : null;

  for (const file of candidates) {
    const spec = readSpec(opts.root, file);
    if (!spec) {
      console.error('skipped ' + file + ': unreadable JSON, so it cannot be checked (the other suites refuse it).');
      continue;
    }
    const key = keyOf(spec, file);
    const who = describe(spec, file);

    // 1. The base already has this exact path. This is the add/add the merge dies on.
    if (basePaths && basePaths.has(file)) {
      findings.push({
        file,
        who,
        kind: 'add/add',
        owner: file,
        note: baseName + ' already carries ' + file + ', so this merge is a conflict: all ' +
          'the Node legs go red before a test runs.'
      });
      continue;
    }

    // 2. Same model, already in this tree at another path.
    const inTree = key ? tree.byKey.get(key) : null;
    if (inTree) {
      findings.push({
        file,
        who,
        kind: 'duplicate',
        owner: inTree.path,
        note: who + ' is already modelled by ' + inTree.path + '.'
      });
      continue;
    }

    // 3. Same model, on the base, at a path this tree does not have.
    const inBase = key ? (baseIndex() || new Map()).get(key) : null;
    if (inBase) {
      findings.push({
        file,
        who,
        kind: 'duplicate',
        owner: inBase.path,
        note: who + ' is already modelled by ' + inBase.path + ' on ' + baseName + '.'
      });
      continue;
    }

    // 4. Two specs added by this same change.
    const sibling = key ? addedByKey.get(key) : null;
    if (sibling) {
      findings.push({
        file,
        who,
        kind: 'duplicate',
        owner: sibling,
        note: who + ' is the same model as ' + sibling + ', which this change adds too.'
      });
      continue;
    }

    if (key) addedByKey.set(key, file);
  }

  if (findings.length === 0) {
    console.log('checked ' + candidates.length + ' added device spec' + (candidates.length === 1 ? '' : 's') +
      ' against devices/' + (useGit ? ' and ' + baseName : '') + ': none is already modelled.');
    return 0;
  }

  const one = findings.length === 1;
  console.log('refusing: ' + findings.length + ' of ' + candidates.length + ' added device spec' +
    (candidates.length === 1 ? '' : 's') + ' ' + (one ? 'describes' : 'describe') +
    ' hardware the catalogue already has.');
  console.log('');
  for (const f of findings) {
    console.log('  ' + f.file);
    console.log('    ' + f.note);
  }
  console.log('');
  console.log('One box, one spec. Extend the file that exists — if this really is a different');
  console.log('product, the model string has to say so. The matcher is shared with');
  console.log('scripts/sweep-device-requests.js; docs/plans/request-queue-duplicates.md says why');
  console.log('two spellings of one model are one device here.');
  return 1;
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(e.message);
    return 2;
  }
  if (opts.help) {
    console.log(usage());
    return 0;
  }
  try {
    return check(opts);
  } catch (e) {
    console.error(e.message || String(e));
    return 2;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
} else {
  module.exports = { keyOf, check, addedFromGit, indexTree, DEFAULT_BASE };
}
