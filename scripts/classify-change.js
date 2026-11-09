#!/usr/bin/env node
/**
 * Classify a diff so CI can spend its runner time where it changes an outcome.
 *
 * A pull request that only adds device specs, docs or research notes cannot break the
 * server, the Docker image or the simulator's behaviour - the worst it can do is fail the
 * catalogue invariants, which the test suite checks. Running three Node versions, a smoke
 * test and a Docker build against it costs five runner slots to learn the same thing.
 *
 * Prints `data_only` and `code` to $GITHUB_OUTPUT, and the file list to stdout so a human
 * reading the log can see why.
 *
 * Usage:
 *   node scripts/classify-change.js --base <sha> [--head <sha>]
 *   node scripts/classify-change.js --files a.json devices/x/y.json   (offline check)
 */

const { execFileSync } = require('child_process');
const fs = require('fs');

/**
 * Paths that cannot change runtime behaviour.
 *
 * Deliberately narrow: a test file, a script or a workflow is NOT data, because those are
 * exactly the changes that can make CI lie. `docs/` is safe; `scripts/` is not, even when
 * the script only prints documentation, because the next edit to it might not.
 */
const DATA_PATTERNS = [
  /^devices\/[^/]+\/[^/]+\.json$/,
  /^research\/incoming\/[^/]+\.json$/,
  /^research\/[^/]+\.json$/,
  /^docs\/[^/]+\.md$/,
  /^[^/]+\.md$/
];

function isDataPath(path) {
  if (!path) return false;
  return DATA_PATTERNS.some(re => re.test(path));
}

/**
 * @param {string[]} files changed paths, relative to the repository root
 * @returns {{data_only: boolean, code: boolean, files: string[]}}
 */
function classify(files) {
  const list = (files || []).filter(Boolean);
  if (list.length === 0) {
    // Nothing to look at is not evidence of safety.
    return { data_only: false, code: true, files: [] };
  }
  const codeFiles = list.filter(p => !isDataPath(p));
  return { data_only: codeFiles.length === 0, code: codeFiles.length > 0, files: list };
}

function changedFiles(base, head) {
  const range = base ? [base, head || 'HEAD'] : null;
  if (!range) return [];
  try {
    const out = execFileSync('git', ['diff', '--name-only', ...range], { encoding: 'utf8' });
    return out.split('\n').map(l => l.trim()).filter(Boolean);
  } catch (err) {
    // An unknown base (shallow clone, force-push, brand-new branch) means "we cannot tell",
    // which must never be read as "safe to skip".
    return null;
  }
}

function writeOutput(result) {
  const lines = [
    `data_only=${result.data_only}`,
    `code=${result.code}`
  ].join('\n') + '\n';
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, lines);
  }
  console.log(lines.trim());
}

function main(argv) {
  const args = argv.slice(2);
  const fileIdx = args.indexOf('--files');
  if (fileIdx !== -1) {
    const result = classify(args.slice(fileIdx + 1));
    writeOutput(result);
    console.log(`files=${result.files.length}`);
    return;
  }

  const baseIdx = args.indexOf('--base');
  const headIdx = args.indexOf('--head');
  const base = baseIdx !== -1 ? args[baseIdx + 1] : (process.env.BASE_SHA || '');
  const head = headIdx !== -1 ? args[headIdx + 1] : 'HEAD';

  if (!base) {
    // A push to main has no base: verify everything, as before.
    const result = { data_only: false, code: true, files: [] };
    writeOutput(result);
    console.log('no base sha - treating this as a code change and running the full matrix');
    return;
  }

  const files = changedFiles(base, head);
  if (files === null) {
    writeOutput({ data_only: false, code: true, files: [] });
    console.log(`could not diff ${base}..${head} - treating this as a code change`);
    return;
  }

  const result = classify(files);
  writeOutput(result);
  console.log(`changed files (${files.length}):`);
  for (const f of files.slice(0, 40)) console.log(`  ${isDataPath(f) ? 'data' : 'code'}  ${f}`);
  if (files.length > 40) console.log(`  ... and ${files.length - 40} more`);
}

if (require.main === module) main(process.argv);

module.exports = { classify, isDataPath, DATA_PATTERNS };
