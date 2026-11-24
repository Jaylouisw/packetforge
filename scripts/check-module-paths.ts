#!/usr/bin/env node
'use strict';
/**
 * Does every `require()` in this tree actually resolve?
 *
 * Why this exists
 * ---------------
 * Converting a file to TypeScript renames it, and CommonJS will not follow the rename. Node's
 * resolver, for a path, tries exactly four things and then gives up:
 *
 *     <path>          the literal path, if it names a file
 *     <path>.js
 *     <path>.json
 *     <path>.node
 *
 * and then, for a directory, `package.json`'s `main`, then `index.js`, `index.json`, `index.node`.
 * `.ts` is not in that list and never will be: `package.json` says `"type": "commonjs"`, and the
 * CommonJS resolver has no notion of the extension. So `require('./segment')` against a file named
 * `segment.ts` throws `MODULE_NOT_FOUND` at run time, and `require('./segment.ts')` works.
 *
 * That has now broken two conversions, both caught by a suite going red rather than by a reader:
 * the require was in a file the conversion did not touch, and the diff looked complete.
 *
 * The worse half is the *latent* one. `engine/segment.ts` says `require('./lag')`, which is correct
 * today because `lag.js` is JavaScript - and dies the day somebody converts `lag.js`, in a file
 * nobody edited, for a reason nobody will connect to the conversion. No reviewer is going to notice
 * that, because the line is not in the diff. So it gets a section of its own below: a relative
 * require *inside a converted file* that still lands on a `.js` file is a debt this reports, not a
 * debt this fails.
 *
 * What it resolves
 * ----------------
 *   - every `require('<literal>')` in `scripts/`, `engine/`, `server/`, `web/` and `test/`, in
 *     `.js` and `.ts` alike, found by reading the source rather than by importing it: comments,
 *     quoted strings and template literals are skipped, so prose about `require('./x')` is not a
 *     call, and a fixture that writes a `require()` into a file is not a call either;
 *   - `require(path.join(__dirname, '..', 'scripts', 'x.js'))`, which is how twenty-eight call
 *     sites in this tree reach a script, and which breaks on a conversion exactly as a bare
 *     relative require does. Only the fully literal, `__dirname`-anchored form is followed: a
 *     `path.join` of anything else is an expression, and an expression needs the program run;
 *   - a path specifier relative to the requiring file, a directory by `package.json` `main` and
 *     then `index.*`, and an exact file path whatever its extension - which is why
 *     `require('./x.ts')` is clean and `require('./x')` against `x.ts` is not.
 *
 * What it does not resolve
 * ------------------------
 *   - bare specifiers (`fs`, `node:path`, `typescript`): out of scope by definition, never
 *     reported. A dependency this checkout has not installed is not this check's question;
 *   - anything computed: `require(name)`, `require('./a' + b)`, a `path.join` whose first part is
 *     a variable such as `ROOT` or a working directory this cannot know;
 *   - `require.resolve`, `import`, and ESM `export` paths: not CommonJS loads;
 *   - a package's `exports` map: it does not apply to a path relative to the requiring file.
 *
 * Known shape of the scanner, stated so nobody mistakes it for a parser: an unbalanced quote or a
 * regex holding an apostrophe can make it read text as code. It errs towards reporting - a finding
 * a reader can check by hand - rather than towards silence, and every finding it prints names a
 * specifier a reader can paste into `node -e "require('...')"`.
 *
 * Usage:
 *   node scripts/check-module-paths.ts               # this repository, exit 1 on any finding
 *   node scripts/check-module-paths.ts <dir|file>    # one tree or one file (the tests do this)
 *   node scripts/check-module-paths.ts --list        # print every file scanned, then the findings
 */

const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');

// A `.ts` file with no import or export is a *script* to TypeScript, and its top-level names land
// in one global scope shared with every other script in the program - two of them would collide on
// `fs` alone. A type-only export marks this file as a module; the runtime strips it because it is a
// type, so nothing changes at run time and `node` still loads this as the plain CommonJS script it
// is written as.
export type CheckModulePathsModule = never;

const ROOT: string = path.join(__dirname, '..');

// The directories that carry code somebody loads by path. Root-level files are out of scope on
// purpose: they are docs, config and the entry point, and a converted root file is visible in its
// own diff.
const SCAN_DIRS: readonly string[] = ['scripts', 'engine', 'server', 'web', 'test'];
const SOURCE_EXTENSIONS: readonly string[] = ['.js', '.ts'];
const SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git', 'dist', 'coverage', '.github-cache']);

