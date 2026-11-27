'use strict';
// Every access port on an Aruba CX 6000 / 6200F / 6300M copper model is an RJ-45 10/100/1000BASE-T jack,
// and the spec has to say so.
//
// HPE's description line for each of these models opens with the port count and the rate set:
//
//   CX6000 data sheet (a00112996enw): "48x 10/100/1000BASE-T Class 4 PoE ports"  (R8N85A)
//                                     "24x 10/100/1000BASE-T ports 4x 1G SFP ports" (R8N88A)
//   CX 6200F specifications (a00099581en_us): "48x Ports 10/100/1000BASE-T ports"  (JL726A)
//   CX 6300 QuickSpecs (a00073540enw): "48x ports 10/100/1000 BaseT ports"         (JL663A)
//
// The ten specs in the catalogue declared those ports with a portTemplate that named only a rate:
// type ethernet, speed 1G, no connector. The engine then inferred rj45 from "1G", which happened to be
// right and could never be wrong out loud — issue #1398's point ("the declaration is silent, so there
// is nothing to contradict"). research/aruba-cx-copper-ports.md records the sources.
//
// Before this change every spec below had portTemplate.connector === undefined, so the first section
// fails on all ten; the rest pins the behaviour the declaration is supposed to describe.
const path = require('path');
const { Topology } = require('../engine');
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
  const s = catalog.filter(function (x) { return x.vendor === 'aruba' && x.model === model; })[0];
  if (!s) throw new Error('missing spec ' + model);
  return s;
}

// model -> access-port count, i.e. the whole 1/1/1..N run the template generates
const COPPER_ROWS = {
  'CX 6000 24G 4SFP': 24,
  'CX 6000 24G CL4 PoE 4SFP 370W': 24,
  'CX 6000 48G 4SFP': 48,
  'CX 6000 48G CL4 PoE 4SFP 370W': 48,
  'CX 6200F 24G 4SFP+': 24,
  'CX 6200F 24G CL4 PoE 4SFP+': 24,
  'CX 6200F 48G 4SFP+': 48,
  'CX 6200F 48G CL4 PoE 4SFP+': 48,
  'CX 6300M 48G 4SFP56': 48,
  'CX 6300M 48G CL4 PoE 4SFP56': 48
};

section('The template declares the jack and the ladder, not just a rate');
for (const [model, count] of Object.entries(COPPER_ROWS)) {
  const s = spec(model);
  const tpl = s.portTemplate || {};
  ok(tpl.connector === 'rj45', model + ': portTemplate declares connector rj45', 'connector=' + String(tpl.connector));
  ok(JSON.stringify(tpl.speedCaps) === JSON.stringify([10, 100, 1000]),
    model + ': portTemplate declares speedCaps [10,100,1000]', JSON.stringify(tpl.speedCaps));
  ok(tpl.count === count, model + ': template still generates ' + count + ' ports', 'count=' + tpl.count);
}

section('And the ports the template expands to carry it');
for (const [model, count] of Object.entries(COPPER_ROWS)) {
  const t = new Topology();
  const sw = t.addDevice(spec(model), 'SW');
  const bad = [];
  for (let n = 1; n <= count; n++) {
    const p = sw.interfaces.get('1/1/' + n);
    if (!p) { bad.push(n + '=missing'); continue; }
    const caps = (p.hardware && p.hardware.speedCaps) || [];
    const offered = (p.hardware && p.hardware.media) || [];
    const wrong = p.cage !== 'rj45' || caps.indexOf(10) === -1 || caps.indexOf(100) === -1 ||
      caps.indexOf(1000) === -1 || caps.indexOf(2500) !== -1 ||
      offered.indexOf('10base-t') === -1 || offered.indexOf('100base-tx') === -1 || offered.indexOf('1000base-t') === -1;
    if (wrong) bad.push('1/1/' + n + '=' + p.cage + JSON.stringify(caps));
  }
  ok(bad.length === 0, model + ': all ' + count + ' access ports are RJ-45 at 10/100/1000' +
    (bad.length ? ' (' + bad.slice(0, 4).join(', ') + ')' : ''));
}

section('Cabling: a copper patch cord meets the port, a fibre optic does not');
{
  const t = new Topology();
  const sw = t.addDevice(spec('CX 6000 48G 4SFP'), 'SW');
  const p1 = sw.interfaces.get('1/1/1'), p2 = sw.interfaces.get('1/1/48');
  const g = media.canMate(p1.hardware, p2.hardware, { mediaId: '1000base-t' });
  ok(g.ok === true, 'two access ports meet over a 1000BASE-T patch cord', g.code + ': ' + g.message);
  ok(g.speedMbps === 1000, 'at 1G', String(g.speedMbps));
  const h = media.canMate(p1.hardware, p2.hardware, { mediaId: '100base-tx' });
  ok(h.ok === true, 'a 100BASE-TX cord is not refused', h.code + ': ' + h.message);
  const c = media.canMate(p1.hardware, p2.hardware, { mediaId: '10base-t' });
  ok(c.ok === true, 'nor a 10BASE-T one', c.code + ': ' + c.message);
  const fibre = media.canMate(p1.hardware, sw.interfaces.get('1/1/49').hardware, { mediaId: '1000base-sx' });
  ok(fibre.ok === false && fibre.code === 'E_CONNECTOR_MISMATCH',
    'a 1000BASE-SX optic into an access port is refused as a connector mismatch',
    fibre.code + ': ' + fibre.message);
}

section('The uplinks are the uplinks: this pass did not touch them');
{
  const expect = [
    ['CX 6000 48G 4SFP', '1/1/49', 'sfp', [1000]],
    ['CX 6200F 48G 4SFP+', '1/1/49', 'sfp+', [1000, 10000]],
    ['CX 6300M 48G 4SFP56', '1/1/49', 'sfp28', [1000, 10000, 25000]]
  ];
  for (const [model, name, cage, caps] of expect) {
    const t = new Topology();
    const sw = t.addDevice(spec(model), 'SW');
    const p = sw.interfaces.get(name);
    ok(p && p.cage === cage, model + ': ' + name + ' is still a ' + cage + ' cage', p && p.cage);
    ok(p && JSON.stringify(p.hardware.speedCaps) === JSON.stringify(caps),
      model + ': ' + name + ' ladder is unchanged at ' + JSON.stringify(caps),
      p && JSON.stringify(p.hardware.speedCaps));
  }
}

section('A PoE model puts PoE on all of its copper ports, because that is what the jack is for');
{
  const t = new Topology();
  const sw = t.addDevice(spec('CX 6200F 48G CL4 PoE 4SFP+'), 'PoE');
  const dead = [];
  for (let n = 1; n <= 48; n++) {
    const p = sw.interfaces.get('1/1/' + n);
    if (!p || p.cage !== 'rj45' || !(p.hardware && p.hardware.poeOut > 0)) dead.push('1/1/' + n);
  }
  ok(dead.length === 0, '48 copper ports, all with a PoE budget' + (dead.length ? ' (' + dead.slice(0, 4).join(', ') + ')' : ''));
  ok((spec('CX 6200F 48G CL4 PoE 4SFP+').poe || {}).budgetW === 370, 'and the model still declares its 370 W budget');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
