'use strict';
// DHCP in the data path: 'ip address dhcp' has to actually get an address.
//
// Before this, the command set a flag on the interface and nothing else - the client stayed
// unaddressed, every ping it sent failed, and nothing in the timeline said why. The server
// side (offers, NAKs, reservations, lease expiry) had been sitting in engine/dhcp.js and
// tested in isolation, with no way to configure a pool and nothing that ran an exchange.
//
// What is locked here:
//   1. a client that asks gets a real lease - address, mask and gateway - and can ping;
//   2. two clients get different addresses;
//   3. the server never hands out an address it already owns (its own interface / gateway);
//   4. an exhausted range is reported, not silently ignored;
//   5. a segment with no server is reported as such, and the client stays unaddressed;
//   6. the excluded range is honoured;
//   7. DNS servers from the pool reach the client;
//   8. pool config survives save/load and still serves the same address afterwards;
//   9. a statically addressed client is left alone.
//
// The exchange is computed at the start of a run rather than timed (see computeDhcp), so
// these assertions are about outcomes, not about DISCOVER timeouts.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.log('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + ' (expected ' + JSON.stringify(expected) +
    ', got ' + JSON.stringify(actual) + ')');
}
function section(name) { console.log('\n' + name); }

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(model) {
  const s = catalog.find(function (x) { return x.model === model; });
  if (!s) throw new Error('missing spec ' + model);
  return s;
}
function cfg(dev, cmds, topo, sim) {
  return runCommands(dev, topo, sim, ['enable', 'configure terminal'].concat(cmds));
}
function dhcpEvents(sim) {
  return sim.events.filter(function (e) {
    return String(e.type || '').indexOf('dhcp') === 0;
  });
}

// A router on a stick with n clients hanging off a switch.
function bench(clientCount) {
  const topo = new Topology();
  const router = topo.addDevice(spec('generic-router'));
  const sw = topo.addDevice(spec('generic-switch'));
  topo.connect(router.id, 'Gi0/0', sw.id, 'Fa0/1');
  const clients = [];
  for (let i = 0; i < clientCount; i++) {
    const pc = topo.addDevice(spec('generic-pc'));
    topo.connect(sw.id, 'Fa0/' + (i + 2), pc.id, 'eth0');
    clients.push(pc);
  }
  return { topo: topo, router: router, sw: sw, clients: clients };
}

section('1. A client that asks gets a real lease, and can ping');
{
  const b = bench(1);
  const sim = new Simulator(b.topo);
  cfg(b.router, [
    'interface Gi0/0', 'ip address 192.168.1.1 255.255.255.0', 'exit',
    'ip dhcp pool LAN', 'network 192.168.1.0 255.255.255.0',
    'default-router 192.168.1.1', 'exit'
  ], b.topo, sim);
  cfg(b.clients[0], ['interface eth0', 'ip address dhcp'], b.topo, sim);

  const iface = b.clients[0].interfaces.get('eth0');
  eq(iface.dhcp, true, 'the interface is marked as a DHCP client');

  const ping = sim.ping(b.clients[0].id, '192.168.1.1', { count: 1 });
  ok(ping.success, 'the client can reach the router');

  ok(iface.ip !== null && iface.ip !== undefined, 'the client holds an address (' + iface.ip + ')');
  eq(iface.mask, '255.255.255.0', 'with the pool mask');
  eq(iface.gateway, '192.168.1.1', 'and the pool default gateway');
  eq(iface.dhcpLeased, true, 'and it is recorded as leased');

  // The address is inside the pool subnet and is not the server's own.
  ok(iface.ip.indexOf('192.168.1.') === 0, 'the address is inside the pool subnet');
  ok(iface.ip !== '192.168.1.1', 'and it is not the router\'s own address');
}

section('2. Two clients get two addresses');
{
  const b = bench(2);
  const sim = new Simulator(b.topo);
  cfg(b.router, [
    'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'exit',
    'ip dhcp pool LAN', 'network 10.0.0.0 255.255.255.0', 'exit'
  ], b.topo, sim);
  cfg(b.clients[0], ['interface eth0', 'ip address dhcp'], b.topo, sim);
  cfg(b.clients[1], ['interface eth0', 'ip address dhcp'], b.topo, sim);
  sim.ping(b.clients[0].id, '10.0.0.1', { count: 1 });

  const a = b.clients[0].interfaces.get('eth0').ip;
  const c = b.clients[1].interfaces.get('eth0').ip;
  ok(a && c, 'both clients are addressed (' + a + ', ' + c + ')');
  ok(a !== c, 'and the two addresses differ');
  ok(a !== '10.0.0.1' && c !== '10.0.0.1', 'neither of them is the server address');
  ok(sim.ping(b.clients[0].id, c, { count: 1 }).success, 'and they can reach each other');
}