/**
 * Exactly what CommonJS appends to a specifier, in order, and the whole of it.
 *
 * This list is the check. `.ts` is absent because it is absent from the resolver: the loader that
 * runs this repository's TypeScript is the strip-types one, and it loads a `.ts` file it is handed
 * by name - it is never asked what extension to guess.
 */
const COMMONJS_EXTENSIONS: readonly string[] = ['.js', '.json', '.node'];

const USAGE = [
  'Usage:',
  '  node scripts/check-module-paths.ts              resolve this repository as CommonJS will',
  '  node scripts/check-module-paths.ts <dir|file>   resolve one tree or one file',
  '  node scripts/check-module-paths.ts --list       print every file scanned, then the findings'
].join('\n');

/**
 * How one `require()` call spells its specifier: a quoted literal, or a `path.join`/`path.resolve`
 * of literals anchored at `__dirname`. Anything else is an expression, and an expression is not a
 * path until the program has run.
 */
type Specifier =
  | { readonly kind: 'literal'; readonly text: string; readonly line: number }
  | { readonly kind: 'join'; readonly parts: readonly string[]; readonly line: number };

/** One require that CommonJS will not resolve: the finding that fails the run. */
interface Unresolved {
  readonly file: string;
  readonly line: number;
  readonly spelling: string;
  /** The `.ts` file that would have been found, when the fix is exactly "name the extension". */
  readonly tsSibling: string | null;
}

/** One require that resolves today and will not survive its target being converted. */
interface Latent {
  readonly file: string;
  readonly line: number;
  readonly spelling: string;
  readonly target: string;
}

type FrameKind = 'code' | 'template';

/** Where the scanner is: in code, or in a template literal, and how deep in braces. */
interface Frame {
  readonly kind: FrameKind;
  braces: number;
}

const WORD_START = /[A-Za-z_$]/;
const WORD_PART = /[A-Za-z0-9_$]/;

// A `/` opens a regular expression rather than dividing after one of these. Getting this wrong
// matters: a regex holding an apostrophe would open a string literal and swallow the rest of the
// file, and a `require()` after it would then be read as a comment or as nothing at all.
const REGEX_AFTER_WORDS: ReadonlySet<string> = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case',
  'do', 'else', 'yield', 'await'
]);
const REGEX_AFTER_PUNCTUATION: ReadonlySet<string> = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>'
]);

function countNewlines(source: string, from: number, to: number): number {
  let lines = 0;
  for (let index = from; index < to && index < source.length; index++) {
    if (source[index] === '\n') lines++;
  }
  return lines;
}

/** Index just past a quoted string that starts at `start`. Stops at the line end if unterminated. */
function skipQuoted(source: string, start: number): number {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character === quote) return index + 1;
    if (character === '\n') return index;
    index++;
  }
  return index;
}

/** Index just past a regex literal that starts at `start` (the `/`), or `start + 1` if it is not one. */
function skipRegex(source: string, start: number): number {
  let index = start + 1;
  let inClass = false;
  while (index < source.length) {
    const character = source[index];
    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character === '\n') return start + 1; // not a literal after all; treat the `/` as division
    if (character === '[') inClass = true;
    else if (character === ']') inClass = false;
    else if (character === '/' && !inClass) {
      index++;
      while (index < source.length && WORD_PART.test(source[index] || '')) index++;
      return index;
    }
    index++;
  }
  return start + 1;
}

/** The previous significant character, ignoring whitespace, for the regex heuristic. */
function previousSignificant(source: string, from: number): string {
  for (let index = from - 1; index >= 0; index--) {
    const character = source[index] || '';
    if (!/\s/.test(character)) return character;
  }
  return '';
}

/** A quoted literal at `from`, or null. The value is not unescaped: no specifier here needs it. */
function literalAt(source: string, from: number): { readonly text: string; readonly end: number } | null {
  const quote = source[from];
  if (quote !== "'" && quote !== '"') return null;
  const end = skipQuoted(source, from);
  const closed = source[end - 1] === quote;
  const text = source.slice(from + 1, closed ? end - 1 : end);
  if (text.indexOf('\n') !== -1) return null;
  return { text: text, end: closed ? end : source.length };
}

/**
 * The arguments of `path.join(...)` / `path.resolve(...)` when every one of them is a literal or
 * `__dirname`, or null when anything in there has to be computed.
 *
 * This is the shape twenty-eight call sites in this tree use to reach a script by path, and it
 * breaks on a conversion exactly as a bare relative require does - the file name is a string in a
 * test, so nothing in the converted file's own diff mentions it.
 */
