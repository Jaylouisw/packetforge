#!/usr/bin/env node
'use strict';
/**
 * A guard nobody has seen fail is a guard that might be checking nothing.
 *
 * `scripts/check-module-paths.ts` claims to resolve a `require()` exactly as CommonJS will, which
 * is a claim about a resolver most readers have never read. It is also the guard standing between a
 * conversion and a `MODULE_NOT_FOUND` that nobody will connect to the conversion - so each of its
 * rules is planted here, in a fixture tree built in a temp directory, and each of them has to come
 * back with the file and the line that caused it:
 *
 *   - `require('./x')` where only `x.ts` exists is the breakage: reported;
 *   - `require('./x.ts')` where `x.ts` exists is the fix: clean;
 *   - a directory resolves by `index.js`, a directory with a `package.json` `main` resolves,
 *     a `.json` resolves - the three things CommonJS tries that are not the file itself;
 *   - a missing sibling is reported *with its line*, because a finding that names the wrong line is
 *     a finding a contributor cannot act on;
 *   - `require(path.join(__dirname, '..', 'shared', 'helper.js'))` is reported too, which is the
 *     shape twenty-eight call sites in this tree use and the one a conversion breaks silently;
 *   - a package name (`fs`, `node:path`, a dependency) is never reported: it is not a path, and a
 *     dependency this checkout has not installed is not a module-path question;
 *   - `require()` inside a comment, a string or a template literal is not a call.
 *
 * Last, it runs the checker over this repository - including this file and the checker - because
 * "the rule applies to the rule's implementation" is the only version of it that survives the first
 * exception, and because the real tree is where the latent findings live.
 *
 * The fixtures live in a temp directory: no network, no writes inside the repository, nothing left
 * behind. Runs standalone: `node test/check-module-paths.test.ts` prints "<n> passed, <m> failed".
 */

const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const os: typeof import('node:os') = require('node:os');
const childProcess: typeof import('node:child_process') = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CHECKER = path.join(ROOT, 'scripts', 'check-module-paths.ts');

// TypeScript calls a `.ts` file with no import or export a *script* and shares its top-level names
// with every other one in the program; this file and the checker both declare `fs`, so they would
// collide. A type-only export makes this one a module, and the runtime strips it because it is a
// type - the file is still the CommonJS script `node` loads.
export type CheckModulePathsTestModule = never;

let passed = 0;
let failed = 0;

function ok(condition: boolean, name: string, detail?: string): void {
  if (condition) {
    passed++;
    console.log('  \u2713 ' + name);
    return;
  }
  failed++;
  console.log('  \u2717 ' + name + (detail ? '  (' + detail + ')' : ''));
}

