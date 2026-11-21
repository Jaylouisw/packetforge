'use strict';
// NETGEAR JGS516PE: PoE on ports 1-8 only, 802.3af, 85 W shared.
//
// The model declared sixteen PSE ports (the engine fills an undeclared port on a `poe-pse`
// switch with 802.3af, so ge9-ge16 sourced power nobody's hardware does), called every one
// of them `poeOutClass: "PoE+"` (802.3at, 30 W), and carried no `poe` block - so
// `show power inline` answered "budget not modelled" and the allocator counted no watt.
//
// NETGEAR's own two documents settle all three facts:
//   * JGS516PE/JGS524PE installation guide, Specifications
//     https://www.downloads.netgear.com/files/GDC/JGS516PE/JGS516PE_JGS524PE_IG_EN.pdf
//       Ports:        "JGS516PE: 16, of which ports 1-8 are PoE ports"
//       Power budget: "JGS516PE: 15.4W per port for ports 1-8
//                      Maximum power budget for the switch: 85W"
//       Power consumption: "JGS516PE: 110W maximum with PoE"
//   * Gigabit Ethernet Plus Switches data sheet, "Hardware at a Glance"
//     https://www.netgear.com/images/datasheet/switches/gigabit_ethernet_plus_switches_ds.pdf
//       JGS516PE | Rack mount | 16 | "PoE 802.3af Ports" 8 | Internal | 85W
// The 123 W that some listings quote as a budget is not one: the same data sheet prints
// "123W maximum with PoE" for the *24-port JGS524PE*, one row below this model's 110 W
// power consumption. The budget is 85 W, and 8 x 15.4 W = 123.2 W of port ceiling means
// the budget - not the port class - is what refuses a load.
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
const SWITCH = catalog.find(function (s) { return s.vendor === 'netgear' && s.model === 'JGS516PE'; });
const AP = catalog.find(function (s) { return s.vendor === 'ubiquiti' && s.model === 'U6-Lite'; });

console.log('The vendor documents state the budget, the standard and the powered subset:');
ok(!!SWITCH, 'JGS516PE is in the catalogue');
ok(SWITCH && SWITCH.poe && SWITCH.poe.budgetW === 85,
  'the budget is 85 W (' + (SWITCH && SWITCH.poe && SWITCH.poe.budgetW) + ')');
ok(SWITCH && /JGS516PE_JGS524PE_IG_EN\.pdf$/.test(String(SWITCH.poe.sourceUrl)),
  'and it cites NETGEAR\'s own installation guide');
ok(SWITCH && SWITCH.capabilities.indexOf('802.3af') !== -1, 'the device claims 802.3af');
ok(SWITCH && SWITCH.capabilities.indexOf('802.3at') === -1,
  'and does not claim 802.3at: the data sheet\'s column is "PoE 802.3af Ports"');
ok(SWITCH && /802\.3af/.test(SWITCH.description), 'the description names 802.3af: ' + (SWITCH && SWITCH.description));

console.log('\n8 ports source 802.3af; the other 8 carry no power:');
{
  const dev = new Topology().addDevice(SWITCH, 'sw1');
  const ifaces = [...dev.interfaces.values()];
  const pse = ifaces.filter(function (i) { return i.poeOut; });
  ok(pse.length === 8, 'exactly 8 ports source power (' + pse.length + ')');
  ok(pse.map(function (i) { return i.name; }).join(',') === 'ge1,ge2,ge3,ge4,ge5,ge6,ge7,ge8',
    'and they are the first eight: ' + pse.map(function (i) { return i.name; }).join(','));
  // `poeOutClass` is a declaration, not derived hardware: DEVICE_SCHEMA.md says the string is
  // kept verbatim and dropped by derivePortHardware(), so it is read off the spec's own ports.
  const declared = (SWITCH.interfaces || []).filter(function (i) { return i.poeOut; });
  ok(declared.length === 8 && declared.every(function (i) { return i.poeOutClass === 'PoE'; }),
    'every one is declared class PoE (802.3af)');
  ok(declared.every(function (i) { return i.poeOutClass !== 'PoE+'; }),
    'and none is declared PoE+ (802.3at)');
  ok(ifaces.filter(function (i) { return /^ge(9|1[0-6])$/.test(i.name); })
    .every(function (i) { return !i.poeOut; }), 'ge9-ge16 are not PSE ports');
  ok(dev.poeBudget === 85, 'the device carries 85 W (' + dev.poeBudget + ')');
  ok(dev.poeBudgetSource === 'research', 'sourced from research, not guessed from the model name');
}