function joinArguments(source: string, from: number): { readonly parts: readonly string[]; readonly end: number } | null {
  const parts: string[] = [];
  let index = from;
  for (;;) {
    while (index < source.length && /\s/.test(source[index] || '')) index++;
    if (source[index] === ')') return { parts: parts, end: index + 1 };
    if (source.startsWith('__dirname', index)) {
      parts.push('__dirname');
      index += '__dirname'.length;
    } else {
      const literal = literalAt(source, index);
      if (!literal) return null;
      parts.push(literal.text);
      index = literal.end;
    }
    while (index < source.length && /\s/.test(source[index] || '')) index++;
    if (source[index] === ',') {
      index++;
      continue;
    }
    if (source[index] === ')') return { parts: parts, end: index + 1 };
    return null;
  }
}

/** The `path.join(...)` / `path.resolve(...)` call starting at `from`, or null. */
function joinCallAt(source: string, from: number): { readonly parts: readonly string[]; readonly end: number } | null {
  if (!source.startsWith('path.', from)) return null;
  const nameStart = from + 'path.'.length;
  const isJoin = source.startsWith('join(', nameStart);
  const isResolve = source.startsWith('resolve(', nameStart);
  if (!isJoin && !isResolve) return null;
  const open = nameStart + (isJoin ? 'join' : 'resolve').length;
  if (source[open] !== '(') return null;
  return joinArguments(source, open + 1);
}

/**
 * Every resolvable `require(...)` in one source, with the line each is on.
 *
 * The scanner keeps just enough state to know what is text and what is code: comments, quoted
 * strings and template literals are swallowed, and a template's `${ ... }` is code again, which is
 * the shape every test fixture in this repository is written in.
 */
function findRequires(source: string): Specifier[] {
  const found: Specifier[] = [];
  const frames: Frame[] = [{ kind: 'code', braces: 0 }];
  const length = source.length;
  let line = 1;
  let index = 0;
  let lastWord = '';

  while (index < length) {
    const frame = frames[frames.length - 1];
    if (!frame) break;
    const character = source[index] || '';

    if (character === '\n') {
      line++;
      index++;
      continue;
    }

    if (frame.kind === 'template') {
      if (character === '\\') {
        index += 2;
        continue;
      }
      if (character === '`') {
        frames.pop();
        index++;
        continue;
      }
      if (character === '$' && source[index + 1] === '{') {
        frames.push({ kind: 'code', braces: 0 });
        index += 2;
        continue;
      }
      index++;
      continue;
    }

    if (character === '/' && source[index + 1] === '/') {
      while (index < length && source[index] !== '\n') index++;
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      const start = index;
      index += 2;
      while (index < length && !(source[index] === '*' && source[index + 1] === '/')) index++;
      index += 2;
      line += countNewlines(source, start, index);
      continue;
    }
    if (character === "'" || character === '"') {
      const start = index;
      index = skipQuoted(source, index);
      line += countNewlines(source, start, index);
      lastWord = '';
      continue;
    }
    if (character === '`') {
      frames.push({ kind: 'template', braces: 0 });
      index++;
      lastWord = '';
      continue;
    }
    if (character === '/') {
      const previous = previousSignificant(source, index);
      const opensRegex = REGEX_AFTER_PUNCTUATION.has(previous) || REGEX_AFTER_WORDS.has(lastWord);
      if (opensRegex) {
        const start = index;
        index = skipRegex(source, index);
        line += countNewlines(source, start, index);
        lastWord = '';
        continue;
      }
      index++;
      lastWord = '';
      continue;
    }
    if (character === '{') {
      frame.braces++;
      index++;
      lastWord = '';
      continue;
    }
    if (character === '}') {
      if (frame.braces === 0 && frames.length > 1) frames.pop();
      else frame.braces--;
      index++;
      lastWord = '';
      continue;
    }
    if (WORD_START.test(character)) {
      const start = index;
      while (index < length && WORD_PART.test(source[index] || '')) index++;
      const word = source.slice(start, index);
      // A property access is not the global loader: `something.require(...)` is someone else's
      // method, and resolving its argument as a module would be a finding about nothing.
      const isProperty = source[start - 1] === '.' || source[start - 1] === '?';
      if (word === 'require' && !isProperty) {
        let cursor = index;
        while (cursor < length && /\s/.test(source[cursor] || '')) cursor++;
        if (source[cursor] === '(') {
          let argument = cursor + 1;
          while (argument < length && /\s/.test(source[argument] || '')) argument++;
          const literal = literalAt(source, argument);
          if (literal) {
            found.push({ kind: 'literal', text: literal.text, line: line });
            index = literal.end;
            lastWord = '';
            continue;
          }
          const joined = joinCallAt(source, argument);
          if (joined) {
            found.push({ kind: 'join', parts: joined.parts, line: line });
            index = joined.end;
            lastWord = '';
            continue;
          }
        }
      }
      lastWord = word;
      continue;
    }

    index++;
  }

  return found;
}

