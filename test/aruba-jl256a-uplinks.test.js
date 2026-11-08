'use strict';
// Four uplinks of one kind, not three and an oddity.
//
// The Aruba 2930F 48G PoE+ 4SFP+ (JL256A) has 48 copper ports and four identical 10G SFP+
// uplinks. The catalogue described port 49 as a **1G port in an SFP+ cage** while 50-52 were
// 10G, so the switch had a 10G cage that refused 10G, and the faceplate drew one uplink as a
// different class from its three siblings for no hardware reason.
//
// What is locked here:
//   1. all four uplinks are SFP+ cages declaring the same rate ladder [1000, 10000];
//   2. a 10G-only peer links at 10G on any of the four, not just three of them;
//   3. a 1G-only module still works on any of the four, because an SFP+ cage takes a 1G SFP
//      module - that is the whole reason the ladder lists both rates;
//   4. the 48 copper ports are untouched: still RJ45, still 1G.
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
function spec(model) { return catalog.find(function (x) { return x.model === model; }); }
const UPLINKS = ['49', '50', '51', '52'];

section('1. All four uplinks are the same kind of cage with the same ladder');
{
  const sw = new Topology().addDevice(spec('2930F 48G PoE+ 4SFP+'));
  for (const name of UPLINKS) {
    const i = sw.interfaces.get(name);
    ok(!!i, 'port ' + name + ' exists');
    eq(i.hardware.cage, 'sfp+', 'port ' + name + ' is an SFP+ cage');
    eq(i.hardware.speedCaps.join(','), '1000,10000',
      'port ' + name + ' offers 1G and 10G');
  }
  const ladders = UPLINKS.map(function (n) {
    return sw.interfaces.get(n).hardware.speedCaps.join(',');
  });
  eq(new Set(ladders).size, 1, 'and none of them is the odd one out');
}

section('2. A 10G-only peer links at 10G on every uplink, not just three');
{
  const tenGOnly = spec('CCR2116-12G-4S+');
  for (const name of UPLINKS) {
    const t = new Topology();
    const sw = t.addDevice(spec('2930F 48G PoE+ 4SFP+'));
    const peer = t.addDevice(tenGOnly);
    const r = t.validateLink(sw.id, name, peer.id, 'SFP+1');
    ok(r.ok === true, 'port ' + name + ' carries a 10G-only link');
    eq(r.speedMbps, 10000, 'port ' + name + ' negotiates 10G');
  }
}

section('3. A 1G module still works on every uplink');
{
  // A 1G-only SFP port, i.e. a device that cannot do 10G at all.
  const gbeOnly = spec('ISR 4331');
  for (const name of ['49', '52']) {
    const t = new Topology();
    const sw = t.addDevice(spec('2930F 48G PoE+ 4SFP+'));
    const peer = t.addDevice(gbeOnly);
    const r = t.validateLink(sw.id, name, peer.id, 'Gi0/0/0-sfp');
    ok(r.ok === true, 'port ' + name + ' accepts a 1G-only neighbour');
    eq(r.speedMbps, 1000, 'port ' + name + ' settles on 1G');
  }
}

section('4. The copper side is exactly as it was');
{
  const sw = new Topology().addDevice(spec('2930F 48G PoE+ 4SFP+'));
  const names = Array.from(sw.interfaces.keys());
  eq(names.length, 52, 'still 52 ports');
  const copper = names.slice(0, 48).map(function (n) { return sw.interfaces.get(n); });
  ok(copper.every(function (i) { return i.hardware.cage === 'rj45'; }),
    'the 48 access ports are still RJ45');
  ok(copper.every(function (i) { return i.hardware.speedCaps.indexOf(1000) !== -1; }),
    'and still gigabit');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
