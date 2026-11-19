'use strict';
// The wAP ac LTE6 kit is MikroTik's weatherproof AP *and* a full RouterOS router - the vendor's own sentence
// is "you can use the device as a wired router with LTE backup via the Micro SIM slot" - and it was filed as
// an AP that could not bridge, could not lease, and could not be powered at the wattage it publishes.
//
// Three faults, all from rows the vendor does print:
//   * no `l2-forward`, so `switchport mode trunk` / LAG answers "cannot switch frames" on a board whose spec
//     table prints "Switch chip model IPQ-4018" and whose throughput table has a "Bridging, none (fast path)"
//     row beside the routing one;
//   * `nat` without `dhcp-server`/`dhcp-client` - the only one of 306 NAT-capable MikroTik entries so
//     configured - so `ip dhcp pool lan` was refused and a wAP standing in as a site gateway could not lease
//     an address to anything behind it;
//   * PoE-in declared 802.3af at 12.95 W while the vendor prints "PoE in 802.3af/at" and
//     "Max power consumption 16 W": the declared class ceiling sat 3 W below the box's own published draw.
//
// Every figure below is the vendor's, read 2026-11-19:
//   https://mikrotik.com/product/wap_ac_lte6_kit   (200, 388,174 B)
//   https://manual.mikrotik.com/hardware/wap-ac-kit-series/  (200)
// "RouterOS license 4"; "10/100/1000 Ethernet ports 2"; "Switch chip model IPQ-4018";
// "PoE in 802.3af/at"; "PoE in input Voltage 18-57 V"; "Max power consumption 16 W".
// The manual repeats: "Ethernet port accepts 802.3af/at PoE 18-57 V DC. The power consumption under
// maximum load can reach 16 W."
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
const WAP = catalog.find(function (s) { return s.vendor === 'mikrotik' && s.model === 'wAP ac LTE6 kit'; });
const SWITCH = catalog.find(function (s) { return s.model === 'USW-Lite-8-PoE'; });

console.log('The spec carries the router capabilities the vendor documents:');
ok(!!WAP, 'wAP ac LTE6 kit is in the catalogue');
ok(WAP && WAP.capabilities.indexOf('l2-forward') !== -1,
  'l2-forward - the vendor prints a switch chip and a bridging throughput row');
ok(WAP && WAP.capabilities.indexOf('dhcp-server') !== -1,
  'dhcp-server - the vendor calls it a wired router with LTE backup, on RouterOS licence 4');
ok(WAP && WAP.capabilities.indexOf('dhcp-client') !== -1, 'dhcp-client - RouterOS ships "both server and client parts"');
ok(WAP && WAP.capabilities.indexOf('802.3at') !== -1,
  '802.3at - the spec table reads "PoE in 802.3af/at"');
ok(WAP && WAP.capabilities.indexOf('802.3af') !== -1, 'and 802.3af is still declared');

console.log('\nPoE-in is the 16 W the vendor publishes, not an 802.3af class ceiling:');
{
  const eth1 = WAP && (WAP.interfaces || []).find(function (i) { return i.name === 'eth1'; });
  ok(eth1 && eth1.poeIn === 16, 'eth1 asks for 16 W (' + (eth1 && eth1.poeIn) + ')');
  ok(eth1 && eth1.poeIn > 12.95,
    'which is more than an 802.3af port may deliver, so af alone cannot describe this PD');
}

console.log('\nA wAP on a PoE+ switch is budgeted 16 W, not 12.95 W:');
{
  const t = new Topology();
  t.addDevice(SWITCH, 'sw1');
  t.addDevice(WAP, 'wap');
  t.connect('sw1', 'port1', 'wap', 'eth1', { mediaId: '1000base-t', speedMbps: 1000 });
  const entry = new Simulator(t).computePoe().find(function (e) { return e.dev === t.getDevice('sw1').id; });
  ok(!!entry, 'computePoe() has an entry for the switch');
  const p = entry && (entry.ports || []).find(function (x) { return x.iface === 'port1'; });
  ok(!!p && p.draw === 16, 'the port draws the published 16 W (' + (p && p.draw) + ')');
  ok(!!p && p.powered === true, 'and it is powered');
}

console.log('\nIt can serve the LAN it routes:');
{
  const t = new Topology();
  t.addDevice(WAP, 'd1');
  const sim = new Simulator(t);
  const cli = new CliSession(t.getDevice('d1'), t, sim);
  cli.run('enable');
  cli.run('configure terminal');
  const out = ((cli.run('ip dhcp pool lan') || {}).output || []).join('\n');
  ok(!/cannot serve DHCP/.test(out), '`ip dhcp pool lan` is accepted (' + (out || 'no output') + ')');
  ok(/Created DHCP pool lan/.test(out), 'and the pool exists');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
