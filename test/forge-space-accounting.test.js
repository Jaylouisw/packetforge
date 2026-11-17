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
// The cross-check is a *host* command, and `/data` is the container's own path. On the host a du at
// `/data/git/repositories` matches nothing and prints its miss, while the same page records the bind
// `.../forgejo/data -> /data` further down - so a reader who follows "from the host" here gets an
// empty answer and reads it as "no repository owns the space". That is the empty-result-as-
// measurement mistake the rest of this section exists to correct.
const lines = section.split('\n');
ok(section.indexOf('/mnt/cache/appdata/forgejo/data') !== -1
  && section.indexOf('du -s "$base"/git/repositories') !== -1,
  'the host-side cross-check runs at the bind source, not at the container path');
ok(lines.filter((l) => l.indexOf('/data/git/repositories') !== -1)
  .every((l) => l.indexOf('docker exec') !== -1 || l.trim().startsWith('#')),
  'and a /data/ path is offered only inside the container, never as a host command');
ok(section.indexOf('echo "absent: $base/git/repositories"') !== -1,
  'a candidate path that is not there is reported, not silently empty');

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

// Locating the bytes is the last step, and it is the one that was wrong: the page sent the reader to
// `du -sh /data/gitea/lfs` on the *host*, but `/data` only exists inside the container (the page's own
// bind, `docker inspect forgejo` a section later, reads `/mnt/user/appdata/forgejo/data -> /data`). On
// the host that command matches nothing and, with `2>/dev/null`, exits 0 printing nothing - an empty
// answer indistinguishable from "there is no LFS here", which is the very confusion this section is
// fixing.
ok(section.indexOf('/mnt/user/appdata/forgejo/data/gitea') !== -1,
  'the LFS locate command uses the host path the bind maps to, not the container path');
ok(section.indexOf('du -sh /data/gitea') === -1,
  'and no longer points the reader at a container path that does not exist on the host');
ok(section.toLowerCase().indexOf('absent') !== -1,
  'a directory that is not there says so in words rather than printing nothing');
// LFS is not necessarily on the volume being cleaned at all - STORAGE_TYPE decides that, and a bucket
// means the 46 GiB is somewhere `df -h` on this host cannot see.
ok(section.indexOf('[lfs]') !== -1 && /STORAGE_TYPE/.test(section),
  'it checks [lfs] STORAGE_TYPE, which can put the objects off this volume entirely');
ok(!/`\/data\/gitea\/lfs` or/.test(section),
  'the "container path is the host path" phrasing is gone');

// The same defect sits one section earlier, in the first-instructions block headed "On the host, in
// this order:". It still opened with `df -h /data` and a `du` at `/data/gitea/data/tmp/local-repo/*`
// with `2>/dev/null`. `/data` is the container's mount point (the page's own bind is
// `.../forgejo/data -> /data`), so on a host `df` errors to stderr and the `du` prints nothing at all -
// a reader concludes "the failed attempts left nothing behind" and goes hunting for space that is
// sitting in half-clones. Neither the block nor any test covered it: `section` starts at
// "### Which repository owns the space", which is *below* this block.
// Two sections open with "On the host, in this order"; anchor on the disk-full one, whose
// preceding paragraph is unique to it, or the assertions below read the wrong block.
const triageFrom = doc.indexOf('One attempt tells you the answer');
const hostStart = triageFrom === -1 ? -1 : doc.indexOf('On the host, in this order', triageFrom);
ok(hostStart !== -1, 'the page still has the first host-side triage block');
const hostEnd = hostStart === -1 ? -1 : doc.indexOf('Then restart Forgejo', hostStart);
const hostBlock = hostStart === -1 ? '' : doc.slice(hostStart, hostEnd === -1 ? doc.length : hostEnd);
ok(hostBlock.length > 150, 'and the triage block is instructions, not a sentence', String(hostBlock.length) + ' chars');
ok(hostBlock.indexOf('local-repo') !== -1,
  'and it is the disk-full triage block, not the other section that opens the same way');
ok(hostBlock.indexOf('/mnt/cache/appdata/forgejo/data') !== -1
  && hostBlock.indexOf('du -sh "$tmp"/*') !== -1,
  'its measurements run at the bind sources, where a host shell can actually see /data');
ok(hostBlock.indexOf('echo "absent: $tmp"') !== -1,
  'a bind path that is not there is reported in words, not as an empty line');
// A path argument that starts at the root: `gitea/data/tmp/...` is a host path and must not trip this.
const hostLines = hostBlock.split(String.fromCharCode(10));
const containerPathLines = hostLines.filter((l) => {
  const i = l.indexOf('/data/');
  if (i === -1) return false;
  const before = i === 0 ? '' : l.charAt(i - 1);
  return !/[A-Za-z]/.test(before);
});
ok(containerPathLines.every((l) => l.indexOf('docker exec') !== -1 || l.trim().indexOf('#') === 0),
  'no line in the triage block sends a host shell to a /data/ path');
ok(hostBlock.indexOf('2>/dev/null') === -1 || hostBlock.indexOf('[ -d "$tmp" ]') !== -1,
  'the only silenced command is one whose directory was already proved to exist');

console.log((failed ? '\u2717 ' : '') + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
