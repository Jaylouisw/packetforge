'use strict';
// Fuzz the device importer.
//
// `loadCatalog()` reads every JSON file under `devices/` and turns it into a device. It is the one
// place where a hand-written file - contributed by anyone, reviewed by nobody in particular - enters
// the programme. So the interesting question is not whether a well-formed spec loads. It is what
// happens to the other kind:
//
//   * a file truncated by a bad save                        -> must name the file and the position
//   * `"interfaces": "nope"`                                -> must not invent four ports
//   * `"portTemplate": { "count": 0 }`                      -> must not invent one port either
//   * a spec with no `model`                                -> must not vanish without trace
//   * a spec that declares no ports at all                  -> must not become a portless device
//   * a JSON array where an object belongs                  -> must not load as a "device"
//
// All of those used to land in the catalogue looking normal. The fuzz half mutates a real spec four
// hundred ways with a seeded PRNG and asserts the two things that must always hold: the loader never
// throws, and every entry it returns is either a usable device or an error that names the file.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadCatalog, effectiveInterfaces } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; }
  else { failed++; console.log('  not ok - ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const made = [];
function dirWith(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-fuzz-'));
  made.push(root);
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}
process.on('exit', function () {
  for (const d of made) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  }
});

const GOOD = {
  vendor: 'acme', model: 'good-box', label: 'Good Box', category: 'switch',
  capabilities: ['switch'], interfaces: [{ name: 'p1', type: 'ethernet', speed: '1G' }]
};

console.log('');
console.log('Each way a spec can be wrong gets its own sentence, and the file name:');
{
  const root = dirWith({
    'acme/good.json': GOOD,
    'acme/truncated.json': '{"vendor":"acme","model":"t",',
    'acme/empty.json': '',
    'acme/array.json': [{ vendor: 'acme', model: 'arr' }],
    'acme/no-model.json': { vendor: 'acme', label: 'Nameless', interfaces: GOOD.interfaces },
    'acme/ifaces-string.json': { vendor: 'acme', model: 'xs', interfaces: 'nope' },
    'acme/ifaces-empty.json': { vendor: 'acme', model: 'xe', interfaces: [] },
    'acme/count-zero.json': { vendor: 'acme', model: 'cz', portTemplate: { prefix: 'eth', count: 0, speed: '1G' } },
    'acme/count-string.json': { vendor: 'acme', model: 'cs', portTemplate: { prefix: 'eth', count: '8', speed: '1G' } },
    'acme/no-ports.json': { vendor: 'acme', model: 'np', category: 'switch' }
  });
  const entries = loadCatalog(root);
  const byName = new Map(entries.map(function (e) { return [e.model, e]; }));

  ok(!!byName.get('good-box') && !byName.get('good-box').error, 'a good spec loads');
  ok(effectiveInterfaces(byName.get('good-box')).length === 1, 'and keeps its port');

  const expect = {
    'truncated.json': /Expected|Unexpected|Unterminated/,
    'empty.json': /Unexpected end|Unexpected/,
    'array.json': /is not a JSON object/,
    'no-model.json': /has no "model" field/,
    'ifaces-string.json': /"interfaces" must be an array/,
    'ifaces-empty.json': /empty "interfaces" array/,
    // The wording gained the range when #1319 found the ceiling unenforced: a message that says "positive" is
    // not enough when "1000000" is positive and the schema says 1..512.
    'count-zero.json': /"portTemplate\.count" must be a whole number from 1 to 512/,
    'count-string.json': /"portTemplate\.count" must be a whole number from 1 to 512/,
    'no-ports.json': /declares no ports/
  };
  const misses = [];
  for (const [file, pattern] of Object.entries(expect)) {
    const e = byName.get(file);
    if (!e) { misses.push(file + ': no entry at all - the file vanished, which is the bug'); continue; }
    if (!e.error) { misses.push(file + ': loaded as a device'); continue; }
    if (!pattern.test(e.error)) { misses.push(file + ': unhelpful message "' + e.error.slice(0, 80) + '"'); continue; }
    if (e.error.indexOf(file) === -1) misses.push(file + ': message does not name the file');
    if (/^\s+at /m.test(e.error)) misses.push(file + ': message contains a stack trace');
    if (e.vendor !== 'error') misses.push(file + ': not marked as an error entry');
  }
  ok(misses.length === 0, 'nine malformed specs, nine useful messages', misses.join(' | '));
  ok(entries.length === 10, 'every file produces exactly one entry - nothing is swallowed', String(entries.length));
}

console.log('');
console.log('A fixed file is picked up without a restart:');
{
  // The loader used to `require()` each spec, and require caches by path: correcting a spec on disk
  // left the process reporting the old failure forever. Anyone who has ever fixed a typo, reloaded,
  // and seen the same error will recognise the hour it costs.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-fresh-'));
  made.push(root);
  const file = path.join(root, 'acme', 'box.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"vendor":"acme","model":"box",');
  const first = loadCatalog(root);
  ok(!!first[0].error, 'the broken file is reported first time', first[0] && first[0].error);
  fs.writeFileSync(file, JSON.stringify(GOOD));
  const second = loadCatalog(root);
  ok(!second[0].error, 'and the corrected file loads without restarting anything', second[0] && second[0].error);
  ok(second[0].model === 'good-box', 'with the contents that are on disk now', second[0].model);
}

console.log('');
console.log('Four hundred mutations of a real spec, and two invariants that never bend:');
{
  const seedSpec = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'devices', 'cisco', 'isr4321.json'), 'utf8'));
  const rand = mulberry32(20261109);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-mut-'));
  made.push(root);
  fs.mkdirSync(path.join(root, 'acme'), { recursive: true });
  const file = path.join(root, 'acme', 'subject.json');

  const JUNK = [null, true, 0, -1, '', 'string', [], {}, 1e308, -1e308,
    String.fromCharCode(0), 'ünïcode ' + String.fromCharCode(0x202e),
    ['nested', ['deeper']]];
  const KEYS = ['model', 'vendor', 'label', 'category', 'interfaces', 'portTemplate', 'capabilities', 'notes', 'fabric', 'aliases', 'speed', 'type'];
  let threw = null, checked = 0, asError = 0, asDevice = 0;
  const bad = [];

  for (let i = 0; i < 400; i++) {
    const spec = JSON.parse(JSON.stringify(seedSpec));
    const mutations = 1 + Math.floor(rand() * 3);
    for (let m = 0; m < mutations; m++) {
      const key = KEYS[Math.floor(rand() * KEYS.length)];
      const roll = rand();
      if (roll < 0.3) delete spec[key];
      else if (roll < 0.6) spec[key] = JUNK[Math.floor(rand() * JUNK.length)];
      else if (roll < 0.75) spec[key] = 'x'.repeat(Math.floor(rand() * 500));
      else if (roll < 0.9) spec[key] = [JUNK[Math.floor(rand() * JUNK.length)]];
      else spec[key] = { count: JUNK[Math.floor(rand() * JUNK.length)], prefix: 'e' };
    }
    // One file at a time: the question is what this spec does, not how 400 specs interact, and
    // re-reading a growing corpus is how a fuzz test earns a timeout.
    fs.writeFileSync(file, JSON.stringify(spec));

    let entries;
    try {
      entries = loadCatalog(root);
    } catch (e) {
      threw = threw || (e.constructor.name + ': ' + e.message + ' (mutation ' + i + ')');
      continue;
    }
    checked++;
    if (entries.length !== 1) { bad.push('mutation ' + i + ': ' + entries.length + ' entries for one file'); continue; }
    const mine = entries[0];
    if (mine.error) {
      asError++;
      if (mine.error.indexOf('subject.json') === -1) bad.push('mutation ' + i + ': error does not name the file');
      if (/^\s+at /m.test(mine.error)) bad.push('mutation ' + i + ': error contains a stack trace');
      if (mine.vendor !== 'error') bad.push('mutation ' + i + ': error entry is not marked as one');
    } else {
      asDevice++;
      const ports = effectiveInterfaces(mine);
      if (!ports.length) bad.push('mutation ' + i + ': loaded as a device with no ports');
      if (!mine.model) bad.push('mutation ' + i + ': loaded as a device with no model');
      for (const p of ports) {
        if (!p || typeof p.name !== 'string' || !p.name) bad.push('mutation ' + i + ': a port has no name');
        if (p && p.speed != null && typeof p.speed !== 'string' && typeof p.speed !== 'number') {
          bad.push('mutation ' + i + ': a port speed is ' + typeof p.speed);
        }
      }
    }
  }

  ok(!threw, 'the loader never throws, whatever the file contains', threw);
  ok(bad.length === 0, 'every mutation is either a usable device or a named error', bad.slice(0, 4).join(' | '));
  ok(checked === 400, 'all 400 mutations were checked', String(checked));
  ok(asError > 0 && asDevice > 0, 'the mutation set produced both outcomes (' + asDevice + ' loaded, ' + asError + ' refused)');
}

console.log('');
console.log('The real catalogue is untouched by all of this:');
{
  const specs = loadCatalog(path.join(__dirname, '..', 'devices'));
  const errors = specs.filter(function (s) { return s.error; });
  ok(errors.length === 0, 'every shipped spec still loads', errors.slice(0, 3).map(function (e) { return e.error; }).join(' | '));
  ok(specs.length > 2000, 'and the catalogue is still whole (' + specs.length + ')');
  const portless = specs.filter(function (s) { return effectiveInterfaces(s).length === 0; });
  ok(portless.length === 0, 'no shipped device is portless', portless.slice(0, 3).map(function (s) { return s.model; }).join(','));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
