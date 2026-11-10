'use strict';
// What the catalogue refuses, and what it must keep accepting (#1317).
//
// `loadCatalog()` already refuses a spec that cannot describe a device: no `model`, `interfaces` that is not an
// array, a template with a negative count, a nameless port. Three ways of lying were still accepted:
//
//   * **two ports with one name.** Ports are kept in a map keyed by name, so the later one silently replaces the
//     earlier. A spec describing five ports became a device with four, and the box on the canvas showed 4 where
//     the file said 5 - with nothing anywhere saying so. Measured before the gate:
//
//         expandInterfaces(spec) -> Gi1,Gi2,Gi3,Gi4,Gi2      (five)
//         device.interfaces      -> Gi1,Gi2,Gi3,Gi4          (four)
//
//   * **the same box declared twice.** `modelKey()` squashes punctuation, which is how the importer's duplicate
//     gate works (issue #60) - but nothing re-checked it at load, so a file added any other way put two entries in
//     the palette for one machine, and `POST /devices {model}` silently took whichever sorted first;
//   * **a template prefix or start of the wrong type.** `prefix: 5` with `start: "1"` invents `Gi10, Gi11 ...` as
//     if the numbering began at ten.
//
// The second half of this file is the other half of the rule: the catalogue it has to keep accepting. 207 specs are
// template-only, and a spec may legitimately combine a template with extra explicit ports - so a gate that refused
// that would empty a fifth of the catalogue to make a point.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadCatalog, effectiveInterfaces, modelKey } = require('../devices/registry');
const { expandInterfaces, Topology } = require('../engine/topology');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const ROOT = path.join(__dirname, '..');

function fixture(specs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cat-'));
  for (const [name, spec] of Object.entries(specs)) {
    fs.writeFileSync(path.join(dir, name + '.json'), typeof spec === 'string' ? spec : JSON.stringify(spec, null, 2));
  }
  return dir;
}
const SW = { vendor: 'Testco', model: 'TS-8', category: 'switch',
  portTemplate: { prefix: 'Gi', start: 1, count: 8, type: 'ethernet', speed: '1G' } };

console.log('');
console.log('The catalogue that ships is clean, and stays clean:');
{
  const specs = loadCatalog(path.join(ROOT, 'devices'));
  const broken = specs.filter(function (s) { return s.error; });
  ok(broken.length === 0, 'every spec in the tree loads (' + specs.length + ')', JSON.stringify(broken.slice(0, 3).map(function (b) { return b.error; })));
  ok(specs.length > 1500, 'and there are as many as there were', String(specs.length));

  const clash = [];
  const keys = new Map();
  const dupeModel = [];
  for (const s of specs) {
    if (s.error) continue;
    const seen = new Map();
    for (const p of effectiveInterfaces(s)) seen.set(p.name, (seen.get(p.name) || 0) + 1);
    const dup = Array.from(seen).filter(function (e) { return e[1] > 1; });
    if (dup.length) clash.push(s.vendor + ' ' + s.model + ': ' + dup[0][0]);
    const k = modelKey(s);
    if (keys.has(k)) dupeModel.push(s.vendor + ' ' + s.model + ' ~ ' + keys.get(k));
    keys.set(k, s.vendor + ' ' + s.model);
  }
  ok(clash.length === 0, 'no spec gives two ports one name', JSON.stringify(clash.slice(0, 3)));
  ok(dupeModel.length === 0, 'and no two specs describe the same box', JSON.stringify(dupeModel.slice(0, 3)));
  ok(specs.every(function (s) { return s.vendor && s.model && s.category; }),
    'every entry names a vendor, a model and a category');
  ok(specs.every(function (s) { return s.error || effectiveInterfaces(s).length > 0; }),
    'and every one of them has something to cable to');
}

