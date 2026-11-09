'use strict';
// A tracked file called `C：/Users/jay/AppData/Local/hermes/cache/scratch/verify-slaac.js`
// sat in this repository: a scratch script from a local machine, committed under a directory
// whose name is the literal string "C：" - a drive letter with a fullwidth colon, which is what
// a Windows path becomes when it is mangled on the way in.
//
// Nothing noticed. It was not in `test/`, so no runner saw it; it was not in `scripts/`, so no
// audit looked at it; and `docs/DEVICE_REGISTRY.md` does not mention it. It was in the
// repository for months, and the only reason it could be is that no check asks what a path
// *looks* like.
//
// This is that check, and it is deliberately about shape rather than about that one file: any
// future path that is obviously somebody's local filesystem is a mistake, whatever its name.
const path = require('path');
const { execFileSync } = require('child_process');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; }
  else { failed++; console.log('  not ok - ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  return out.split('\u0000').filter(Boolean);
}

let files = [];
try {
  files = trackedFiles();
} catch (e) {
  console.log('  (skipped: git is not available here - ' + e.message.split('\n')[0] + ')');
}

console.log('');
console.log('No tracked path is somebody\'s local filesystem (' + files.length + ' files):');

// A drive letter, ASCII or the fullwidth colon a mangled Windows path picks up.
const ABSOLUTE = /^[A-Za-z][:：]/;
// Home directories as a first segment. "Users" is fine one level down in a doc path; as the
// top of a tracked path it means a local tree leaked in.
const HOME_ROOTS = /^(Users|home|root)\//;
const LOCAL_NOISE = /(^|\/)(AppData|AppData\/Local|\.cache)\//i;
const SCRATCH = /cache\/scratch/i;

const bad = files.filter(function (f) {
  return ABSOLUTE.test(f) || HOME_ROOTS.test(f) || LOCAL_NOISE.test(f) || SCRATCH.test(f);
});

ok(bad.length === 0, 'no tracked path starts with a drive letter or a home directory', bad.slice(0, 5).join(' | '));

console.log('');
console.log('And the shape rules are themselves correct, so this cannot pass vacuously:');
ok(ABSOLUTE.test('C:/Users/jay/x.js') === true, 'an ASCII drive letter is caught');
ok(ABSOLUTE.test('C：/Users/jay/x.js') === true, 'the fullwidth colon variant is caught');
ok(ABSOLUTE.test('catalogue/foo.json') === false, 'a normal relative path is not');
ok(HOME_ROOTS.test('Users/jay/x.js') === true, 'a bare Users/ root is caught');
ok(HOME_ROOTS.test('docs/Users-guide.md') === false, 'a filename that merely contains the word is not');
ok(SCRATCH.test('C：/Users/jay/AppData/Local/hermes/cache/scratch/verify-slaac.js') === true,
  'the path that actually shipped is caught by the rule');

console.log('');
console.log('The tree is not just renamed - those paths are gone from history\'s working set:');
ok(files.every(function (f) { return f.indexOf('verify-slaac') === -1; }),
  'the scratch script is not tracked under any path');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
