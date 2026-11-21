'use strict';
// A virtual address the box answers for is in its own ARP table.
//
// `show arp` gained one row per interface address, age `-`, after the vendor's field list said what the
// hyphen means ("a hyphen (-) means the address is local"). A first-hop group's virtual address is a
// local address by the same test - the master answers ARP for it - and Cisco's own check for a group
// reads exactly that row out of this table:
//
//   ed1-pe1#show ip arp vrf vrf1
//   Internet  10.2.0.1   -   00d0.bbd3.bc22   ARPA   Ethernet0/2
//   Internet  10.2.0.20  -   0000.0c07.ac01   ARPA   Ethernet0/2   <- the group's virtual address
//   (Cisco, "Understand the HSRP Features and Functionality", doc 9234)
//
// and for VRRP the same row carries the 0000.5e00.01xx MAC:
//
//   r1#show ip arp 10.1.123.100
//   Internet  10.1.123.100   1   0000.5e00.0101   ARPA   FastEthernet0/0
//   (cciepursuit.wordpress.com, question of the day 2008-05-02)
//
// The engine already knew the answer: the elected master claims the group's IPs (`claimVrrp()`) and
// `macForIp()` puts the virtual MAC on every reply for one. `show arp` was the one surface that did not
// say so, so a reader checking "does this router hold the gateway address" found nothing.
//
// A backup gets no row. What a real backup holds is learned from the master's gratuitous ARP, and this
// model does not install addresses from an unsolicited ARP - so it prints nothing rather than a binding
// it never received (research/show-arp-vrrp-virtual-address.md).
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
const ROUTER = catalog.filter(function (s) { return s.model === 'ISR 4331'; })[0];

function configure(dev, topo, cmds) {
  runCommands(dev, topo, null, ['enable', 'configure terminal'].concat(cmds).concat(['end']));
}

function rows(dev, topo, sim) {
  const out = new CliSession(dev, topo, sim).run('show arp').output || [];
  return out.slice(1).map(function (l) { return l.trim().split(/\s+/); });
}
function rowFor(dev, topo, sim, ip) {
  return rows(dev, topo, sim).filter(function (f) { return f[1] === ip; })[0] || [];
}

// Two routers on one segment, one VRRP group. r1 is master on priority 150, r2 backup on 100.
function lab() {
  const t = new Topology();
  const r1 = t.addDevice(ROUTER, 'r1');
  const r2 = t.addDevice(ROUTER, 'r2');
  t.connect('r1', 'Gi0/0/0', 'r2', 'Gi0/0/0');
  configure(r1, t, ['interface Gi0/0/0', 'ip address 10.0.0.1 255.255.255.0',
    'vrrp 1 ip 10.0.0.254', 'vrrp 1 priority 150', 'no shutdown']);
  configure(r2, t, ['interface Gi0/0/0', 'ip address 10.0.0.2 255.255.255.0',
    'vrrp 1 ip 10.0.0.254', 'no shutdown']);
  return { t: t, r1: r1, r2: r2, sim: new Simulator(t) };
}

console.log('');
console.log('The master lists the virtual address as its own:');
{
  const env = lab();
  const vip = rowFor(env.r1, env.t, env.sim, '10.0.0.254');
  ok(vip.length === 6, 'the master prints one row for the group address', JSON.stringify(vip));
  ok(vip[0] === 'Internet', 'Protocol is Internet', vip[0]);
  ok(vip[2] === '-', 'Age (min) is the hyphen a local address carries, not a count', vip[2]);
  ok(vip[3] === '0000.5e00.0101', 'Hardware Addr is the group virtual MAC, dotted as this table writes MACs',
    vip[3]);
  ok(vip[4] === 'ARPA', 'Type is ARPA', vip[4]);
  // Whole name, as the HSRP capture in the note spells it: `ARPA Ethernet0/2`, not `Et0/2`
  // (research/show-arp-interface-spelling.md).
  ok(vip[5] === 'GigabitEthernet0/0/0', 'Interface is the port the group is on', vip[5]);
  // The MAC printed has to be the MAC the data plane uses, or the table and the wire disagree.
  ok(env.r1.macForIp('10.0.0.254', 'Gi0/0/0') === '00:00:5e:00:01:01',
    'and it is the MAC macForIp() answers ARP with', env.r1.macForIp('10.0.0.254', 'Gi0/0/0'));
}

