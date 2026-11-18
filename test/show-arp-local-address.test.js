'use strict';
// The box's own addresses are entries in `show arp`.
//
// Cisco's field list for the command settles what the hyphen in `Age (min)` means - "Age, in minutes, of the
// cache entry; a hyphen (-) means the address is local" - and two transcripts show the row itself, one on a
// router and one on a switch:
//
//   ASR1k#show arp
//   Internet  10.2.2.1   -   30e4.dbb7.7e02   ARPA   GigabitEthernet0/0/2
//   Internet  10.2.2.2   253 0004.c01d.7c1a   ARPA   GigabitEthernet0/0/2
//   (Cisco TAC, ARP FAQ 117398)
//
//   SW_SDVoE#show ip arp
//   Internet 192.168.2.1 - d42c.4461.e340 ARPA Vlan1
//   Internet 192.168.2.4 0 a0ce.c8fb.3249 ARPA Vlan1
//   (Cisco Learning Network, a 2960-CX acting as a DHCP server)
//
// This table listed only what the box had heard, so the address configured on the box was missing from the
// box's own ARP cache. The rule is asserted here: one row per interface holding an IPv4 address, age `-`,
// Hardware Addr the port's own MAC, Interface the port's name - and no such row on an end host, whose cache
// holds its neighbours rather than itself. research/show-arp-local-address.md has the sources.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');
const net = require('../engine/net');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.filter(function (s) { return /ASR 1001-X/.test(s.model); })[0];
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];
const PC = catalog.filter(function (s) { return s.model === 'generic-pc'; })[0];
const eth = function (d) {
  return [...d.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
};

function lines(dev, topo, sim) {
  return ((new CliSession(dev, topo, sim).run('show arp').output) || []).map(String);
}
function fields(dev, topo, sim) {
  return lines(dev, topo, sim).slice(1).map(function (l) { return l.trim().split(/\s+/); });
}
function rowFor(dev, topo, sim, ip) {
  return fields(dev, topo, sim).filter(function (f) { return f[1] === ip; })[0] || [];
}

// A router and one PC behind a switch, with the router's port addressed and the PC addressed and pinging.
function lab() {
  const t = new Topology();
  const r = t.addDevice(ROUTER, 'r1');
  const sw = t.addDevice(SWITCH, 'sw');
  const pc = t.addDevice(PC, 'pc');
  t.connect('r1', eth(r)[0].name, 'sw', 'Fa0/1');
  t.connect('pc', 'eth0', 'sw', 'Fa0/2');
  const sim = new Simulator(t);
  runCommands(r, t, sim, ['configure terminal', 'interface ' + eth(r)[0].name,
    'ip address 10.0.0.1 255.255.255.0', 'end']);
  runCommands(pc, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.0.10 255.255.255.0', 'ip default-gateway 10.0.0.1', 'end']);
  return { t: t, sim: sim, r: r, sw: sw, pc: pc };
}

console.log('');
console.log('The address on the box is a row in its own ARP table:');
{
  const env = lab();
  const row = rowFor(env.r, env.t, env.sim, '10.0.0.1');
  ok(row.length === 6, 'the local entry is a six-column row', JSON.stringify(row));
  ok(row[0] === 'Internet', 'with Internet in the Protocol column', JSON.stringify(row[0]));
  ok(row[2] === '-', 'a hyphen for its age, the vendor rule for an address that is local', JSON.stringify(row[2]));
  ok(row[3] === net.formatMac(eth(env.r)[0].mac),
    'the hardware address of the port that holds it, printed dotted', JSON.stringify(row[3]));
  ok(row[4] === 'ARPA', 'ARPA in the Type column, as every Ethernet row is', JSON.stringify(row[4]));
  ok(row[5] === eth(env.r)[0].name, 'and the port named in the Interface column', JSON.stringify(row[5]));
}

console.log('');
console.log('The row is there before anything has been heard - it is configuration, not traffic:');
{
  const env = lab();
  // No ping, no simulation run: only the address typed on the port.
  const shown = lines(env.r, env.t, null);
  ok(shown.length === 2, 'header and the one local row', shown.join(' | '));
  ok(/^Internet\s+10\.0\.0\.1\s+-\s+/.test(shown[1] || ''), 'and it is the configured address with a hyphen age',
    shown[1]);
}

console.log('');
console.log('A learned neighbour is still printed beside it, with its own port:');
{
  const env = lab();
  env.sim.ping('pc', '10.0.0.1', { count: 1 });
  const local = rowFor(env.r, env.t, env.sim, '10.0.0.1');
  const heard = rowFor(env.r, env.t, env.sim, '10.0.0.10');
  ok(heard.length === 6, 'the neighbour row is still there', JSON.stringify(heard));
  ok(heard[3] === net.formatMac(env.r.arp.get('10.0.0.10')),
    'with the learned hardware address, not the port\'s', JSON.stringify(heard[3]));
  ok(heard[3] !== local[3], 'so the two rows carry different hardware addresses', JSON.stringify([local[3], heard[3]]));
  ok(heard[5] === eth(env.r)[0].name, 'and the port it was heard on', JSON.stringify(heard[5]));
  const order = fields(env.r, env.t, env.sim).map(function (f) { return f[1]; });
  ok(order.join(',') === '10.0.0.1,10.0.0.10', 'rows stay in numeric address order', order.join(','));
}

console.log('');
console.log('An end host does not print a row for itself:');
{
  const env = lab();
  env.sim.ping('pc', '10.0.0.1', { count: 1 });
  const own = rowFor(env.pc, env.t, env.sim, '10.0.0.10');
  ok(own.length === 0, 'the PC\'s own address is not an ARP entry in its cache', JSON.stringify(own));
  const gw = rowFor(env.pc, env.t, env.sim, '10.0.0.1');
  ok(gw.length === 6, 'but its gateway is', JSON.stringify(gw));
}

console.log('');
console.log('A subinterface with an address gets its own row, under its own name:');
{
  const env = lab();
  const parent = eth(env.r)[0].name;
  runCommands(env.r, env.t, env.sim, ['configure terminal', 'interface ' + parent + '.10',
    'ip address 10.0.10.1 255.255.255.0', 'end']);
  const sub = parent + '.10';
  const row = rowFor(env.r, env.t, env.sim, '10.0.10.1');
  ok(row.length === 6, 'the subinterface address is listed', JSON.stringify(row));
  ok(row[2] === '-', 'with a hyphen age, as a local address', JSON.stringify(row[2]));
  ok(row[5] === sub, 'and its own name in the Interface column', JSON.stringify(row[5]));
  ok(row[3] === net.formatMac(eth(env.r)[0].mac),
    'borrowing the parent port\'s hardware address', JSON.stringify(row[3]));
}

console.log('');
console.log('A box with no IPv4 address has no local row to print:');
{
  const t = new Topology();
  const r = t.addDevice(ROUTER, 'bare');
  const shown = lines(r, t, null);
  ok(shown.length === 1, 'the header and nothing else', shown.join(' | '));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
