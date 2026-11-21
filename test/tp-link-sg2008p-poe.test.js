'use strict';
// TP-Link Omada SG2008P: a PoE switch that the catalogue modelled as if it had no power supply.
//
// The spec said, in prose, "8-port Gigabit smart switch with 4 PoE+ ports and 62 W power budget" - and
// then declared no `poeOut` on any port, no `poe-pse` capability and no `poe` block. `show power inline`
// answered "% No PoE on ...: no port on this device can supply power" for the one thing the SKU is sold
// to do, and `scripts/audit-poe-budget.js` could not even see the gap: it counts devices that source
// power on at least one port, and this one sourced on none.
//
// Omada's product page for the SKU (https://www.omadanetworks.com/us/business-networking/
// omada-switch-access/sg2008p/, HTTP 200, 187,036 B, read 2026-11-21), specification table:
//
//   "Interface  - 8x 10/100/1000 Mbps RJ45 Ports (Ports 1-4 Support 802.3at/af PoE+)"
//   "PoE Ports (RJ45) - Standard: 802.3af/at compliant / PoE Ports: 4 Ports / Power Supply: 62 W*"
//   "Power Supply - AC/DC Adapter (Input: 100-240V AC; Output: 53.5V DC/1.31A)"
//   "Max. Power Consumption - 73.4 W (220 V/50 Hz @ 25 C) (with 62 W PD connected)"
//
// The 62 W is the PD-side allowance, not the adapter's rating: 53.5 V x 1.31 A is 70.1 W, and the
// max-consumption row is 62 W of PD load plus ~11 W of chassis. Four 802.3af loads (61.6 W) fit;
// four Class-4 25.5 W loads (102 W) do not, which is the arithmetic a lab runs into.
//
// Ports 5-8 are declared `poeOut: false` on purpose. `engine/media.js` fills a silent `poeOut` on every
// RJ45 port of a `switch` that claims `poe-pse`, so leaving them silent would have invented four more
// PSE ports - the same defect the GS305EPP half-fixed by declaring its uplink. The end-of-sale
// TL-SG2008P carries the identical 62 W budget and is checked here beside its successor.
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
const SWITCH = catalog.find(function (s) { return s.vendor === 'tp-link' && s.model === 'SG2008P'; });
const EOL = catalog.find(function (s) { return s.vendor === 'tp-link' && s.model === 'TL-SG2008P'; });
// 25.5 W is the Class-4 draw the budget arithmetic below uses; the AP is only a load.
const AP = catalog.find(function (s) { return s.vendor === 'aruba' && s.model === 'AP-515'; });

console.log('The vendor table states the budget, the class and which ports are PoE+');
ok(!!SWITCH, 'SG2008P is in the catalogue');
ok(SWITCH && SWITCH.poe && SWITCH.poe.budgetW === 62,
  'the budget is 62 W (' + (SWITCH && SWITCH.poe && SWITCH.poe.budgetW) + ')');
ok(SWITCH && SWITCH.poe && SWITCH.poe.standard === '802.3at', 'and the standard is 802.3at, the vendor\'s row');
ok(SWITCH && /omadanetworks\.com\/us\/business-networking\/omada-switch-access\/sg2008p\/$/.test(String(SWITCH.poe.sourceUrl)),
  'sourced to the vendor product page');
ok(SWITCH && /Power Supply: 62 W/.test(String(SWITCH.poe.note)), 'the note quotes the vendor row');
ok(SWITCH && /with 62 W PD connected/.test(String(SWITCH.poe.note)),
  'and the max-consumption row that makes 62 W a PoE budget rather than a PSU rating');
ok(SWITCH && ['poe-pse', '802.3af', '802.3at'].every(function (c) { return SWITCH.capabilities.indexOf(c) !== -1; }),
  'the device claims poe-pse, 802.3af and 802.3at');
ok(SWITCH && /62 W/.test(String(SWITCH.description)), 'the prose and the field agree on 62 W');

