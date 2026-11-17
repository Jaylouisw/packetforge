'use strict';
// The disk-full page has to answer "what filled it", not only "it is full" (#1507).
//
// `#1507` was open for four days and misdiagnosed for most of them. `df -h` said the volume was
// full, the forge answered four errors that look unrelated (a failed ref write, a 500 staging a temp
// clone, a 405 on merge, checks whose jobs are never created), and every API housekeeping task
// answered `204` while freeing nothing.
//
// The first version of this page got the attribution right (96% of the instance was one private
// repository) and the *reason* wrong: it read a 46.2 GiB repository `size` next to a 15 MB tip tree
// and concluded the bytes were reachable history, so it recommended a `git filter-repo` rewrite. The
// full history of that repository packs to 4.2 MiB and its largest blob is 3.9 MB. The other 46 GiB
// is LFS: 5,816 pointer files at the tip, 5,345 unique objects, 56.5 GiB declared. A rewrite would
// have deleted the manifests, kept every LFS object, and freed nothing.
//
// That is the failure this test locks: `size` includes LFS storage, so a small tree proves nothing
// on its own, and the page must send the reader to the pointer files before recommending a rewrite.
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
ok(/\bgc\b[^.]{0,80}cannot reclaim/i.test(section), 'and says why collecting garbage frees nothing');
ok(section.indexOf('#1507') !== -1, 'the decision it defers to is tracked, not implied');

// The attribution is not finished until LFS has been ruled in or out: `size` counts LFS storage, and
// on this repository it is 96% of the number. A page that stops at the tree split sends the reader to
// rewrite history for bytes that are not in history.
ok(/\bLFS\b/.test(section), 'it checks LFS storage, which an API `size` includes');
ok(section.indexOf('git-lfs.github.com/spec/v1') !== -1, 'and shows the pointer files that identify it');
ok(/\b5,816\b/.test(section) && /\b5,345\b/.test(section),
  'it reports the measured pointer and object counts rather than a factor');
ok(/filter-repo[^.]{0,200}(cannot|does not|would not|frees nothing|free nothing|no [a-z]+ bytes)/i.test(section)
  || /(cannot|does not|would not|frees nothing|free nothing)[^.]{0,200}filter-repo/i.test(section),
  'it says a history rewrite cannot reclaim LFS bytes');
// The withdrawn numbers: they are what made the wrong recommendation look measured.
ok(section.indexOf('6.4 MB') === -1 && section.indexOf('7,400') === -1,
  'the withdrawn "6.4 MB tip against 46.2 GiB stored" reading is gone');

console.log((failed ? '\u2717 ' : '') + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
