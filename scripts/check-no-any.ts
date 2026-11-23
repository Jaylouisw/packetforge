#!/usr/bin/env node
'use strict';
/**
 * The standing rule is that new code is TypeScript and that `any` appears nowhere. A rule that
 * lives only in a document is a habit, and a habit is not a check: `any` is the one type that
 * never fails. It type-checks, it reviews clean, and it switches TypeScript off for everything
 * downstream of it, silently, forever.
 *
 * So this reads the sources and reports every explicit `any` written in a type position, with the
 * `file:line:column` of the word itself.
 *
 * Why a lexical check and not the compiler
 * ---------------------------------------
 * `tsc --noEmit` cannot answer this question: it reports nothing for an `any` you wrote by hand,
 * which is exactly the one it is not allowed to see. ESLint's `no-explicit-any` could, but the
 * repository promises zero dependencies and `npm test` has to stay runnable from a bare checkout.
 * That leaves reading the text - and reading the text carefully, because the word "any" occurs
 * in prose, in strings, in test fixtures and in filenames, and none of those is a type:
 *
 *   - comments and string literals are dropped by the tokenizer before anything is judged, so a
 *     comment that *explains* the rule cannot fail it, and neither can a fixture string;
 *   - `unknown` is a different word and is the answer to almost every `any` (narrow it, do not
 *     silence it), so it is never touched;
 *   - a property, a member or a variable *named* `any` is an identifier in a value position, not
 *     a type, and the rules below key on what surrounds the word rather than on the word.
 *
 * What counts as a type position - the spellings this catches:
 *
 *   `: any`                 annotation, return type, parameter, property, `?: any`
 *   `as any`                the cast that turns the compiler off
 *   `<any>`                 angle-bracket assertion and type argument
 *   `any[]`                 array of any (matched as `[` `]`, so `bag[0]` is not this)
 *   `Array<any>`            same thing with a capital A
 *   `Promise<any>`          a promise that resolves to nothing anybody knows
 *   `Record<string, any>`   a record whose values are untyped
 *   `<T = any>`             a generic defaulting to any, which is worse than it looks: every call
 *                           site that omits the argument now types as any and nobody sees it
 *   `| any`                 a union member, which swallows the other members whole
 *   `extends any`           a generic constraint that constrains nothing
 *
 * Known shape of the check, stated so nobody mistakes it for a parser: `<` is counted as opening
 * type arguments when the token before it can be a type name (`X<`, `)`, `]`, `>`), and the count
 * is discarded at `;`, `{` and `}`. A comparison can therefore inflate the count - which only
 * matters if a comma inside that stretch is followed by the bare word `any` - while a real
 * `Array<any>` cannot escape it. If this ever cries wolf on honest code the fix is the rule, not a
 * suppression: a guard people work around is worse than no guard.
 *
 * Usage:
 *   node scripts/check-no-any.ts                  # scan this repository, exit 1 on findings
 *   node scripts/check-no-any.ts <dir|file>       # scan one directory or one file (the tests do)
 *   node scripts/check-no-any.ts --list           # print every file scanned, then the findings
 */

const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');

// A `.ts` file with no import or export is a *script* to TypeScript, which drops its top-level
// names into one global scope shared with every other such file - two of them would collide on
// `fs` alone. This type-only export marks the file as a module, and the runtime strips it because
// it is a type: nothing changes at run time, and the checker stays the plain CommonJS script that
// `node` loads here. (A `tsconfig` with `moduleDetection: "force"` would say the same thing; this
// says it in the file, where it cannot be turned off by a config somewhere else.)
export type CheckNoAnyModule = never;

const ROOT = path.join(__dirname, '..');

// Where new TypeScript may appear. `types/` is scanned on purpose: an ambient declaration is
// still code somebody wrote, and a `d.ts` full of `any` is exactly how the rule walks back in
// through the door marked "just typings". A `.d.ts` is not a licence, it is a file.
const SCAN_DIRS = ['scripts', 'engine', 'server', 'web', 'test', 'types'];
const TS_EXTENSIONS = ['.ts', '.mts', '.cts', '.tsx'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.github-cache']);

const USAGE = [
  'Usage:',
  '  node scripts/check-no-any.ts                scan the repository',
  '  node scripts/check-no-any.ts <dir|file>     scan one directory or one file',
  '  node scripts/check-no-any.ts --list         print every file scanned, then the findings'
].join('\n');

type TokenKind = 'word' | 'punct' | 'literal';

interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  readonly line: number;
  readonly column: number;
}