console.log('\n85 W funds six 12.95 W access points, and refuses the seventh and eighth:');
{
  const t = new Topology();
  t.addDevice(SWITCH, 'sw1');
  for (let n = 1; n <= 8; n++) t.addDevice(AP, 'ap' + n);
  for (let n = 1; n <= 8; n++) {
    t.connect('sw1', 'ge' + n, 'ap' + n, 'port1', { mediaId: '1000base-t', speedMbps: 1000 });
  }
  const sim = new Simulator(t);
  const entry = sim.computePoe().filter(function (p) { return p.dev === t.getDevice('sw1').id; })[0];
  ok(!!entry, 'the switch has a PoE result');
  ok(entry && entry.budget === 85, 'counted against 85 W (' + (entry && entry.budget) + ')');
  ok(entry && entry.ports.length === 8, 'the allocator sees eight PSE ports (' + (entry && entry.ports.length) + ')');
  ok(entry && entry.ports.filter(function (p) { return p.powered; }).length === 6,
    'six are powered (' + (entry && entry.ports.filter(function (p) { return p.powered; }).length) + ')');
  ok(entry && Math.abs(entry.used - 77.7) < 1e-9,
    '6 x 12.95 W = 77.7 W of the 85 W budget (' + (entry && entry.used) + ')');
  const denied = entry && entry.ports.filter(function (p) { return !p.powered; }).map(function (p) { return p.iface; });
  ok(denied && denied.join(',') === 'ge7,ge8', 'ge7 and ge8 are the ports refused (' + denied + ')');
  const reason = entry && entry.ports.filter(function (p) { return !p.powered; })[0].reason;
  ok(/PSE budget exhausted: 12\.95 W requested, 7\.3 W left/.test(reason || ''),
    'and they say why: ' + reason);

  const cli = new CliSession(t.getDevice('sw1'), t, sim);
  const table = (cli.run('show power inline').output || []).map(String).join('\n');
  ok(/^Available:85\.0\(w\) Used:77\.7\(w\) Remaining:7\.3\(w\)$/m.test(table),
    'the summary line adds up: ' + table.split('\n')[0]);
  ok(/^ge1\s+auto\s+on\s+13\.0\s/m.test(table), 'ge1 is on, drawing 13.0 W');
  ok(/^ge7\s+auto\s+power-deny\s+0\.0\s/m.test(table),
    'ge7 is power-deny with 0.0 allocated, not "off"');
  ok(/  ge7: PSE budget exhausted: 12\.95 W requested, 7\.3 W left/.test(table),
    'and the denial sentence is repeated under the table');
  ok(!/budget not modelled/.test(table), 'the table no longer says the budget is unmodelled');
}

console.log('\nAn eighth socket is not a PSE, and a missing one is refused by name:');
{
  const t = new Topology();
  t.addDevice(SWITCH, 'sw1');
  const sim = new Simulator(t);
  sim.computePoe();
  const cli = new CliSession(t.getDevice('sw1'), t, sim);
  const nine = (cli.run('show power inline ge9').output || []).map(String).join('\n');
  ok(/ge9 .*cannot supply power \(it is not a PSE port\)/.test(nine),
    'ge9 cannot supply power: ' + nine);
  const missing = (cli.run('show power inline ge17').output || []).map(String).join('\n');
  ok(/No interface ge17/.test(missing), 'a port the model does not carry is refused by name: ' + missing);
  // With no cable the eight PSE ports are still printed, as idle rows.
  const whole = (cli.run('show power inline').output || []).map(String).join('\n');
  ok(/8 ports with nothing plugged in: ge1, ge2, ge3, ge4, ge5 \(\+3 more\)/.test(whole),
    'the eight powered ports are named once, not as eight rows: ' + whole.split('\n').slice(-1)[0]);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
