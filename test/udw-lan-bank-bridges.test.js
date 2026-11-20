'use strict';
// The Dream Wall's seventeen LAN sockets are one bridge (#130 fallback row).
//
// Ubiquiti states a MAC address table of 8,000 entries, LACP port aggregation and 802.1Q VLANs for the UDW
// (https://techspecs.ui.com/unifi/cloud-gateways/udw - "MAC Address Table Size = 8,000", "LACP Port
// Aggregation", "VLAN = 802.1Q"; the storefront payload for the same SKU repeats all three rows). A MAC table
// is a bridge table and a LAG is a switch feature, so the row cannot describe seventeen routed interfaces -
// and while it was missing `l2-forward` the console refused `switchport access vlan` and `channel-group`, and
// two hosts on adjacent LAN ports could not resolve each other's ARP ("not addressed to this device").
//
// What must not regress: the UDW stays a gateway. An address on a LAN port is answered bank-wide instead of
// only on the port that holds it, a LAN port can still be made routed with `no switchport`, the WAN port still
// takes an address, and the port/PoE census is the one the datasheet prints.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
function spec(model) { return catalog.filter(function (s) { return s.model === model; })[0]; }
function PC() { return spec('generic-pc'); }

console.log('');
console.log('The Dream Wall switches its LAN bank:');
{
  const udwSpec = spec('UDW');
  ok(!!udwSpec, 'the UDW is in the catalogue');
  const caps = udwSpec.capabilities || [];
  ok(caps.indexOf('l2-forward') !== -1, 'it declares l2-forward', caps.join(','));
  ok(caps.indexOf('l3-forward') !== -1 && caps.indexOf('nat') !== -1,
    'and stays a gateway: l3-forward and nat are still declared', caps.join(','));

  const copper = udwSpec.interfaces.filter(function (i) { return i.type === 'ethernet' && i.speed === '1G'; });
  ok(copper.length === 17, 'seventeen 1G copper ports, as the datasheet prints', String(copper.length));
  ok(udwSpec.interfaces.filter(function (i) { return i.speed === '2.5G'; }).length === 1, 'one 2.5G WAN port');
  ok(udwSpec.interfaces.filter(function (i) { return i.connector === 'sfp+'; }).length === 2,
    'two 10G SFP+ cages');
  ok(udwSpec.interfaces.filter(function (i) { return i.poeOut; }).length === 12,
    'twelve of the copper ports source PoE (4 PoE++ / 4 PoE+ / 4 PoE)');

  const t = new Topology();
  const udw = t.addDevice(udwSpec, 'udw');
  const pc1 = t.addDevice(PC(), 'pc1');
  const pc2 = t.addDevice(PC(), 'pc2');
  t.connect(pc1.id, 'eth0', udw.id, 'eth0');
  t.connect(pc2.id, 'eth0', udw.id, 'eth1');
  const sim = new Simulator(t);

  runCommands(pc1, t, sim, ['configure terminal', 'interface eth0', 'ip address 192.168.1.10 255.255.255.0']);
  runCommands(pc2, t, sim, ['configure terminal', 'interface eth0', 'ip address 192.168.1.11 255.255.255.0']);

  const cli = new CliSession(udw, t, sim);
  const say = function (c) { return (cli.run(c).output || []).map(String); };
  cli.run('enable');
  cli.run('configure terminal');
  say('interface eth0');
  say('ip address 192.168.1.1 255.255.255.0');
  say('end');

  ok(sim.ping(pc1.id, '192.168.1.11', { count: 2 }).success,
    'two hosts on eth0 and eth1 reach each other through the LAN bank');
  ok(sim.ping(pc2.id, '192.168.1.1', { count: 2 }).success,
    'and the bank address is answered from a port other than the one that holds it');

  cli.run('configure terminal');
  say('vlan 10');
  say('interface eth0');
  const access = say('switchport access vlan 10');
  ok(!access.some(function (l) { return /^\s*%/.test(l); }),
    'switchport access vlan is accepted on a LAN port', JSON.stringify(access));

  const lag = say('channel-group 1 mode active');
  ok(!lag.some(function (l) { return /^\s*%/.test(l); }),
    'channel-group is accepted: the vendor states LACP aggregation', JSON.stringify(lag));

  say('no switchport');
  const addr = say('ip address 192.0.2.1 255.255.255.0');
  ok(!addr.some(function (l) { return /^\s*%/.test(l); }),
    'a LAN port can still be made a routed port and take an address', JSON.stringify(addr));

  say('interface wan1');
  const wan = say('ip address 203.0.113.2 255.255.255.0');
  ok(!wan.some(function (l) { return /^\s*%/.test(l); }),
    'the WAN port still takes an address', JSON.stringify(wan));
  ok(udw.interfaces.get('wan1').role === 'wan', 'and keeps its WAN role');
  cli.run('end');
}

console.log('');
if (failed) { console.error(passed + ' passed, ' + failed + ' failed'); process.exit(1); }
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(0);