interface Frame {
  readonly kind: 'code' | 'template';
  braceDepth: number;
}

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly spelling: string;
}

// Longest first, and checked with startsWith: `>>>` has to win over `>>`, and `>=` must never be
// read as a closing `>` or the generic-depth counter walks off the end of the file.
const MULTI_CHAR_PUNCTUATION = [
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '&&=', '||=', '??=', '>>>',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '+=', '-=', '*=', '/=', '%=',
  '&=', '|=', '^=', '**', '<<', '++', '--', '>>', '::'
];

const WORD_START = /[A-Za-z_$]/;
const WORD_PART = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;
const CLOSING_ANGLE_RUN = /^>+$/;

// A `/` opens a regular expression rather than dividing after one of these. Getting this wrong
// matters twice over: a regex containing an apostrophe would open a string literal and swallow
// the rest of the file, and the text inside `/.../` is text, not code.
const REGEX_AFTER_WORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case',
  'do', 'else', 'yield', 'await'
]);
const REGEX_AFTER_PUNCTUATION = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '=>', '&&', '||', '??',
  '+=', '-=', '*=', '/=', '%=', '==', '===', '!=', '!==', '<=', '>='
]);

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const frames: Frame[] = [{ kind: 'code', braceDepth: 0 }];
  let index = 0;
  let line = 1;
  let lineStart = 0;

  function advance(count: number): void {
    for (let step = 0; step < count && index < source.length; step++) {
      if (source.charAt(index) === '\n') {
        line++;
        lineStart = index + 1;
      }
      index++;
    }
  }

  function push(kind: TokenKind, text: string, startLine: number, startColumn: number): void {
    tokens.push({ kind, text, line: startLine, column: startColumn });
  }

  function startsRegex(): boolean {
    const previous = tokens.length ? tokens[tokens.length - 1] : undefined;
    if (!previous) return true;
    if (previous.kind === 'word') return REGEX_AFTER_WORDS.has(previous.text);
    if (previous.kind === 'punct') return REGEX_AFTER_PUNCTUATION.has(previous.text);
    return false;
  }

  function consumeRegex(): void {
    const startLine = line;
    const startColumn = index - lineStart + 1;
    advance(1);
    let inCharacterClass = false;
    while (index < source.length) {
      const character = source.charAt(index);
      if (character === '\\') {
        advance(2);
        continue;
      }
      if (character === '\n') break;
      if (character === '[') inCharacterClass = true;
      else if (character === ']') inCharacterClass = false;
      else if (character === '/' && !inCharacterClass) {
        advance(1);
        break;
      }
      advance(1);
    }
    while (index < source.length && WORD_PART.test(source.charAt(index))) advance(1);
    push('literal', '/', startLine, startColumn);
  }

  while (index < source.length) {
    const frame = frames[frames.length - 1];
    if (!frame) break;
    const character = source.charAt(index);

    if (frame.kind === 'template') {
      // Inside a template the text is text - including anything that looks like a type - until
      // `${` hands the scanner back to code.
      if (character === '\\') {
        advance(2);
        continue;
      }
      if (character === '`') {
        advance(1);
        frames.pop();
        continue;
      }
      if (character === '$' && source.charAt(index + 1) === '{') {
        advance(2);
        frames.push({ kind: 'code', braceDepth: 0 });
        continue;
      }
      advance(1);
      continue;
    }

    if (character === '\n' || character === '\r' || character === ' ' || character === '\t' ||
      character === '\f' || character === '\v') {
      advance(1);
      continue;
    }

    if (character === '/' && source.charAt(index + 1) === '/') {
      while (index < source.length && source.charAt(index) !== '\n') advance(1);
      continue;
    }

    if (character === '/' && source.charAt(index + 1) === '*') {
      advance(2);
      while (index < source.length && !(source.charAt(index) === '*' && source.charAt(index + 1) === '/')) {
        advance(1);
      }
      advance(2);
      continue;
    }

    if (character === '\'' || character === '"') {
      const quote = character;
      const startLine = line;
      const startColumn = index - lineStart + 1;
      advance(1);
      while (index < source.length) {
        if (source.charAt(index) === '\\') {
          advance(2);
          continue;
        }
        if (source.charAt(index) === quote) {
          advance(1);
          break;
        }
        advance(1);
      }
      push('literal', quote, startLine, startColumn);
      continue;
    }

    if (character === '`') {
      const startLine = line;
      const startColumn = index - lineStart + 1;
      advance(1);
      frames.push({ kind: 'template', braceDepth: 0 });
      push('literal', '`', startLine, startColumn);
      continue;
    }

    if (character === '{') {
      frame.braceDepth++;
      push('punct', '{', line, index - lineStart + 1);
      advance(1);
      continue;
    }

    if (character === '}') {
      // A `}` that closes the brace level the `${` opened ends the interpolation; anything deeper
      // is an ordinary block inside it.
      if (frame.braceDepth === 0 && frames.length > 1) {
        frames.pop();
        advance(1);
        continue;
      }
      if (frame.braceDepth > 0) frame.braceDepth--;
      push('punct', '}', line, index - lineStart + 1);
      advance(1);
      continue;
    }

    if (character === '/') {
      if (startsRegex()) {
        consumeRegex();
        continue;
      }
      push('punct', '/', line, index - lineStart + 1);
      advance(1);
      continue;
    }

    if (WORD_START.test(character)) {
      const startLine = line;
      const startColumn = index - lineStart + 1;
      let text = '';
      while (index < source.length && WORD_PART.test(source.charAt(index))) {
        text += source.charAt(index);
        advance(1);
      }
      push('word', text, startLine, startColumn);
      continue;
    }

    if (DIGIT.test(character) || (character === '.' && DIGIT.test(source.charAt(index + 1)))) {
      const startLine = line;
      const startColumn = index - lineStart + 1;
      let text = '';
      while (index < source.length && WORD_PART.test(source.charAt(index))) {
        text += source.charAt(index);
        advance(1);
      }
      push('literal', text, startLine, startColumn);
      continue;
    }

    const multi = MULTI_CHAR_PUNCTUATION.find((candidate) => source.startsWith(candidate, index));
    if (multi) {
      push('punct', multi, line, index - lineStart + 1);
      advance(multi.length);
      continue;
    }

    push('punct', character, line, index - lineStart + 1);
    advance(1);
  }

  return tokens;
}

