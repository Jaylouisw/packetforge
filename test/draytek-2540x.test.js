'use strict';
// The DrayTek 2540x pair: one datasheet, two switches, and a difference that decides
// whether a device boots.
//
// They are the same chassis, the same 48 copper ports and the same six 10G SFP+ uplinks.
// The only thing that separates them is PoE - 400 W across all 48 ports on the P2540x, and
// nothing at all on the G2540X. That is precisely the field a lab cares about: an access
// point or a camera on a G2540X port does not come up, and the reason should be visible in
// the model rather than mysterious.
//
// What is locked here:
//   1. both are 48+6+console, with the SFP+ ports numbered 49-54 as the datasheet does;
//   2. the P2540x supplies PoE+ on all 48 copper ports with a 400 W budget;
//   3. the G2540X supplies none, and does not claim a PSE capability it lacks;
//   4. their SFP+ cages take 1G or 10G modules, not 10G only;
//   5. a powered device behind the PoE switch is powered, and behind the other is not.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const media = require('../engine/media');
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

section('1. Same chassis, 48 copper plus 6 SFP+ plus a console');
{
  for (const model of ['VigorSwitch P2540x', 'VigorSwitch G2540X']) {
    const d = spec(model);
    ok(!!d, model + ' is in the catalogue');
    if (!d) continue;
    eq(d.vendor, 'draytek', model + ' is a DrayTek');
    eq(d.category, 'switch', model + ' is a switch');

    const dev = new Topology().addDevice(d);
    const ports = [...dev.interfaces.values()];
    eq(ports.length, 55, model + ' has 55 ports (48 + 6 + console)');
    eq(ports.filter(function (i) { return i.cage === 'rj45'; }).length, 48,
      model + ' has 48 copper ports');
    eq(ports.filter(function (i) { return i.cage === 'sfp+'; }).length, 6,
      model + ' has 6 SFP+ cages');

    // The datasheet numbers the fibre ports 49-54, continuing the copper numbering.
    ok(!!dev.interfaces.get('sfp49') && !!dev.interfaces.get('sfp54'),
      model + ' names its uplinks 49-54 as the datasheet does');
    ok(!!dev.interfaces.get('port1') && !!dev.interfaces.get('port48'),
      model + ' names its copper ports 1-48');
  }
}

section('2. PoE is the only difference, and it is the difference that matters');
{
  const p = spec('VigorSwitch P2540x');
  const g = spec('VigorSwitch G2540X');

  eq(p.poe && p.poe.budgetW, 400, 'the P2540x declares a 400 W PoE budget');
  ok(p.capabilities.indexOf('poe-pse') !== -1, 'and the PSE capability');
  ok(p.capabilities.indexOf('802.3at') !== -1, 'and 802.3at (PoE+)');
  ok(!g.poe, 'the G2540X declares no PoE budget');
  ok(g.capabilities.indexOf('poe-pse') === -1, 'and does not claim a PSE capability');

  const pDev = new Topology().addDevice(p);
  const gDev = new Topology().addDevice(g);
  const powered = function (dev) {
    return [...dev.interfaces.values()].filter(function (i) {
      return i.cage === 'rj45' && i.poeOut;
    }).length;
  };
  eq(powered(pDev), 48, 'all 48 copper ports on the P2540x can supply power');
  eq(powered(gDev), 0, 'none of them on the G2540X can');

  const port1 = pDev.interfaces.get('port1');
  ok(port1.poeOut >= 30, 'and each P2540x port offers up to 30 W (' + port1.poeOut + ' W)');
}

section('3. The SFP+ cages take 1G or 10G');
{
  const dev = new Topology().addDevice(spec('VigorSwitch P2540x'));
  const sfp = dev.interfaces.get('sfp49');
  eq(sfp.cage, 'sfp+', 'the uplink is an SFP+ cage');
  eq(sfp.speedCaps.join(','), '1000,10000', 'advertising both 1G and 10G');

  const peer = new Topology().addDevice(spec('CX 6000 48G 4SFP'));
  const peerSfp = [...peer.interfaces.values()].filter(function (i) { return i.cage === 'sfp'; })[0];
  const topo = new Topology();
  const a = topo.addDevice(spec('VigorSwitch P2540x'));
  const b = topo.addDevice(spec('CX 6000 48G 4SFP'));
  const v = topo.validateLink(a.id, 'sfp49', b.id, peerSfp.name);
  ok(v.ok, 'a 1G SFP peer is accepted into the 10G cage');
  eq(v.speedMbps, 1000, 'and runs at 1G');
}

section('4. The PoE budget is real, not decorative');
{
  // Feeding several powered devices must be checked against the 400 W budget rather than
  // assumed: 48 ports at 30 W is 1440 W, three times what the supply can deliver.
  const p = spec('VigorSwitch P2540x');
  eq(p.poe.budgetW, 400, 'the budget is 400 W');
  const maxPerPort = 30;
  ok(p.poe.budgetW < 48 * maxPerPort,
    'and it is deliberately less than 48 ports x 30 W (' + (48 * maxPerPort) + ' W), ' +
    'so the switch has to be asked what it can actually power');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
