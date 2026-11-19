'use strict';
// Which ports on the UniFi Lite 8 PoE actually supply power? Four, not eight.
//
// The model declares its 52 W budget, and `isPoePse()` promotes every copper port of a
// `switch` whose label mentions PoE - a rule written for the 24- and 48-port UniFi
// switches, where every access port is a PSE. On this model it made all eight RJ45
// ports PSE ports, so `show power inline` offered power on ports 5-8 and the panel drew
// a PoE badge on sockets that carry data only.
//
// Ubiquiti publishes the census twice over:
//   https://dl.ui.com/ds/usw-lite-8-poe.pdf
//     "Networking interface: (8) 10/100/1000 MbE RJ45 ports"
//     "PoE interface: (4) PoE/PoE+ (Pins 1, 2+; 3, 6-)"
//     "Max. PoE+ wattage per port by PSE: 30W" / "PoE budget: 52W"
//   https://techspecs.ui.com/unifi/switching/usw-lite-8-poe
//     Port Layout: "8 (4 PoE+) (1G/100M/10M)"; PoE Ports: "PoE+ 4";
//     Max. PoE Wattage per Port by PSE: "PoE+ 30W"; Total PoE Availability: "52W"
// The port numbers are from the installation guide's front-panel map, transcribed at
// https://manuals.plus/asin/B08MBRKG2Q - "PoE Interfaces: (4) 802.3af/at PoE Ports
// (Ports 1-4)", "For devices requiring Power over Ethernet (PoE), connect them to
// ports 1-4" - and from the second transcription at https://manuals.plus/asin/B08KC6KT1F.
//
// The same declaration already existed on this switch's 16-port sibling
// (ports 1-8 at 30 W, 9-16 at 0) and on the Gen1 US-8-60W (ports 1-4 at `true` with
// `poeOutClass: "PoE"`, 5-8 at 0). This model was the one that had never been split.
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
function spec(model) {
  return catalog.find(function (s) { return s.vendor === 'ubiquiti' && s.model === model; });
}
const SWITCH = spec('USW-Lite-8-PoE');
const AP = spec('U6-Lite');

console.log('The spec states the four-port census and the 52 W budget:');
ok(!!SWITCH, 'USW-Lite-8-PoE is in the catalogue');
ok(SWITCH && SWITCH.poe && SWITCH.poe.budgetW === 52, 'the budget is 52 W (' +
  (SWITCH && SWITCH.poe && SWITCH.poe.budgetW) + ')');
ok(SWITCH && /techspecs\.ui\.com\/unifi\/switching\/usw-lite-8-poe/.test(String(SWITCH.poe.sourceUrl)),
  'and it cites the vendor tech-spec page');
ok(SWITCH && SWITCH.capabilities.indexOf('poe-pse') !== -1, 'the device claims poe-pse');
ok(SWITCH && SWITCH.capabilities.indexOf('802.3at') !== -1, 'and 802.3at, which is what PoE+ is');
ok(SWITCH && /ports 1-4/.test(SWITCH.description) && /ports 5-8/.test(SWITCH.description),
  'the description names both halves of the panel');

console.log('\nPorts 1-4 are the PSE, ports 5-8 are not:');
{
  const dev = new Topology().addDevice(SWITCH, 'sw1');
  const ifaces = [...dev.interfaces.values()];
  ok(ifaces.length === 8, 'eight copper ports (' + ifaces.length + ')');
  const pse = ifaces.filter(function (i) { return i.poeOut; }).map(function (i) { return i.name; });
  ok(pse.join(',') === 'port1,port2,port3,port4',
    'exactly the first four source power (' + pse.join(',') + ')');
  const plain = ifaces.filter(function (i) { return i.name.match(/^port[5-8]$/); });
  ok(plain.length === 4 && plain.every(function (i) { return !i.poeOut; }),
    'ports 5-8 do not source power');
  ok(plain.every(function (i) { return i.poeOut === 0; }),
    'and each says so with an explicit 0, so inference cannot promote it again');
  const declared = (SWITCH.interfaces || []).filter(function (i) { return /^port[1-4]$/.test(i.name); });
  ok(declared.length === 4 && declared.every(function (i) { return i.poeOutClass === 'PoE+'; }),
    'the spec records PoE+ on each of the four');
}

console.log('\nFour 12.95 W access points fit, and a fifth socket cannot be asked:');
{
  const t = new Topology();
  t.addDevice(SWITCH, 'sw1');
  for (let n = 1; n <= 4; n++) t.addDevice(AP, 'ap' + n);
  t.addDevice(AP, 'ap5');
  for (let n = 1; n <= 5; n++) {
    t.connect('sw1', 'port' + n, 'ap' + (n === 5 ? 5 : n), 'port1', { mediaId: '1000base-t', speedMbps: 1000 });
  }
  const sim = new Simulator(t);
  const entry = sim.computePoe().filter(function (p) { return p.dev === t.getDevice('sw1').id; })[0];
  ok(!!entry, 'the switch has a PoE result');
  ok(entry && entry.budget === 52, 'counted against 52 W (' + (entry && entry.budget) + ')');
  ok(entry && entry.ports.length === 4,
    'the allocator sees four PSE ports, not five (' + (entry && entry.ports.length) + ')');
  ok(entry && entry.ports.every(function (p) { return p.powered; }),
    'all four access points are powered');
  ok(entry && Math.abs(entry.used - 51.8) < 1e-9,
    '4 x 12.95 W = 51.8 W of the 52 W budget (' + (entry && entry.used) + ')');

  const cli = new CliSession(t.getDevice('sw1'), t, sim);
  const table = (cli.run('show power inline').output || []).map(String).join('\n');
  ok(/port1\s+auto\s+on\s+12\.95 W/.test(table), 'the table powers port1');
  ok(!/^port5\b/m.test(table), 'and has no row for port5, which is not a PSE');
  const refused = (cli.run('show power inline port5').output || []).map(String).join('\n');
  ok(/port5 .*cannot supply power \(it is not a PSE port\)/.test(refused),
    'asking about port5 is refused in the map\'s own terms: ' + refused);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