function opensTypeArguments(previous: Token | undefined): boolean {
  if (!previous) return false;
  if (previous.kind === 'word') return true;
  return previous.text === ')' || previous.text === '>' || previous.text === ']';
}

// `previous`/`next` are the significant neighbours of the word `any`; the spelling that comes back
// names what the source actually says, so the report reads as a fix instruction and not a riddle.
function spellingAt(tokens: readonly Token[], position: number, insideTypeArguments: boolean): string | null {
  const previous = position > 0 ? tokens[position - 1] : undefined;
  const next = tokens[position + 1];
  const afterNext = tokens[position + 2];

  // `any[]` first: it is the more specific name for `const list: any[]`, and the report should say
  // what to replace rather than repeating the annotation it sits inside.
  if (next && next.text === '[' && afterNext && afterNext.text === ']') return 'array of any (any[])';

  if (previous) {
    if (previous.text === ':') return 'type annotation (: any)';
    if (previous.text === 'as') return 'type assertion (as any)';
    if (previous.text === '<') return 'type argument (<any>)';
    if (previous.text === '|') return 'union member (| any)';
    if (previous.text === 'extends') return 'generic constraint (extends any)';
    if (insideTypeArguments && previous.text === ',') return 'generic argument (<T, any>)';
    if (insideTypeArguments && previous.text === '=') return 'generic default (<T = any>)';
  }

  return null;
}

