#!/usr/bin/env node
/**
 * DHCP in the data path (#1051).
 *
 * `engine/dhcp.js` modelled the exchange completely - pools, DISCOVER/OFFER, REQUEST/ACK, renewals,
 * reservations, exclusions - and nothing called it. `ip address dhcp` set a flag and the host stayed
 * unaddressed for the life of the lab, so every ping it sent failed silently and the lab read as a
 * broken configuration rather than a missing feature.
 *
 * These tests are about the caller: that a real lab gets real addresses, that the failures are the
 * ones a real server produces (no server, no pool, exhausted, NAK), that the broadcast domain is
 * walked rather than assumed, and that a save/load cycle does not lose the pools.
 */
'use strict';

const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const segment = require('../engine/segment');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}
function eq(got, want, name) { ok(got === want, name + ' (got ' + got + ', want ' + want + ')'); }
function t(name, fn) {
  console.log('\n' + name);
  if (typeof fn !== 'function') return;
  try { fn(); } catch (e) { failed++; console.log('  ✗ threw: ' + e.message); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(model) {
  const s = catalog.find(function (x) { return String(x.model) === model; });
  if (!s) throw new Error('missing spec ' + model);
  return s;
}

// A router with one pool, and hosts cabled to it.
function lab(opts) {
  opts = opts || {};
  const topo = new Topology();
  const r = topo.addDevice(spec('generic-router'));
  r.name = 'R1';
  const sim = new Simulator(topo);
  const cli = function (dev, cmds) { return runCommands(dev, topo, sim, cmds).lines; };
  const hosts = [];
  const ports = ['Gi0/0', 'Gi0/1', 'Gi0/2'];
  for (let i = 0; i < (opts.hosts || 2); i++) {
    const pc = topo.addDevice(spec('generic-pc'));
    pc.name = 'PC' + (i + 1);
    topo.connect(pc.id, 'eth0', r.id, ports[i]);
    cli(pc, ['enable', 'configure terminal', 'interface eth0', 'ip address dhcp', 'exit']);
    hosts.push({ dev: pc, port: ports[i] });
  }
  return { topo: topo, r: r, sim: sim, cli: cli, hosts: hosts };
}

function addPool(cli, r, lines) {
  return cli(r, ['enable', 'configure terminal', 'ip dhcp pool ' + (lines.name || 'lan')]
    .concat(lines.cmds || []).concat(['exit', 'end']));
}

// ---------------------------------------------------------------------------
t('A host that asks gets an address, in the events and on the interface');

{
  const L = lab();
  L.cli(L.r, ['enable', 'configure terminal',
    'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'exit', 'end']);
  addPool(L.cli, L.r, {
    cmds: ['network 10.0.0.0 255.255.255.0', 'default-router 10.0.0.1',
      'dns-server 1.1.1.1 8.8.8.8', 'range 10.0.0.100 10.0.0.110', 'lease 0 12 0']
  });

  const iface = L.hosts[0].dev.interfaces.get('eth0');
  eq(iface.ip, null, 'before the run the interface has no address');

  const res = L.sim.ping(L.hosts[0].dev.id, '10.0.0.1', { count: 1 });
  const dhcpEvents = res.events.filter(function (e) { return e.type === 'dhcp'; });
  ok(dhcpEvents.length >= 1, 'the exchange appears in the timeline');
  const ack = dhcpEvents.filter(function (e) { return e.phase === 'ack'; })[0];
  ok(!!ack, 'and it ends in an ACK, not silence');
  eq(ack.ip, '10.0.0.100', 'with the first address in the range');
  eq(ack.pool, 'lan', 'naming the pool');
  eq(ack.serverIp, '10.0.0.1', 'and the server that answered');
  eq(ack.leaseSec, 43200, 'and the twelve-hour lease that was configured');

  eq(iface.ip, '10.0.0.100', 'the interface now holds the address');
  eq(iface.mask, '255.255.255.0', 'with the pool mask');
  ok(!!iface.dhcpLease, 'and the lease is recorded on the interface');
  eq(iface.dhcpLease.gateway, '10.0.0.1', 'so `show` can report the gateway');
  ok(iface.dhcpLease.dns.indexOf('8.8.8.8') !== -1, 'and the DNS servers it was given');
  eq(L.hosts[0].dev.config.defaultGateway, '10.0.0.1', 'the default gateway came from the pool');
  ok(res.replies[0].success, 'and the host can now reach the router');
}

// ---------------------------------------------------------------------------
t('Two hosts, one pool: no address is handed out twice');

{
  // Both hosts are in the same subnet, which means a switch - two router ports would be two subnets,
  // and a router that handed the same range to both would be the bug this is not testing.
  const topo = new Topology();
  const r = topo.addDevice(spec('generic-router'));
  const sw = topo.addDevice(spec('generic-switch'));
  r.name = 'R1'; sw.name = 'SW1';
  topo.connect(sw.id, 'Fa0/1', r.id, 'Gi0/0');
  const sim = new Simulator(topo);
  const cli = function (dev, cmds) { return runCommands(dev, topo, sim, cmds).lines; };
  const hosts = [];
  for (let i = 0; i < 2; i++) {
    const pc = topo.addDevice(spec('generic-pc'));
    pc.name = 'PC' + (i + 1);
    topo.connect(pc.id, 'eth0', sw.id, 'Fa0/' + (2 + i));
    cli(pc, ['enable', 'configure terminal', 'interface eth0', 'ip address dhcp', 'exit']);
    hosts.push(pc);
  }
  cli(r, ['enable', 'configure terminal', 'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'exit', 'end']);
  addPool(cli, r, { cmds: ['network 10.0.0.0 255.255.255.0', 'range 10.0.0.100 10.0.0.110'] });

  sim.ping(hosts[0].id, '10.0.0.1', { count: 1 });
  sim.ping(hosts[0].id, '10.0.0.1', { count: 1 });
  sim.ping(hosts[1].id, '10.0.0.1', { count: 1 });
  const a = hosts[0].interfaces.get('eth0').ip;
  const b = hosts[1].interfaces.get('eth0').ip;
  ok(a && b && a !== b, 'the second host gets a different address (' + a + ', ' + b + ')');
  eq(a, '10.0.0.100', 'and the first keeps the one it already had');
}

// ---------------------------------------------------------------------------
t('The failures a real server produces are the ones reported');

{
  // No server in the domain at all.
  const topo = new Topology();
  const sw = topo.addDevice(spec('generic-switch'));
  const pc = topo.addDevice(spec('generic-pc'));
  sw.name = 'SW1'; pc.name = 'PC1';
  topo.connect(pc.id, 'eth0', sw.id, 'Fa0/1');
  const sim = new Simulator(topo);
  runCommands(pc, topo, sim, ['enable', 'configure terminal', 'interface eth0', 'ip address dhcp', 'exit']);
  // A server that is cabled but holds no pool: the domain has a DHCP box and it cannot answer.
  const r2 = topo.addDevice(spec('generic-router'));
  r2.name = 'R2';
  topo.connect(sw.id, 'Fa0/2', r2.id, 'Gi0/0');
  runCommands(r2, topo, sim, ['enable', 'configure terminal',
    'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'exit']);

  const res = sim.ping(pc.id, '10.0.0.1', { count: 1 });
  const fail = res.events.filter(function (e) { return e.type === 'dhcp' && e.phase === 'failed'; })[0];
  ok(!!fail, 'a failure is reported rather than nothing');
  eq(fail.reason, 'no-server', 'a router holding no pool is not a DHCP server and says so');
  eq(pc.interfaces.get('eth0').ip, null, 'the host stays unaddressed');
}

{
  // A real server whose pool covers a different subnet: it answers DISCOVERs in this domain and
  // still has nothing to give, which is a different failure from having no server.
  const topo = new Topology();
  const r = topo.addDevice(spec('generic-router'));
  const pc = topo.addDevice(spec('generic-pc'));
  r.name = 'R1'; pc.name = 'PC1';
  topo.connect(pc.id, 'eth0', r.id, 'Gi0/0');
  const sim = new Simulator(topo);
  const cli = function (dev, cmds) { return runCommands(dev, topo, sim, cmds).lines; };
  cli(pc, ['enable', 'configure terminal', 'interface eth0', 'ip address dhcp', 'exit']);
  cli(r, ['enable', 'configure terminal', 'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'exit', 'end']);
  addPool(cli, r, { cmds: ['network 192.168.5.0 255.255.255.0', 'range 192.168.5.10 192.168.5.20'] });

  const res = sim.ping(pc.id, '10.0.0.1', { count: 1 });
  const fail = res.events.filter(function (e) { return e.type === 'dhcp' && e.phase === 'failed'; })[0];
  ok(!!fail, 'a pool for the wrong subnet fails');
  eq(fail.reason, 'no-pool', 'with a reason that names the pool problem');
  ok(/none of the server pools/.test(fail.detail || ''), 'and says the interface is in none of them');
}

{
  // Pool exhausted: one address, two clients behind a switch, so both are in the same subnet.
  const topo = new Topology();
  const r = topo.addDevice(spec('generic-router'));
  const sw = topo.addDevice(spec('generic-switch'));
  r.name = 'R1'; sw.name = 'SW1';
  topo.connect(sw.id, 'Fa0/1', r.id, 'Gi0/0');
  const sim = new Simulator(topo);
  const cli = function (dev, cmds) { return runCommands(dev, topo, sim, cmds).lines; };
  const hosts = [];
  for (let i = 0; i < 2; i++) {
    const pc = topo.addDevice(spec('generic-pc'));
    pc.name = 'PC' + (i + 1);
    topo.connect(pc.id, 'eth0', sw.id, 'Fa0/' + (2 + i));
    cli(pc, ['enable', 'configure terminal', 'interface eth0', 'ip address dhcp', 'exit']);
    hosts.push(pc);
  }
  cli(r, ['enable', 'configure terminal', 'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'exit', 'end']);
  addPool(cli, r, { cmds: ['network 10.0.0.0 255.255.255.0', 'range 10.0.0.100 10.0.0.100'] });

  sim.ping(hosts[0].id, '10.0.0.1', { count: 1 });
  const res = sim.ping(hosts[1].id, '10.0.0.1', { count: 1 });
  const fail = res.events.filter(function (e) { return e.type === 'dhcp' && e.phase === 'failed'; })[0];
  ok(!!fail, 'the second client fails on a one-address pool');
  eq(fail.reason, 'pool-exhausted', 'and the reason is exhaustion, not a broken config');
}

// ---------------------------------------------------------------------------
t('Exclusions and reservations are honoured from the CLI');

{
  const L = lab();
  L.cli(L.r, ['enable', 'configure terminal',
    'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'exit', 'end']);
  addPool(L.cli, L.r, {
    cmds: ['network 10.0.0.0 255.255.255.0', 'range 10.0.0.100 10.0.0.105',
      'excluded-address 10.0.0.100 10.0.0.101']
  });
  L.sim.ping(L.hosts[0].dev.id, '10.0.0.1', { count: 1 });
  eq(L.hosts[0].dev.interfaces.get('eth0').ip, '10.0.0.102',
    'an excluded address is not handed out, even though it is in the range');
}

{
  const L = lab();
  L.cli(L.r, ['enable', 'configure terminal',
    'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'exit', 'end']);
  const mac = L.hosts[0].dev.interfaces.get('eth0').mac;
  addPool(L.cli, L.r, {
    cmds: ['network 10.0.0.0 255.255.255.0', 'range 10.0.0.100 10.0.0.110', 'host 10.0.0.109 ' + mac]
  });
  L.sim.ping(L.hosts[0].dev.id, '10.0.0.1', { count: 1 });
  eq(L.hosts[0].dev.interfaces.get('eth0').ip, '10.0.0.109', 'a reservation gives that MAC its address');
}

// ---------------------------------------------------------------------------
t('The broadcast domain is walked, not assumed');

{
  // Two hosts behind a switch, server on the router: the DISCOVER must cross the bridge.
  const topo = new Topology();
  const r = topo.addDevice(spec('generic-router'));
  const sw = topo.addDevice(spec('generic-switch'));
  const pc = topo.addDevice(spec('generic-pc'));
  r.name = 'R1'; sw.name = 'SW1'; pc.name = 'PC1';
  topo.connect(sw.id, 'Fa0/1', r.id, 'Gi0/0');
  topo.connect(pc.id, 'eth0', sw.id, 'Fa0/2');
  const sim = new Simulator(topo);
  const cli = function (dev, cmds) { return runCommands(dev, topo, sim, cmds).lines; };
  cli(r, ['enable', 'configure terminal', 'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'exit', 'end']);
  addPool(cli, r, { cmds: ['network 10.0.0.0 255.255.255.0', 'range 10.0.0.100 10.0.0.110'] });
  cli(pc, ['enable', 'configure terminal', 'interface eth0', 'ip address dhcp', 'exit']);

  const seg = segment.segmentOf(topo, pc, 'eth0');
  ok(seg.length >= 1, 'the segment walk finds the router through the switch');
  ok(seg.some(function (e) { return e.device.name === 'R1'; }), 'and names it');

  sim.ping(pc.id, '10.0.0.1', { count: 1 });
  eq(pc.interfaces.get('eth0').ip, '10.0.0.100', 'so the host behind the switch gets a lease');
}

{
  // A router is not a bridge: the DISCOVER must stop at it.
  const topo = new Topology();
  const r1 = topo.addDevice(spec('generic-router'));
  const r2 = topo.addDevice(spec('generic-router'));
  const pc = topo.addDevice(spec('generic-pc'));
  r1.name = 'R1'; r2.name = 'R2'; pc.name = 'PC1';
  topo.connect(pc.id, 'eth0', r1.id, 'Gi0/0');
  topo.connect(r1.id, 'Gi0/1', r2.id, 'Gi0/0');
  const sim = new Simulator(topo);
  const cli = function (dev, cmds) { return runCommands(dev, topo, sim, cmds).lines; };
  cli(r2, ['enable', 'configure terminal', 'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'exit', 'end']);
  addPool(cli, r2, { cmds: ['network 10.0.0.0 255.255.255.0', 'range 10.0.0.100 10.0.0.110'] });
  cli(pc, ['enable', 'configure terminal', 'interface eth0', 'ip address dhcp', 'exit']);

  const seg = segment.segmentOf(topo, pc, 'eth0');
  ok(!seg.some(function (e) { return e.device.name === 'R2'; }),
    'a server beyond a router is not in the broadcast domain (no relay modelled)');
  const res = sim.ping(pc.id, '10.0.0.1', { count: 1 });
  const fail = res.events.filter(function (e) { return e.type === 'dhcp' && e.phase === 'failed'; })[0];
  ok(!!fail, 'and the host reports failure rather than inventing a lease');
  eq(fail.reason, 'no-server', 'with "no server in this broadcast domain"');
}

// ---------------------------------------------------------------------------
t('A blocked port passes nothing, and VLANs do not leak');

{
  const topo = new Topology();
  const r = topo.addDevice(spec('generic-router'));
  const sw = topo.addDevice(spec('generic-switch'));
  const pc = topo.addDevice(spec('generic-pc'));
  r.name = 'R1'; sw.name = 'SW1'; pc.name = 'PC1';
  topo.connect(sw.id, 'Fa0/1', r.id, 'Gi0/0');
  topo.connect(pc.id, 'eth0', sw.id, 'Fa0/2');
  sw.stp = { blocked: new Set(['Fa0/1']), states: { 'Fa0/1': 'blocking' }, roles: {} };
  const seg = segment.segmentOf(topo, pc, 'eth0');
  ok(!seg.some(function (e) { return e.device.name === 'R1'; }),
    'a spanning-tree blocked uplink does not carry the DISCOVER');

  ok(segment.sameDomain({ vlan: { mode: 'access', accessVlan: 10 } }, { vlan: { mode: 'access', accessVlan: 10 } }),
    'two ports in VLAN 10 are one domain');
  ok(!segment.sameDomain({ vlan: { mode: 'access', accessVlan: 10 } }, { vlan: { mode: 'access', accessVlan: 20 } }),
    'VLAN 10 and VLAN 20 are not');
  ok(segment.sameDomain({ vlan: { mode: 'access', accessVlan: 10 } }, { vlan: { mode: 'trunk', allowedVlans: '10,20' } }),
    'an access port in 10 matches a trunk that allows 10');
  ok(!segment.sameDomain({ vlan: { mode: 'access', accessVlan: 30 } }, { vlan: { mode: 'trunk', allowedVlans: '10-20' } }),
    'and not one that allows only 10-20');
}

// ---------------------------------------------------------------------------
t('A run asked before the exchange finished leaves the host unaddressed');

{
  const L = lab();
  L.cli(L.r, ['enable', 'configure terminal',
    'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'exit', 'end']);
  addPool(L.cli, L.r, { cmds: ['network 10.0.0.0 255.255.255.0', 'range 10.0.0.100 10.0.0.110'] });

  const early = new Simulator(L.topo);
  early.setRunTime(200);            // the exchange takes 1000 ms by default
  const res = early.ping(L.hosts[0].dev.id, '10.0.0.1', { count: 1 });
  eq(L.hosts[0].dev.interfaces.get('eth0').ip, null, 'no lease at t=200 ms');
  eq(res.replies[0].reason, 'converging', 'and the ping explains itself');
  ok(res.replies[0].pending.some(function (p) { return p.process === 'dhcp'; }),
    'naming DHCP as the unfinished process');

  const late = new Simulator(L.topo);
  late.setRunTime(1000);
  late.ping(L.hosts[0].dev.id, '10.0.0.1', { count: 1 });
  eq(L.hosts[0].dev.interfaces.get('eth0').ip, '10.0.0.100', 'at t=1000 ms the lease is there');
}

// ---------------------------------------------------------------------------
t('CLI: the pool sub-mode validates on exit, not on every keystroke');

{
  const L = lab(0);
  // One session: a sub-mode only exists inside the session that entered it.
  const session = L.cli(L.r, ['enable', 'configure terminal', 'ip dhcp pool lan',
    'network 10.0.0.0 255.255.255.0', 'exit']);
  ok(session.some(function (l) { return /Created DHCP pool lan/.test(l); }), 'a pool can be created');
  const typing = session.filter(function (l) { return /E_DHCP_BAD_RANGE/.test(l); });
  eq(typing.length, 1, 'a half-typed pool is only judged once, on the way out');
  ok(session.some(function (l) { return /rangeStart and rangeEnd/.test(l); }),
    'with the library\'s own message, not a second opinion');

  const bad = L.cli(L.r, ['enable', 'configure terminal', 'ip dhcp pool bad!name']);
  ok(bad.some(function (l) { return /Invalid pool name/.test(l); }), 'an invalid pool name is refused');
  const missing = L.cli(L.r, ['enable', 'configure terminal', 'ip dhcp pool']);
  ok(missing.some(function (l) { return /Incomplete command/.test(l); }), 'and a missing name too');
}

// ---------------------------------------------------------------------------
t('A saved lab keeps its pools');

{
  const L = lab(1);
  addPool(L.cli, L.r, {
    cmds: ['network 10.0.0.0 255.255.255.0', 'default-router 10.0.0.1',
      'range 10.0.0.100 10.0.0.110', 'lease 0 12 0']
  });
  const json = JSON.parse(JSON.stringify(L.topo.serialize()));
  ok(Array.isArray(json.devices[0].config.dhcpPools) && json.devices[0].config.dhcpPools.length === 1,
    'the pool is in the serialised topology');
  const back = Topology.fromJSON(json);
  const pools = back.getDevice(L.r.id).config.dhcpPools;
  eq(pools.length, 1, 'and it comes back on load');
  eq(pools[0].name, 'lan', 'with its name');
  eq(pools[0].leaseSec, '43200', 'and its lease');
  ok(JSON.stringify(back.serialize()) === JSON.stringify(json), 'the round trip is stable');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
