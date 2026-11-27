'use strict';
// The TP-Link Omada/JetStream access ports are RJ-45 10/100/1000BASE-T jacks, and the spec
// has to say so.
//
// TP-Link datasheet Interfaces rows for these models:
//   TL-SG2210MP  "8x 10/100/1000 Mbps RJ45 Ports, 2x Gigabit SFP Slots"
//   TL-SG3428    "24x 10/100/1000 Mbps RJ45 Ports, 4x Gigabit SFP Slots"
//   TL-SG3428X   "24x 10/100/1000 Mbps RJ45 Ports, 4x 10G SFP+ Slots"
//   TL-SG3428XMP "24x 10/100/1000 Mbps RJ45 PoE+ Ports, 4x 10G SFP+ Slots"
//   TL-SG3452    "48x 10/100/1000 Mbps RJ45 Ports, 4x Gigabit SFP Slots"
//   TL-SG3452X   "48x 10/100/1000 Mbps RJ45 Ports, 4x 10G SFP+ Slots"
//
// All six declared those ports with a portTemplate that named only a rate -- type ethernet,
// speed 1G, no connector and no speedCaps -- so the cage and the ladder were inferred from
// "1G" (engine/media.js -> inferCage). That inference happened to be right and could never be
// contradicted, which is issue #1398: the declaration is silent, so nothing in the spec can
// disagree with the engine.
//
// Before this change every spec below had portTemplate.connector === undefined and
// portTemplate.speedCaps === undefined. The three 1G-uplink models also had SFP1..SFP4 with
// no connector -- still an inference, though from the port name -- and now declare the cage
// their datasheet names.
const fs = require('fs');
const path = require('path');
const { Topology, Simulator } = require('../engine');
const media = require('../engine/media');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  OK ' + msg); }
  else { failed++; console.error('  FAIL ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
function section(name) { console.log('\n' + name); }

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
function spec(model) {
  const s = catalog.filter(function (x) { return x.vendor === 'tp-link' && x.model === model; })[0];
  if (!s) throw new Error('missing spec ' + model);
  return s;
}

// model -> [access ports, uplink ports, uplink cage, uplink ladder]
const ROWS = {
  'TL-SG2210MP': [8, 2, 'sfp', [1000]],
  'TL-SG3428': [24, 4, 'sfp', [1000]],
  'TL-SG3428X': [24, 4, 'sfp+', [1000, 10000]],
  'TL-SG3428XMP': [24, 4, 'sfp+', [1000, 10000]],
  'TL-SG3452': [48, 4, 'sfp', [1000]],
  'TL-SG3452X': [48, 4, 'sfp+', [1000, 10000]]
};

section('The template declares the jack and the ladder, not just a rate');
for (const model of Object.keys(ROWS)) {
  const row = ROWS[model];
  const tpl = spec(model).portTemplate || {};
  ok(tpl.connector === 'rj45', model + ': portTemplate declares connector rj45', 'connector=' + String(tpl.connector));
  ok(JSON.stringify(tpl.speedCaps) === JSON.stringify([10, 100, 1000]),
    model + ': portTemplate declares speedCaps [10,100,1000]', JSON.stringify(tpl.speedCaps));
  ok(tpl.count === row[0], model + ': template still generates ' + row[0] + ' ports', 'count=' + tpl.count);
}

section('No TP-Link spec leaves a template guessing -- the vendor-wide version of #1398');
for (const file of fs.readdirSync(path.join(__dirname, '..', 'devices', 'tp-link'))) {
  if (!file.endsWith('.json')) continue;
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'devices', 'tp-link', file), 'utf8'));
  if (!raw.portTemplate) continue;
  ok(!!raw.portTemplate.connector,
    file + ': portTemplate declares a connector', 'connector=' + String(raw.portTemplate.connector));
  ok(Array.isArray(raw.portTemplate.speedCaps) && raw.portTemplate.speedCaps.length > 0,
    file + ': portTemplate declares a speed ladder', JSON.stringify(raw.portTemplate.speedCaps));
}

