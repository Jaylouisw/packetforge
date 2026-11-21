'use strict';
// What `show ip route` calls the port in a row: the full type word, as a sentence.
//
// The console printed the panel's short name - `C 10.1.2.0/24 is directly connected, Gi0` and
// `O 192.168.9.0/24 [110/2] via 10.0.0.1  Gi0` - while every published capture of this command spells the
// type out and separates it from the next hop with a comma:
//
//   C 10.44.192.0/24 is directly connected, GigabitEthernet0/0
//   L 10.44.192.1/32 is directly connected, GigabitEthernet0/0
//       Cisco, "Configure a Gateway of Last Resort that Uses IP Commands" (doc 16448, updated 2025, IOS 15M
//       on a Cisco 3900), first table
//       https://www.cisco.com/c/en/us/support/docs/ip/routing-information-protocol-rip/16448-default.html
//   P 172.16.4.0/8 [1/0] via 10.1.1.1, BRI0
//   H 172.16.99.0 [250/1] via 10.1.1.99, 00:11:43, Tunnel0
//       Cisco IOS IP Routing: Protocol-Independent Command Reference, `show ip route`, sample output
//       https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/iproute_pi/command/iri-cr-book/iri-cr-s1.html
//   O E2 10.110.0.0 [160/5] via 10.119.254.6, 0:01:00, Ethernet2
//   E    10.67.10.0 [200/128] via 10.119.254.244, 0:02:22, Ethernet2
//       Same reference, and the 12.x TAC command reference (Ethernet2, TokenRing0, "S 134.134.0.0 is
//       directly connected, Ethernet0")
//       https://www.cisco.com/E-Learning/bulk/public/tac/cim/cib/using_cisco_ios_software/cmdrefs/show_ip_route.htm
//   S 172.16.2.0/24 [1/0] via 172.16.4.2, Serial0/0/1
//       Cisco Learning Network, the row for a fully specified static, quoted in
//       research/show-ip-route-interface-spelling.md
//
// The interface is therefore a field of the sentence, not a table cell: the type word is spelled out and
// preceded by ", " whenever one follows the next hop. This console's own `show ip interface brief` already
// spells the type out (research/interface-brief-name-spelling.md); `show ip route` was the view that did not.
//
// What is NOT modelled, and is not printed rather than guessed: a protocol-learned row on the box carries a
// third field between next hop and interface - the route's age, `00:11:43` - which this engine does not track
// (research/show-ip-route-interface-spelling.md, "what is unresolved").
const path = require('path');
const { Topology, Simulator, Device, runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');
const { displayName } = require('../engine/iface-name');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.filter(function (s) { return /ASR 1001-X/.test(s.model); })[0];

function show(dev, topo, sim, cmd) {
  return ((new CliSession(dev, topo, sim).run(cmd).output) || []).map(String);
}
function rowFor(lines, needle) {
  return lines.filter(function (l) { return /^[A-Z]\*?\s/.test(l) && l.indexOf(needle) !== -1; })[0] || '';
}

console.log('');
console.log('A connected row names the port in the box\'s spelling');
{
  const dev = new Device('r1', ROUTER);
  const port = [...dev.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; })[0];
  port.ip = '10.1.2.3'; port.mask = '255.255.255.0'; port.enabled = true;
  const lines = show(dev, null, null, 'show ip route');
  const c = rowFor(lines, '10.1.2.0/24');
  const l = rowFor(lines, '10.1.2.3/32');
  const long = displayName(port.name);
  ok(long !== port.name, 'the port this test uses is stored short and printed long', port.name + ' -> ' + long);
  ok(c === 'C   10.1.2.0/24 is directly connected, ' + long,
    'the C row spells the type word out, as a sentence', c);
  ok(l === 'L   10.1.2.3/32 is directly connected, ' + long,
    'the L row does too', l);
  ok(c.indexOf('is directly connected, ' + port.name) === -1,
    'and the short cell spelling is gone from the sentence', c);
}

