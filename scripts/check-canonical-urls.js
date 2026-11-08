#!/usr/bin/env node
/**
 * Every URL in the repo has to point at the place the project actually lives.
 *
 * Development moved to Forgejo and the links did not follow: the README told people to clone from
 * GitHub, the hardware-request button opened a GitHub issue form, SECURITY.md sent vulnerability
 * reports to a GitHub advisory form, and package.json advertised a GitHub repository. None of those
 * is where work happens, so the first instruction a contributor followed took them somewhere else -
 * and nothing failed when it happened, because a stale URL is invisible to every other test.
 *
 * This makes it a build failure. The canonical base lives in `scripts/canonical.js`; change it there
 * and this reports every place that needs to follow.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const canonical = require('./canonical');

const ROOT = path.join(__dirname, '..');

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage', '.github-cache']);
const CHECK_EXT = new Set(['.md', '.js', '.json', '.yml', '.yaml', '.html', '.txt']);

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github' && entry.name !== '.forgejo') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (CHECK_EXT.has(path.extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

function check() {
  const files = walk(ROOT, []).sort();
  const problems = [];

  for (const file of files) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    if (canonical.EXEMPT_FILES.has(rel)) continue;
    // Reasoned exceptions: each entry in canonical.ALLOW says why that file must name the old
    // location. A file cannot be quietly added here without a reason a reader can judge.
    const allowed = Object.prototype.hasOwnProperty.call(canonical.ALLOW, rel);

    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      continue;
    }
    // A cheap pre-filter. It has to cover every rule below, or the file is skipped before the
    // rule sees it - which is exactly how the GitHub-CLI rule passed silently at first.
    if (text.indexOf('github.com') === -1 && text.indexOf('GitHub') === -1 &&
        text.indexOf('gh auth') === -1) continue;

    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // 1. The old repository URL, in any of its forms.
      for (const pattern of allowed ? [] : canonical.FORBIDDEN) {
        if (pattern.test(line)) {
          problems.push({
            file: rel, line: i + 1, code: 'E_STALE_REPO_URL',
            detail: 'points at the old GitHub repository; the canonical home is ' + canonical.BASE,
            text: line.trim()
          });
          break;
        }
      }

      // 2. Instructions that only make sense on GitHub's tooling.
      if (!allowed && /\bgh auth status\b|\bapi\.github\.com\b/.test(line)) {
        problems.push({
          file: rel, line: i + 1, code: 'E_GITHUB_ONLY_TOOLING',
          detail: 'Forgejo does not run the `gh` CLI; use `tea` or the REST API',
          text: line.trim()
        });
      }
    }
  }

  // 3. The clone instructions and badges, which are the two most-followed URLs in the project,
  //    must match the canonical base exactly rather than merely not being GitHub.
  const readme = path.join(ROOT, 'README.md');
  if (fs.existsSync(readme)) {
    const text = fs.readFileSync(readme, 'utf8');
    if (text.indexOf(canonical.clone()) === -1) {
      problems.push({
        file: 'README.md', line: 0, code: 'E_NO_CANONICAL_CLONE',
        detail: 'README does not contain the canonical clone URL ' + canonical.clone(),
        text: ''
      });
    }
    if (text.indexOf(canonical.badge('ci.yml')) === -1) {
      problems.push({
        file: 'README.md', line: 0, code: 'E_NO_CANONICAL_BADGE',
        detail: 'README does not carry a CI badge from ' + canonical.BASE,
        text: ''
      });
    }
  }

  return { ok: problems.length === 0, problems: problems, scanned: files.length };
}

if (require.main === module) {
  const res = check();
  if (res.ok) {
    console.log('OK — ' + res.scanned + ' files, every project URL points at ' + canonical.BASE);
    process.exit(0);
  }
  console.error('Canonical URL drift (' + res.problems.length + '):');
  for (const p of res.problems) {
    console.error('  ' + p.file + (p.line ? ':' + p.line : '') + '  ' + p.code);
    console.error('    ' + p.detail);
    if (p.text) console.error('    > ' + p.text);
  }
  process.exit(1);
}

module.exports = { check: check };
