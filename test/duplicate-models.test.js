'use strict';
// One model, one spec - whatever punctuation the vendor uses.
//
// Issue #60: the catalogue held three devices twice under punctuation variants of one
// model name:
//   cisco ASR1001-X       ==  cisco ASR 1001-X
//   cisco ISR4331         ==  cisco ISR 4331
//   raspberrypi RaspberryPi5  ==  raspberrypi Raspberry Pi 5
// Nothing caught it. test/hardware-invariants.test.js compared the exact vendor+model
// string, so two spellings of one name were two identities as far as it was concerned,
// and the importer names files by slug(model) - "ASR1001-X" and "ASR 1001-X" slug
// differently - so nothing collided on disk either. The catalogue just offered the same
// box twice, and the ASR pair disagreed about the hardware: the compact copy modelled
// all eight built-in ports as 10G SFP+ where the datasheet has six 1G SFP-only cages.
//
// So this suite asserts the two things that let it happen cannot happen again:
//   1. every spec in the catalogue squashes to a distinct vendor+model key, and
//   2. the importer refuses a spec whose key is already taken, naming the owner.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadCatalog, modelKey } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const ROOT = path.join(__dirname, '..');
const catalog = loadCatalog(path.join(ROOT, 'devices'));

console.log('The catalogue holds one spec per device:');
{
  // The key, not the string, is the identity. modelKey() lives in devices/registry.js so
  // the importer's gate and this invariant can never drift apart on what "same model" means.
  const byKey = new Map();
  const dupes = [];
  for (const s of catalog) {
    const k = modelKey(s);
    if (byKey.has(k)) {
      const first = byKey.get(k);
      dupes.push(k + ' (' + first.vendor + '/' + first.model + ' == ' + s.vendor + '/' + s.model + ')');
    } else {
      byKey.set(k, s);
    }
  }
  ok(dupes.length === 0, 'no two specs share a normalised vendor+model key' +
    (dupes.length ? ' (' + dupes.slice(0, 3).join('; ') + ')' : ''));
  ok(catalog.length === byKey.size, 'every one of the ' + catalog.length +
    ' specs has a key of its own (' + byKey.size + ' distinct)');
}

console.log('\nThe three that were merged stay merged:');
{
  // Keeping the surviving spelling pinned means a careless re-import cannot quietly bring
  // the duplicate back: the compact spelling would fail the key check above, but it would
  // also mean the vendor spelling had been replaced, which is its own regression.
  const groups = [
    { vendor: 'cisco', model: 'ASR 1001-X', compact: 'ASR1001-X', key: 'cisco|asr1001x' },
    { vendor: 'cisco', model: 'ISR 4331', compact: 'ISR4331', key: 'cisco|isr4331' },
    { vendor: 'raspberrypi', model: 'Raspberry Pi 5', compact: 'RaspberryPi5', key: 'raspberrypi|raspberrypi5' },
    // Ubiquiti EdgeRouter 4, merged 2026-11-27: er-4.json (model ER-4) and edgerouter4.json
    // (model EdgeRouter-4) were the same router off the same tech-spec page, and the pair sat
    // in test/known-issues.json as an accepted duplicate name. The waiver is gone, so this
    // group keeps the retired string from coming back as a second spec.
    { vendor: 'ubiquiti', model: 'ER-4', compact: 'EdgeRouter-4', key: 'ubiquiti|er4' },
    // RADWIN 5000 JET, merged 2026-11-28: 5000-jet.json (model "5000 JET") and
    // radwin-5000-jet.json (model "RADWIN 5000 JET") were one sector base station, two
    // spellings, and an accepted duplicate label in test/known-issues.json. The vendor name
    // survives because RADWIN prints it on every brochure page and the sibling 2000 C row is
    // filed the same way; the bare string stays searchable as an alias.
    { vendor: 'radwin', model: 'RADWIN 5000 JET', compact: '5000 JET', key: 'radwin|radwin5000jet' }
  ];
  const missing = [], reverted = [], wrongKey = [];
  for (const g of groups) {
    const kept = catalog.find(function (s) { return s.vendor === g.vendor && s.model === g.model; });
    if (!kept) missing.push(g.vendor + '/' + g.model);
    else if (modelKey(kept) !== g.key) wrongKey.push(g.model + ' -> ' + modelKey(kept));
    if (catalog.some(function (s) { return s.vendor === g.vendor && s.model === g.compact; })) {
      reverted.push(g.vendor + '/' + g.compact);
    }
  }
  ok(missing.length === 0, 'the vendor spelling of each merged model is in the catalogue' +
    (missing.length ? ' (missing ' + missing.join(', ') + ')' : ''));
  ok(reverted.length === 0, 'the compact spelling is gone, not kept beside it' +
    (reverted.length ? ' (' + reverted.join(', ') + ')' : ''));
  ok(wrongKey.length === 0, 'each one squashes to the key it was merged under' +
    (wrongKey.length ? ' (' + wrongKey.join(', ') + ')' : ''));
}

