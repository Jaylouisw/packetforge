'use strict';
// Two 2930F shelves that look identical in a rack and are not (#575, #950).
//
// Aruba sells the 48G PoE+ switch with either four 1G SFP uplinks (JL557A) or four 10G
// SFP+ uplinks (JL256A). The copper side is the same, the PoE budget is 740 W on both of
// the SKUs modelled here, and the only difference is the four cages on the right-hand side.
//
// That distinction is the reason to keep both specs. "Add an uplink, raise the port speed"
// reads like configuration; on this hardware it is a different part number and a purchase.
// A 10G module physically seats in a 1G SFP cage, so nothing about the shape of the link
// tells you it is wrong - only the rate ladder does.
//
// What is locked here:
//   1. both SKUs are 52 ports with 48 RJ45 access ports;
//   2. JL557A uplinks are 1G SFP cages and offer no 10G rate at all;
//   3. JL256A uplinks are SFP+ cages offering 1G *and* 10G, all four identical;
//   4. a 10G-only peer is refused by the JL557A on speed - not on connector, because the
//      module fits - and accepted by the JL256A at 10G;
//   5. the PoE budget is the SKU's own 740 W, not the family's 370 W.
const path = require('path');
const { Topology } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.log('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + ' (expected ' + JSON.stringify(expected) +
    ', got ' + JSON.stringify(actual) + ')');
}
function section(name) { console.log('\n' + name); }

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(model) {
  const s = catalog.find(function (x) { return x.model === model; });
  if (!s) throw new Error('missing spec ' + model);
  return s;
}
function codes(res) {
  return ((res && res.errors) || []).map(function (x) { return x.code; });
}

const JL557A = '2930F 48G PoE+ 4SFP 740W (JL557A)';
const JL256A = '2930F 48G PoE+ 4SFP+';
const UPLINKS = ['49', '50', '51', '52'];

section('1. Both SKUs are 52 ports with 48 copper access ports');
{
  for (const model of [JL557A, JL256A]) {
    const sw = new Topology().addDevice(spec(model));
    const names = Array.from(sw.interfaces.keys());
    eq(names.length, 52, model + ': 52 ports');
    const copper = names.slice(0, 48).map(function (n) { return sw.interfaces.get(n); });
    ok(copper.every(function (i) { return i.hardware.cage === 'rj45'; }),
      model + ': the 48 access ports are RJ45');
    ok(copper.every(function (i) { return i.hardware.speedCaps.indexOf(1000) !== -1; }),
      model + ': and every one of them runs gigabit');
  }
}

section('2. The uplinks are the only difference - and it is a real one');
{
  const gbe = new Topology().addDevice(spec(JL557A));
  const tenG = new Topology().addDevice(spec(JL256A));

  for (const name of UPLINKS) {
    eq(gbe.interfaces.get(name).hardware.cage, 'sfp', 'JL557A port ' + name + ' is an SFP cage');
    eq(gbe.interfaces.get(name).hardware.speedCaps.join(','), '1000',
      'JL557A port ' + name + ' offers 1G and nothing above it');
    eq(tenG.interfaces.get(name).hardware.cage, 'sfp+', 'JL256A port ' + name + ' is an SFP+ cage');
    eq(tenG.interfaces.get(name).hardware.speedCaps.join(','), '1000,10000',
      'JL256A port ' + name + ' offers 1G and 10G');
  }
  eq(new Set(UPLINKS.map(function (n) {
    return tenG.interfaces.get(n).hardware.speedCaps.join(',');
  })).size, 1, 'and all four JL256A uplinks are identical');
}

section('3. A 10G-only link is refused by the JL557A and carried by the JL256A');
{
  // The peer can only ever run 10G, so the outcome is about the Aruba cage and nothing else.
  const tenGOnly = spec('CCR2116-12G-4S+');

  const t = new Topology();
  const a = t.addDevice(spec(JL557A));
  const peer = t.addDevice(tenGOnly);
  const refused = t.validateLink(a.id, '49', peer.id, 'SFP+1');
  eq(refused.ok, false, 'the JL557A cannot carry a 10G-only link');
  ok(codes(refused).indexOf('E_NO_COMMON_SPEED') !== -1,
    'the refusal is about speed, which is the honest reason');
  ok(codes(refused).indexOf('E_CONNECTOR_MISMATCH') === -1,
    'not about the connector: a 10G module seats in a 1G SFP cage');

  const t2 = new Topology();
  const b = t2.addDevice(spec(JL256A));
  const peer2 = t2.addDevice(tenGOnly);
  const carried = t2.validateLink(b.id, '49', peer2.id, 'SFP+1');
  eq(carried.ok, true, 'the JL256A carries the same link on port 49');
  eq(carried.speedMbps, 10000, 'at 10 Gbps');
}

section('4. The PoE budget belongs to the SKU, not the family');
{
  eq(new Topology().addDevice(spec(JL557A)).poeBudget, 740, 'JL557A: 740 W');
  eq(new Topology().addDevice(spec(JL256A)).poeBudget, 370, 'JL256A entry in this catalogue: 370 W');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
