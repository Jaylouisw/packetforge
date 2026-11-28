'use strict';
// The U7 access points described their draw in prose and carried none on the port.
//
// Thirteen `devices/ubiquiti/u7-*.json` specs said in their own description "13 W max", "25 W max",
// "29 W max" - and not one of their eth0 interfaces carried a `poeIn`. engine/media.js reads a
// silent port as "no declared draw" and, for a wireless device, fills in 12.95 W (the 802.3af
// class default): a 29 W 802.3bt AP and a 13 W 802.3af AP billed the same number on a PoE
// switch's budget, and `show power inline` was wrong for both.
//
// U7-Pro and U7-Pro-Outdoor had the opposite fault - a hand-typed 25.5 and 12.95, the at and af
// PD class ceilings, not the boxes' own figures (21 W each per Ubiquiti).
//
// Every number below is the vendor's "Max. Power Consumption" row, read 2026-11-28 from the
// techspecs page each spec already cites (all HTTP 200; sizes are on the specs' notes):
//   https://techspecs.ui.com/unifi/wifi/<slug>
// "Power Method" decides the class: PoE = 802.3af, PoE+ = 802.3at, PoE++ = 802.3bt.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
function spec(model) { return catalog.filter(function (s) { return s.model === model; })[0]; }

// model -> [watts, class capability]
const PUBLISHED = {
  'U7-Lite': [13, '802.3af'],
  'U7-Mesh': [13, '802.3af'],
  'U7-LR': [14, '802.3af'],
  'U7-Industrial': [13, '802.3af'],
  'U7-IW': [13, '802.3af'],
  'U7-Outdoor': [19, '802.3at'],
  'U7-Pro': [21, '802.3at'],
  'U7-Pro-Outdoor': [21, '802.3at'],
  'U7-Pro-Max': [25, '802.3at'],
  'U7-Pro-Wall': [22, '802.3at'],
  'U7-Pro-XG': [22, '802.3at'],
  'U7-Pro-XG-Wall': [22, '802.3at'],
  'U7-Pro-XGS': [29, '802.3bt'],
};

console.log('\nEvery U7 model carries the vendor\'s own draw on eth0, not a class default');
for (const model of Object.keys(PUBLISHED)) {
  const [watts, cls] = PUBLISHED[model];
  const s = spec(model);
  ok(!!s, model + ' is in the catalogue');
  if (!s) continue;
  const eth0 = s.interfaces.filter(function (i) { return i.name === 'eth0'; })[0];
  ok(!!eth0, model + ' has an eth0');
  if (!eth0) continue;
  ok(eth0.poeIn === watts, model + ' draws its published ' + watts + ' W (' + eth0.poeIn + ')');
  ok(s.capabilities.indexOf('poe-pd') !== -1, model + ' declares poe-pd');
  ok(s.capabilities.indexOf(cls) !== -1, model + ' declares ' + cls);
}

console.log('\nTwo U7 Pro Max on a 420 W Dream Wall spend 50 W, because 25 W is the published draw');
{
  const udw = spec('UDW');
  const ap = spec('U7-Pro-Max');
  if (udw && ap) {
    const t = new Topology();
    t.addDevice(udw, 'udw');
    t.addDevice(ap, 'ap1');
    t.addDevice(ap, 'ap2');
    ok(!!t.connect('ap1', 'eth0', 'udw', 'eth0'), 'ap1 cables to the 60 W socket');
    ok(!!t.connect('ap2', 'eth0', 'udw', 'eth4'), 'ap2 cables to the 30 W socket');
    const sim = new Simulator(t);
    sim.computePoe();
    const row = sim.poe.filter(function (r) { return r.dev === 'udw'; })[0];
    ok(!!row && row.used === 50, 'show power inline spends 2 x 25 W = 50 W (' + (row && row.used) + ')');
    ok(!!row && row.ports.length === 2 && row.ports.every(function (p) { return p.powered; }),
      'and both are powered, 370 W of the 420 W still free');
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
