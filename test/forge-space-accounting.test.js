'use strict';
// The disk-full page has to answer "what filled it", not only "it is full" (#1507).
//
// `#1507` was open for four days and misdiagnosed for most of them. `df -h` said the volume was
// full, the forge answered four errors that look unrelated (a failed ref write, a 500 staging a temp
// clone, a 405 on merge, checks whose jobs are never created), and every API housekeeping task
// answered `204` while freeing nothing. The missing measurement was the one the host steps could not
// give from inside the repository: 96% of the instance was one private repository, and the number was
// in its *history* rather than its tree, which is why collecting garbage could never help.
//
// That distinction is a fact about running this forge, not a passing observation, and it is what this
// page exists for. So it is locked: a page that says `df -h`, `du` the temp clones and restart would
// pass every other gate - no test reads prose - and leave the next reader exactly where that one
// started. The assertions below are the shape of the answer, not its wording.
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const DOC = path.join(__dirname, '..', 'docs', 'FORGE_TROUBLESHOOTING.md');
const doc = fs.readFileSync(DOC, 'utf8');

const start = doc.indexOf('### Which repository owns the space');
ok(start !== -1, 'the disk-full page says how to attribute the space to a repository');

const nextHeading = start === -1 ? -1 : doc.indexOf('\n## ', start);
const section = start === -1 ? '' : doc.slice(start, nextHeading === -1 ? doc.length : nextHeading);
ok(section.length > 400, 'and the section is an answer, not a heading', String(section.length) + ' chars');

// The API is the only way to see this from inside the repository, which is the whole point.
ok(section.indexOf('sort=size') !== -1, 'it uses the API query that ranks repositories by size');
ok(section.indexOf('full_name') !== -1, 'and prints the repository name next to the size');
// `size` is kilobytes; a divisor that is not 1048576 turns 46.2 GiB into 46.2 MB. The number has to
// be right or the reader concludes the wrong repository is the problem.
ok(section.indexOf('x.size/1048576') !== -1, 'the kilobytes are converted with 1048576, not 1000 or 1e6');
ok(section.indexOf('du -sh /data/git/repositories/') !== -1, 'it offers the host-side measurement as a cross-check');

// Stored size versus tree size is the difference that decides what reclaims it.
ok(section.indexOf('count-objects -vH') !== -1, 'it separates the pack size from the tip tree size');
ok(section.indexOf('ls-tree -r -l HEAD') !== -1, 'with the command that measures the tree');
ok(/gc\b[^.]{0,80}cannot reclaim/i.test(section), 'and says why collecting garbage frees nothing');
ok(section.indexOf('#1507') !== -1, 'the decision it defers to is tracked, not implied');

console.log((failed ? '\u2717 ' : '') + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
