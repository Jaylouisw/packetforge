#!/usr/bin/env node
'use strict';
/**
 * A guard nobody has seen fail is a guard that might be checking nothing.
 *
 * `scripts/check-no-any.ts` is a lexical check, which means it is right for reasons a reader
 * cannot verify by reading it: it says "this word is a type here" only after working out that the
 * word is not inside a comment, not inside a string, not inside a template literal, and not the
 * name of a property. Each of those is a way to be wrong, and every one of them is a way to be
 * wrong in the direction that hurts: a false positive on a comment gets the guard deleted, and a
 * false negative lets the very thing the rule forbids walk back in.
 *
 * So this plants each banned spelling in a fixture tree it builds in a temp directory, asserts
 * every one comes back with the line it is on, and asserts the things that are not types come back
 * silent: a comment, a string literal, `unknown` narrowed with a guard, a property named `any`, a
 * file whose *name* contains the word, and a `.d.ts`-shaped declaration that never says it.
 *
 * Finally it runs the checker over this repository's own sources - including the checker and this
 * file - because "the rule applies to the rule's implementation" is the only version of it that
 * survives the first exception. A tree with no TypeScript yet has nothing to scan, and that case
 * says so rather than passing quietly.
 *
 * The fixtures live in a temp directory: no network, no writes inside the repository, nothing left
 * behind. Runs standalone: `node test/no-any.test.ts` prints "<n> passed, <m> failed".
 */

const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const os: typeof import('node:os') = require('node:os');
const childProcess: typeof import('node:child_process') = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CHECKER = path.join(ROOT, 'scripts', 'check-no-any.ts');

// TypeScript calls a `.ts` file with no import or export a *script* and shares its top-level names
// with every other one in the program; this file and the checker both declare `fs`, so they would
// collide. A type-only export makes this one a module, and the runtime strips it because it is a
// type - the file is still the CommonJS script `node` loads.
export type NoAnyTestModule = never;

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

interface Run {
  readonly status: number;
  readonly out: string;
  readonly err: string;
}

interface Reported {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly spelling: string;
}

function runChecker(cwd: string, args: readonly string[]): Run {
  const result = childProcess.spawnSync(process.execPath, [CHECKER].concat(args.slice()), {
    cwd,
    encoding: 'utf8',
    timeout: 120000
  });
  return {
    status: typeof result.status === 'number' ? result.status : -1,
    out: String(result.stdout || ''),
    err: String(result.stderr || '')
  };
}

// `file:line:column: what` - parsed from the end, because a Windows path carries a colon of its
// own and the reason after the column may carry another.
const FINDING = /^(.*?):(\d+):(\d+): (.+)$/;
const SUMMARY = /\d+ occurrences? in \d+ files?/;

function reported(run: Run): Reported[] {
  const rows: Reported[] = [];
  for (const raw of (run.err + '\n' + run.out).split('\n')) {
    const match = FINDING.exec(raw.trim());
    if (!match) continue;
    rows.push({
      file: match[1] || '',
      line: Number(match[2]),
      column: Number(match[3]),
      spelling: match[4] || ''
    });
  }
  return rows;
}

// `--list` prints one scanned path per line; the summary line after it is not a path.
function scanned(run: Run): string[] {
  const files: string[] = [];
  for (const raw of run.out.split('\n')) {
    const line = raw.trim();
    if (line && /\.(ts|mts|cts|tsx)$/.test(line)) files.push(line);
  }
  return files;
}

function writeFixture(root: string, name: string, content: string): void {
  const full = path.join(root, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content.endsWith('\n') ? content : content + '\n', 'utf8');
}

// One banned spelling per line, so a report can be matched to the line that caused it. These are
// fixture *text*: nothing in this file is a cast, an annotation or a generic parameter.
const BANNED_LINES: readonly string[] = [
  'const annotated: any = 1;',
  'const asserted = value as any;',
  'const angleBracket = <any>value;',
  'const list: any[] = [];',
  'type Anything = Array<any>;',
  'type Eventually = Promise<any>;',
  'type Bag = Record<string, any>;',
  'function identity<T = any>(value: T): T { return value; }'
];

