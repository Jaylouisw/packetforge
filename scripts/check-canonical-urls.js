#!/usr/bin/env node
/**
 * Every URL in the repo has to point at the place the project actually lives.
 *
 * This guard was written when the project left GitHub for a self-hosted Forgejo instance: the README
 * told people to clone from GitHub, the hardware-request button opened a GitHub issue form,
 * SECURITY.md sent vulnerability reports to a GitHub advisory form, and package.json advertised a
 * GitHub repository. None of that was where work happened, so the first instruction a contributor
 * followed took them somewhere else - and nothing failed when it happened, because a stale URL is
 * invisible to every other test.
 *
 * On 2026-11-27 the move was reversed: GitHub is the workshop again, and the Forgejo instance is a
 * retained read-only archive. So the rule is **inverted, not deleted** - the same failure, the other
 * way round. A Forgejo URL in a tracked file is now the stale one.
 *
 * This makes it a build failure, in both directions. The canonical base lives in
 * `scripts/canonical.ts`; change it there and this reports every place that needs to follow.
 */
'use strict';

const fs = require('fs');
const path = require('path');
// `.ts`, extension and all: CommonJS resolves `.js`, `.json` and `.node`, so a bare
// `require('./canonical')` would not find the TypeScript file. The runtime strips the
// annotations, so what comes back here is the same plain object it always was.
const canonical = require('./canonical.ts');

const ROOT = path.join(__dirname, '..');

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage', '.github-cache']);
// `.ts` is in this list because the canonical definition itself is now TypeScript: a stale URL in
// a converted file is the same stale URL, and a guard that stopped looking at the file it reads
// its own base from would be the one blind spot it could not report.
const CHECK_EXT = new Set(['.md', '.js', '.ts', '.json', '.yml', '.yaml', '.html', '.txt']);

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