function scanSource(text: string, label: string): Finding[] {
  const tokens = tokenize(text);
  const findings: Finding[] = [];
  let depth = 0;

  for (let position = 0; position < tokens.length; position++) {
    const token = tokens[position];
    if (!token) continue;

    if (token.kind === 'punct') {
      if (token.text === '<') {
        if (opensTypeArguments(position > 0 ? tokens[position - 1] : undefined)) depth++;
      } else if (CLOSING_ANGLE_RUN.test(token.text)) {
        depth = Math.max(0, depth - token.text.length);
      } else if (token.text === ';' || token.text === '{' || token.text === '}') {
        depth = 0;
      }
      continue;
    }

    // Only a bare word can be the type keyword. A property, a member (`row.any`) or a variable
    // called `any` never reaches this point in a type position, which is the whole distinction.
    if (token.kind !== 'word' || token.text !== 'any') continue;

    const spelling = spellingAt(tokens, position, depth > 0);
    if (spelling) findings.push({ file: label, line: token.line, column: token.column, spelling });
  }

  return findings;
}

function isTypeScript(name: string): boolean {
  return TS_EXTENSIONS.some((extension) => name.endsWith(extension));
}

function walk(directory: string, out: string[]): void {
  let entries: import('node:fs').Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    // An unreadable directory holds no code this check can be wrong about.
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (entry.isFile() && isTypeScript(entry.name)) out.push(full);
  }
}

function collect(target: string | null): string[] {
  const files: string[] = [];
  if (target) {
    const absolute = path.resolve(target);
    let stats: import('node:fs').Stats;
    try {
      stats = fs.statSync(absolute);
    } catch {
      throw new Error('no such file or directory: ' + target);
    }
    if (stats.isDirectory()) walk(absolute, files);
    else if (isTypeScript(absolute)) files.push(absolute);
    else throw new Error('not a TypeScript file: ' + target);
  } else {
    for (const directory of SCAN_DIRS) walk(path.join(ROOT, directory), files);
    for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
      if (entry.isFile() && isTypeScript(entry.name)) files.push(path.join(ROOT, entry.name));
    }
  }
  return files.sort();
}

function label(absolute: string): string {
  const relative = path.relative(process.cwd(), absolute);
  const inside = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  return (inside ? relative : absolute).split(path.sep).join('/');
}

function compareFindings(left: Finding, right: Finding): number {
  if (left.file !== right.file) return left.file < right.file ? -1 : 1;
  if (left.line !== right.line) return left.line - right.line;
  return left.column - right.column;
}

function plural(count: number, word: string): string {
  return count + ' ' + word + (count === 1 ? '' : 's');
}

function main(argv: readonly string[]): number {
  const flags = argv.filter((argument) => argument.startsWith('-'));
  const unknownFlag = flags.find((flag) => flag !== '--list' && flag !== '--help' && flag !== '-h');
  if (unknownFlag) {
    console.error('check-no-any: unknown option ' + unknownFlag);
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
    console.error('check-no-any: ' + (error instanceof Error ? error.message : String(error)));
    return 2;
  }

  const labels = files.map(label);
  if (list) {
    for (const name of labels) console.log(name);
    console.log('');
  }

  const findings: Finding[] = [];
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    if (!file) continue;
    const name = labels[index] || label(file);
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const finding of scanSource(text, name)) findings.push(finding);
  }
  findings.sort(compareFindings);

  if (!findings.length) {
    console.log('0 occurrences in 0 files (' + files.length + ' scanned) \u2014 no explicit any in a type position.');
    return 0;
  }

  const filesWithFindings = new Set(findings.map((finding) => finding.file));
  console.error('Explicit any in a type position:');
  for (const finding of findings) {
    console.error('  ' + finding.file + ':' + finding.line + ':' + finding.column + ': ' + finding.spelling);
  }
  console.error('');
  console.error(plural(findings.length, 'occurrence') + ' in ' + plural(filesWithFindings.size, 'file') +
    ' (' + files.length + ' scanned) \u2014 narrow an unknown, or name the type.');
  return 1;
}

process.exit(main(process.argv.slice(2)));
