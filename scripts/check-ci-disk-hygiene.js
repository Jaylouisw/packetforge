'use strict';
// A job that writes to the host's disk has to bound what it writes.
//
// On 2026-11-12 the forge ran out of disk in the middle of a normal day. It did not
// report that: the symptom was a push rejected with `couldn't set
// 'refs/heads/fix/short-line'`, an API call answering 500 with
// `could not write config file ...: No space left on device`, and - worst of the
// three - a pull request whose `test` jobs were never created at all, so the checks
// it was armed against could not exist. Two force-pushes produced no run, and a
// `workflow_dispatch` on the same branch created only the job that has no `needs:`.
// Everything downstream of a `needs:` was silently absent.
//
// The volume is shared: Forgejo stores its data there, and the CI runner builds a
// Docker image against the *host* daemon on every code push (see the `docker` job in
// `.forgejo/workflows/ci.yml`, which installs the CLI and talks to the mounted
// `/var/run/docker.sock`). Nothing consumes the image it builds - it exists to prove
// the Dockerfile builds - and nothing removed it afterwards. Every push left layers
// and build cache behind on the same volume as the database, forever.
//
// That is the rule this checks: a step that runs `docker build` is a promise to clean
// up after itself, in the same job, in a step that runs even when the build fails
// (`if: always()`), and the job has to say what the volume looked like
// (`docker system df`) so a filling disk is visible in a log instead of discovered by
// a rejected push.
//
// Workflows are read as text: this repository has no YAML dependency and does not
// want one. Full-line comments are stripped first, because the prose explaining the
// build mentions `docker build` and a checker that counted its own documentation as
// evidence would fail every time somebody documented the rule.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WORKFLOW_DIRS = ['.forgejo/workflows', '.github/workflows'];

// The three things a Docker-building job must contain, and what a missing one means.
const RULES = [
  {
    code: 'E_UNBOUNDED_DOCKER_BUILD',
    test: function (job) {
      const builds = steps(job.lines).some(function (s) { return /docker\s+build/.test(s.text); });
      if (!builds) return null;
      const prunes = steps(job.lines).some(function (s) { return /docker\s+builder\s+prune/.test(s.text); });
      if (prunes) return null;
      return 'job "' + job.name + '" runs `docker build` against the host daemon and never prunes the ' +
        'builder cache, so every push leaves layers on the volume Forgejo stores its data on';
    }
  },
  {
    code: 'E_PRUNE_SKIPPED_ON_FAILURE',
    test: function (job) {
      const prunes = steps(job.lines).filter(function (s) { return /docker\s+builder\s+prune/.test(s.text); });
      if (!prunes.length) return null;
      const always = prunes.some(function (s) { return /^\s*if:\s*always\(\)\s*$/m.test(s.text); });
      if (always) return null;
      return 'job "' + job.name + '" prunes the builder cache in a step without `if: always()`, so a failed ' +
        'build - the one that leaves the most behind - skips its own cleanup';
    }
  },
  {
    code: 'E_NO_DISK_REPORT',
    test: function (job) {
      const builds = steps(job.lines).some(function (s) { return /docker\s+build/.test(s.text); });
      const reports = job.lines.join('\n').indexOf('docker system df') !== -1;
      if (!builds || reports) return null;
      return 'job "' + job.name + '" builds an image but never prints `docker system df`, so how much the ' +
        'job left on the host is invisible until the disk is full';
    }
  }
];

function stripComments(text) {
  return text.split('\n').map(function (line) {
    return /^\s*#/.test(line) ? '' : line;
  }).join('\n');
}

// Jobs are the two-space keys under `jobs:`. A step is a `      - ` entry inside one.
function jobBlocks(text) {
  const lines = stripComments(text).split('\n');
  const start = lines.findIndex(function (l) { return /^jobs:\s*$/.test(l); });
  if (start === -1) return [];
  const jobs = [];
  let cur = null;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[i]);
    if (m) {
      if (cur) jobs.push(cur);
      cur = { name: m[1], line: i + 1, lines: [] };
      continue;
    }
    if (cur) cur.lines.push(lines[i]);
  }
  if (cur) jobs.push(cur);
  return jobs;
}

function steps(jobLines) {
  const out = [];
  let cur = null;
  for (const line of jobLines) {
    if (/^ {6}- /.test(line)) {
      if (cur) out.push(cur);
      cur = { text: line };
      continue;
    }
    if (cur) cur.text += '\n' + line;
  }
  if (cur) out.push(cur);
  return out;
}

function audit(text, label) {
  const offenders = [];
  for (const job of jobBlocks(text)) {
    for (const rule of RULES) {
      const detail = rule.test(job);
      if (detail) offenders.push({ file: label, line: job.line, code: rule.code, detail: detail });
    }
  }
  return offenders;
}

function workflowFiles() {
  const files = [];
  for (const dir of WORKFLOW_DIRS) {
    const full = path.join(ROOT, dir);
    if (!fs.existsSync(full)) continue;
    for (const entry of fs.readdirSync(full)) {
      if (/\.ya?ml$/.test(entry)) files.push(path.join(dir, entry).replace(/\\/g, '/'));
    }
  }
  return files;
}

function main() {
  const files = workflowFiles();
  const offenders = [];
  for (const rel of files) {
    offenders.push.apply(offenders, audit(fs.readFileSync(path.join(ROOT, rel), 'utf8'), rel));
  }
  if (!offenders.length) {
    console.log('Every job that builds an image bounds what it leaves behind. (' + files.length + ' workflow file(s))');
    return 0;
  }
  console.error('A CI job writes to the host\'s disk without bounding it:');
  for (const o of offenders) {
    console.error('  ' + o.file + ':' + o.line + '  ' + o.code);
    console.error('    ' + o.detail);
  }
  console.error('\nThe failure this prevents is not "the build broke": it is a forge that');
  console.error('answers `No space left on device` to pushes and stops scheduling the jobs that carry');
  console.error('`needs:`. Clean up in the same job, in a step with `if: always()`, and print');
  console.error('`docker system df` so the next full disk is a line in a log.');
  return 1;
}

module.exports = { audit: audit, jobBlocks: jobBlocks, steps: steps, stripComments: stripComments, RULES: RULES };

if (require.main === module) process.exit(main());