section('3. The server never hands out an address it owns');
{
  const b = bench(1);
  const sim = new Simulator(b.topo);
  // No explicit range: the derived range starts at the first usable address, which is the
  // router's own gateway. This is the case that produced a duplicate address before.
  cfg(b.router, [
    'interface Gi0/0', 'ip address 172.16.5.1 255.255.255.0', 'exit',
    'ip dhcp pool P', 'network 172.16.5.0 255.255.255.0',
    'default-router 172.16.5.1', 'exit'
  ], b.topo, sim);
  cfg(b.clients[0], ['interface eth0', 'ip address dhcp'], b.topo, sim);
  sim.ping(b.clients[0].id, '172.16.5.1', { count: 1 });

  const ip = b.clients[0].interfaces.get('eth0').ip;
  ok(ip !== '172.16.5.1', 'the lease is not the address the server already holds (' + ip + ')');
  eq(b.clients[0].interfaces.get('eth0').gateway, '172.16.5.1',
    'while the gateway is still the server, as an operator would expect');
}

section('4. An exhausted range is reported, not ignored');
{
  const b = bench(3);
  const sim = new Simulator(b.topo);
  cfg(b.router, [
    'interface Gi0/0', 'ip address 192.168.9.1 255.255.255.0', 'exit',
    'ip dhcp pool TINY', 'network 192.168.9.0 255.255.255.0',
    'range 192.168.9.50 192.168.9.51', 'exit'
  ], b.topo, sim);
  for (const pc of b.clients) cfg(pc, ['interface eth0', 'ip address dhcp'], b.topo, sim);
  sim.ping(b.clients[0].id, '192.168.9.1', { count: 1 });

  const got = b.clients.map(function (pc) { return pc.interfaces.get('eth0').ip; });
  const served = got.filter(function (x) { return !!x; });
  eq(served.length, 2, 'two clients are served by a two-address range');
  eq(got.filter(function (x) { return !x; }).length, 1, 'the third one is not');
  ok(served.indexOf('192.168.9.50') !== -1 && served.indexOf('192.168.9.51') !== -1,
    'and the two leases are exactly the range');

  const evs = dhcpEvents(sim);
  ok(evs.some(function (e) { return e.type === 'dhcp-no-offer'; }),
    'the exhausted pool produces a no-offer event instead of silence');
  ok(evs.some(function (e) { return e.type === 'dhcp-failed'; }),
    'and the unserved client records a failure');
}

section('5. No server on the segment says so');
{
  const topo = new Topology();
  const sw = topo.addDevice(spec('generic-switch'));
  const pc = topo.addDevice(spec('generic-pc'));
  const other = topo.addDevice(spec('generic-pc'));
  topo.connect(sw.id, 'Fa0/1', pc.id, 'eth0');
  topo.connect(sw.id, 'Fa0/2', other.id, 'eth0');
  const sim = new Simulator(topo);
  cfg(pc, ['interface eth0', 'ip address dhcp'], topo, sim);

  // The control plane runs on the first simulated action, not on the config command, so
  // the client's failure to get a lease has to be observed by trying to use the network.
  try { sim.ping(pc.id, '192.168.1.1', { count: 1 }); } catch (e) { /* no address to send from */ }

  ok(!pc.interfaces.get('eth0').ip, 'the client stays unaddressed');
  const evs = dhcpEvents(sim);
  const fail = evs.filter(function (e) { return e.type === 'dhcp-failed'; })[0];
  ok(!!fail, 'a dhcp-failed event is emitted');
  eq(fail.reason, 'no DHCP server on this broadcast domain',
    'and it names the reason, so the timeline explains the silent ping');
}

section('6. The excluded range is honoured');
{
  const b = bench(1);
  const sim = new Simulator(b.topo);
  cfg(b.router, [
    'interface Gi0/0', 'ip address 192.168.7.1 255.255.255.0', 'exit',
    'ip dhcp pool P', 'network 192.168.7.0 255.255.255.0',
    'range 192.168.7.10 192.168.7.20',
    'excluded-address 192.168.7.10 192.168.7.15', 'exit'
  ], b.topo, sim);
  cfg(b.clients[0], ['interface eth0', 'ip address dhcp'], b.topo, sim);
  sim.ping(b.clients[0].id, '192.168.7.1', { count: 1 });

  eq(b.clients[0].interfaces.get('eth0').ip, '192.168.7.16',
    'the first lease skips the excluded block');
}

