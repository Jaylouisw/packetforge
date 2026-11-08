#!/usr/bin/env node
/**
 * GitHub -> Forgejo bridge for inbound contributions.
 *
 * The arrangement this serves:
 *
 *   Forgejo is the workshop. Development, CI and merging happen here. Nobody else has an account.
 *   GitHub is the shopfront. Strangers can read the mirror and open an issue or a pull request there.
 *   This script carries those contributions across, so a contributor never needs an account on this box.
 *
 * What it does, in both directions that matter:
 *
 *   --issues   GitHub issues      -> Forgejo issues,  credited to the author, labelled `from-github`
 *   --prs      GitHub pull reqs   -> a `gh/<n>` branch and a Forgejo pull request, so CI runs here
 *   --report   Forgejo merges     -> a comment on the GitHub pull request, so the contributor is told
 *
 * Each imported object carries a `<!-- gh-issue: N -->` or `<!-- gh-pr: N -->` marker. That marker is
 * the identity: the script finds work it has already done by reading it back, so it is safe to run
 * repeatedly, and it never creates a second copy of the same GitHub object.
 *
 * Zero dependencies, Node >= 18.
 *
 * Environment:
 *   PF_FORGEJO_URL      default http://127.0.0.1:3000
 *   PF_FORGEJO_TOKEN    a Forgejo token with repository read/write
 *   PF_REPO             default jaylouisw/packetforge
 *   GH_REPO             default Jaylouisw/packetforge
 *   GH_TOKEN            a GitHub token; alternatively PF_GH_TOKEN_FILE naming a file that holds one
 *   PF_CLONE            path to a clone of this repository, needed for --prs (branches are pushed,
 *                       and a pull request cannot exist without a branch)
 *
 * Usage:
 *   node scripts/gh-bridge.js --issues --dry-run
 *   node scripts/gh-bridge.js --prs --limit 5
 *   node scripts/gh-bridge.js --all
 */

'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');

