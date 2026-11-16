'use strict';
// acl-vlan-interface.test.js -- an access list bound to a VLAN interface is evaluated (#1517).
//
// `interface Gi0/0.10` + `encapsulation dot1q 10` is this console's VLAN interface: the interface the
// box terminates and routes VLAN 10 at. `ip access-group 101 in` was accepted there, `running-config`
// printed it back, and the forwarding path only ever asked the *physical* port - so the list was
// respected by every surface an operator reads and evaluated by nothing at all.
//
// That is the failure mode that matters most, because it fails open: a lab that binds a policy to a
// VLAN interface and then checks that the VLAN is isolated passes while the isolation does nothing.
// These tests pin both directions on the subinterface, and pin that the new check does not leak into
// the other VLAN or turn a permit into a deny.
//
// The topology is router-on-a-stick, the shape this feature exists for:
//
//   PC1 (vlan 10)  --\
//                      SW1 -- trunk -- R1  Gi0/0.10 10.10.10.1/24
//   PC2 (vlan 20)  --/                   Gi0/0.20 10.20.20.1/24
const path = require('path');
const { Topology, Simulator, CliSession, runCommands, flow } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const ROOT = path.join(__dirname, '..');
const catalog = loadCatalog(path.join(ROOT, 'devices'));
function spec(v, m) {
  const s = catalog.find(function (x) { return x.vendor === v && x.model === m; });
  if (!s) throw new Error('missing spec ' + v + '/' + m);
  return s;
}
function cfg(dev, t, sim, lines) { return runCommands(dev, t, sim, ['configure terminal'].concat(lines)); }

function aclEntry(acl, action) {
  return {
    sequence: null, acl: acl, kind: 'extended', action: action, protocol: 'ip',
    source: { ip: '0.0.0.0', wildcard: '255.255.255.255', any: true, host: false },
    destination: { ip: '0.0.0.0', wildcard: '255.255.255.255', any: true, host: false },
    port: null, log: false
  };
}

function lab() {
  const t = new Topology();
  const pc1 = t.addDevice(spec('generic', 'generic-pc')); pc1.name = 'PC1';
  const pc2 = t.addDevice(spec('generic', 'generic-pc')); pc2.name = 'PC2';
  const r1 = t.addDevice(spec('generic', 'generic-router')); r1.name = 'R1';
  const sw = t.addDevice(spec('generic', 'generic-switch')); sw.name = 'SW1';
  const rp = Array.from(r1.interfaces.values())[0].name;
  t.connect(pc1.id, 'eth0', sw.id, 'Fa0/1');
  t.connect(pc2.id, 'eth0', sw.id, 'Fa0/2');
  t.connect(r1.id, rp, sw.id, 'Fa0/3');
  if (!t.flowState) t.flowState = flow.createFlowState();
  const sim = new Simulator(t, { flowState: t.flowState });
  cfg(sw, t, sim, ['interface Fa0/1', 'switchport mode access', 'switchport access vlan 10',
    'interface Fa0/2', 'switchport mode access', 'switchport access vlan 20',
    'interface Fa0/3', 'switchport mode trunk', 'switchport trunk allowed vlan 10,20', 'end']);
  cfg(r1, t, sim, ['interface ' + rp + '.10', 'encapsulation dot1q 10', 'ip address 10.10.10.1 255.255.255.0',
    'interface ' + rp + '.20', 'encapsulation dot1q 20', 'ip address 10.20.20.1 255.255.255.0', 'end']);
  cfg(pc1, t, sim, ['interface eth0', 'ip address 10.10.10.10 255.255.255.0',
    'ip default-gateway 10.10.10.1', 'end']);
  cfg(pc2, t, sim, ['interface eth0', 'ip address 10.20.20.10 255.255.255.0',
    'ip default-gateway 10.20.20.1', 'end']);
  return { t: t, pc1: pc1, pc2: pc2, r1: r1, sw: sw, rp: rp, sim: sim };
}

