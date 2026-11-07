'use strict';
// Recursively syntax-check every JavaScript file under the project.
// Zero dependencies — uses `node --check`. Run: node scripts/syntax-check.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIRS = ['engine', 'server', 'devices', 'web', 'scripts', 'examples', 'test'];

const files = [];
for (const d of DIRS) {
  const dir = path.join(ROOT, d);
  if (!fs.existsSync(dir)) continue;
  (function walk(p) {
    for (const e of fs.readdirSync(p)) {
      const f = path.join(p, e);
      const st = fs.statSync(f);
      if (st.isDirectory()) walk(f);
      else if (f.endsWith('.js')) files.push(f);
    }
  })(dir);
}

let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    failed++;
    console.error('✗ ' + path.relative(ROOT, f));
    console.error(String(e.stderr || e.message));
  }
}
console.log('Syntax-checked ' + files.length + ' files: ' + (failed ? failed + ' failed' : 'all OK'));
process.exit(failed ? 1 : 0);