console.log('');
console.log('The interface row is still there, and there is exactly one of each:');
{
  const env = lab();
  const own = rowFor(env.r1, env.t, env.sim, '10.0.0.1');
  ok(own[2] === '-' && own[5] === 'GigabitEthernet0/0/0', 'the port own address keeps its local row',
    JSON.stringify(own));
  const ips = rows(env.r1, env.t, env.sim).map(function (f) { return f[1]; });
  ok(ips.length === 2, 'two rows on the master: the port address and the group address', JSON.stringify(ips));
  ok(ips[0] === '10.0.0.1' && ips[1] === '10.0.0.254', 'and they are in address order', JSON.stringify(ips));
}

console.log('');
console.log('A backup prints no binding it does not hold:');
{
  const env = lab();
  const vip = rowFor(env.r2, env.t, env.sim, '10.0.0.254');
  ok(vip.length === 0, 'the backup has no row for the group address', JSON.stringify(vip));
  ok(rowFor(env.r2, env.t, env.sim, '10.0.0.2').length === 6,
    'while its own port address is still printed, so the table is not simply empty');
}

console.log('');
console.log('An address-owner group does not print its one address twice:');
{
  const t = new Topology();
  const r1 = t.addDevice(ROUTER, 'r1');
  const r2 = t.addDevice(ROUTER, 'r2');
  t.connect('r1', 'Gi0/0/0', 'r2', 'Gi0/0/0');
  // The interface address IS the group address: VRRP's "IP address owner", implicitly priority 255.
  configure(r1, t, ['interface Gi0/0/0', 'ip address 10.0.0.254 255.255.255.0',
    'vrrp 1 ip 10.0.0.254', 'no shutdown']);
  configure(r2, t, ['interface Gi0/0/0', 'ip address 10.0.0.2 255.255.255.0',
    'vrrp 1 ip 10.0.0.254', 'no shutdown']);
  const sim = new Simulator(t);
  const hits = rows(r1, t, sim).filter(function (f) { return f[1] === '10.0.0.254'; });
  ok(hits.length === 1, 'the owner prints one row for the address, not two', JSON.stringify(hits));
  ok(hits[0][2] === '-', 'still a local row', JSON.stringify(hits[0]));
  // The address is the port's own here, so the row is the port's, with the port's MAC: the group does
  // not substitute a hardware address for an address an interface already holds.
  ok(hits[0][3] === net.formatMac(r1.interfaces.get('Gi0/0/0').mac),
    'and it carries the port hardware address, not a second one', hits[0][3]);
}

console.log('');
console.log('Two groups on one port are two rows:');
{
  const t = new Topology();
  const r1 = t.addDevice(ROUTER, 'r1');
  const r2 = t.addDevice(ROUTER, 'r2');
  t.connect('r1', 'Gi0/0/0', 'r2', 'Gi0/0/0');
  configure(r1, t, ['interface Gi0/0/0', 'ip address 10.0.0.1 255.255.255.0',
    'vrrp 1 ip 10.0.0.254', 'vrrp 1 priority 150', 'vrrp 2 ip 10.0.0.253', 'vrrp 2 priority 150', 'no shutdown']);
  configure(r2, t, ['interface Gi0/0/0', 'ip address 10.0.0.2 255.255.255.0',
    'vrrp 1 ip 10.0.0.254', 'vrrp 2 ip 10.0.0.253', 'no shutdown']);
  const sim = new Simulator(t);
  ok(rowFor(r1, t, sim, '10.0.0.254')[3] === '0000.5e00.0101', 'group one address carries group one MAC',
    rowFor(r1, t, sim, '10.0.0.254').join(' '));
  ok(rowFor(r1, t, sim, '10.0.0.253')[3] === '0000.5e00.0102', 'group two address carries group two MAC',
    rowFor(r1, t, sim, '10.0.0.253').join(' '));
}

console.log('');
console.log('Removing the group removes the row:');
{
  const env = lab();
  // Through the session's own simulator, so the election is re-run the way a typed 'no vrrp' re-runs it.
  runCommands(env.r1, env.t, env.sim, ['enable', 'configure terminal', 'interface Gi0/0/0',
    'no vrrp 1', 'end']);
  const vip = rowFor(env.r1, env.t, env.sim, '10.0.0.254');
  ok(vip.length === 0, 'the address leaves the table when the group no longer claims it', JSON.stringify(vip));
}

console.log('');
console.log('' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
