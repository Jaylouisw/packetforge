'use strict';
// The Docker build job needs a docker daemon, and the Forgejo runner's job image does not
// have one: `docker` is not on PATH inside node:20-bookworm and /var/run/docker.sock is not
// mounted. So `docker build` failed on every pull request for reasons that had nothing to do
// with the change - a permanently red check that blocks everything, which is how a CI gate
// turns into wallpaper.
//
// This script is what the job runs when it cannot build: it checks the things that a build
// would have caught early and that can be verified from the files alone - the base image is
// pinned, the container does not run as root, there is a healthcheck, every COPY source
// exists in the repository, and there is a command to run. It does NOT prove the image
// builds; the workflow still builds for real wherever a daemon is available, and this says
// so in its output rather than pretending.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let failed = 0;
function ok(cond, msg) {
  if (cond) console.log('  \u2713 ' + msg);
  else { failed++; console.error('  \u2717 ' + msg); }
}

const file = path.join(ROOT, 'Dockerfile');
if (!fs.existsSync(file)) {
  console.error('  \u2717 no Dockerfile at the repository root');
  process.exit(1);
}
const text = fs.readFileSync(file, 'utf8');
const lines = text.split(/\r?\n/);

// Instructions, with continuations joined, comments dropped.
const instructions = [];
let pending = '';
for (const raw of lines) {
  const line = raw.replace(/\s+$/, '');
  if (!line || line.trimStart().startsWith('#')) continue;
  pending += (pending ? ' ' : '') + line.trim();
  if (pending.endsWith('\\')) { pending = pending.slice(0, -1); continue; }
  const m = pending.match(/^([A-Za-z]+)\s+(.*)$/);
  if (m) instructions.push({ op: m[1].toUpperCase(), arg: m[2] });
  pending = '';
}
const ops = instructions.map(function (i) { return i.op; });
function argsOf(op) {
  return instructions.filter(function (i) { return i.op === op; }).map(function (i) { return i.arg; });
}

console.log('Dockerfile static checks (' + instructions.length + ' instructions)');

// -- base image ---------------------------------------------------------------
const froms = argsOf('FROM');
ok(froms.length > 0, 'has a FROM');
const images = froms.map(function (a) { return a.split(/\s+/)[0]; }).filter(function (i) { return i !== 'scratch'; });
ok(images.length > 0, 'uses a real base image (' + images.join(', ') + ')');
const unpinned = images.filter(function (i) { return !/[:@]/.test(i) || /:latest$/.test(i); });
ok(unpinned.length === 0, 'base image is pinned, not :latest or bare' +
  (unpinned.length ? ' (unpinned: ' + unpinned.join(', ') + ')' : ''));

// -- runs as non-root ---------------------------------------------------------
const users = argsOf('USER');
ok(users.length > 0, 'declares a USER');
const rootUser = users.filter(function (u) { return /^(root|0)(:0)?$/.test(u.trim()); });
ok(rootUser.length === 0, 'does not run as root' +
  (rootUser.length ? ' (USER ' + rootUser.join(',') + ')' : ''));

// -- healthcheck + entrypoint -------------------------------------------------
ok(ops.indexOf('HEALTHCHECK') !== -1, 'declares a HEALTHCHECK');
ok(ops.indexOf('CMD') !== -1 || ops.indexOf('ENTRYPOINT') !== -1, 'has a CMD or ENTRYPOINT');

// -- every COPY source exists ------------------------------------------------
const copies = instructions.filter(function (i) { return i.op === 'COPY' || i.op === 'ADD'; });
let missing = [];
for (const c of copies) {
  // COPY [--flags] src... dest
  const parts = c.arg.split(/\s+/).filter(function (p) { return !p.startsWith('--'); });
  if (parts.length < 2) continue;
  const srcs = parts.slice(0, -1);
  for (const s of srcs) {
    if (/^https?:\/\//.test(s)) continue;      // ADD from a URL: nothing local to check
    if (s === '.') continue;                   // whole context, always present
    const clean = s.replace(/^\.?\//, '');
    if (!fs.existsSync(path.join(ROOT, clean))) missing.push(s);
  }
}
ok(missing.length === 0, 'every COPY/ADD source exists in the repository' +
  (missing.length ? ' (missing: ' + missing.join(', ') + ')' : '') +
  ' [' + copies.length + ' COPY/ADD instruction(s)]');

// -- the image's entrypoint is a file we ship --------------------------------
const cmds = argsOf('CMD').concat(argsOf('ENTRYPOINT'));
const script = cmds.join(' ').match(/[\w./-]+\.js/);
if (script) {
  const p = script[0].replace(/^\.?\//, '');
  ok(fs.existsSync(path.join(ROOT, p)), 'the entrypoint script exists (' + p + ')');
} else {
  ok(true, 'no .js entrypoint to check (' + (cmds.join(' ') || 'none') + ')');
}

if (failed) {
  console.error('\n' + failed + ' Dockerfile check(s) failed');
  process.exit(1);
}
console.log('\nDockerfile checks passed. The image itself was not built here - ' +
  'run `docker build -t packetforge:ci .` where a daemon is available.');