// What the checker must say about each of those lines. The line numbers are the contract: a report
// that names the wrong line is a report a contributor cannot act on.
const BANNED_EXPECTED: readonly { readonly line: number; readonly spelling: string }[] = [
  { line: 1, spelling: 'type annotation' },
  { line: 2, spelling: 'type assertion' },
  { line: 3, spelling: 'type argument' },
  { line: 4, spelling: 'array of any' },
  { line: 5, spelling: 'type argument' },
  { line: 6, spelling: 'type argument' },
  { line: 7, spelling: 'generic argument' },
  { line: 8, spelling: 'generic default' }
];

// Each of these is a way the word appears in a file without being a type in that file. If the
// checker ever flags one, the guard has become a nuisance and the fix is the checker.
const CLEAN_FIXTURES: readonly { readonly name: string; readonly content: string }[] = [
  {
    name: 'comment-only.ts',
    content: `// A comment is not code: 'const value: any = 1;' is a note about the rule.
/* A block comment may say as any, Array<any>, Record<string, any>, or <any>, and still mean nothing. */
const answer: number = 42;
console.log(answer);`
  },
  {
    name: 'string-only.ts',
    content: `const label = 'cast it: as any';
const detail = "an array of any[] and a Record<string, any>";
console.log(label, detail);`
  },
  {
    name: 'unknown-narrow.ts',
    content: `function describe(value: unknown): string {
  if (typeof value === 'string') return 'a string: ' + value;
  if (typeof value === 'number') return 'a number: ' + String(value);
  return 'something else';
}
console.log(describe(1));`
  },
  {
    name: 'property-named-any.ts',
    content: `interface Row { any: number }
const row: Row = { any: 1 };
const picked: number = row.any;
console.log(picked, row['any']);`
  },
  {
    name: 'many-clean/any-in-a-filename.ts',
    content: `const unrelated: number = 7;
console.log(unrelated);`
  },
  {
    name: 'nested/deep.ts',
    content: `const deep: string = 'deep';
console.log(deep);`
  }
];

function buildFixtures(root: string): void {
  writeFixture(root, 'banned/banned-types.ts', BANNED_LINES.join('\n'));
  for (const fixture of CLEAN_FIXTURES) writeFixture(root, 'clean/' + fixture.name, fixture.content);
}

// Each banned spelling, with the line it sits on.
function everySpellingIsReported(root: string): void {
  console.log('\nEvery banned spelling is reported with its line:');
  const run = runChecker(root, ['banned']);
  const rows = reported(run);

  ok(run.status !== 0, 'the checker exits non-zero when it finds an explicit any', 'exit ' + run.status);
  ok(rows.length === BANNED_LINES.length, 'and reports one occurrence per banned spelling',
    rows.length + ' reported for ' + BANNED_LINES.length + ' planted');
  ok(rows.every((row) => row.file === 'banned/banned-types.ts'), 'and names the file for every one of them',
    rows.map((row) => row.file).join(', '));

  for (const expected of BANNED_EXPECTED) {
    const hit = rows.filter((row) => row.line === expected.line)[0];
    ok(!!hit && hit.spelling.indexOf(expected.spelling) !== -1,
      'line ' + expected.line + ': ' + expected.spelling,
      hit ? hit.spelling : 'nothing reported on that line');
  }

  const first = rows.filter((row) => row.line === 1)[0];
  ok(!!first && first.column === 18, 'the column points at the word, not at the start of the line',
    first ? 'column ' + first.column : 'nothing reported');
  ok(SUMMARY.test(run.err + run.out), 'and the summary counts occurrences in files',
    (run.err + run.out).split('\n').filter((line) => SUMMARY.test(line))[0] || 'no summary line');
}

