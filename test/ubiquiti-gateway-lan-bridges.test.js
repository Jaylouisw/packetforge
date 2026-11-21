'use strict';
// The LAN banks of the three UniFi gateways that publish a MAC address table (#130 fallback rows).
//
// Ubiquiti prints a bridge FDB for each of these SKUs on its own tech-spec page - UDM-Pro-Max "MAC Address
// Table Size = 4,000" plus "LACP Port Aggregation" over "GbE RJ45 ports 1-8", UCG-Max and UXG-Max "2,000"
// (https://techspecs.ui.com/unifi/cloud-gateways/<sku>, read 2026-11-20). A MAC table is the bridge's
// forwarding database; a gateway that only routed would hold neither it nor a LAG. While the rows shipped
// without `l2-forward`, the LAN sockets were routed interfaces: `switchport access vlan` was answered with
// "cannot switch frames", `channel-group` was refused, and two hosts on adjacent LAN ports in one subnet could
// not resolve each other's ARP ("not addressed to this device").
//
// What must not regress: each box stays a gateway. A LAN port can still be made routed with `no switchport`,
// the WAN port still takes an address, and the port census is the one the vendor prints.
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

const ROWS = [
  { model: 'UDM-Pro-Max', lan: ['Port 1', 'Port 2'], wan: 'WAN', copper: 9, lag: true,
    table: '4,000', url: 'https://techspecs.ui.com/unifi/cloud-gateways/udm-pro-max' },
  { model: 'UCG-Max', lan: ['Port 1', 'Port 2'], wan: 'WAN', copper: 5, lag: false,
    table: '2,000', url: 'https://techspecs.ui.com/unifi/cloud-gateways/ucg-max' },
  { model: 'UXG-Max', lan: ['eth1', 'eth2'], wan: 'eth0', copper: 5, lag: false,
    table: '2,000', url: 'https://techspecs.ui.com/unifi/cloud-gateways/uxg-max' }
];

ROWS.forEach(function (row) {
  console.log('');
  console.log(row.model + ' (' + row.table + '-entry MAC table, ' + row.url + '):');
  const gwSpec = spec(row.model);
  ok(!!gwSpec, 'the ' + row.model + ' is in the catalogue');
  if (!gwSpec) return;

  const caps = gwSpec.capabilities || [];
  ok(caps.indexOf('l2-forward') !== -1, 'it declares l2-forward', caps.join(','));
  ok(caps.indexOf('l3-forward') !== -1 && caps.indexOf('nat') !== -1,
    'and stays a gateway: l3-forward and nat are still declared', caps.join(','));
  ok(gwSpec.interfaces.filter(function (i) { return i.type === 'ethernet' && i.connector !== 'sfp+'; }).length === row.copper,
    'the copper census is the one the vendor prints: ' + row.copper + ' sockets',
    String(gwSpec.interfaces.filter(function (i) { return i.type === 'ethernet' && i.connector !== 'sfp+'; }).length));

  const t = new Topology();
  const gw = t.addDevice(gwSpec, 'gw');
  const pc1 = t.addDevice(PC(), 'pc1');
  const pc2 = t.addDevice(PC(), 'pc2');
  t.connect(pc1.id, 'eth0', gw.id, row.lan[0]);
  t.connect(pc2.id, 'eth0', gw.id, row.lan[1]);
  const sim = new Simulator(t);

  runCommands(pc1, t, sim, ['configure terminal', 'interface eth0', 'ip address 192.168.1.10 255.255.255.0']);
  runCommands(pc2, t, sim, ['configure terminal', 'interface eth0', 'ip address 192.168.1.11 255.255.255.0']);

  const cli = new CliSession(gw, t, sim);
  const say = function (c) { return (cli.run(c).output || []).map(String); };
  cli.run('enable');
  cli.run('configure terminal');
  say('interface ' + row.lan[0]);
  say('ip address 192.168.1.1 255.255.255.0');
  say('end');

  ok(sim.ping(pc1.id, '192.168.1.11', { count: 2 }).success,
    'two hosts on ' + row.lan[0] + ' and ' + row.lan[1] + ' reach each other through the LAN bank');
  ok(sim.ping(pc2.id, '192.168.1.1', { count: 2 }).success,
    'and the bank address is answered from a port other than the one that holds it');

  cli.run('configure terminal');
  say('vlan 10');
  say('interface ' + row.lan[0]);
  const access = say('switchport access vlan 10');
  ok(!access.some(function (l) { return /^\s*%/.test(l); }),
    'switchport access vlan is accepted on a LAN port', JSON.stringify(access));

  if (row.lag) {
    const lag = say('channel-group 1 mode active');
    ok(!lag.some(function (l) { return /^\s*%/.test(l); }),
      'channel-group is accepted: the vendor states LACP over ports 1-8', JSON.stringify(lag));
  }

  say('no switchport');
  const addr = say('ip address 192.0.2.1 255.255.255.0');
  ok(!addr.some(function (l) { return /^\s*%/.test(l); }),
    'a LAN port can still be made a routed port and take an address', JSON.stringify(addr));

  say('interface ' + row.wan);
  const wan = say('ip address 203.0.113.2 255.255.255.0');
  ok(!wan.some(function (l) { return /^\s*%/.test(l); }),
    'the WAN port still takes an address', JSON.stringify(wan));
  cli.run('end');
});

console.log('');
if (failed) { console.error(passed + ' passed, ' + failed + ' failed'); process.exit(1); }
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(0);
