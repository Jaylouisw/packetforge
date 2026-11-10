'use strict';
// ping-self-and-vrrp.test.js - a box could not ping its own address, and two routers held one group.
//
// Measured before this pass, on a `generic-router` with 10.0.0.1/24 on Gi0/0:
//   R1#ping 10.0.0.1 count 2
//   Sending 2, 100-byte ICMP Echos to 10.0.0.1, timeout is 2 seconds:
//   ..
//   Success rate is 0 percent (0/2)
//
// ...with no drop event anywhere. The echo was routed out of the very port it was addressed to, ARP'd
// for itself and died. Pinging your own new address is the first check after configuring one, and the
// same defect made a VRRP master unable to reach its own virtual address.
//
// The group itself had two masters after a failure, if you asked both boxes:
//   [R1] Gi0/0  1  150  Master  R1  192.168.9.1  00:00:5e:00:01:01   <- cable pulled a moment ago
//   [R2] Gi0/0  1  100  Master  R2  192.168.9.1  00:00:5e:00:01:01
// because the candidate's `up` flag asked only whether the port was enabled and had an address, never
// whether the cable was still in it.
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
  const m = /Success rate is (\d+) percent/.exec((Array.isArray(out) ? out : [out]).join(' '));
  return m ? Number(m[1]) : null;
}
function cli(t, dev, cmds) {
  const s = new CliSession(dev, t, new Simulator(t));
  s.run('enable');
  if (cmds) { s.run('configure terminal'); for (const c of cmds) s.run(c); s.run('end'); }
  return s;
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const ROUTER = catalog.find(function (s) { return s.model === 'generic-router'; });
const SWITCH = catalog.find(function (s) { return s.model === 'generic-switch'; });
const PC = catalog.find(function (s) { return s.model === 'generic-pc'; });

console.log('\nA device answers for an address it holds:');
{
  const t = new Topology();
  const r1 = t.addDevice(ROUTER); r1.name = 'R1';
  const sim = new Simulator(t);
  const s = new CliSession(r1, t, sim);
  s.run('enable');
  s.run('configure terminal', 'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'exit', 'end');
  const out = s.run('ping 10.0.0.1 count 2').output;
  eq(rate(out), 100, 'pinging the router\'s own address answers');
  ok(/Reply from 10\.0\.0\.1: bytes=100 time=/.test(out.join('\n')), 'with a reply line naming it');
  // Nothing crossed a wire, so nothing is counted as traffic. This is what makes it a loopback
  // rather than a packet that happened to come back.
  const counters = s.run('show interfaces counters Gi0/0').output.join('\n');
  ok(/no port has carried a frame/.test(counters), 'and no port counted a frame for it');
  // A second address on another port is answered the same way.
  s.run('configure terminal', 'interface Gi0/1', 'ip address 10.9.9.1 255.255.255.0', 'exit', 'end');
  eq(rate(s.run('ping 10.9.9.1 count 1').output), 100, 'and so is an address on another port');
  // A switch's management SVI is an address it holds, too.
  const t2 = new Topology();
  const sw = t2.addDevice(SWITCH); sw.name = 'SW1';
  const ss = cli(t2, sw, ['interface vlan 1', 'ip address 192.168.1.2 255.255.255.0', 'exit']);
  eq(rate(ss.run('ping 192.168.1.2 count 1').output), 100, 'and a switch answers for its own SVI');
  // ...but a host that does not hold it must not.
  const t3 = new Topology();
  const pc = t3.addDevice(PC); pc.name = 'PC1';
  const sp = cli(t3, pc, ['interface eth0', 'ip address 10.1.1.5 255.255.255.0', 'exit']);
  eq(rate(sp.run('ping 10.1.1.9 count 1').output), 0, 'while an address nobody holds still fails');
}

// The classic pair: PC1 -- SW1 -- (R1, R2), both routers in VRRP group 1 on 192.168.9.1.
function vrrpLab() {
  const t = new Topology();
  const sw = t.addDevice(SWITCH); sw.name = 'SW1';
  const r1 = t.addDevice(ROUTER); r1.name = 'R1';
  const r2 = t.addDevice(ROUTER); r2.name = 'R2';
  const pc = t.addDevice(PC); pc.name = 'PC1';
  const l1 = t.connect(r1.id, 'Gi0/0', sw.id, 'Fa0/1');
  t.connect(r2.id, 'Gi0/0', sw.id, 'Fa0/2');
  t.connect(pc.id, 'eth0', sw.id, 'Fa0/3');
  const sim = new Simulator(t);
  const cfg = function (d, cmds) {
    const s = new CliSession(d, t, sim);
    s.run('enable'); s.run('configure terminal');
    for (const c of cmds) s.run(c);
    s.run('end');
    return s;
  };
  const s1 = cfg(r1, ['interface Gi0/0', 'ip address 192.168.9.2 255.255.255.0',
    'vrrp 1 ip 192.168.9.1', 'vrrp 1 priority 150', 'vrrp 1 preempt', 'exit']);
  const s2 = cfg(r2, ['interface Gi0/0', 'ip address 192.168.9.3 255.255.255.0',
    'vrrp 1 ip 192.168.9.1', 'vrrp 1 priority 100', 'exit']);
  const sp = cfg(pc, ['interface eth0', 'ip address 192.168.9.50 255.255.255.0',
    'ip default-gateway 192.168.9.1', 'exit']);
  return { t: t, sim: sim, sw: sw, r1: r1, r2: r2, pc: pc, s1: s1, s2: s2, sp: sp, link: l1 };
}
function vrrpRow(s) {
  const line = s.run('show vrrp').output.filter(function (l) { return /^Gi0/.test(l); })[0] || '';
  const w = line.trim().split(/\s{2,}/);
  return { state: w[3], master: w[4] };
}

console.log('\nA master answers for its virtual address:');
{
  const env = vrrpLab();
  eq(vrrpRow(env.s1).state, 'Master', 'R1 is master by priority');
  eq(rate(env.s1.run('ping 192.168.9.1 count 2').output), 100,
    'and can ping the group address it holds');
  eq(rate(env.sp.run('ping 192.168.9.1 count 2').output), 100, 'while the PC reaches it through the group');
  // The backup does not hold it, and must not claim it.
  eq(vrrpRow(env.s2).state, 'Backup', 'R2 is backup');
  eq(env.s2.device.vrrpClaimFor('192.168.9.1', 'Gi0/0'), null, 'and holds no claim on the address');
  // The Master column names who holds the group, not who is asking.
  eq(vrrpRow(env.s2).master, 'R1', 'and its table names R1 as the master, not itself');
}

console.log('\nA failed master gives the group up, and says why:');
{
  const env = vrrpLab();
  ok(/is now down/.test(env.s1.run('link down ' + env.link.id).output[0]), 'the cable is pulled');
  eq(vrrpRow(env.s1).state, 'Backup', 'the old master reports Backup');
  eq(vrrpRow(env.s2).state, 'Master', 'and the other router has taken the group');
  eq(rate(env.sp.run('ping 192.168.9.1 count 2').output), 100, 'the virtual address still answers');
  // Exactly one master: the whole point of the group.
  const masters = [vrrpRow(env.s1), vrrpRow(env.s2)].filter(function (r) { return r.state === 'Master'; });
  eq(masters.length, 1, 'and only one router claims mastership');
  ok(/R1: Gi0\/0 has no line, so group 1 moved to R2/.test(env.s1.run('show vrrp').output.join('\n')),
    'the table on the old master names the reason it moved');
  // A shut port is a different reason from a pulled cable, and both are given.
  const env2 = vrrpLab();
  env2.s1.run('configure terminal', 'interface Gi0/0', 'shutdown', 'exit', 'end');
  eq(vrrpRow(env2.s1).state, 'Backup', 'a shut port gives the group up as well');
  ok(/is administratively down/.test(env2.s1.run('show vrrp').output.join('\n')),
    'and the reason says administratively, not a cable');
}

console.log('\n...and takes it back when the line returns:');
{
  const env = vrrpLab();
  env.s1.run('link down ' + env.link.id);
  eq(vrrpRow(env.s2).state, 'Master', 'the group moved to R2');
  env.s1.run('link up ' + env.link.id);
  eq(vrrpRow(env.s1).state, 'Master', 'preemption puts it back on R1, the higher priority');
  eq(vrrpRow(env.s2).state, 'Backup', 'and R2 goes back to backup');
  eq(rate(env.s1.run('ping 192.168.9.1 count 1').output), 100, 'R1 answers for it again');
  eq(rate(env.sp.run('ping 192.168.9.1 count 2').output), 100, 'and the PC never lost its gateway');
}

console.log('\nA group nobody has claimed says so honestly:');
{
  // No simulator: nothing has been elected, and the note must not claim a simulation is running.
  const t = new Topology();
  const r1 = t.addDevice(ROUTER); r1.name = 'R1';
  const s = new CliSession(r1, t, null);
  s.run('enable');
  s.run('configure terminal', 'interface Gi0/0', 'ip address 10.5.5.1 255.255.255.0',
    'vrrp 1 ip 10.5.5.254', 'exit', 'end');
  const out = s.run('show vrrp').output.join('\n');
  ok(/no simulation is attached/.test(out), 'without a simulator it says that, not \"run a simulation\"');
  const env = vrrpLab();
  eq(vrrpRow(env.s1).state, 'Master', 'and with one attached an election runs');
  ok((env.r1.vrrpClaims || []).length > 0, 'so the master holds the claim');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