console.log('');
console.log('Two ports with one name are refused, and the engine is why:');
{
  // The reasoning, measured rather than asserted: the spec describes five ports and the device keeps four.
  const spec = { vendor: 'Testco', model: 'Clash', category: 'switch',
    portTemplate: { prefix: 'Gi', start: 1, count: 4 }, interfaces: [{ name: 'Gi2', type: 'ethernet', speed: '1G' }] };
  const expanded = expandInterfaces(spec);
  const t = new Topology();
  const dev = t.addDevice(spec, 'd1');
  ok(expanded.length === 5, 'the expansion describes five ports', String(expanded.length));
  ok(dev.interfaces.size === 4, 'and the device keeps four', String(dev.interfaces.size));
  ok(expanded.map(function (p) { return p.name; }).join(',') === 'Gi1,Gi2,Gi3,Gi4,Gi2', 'the duplicate is Gi2');

  const dir = fixture({ clash: spec });
  const loaded = loadCatalog(dir);
  ok(loaded.length === 1 && !!loaded[0].error, 'so a spec like that is refused, not loaded', JSON.stringify(loaded[0]));
  ok(/Gi2/.test(loaded[0].error) && /5/.test(loaded[0].error) && /4/.test(loaded[0].error),
    'the message names the port and the arithmetic', loaded[0].error);
  ok(/clash\.json/.test(loaded[0].error), 'and the file', loaded[0].error);
  ok(loaded[0].vendor === 'error', 'it stays in the catalogue as a broken entry, rather than vanishing');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('');
console.log('Two specs for one box are refused, punctuation or not:');
{
  const dir = fixture({
    a: { vendor: 'Cisco', model: 'ASR1001-X', category: 'router', interfaces: [{ name: 'Gi0/0', type: 'ethernet', speed: '1G' }] },
    b: { vendor: 'Cisco', model: 'ASR 1001-X', category: 'router', interfaces: [{ name: 'Gi0/0', type: 'ethernet', speed: '1G' }] }
  });
  const loaded = loadCatalog(dir);
  const good = loaded.filter(function (s) { return !s.error; });
  const bad = loaded.filter(function (s) { return s.error; });
  ok(good.length === 1, 'one of them loads', String(good.length));
  ok(bad.length === 1, 'and the other is reported', String(bad.length));
  ok(/already declares/.test(bad[0].error), 'with a message saying the model is taken', bad[0].error);
  ok(/(a|b)\.json/.test(bad[0].error), 'naming the file that already has it', bad[0].error);

  // A different vendor may of course use the same model string.
  const dir2 = fixture({
    a: { vendor: 'Cisco', model: 'X100', category: 'router', interfaces: [{ name: 'p1', type: 'ethernet', speed: '1G' }] },
    b: { vendor: 'Juniper', model: 'X100', category: 'router', interfaces: [{ name: 'p1', type: 'ethernet', speed: '1G' }] }
  });
  const two = loadCatalog(dir2);
  ok(two.filter(function (s) { return !s.error; }).length === 2, 'two vendors sharing a model name are two devices',
    JSON.stringify(two.map(function (s) { return s.error || s.vendor; })));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dir2, { recursive: true, force: true });
}

console.log('');
console.log('A template prefix or start of the wrong type is refused:');
{
  const dir = fixture({
    prefix: { vendor: 'Testco', model: 'P5', category: 'switch', portTemplate: { prefix: 5, count: 4 } },
    start: { vendor: 'Testco', model: 'S1', category: 'switch', portTemplate: { prefix: 'Gi', start: '1', count: 4 } },
    negative: { vendor: 'Testco', model: 'N1', category: 'switch', portTemplate: { prefix: 'Gi', start: -1, count: 4 } }
  });
  const loaded = loadCatalog(dir);
  const errors = loaded.filter(function (s) { return s.error; });
  ok(errors.length === 3, 'all three are refused', String(errors.length));
  ok(errors.some(function (s) { return /prefix/.test(s.error); }), 'one names the prefix');
  ok(errors.some(function (s) { return /start/.test(s.error) && /"1"/.test(s.error); }), 'one names the start');
  ok(errors.some(function (s) { return /start/.test(s.error) && /-1/.test(s.error); }), 'and one names the negative start');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('');
console.log('The shapes the catalogue actually uses are still accepted:');
{
  const dir = fixture({
    // 207 specs are template-only.
    template: SW,
    // A template plus extra ports of a different family is legal and common: "24x RJ45 + 4x SFP".
    mixed: { vendor: 'Testco', model: 'TS-24+4', category: 'switch',
      portTemplate: { prefix: 'Gi', start: 1, count: 24 }, interfaces: [{ name: 'Te1/1/1', type: 'ethernet', speed: '10G' }] },
    // Explicit ports only.
    explicit: { vendor: 'Testco', model: 'TS-2', category: 'switch',
      interfaces: [{ name: 'eth0', type: 'ethernet', speed: '1G' }, { name: 'eth1', type: 'ethernet', speed: '1G' }] },
    // A template with no start, defaulting to 1.
    noStart: { vendor: 'Testco', model: 'TS-4', category: 'switch', portTemplate: { prefix: 'eth', count: 4 } }
  });
  const loaded = loadCatalog(dir);
  const errors = loaded.filter(function (s) { return s.error; });
  ok(errors.length === 0, 'four legitimate shapes all load', JSON.stringify(errors.map(function (e) { return e.error; })));
  const mixed = loaded.filter(function (s) { return s.model === 'TS-24+4'; })[0];
  ok(mixed && effectiveInterfaces(mixed).length === 25, 'the mixed one has 25 ports, not 24 and not 1',
    mixed && effectiveInterfaces(mixed).length);
  ok(mixed && effectiveInterfaces(mixed).filter(function (p) { return p.name === 'Te1/1/1'; }).length === 1,
    'with the SFP where it was written');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
