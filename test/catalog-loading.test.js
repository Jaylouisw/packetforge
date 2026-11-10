'use strict';
// catalog-loading.test.js - a catalogue load must not lie about what it found.
//
// Two ways it did:
//
//  1. `require()` decides how to find a file from the string it is handed, so a relative directory
//     ("devices") made every file unloadable. Each throw was caught and pushed as a "Broken spec"
//     entry, so the call returned a full-length catalogue of perfectly good hardware, all of it
//     labelled broken. Nothing failed - the answer was just wrong, which is the harder failure to
//     notice.
//  2. A file that parsed but declared no `model` was dropped without a trace. `"Model"` for
//     `"model"` is one keystroke away, and the catalogue came back quietly one box short.
//
// This suite pins both: the same catalogue for any path spelling, and a file that is not a device
// reported by name instead of vanishing.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadCatalog, modelKey } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const REAL = path.join(__dirname, '..', 'devices');

console.log('The real catalogue loads the same however the directory is written:');
{
  const abs = loadCatalog(REAL);
  ok(abs.length > 1000, 'the absolute path loads the catalogue (' + abs.length + ' entries)');
  const broken = abs.filter(function (s) { return s.vendor === 'error'; });
  ok(broken.length === 0, 'and none of it is reported broken' +
    (broken.length ? ' (' + broken.slice(0, 3).map(function (b) { return b.model + ': ' + b.error; }).join('; ') + ')' : ''));

  // The bug: this exact call used to return a full-length catalogue of "Broken spec" entries.
  const rel = loadCatalog('devices');
  ok(rel.length === abs.length, 'a relative path returns the same number of entries (' + rel.length + ')');
  const relBroken = rel.filter(function (s) { return s.vendor === 'error'; });
  ok(relBroken.length === 0, 'and reports nothing broken, so the walk really read the files');

  const keyOf = function (s) { return modelKey(s); };
  const a = abs.map(keyOf).sort().join('|');
  const b = rel.map(keyOf).sort().join('|');
  ok(a === b, 'and the two loads describe exactly the same devices');
}

// A small tree with one good file and two broken ones, so both failure modes are exercised without
// touching the real catalogue.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-catalog-'));
fs.writeFileSync(path.join(tmp, 'good.json'), JSON.stringify({
  vendor: 'Acme', model: 'Widget 9000', label: 'Widget 9000', category: 'switch',
  interfaces: [{ name: 'eth0', type: 'ethernet', speed: '1G' }]
}, null, 2));
fs.writeFileSync(path.join(tmp, 'unparseable.json'), '{ "vendor": "Acme", "model": ');
fs.writeFileSync(path.join(tmp, 'capitalised.json'), JSON.stringify({
  vendor: 'Acme', Model: 'Widget 9100', label: 'Widget 9100'
}, null, 2));
fs.mkdirSync(path.join(tmp, 'nested'));
fs.writeFileSync(path.join(tmp, 'nested', 'deep.json'), JSON.stringify({
  vendor: 'Acme', model: 'Widget 9200', label: 'Widget 9200'
}, null, 2));

console.log('\nA file that is not a device is reported, not dropped:');
{
  const specs = loadCatalog(tmp);
  const good = specs.filter(function (s) { return s.vendor === 'Acme'; });
  ok(good.length === 2, 'both readable devices load, including the one a directory down (' + good.length + ')');
  ok(good.some(function (s) { return s.model === 'Widget 9000'; }), 'the well-formed spec is there by model');
  ok(good.some(function (s) { return s.model === 'Widget 9200'; }), 'and so is the nested one');

  const errors = specs.filter(function (s) { return s.vendor === 'error'; });
  ok(errors.length === 2, 'two files are reported as unusable, not one (' + errors.length + ')');
  const unparseable = errors.find(function (e) { return e.model === 'unparseable.json'; });
  ok(!!unparseable, 'the unparseable file is named');
  ok(/Unexpected|JSON/i.test(String(unparseable && unparseable.error)),
    'with the parser\'s own complaint (' + (unparseable && unparseable.error) + ')');
  const capitalised = errors.find(function (e) { return e.model === 'capitalised.json'; });
  ok(!!capitalised, 'the file that parses but has "Model" instead of "model" is named too');
  ok(/no "model" field/.test(String(capitalised && capitalised.error)),
    'and says what is missing rather than blaming the syntax');
}

console.log('\nThe same tree, reached by a relative path, gives the same answer:');
{
  const abs = loadCatalog(tmp);
  const relPath = path.relative(process.cwd(), tmp);
  if (path.isAbsolute(relPath)) {
    // Different drive on this machine: there is no relative spelling to test.
    ok(true, 'skipped - the scratch directory is on another volume, so it has no relative form');
  } else {
    const rel = loadCatalog(relPath);
    ok(rel.length === abs.length, 'the relative load returns the same entries (' + rel.length + ')');
    const missing = rel.filter(function (s) {
      return s.vendor === 'error' && /Cannot find module/.test(String(s.error));
    });
    ok(missing.length === 0, 'and not one of them failed to be found on disk' +
      (missing.length ? ' (' + missing.length + ')' : ''));
    const good = rel.filter(function (s) { return s.vendor === 'Acme' && s.model; });
    ok(good.length === 2, 'the devices still load by their real models (' + good.length + ')');
  }
}

console.log('\nA missing directory still throws, rather than returning an empty catalogue:');
{
  let threw = false;
  try { loadCatalog(path.join(tmp, 'not-a-directory')); } catch (e) { threw = true; }
  ok(threw, 'loadCatalog refuses a path that is not there');
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
