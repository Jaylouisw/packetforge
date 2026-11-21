#!/usr/bin/env node
'use strict';
// A DHCP pool with a `network` and no `range` serves that subnet (#fidelity: dhcp range optional).
//
// `range` is not a required statement on the box. Every published configuration example is
// `ip dhcp pool` + `network` + options, and the 850/870 capture's own `show ip dhcp pool` prints the subnet
// row `10.10.0.1 - 10.10.0.254` for a pool that never named a range; the SD-WAN capture leases 77 addresses
// from a pool configured the same way (research/dhcp-range-is-optional.md). This console refused the pool
// outright - `both rangeStart and rangeEnd are required` - so the commonest DHCP lab in the world did not
// work. `range` now narrows the subnet; omitting it serves the subnet.
//
// The second half is the address the box answers on: the pool's gateway sits inside the derived range, and
// `poolCapacity()`/`poolSummary()` already treated it as unofferable. The allocator did not, so the first
// client of a plain pool was offered the router's own address.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');
const dhcp = require('../engine/dhcp');
const { CliSession } = require('../engine/cli');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
function eq(got, want, msg) { ok(got === want, msg + ' (got ' + got + ', want ' + want + ')'); }

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
function spec(model) {
  const s = catalog.filter(function (x) { return String(x.model) === model; })[0];
  if (!s) throw new Error('missing spec ' + model);
  return s;
}

// A router with one pool and `hosts` clients on it, all in the pool's subnet.
function lab(poolCmds, hosts) {
  hosts = hosts || 1;
  const topo = new Topology();
  const r = topo.addDevice(spec('generic-router'), 'r1');
  // One switch, so both clients share the subnet the router port is addressed in.
  const sw = topo.addDevice(spec('generic-switch'), 'sw1');
  topo.connect(sw.id, 'Fa0/1', r.id, 'Gi0/0');
  const sim = new Simulator(topo);
  const cli = function (dev, cmds) { return runCommands(dev, topo, sim, cmds).lines; };
  const pcs = [];
  for (let i = 0; i < hosts; i++) {
    const pc = topo.addDevice(spec('generic-pc'), 'pc' + (i + 1));
    topo.connect(pc.id, 'eth0', sw.id, 'Fa0/' + (2 + i));
    cli(pc, ['enable', 'configure terminal', 'interface eth0', 'ip address dhcp', 'exit']);
    pcs.push(pc);
  }
  cli(r, ['enable', 'configure terminal', 'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0',
    'exit', 'end']);
  cli(r, ['enable', 'configure terminal', 'ip dhcp pool lan'].concat(poolCmds).concat(['exit', 'end']));
  return { topo: topo, r: r, sim: sim, cli: cli, pcs: pcs };
}
function show(env, cmd) {
  return ((new CliSession(env.r, env.topo, env.sim).run(cmd).output) || []).map(String);
}

// ---------------------------------------------------------------------------
console.log('The library: a pool with no range is a pool, and it serves its subnet');
{
  const pool = dhcp.normalizePool({ name: 'lan', network: '10.4.5.0', mask: '255.255.255.0',
    gateway: '10.4.5.1' });
  eq(pool.rangeStart, '', 'the spec still holds no range of its own');
  const verdict = dhcp.validatePool(pool);
  ok(verdict.ok, 'and it validates', JSON.stringify(verdict.errors));
  // The gateway is not an address the box may hand out.
  eq(dhcp.poolCapacity(pool), 253, '254 usable addresses in the /24, less the gateway');

  const half = dhcp.validatePool(dhcp.normalizePool({ name: 'half', network: '10.4.5.0',
    mask: '255.255.255.0', rangeStart: '10.4.5.10' }));
  ok(!half.ok && half.errors.some(function (e) { return e.code === 'E_DHCP_BAD_RANGE'; }),
    'one end of a range and not the other is still refused', JSON.stringify(half.errors));

  const narrow = dhcp.normalizePool({ name: 'narrow', network: '10.4.5.0', mask: '255.255.255.0',
    rangeStart: '10.4.5.10', rangeEnd: '10.4.5.20' });
  eq(dhcp.poolCapacity(narrow), 11, 'a configured range is not widened to the subnet');
}