// A deny list on a VLAN interface, bound after the lab is built, and a simulator that has not been
// asked anything yet - so the ping below is the only thing that could have produced a verdict.
function denyOn(env, dir, aclNum) {
  env.r1.config.acls = env.r1.config.acls || {};
  env.r1.config.acls[String(aclNum)] = [aclEntry(aclNum, 'deny')];
  cfg(env.r1, env.t, env.sim, ['interface ' + env.rp + '.' + (dir === 'in' ? 10 : 20),
    'ip access-group ' + aclNum + ' ' + dir, 'end']);
  env.sim = new Simulator(env.t, { flowState: env.t.flowState });
  return env;
}

function denies(env) {
  return env.sim.events.filter(function (e) { return e.type === 'acl-deny'; });
}

// ---------------------------------------------------------------------------
// 1. The lab itself
// ---------------------------------------------------------------------------
console.log('Router-on-a-stick: two VLAN interfaces on one trunk port');
{
  const env = lab();
  const subs = env.r1.subinterfacesOf(env.rp);
  ok(subs.length === 2, 'the router has two subinterfaces on ' + env.rp, String(subs.length));
  ok(subs.some(function (s) { return s.name === env.rp + '.10' && Number(s.encapVid) === 10; }),
    'one of them is ' + env.rp + '.10 for VLAN 10');
  const p = env.sim.ping(env.pc1.id, '10.20.20.10', { count: 1 });
  ok(p.success === true, 'and VLAN 10 reaches VLAN 20 through it with no policy in place');
}

// ---------------------------------------------------------------------------
// 2. `in` on the VLAN interface
// ---------------------------------------------------------------------------
console.log('');
console.log('A deny list bound `in` on the VLAN interface refuses traffic entering that VLAN');
{
  const env = denyOn(lab(), 'in', 101);
  const p = env.sim.ping(env.pc1.id, '10.20.20.10', { count: 1 });
  ok(p.success === false, 'the ping from VLAN 10 to VLAN 20 now fails');
  ok(/ACL 101 denied \(in\)/.test(String((p.replies[0] || {}).reason)),
    'and the reason names the list and the direction', String((p.replies[0] || {}).reason));
  const d = denies(env);
  ok(d.length === 1, 'exactly one acl-deny event was recorded', String(d.length));
  ok(d.length === 1 && d[0].iface === env.rp + '.10',
    'and it is attributed to the VLAN interface, not the physical port',
    d.length ? String(d[0].iface) : 'none');
  ok(d.length === 1 && Number(d[0].acl) === 101, 'the event names list 101',
    d.length ? String(d[0].acl) : 'none');
}

// ---------------------------------------------------------------------------
// 3. A flow, not just a ping
// ---------------------------------------------------------------------------
console.log('');
console.log('A flow is refused by the same list, and says which interface refused it');
{
  const env = denyOn(lab(), 'in', 101);
  const f = env.sim.openFlow({ srcDevice: env.pc1.id, dstIp: '10.20.20.10', dstPort: 80 });
  ok(f.ok === false, 'the flow does not open');
  ok(f.code === 'E_ACL_DENY', 'the code is E_ACL_DENY', String(f.code));
  ok(/101 in /.test(String(f.reason)) && String(f.reason).indexOf(env.rp + '.10') !== -1,
    'the reason names list 101 `in` on ' + env.rp + '.10', String(f.reason));
}

// ---------------------------------------------------------------------------
// 4. `out` on the VLAN interface
// ---------------------------------------------------------------------------
console.log('');
console.log('A deny list bound `out` on the VLAN interface refuses traffic leaving that VLAN');
{
  const env = denyOn(lab(), 'out', 102);
  const p = env.sim.ping(env.pc1.id, '10.20.20.10', { count: 1 });
  ok(p.success === false, 'the ping from VLAN 10 to VLAN 20 fails on the way out');
  ok(/ACL 102 denied \(out\)/.test(String((p.replies[0] || {}).reason)),
    'and the reason names list 102 `out`', String((p.replies[0] || {}).reason));
  const d = denies(env);
  ok(d.length === 1 && d[0].iface === env.rp + '.20',
    'the event is attributed to ' + env.rp + '.20', d.length ? String(d[0].iface) : 'none');
}