console.log('');
console.log('A fully specified static separates the interface from the next hop with a comma');
{
  const dev = new Device('r1', ROUTER);
  const ports = [...dev.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
  const cli = new CliSession(dev, null, null);
  cli.run('configure terminal');
  cli.run('interface ' + ports[0].name); cli.run('ip address 10.1.2.3 255.255.255.0');
  cli.run('no shutdown'); cli.run('exit');
  dev.config.routes.push({ dest: '10.8.0.0', mask: '255.255.0.0', gw: '10.1.2.9', iface: ports[1].name });
  dev.config.routes.push({ dest: '172.16.0.0', mask: '255.255.0.0', gw: '10.1.2.9' });
  const lines = show(dev, null, null, 'show ip route');
  const full = rowFor(lines, '10.8.0.0/16');
  const nextHopOnly = rowFor(lines, '172.16.0.0/16');
  ok(full === 'S   10.8.0.0/16 [1/0] via 10.1.2.9, ' + displayName(ports[1].name),
    'the row reads "via <next hop>, <interface>", the vendor\'s fully specified form', full);
  ok(nextHopOnly === 'S   172.16.0.0/16 [1/0] via 10.1.2.9',
    'a next-hop-only route still names no interface and adds no dangling comma', nextHopOnly);
  const row = dev.routesTable(null).filter(function (r) { return r.dest === '10.8.0.0'; })[0];
  ok(row.iface === ports[1].name,
    'the stored iface stays the panel name every lookup uses', row && row.iface);
  ok(row.ifaceDisplay === displayName(ports[1].name) && row.ifaceDisplay !== row.iface,
    'and ifaceDisplay is the printed spelling the other surface reads too', row && row.ifaceDisplay);
}

console.log('');
console.log('An OSPF row is the same sentence, with the comma');
{
  const t = new Topology();
  const r1 = t.addDevice(ROUTER, 'r1');
  const r2 = t.addDevice(ROUTER, 'r2');
  const eth = function (d) {
    return [...d.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; }).map(function (i) { return i.name; });
  };
  const a1 = eth(r1)[0], a2 = eth(r1)[1], b1 = eth(r2)[0];
  t.connect('r1', a1, 'r2', b1);
  const sim = new Simulator(t);
  runCommands(r1, t, sim, ['configure terminal',
    'interface ' + a1, 'ip address 10.0.0.1 255.255.255.0', 'exit',
    'interface ' + a2, 'ip address 192.168.9.1 255.255.255.0', 'exit',
    'router ospf 1', 'ospf router-id 1.1.1.1',
    'network 10.0.0.0 255.255.255.0 area 0',
    'network 192.168.9.0 255.255.255.0 area 0', 'end']);
  runCommands(r2, t, sim, ['configure terminal',
    'interface ' + b1, 'ip address 10.0.0.2 255.255.255.0', 'exit',
    'router ospf 1', 'ospf router-id 2.2.2.2',
    'network 10.0.0.0 255.255.255.0 area 0', 'end']);
  sim.computeOspf();
  const lines = show(r2, t, sim, 'show ip route');
  const o = rowFor(lines, '192.168.9.0/24');
  ok(o === 'O   192.168.9.0/24 [110/2] via 10.0.0.1, ' + displayName(a1),
    'the O row spells the port out, after a comma', o);
  ok(!/\s{2}GigabitEthernet/.test(o),
    'two spaces no longer stand where the vendor prints ", "', o);
  ok(!/\d\d:\d\d:\d\d/.test(o),
    'and no route age is invented: the field this engine does not track is simply absent', o);
}

console.log('');
console.log('One row, two spellings: the key the engine forwards by, and the cell the box prints');
{
  const t = new Topology();
  const dev = t.addDevice(ROUTER, 'r1');
  const port = [...dev.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; })[0];
  port.ip = '10.1.2.3'; port.mask = '255.255.255.0'; port.enabled = true;
  const row = dev.routesTable(t).filter(function (r) { return r.type === 'connected'; })[0];
  ok(row.iface === port.name && row.ifaceDisplay === displayName(port.name),
    'the row carries both: the key and the printed cell', row.iface + ' / ' + row.ifaceDisplay);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
