#!/usr/bin/env node
'use strict';
// Guard against control bytes smuggled in by scripted edits.
//
// Issue #11: a regex written through a Python heredoc had its backslash collapse into
// a literal backspace (0x08), so /\bpassive\b/i became /<0x08>passive<0x08>/i. That
// is a *valid* regex literal that matches nothing. `node --check` passed, every editor
// showed the line as correct, and the only symptom was a logic branch that silently
// never fired. It stayed invisible until a test that should have caught a real data
// problem stayed quiet for the wrong reason.
//
// A backspace in source is never intentional. Neither is any other C0 control
// character outside tab/newline/carriage return. This checks for them before they can
// reach main.
//
// This is the repository's first TypeScript file: see docs/TYPESCRIPT.md. It is run
// the way every other script is run - `node scripts/check-control-bytes.ts` - because
// the runtime strips the annotations; there is no build step, and `tsc --noEmit` is
// the only thing that reads them twice. Every parameter and every return below is
// typed, and the Node functions it calls are declared in types/node.d.ts, because
// `typescript` is the only devDependency and there is no `@types/node` to pull in.

// A `.ts` file with no top-level import is a *script* in the type system: every
// `const` in it lands in the global scope and collides with the next script's, and
// `npm test` runs several of these in one program. This empty, type-only import is
// erased by the strip-types runtime and is what marks the file as a module.
import type {} from 'fs';

const fs = require('fs');
const path = require('path');

const ROOT: string = path.join(__dirname, '..');
const SKIP_DIRS: ReadonlySet<string> = new Set(['.git', 'node_modules', '.github-cache', 'dist', 'coverage']);
// `.ts` is in this list because the repository now writes TypeScript: a control byte
// smuggled into a converted file is the same bug, and the same silence.
const EXTS: readonly string[] = ['.js', '.ts', '.json', '.md', '.yml', '.yaml', '.css', '.html', '.sh'];

// Tab (9), LF (10), CR (13) are legitimate. Everything else below 0x20 is not.
const ALLOWED: ReadonlySet<number> = new Set([9, 10, 13]);

/** One control byte, and where in the file it sits. */
interface Hit {
  readonly index: number;
  readonly byte: number;
}

/** One offending file: how many hits, and the line and byte of the first one. */
interface Offender {
  readonly file: string;
  readonly count: number;
  readonly first: { readonly line: number; readonly byte: number };
}

function badBytes(buf: Uint8Array): Hit[] {
  const hits: Hit[] = [];
  for (let i = 0; i < buf.length; i++) {
    const b: number = buf[i];
    if (ALLOWED.has(b)) continue;
    if (b < 32 || b === 127) hits.push({ index: i, byte: b });
  }
  return hits;
}

function lineOf(buf: Uint8Array, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < buf.length; i++) if (buf[i] === 10) line++;
  return line;
}

const offenders: Offender[] = [];

function walk(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name));
      continue;
    }
    const ext: string = path.extname(entry.name).toLowerCase();
    if (EXTS.indexOf(ext) === -1) continue;
    const full: string = path.join(dir, entry.name);
    const buf: Uint8Array = fs.readFileSync(full);
    const hits: Hit[] = badBytes(buf);
    if (hits.length) {
      const first: Hit = hits[0];
      offenders.push({
        file: path.relative(ROOT, full).replace(/\\/g, '/'),
        count: hits.length,
        first: { line: lineOf(buf, first.index), byte: first.byte }
      });
    }
  }
}

walk(ROOT);

if (!offenders.length) {
  console.log('No control bytes in source. (' + EXTS.join(' ') + ')');
  process.exit(0);
}

console.error('Control bytes found in source files:');
for (const o of offenders) {
  console.error('  ' + o.file + ': ' + o.count + ' byte(s), first at line ' + o.first.line +
    ' (0x' + o.first.byte.toString(16).padStart(2, '0') + ')');
}
console.error('\nA control byte is almost always a collapsed escape from a scripted edit.');
console.error('Fix the literal (0x08 for a lost backslash-b, for example) rather than');
console.error('deleting the line, or the branch it guards stays silently dead.');
process.exit(1);