// Everything that is not a type stays silent - and was genuinely scanned, not skipped.
function everyNonTypeIsSilent(root: string): void {
  console.log('\nWhat is not a type passes:');
  const run = runChecker(root, ['clean']);
  const rows = reported(run);
  const listed = scanned(runChecker(root, ['clean', '--list']));

  ok(run.status === 0, 'a tree with no explicit any exits zero', 'exit ' + run.status);
  ok(rows.length === 0, 'and reports no occurrences', rows.map((row) => row.file + ':' + row.line).join(', '));
  ok(/0 occurrences in 0 files/.test(run.out), 'and says zero in the summary', run.out.trim());

  const covers = (name: string, label: string): void => {
    const present = listed.indexOf('clean/' + name) !== -1;
    const quiet = !rows.some((row) => row.file === 'clean/' + name);
    ok(present && quiet, label, present ? 'reported a hit' : 'not scanned at all');
  };

  covers('comment-only.ts', 'a comment that spells out the banned forms is not a type');
  covers('string-only.ts', 'a string literal that spells them out is not a type');
  covers('unknown-narrow.ts', 'an unknown narrowed with a typeof guard passes');
  covers('property-named-any.ts', 'a property or member named any is a value, not a type');
  covers('many-clean/any-in-a-filename.ts', 'a filename containing the word is not a type');
  covers('nested/deep.ts', 'and directories are walked all the way down');
}

// --list is how a reader confirms the guard looked where it claims to look.
function listsWhatItScanned(root: string): void {
  console.log('\n--list names the files it read:');
  const banned = scanned(runChecker(root, ['banned', '--list']));
  const clean = scanned(runChecker(root, ['clean', '--list']));

  ok(banned.indexOf('banned/banned-types.ts') !== -1, 'the banned fixture is listed', banned.join(', '));
  ok(clean.length === CLEAN_FIXTURES.length, 'and every clean fixture is listed',
    clean.length + ' listed for ' + CLEAN_FIXTURES.length + ' written');
  ok(clean.indexOf('clean/nested/deep.ts') !== -1, 'including the one in a nested directory', clean.join(', '));
}

// The rule applies to the rule's implementation, or it is not a rule.
function thisRepositoryPasses(): void {
  console.log('\nThis repository is clean under its own guard:');
  const run = runChecker(ROOT, []);
  const files = scanned(runChecker(ROOT, ['--list']));

  if (!files.length) {
    ok(run.status === 0, 'the tree has no TypeScript yet, so the scan has nothing to object to');
    console.log('    (no .ts files in the scan path yet - this assertion reads the tree as it stands)');
    return;
  }

  ok(run.status === 0, 'every .ts file in the tree is free of explicit any',
    reported(run).map((row) => row.file + ':' + row.line + ': ' + row.spelling).join('; ') || 'exit ' + run.status);
  ok(files.indexOf('scripts/check-no-any.ts') !== -1, 'the scan reaches the checker itself',
    files.length + ' file(s) scanned');
  ok(files.indexOf('test/no-any.test.ts') !== -1, 'and this test file');
}

// Node before type stripping cannot load a .ts entry point at all; saying so loudly beats a red
// job that blames the guard. Where this runs, the checker runs.
const RUNTIME_CANNOT_LOAD = /ERR_UNKNOWN_FILE_EXTENSION|Unknown file extension|strip-types/;

function main(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-no-any-'));
  let skipped = false;

  try {
    buildFixtures(root);

    const probe = runChecker(root, ['clean']);
    if (probe.status === -1 || RUNTIME_CANNOT_LOAD.test(probe.err + probe.out)) {
      skipped = true;
      console.log('  \u2026 skipped: node ' + process.version + ' cannot execute TypeScript directly');
      console.log('    (the fixtures need a runtime with type stripping; this one has none)');
    } else {
      everySpellingIsReported(root);
      everyNonTypeIsSilent(root);
      listsWhatItScanned(root);
      thisRepositoryPasses();
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