console.log('\nThe EdgeRouter 4 merge kept the hardware, not just the name:');
{
  // Deleting the twin is only half the fix. The retired copy was the researched one, so the
  // surviving ER-4 row has to carry the four interfaces and the PoE verdict the tech-spec page
  // states, and the retired model string has to still find it - otherwise the merge traded a
  // duplicate for a router nobody can search by the name they used yesterday.
  const er4 = catalog.find(function (s) { return s.vendor === 'ubiquiti' && s.model === 'ER-4'; });
  ok(!!er4, 'ubiquiti/ER-4 is in the catalogue');
  const ifaces = (er4 && er4.interfaces) || [];
  ok(ifaces.length === 4, 'four interfaces, as the tech-spec page counts them (' + ifaces.length + ')');
  const copper = ifaces.filter(function (i) { return i.connector === 'rj45'; });
  const cages = ifaces.filter(function (i) { return i.connector === 'sfp'; });
  ok(copper.length === 3, '3x RJ45 (' + copper.length + ')');
  ok(cages.length === 1 && cages[0].speed === '1G', '1x 1G SFP, not SFP+');
  ok(copper.every(function (i) { return i.poeIn === false; }),
    'the AC-only copper ports are declared unable to power the box, not left to the engine guess');
  const alias = (er4 && er4.aliases) || [];
  ok(alias.indexOf('EdgeRouter-4') !== -1, 'the retired model string is an alias of the survivor');
}

console.log('\nThe RADWIN 5000 JET merge corrected the ports, not just the name:');
{
  // Both copies of this radio claimed one RJ45 plus one SFP cage. The vendor's HBS interfaces
  // row says two 10/100/1000BaseT ports and nothing else, so the merge had to retire the
  // phantom cage as well as the duplicate - a PtMP base station with an SFP this platform
  // never had is the kind of port a lab only discovers by ordering the wrong transceiver.
  const jet = catalog.find(function (s) { return s.vendor === 'radwin' && s.model === 'RADWIN 5000 JET'; });
  ok(!!jet, 'radwin/RADWIN 5000 JET is in the catalogue');
  const ifaces = (jet && jet.interfaces) || [];
  const copper = ifaces.filter(function (i) { return i.connector === 'rj45'; });
  const cages = ifaces.filter(function (i) { return i.connector === 'sfp' || i.connector === 'sfp+'; });
  ok(copper.length === 2, 'two 10/100/1000BaseT ports, as the Interfaces row counts them (' + copper.length + ')');
  ok(cages.length === 0, 'no SFP cage - that port belongs to the later JET PRO/DUO/AIR generation (' + cages.length + ')');
  ok(copper.every(function (i) { return JSON.stringify(i.speedCaps) === '[10,100,1000]'; }),
    'both copper ports admit 10M, 100M and 1G');
  const powered = copper.filter(function (i) { return i.poeIn === 25; });
  ok(powered.length === 1 && powered[0].name === 'eth0',
    'exactly one port sinks the HBS draw (< 25 W), and it is the data port');
  const mgmt = copper.filter(function (i) { return i.name === 'eth1'; })[0];
  ok(!!mgmt && mgmt.poeIn === false, 'the management port is declared unable to sink power');
  ok(ifaces.filter(function (i) { return i.type === 'wireless'; }).length === 1, 'one radio interface');
  const alias = (jet && jet.aliases) || [];
  ok(alias.indexOf('5000 JET') !== -1, 'the retired model string is an alias of the survivor');
}

// The importer's gate, exercised on throwaway trees via PF_DEVICES / PF_INCOMING.
function runImporter(args, env) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'import-devices.js')].concat(args), {
    env: env, encoding: 'utf8'
  });
  return { status: r.status, out: String(r.stdout || '') + String(r.stderr || '') };
}

function scratchTree() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-dupes-'));
  const devices = path.join(tmp, 'devices');
  const incoming = path.join(tmp, 'incoming');
  fs.mkdirSync(path.join(devices, 'acme'), { recursive: true });
  fs.mkdirSync(incoming, { recursive: true });
  return { tmp: tmp, devices: devices, incoming: incoming,
    env: Object.assign({}, process.env, { PF_DEVICES: devices, PF_INCOMING: incoming }) };
}

