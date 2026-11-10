'use strict';
// local-delivery.test.js - a router did not answer for its own addresses unless the packet arrived
// on the port that held them.
//
// Measured before this pass, on R1 --- R2 with R2 holding 10.9.9.2 on Gi0/1:
//   R1#ping 10.9.9.2 count 2
//   ....  Success rate is 0 percent (0/2)
//
// ...and the event log said why, in three steps that each looked correct:
//   route      d2  10.9.9.2 via 10.9.9.2 iface Gi0/1     <- R2 *routed* a packet addressed to itself
//   arp-request d2  Gi0/1 10.9.9.2                        <- and ARP'd for itself on the far port
//   (nothing)                                             <- no drop event: a silent timeout
//
// Two defects, both in the same decision:
//   1. ownsIpOn() compared the address's port with the *ingress* port and refused when they differed,
//      so every router address except the one on the arriving port was somebody else's.
//   2. Having accepted the echo, the reply was sent out of the port that held the address (Gi0/1),
//      which has no cable - into an empty socket. A router sources the reply from the address that
//      was pinged and routes it back.
const path = require('path');
const { Topology, Simulator, CliSession } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + (actual === expected ? '' : ' (got ' + JSON.stringify(actual) + ')'));
}
function rate(out) {
  const m = /Success rate is (\d+) percent/.exec(Array.isArray(out) ? out.join(' ') : String(out));
  return m ? Number(m[1]) : null;
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const ROUTER = catalog.find(function (s) { return s.model === 'generic-router'; });
const PC = catalog.find(function (s) { return s.model === 'generic-pc'; });
const SWITCH = catalog.find(function (s) { return s.model === 'generic-switch'; });

// PC1 -- R1 -- R2, with R2 holding a second subnet on a port of its own (Gi0/1).
function lab() {
  const t = new Topology();
  const r1 = t.addDevice(ROUTER); r1.name = 'R1';
  const r2 = t.addDevice(ROUTER); r2.name = 'R2';
  const pc = t.addDevice(PC); pc.name = 'PC1';
  t.connect(r1.id, 'Gi0/0', r2.id, 'Gi0/0');
  t.connect(pc.id, 'eth0', r1.id, 'Gi0/1');
  const sim = new Simulator(t);
  const cfg = function (d, cmds) {
    const s = new CliSession(d, t, sim);
    s.run('enable'); s.run('configure terminal');
    for (const cmd of cmds) s.run(cmd);
    s.run('end');
    return s;
  };
  cfg(r1, ['interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'exit',
    'interface Gi0/1', 'ip address 192.168.1.1 255.255.255.0', 'exit',
    'ip route 10.9.9.0 255.255.255.0 10.0.0.2']);
  cfg(r2, ['interface Gi0/0', 'ip address 10.0.0.2 255.255.255.0', 'exit',
    'interface Gi0/1', 'ip address 10.9.9.2 255.255.255.0', 'exit',
    'ip route 192.168.1.0 255.255.255.0 10.0.0.1']);
  cfg(pc, ['interface eth0', 'ip address 192.168.1.10 255.255.255.0', 'exit',
    'ip default-gateway 192.168.1.1']);
  return { t: t, r1: r1, r2: r2, pc: pc, sim: sim, cfg: cfg };
}
function console_(env, d) {
  const s = new CliSession(d, env.t, env.sim);
  s.run('enable');
  return s;
}

console.log('\nA router answers for every address it holds:');
{
  const env = lab();
  const s = console_(env, env.r1);
  eq(rate(s.run('ping 10.9.9.2 count 2').output), 100,
    'a ping to R2\'s second address, arriving on R2\'s first port, is answered');
  // The address on the arriving port still works - that was the only case that ever did.
  eq(rate(s.run('ping 10.0.0.2 count 2').output), 100, 'and the address on the ingress port still answers');
  // A host behind R1 reaches the same address: the fix is not an artefact of a router-to-router ping.
  eq(rate(console_(env, env.pc).run('ping 10.9.9.2 count 2').output), 100,
    'and a host two hops away reaches it');
}

console.log('\nThe reply leaves by a port that can carry it:');
{
  const env = lab();
  const s = console_(env, env.r1);
  s.run('ping 10.9.9.2 count 1');
  const echoes = env.sim.events.filter(function (e) { return e.type === 'icmp-echo'; });
  ok(echoes.length === 1, 'the echo is answered by R2 exactly once');
  eq(echoes[0] && echoes[0].iface, 'Gi0/0',
    'and the answer leaves by the port the request arrived on, not the port that holds the address');
  // The empty socket is observable: a reply sent out of Gi0/1 would be counted there.
  const counters = console_(env, env.r2).run('show interfaces counters Gi0/1').output.join('\n');
  ok(/no port has carried a frame/.test(counters),
    'Gi0/1 carried nothing - the reply did not go into an empty socket');
  const leaving = console_(env, env.r2).run('show interfaces counters Gi0/0').output.join('\n');
  ok(/Gi0\/0\s+\d+/.test(leaving), 'while Gi0/0 shows the frames it passed');
}

console.log('\nRole separation still outranks "it is my address":');
{
  // The rule that a WAN port cannot reach a LAN address is deliberate (NAT depends on it), and the
  // new "a router owns all its addresses" check must not have swallowed it.
  const env = lab();
  env.r2.interfaces.get('Gi0/0').role = 'wan';
  env.r2.interfaces.get('Gi0/1').role = 'lan';
  eq(env.r2.ownsIpOn('Gi0/0', '10.9.9.2'), null,
    'a LAN address is not reachable from the WAN port');
  eq(rate(console_(env, env.r1).run('ping 10.9.9.2 count 2').output), 0,
    'so the ping fails, as it should');
  // ...and the reverse direction still works, because LAN-to-WAN is what a router is for.
  env.r2.interfaces.get('Gi0/0').role = 'lan';
  ok(env.r2.ownsIpOn('Gi0/0', '10.9.9.2') !== null, 'and with both ports LAN the address is owned again');
}

console.log('\nA switch\'s management address is unchanged by this:');
{
  // A switch is not L3, so the new check does not apply to it; its SVI is still reachable from any
  // access port in its VLAN, which is the rule that check sits in front of.
  const t = new Topology();
  const sw = t.addDevice(SWITCH); sw.name = 'SW1';
  const pc = t.addDevice(PC); pc.name = 'PC1';
  t.connect(pc.id, 'eth0', sw.id, 'Fa0/1');
  const sim = new Simulator(t);
  const cfg = function (d, cmds) {
    const s = new CliSession(d, t, sim);
    s.run('enable'); s.run('configure terminal');
    for (const cmd of cmds) s.run(cmd);
    s.run('end');
    return s;
  };
  cfg(sw, ['interface vlan 1', 'ip address 192.168.1.2 255.255.255.0', 'exit']);
  cfg(pc, ['interface eth0', 'ip address 192.168.1.10 255.255.255.0', 'exit']);
  const s = new CliSession(pc, t, sim); s.run('enable');
  eq(rate(s.run('ping 192.168.1.2 count 2').output), 100,
    'the SVI answers a host in its VLAN');
  ok(sw.ownsIpOn('Fa0/1', '192.168.1.2') !== null, 'through the VLAN rule, not the L3 one');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
