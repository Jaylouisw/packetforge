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
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', '.github-cache', 'dist', 'coverage']);
const EXTS = ['.js', '.json', '.md', '.yml', '.yaml', '.css', '.html', '.sh'];

// Tab (9), LF (10), CR (13) are legitimate. Everything else below 0x20 is not.
function badBytes(buf) {
  const hits = [];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 9 || b === 10 || b === 13) continue;
    if (b < 32 || b === 127) hits.push({ index: i, byte: b });
  }
  return hits;
}

function lineOf(buf, index) {
  let line = 1;
  for (let i = 0; i < index && i < buf.length; i++) if (buf[i] === 10) line++;
  return line;
}

const offenders = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name));
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (EXTS.indexOf(ext) === -1) continue;
    const full = path.join(dir, entry.name);
    const buf = fs.readFileSync(full);
    const hits = badBytes(buf);
    if (hits.length) {
      offenders.push({
        file: path.relative(ROOT, full).replace(/\\/g, '/'),
        count: hits.length,
        first: { line: lineOf(buf, hits[0].index), byte: hits[0].byte }
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