console.log('\nFour ports source power and four do not:');
{
  const dev = new Topology().addDevice(SWITCH, 'sw1');
  const ifaces = [...dev.interfaces.values()];
  ok(ifaces.length === 8, 'the box has eight RJ45 ports (' + ifaces.length + ')');
  const pse = ifaces.filter(function (i) { return i.poeOut; });
  ok(pse.length === 4, 'exactly four source power (' + pse.length + ')');
  ok(pse.map(function (i) { return i.name; }).join(',') === 'port1,port2,port3,port4',
    'and they are port1-port4 (' + pse.map(function (i) { return i.name; }).join(',') + ')');
  const rest = ifaces.filter(function (i) { return ['port5', 'port6', 'port7', 'port8'].indexOf(i.name) !== -1; });
  ok(rest.every(function (i) { return i.poeOut === false; }), 'ports 5-8 source nothing');
  ok(rest.every(function (i) { return i.hardware.poeOutDeclared === true; }),
    'and that is a declaration, not a silence the engine filled');
  const declared = (SWITCH.interfaces || []).filter(function (i) { return i.poeOut === true; });
  ok(declared.length === 4 && declared.every(function (i) { return i.poeOutClass === 'PoE+'; }),
    'all four are declared class PoE+ (802.3at)');
  ok(dev.poeBudget === 62, 'the device carries 62 W (' + dev.poeBudget + ')');
  ok(dev.poeBudgetSource === 'research', 'sourced from the vendor page, not guessed from the model name (' +
    dev.poeBudgetSource + ')');
}

console.log('\n62 W funds two Class-4 access points and refuses the third:');
{
  const t = new Topology();
  const sw = t.addDevice(SWITCH, 'sw1');
  for (let n = 1; n <= 3; n++) t.addDevice(AP, 'ap' + n);
  for (let n = 1; n <= 3; n++) t.connect('sw1', 'port' + n, 'ap' + n, 'eth0', { mediaId: '1000base-t', speedMbps: 1000 });
  const sim = new Simulator(t);
  const entry = sim.computePoe().filter(function (p) { return p.dev === sw.id; })[0];
  ok(!!entry, 'the switch has a PoE result at all - it had none before');
  ok(entry && entry.budget === 62, 'counted against 62 W (' + (entry && entry.budget) + ')');
  const powered = (entry ? entry.ports : []).filter(function (p) { return p.powered; });
  const denied = (entry ? entry.ports : []).filter(function (p) { return !p.powered; });
  ok(powered.length === 2, 'two ports are powered (' + powered.length + ')');
  ok(denied.length === 1 && denied[0].iface === 'port3', 'the third is denied, not averaged');
  ok(denied[0] && denied[0].reason === 'PSE budget exhausted: 25.5 W requested, 11 W left',
    'with the arithmetic in the box\'s own sentence: ' + (denied[0] && denied[0].reason));
  ok(entry && Math.abs(entry.used - 51) < 1e-9, '51 W in use, 2 x 25.5 W (' + (entry && entry.used) + ')');
  ok(t.getDevice('ap3').poeUnpowered === true, 'the refused access point is marked unpowered');

  const cli = new CliSession(sw, t, sim);
  const table = (cli.run('show power inline').output || []).map(String).join('\n');
  ok(/^Available:62\.0\(w\) Used:51\.0\(w\) Remaining:11\.0\(w\)$/m.test(table),
    '`show power inline` prints the 62 W summary: ' + table.split('\n')[0]);
  ok(/^port1\s+auto\s+on\s+25\.5\s/m.test(table), 'port1 is on, drawing 25.5 W');
  ok(!/^port5\s/m.test(table), 'port5 does not appear as a PoE port');
  const one = (cli.run('show power inline port5').output || []).map(String).join('\n');
  ok(/port5 .*cannot supply power \(it is not a PSE port\)/.test(one),
    'asking about port5 says it is not a PSE port: ' + one);
}

console.log('\nThe end-of-sale TL-SG2008P carries the same 62 W, not the same silence:');
{
  const dev = new Topology().addDevice(EOL, 'eol1');
  ok(EOL && EOL.poe && EOL.poe.budgetW === 62, 'the sibling\'s budget is 62 W (' +
    (EOL && EOL.poe && EOL.poe.budgetW) + ')');
  ok(dev.poeBudget === 62 && dev.poeBudgetSource === 'research',
    'and the engine reads it as research, not as a name guess (' + dev.poeBudgetSource + ')');
  ok([...dev.interfaces.values()].filter(function (i) { return i.poeOut; }).length === 4,
    'its four PoE+ ports still source power');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