// ---------------------------------------------------------------------------
console.log('');
console.log('A host is served by the SD-WAN guide\'s own pool: network, default-router, dns-server, no range');
{
  const env = lab(['network 10.0.0.0 255.255.255.0', 'default-router 10.0.0.1',
    'dns-server 8.8.8.8'], 2);
  const before = env.pcs[0].interfaces.get('eth0').ip;
  eq(before, null, 'before the run the client has no address');
  const res = env.sim.ping(env.pcs[0].id, '10.0.0.1', { count: 1 });
  const dhcpEvents = res.events.filter(function (e) { return e.type === 'dhcp'; });
  const ack = dhcpEvents.filter(function (e) { return e.phase === 'ack'; })[0];
  ok(!!ack, 'the pool answers a DISCOVER with an ACK', JSON.stringify(dhcpEvents.map(function (e) { return e.phase; })));
  eq(ack && ack.ip, '10.0.0.2', 'with the first address after the gateway, not the gateway');
  eq(env.pcs[0].interfaces.get('eth0').ip, '10.0.0.2', 'and the client holds it');
  eq(env.pcs[0].interfaces.get('eth0').dhcpLease.gateway, '10.0.0.1', 'and was given the default router');

  env.sim.ping(env.pcs[1].id, '10.0.0.1', { count: 1 });
  eq(env.pcs[1].interfaces.get('eth0').ip, '10.0.0.3', 'the second client gets the next address');
}

// ---------------------------------------------------------------------------
console.log('');
console.log('`show ip dhcp pool` prints the subnet row for a pool that never named a range');
{
  const env = lab(['network 10.4.5.0 255.255.255.0', 'default-router 10.4.5.1']);
  const lines = show(env, 'show ip dhcp pool lan');
  const text = lines.join('\n');
  ok(text.indexOf('rangeStart and rangeEnd are required') === -1,
    'the pool is not reported as incomplete', text);
  ok(/10\.4\.5\.1 - 10\.4\.5\.254/.test(text), 'the row spans the usable range of the subnet', text);
  ok(/Total addresses\s+: 254/.test(text), 'total is the subnet, 254');
  ok(/ 0 \/ 1 \/ 254$/.test(text.split('\n').filter(function (l) { return /^ 10\.4\.5\./.test(l); })[0] || ''),
    'leased / excluded / total, with the gateway counted as not offerable',
    lines.join(' | '));
}

// ---------------------------------------------------------------------------
console.log('');
console.log('A configured range still wins, and the gateway is never offered even inside it');
{
  const env = lab(['network 10.0.0.0 255.255.255.0', 'default-router 10.0.0.1',
    'range 10.0.0.1 10.0.0.50']);
  const res = env.sim.ping(env.pcs[0].id, '10.0.0.1', { count: 1 });
  const ack = res.events.filter(function (e) { return e.type === 'dhcp' && e.phase === 'ack'; })[0];
  eq(ack && ack.ip, '10.0.0.2', 'the first lease is the first non-gateway address in the range');
}

// ---------------------------------------------------------------------------
console.log('');
console.log('`no range` returns the pool to its subnet, and the configuration says so');
{
  const env = lab(['network 10.0.0.0 255.255.255.0', 'default-router 10.0.0.1',
    'range 10.0.0.100 10.0.0.110']);
  let cfg = show(env, 'show running-config').join('\n');
  ok(/range 10\.0\.0\.100 10\.0\.0\.110/.test(cfg), 'the range is in the configuration first');
  const out = env.cli(env.r, ['enable', 'configure terminal', 'ip dhcp pool lan', 'no range', 'exit', 'end']);
  ok(out.some(function (l) { return /Range cleared from pool lan/.test(l); }),
    'removing it is a receipt, not an error', JSON.stringify(out));
  cfg = show(env, 'show running-config').join('\n');
  ok(cfg.indexOf('range 10.0.0.100') === -1, 'and the line is gone');
  const view = show(env, 'show ip dhcp pool lan').join('\n');
  ok(/10\.0\.0\.1 - 10\.0\.0\.254/.test(view), 'the pool now serves the whole subnet', view);
  const res = env.sim.ping(env.pcs[0].id, '10.0.0.1', { count: 1 });
  const ack = res.events.filter(function (e) { return e.type === 'dhcp' && e.phase === 'ack'; })[0];
  eq(ack && ack.ip, '10.0.0.2', 'and it answers with the subnet\'s first offerable address');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
