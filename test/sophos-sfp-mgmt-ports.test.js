'use strict';
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
function spec(vendor, model) {
  const s = catalog.filter(function (x) { return x.vendor === vendor && x.model === model; })[0];
  if (!s) throw new Error('missing spec ' + vendor + '/' + model);
  return s;
}
function portOf(vendor, model, name) {
  const t = new Topology();
  const d = t.addDevice(spec(vendor, model), 'D');
  const p = d.interfaces.get(name);
  if (!p) throw new Error('missing port ' + model + '/' + name);
  return p;
}
function peer(connector, caps) {
  return media.derivePortHardware({ name: 'eth0', connector: connector,
    speed: (caps[caps.length - 1] / 1000) + 'G', speedCaps: caps }, { model: 'PEER' });
}
function mate(vendor, model, name, connector, caps) {
  return media.canMate(portOf(vendor, model, name).hardware, peer(connector, caps));
}
// PRE-FIX, the derived hardware was:
//   XGS 3100/PortF1  rj45  10/100/1000/2500/5000/10000  (the first fibre uplink presented as copper)
//   XGS 3100/PortF3  sfp+  1000/10000                   (a 1G SFP cage that took a 10G module)
//   XGS 4300/PortF1  rj45  10/100/1000/2500/5000/10000  (same as 3100/PortF1)
//   XGS 2100/PortF1  rj45  10/100/1000                  (1G SFP presented as GE copper)
//   MGMT (all three) sfp+/sfp                           (the management jack wearing a fibre cage)
const SFP10 = peer('sfp+', [1000, 10000]);
const COPPER1 = peer('rj45', [10, 100, 1000]);
section('The 10G SFP+ uplinks are SFP+ cages, not copper');
[
  { model: 'XGS 3100', names: ['PortF1', 'PortF2'] },
  { model: 'XGS 4300', names: ['PortF1', 'PortF2', 'PortF3', 'PortF4'] }
].forEach(function (box) {
  box.names.forEach(function (name) {
    const hw = portOf('sophos', box.model, name).hardware;
    ok(hw.cage === 'sfp+', box.model + '/' + name + ' is an SFP+ cage', hw.cage);
    ok(JSON.stringify(hw.speedCaps) === '[1000,10000]',
      box.model + '/' + name + ' runs at 1G and 10G (' + hw.speedCaps.join(',') + ')');
  });
});
section('A 10G optic seats in PortF1, and a copper lead does not');
{
  const v = mate('sophos', 'XGS 3100', 'PortF1', 'sfp+', [1000, 10000]);
  ok(v.ok === true, '10GBASE-SR into XGS 3100/PortF1 connects (was a connector mismatch)', v.code + ': ' + v.message);
  ok(v.speedMbps === 10000, 'at 10000 Mbps (' + v.speedMbps + ')');
  ok((v.media || []).some(function (m) { return /^10gbase/.test(m); }),
    'over a 10G optic (' + (v.media || []).filter(function (m) { return /^10gbase/.test(m); }).join(', ') + ')');
  const c = mate('sophos', 'XGS 3100', 'PortF1', 'rj45', [100, 1000, 10000]);
  ok(c.ok === false, 'a 10GBASE-T copper lead is refused by XGS 3100/PortF1 (there is no jack)', c.code + ': ' + c.message);
  const lr = mate('sophos', 'XGS 4300', 'PortF1', 'sfp+', [1000, 10000]);
  ok(lr.ok === true && lr.speedMbps === 10000, 'XGS 4300/PortF1 takes the same 10G optic at 10G',
    lr.ok ? String(lr.speedMbps) : lr.code);
}
section('The 1G SFP uplinks stay at 1G');
[
  { model: 'XGS 3100', names: ['PortF3', 'PortF4'] },
  { model: 'XGS 2100', names: ['PortF1', 'PortF2'] }
].forEach(function (box) {
  box.names.forEach(function (name) {
    const hw = portOf('sophos', box.model, name).hardware;
    ok(hw.cage === 'sfp', box.model + '/' + name + ' is a 1G SFP cage', hw.cage);
    ok(JSON.stringify(hw.speedCaps) === '[1000]',
      box.model + '/' + name + ' runs at 1G only (' + hw.speedCaps.join(',') + ')');
    const one = mate('sophos', box.model, name, 'sfp', [1000]);
    ok(one.ok === true && one.speedMbps === 1000,
      'a 1000BASE-SX module links at 1000 (' + (one.ok ? one.speedMbps : one.code) + ')');
    const ten = mate('sophos', box.model, name, 'sfp+', [1000, 10000]);
    ok(ten.speedMbps === 1000,
      'a pair of SFP+ modules in it still meet at 1G, never 10G (' +
      (ten.ok ? ten.speedMbps : ten.code) + ')');
  });
});
section('MGMT is the 1G copper management jack');
['XGS 2100', 'XGS 3100', 'XGS 4300'].forEach(function (model) {
  const hw = portOf('sophos', model, 'MGMT').hardware;
  ok(hw.cage === 'rj45', model + '/MGMT is an RJ-45 jack', hw.cage);
  ok(hw.maxSpeedMbps === 1000, model + '/MGMT tops out at 1G (' + hw.maxSpeedMbps + ')');
  const g = mate('sophos', model, 'MGMT', 'rj45', [10, 100, 1000]);
  ok(g.ok === true && g.speedMbps === 1000, 'a GE copper link comes up at 1000 (' + (g.ok ? g.speedMbps : g.code) + ')');
  const f = mate('sophos', model, 'MGMT', 'rj45', [10, 100]);
  ok(f.ok === true && f.speedMbps === 100, 'and a 100BASE-TX link at 100 (' + (f.ok ? f.speedMbps : f.code) + ')');
  const ten = mate('sophos', model, 'MGMT', 'sfp+', [1000, 10000]);
  ok(ten.ok === false, 'a 10G SFP+ module is refused', ten.code + ': ' + ten.message);
});

section('The access ports are untouched');
{
  const hw = portOf('sophos', 'XGS 3100', 'Port1').hardware;
  ok(hw.cage === 'rj45' && JSON.stringify(hw.speedCaps) === '[10,100,1000]',
    'XGS 3100/Port1 is still 10/100/1000BASE-T copper (' + hw.speedCaps.join(',') + ')');
  const l = mate('sophos', 'XGS 3100', 'Port1', 'rj45', [10, 100, 1000]);
  ok(l.ok === true && l.speedMbps === 1000, 'and still links a GE copper peer at 1000');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