function spec(model, extra) {
  return Object.assign({
    vendor: 'acme', model: model, label: model, category: 'router',
    description: model + ' lab router', capabilities: ['l3-forward', 'cli'],
    interfaces: [{ name: 'eth0', type: 'ethernet', speed: '1G' }]
  }, extra || {});
}

function specFiles(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (/\.json$/i.test(e.name)) out.push(p);
    }
  })(dir);
  return out;
}

console.log('\nThe importer refuses a spec that collides with an existing device:');
{
  // "ROUTER-9000" is on disk; the research batch brings "ROUTER 9000", the same box with a
  // space. slug() would have written acme/router-9000.json over the top of the existing
  // spec on some vendors and a second file on others - either way the catalogue would hold
  // one model twice, so the importer must refuse it and say whose key it is.
  const t = scratchTree();
  fs.writeFileSync(path.join(t.devices, 'acme', 'router-9000.json'),
    JSON.stringify(spec('ROUTER-9000'), null, 2));
  fs.writeFileSync(path.join(t.incoming, 'devices-collide.json'), JSON.stringify([
    spec('ROUTER 9000'),
    spec('ROUTER-9001')
  ], null, 2));

  const r = runImporter(['--apply'], t.env);

  ok(r.status !== 0, 'the batch fails instead of silently skipping it (exit ' + r.status + ')');
  ok(/Refused - already in the catalogue under a different spelling/.test(r.out),
    'it reports a refusal, not a routine duplicate');
  ok(/duplicate model: acme\/ROUTER 9000 is the same device as the existing acme\/ROUTER-9000/.test(r.out),
    'and names the spec it collides with');
  ok(/normalised key acme\|router9000/.test(r.out), 'and the key that collided');
  ok(/acme\/router-9000\.json/.test(r.out), 'and where the owner lives');

  const written = specFiles(t.devices).map(function (p) { return path.basename(p); }).sort();
  ok(written.indexOf('router-9000.json') !== -1 && written.indexOf('router-9001.json') !== -1,
    'the collider did not overwrite the existing spec (' + written.join(', ') + ')');
  ok(written.length === 2, 'exactly two spec files exist - the collider was not written (' + written.length + ')');

  const kept = JSON.parse(fs.readFileSync(path.join(t.devices, 'acme', 'router-9000.json'), 'utf8'));
  ok(kept.model === 'ROUTER-9000', 'the existing spelling is untouched (' + kept.model + ')');
  ok(/Added: 1/.test(r.out), 'the clean spec in the same batch was still imported');

  fs.rmSync(t.tmp, { recursive: true, force: true });
}

console.log('\nA batch cannot introduce both spellings itself:');
{
  // The catalogue is empty here, so the collision is entirely inside the incoming file. Both
  // specs slug to acme/gadget-1.json, which is how one batch could once have written one
  // model twice - the second write landing on the first file's name.
  const t = scratchTree();
  fs.writeFileSync(path.join(t.incoming, 'devices-twice.json'),
    JSON.stringify([spec('GADGET-1'), spec('Gadget 1')], null, 2));

  const r = runImporter(['--apply'], t.env);
  ok(r.status !== 0, 'the batch is refused (exit ' + r.status + ')');
  ok(/duplicate model: acme\/Gadget 1 is the same device as the existing acme\/GADGET-1/.test(r.out),
    'the second spelling is measured against the first spec in the same run');
  ok(specFiles(t.devices).length === 1, 'only one of the two spellings reached disk');

  fs.rmSync(t.tmp, { recursive: true, force: true });
}

console.log('\nAn exact re-import is still a no-op, not a collision:');
{
  // Re-running a research file over the catalogue it came from has to stay harmless, so the
  // gate must distinguish "same string" (benign, reported as a duplicate, repairable with
  // --upgrade) from "same model spelled differently" (a modelling error worth failing on).
  const t = scratchTree();
  const original = spec('ROUTER-9000');
  fs.writeFileSync(path.join(t.devices, 'acme', 'router-9000.json'), JSON.stringify(original, null, 2));
  fs.writeFileSync(path.join(t.incoming, 'devices-same.json'), JSON.stringify([original], null, 2));

  const r = runImporter(['--apply'], t.env);
  ok(r.status === 0, 'the import succeeds (exit ' + r.status + ')');
  ok(/duplicates: 1/.test(r.out), 'the spec is reported as a duplicate');
  ok(!/Refused - already in the catalogue/.test(r.out), 'and not as a refused spelling');
  ok(specFiles(t.devices).length === 1, 'no second file was created');

  fs.rmSync(t.tmp, { recursive: true, force: true });
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
