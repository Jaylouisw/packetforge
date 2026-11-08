'use strict';
// Publish docs/wiki/*.md to the Forgejo wiki.
//
// A Forgejo wiki is a separate git repository (<repo>.wiki.git) that the instance creates the first
// time somebody saves a page through the web UI. Until that page exists the clone URL
// answers "Repository not found", even with wiki enabled - so this script can only do its
// job once the wiki has been created once. It says that plainly instead of failing with a
// git error that looks like a credentials problem.
//
// Pages are authored in docs/wiki/ so they are reviewed in PRs like any other documentation,
// and published with `node scripts/publish-wiki.js`.
//
// Usage:
//   node scripts/publish-wiki.js            # clone/pull, copy pages, commit, push
//   node scripts/publish-wiki.js --dry-run  # show what would change
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'docs', 'wiki');
const REPO = process.env.PF_WIKI_REPO || 'https://git.jayw.uk/jaylouisw/packetforge.wiki.git';
const DRY = process.argv.includes('--dry-run');

function git(args, cwd) {
  return execFileSync('git', args, { cwd: cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function authorArgs() {
  let name = 'packetforge-bot', email = 'packetforge@users.noreply.github.com';
  try {
    name = git(['config', 'user.name'], ROOT).trim() || name;
    email = git(['config', 'user.email'], ROOT).trim() || email;
  } catch (e) { /* fall back to the bot identity */ }
  return ['-c', 'user.name=' + name, '-c', 'user.email=' + email];
}

if (!fs.existsSync(SRC)) {
  console.error('docs/wiki/ is missing - run: node scripts/build-wiki.js');
  process.exit(1);
}

const pages = fs.readdirSync(SRC).filter(function (f) { return f.endsWith('.md'); }).sort();
if (!pages.length) {
  console.error('docs/wiki/ has no .md pages - run: node scripts/build-wiki.js');
  process.exit(1);
}

const work = path.join(os.tmpdir(), 'packetforge-wiki-' + process.pid);
let cloned = false;
try {
  git(['clone', '--quiet', REPO, work], os.tmpdir());
  cloned = true;
} catch (e) {
  const msg = String((e.stderr || e.message || '')).trim();
  console.error('Cannot reach the wiki repository:\n  ' + msg.split('\n').slice(-2).join('\n  '));
  console.error('\nGitHub creates <repo>.wiki.git only after the first page is saved in the web UI.');
  console.error('To unblock: open https://git.jayw.uk/jaylouisw/packetforge/wiki, choose');
  console.error('"Create the first page", save anything (it will be overwritten), then re-run this.');
  console.error('\nThe page sources are already in docs/wiki/ and are valid as-is.');
  process.exit(1);
}

try {
  const changed = [];
  for (const p of pages) {
    const from = path.join(SRC, p);
    const to = path.join(work, p);
    const next = fs.readFileSync(from, 'utf8');
    const prev = fs.existsSync(to) ? fs.readFileSync(to, 'utf8') : null;
    if (prev === next) continue;
    changed.push({ page: p, status: prev === null ? 'new' : 'updated' });
    if (!DRY) fs.writeFileSync(to, next, 'utf8');
  }

  // Pages deleted from docs/wiki are deleted from the wiki: the repo is the source of truth,
  // and a stale wiki page is exactly the problem this script exists to prevent.
  const existing = fs.readdirSync(work).filter(function (f) { return f.endsWith('.md'); });
  const removed = existing.filter(function (f) { return pages.indexOf(f) === -1; });
  if (!DRY) for (const f of removed) fs.unlinkSync(path.join(work, f));

  if (!changed.length && !removed.length) {
    console.log('Wiki is already up to date (' + pages.length + ' pages).');
    process.exit(0);
  }

  console.log((DRY ? 'Would publish' : 'Publishing') + ':');
  for (const c of changed) console.log('  ' + c.status.padEnd(8) + c.page);
  for (const f of removed) console.log('  ' + 'removed'.padEnd(8) + f);

  if (DRY) {
    console.log('\nDry run - nothing written or pushed.');
    process.exit(0);
  }

  git(['add', '-A'], work);
  git(authorArgs().concat(['commit', '--quiet', '-m',
    'Publish wiki from docs/wiki (scripts/build-wiki.js)\n\n' +
    changed.map(function (c) { return '  ' + c.status + ' ' + c.page; })
      .concat(removed.map(function (f) { return '  removed ' + f; })).join('\n')]), work);
  git(['push', '--quiet', 'origin', 'HEAD'], work);
  console.log('\nPublished ' + pages.length + ' pages.');
} finally {
  try { if (cloned) fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* best effort */ }
}