function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** LOAD_AS_FILE: the literal path, then the three extensions CommonJS will append. */
function loadAsFile(base: string): string | null {
  if (isFile(base)) return base;
  for (const extension of COMMONJS_EXTENSIONS) {
    const candidate = base + extension;
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/** LOAD_AS_DIRECTORY: `package.json`'s `main`, then `index.*`. */
function loadAsDirectory(directory: string, depth: number): string | null {
  if (depth > 4) return null; // a `main` that points back at its own directory; Node throws too
  const manifest = path.join(directory, 'package.json');
  if (isFile(manifest)) {
    let main: string | null = null;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (parsed && typeof parsed === 'object' && 'main' in parsed) {
        const value: unknown = (parsed as { main?: unknown }).main;
        if (typeof value === 'string' && value.length > 0) main = value;
      }
    } catch {
      main = null; // an unparseable manifest resolves to nothing, exactly as it does at run time
    }
    if (main !== null) {
      const target = path.resolve(directory, main);
      const resolved = loadAsFile(target) || loadAsDirectory(target, depth + 1);
      if (resolved) return resolved;
    }
  }
  for (const extension of COMMONJS_EXTENSIONS) {
    const candidate = path.join(directory, 'index' + extension);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/** Is this specifier the loader's problem, or a package's? Only a path is. */
function isPathSpecifier(specifier: string): boolean {
  return specifier === '.' || specifier === '..' ||
    specifier.startsWith('./') || specifier.startsWith('../') ||
    specifier.startsWith('.\\') || specifier.startsWith('..\\') ||
    path.isAbsolute(specifier);
}

/**
 * The absolute path a specifier names, before any extension is guessed - or null when it names
 * something this cannot know without running the program.
 */
function basePath(requiringFile: string, specifier: Specifier): string | null {
  const directory = path.dirname(requiringFile);
  if (specifier.kind === 'literal') {
    if (!isPathSpecifier(specifier.text)) return null; // a package, not a path: out of scope
    return path.resolve(directory, specifier.text);
  }
  // A join is only a path when it is anchored: `path.join('..', 'devices')` is relative to a
  // working directory, and this check does not get to assume one.
  if (specifier.parts[0] !== '__dirname') return null;
  return path.resolve(directory, ...specifier.parts.slice(1));
}

/**
 * How to print the specifier in a finding: the argument as a reader would see it in the source,
 * quotes included for a literal and none for a join, so `require(<spelling>)` reads back exactly.
 */
function spell(specifier: Specifier): string {
  if (specifier.kind === 'literal') return "'" + specifier.text + "'";
  const parts = specifier.parts.map((part) => (part === '__dirname' ? part : "'" + part + "'"));
  return 'path.join(' + parts.join(', ') + ')';
}

/**
 * The `.ts` file the author probably meant, when there is exactly one and naming it is the fix.
 * Only offered for a specifier that resolves to nothing - this is a hint, not a second rule.
 */
function tsSiblingFor(base: string): string | null {
  const direct = base + '.ts';
  if (isFile(direct)) return direct;
  const index = path.join(base, 'index.ts');
  if (isFile(index)) return index;
  return null;
}

function isTypeScript(name: string): boolean {
  return name.endsWith('.ts');
}

function hasSourceExtension(name: string): boolean {
  return SOURCE_EXTENSIONS.some((extension) => name.endsWith(extension));
}

function walk(directory: string, out: string[]): void {
  let entries: import('node:fs').Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return; // an unreadable directory holds no require() this check can be wrong about
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (entry.isFile() && hasSourceExtension(entry.name)) out.push(full);
  }
}

function collect(target: string | null): string[] {
  const files: string[] = [];
  if (target) {
    const absolute = path.resolve(target);
    if (isDirectory(absolute)) {
      walk(absolute, files);
    } else if (isFile(absolute)) {
      if (!hasSourceExtension(absolute)) throw new Error('not a JavaScript or TypeScript file: ' + target);
      files.push(absolute);
    } else {
      throw new Error('no such file or directory: ' + target);
    }
  } else {
    for (const directory of SCAN_DIRS) walk(path.join(ROOT, directory), files);
  }
  return files.sort();
}

function label(absolute: string): string {
  const relative = path.relative(process.cwd(), absolute);
  const inside = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  return (inside ? relative : absolute).split(path.sep).join('/');
}

interface ScanResult {
  readonly files: readonly string[];
  readonly specifiers: number;
  readonly unresolved: readonly Unresolved[];
  readonly latent: readonly Latent[];
}

function scan(files: readonly string[]): ScanResult {
  const unresolved: Unresolved[] = [];
  const latent: Latent[] = [];
  const labels: string[] = [];
  let specifiers = 0;

  for (const file of files) {
    const name = label(file);
    labels.push(name);
    let source: string;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const entry of findRequires(source)) {
      const base = basePath(file, entry);
      if (base === null) continue;
      specifiers++;
      const target = loadAsFile(base) || loadAsDirectory(base, 0);
      if (!target) {
        unresolved.push({
          file: name, line: entry.line, spelling: spell(entry), tsSibling: tsSiblingFor(base)
        });
        continue;
      }
      // The latent half: this line resolves today only because its target is still JavaScript, and
      // a `.ts` file that requires a `.js` sibling is a line that dies the day that sibling is
      // converted - in a file the conversion never touched. Non-fatal by design: nothing is broken
      // yet, and a check that fails on a healthy tree is a check that gets switched off.
      if (isTypeScript(file) && target.endsWith('.js') && !isFile(target.slice(0, -3) + '.ts')) {
        latent.push({ file: name, line: entry.line, spelling: spell(entry), target: target });
      }
    }
  }

  const byPosition = (left: Unresolved | Latent, right: Unresolved | Latent): number => {
    if (left.file !== right.file) return left.file < right.file ? -1 : 1;
    return left.line - right.line;
  };
  unresolved.sort(byPosition);
  latent.sort(byPosition);

  return { files: labels, specifiers: specifiers, unresolved: unresolved, latent: latent };
}

function plural(count: number, word: string): string {
  return count + ' ' + word + (count === 1 ? '' : 's');
}

function main(argv: readonly string[]): number {
  const flags = argv.filter((argument) => argument.startsWith('-'));
  const unknownFlag = flags.find((flag) => flag !== '--list' && flag !== '--help' && flag !== '-h');
  if (unknownFlag) {
    console.error('check-module-paths: unknown option ' + unknownFlag);
    console.error(USAGE);
    return 2;
  }
  if (flags.includes('--help') || flags.includes('-h')) {
    console.log(USAGE);
    return 0;
  }

  const list = flags.includes('--list');
  const target = argv.find((argument) => !argument.startsWith('-')) || null;

  let files: string[];
  try {
    files = collect(target);
  } catch (error) {
    console.error('check-module-paths: ' + (error instanceof Error ? error.message : String(error)));
    return 2;
  }

  const result = scan(files);

  if (list) {
    for (const name of result.files) console.log(name);
    console.log('');
  }

  // The debt first, because it is the part nobody would otherwise see. A require that resolves is
  // not a finding; a require that resolves *by luck of the target's extension* is a note, and the
  // note is the reason this check reads `.ts` files and not only `.js`.
  if (result.latent.length) {
    console.log('Relative requires in TypeScript that still land on a .js file:');
    for (const note of result.latent) {
      console.log('  ' + note.file + ':' + note.line + '  require(' + note.spelling + ')  -> ' +
        label(note.target) + ' today; it breaks when that file becomes .ts');
    }
    console.log('  ' + plural(result.latent.length, 'latent require') +
      ' - non-fatal, and the sweep that converts the target is the commit that names the extension.');
    console.log('');
  }

  if (!result.unresolved.length) {
    console.log('0 unresolvable out of ' + plural(result.specifiers, 'require() specifier') + ' (' +
      plural(result.files.length, 'file') + ' scanned) - every require resolves the way CommonJS will.');
    return 0;
  }

  console.error('Specifiers CommonJS will not resolve:');
  for (const finding of result.unresolved) {
    console.error('  ' + finding.file + ':' + finding.line + '  require(' + finding.spelling +
      ')  -> no such module');
    if (finding.tsSibling) {
      console.error('    ' + label(finding.tsSibling) +
        ' exists; CommonJS does not try .ts - name the extension');
    }
  }
  console.error('');
  console.error(plural(result.unresolved.length, 'unresolvable specifier') + ' out of ' +
    plural(result.specifiers, 'require() specifier') + ' (' + plural(result.files.length, 'file') +
    ' scanned) - CommonJS tries .js, .json and .node, never .ts.');
  return 1;
}

process.exit(main(process.argv.slice(2)));
