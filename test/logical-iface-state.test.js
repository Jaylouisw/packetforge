'use strict';
// logical-iface-state.test.js - a subinterface reported `up` while its parent was shut.
//
// Measured before this pass, on router-on-a-stick (R1 -- SW1 -- R2, VLAN 10 on Gi0/0.10):
//   R1(config)#interface Gi0/0
//   R1(config-if)#shutdown
//   Gi0/0 administratively down
//   R1#show ip interface brief
//   Interface  IP-Address    OK?  Method  Status                 Protocol
//   Gi0/0      unassigned    YES  manual  administratively down  down
//   Gi0/0.10   10.10.0.1/24  YES  manual  up                     up     <- while this was true:
//   R1#ping 10.10.0.2 count 2
//   Success rate is 0 percent (0/2)
//
// The data path knew (0 percent) and the state column did not - the two-answers-to-one-question
// failure this file exists for. And `show interfaces Gi0/0.10` reported `input : 0 packets` after
// pings that answered 100 percent, so the counters were wrong in the other direction.
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
function briefRow(out, name) {
  const line = out.filter(function (l) { return new RegExp('^' + name.replace(/[.\/]/g, '\\$&') + '\\s').test(l); })[0];
  if (!line) return null;
  const words = line.trim().split(/\s{2,}/);
  return { address: words[1], status: words[words.length - 2], protocol: words[words.length - 1] };
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const ROUTER = catalog.find(function (s) { return s.model === 'generic-router'; });
const SWITCH = catalog.find(function (s) { return s.model === 'generic-switch'; });

// R1 -- SW1 -- R2, both routers tagging VLAN 10 on Gi0/0.10. A second subinterface (.20) is
// configured on R1 so a quiet interface exists to compare counters against.
function lab() {
  const t = new Topology();
  const r1 = t.addDevice(ROUTER); r1.name = 'R1';
  const sw = t.addDevice(SWITCH); sw.name = 'SW1';
  const r2 = t.addDevice(ROUTER); r2.name = 'R2';
  const l1 = t.connect(r1.id, 'Gi0/0', sw.id, 'Fa0/1');
  t.connect(sw.id, 'Fa0/2', r2.id, 'Gi0/0');
  const sim = new Simulator(t);
  const cfg = function (d, cmds) {
    const s = new CliSession(d, t, sim);
    s.run('enable'); s.run('configure terminal');
    for (const cmd of cmds) s.run(cmd);
    s.run('end');
    return s;
  };
  cfg(sw, ['vlan 10', 'interface Fa0/1', 'switchport mode trunk',
    'switchport trunk allowed vlan 10', 'exit',
    'interface Fa0/2', 'switchport mode trunk', 'switchport trunk allowed vlan 10', 'exit']);
  const s1 = cfg(r1, ['interface Gi0/0.10', 'ip address 10.10.0.1 255.255.255.0', 'exit',
    'interface Gi0/0.20', 'ip address 10.20.0.1 255.255.255.0', 'exit']);
  cfg(r2, ['interface Gi0/0.10', 'ip address 10.10.0.2 255.255.255.0', 'exit']);
  return { t: t, r1: r1, r2: r2, sw: sw, sim: sim, s1: s1, link: l1 };
}

console.log('\nA subinterface is up when its parent can carry it:');
{
  const env = lab();
  const row = briefRow(env.s1.run('show ip interface brief').output, 'Gi0/0.10');
  eq(row.status, 'up', 'a healthy subinterface is up');
  eq(row.protocol, 'up', 'with its line up');
  eq(rate(env.s1.run('ping 10.10.0.2 count 2').output), 100, 'and it carries the ping');
}

console.log('\n...and down when the parent is shut, which is what the ping already said:');
{
  const env = lab();
  env.s1.run('configure terminal');
  env.s1.run('interface Gi0/0');
  eq(env.s1.run('shutdown').output[0], 'Gi0/0 administratively down', 'the parent is shut');
  env.s1.run('exit'); env.s1.run('end');
  const row = briefRow(env.s1.run('show ip interface brief').output, 'Gi0/0.10');
  eq(row.status, 'administratively down', 'the subinterface reports the administrator state it inherits');
  eq(row.protocol, 'down', 'and its line is down');
  ok(/line protocol: down \(parent Gi0\/0 is administratively down\)/.test(
    env.s1.run('show interfaces Gi0/0.10').output.join('\n')),
    'show interfaces names the parent and the administrative state');
  eq(rate(env.s1.run('ping 10.10.0.2 count 2').output), 0,
    'which is exactly what the ping to that address answered all along');
  // The parent's own state is unchanged by any of this.
  const parent = briefRow(env.s1.run('show ip interface brief').output, 'Gi0/0');
  eq(parent.status, 'administratively down', 'the parent still reports its own state');
}

console.log('\nRestoring the parent restores the subinterface:');
{
  const env = lab();
  env.s1.run('configure terminal', 'interface Gi0/0', 'shutdown', 'exit', 'end');
  env.s1.run('configure terminal', 'interface Gi0/0', 'no shutdown', 'exit', 'end');
  const row = briefRow(env.s1.run('show ip interface brief').output, 'Gi0/0.10');
  eq(row.status, 'up', 'up again');
  eq(row.protocol, 'up', 'line up again');
  eq(rate(env.s1.run('ping 10.10.0.2 count 2').output), 100, 'and the ping answers again');
}

console.log('\nA pulled cable is a different fact from a shut port:');
{
  const env = lab();
  env.s1.run('enable');
  ok(/is now down/.test(env.s1.run('link down ' + env.link.id).output[0]), 'the cable is pulled');
  const row = briefRow(env.s1.run('show ip interface brief').output, 'Gi0/0.10');
  eq(row.status, 'up', 'the administrator has not shut anything, so Status stays up');
  eq(row.protocol, 'down', 'but the line is down');
  // The wording follows the behaviour: the reason used to say only that the parent had no link, and
  // now carries the parent's own reason after it. What the assertion is about is unchanged - the
  // line is down because of the cable, and nothing here blames the administrator.
  ok(/line protocol: down \(parent Gi0\/0: the cable is down\)/.test(
    env.s1.run('show interfaces Gi0/0.10').output.join('\n')),
    'and the reason is the cable, not the administrator');
  eq(rate(env.s1.run('ping 10.10.0.2 count 2').output), 0, 'and the ping fails');
  env.s1.run('link up ' + env.link.id);
  eq(briefRow(env.s1.run('show ip interface brief').output, 'Gi0/0.10').protocol, 'up',
    'and comes back when the cable does');
}

console.log('\nShutting the subinterface itself leaves the parent alone:');
{
  const env = lab();
  env.s1.run('configure terminal', 'interface Gi0/0.10');
  eq(env.s1.run('shutdown').output[0], 'Gi0/0.10 administratively down', 'the subinterface is shut');
  env.s1.run('exit', 'end');
  eq(briefRow(env.s1.run('show ip interface brief').output, 'Gi0/0.10').status, 'administratively down',
    'and says so');
  eq(briefRow(env.s1.run('show ip interface brief').output, 'Gi0/0').status, 'up',
    'while the parent is untouched');
  eq(rate(env.s1.run('ping 10.10.0.2 count 2').output), 0, 'the ping fails');
}

console.log('\nA subinterface counts the traffic it carried:');
{
  const env = lab();
  env.s1.run('ping 10.10.0.2 count 2');
  const shown = env.s1.run('show interfaces Gi0/0.10').output.join('\n');
  const inPkts = /input : (\d+) packet/.exec(shown);
  const outPkts = /output: (\d+) packet/.exec(shown);
  ok(inPkts && Number(inPkts[1]) > 0, 'input counted the replies (' + (inPkts && inPkts[1]) + ')');
  ok(outPkts && Number(outPkts[1]) > 0, 'output counted the requests (' + (outPkts && outPkts[1]) + ')');
  // The discriminator: Gi0/0.20 is configured but VLAN 20 is not allowed on the trunk, so it must
  // stay at zero. Without this, "counters > 0" could be satisfied by counting the parent's traffic
  // onto every subinterface.
  const quiet = env.s1.run('show interfaces Gi0/0.20').output.join('\n');
  ok(/input : 0 packets/.test(quiet) && /output: 0 packets/.test(quiet),
    'while a subinterface whose VLAN the trunk does not allow stays at zero');
  eq(rate(env.s1.run('ping 10.20.0.2 count 1').output), 0, 'and indeed nothing is carried on it');
}

console.log('\nThe same rule, one interface class over: an SVI:');
{
  // An SVI is up by VLAN membership, and this already worked; the assertion is here so the shared
  // helper cannot regress one class while fixing the other.
  const t = new Topology();
  const sw = t.addDevice(SWITCH); sw.name = 'SW1';
  const pc = t.addDevice(catalog.find(function (s) { return s.model === 'generic-pc'; }));
  pc.name = 'PC1';
  t.connect(pc.id, 'eth0', sw.id, 'Fa0/1');
  const sim = new Simulator(t);
  const cfg = function (d, cmds) {
    const s = new CliSession(d, t, sim);
    s.run('enable'); s.run('configure terminal');
    for (const cmd of cmds) s.run(cmd);
    s.run('end');
    return s;
  };
  const s = cfg(sw, ['interface vlan 1', 'ip address 192.168.1.2 255.255.255.0', 'exit']);
  eq(briefRow(s.run('show ip interface brief').output, 'Vlan1').protocol, 'up', 'the SVI is up');
  cfg(sw, ['interface Fa0/1', 'shutdown', 'exit']);
  eq(briefRow(s.run('show ip interface brief').output, 'Vlan1').protocol, 'down',
    'and goes down with its last member port');
  ok(/no active port in VLAN 1/.test(s.run('show interfaces Vlan1').output.join('\n')),
    'naming the reason');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