section('7. DNS servers from the pool reach the client');
{
  const b = bench(1);
  const sim = new Simulator(b.topo);
  cfg(b.router, [
    'interface Gi0/0', 'ip address 192.168.4.1 255.255.255.0', 'exit',
    'ip dhcp pool P', 'network 192.168.4.0 255.255.255.0',
    'dns-server 192.168.4.53', 'exit'
  ], b.topo, sim);
  cfg(b.clients[0], ['interface eth0', 'ip address dhcp'], b.topo, sim);
  sim.ping(b.clients[0].id, '192.168.4.1', { count: 1 });

  eq((b.clients[0].config.dnsServers || []).join(','), '192.168.4.53',
    'the client learned the DNS server from the pool');
}

section('8. Pool config survives save/load, and still serves the same address');
{
  // Direct router-to-PC, so the reloaded topology has its client in place already.
  const topo = new Topology();
  const router = topo.addDevice(spec('generic-router'));
  const pc = topo.addDevice(spec('generic-pc'));
  topo.connect(router.id, 'Gi0/0', pc.id, 'eth0');
  const sim = new Simulator(topo);
  cfg(router, [
    'interface Gi0/0', 'ip address 192.168.3.1 255.255.255.0', 'exit',
    'ip dhcp pool P', 'network 192.168.3.0 255.255.255.0', 'exit'
  ], topo, sim);

  const saved = topo.serialize();
  const pools = saved.devices.filter(function (d) { return d.config; })
    .map(function (d) { return (d.config.dhcpPools || []).length; })
    .reduce(function (a, c) { return a + c; }, 0);
  eq(pools, 1, 'the pool is written into the saved topology');

  const reloaded = Topology.fromJSON(saved);
  const router2 = Array.from(reloaded.devices.values()).filter(function (d) {
    return (d.config.dhcpPools || []).length;
  })[0];
  ok(!!router2, 'and it comes back on the right device');
  eq(router2.config.dhcpPools[0].rangeStart, '192.168.3.1',
    'with its derived range intact');

  const pc2 = Array.from(reloaded.devices.values()).filter(function (d) {
    return d.id !== router2.id;
  })[0];
  const sim2 = new Simulator(reloaded);
  cfg(pc2, ['interface eth0', 'ip address dhcp'], reloaded, sim2);
  sim2.ping(pc2.id, '192.168.3.1', { count: 1 });
  eq(pc2.interfaces.get('eth0').ip, '192.168.3.2',
    'and a client on the reloaded topology gets the first free address');
}

section('9. A statically addressed client is left alone');
{
  const b = bench(1);
  const sim = new Simulator(b.topo);
  cfg(b.router, [
    'interface Gi0/0', 'ip address 192.168.2.1 255.255.255.0', 'exit',
    'ip dhcp pool P', 'network 192.168.2.0 255.255.255.0', 'exit'
  ], b.topo, sim);
  cfg(b.clients[0], ['interface eth0', 'ip address 192.168.2.77 255.255.255.0'], b.topo, sim);
  sim.ping(b.clients[0].id, '192.168.2.1', { count: 1 });

  eq(b.clients[0].interfaces.get('eth0').ip, '192.168.2.77',
    'the static address is untouched');
  eq(b.clients[0].interfaces.get('eth0').dhcpLeased, undefined,
    'and no lease was recorded against it');
}

section('10. A router can be the client, which is how a WAN uplink works');
{
  const topo = new Topology();
  const upstream = topo.addDevice(spec('generic-router'));
  const downstream = topo.addDevice(spec('generic-router'));
  topo.connect(upstream.id, 'Gi0/0', downstream.id, 'Gi0/0');
  const sim = new Simulator(topo);
  cfg(upstream, [
    'interface Gi0/0', 'ip address 203.0.113.1 255.255.255.0', 'exit',
    'ip dhcp pool WAN', 'network 203.0.113.0 255.255.255.0',
    'default-router 203.0.113.1', 'exit'
  ], topo, sim);
  cfg(downstream, ['interface Gi0/0', 'ip address dhcp'], topo, sim);
  sim.ping(downstream.id, '203.0.113.1', { count: 1 });

  const wan = downstream.interfaces.get('Gi0/0');
  ok(wan.ip && wan.ip.indexOf('203.0.113.') === 0, 'the downstream router got a WAN address (' + wan.ip + ')');
  eq(wan.gateway, '203.0.113.1', 'with the upstream as its gateway');
  ok(sim.ping(downstream.id, '203.0.113.1', { count: 1 }).success, 'and it can reach upstream');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