section('And the ports the template expands to carry it');
for (const model of Object.keys(ROWS)) {
  const count = ROWS[model][0];
  const t = new Topology();
  const sw = t.addDevice(spec(model), 'SW');
  const bad = [];
  for (let n = 1; n <= count; n++) {
    const p = sw.interfaces.get('Gi0/' + n);
    if (!p) { bad.push(n + '=missing'); continue; }
    const caps = (p.hardware && p.hardware.speedCaps) || [];
    const offered = (p.hardware && p.hardware.media) || [];
    const wrong = p.cage !== 'rj45' || caps.indexOf(10) === -1 || caps.indexOf(100) === -1 ||
      caps.indexOf(1000) === -1 || caps.indexOf(2500) !== -1 || caps.indexOf(10000) !== -1 ||
      offered.indexOf('10base-t') === -1 || offered.indexOf('100base-tx') === -1 ||
      offered.indexOf('1000base-t') === -1;
    if (wrong) bad.push('Gi0/' + n + '=' + p.cage + JSON.stringify(caps));
  }
  ok(bad.length === 0, model + ': all ' + count + ' access ports are RJ-45 at 10/100/1000' +
    (bad.length ? ' (' + bad.slice(0, 4).join(', ') + ')' : ''));
}

section('Cabling: a copper patch cord meets the port, a fibre optic does not');
{
  const t = new Topology();
  const sw = t.addDevice(spec('TL-SG3452X'), 'SW');
  const a = sw.interfaces.get('Gi0/1');
  const b = sw.interfaces.get('Gi0/48');
  const cord = media.canMate(a.hardware, b.hardware);
  ok(cord.ok === true, 'two access ports meet over a copper patch cord', cord.code);
  const fibre = media.canMate(a.hardware, sw.interfaces.get('SFP+1').hardware);
  ok(fibre.ok === false && fibre.code === 'E_CONNECTOR_MISMATCH',
    'a fibre uplink cannot be pushed into an access jack',
    fibre.code + ': ' + fibre.message);
}

section('The uplinks are the uplinks: this pass did not move them');
for (const model of Object.keys(ROWS)) {
  const row = ROWS[model];
  const t = new Topology();
  const sw = t.addDevice(spec(model), 'SW');
  const names = [...sw.interfaces.keys()];
  const uplinks = names.slice(row[0]);
  ok(uplinks.length === row[1], model + ': still ' + uplinks.length + ' uplink ports', uplinks.join(','));
  const bad = [];
  for (const name of uplinks) {
    const p = sw.interfaces.get(name);
    if (!p || p.cage !== row[2]) bad.push(name + '=' + (p && p.cage));
    else if (JSON.stringify(p.hardware.speedCaps) !== JSON.stringify(row[3])) {
      bad.push(name + ' caps=' + JSON.stringify(p.hardware.speedCaps));
    }
  }
  ok(bad.length === 0, model + ': every uplink is a ' + row[2] + ' cage at ' + JSON.stringify(row[3]) +
    (bad.length ? ' (' + bad.join(', ') + ')' : ''));
}

section('PoE stays on the copper jacks that carry it');
{
  // TL-SG2210MP declared 802.3af/at and a 150 W budget in its description while its
  // template carried no poeOut at all, so the model could not power anything: the
  // switch was a PSE on paper only. It now declares 30 W per port and 150 W on the chassis.
  const t = new Topology();
  const sw = t.addDevice(spec('TL-SG2210MP'), 'SW');
  const pd = t.addDevice(catalog.filter(function (x) { return x.vendor === 'mikrotik' && x.model === 'RBSXTsqG-5acD'; })[0], 'PD');
  ok(sw.poeBudget === 150, 'TL-SG2210MP: the chassis declares its 150 W budget', String(sw.poeBudget));
  const cord = t.connect(pd.id, 'eth1', sw.id, 'Gi0/1');
  ok(!!cord, 'a PoE powered device cables into Gi0/1');
  const poe = new Simulator(t).computePoe()[0] || { ports: [] };
  const port = (poe.ports || []).filter(function (x) { return x.iface === 'Gi0/1'; })[0];
  ok(!!port && port.powered === true, 'Gi0/1 powers the device', JSON.stringify(port));
  ok(pd.poeUnpowered === false, 'and the device is not marked unpowered');
}

for (const model of ['TL-SG2210MP', 'TL-SG3428XMP']) {
  const t = new Topology();
  const sw = t.addDevice(spec(model), 'SW');
  const count = ROWS[model][0];
  const dead = [];
  for (let n = 1; n <= count; n++) {
    const p = sw.interfaces.get('Gi0/' + n);
    if (!p || !(p.hardware && p.hardware.poeOut > 0)) dead.push('Gi0/' + n);
  }
  ok(dead.length === 0, model + ': all ' + count + ' copper ports still declare a PoE budget' +
    (dead.length ? ' (' + dead.slice(0, 4).join(', ') + ')' : ''));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