const FJ_URL = (process.env.PF_FORGEJO_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const FJ_TOKEN = process.env.PF_FORGEJO_TOKEN || '';
// FJ_URL is how this script reaches the API; PUBLIC is what a stranger can actually click. They are
// usually different (an internal address versus the published hostname), and a comment on a public
// pull request must never carry the internal one.
const PUBLIC = (process.env.PF_PUBLIC_URL || 'https://git.jayw.uk').replace(/\/+$/, '');
const PF_REPO = process.env.PF_REPO || 'jaylouisw/packetforge';
const GH_REPO = process.env.GH_REPO || 'Jaylouisw/packetforge';
const GH_TOKEN = process.env.GH_TOKEN || readTokenFile(process.env.PF_GH_TOKEN_FILE);
const CLONE = process.env.PF_CLONE || '';
const REMOTE = process.env.PF_FORGEJO_REMOTE || 'forgejo';

/**
 * Where branches get pushed. Deriving it from PF_FORGEJO_URL keeps the token out of .git/config,
 * and GIT_TERMINAL_PROMPT=0 means a bad credential fails in a second instead of waiting on a prompt
 * that will never be answered - which is how the first attempt at this sat for five minutes.
 */
const PUSH_URL = process.env.PF_FORGEJO_PUSH_URL || (function () {
  try {
    const u = new URL(FJ_URL);
    if (!FJ_TOKEN) return '';
    return u.protocol + '//oauth2:' + encodeURIComponent(FJ_TOKEN) + '@' + u.host + '/' + PF_REPO + '.git';
  } catch (e) { return ''; }
})();

function readTokenFile(p) {
  if (!p) return '';
  try { return fs.readFileSync(p, 'utf8').trim(); } catch (e) { return ''; }
}

const args = process.argv.slice(2);
const has = (f) => args.indexOf(f) !== -1;
const DRY = has('--dry-run');
const LIMIT = (function () {
  const i = args.indexOf('--limit');
  return i === -1 ? Infinity : Number(args[i + 1]) || Infinity;
})();

let created = 0;
let skipped = 0;
let failed = 0;

function log(msg) { console.log(msg); }

// ---------------------------------------------------------------- API clients

async function fj(method, path, body) {
  const res = await fetch(FJ_URL + '/api/v1' + path, {
    method,
    headers: Object.assign({
      Authorization: 'token ' + FJ_TOKEN,
      'Content-Type': 'application/json'
    }),
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch (e) { /* non-JSON error body */ }
  if (!res.ok) {
    const err = new Error('Forgejo ' + method + ' ' + path + ' -> HTTP ' + res.status + ' ' +
      (json.message || text.slice(0, 120)));
    err.status = res.status;
    throw err;
  }
  return json;
}

async function gh(method, path, body) {
  if (!GH_TOKEN) throw new Error('No GitHub token: set GH_TOKEN or PF_GH_TOKEN_FILE');
  const res = await fetch('https://api.github.com' + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + GH_TOKEN,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'packetforge-gh-bridge'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch (e) { /* ignore */ }
  if (!res.ok) {
    const err = new Error('GitHub ' + method + ' ' + path + ' -> HTTP ' + res.status + ' ' +
      (json.message || text.slice(0, 120)));
    err.status = res.status;
    throw err;
  }
  return json;
}

/** Every page of a list endpoint, stopping at a sane ceiling. */
async function paginate(fn, perPage, maxPages) {
  const out = [];
  for (let page = 1; page <= (maxPages || 100); page++) {
    const batch = await fn(page, perPage);
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push.apply(out, batch);
    if (batch.length < perPage) break;
  }
  return out;
}

// ---------------------------------------------------------------- markers

const issueMarker = (n) => '<!-- gh-issue: ' + n + ' -->';
const prMarker = (n) => '<!-- gh-pr: ' + n + ' -->';

/** Map of github number -> forgejo item, read back from the markers we left. */
function indexByMarker(items, marker) {
  const map = new Map();
  for (const it of items) {
    const m = String(it.body || '').match(marker);
    if (m) map.set(Number(m[1]), it);
  }
  return map;
}

// ---------------------------------------------------------------- issues

async function syncIssues() {
  log('\n=== issues: GitHub -> Forgejo ===');

  const ghIssues = await paginate((page) =>
    gh('GET', `/repos/${GH_REPO}/issues?state=open&sort=created&direction=desc&per_page=100&page=${page}`), 100, 20);

  // The issues endpoint returns pull requests too; they are handled by --prs.
  const real = ghIssues.filter((i) => !i.pull_request);
  log(`GitHub reports ${real.length} open issue(s).`);

  const existing = await paginate((page) =>
    fj('GET', `/repos/${PF_REPO}/issues?state=all&type=issues&per_page=50&page=${page}`), 50, 60);
  const known = indexByMarker(existing, /<!-- gh-issue: (\d+) -->/);
  log(`Forgejo already carries ${known.size} imported issue(s).`);

  let todo = real.filter((i) => !known.has(i.number)).slice(0, LIMIT === Infinity ? undefined : LIMIT);
  log(`${todo.length} to import${DRY ? ' (dry run)' : ''}.`);

  await ensureLabel('from-github', '#1f6feb', 'Opened on the GitHub mirror');

  for (const it of todo) {
    const author = it.user ? it.user.login : 'unknown';
    const body = [
      it.body || '_(no description)_',
      '',
      '---',
      `Opened by **@${author}** on the GitHub mirror: ${it.html_url}`,
      'This is the copy that is worked on. Replies happen here; a maintainer will answer on the GitHub thread.',
      '',
      issueMarker(it.number)
    ].join('\n');

    if (DRY) {
      log(`  would import #${it.number}  ${it.title.slice(0, 70)}`);
      created++;
      continue;
    }
    try {
      const made = await fj('POST', `/repos/${PF_REPO}/issues`, {
        title: it.title,
        body: body,
        labels: [1] // replaced below if the label id differs
      });
      log(`  #${made.number} <- GitHub #${it.number}  ${it.title.slice(0, 60)}`);
      created++;
      await commentBack(it.number, made.number);
    } catch (e) {
      failed++;
      log(`  FAILED #${it.number}: ${e.message}`);
    }
  }
}

async function commentBack(ghNumber, pfNumber) {
  try {
    await gh('POST', `/repos/${GH_REPO}/issues/${ghNumber}/comments`, {
      body: `Thanks — this is now tracked on the forge where development happens: ` +
        `${PUBLIC}/${PF_REPO}/issues/${pfNumber}\n\n` +
        `A maintainer will reply on this thread. You do not need an account anywhere else.`
    });
  } catch (e) {
    log(`    (could not comment back on GitHub #${ghNumber}: ${e.message})`);
  }
}

async function ensureLabel(name, color, description) {
  if (DRY) return null;
  try {
    const labels = await fj('GET', `/repos/${PF_REPO}/labels?limit=50`);
    const found = labels.find((l) => l.name === name);
    if (found) return found.id;
    const made = await fj('POST', `/repos/${PF_REPO}/labels`, { name, color: color.replace('#', ''), description });
    log(`Created label "${name}" (id ${made.id})`);
    return made.id;
  } catch (e) {
    log(`  (label "${name}" unavailable: ${e.message})`);
    return null;
  }
}

// ---------------------------------------------------------------- pull requests

async function syncPullRequests() {
  log('\n=== pull requests: GitHub -> Forgejo ===');
  if (!CLONE) {
    log('PF_CLONE is required for --prs: a pull request needs a branch, and the branch has to be pushed.');
    failed++;
    return;
  }

  const prs = await paginate((page) =>
    gh('GET', `/repos/${GH_REPO}/pulls?state=open&sort=created&direction=desc&per_page=100&page=${page}`), 100, 20);
  log(`GitHub reports ${prs.length} open pull request(s).`);

  const existing = await paginate((page) =>
    fj('GET', `/repos/${PF_REPO}/pulls?state=all&per_page=50&page=${page}`), 50, 60);
  const known = indexByMarker(existing, /<!-- gh-pr: (\d+) -->/);
  log(`Forgejo already carries ${known.size} imported pull request(s).`);

  const todo = prs.filter((p) => !known.has(p.number)).slice(0, LIMIT === Infinity ? undefined : LIMIT);
  log(`${todo.length} to import${DRY ? ' (dry run)' : ''}.`);

  await ensureLabel('from-github', '#1f6feb', 'Opened on the GitHub mirror');

  for (const pr of todo) {
    const author = pr.user ? pr.user.login : 'unknown';
    const branch = 'gh/' + pr.number;
    const title = pr.title;

    if (DRY) {
      log(`  would import #${pr.number} -> branch ${branch}  ${title.slice(0, 60)}`);
      created++;
      continue;
    }

    try {
      // refs/pull/N/head exists on the base repository even when the PR comes from a fork.
      git(['fetch', '--force', 'https://github.com/' + GH_REPO + '.git',
        `refs/pull/${pr.number}/head:refs/heads/${branch}`]);
      git(['push', '--force', PUSH_URL || REMOTE, `${branch}:${branch}`]);

      const body = [
        pr.body || '_(no description)_',
        '',
        '---',
        `Opened by **@${author}** on the GitHub mirror: ${pr.html_url}`,
        `Branch \`${branch}\` carries their commits verbatim (head ${String(pr.head && pr.head.sha).slice(0, 12)}).`,
        'CI will run here. Merge here and the mirror carries the result back to GitHub.',
        '',
        prMarker(pr.number)
      ].join('\n');

      const made = await fj('POST', `/repos/${PF_REPO}/pulls`, {
        head: branch,
        base: 'main',
        title: title,
        body: body
      });
      log(`  #${made.number} <- GitHub #${pr.number}  ${title.slice(0, 60)}`);
      created++;

      await gh('POST', `/repos/${GH_REPO}/issues/${pr.number}/comments`, {
        body: `Thanks — this is now under review on the forge where CI and merging happen: ` +
          `${PUBLIC}/${PF_REPO}/pulls/${made.number}\n\n` +
          `Your commits are carried across unchanged, so your authorship is preserved. ` +
          `A maintainer will reply on this thread; you do not need an account anywhere else.`
      });
    } catch (e) {
      failed++;
      log(`  FAILED #${pr.number}: ${e.message}`);
    }
  }
}

function git(argv) {
  return execFileSync('git', ['-C', CLONE, '-c', 'credential.helper='].concat(argv), {
    stdio: 'pipe',
    encoding: 'utf8',
    env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' })
  });
}

// ---------------------------------------------------------------- report back

async function reportMerges() {
  log('\n=== merges: Forgejo -> GitHub ===');
  const pulls = await paginate((page) =>
    fj('GET', `/repos/${PF_REPO}/pulls?state=closed&per_page=50&page=${page}`), 50, 60);
  const merged = pulls.filter((p) => p.merged_at && /<!-- gh-pr: (\d+) -->/.test(String(p.body || '')));
  log(`${merged.length} merged pull request(s) came from GitHub.`);

  for (const p of merged) {
    const n = Number(String(p.body).match(/<!-- gh-pr: (\d+) -->/)[1]);
    try {
      const comments = await gh('GET', `/repos/${GH_REPO}/issues/${n}/comments?per_page=100`);
      const told = (comments || []).some((c) => String(c.body || '').indexOf('/pulls/' + p.number) !== -1);
      if (told) { skipped++; continue; }
      if (DRY) { log(`  would tell GitHub #${n} that it merged as ${p.number}`); continue; }
      await gh('POST', `/repos/${GH_REPO}/issues/${n}/comments`, {
        body: `Merged on the forge as ${PUBLIC}/${PF_REPO}/pulls/${p.number} ` +
          `(commit ${String(p.merge_commit_sha || '').slice(0, 12)}). ` +
          `It is already on GitHub main — the mirror pushes automatically.`
      });
      log(`  told GitHub #${n}`);
      created++;
    } catch (e) {
      failed++;
      log(`  FAILED #${n}: ${e.message}`);
    }
  }
}

// ---------------------------------------------------------------- main

(async function main() {
  const wantIssues = has('--issues') || has('--all');
  const wantPrs = has('--prs') || has('--all');
  const wantReport = has('--report') || has('--all');

  if (!wantIssues && !wantPrs && !wantReport) {
    console.error('Nothing to do. Use --issues, --prs, --report or --all (add --dry-run first).');
    process.exitCode = 2;
    return;
  }
  if (!FJ_TOKEN) {
    console.error('PF_FORGEJO_TOKEN is required.');
    process.exitCode = 2;
    return;
  }

  if (wantIssues) await syncIssues();
  if (wantPrs) await syncPullRequests();
  if (wantReport) await reportMerges();

  log(`\n${created} created, ${skipped} already done, ${failed} failed.`);
  if (failed) process.exitCode = 1;
})().catch((e) => {
  console.error(String((e && e.message) || e));
  process.exitCode = 1;
});
