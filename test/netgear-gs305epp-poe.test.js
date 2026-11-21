'use strict';
// NETGEAR GS305EPP: 120 W over four PoE+ ports, and the fifth socket is the unpowered uplink.
//
// The spec declared four `poeOut` ports but left the fifth silent, and carried no `poe` block.
// `engine/media.js` fills a silent `poeOut` on every RJ45 port of a `switch` that claims
// `poe-pse`, so `ge5` - the vendor's "Ethernet (uplink) port" - was derived as a 15.4 W PSE.
// With no budget, `computePoe()` skipped the box entirely. Both facts are in NETGEAR's manual:
//   https://www.downloads.netgear.com/files/GDC/GS305EP/GS305EP-EPP_GS308EP-EPP_UM_EN.pdf
//     "The switches provide 5 Gigabit Ethernet copper ports with 4 ports supporting up to 30W
//      PoE+ (802.3at) per port"  /  "Model GS305EPP: The maximum PoE power budget of the switch
//      across all active ports is 120W."  /  "ports 1 through 4 are PoE+ ports. Port 5 is an
//      Ethernet (uplink) port."
// The data sheet's PoE table agrees: 4 PoE ports, 4 PoE+ 802.3at ports, 120W for the GS305EPP
// (63W is the GS305EP). research/netgear-gs305epp-poe-budget.md records the column order.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.find(function (s) { return s.vendor === 'netgear' && s.model === 'GS305EPP'; });
// 25.5 W is the class-4 draw the budget arithmetic below uses; the AP is only a load.
const AP = catalog.find(function (s) { return s.vendor === 'aruba' && s.model === 'AP-515'; });

console.log('The manual states the budget, the class and the uplink:');
ok(!!SWITCH, 'GS305EPP is in the catalogue');
ok(SWITCH && SWITCH.poe && SWITCH.poe.budgetW === 120,
  'the budget is 120 W (' + (SWITCH && SWITCH.poe && SWITCH.poe.budgetW) + ')');
ok(SWITCH && /GS305EP-EPP_GS308EP-EPP_UM_EN\.pdf$/.test(String(SWITCH.poe.sourceUrl)),
  'and it cites NETGEAR\'s own user manual');
ok(SWITCH && /120W/.test(String(SWITCH.poe.note)), 'the note quotes the 120W sentence');
ok(SWITCH && /Port 5 is an Ethernet \(uplink\) port/.test(String(SWITCH.poe.note)),
  'and the sentence that says port 5 is the uplink');
ok(SWITCH && SWITCH.capabilities.indexOf('802.3at') !== -1, 'the device claims 802.3at');

console.log('\nFour ports source PoE+; the uplink sources nothing:');
{
  const dev = new Topology().addDevice(SWITCH, 'sw1');
  const ifaces = [...dev.interfaces.values()];
  ok(ifaces.length === 5, 'the box has five RJ45 ports (' + ifaces.length + ')');
  const pse = ifaces.filter(function (i) { return i.poeOut; });
  ok(pse.length === 4, 'exactly four source power (' + pse.length + ')');
  ok(pse.map(function (i) { return i.name; }).join(',') === 'ge1,ge2,ge3,ge4',
    'and they are ge1-ge4 (' + pse.map(function (i) { return i.name; }).join(',') + ')');
  const ge5 = ifaces.find(function (i) { return i.name === 'ge5'; });
  ok(ge5 && ge5.poeOut === false, 'ge5 is declared not to source power (' + (ge5 && ge5.poeOut) + ')');
  ok(ge5 && ge5.hardware.poeOutDeclared === true,
    'and that is a declaration, not a silence the engine filled');
  const declared = (SWITCH.interfaces || []).filter(function (i) { return i.poeOut; });
  ok(declared.length === 4 && declared.every(function (i) { return i.poeOutClass === 'PoE+'; }),
    'all four are declared class PoE+ (802.3at)');
  ok(dev.poeBudget === 120, 'the device carries 120 W (' + dev.poeBudget + ')');
  ok(dev.poeBudgetSource === 'research', 'sourced from the manual, not guessed from the model name');
}

console.log('\n120 W funds four 25.5 W access points, and the uplink funds nothing:');
{
  const t = new Topology();
  t.addDevice(SWITCH, 'sw1');
  for (let n = 1; n <= 5; n++) t.addDevice(AP, 'ap' + n);
  for (let n = 1; n <= 5; n++) {
    t.connect('sw1', 'ge' + n, 'ap' + n, 'eth0', { mediaId: '1000base-t', speedMbps: 1000 });
  }
  const sim = new Simulator(t);
  const entry = sim.computePoe().filter(function (p) { return p.dev === t.getDevice('sw1').id; })[0];
  ok(!!entry, 'the switch has a PoE result');
  ok(entry && entry.budget === 120, 'counted against 120 W (' + (entry && entry.budget) + ')');
  ok(entry && entry.ports.length === 4, 'the allocator sees four PSE ports (' + (entry && entry.ports.length) + ')');
  ok(entry && entry.ports.every(function (p) { return p.powered; }), 'all four are powered');
  ok(entry && Math.abs(entry.used - 102) < 1e-9, '4 x 25.5 W = 102 W (' + (entry && entry.used) + ')');
  ok(entry && entry.ports.every(function (p) { return p.iface !== 'ge5'; }),
    'no allocation is made on ge5, even with a powered device cabled to it');

  const cli = new CliSession(t.getDevice('sw1'), t, sim);
  const table = (cli.run('show power inline').output || []).map(String).join('\n');
  ok(/^Available:120\.0\(w\) Used:102\.0\(w\) Remaining:18\.0\(w\)$/m.test(table),
    'the summary line adds up: ' + (table.split('\n')[0]));
  ok(/^ge1\s+auto\s+on\s+25\.5\s/m.test(table), 'ge1 is on, drawing 25.5 W');
  ok(/^ge4\s+auto\s+on\s+25\.5\s/m.test(table), 'ge4 is on, drawing 25.5 W');
  ok(!/^ge5\s/m.test(table), 'ge5 does not appear as a PoE port');
  const one = (cli.run('show power inline ge5').output || []).map(String).join('\n');
  ok(/ge5 .*cannot supply power \(it is not a PSE port\)/.test(one),
    'asking about ge5 says it is not a PSE port: ' + one);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