// The first offending string on the line, so the report can quote the URL instead of the paragraph
// around it. A guard that says "line 39" and nothing else makes the reader go and find out *what*
// about line 39, which is the moment they stop reading the report.
function quoteFor(line) {
  const m = line.match(/(?:https?:\/\/)?git\.jayw\.uk\/jaylouisw\/packetforge[^\s)`'"<>]*|(?:https?:\/\/)?odin:3000[^\s)`'"<>]*/i);
  return m ? m[0] : '';
}

function isExempt(rel) {
  if (canonical.EXEMPT_FILES.has(rel)) return true;
  return canonical.EXEMPT_PREFIXES.some(function (p) { return rel.indexOf(p) === 0; });
}

// `root` is optional so the guard's own test can plant drift in a throwaway directory without
// touching a tracked file. It is only used for that probe: every other caller checks the tree.
function check(root) {
  const base = root || ROOT;
  const files = walk(base, []).sort();
  const problems = [];

  for (const file of files) {
    const rel = path.relative(base, file).split(path.sep).join('/');
    if (isExempt(rel)) continue;
    // Reasoned exceptions: each entry in canonical.ALLOW says why that file must name the archive.
    // A file cannot be quietly added here without a reason a reader can judge.
    const allowed = Object.prototype.hasOwnProperty.call(canonical.ALLOW, rel);

    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      continue;
    }
    // A cheap pre-filter. It has to cover every rule below, or the file is skipped before the rule
    // sees it - which is exactly how the GitHub-CLI rule passed silently at first. `FORGE_CLAIMS`
    // needs the word, the URL rules need a host, and the badge rule needs `/workflows/`.
    if (text.indexOf('git.jayw.uk') === -1 && text.indexOf('odin:3000') === -1 &&
        text.indexOf('Forgejo') === -1 && text.indexOf('forgejo') === -1 &&
        text.indexOf('/workflows/') === -1) continue;

    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // 1. A URL that sends a reader to the archive's repository, or - in a document - to an
      //    address only the lab network can resolve. The second list is scoped to `.md` on purpose:
      //    the tracker scripts legitimately address the internal API, while a page a reader is
      //    meant to follow may not hand them a hostname that resolves to nothing outside one LAN.
      if (!allowed) {
        const isDoc = path.extname(file).toLowerCase() === '.md';
        const rules = isDoc ? canonical.FORBIDDEN.concat(canonical.FORBIDDEN_IN_DOCS) : canonical.FORBIDDEN;
        for (const pattern of rules) {
          if (pattern.test(line)) {
            const url = quoteFor(line);
            problems.push({
              file: rel, line: i + 1, code: 'E_STALE_FORGE_URL',
              detail: 'points at the retired Forgejo archive' + (url ? ' (' + url + ')' : '') +
                '; the canonical home is ' + canonical.BASE,
              text: line.trim()
            });
            break;
          }
        }
      }

      // 2. Prose that makes the archive the place work happens. `allowed` does not excuse this: a
      //    document about the archive may name it and may date the move, but it may not claim the
      //    work continues there. A working link to the wrong workshop is worse than a dead one.
      for (const pattern of canonical.FORGE_CLAIMS) {
        if (pattern.test(line)) {
          problems.push({
            file: rel, line: i + 1, code: 'E_FORGE_AS_HOME',
            detail: 'describes the archive as the workshop; development, CI and issues are on ' +
              canonical.BASE,
            text: line.trim()
          });
          break;
        }
      }
    }
  }

  // 3. The clone instructions and badges, which are the two most-followed URLs in the project,
  //    must match the canonical base exactly rather than merely not being Forgejo.
  const readme = path.join(base, 'README.md');
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
        detail: 'README does not carry a CI badge from ' + canonical.BASE +
          ' (' + canonical.badge('ci.yml') + ')',
        text: ''
      });
    }
  }

  // 4. A badge is a link that renders its own verdict. GitHub draws a workflow badge it cannot find
  //    as `invalid` or not at all, so a badge left behind by a deleted workflow is worse than no
  //    badge: it either tells every visitor the project is broken or shows nothing while the README
  //    claims CI is watched. The README carried one for codeql.yml, a workflow deleted with the
  //    move off GitHub, and it read `failure` on the front page for weeks. Every workflow URL has to
  //    name a workflow file that exists - in whichever directory this tree keeps them.
  const WORKFLOW_URL = /(?:badges|actions)\/workflows\/([A-Za-z0-9._-]+\.ya?ml)/g;
  for (const file of files) {
    const rel = path.relative(base, file).split(path.sep).join('/');
    if (canonical.EXEMPT_FILES.has(rel)) continue;
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      continue;
    }
    if (text.indexOf('/workflows/') === -1) continue;
    const seen = new Set();
    let m;
    WORKFLOW_URL.lastIndex = 0;
    while ((m = WORKFLOW_URL.exec(text)) !== null) {
      const wf = m[1];
      if (seen.has(wf)) continue;
      seen.add(wf);
      const here = path.join(ROOT, '.forgejo', 'workflows', wf);
      const upstream = path.join(ROOT, '.github', 'workflows', wf);
      if (fs.existsSync(here) || fs.existsSync(upstream)) continue;
      problems.push({
        file: rel, line: 0, code: 'E_BADGE_NO_WORKFLOW',
        detail: 'links workflow ' + wf + ', which is not in .github/workflows/ or .forgejo/workflows/',
        text: wf
      });
    }
  }

  // 5. The tracker instructions an agent reads have to name the tool that reaches the tracker. This
  //    guard used to fire on `gh` here; now the absence of `gh` is the defect, because the token
  //    file and the curl recipes that replaced it reach an archive nobody is merging into.
  const tracker = path.join(base, 'docs', 'agents', 'issue-tracker.md');
  if (fs.existsSync(tracker)) {
    const text = fs.readFileSync(tracker, 'utf8');
    if (text.indexOf(canonical.BASE) === -1) {
      problems.push({
        file: 'docs/agents/issue-tracker.md', line: 0, code: 'E_TRACKER_NOT_CANONICAL',
        detail: 'the tracker doc does not name ' + canonical.BASE,
        text: ''
      });
    }
    if (!/\bgh\s+(issue|pr|auth)\b/.test(text)) {
      problems.push({
        file: 'docs/agents/issue-tracker.md', line: 0, code: 'E_TRACKER_NO_GH',
        detail: 'the tracker doc does not tell an agent to use the `gh` CLI, which is how this ' +
          'project now reads and writes ' + canonical.BASE,
        text: ''
      });
    }
  }

  return { ok: problems.length === 0, problems: problems, scanned: files.length };
}

if (require.main === module) {
  const res = check();
  if (res.ok) {
    console.log('OK \u2014 ' + res.scanned + ' files, every project URL points at ' + canonical.BASE +
      ' and none at the archive (' + canonical.ARCHIVE.web + ')');
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
