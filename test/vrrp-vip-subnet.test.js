'use strict';
// A virtual gateway address has to be on the wire it is a gateway for (#1245).
//
// `vrrp 42 ip 10.0.0.254` was accepted on an interface addressed 10.9.9.1/24. The router was then elected
// master of that group on its own segment and answered ARP for an address belonging to a network it could
// not reach - so a host on 10.9.9.0/24 pointing at 10.0.0.254 got replies from a box with no route for it,
// and a host on 10.0.0.0/24 got nothing at all. Real gear refuses the line, and the refusal is the reason
// the adjacency rule (a VRRP peer must share the segment) can be tested at all.
//
// Two layers, because a lab can also be restored from a file written before the check existed: the command
// refuses, and the election skips a group it cannot serve.
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
const ROUTER = catalog.filter(function (s) { return /ASR 1001-X/.test(s.model); })[0];
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];
const PC = catalog.filter(function (s) { return s.model === 'generic-pc'; })[0];
const eth = function (d) {
  return [...d.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
};

// One router, one switch, one host, all on 10.9.9.0/24. The router is asked to be the gateway for
// 10.0.0.254, a network it knows nothing about.
function lab() {
  const t = new Topology();
  const r1 = t.addDevice(ROUTER, 'r1');
  const sw = t.addDevice(SWITCH, 'sw');
  const pc = t.addDevice(PC, 'pc');
  t.connect('r1', eth(r1)[0].name, 'sw', 'Fa0/1');
  t.connect('pc', 'eth0', 'sw', 'Fa0/2');
  const sim = new Simulator(t);
  runCommands(r1, t, sim, ['configure terminal', 'interface ' + eth(r1)[0].name,
    'ip address 10.9.9.1 255.255.255.0', 'end']);
  runCommands(pc, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.9.9.50 255.255.255.0', 'ip default-gateway 10.0.0.254', 'end']);
  return { t: t, sim: sim, r1: r1, pc: pc, port: eth(r1)[0] };
}

function configOn(env, lines) {
  const cli = new CliSession(env.r1, env.t, env.sim);
  const out = [];
  const all = ['configure terminal', 'interface ' + env.port.name].concat(lines);
  for (const c of all) {
    const r = cli.run(c);
    for (const l of ((r && r.output) || [])) out.push(String(l));
  }
  return out;
}

console.log('');
console.log('An address outside the interface subnet is refused:');
{
  const env = lab();
  const out = configOn(env, ['vrrp 42 ip 10.0.0.254']);
  const refusal = out.filter(function (l) { return /^%/.test(l); })[0] || '';
  ok(!!refusal, 'the command is refused', JSON.stringify(out));
  ok(/10\.0\.0\.254/.test(refusal), 'naming the address', refusal);
  ok(/not in the subnet/.test(refusal), 'saying why', refusal);
  ok(/Gi0/.test(refusal), 'and naming the interface', refusal);
  ok(/10\.9\.9\.1\/24/.test(refusal), 'with the subnet it should have been in', refusal);
  ok(Array.isArray(env.r1.config.vrrp) && env.r1.config.vrrp.length === 0,
    'and no half-built group is left behind', JSON.stringify(env.r1.config.vrrp));
}

console.log('');
console.log('An interface with no address cannot host a group:');
{
  const env = lab();
  const spare = eth(env.r1)[1];
  const cli = new CliSession(env.r1, env.t, env.sim);
  cli.run('configure terminal');
  cli.run('interface ' + spare.name);
  const out = ((cli.run('vrrp 42 ip 10.9.9.254').output) || []).map(String).join(' | ');
  ok(/^%/.test(out), 'the command is refused', out);
  ok(/no address/i.test(out), 'because the interface has none', out);
  ok((env.r1.config.vrrp || []).length === 0, 'and no group is created',
    JSON.stringify(env.r1.config.vrrp));
}

console.log('');
console.log('The same command inside the subnet is accepted:');
{
  const env = lab();
  const out = configOn(env, ['vrrp 42 ip 10.9.9.254', 'vrrp 42 priority 120']);
  ok(!out.some(function (l) { return /not in the subnet/.test(l); }), 'with no complaint', out.join(' | '));
  const groups = env.r1.config.vrrp || [];
  ok(groups.length === 1 && groups[0].ips[0] === '10.9.9.254', 'and the group exists',
    JSON.stringify(groups));
  ok(groups[0] && groups[0].priority === 120, 'with its priority', JSON.stringify(groups[0]));

  env.sim.computeVrrp();
  ok((env.r1.vrrpClaims || []).length === 1, 'and the election hands it the address',
    JSON.stringify(env.r1.vrrpClaims));
}

console.log('');
console.log('A restored group that could not be served does not take part:');
{
  // What a topology file written before the check can still contain.
  const env = lab();
  env.r1.config.vrrp = [{
    vrid: 43, interface: env.port.name, ips: ['10.5.5.254'],
    priority: 200, preempt: true, advertSec: 1
  }];
  env.sim.computeVrrp();

  ok((env.r1.vrrpClaims || []).length === 0, 'the router does not claim the address',
    JSON.stringify(env.r1.vrrpClaims));
  ok(env.sim.vrrpFor('r1').length === 0, 'and no verdict is recorded for the group',
    JSON.stringify(env.sim.vrrpFor('r1')));

  const lines = ((new CliSession(env.r1, env.t, env.sim).run('show vrrp').output) || []).map(String);
  const row = lines.filter(function (l) {
    const f = l.trim().split(/\s+/);
    return f[1] === '43';
  })[0] || '';
  ok(/\bInit\b/.test(row), 'show vrrp reports it as Init, not Backup', row);
  ok(lines.some(function (l) { return /cannot take part/.test(l); }),
    'and explains that the address is on another subnet', lines.join(' | '));

  // The point of all this: a host whose gateway is 10.0.0.254 gets nothing from a router on 10.9.9.0/24.
  const res = env.sim.ping('pc', '10.0.0.254', { count: 2 });
  ok(res.replies.every(function (r) { return !r.success; }),
    'and nothing answers for that address on this wire',
    JSON.stringify(res.replies.map(function (r) { return r.success; })));
}

console.log('');
console.log('Two segments, one master each, and nobody serves the other wire:');
{
  // Same VRID and the same virtual address on two separate segments. Each segment elects its own master,
  // and each master answers only on its own wire - which is the adjacency rule, testable now that a group
  // cannot be configured off-subnet to win a one-member election elsewhere.
  const t = new Topology();
  const a = t.addDevice(ROUTER, 'a');
  const b = t.addDevice(ROUTER, 'b');
  const sw1 = t.addDevice(SWITCH, 'sw1');
  const sw2 = t.addDevice(SWITCH, 'sw2');
  const host1 = t.addDevice(PC, 'h1');
  const host2 = t.addDevice(PC, 'h2');
  t.connect('a', eth(a)[0].name, 'sw1', 'Fa0/1');
  t.connect('h1', 'eth0', 'sw1', 'Fa0/2');
  t.connect('b', eth(b)[0].name, 'sw2', 'Fa0/1');
  t.connect('h2', 'eth0', 'sw2', 'Fa0/2');
  const sim = new Simulator(t);
  runCommands(a, t, sim, ['configure terminal', 'interface ' + eth(a)[0].name,
    'ip address 10.0.0.1 255.255.255.0', 'vrrp 7 ip 10.0.0.254', 'end']);
  runCommands(b, t, sim, ['configure terminal', 'interface ' + eth(b)[0].name,
    'ip address 10.0.0.2 255.255.255.0', 'vrrp 7 ip 10.0.0.254', 'end']);
  runCommands(host1, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.0.10 255.255.255.0', 'ip default-gateway 10.0.0.254', 'end']);
  runCommands(host2, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.0.20 255.255.255.0', 'ip default-gateway 10.0.0.254', 'end']);
  sim.computeVrrp();

  ok((a.vrrpClaims || []).length === 1, 'segment A has a master', JSON.stringify(a.vrrpClaims));
  ok((b.vrrpClaims || []).length === 1, 'segment B has its own master', JSON.stringify(b.vrrpClaims));
  ok(sim.vrrpFor('a').length === 1 && sim.vrrpFor('b').length === 1,
    'each with one verdict recorded',
    JSON.stringify({ a: sim.vrrpFor('a').length, b: sim.vrrpFor('b').length }));
  ok(sim.vrrpFor('a')[0].segment.join(',') !== sim.vrrpFor('b')[0].segment.join(','),
    'and they are not peers of one another',
    JSON.stringify({ a: sim.vrrpFor('a')[0].segment, b: sim.vrrpFor('b')[0].segment }));

  const p1 = sim.ping('h1', '10.0.0.254', { count: 2 });
  const p2 = sim.ping('h2', '10.0.0.254', { count: 2 });
  ok(p1.replies.every(function (r) { return r.success; }), 'the address answers on segment A');
  ok(p2.replies.every(function (r) { return r.success; }), 'and on segment B, from its own master');

  // A host on A must not be served by B: the two segments are not bridged, so the only master it can see is
  // its own. The claims prove it - each master claimed on the port facing its own wire.
  ok(a.vrrpClaims[0].iface === eth(a)[0].name && b.vrrpClaims[0].iface === eth(b)[0].name,
    'each master claimed on the port facing its own segment',
    JSON.stringify({ a: a.vrrpClaims[0].iface, b: b.vrrpClaims[0].iface }));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