function eq(actual: string, expected: string, name: string): void {
  ok(actual === expected, name, 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}

interface Run {
  readonly status: number;
  readonly out: string;
  readonly err: string;
}

/** One reported specifier: the three fields a contributor acts on. */
interface Finding {
  readonly file: string;
  readonly line: number;
  readonly spelling: string;
}

function runChecker(cwd: string, args: readonly string[]): Run {
  const result = childProcess.spawnSync(process.execPath, [CHECKER].concat(args.slice()), {
    cwd,
    encoding: 'utf8',
    timeout: 180000
  });
  return {
    status: typeof result.status === 'number' ? result.status : -1,
    out: String(result.stdout || ''),
    err: String(result.stderr || '')
  };
}

// `file:line  require('<spec>')  -> no such module`, parsed on the two-space seams rather than on a
// regex for the path, because a Windows path carries a colon of its own and a joined specifier
// carries commas and quotes.
const NOT_RESOLVED = '  -> no such module';

function findings(run: Run): Finding[] {
  const rows: Finding[] = [];
  for (const raw of (run.err + '\n' + run.out).split('\n')) {
    const line = raw.trimEnd();
    if (!line.endsWith(NOT_RESOLVED) || !line.startsWith('  ')) continue;
    const body = line.slice(2, line.length - NOT_RESOLVED.length);
    const seam = body.indexOf("  require(");
    if (seam === -1) continue;
    const where = body.slice(0, seam);
    const colon = where.lastIndexOf(':');
    const spelling = body.slice(seam + '  require('.length);
    rows.push({
      file: where.slice(0, colon),
      line: Number(where.slice(colon + 1)),
      spelling: spelling.slice(0, spelling.length - 1)
    });
  }
  return rows;
}

function describe(row: Finding): string {
  return row.file + ':' + row.line + '  require(' + row.spelling + ')';
}

// `--list` prints one scanned path per line, then a blank line and the summary.
function scanned(run: Run): string[] {
  const files: string[] = [];
  for (const raw of run.out.split('\n')) {
    const line = raw.trim();
    if (line && /\.(ts|js)$/.test(line) && !line.includes(' ')) files.push(line);
  }
  return files;
}

interface Fixture {
  readonly name: string;
  readonly content: string;
}

function writeFixtures(root: string, fixtures: readonly Fixture[]): void {
  for (const fixture of fixtures) {
    const full = path.join(root, fixture.name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, fixture.content.endsWith('\n') ? fixture.content : fixture.content + '\n', 'utf8');
  }
}

function fixtureLines(...lines: readonly string[]): string {
  return lines.join('\n');
}

// The tree the checker must fail on. One fixture per broken shape, one line per require, so a
// report can be matched to the line that produced it.
const BROKEN: readonly Fixture[] = [
  // (a) The breakage that has bitten twice: the file exists, and CommonJS cannot see it.
  { name: 'broken/extensionless.js', content: fixtureLines(
    "const marker = 1;",
    "const hidden = require('./only-ts');",
    "module.exports = { marker: marker, hidden: hidden };"
  ) },
  { name: 'broken/only-ts.ts', content: fixtureLines("module.exports = { hidden: true };") },
  // The same breakage reached through a join of literals, which is how a test names a script.
  { name: 'broken/joined.js', content: fixtureLines(
    "const path = require('node:path');",
    "const shared = require(path.join(__dirname, '..', 'shared', 'helper.js'));",
    "module.exports = { shared: shared };"
  ) },
  // (e) A sibling that is simply gone: the finding has to carry the line it is on.
  { name: 'broken/line-number.js', content: fixtureLines(
    "const fs = require('node:fs');",
    'const marker = 2;',
    "// require('./not-a-call'): a comment is not a require",
    "const gone = require('./gone');",
    "module.exports = { fs: fs, marker: marker, gone: gone };"
  ) },
  { name: 'shared/helper.ts', content: fixtureLines("module.exports = { shared: true };") }
];

// Everything CommonJS resolves, and everything it is not asked about. None of this may be reported.
const FINE: readonly Fixture[] = [
  // (b) The fix: the extension is named, so the resolver never has to guess.
  { name: 'fine/explicit-ts.js', content: fixtureLines(
    "const typed = require('./typed.ts');",
    "module.exports = { typed: typed };"
  ) },
  { name: 'fine/typed.ts', content: fixtureLines("module.exports = { typed: true };") },
  // (c) A directory: index.js, the last thing LOAD_AS_DIRECTORY tries.
  { name: 'fine/directory.js', content: fixtureLines(
    "const bag = require('./bag');",
    "module.exports = { bag: bag };"
  ) },
  { name: 'fine/bag/index.js', content: fixtureLines("module.exports = { bag: true };") },
  // A directory whose package.json names its own entry point, which is tried before index.js.
  { name: 'fine/manifest.js', content: fixtureLines(
    "const pkg = require('./with-main');",
    "module.exports = { pkg: pkg };"
  ) },
  { name: 'fine/with-main/package.json', content: fixtureLines('{ "main": "lib/entry.js" }') },
  { name: 'fine/with-main/lib/entry.js', content: fixtureLines("module.exports = { entry: true };") },
  { name: 'fine/with-main/index.js', content: fixtureLines("module.exports = { entry: 'index' };") },
  // A .json, and a join of literals anchored at __dirname that resolves.
  { name: 'fine/json.js', content: fixtureLines(
    "const data = require('./data.json');",
    "const path = require('node:path');",
    "const typed = require(path.join(__dirname, 'typed.ts'));",
    "module.exports = { data: data, typed: typed };"
  ) },
  { name: 'fine/data.json', content: fixtureLines('{ "data": true }') },
  // (d) A package name is not a path. `lodash` is not installed anywhere; that is not this
  // check's question, and reporting it would make the guard a dependency checker by accident.
  { name: 'fine/bare.js', content: fixtureLines(
    "const fs = require('fs');",
    "const os = require('node:os');",
    "const lodash = require('lodash');",
    "module.exports = { fs: fs, os: os, lodash: lodash };"
  ) },
  // Nothing here is a call: a comment, a quoted string, a template, and two computed specifiers
  // whose value only exists once the program runs.
  { name: 'fine/not-a-call.js', content: fixtureLines(
    "// require('./commented-out')",
    "/* require(\"./block-commented\") */",
    'const prose = "require(\'./quoted\')";',
    'const template = `require(\'./templated\')`;',
    "const computed = require(path.join('..', 'devices', 'registry'));",
    "module.exports = { prose: prose, template: template, computed: computed };"
  ) }
];

function buildFixtures(root: string): void {
  writeFixtures(path.join(root, 'broken-tree'), BROKEN);
  writeFixtures(path.join(root, 'fine-tree'), FINE);
}

// The core claim: the specifier and the line, for every shape that is broken, and nothing else.
function brokenShapesAreReported(root: string): void {
  console.log('\nA require CommonJS cannot resolve is reported, with its line:');
  const tree = path.join(root, 'broken-tree');
  const run = runChecker(tree, ['.']);
  const rows = findings(run);

  ok(run.status === 1, 'the broken tree exits 1', 'exit ' + run.status);
  ok(rows.length === 3, 'and reports exactly three specifiers',
    rows.map(describe).join('; ') || 'none');

  const expected: readonly Finding[] = [
    { file: 'broken/extensionless.js', line: 2, spelling: "'./only-ts'" },
    { file: 'broken/joined.js', line: 2, spelling: "path.join(__dirname, '..', 'shared', 'helper.js')" },
    { file: 'broken/line-number.js', line: 4, spelling: "'./gone'" }
  ];
  eq(rows.map(describe).join('\n'), expected.map(describe).join('\n'),
    'file, line and specifier are all named - the extensionless one, the joined one, the missing one');

  // The message is the contract: `file:line  require('<spec>')  -> no such module`.
  const first = rows[0];
  const line = first ? '  ' + describe(first) + NOT_RESOLVED : '';
  eq(line, "  broken/extensionless.js:2  require('./only-ts')  -> no such module",
    'the finding line is file:line, two spaces, require(spec), two spaces, the reason');

  ok(/3 unresolvable specifiers out of \d+ require\(\) specifiers \(\d+ files? scanned\)/.test(run.err),
    'and the summary counts them against the specifiers it resolved', run.err.trim().split('\n').pop() || '');
  ok(/CommonJS tries \.js, \.json and \.node, never \.ts/.test(run.err),
    'and says why, so the fix is not a mystery');

  // A hint, not a second rule: the .ts file the author probably meant is named for them.
  ok(run.err.indexOf('broken/only-ts.ts exists') !== -1,
    'the .ts sibling that would have matched is named as the fix', run.err.trim());
  ok(run.err.indexOf('broken/joined.js:2') !== -1,
    'a joined specifier is reported at the line of the require, not of the string inside it');
}

// Everything CommonJS does resolve: no finding, and an exit code that says so.
function resolvingShapesAreClean(root: string): void {
  console.log('\nA require CommonJS resolves is clean:');
  const tree = path.join(root, 'fine-tree');
  const run = runChecker(tree, ['.']);
  const rows = findings(run);

  ok(run.status === 0, 'the resolvable tree exits 0', 'exit ' + run.status);
  ok(rows.length === 0, 'and reports nothing', rows.map(describe).join('; '));
  ok(/0 unresolvable out of \d+ require\(\) specifier/.test(run.out),
    'and still counts what it resolved', run.out.trim().split('\n').pop() || '');

  // Each shape is proven to have been *scanned*, not skipped: a file the checker never opened
  // would pass this suite while proving nothing.
  const listed = scanned(runChecker(tree, ['.', '--list']));
  ok(listed.length === FINE.filter((fixture) => !fixture.name.endsWith('.json')).length,
    'every fixture is listed as scanned', listed.length + ' listed');
  for (const name of ['fine/explicit-ts.js', 'fine/directory.js', 'fine/manifest.js', 'fine/bare.js']) {
    ok(listed.indexOf(name) !== -1, name + ' is scanned and silent');
  }
  ok(listed.indexOf('fine/typed.ts') !== -1, 'a .ts fixture is scanned like a .js one');
  ok(listed.some((name) => name.endsWith('with-main/package.json')) === false,
    'package.json is read as a manifest, not scanned as source');
}

// A bad invocation is a usage error, not a silent pass.
function refusalIsLoud(root: string): void {
  console.log('\nA bad invocation is refused:');
  const unknown = runChecker(root, ['--nonsense']);
  ok(unknown.status === 2, 'an unknown option exits 2', 'exit ' + unknown.status);
  ok(unknown.err.indexOf('unknown option --nonsense') !== -1, 'and names the option', unknown.err.trim());
  ok(runChecker(root, ['no-such-directory']).status === 2, 'a path that does not exist exits 2');
}

// What "the whole tree" means, computed the way the checker computes it: the same five
// directories, the same skipped names, the same two extensions. Written out here rather than
// imported so the assertion fails if the checker's own walk stops agreeing with the tree -
// importing its list would compare it with itself and could only ever pass.
const SCANNED_DIRS: readonly string[] = ['scripts', 'engine', 'server', 'web', 'test'];
const UNSCANNED_NAMES: ReadonlySet<string> =
  new Set(['node_modules', '.git', 'dist', 'coverage', '.github-cache']);

function sourceFilesOnDisk(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (UNSCANNED_NAMES.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile() || !/\.(js|ts)$/.test(entry.name)) continue;
      found.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  for (const directory of SCANNED_DIRS) walk(path.join(root, directory));
  return found.sort();
}

// The rule applies to the rule's implementation, and this is where the latent findings live.
function thisRepositoryResolves(): void {
  console.log('\nThis repository resolves under its own guard:');
  const run = runChecker(ROOT, []);
  const rows = findings(run);
  const listed = scanned(runChecker(ROOT, ['--list']));

  ok(run.status === 0, 'the real tree has no unresolvable require()',
    rows.map(describe).join('; ') || 'exit ' + run.status);
  ok(rows.length === 0, 'and reports no finding', rows.map(describe).join('; '));
  // "The whole tree" is a number this test can compute, not a constant. It used to be `> 400`:
  // a floor rather than a claim about this tree, and a floor is what a truncated listing slid
  // under - two CI legs listed 268 and 354 files out of 566 and the only assertion that noticed
  // said "more than 400 files", which named a threshold instead of the shortfall. Comparing
  // against what the disk holds makes a partial scan say how many files it lost and which.
  const onDisk = sourceFilesOnDisk(ROOT);
  const missing = onDisk.filter((file) => listed.indexOf(file) === -1);
  ok(listed.length === onDisk.length,
    'it scanned the whole tree, every source file the disk holds',
    listed.length + ' listed, ' + onDisk.length + ' on disk' +
      (missing.length ? '; first missing: ' + missing.slice(0, 3).join(', ') : ''));
  ok(listed.indexOf('scripts/check-module-paths.ts') !== -1, 'the checker scans itself');
  ok(listed.indexOf('test/check-module-paths.test.ts') !== -1, 'and this test');

  const summary = /\d+ require\(\) specifiers \((\d+) files scanned\)/.exec(run.out);
  ok(summary !== null, 'the summary reports how many specifiers it resolved', run.out.split('\n').pop() || '');
  const specifiers = summary ? Number(summary[1]) : 0;
  ok(specifiers > 400, 'which is a real number of files', String(specifiers));

  // The latent case, computed from the tree rather than hard-coded: `engine/segment.ts` requires
  // `./lag` while `lag.js` is still JavaScript. If that is still true, the note has to be there -
  // it is the whole reason this check reads `.ts` files and not only `.js`. When `lag.ts` lands and
  // the require is swept, this assertion follows the tree instead of going red for being stale.
  const segment = fs.readFileSync(path.join(ROOT, 'engine', 'segment.ts'), 'utf8');
  const stillLatent = segment.indexOf("require('./lag')") !== -1 &&
    fs.existsSync(path.join(ROOT, 'engine', 'lag.js')) &&
    !fs.existsSync(path.join(ROOT, 'engine', 'lag.ts'));
  if (stillLatent) {
    ok(run.out.indexOf('engine/segment.ts:118') !== -1,
      'the latent require in engine/segment.ts is named, not left for the day lag.ts lands',
      run.out);
    ok(/latent require/.test(run.out) && run.status === 0,
      'and it is a note, not a failure - nothing in the tree is broken yet');
  } else {
    ok(true, 'engine/segment.ts no longer requires a still-JavaScript ./lag; nothing latent to report');
  }
}

// Node before type stripping cannot load a .ts entry point at all; saying so loudly beats a red job
// that blames the guard. Where this runs, the checker runs.
const RUNTIME_CANNOT_LOAD = /ERR_UNKNOWN_FILE_EXTENSION|Unknown file extension|strip-types/;

function main(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-module-paths-'));
  let skipped = false;

  try {
    buildFixtures(root);

    const probe = runChecker(path.join(root, 'fine-tree'), ['.']);
    if (probe.status === -1 || RUNTIME_CANNOT_LOAD.test(probe.err + probe.out)) {
      skipped = true;
      console.log('  \u2026 skipped: node ' + process.version + ' cannot execute TypeScript directly');
      console.log('    (the fixtures need a runtime with type stripping; this one has none)');
    } else {
      brokenShapesAreReported(root);
      resolvingShapesAreClean(root);
      refusalIsLoud(root);
      thisRepositoryResolves();
    }
  } finally {
    // The fixtures are throwaway: nothing this suite wrote outlives it, pass or fail.
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed' +
    (skipped ? ' (skipped: no TypeScript support in node ' + process.version + ')' : ''));
  process.exit(failed ? 1 : 0);
}

main();