// ---------------------------------------------------------------------------
// 5. Scope: the list on one VLAN interface is not a list on the box
// ---------------------------------------------------------------------------
//
// Every conversation with a VLAN 10 host crosses Gi0/0.10 in *both* directions (the request enters,
// the reply enters), so a deny list there is expected to stop that conversation both ways - claiming
// otherwise would be testing a fiction. What must be true is that frames which never enter that VLAN
// interface are untouched: VLAN 20 talking to the router's own VLAN 20 address is a conversation the
// list has no business in.
console.log('');
console.log('The list on VLAN 10 does not police VLAN 20');
{
  const env = denyOn(lab(), 'in', 101);
  const local = env.sim.ping(env.pc2.id, '10.20.20.1', { count: 1 });
  ok(local.success === true, 'VLAN 20 reaching the router on its own VLAN interface still passes');
  ok(denies(env).length === 0, 'and no acl-deny event was recorded for it', String(denies(env).length));

  const env2 = denyOn(lab(), 'in', 101);
  const into = env2.sim.ping(env2.pc1.id, '10.10.10.1', { count: 1 });
  ok(into.success === false, 'while VLAN 10 reaching the router on *its* interface is refused');
  ok(denies(env2).length === 1 && denies(env2)[0].iface === env2.rp + '.10',
    'and the refusal is attributed to ' + env2.rp + '.10',
    denies(env2).length ? String(denies(env2)[0].iface) : 'none');
}

// ---------------------------------------------------------------------------
// 6. A permit is still a permit
// ---------------------------------------------------------------------------
console.log('');
console.log('A permit list on the VLAN interface does not deny anything');
{
  const env = lab();
  env.r1.config.acls = { 103: [aclEntry(103, 'permit')] };
  cfg(env.r1, env.t, env.sim, ['interface ' + env.rp + '.10', 'ip access-group 103 in', 'end']);
  env.sim = new Simulator(env.t, { flowState: env.t.flowState });
  const p = env.sim.ping(env.pc1.id, '10.20.20.10', { count: 1 });
  ok(p.success === true, 'the ping still succeeds through a permit list');
  ok(denies(env).length === 0, 'and nothing was denied', String(denies(env).length));
}

// ---------------------------------------------------------------------------
// 7. The counters and the config agree with the data path
// ---------------------------------------------------------------------------
console.log('');
console.log('The drop lands on the VLAN interface, and running-config prints the binding inside it');
{
  const env = denyOn(lab(), 'in', 101);
  env.sim.ping(env.pc1.id, '10.20.20.10', { count: 1 });
  const session = new CliSession(env.r1, env.t, env.sim);
  const lines = (session.run('show interfaces ' + env.rp + '.10').output || []).map(String);
  const text = lines.join('\n');
  ok(/1 drops? \("ACL 101 denied \(in\)"/.test(text),
    '`show interfaces ' + env.rp + '.10` counts the drop',
    lines.filter(function (l) { return /drop/.test(l); }).join(' | '));

  const rc = (session.run('show running-config').output || []).map(String);
  const at = rc.indexOf('interface ' + env.rp + '.10');
  ok(at !== -1, 'running-config has a block for ' + env.rp + '.10', String(at));
  const block = at === -1 ? [] : rc.slice(at + 1, at + 6);
  ok(block.some(function (l) { return l.trim() === 'ip access-group 101 in'; }),
    'and the binding is printed inside that block', block.join(' | '));
}

// ---------------------------------------------------------------------------
// 8. No regression: a list on the physical port still applies
// ---------------------------------------------------------------------------
console.log('');
console.log('A list bound to the physical port still refuses what it refuses');
{
  const env = lab();
  env.r1.config.acls = { 104: [aclEntry(104, 'deny')] };
  cfg(env.r1, env.t, env.sim, ['interface ' + env.rp, 'ip access-group 104 in', 'end']);
  env.sim = new Simulator(env.t, { flowState: env.t.flowState });
  const p = env.sim.ping(env.pc1.id, '10.20.20.10', { count: 1 });
  ok(p.success === false, 'the ping fails with the list on ' + env.rp);
  const d = denies(env);
  ok(d.length === 1 && d[0].iface === env.rp, 'and the drop is attributed to the port itself',
    d.length ? String(d[0].iface) : 'none');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
