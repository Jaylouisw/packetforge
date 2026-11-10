'use strict';
// acl-data.test.js -- access lists must actually filter the simulated data path.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(v, m) {
  const s = catalog.find(function (x) { return x.vendor === v && x.model === m; });
  if (!s) throw new Error('spec not found: ' + v + '/' + m);
  return s;
}
function allUp(replies) { return replies.every(function (x) { return x.success; }); }
function allDown(replies) { return replies.every(function (x) { return !x.success; }); }

// PC1 -- router -- PC2, two subnets.
function build() {
  const t = new Topology();
  const pc1 = t.addDevice(spec('generic', 'generic-pc'));
  const pc2 = t.addDevice(spec('generic', 'generic-pc'));
  const r1 = t.addDevice(spec('generic', 'generic-router'));
  t.connect(pc1.id, 'eth0', r1.id, 'Gi0/0');
  t.connect(pc2.id, 'eth0', r1.id, 'Gi0/1');
  const sim = new Simulator(t);
  runCommands(pc1, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.1.10 255.255.255.0', 'exit', 'ip default-gateway 10.0.1.1']);
  runCommands(pc2, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.2.20 255.255.255.0', 'exit', 'ip default-gateway 10.0.2.1']);
  runCommands(r1, t, sim, ['configure terminal',
    'interface Gi0/0', 'ip address 10.0.1.1 255.255.255.0', 'exit',
    'interface Gi0/1', 'ip address 10.0.2.1 255.255.255.0']);
  return { t: t, sim: sim, pc1: pc1, pc2: pc2, r1: r1 };
}

// ---------- A: baseline ----------
console.log('Scenario A: no ACL, traffic flows');
{
  const L = build();
  ok(allUp(L.sim.ping(L.pc1.id, '10.0.2.20', { count: 2 }).replies),
    'ping across the router works before any ACL');
}

// ---------- B: standard ACL on the ingress interface ----------
console.log('\nScenario B: standard ACL denies one host');
{
  const L = build();
  const cfg = runCommands(L.r1, L.t, L.sim, [
    'configure terminal',
    'access-list 10 deny host 10.0.1.10',
    'access-list 10 permit any',
    'interface Gi0/0', 'ip access-group 10 in'
  ]).lines.join('\n');
  ok(/Standard access list 10/.test(cfg), 'CLI accepted the standard ACL entries');
  ok(/access list 10 applied in/.test(cfg), 'CLI bound the ACL to Gi0/0 inbound');

  const blocked = L.sim.ping(L.pc1.id, '10.0.2.20', { count: 2 });
  ok(allDown(blocked.replies), 'ping from the denied host now fails');
  ok(blocked.events.some(function (e) { return e.type === 'acl-deny' && e.dir === 'in'; }),
    'an acl-deny event was recorded inbound');

  // ARP is not an IP packet, so the ACL must not stop address resolution.
  const arpFrames = blocked.events.filter(function (e) {
    return e.type === 'frame' && e.frame && e.frame.etherType === 'arp';
  }).length;
  ok(arpFrames > 0, 'ARP still traverses the interface (ACLs filter IP only)');

  // A standard ACL matches the SOURCE address, so denying 10.0.1.10 inbound on
  // Gi0/0 also blocks that host's echo replies -- the reverse ping fails too.
  ok(allDown(L.sim.ping(L.pc2.id, '10.0.1.10', { count: 2 }).replies),
    'the denied host cannot reply either, so the reverse ping also fails');

  const show = runCommands(L.r1, L.t, L.sim, ['show access-lists']).lines.join('\n');
  ok(/Standard IP access list 10/.test(show), 'show access-lists lists the ACL');
  ok(/deny host 10\.0\.1\.10/.test(show), 'show access-lists renders the entry');
  ok(/applied IN on Gi0\/0/.test(show), 'show access-lists reports the binding');

  const run = runCommands(L.r1, L.t, L.sim, ['show running-config']).lines.join('\n');
  ok(/ip access-group 10 in/.test(run), 'running-config shows the binding');
  ok(/access-list 10 permit any/.test(run), 'running-config shows the ACL entries');

  // Removing the list also clears the binding.
  runCommands(L.r1, L.t, L.sim, ['configure terminal', 'no access-list 10']);
  ok(allUp(L.sim.ping(L.pc1.id, '10.0.2.20', { count: 2 }).replies),
    'traffic flows again after the ACL is removed');
}

// ---------- C: outbound ACL ----------
console.log('\nScenario C: outbound ACL');
{
  const L = build();
  runCommands(L.r1, L.t, L.sim, [
    'configure terminal',
    'access-list 110 deny icmp any host 10.0.2.20',
    'access-list 110 permit ip any any',
    'interface Gi0/1', 'ip access-group 110 out'
  ]);
  const blocked = L.sim.ping(L.pc1.id, '10.0.2.20', { count: 2 });
  ok(allDown(blocked.replies), 'extended ACL out of Gi0/1 blocks the echo');
  ok(blocked.events.some(function (e) { return e.type === 'acl-deny' && e.dir === 'out'; }),
    'an acl-deny event was recorded outbound');
}

// ---------- D: ACL survives save / load ----------
console.log('\nScenario D: ACL persistence');
{
  const L = build();
  runCommands(L.r1, L.t, L.sim, [
    'configure terminal',
    'access-list 10 deny host 10.0.1.10',
    'access-list 10 permit any',
    'interface Gi0/0', 'ip access-group 10 in'
  ]);
  const t2 = Topology.fromJSON(JSON.parse(JSON.stringify(L.t.serialize())));
  const r2 = t2.getDevice(L.r1.id);
  ok(r2.config.acls && r2.config.acls['10'] && r2.config.acls['10'].length === 2,
    'ACL entries restored after load');
  // Bindings are stored under the string key of the list, because a list can be *named*: an ACL
  // called BLOCK has no number to store, and two doors onto the same binding must not disagree
  // about whether it is 10 or "10".
  ok(r2.aclBindings && r2.aclBindings['Gi0/0'] && String(r2.aclBindings['Gi0/0'].in) === '10',
    'ACL binding restored after load');

  const sim2 = new Simulator(t2);
  const pc1b = t2.getDevice(L.pc1.id);
  ok(allDown(sim2.ping(pc1b.id, '10.0.2.20', { count: 2 }).replies),
    'reloaded lab still enforces the ACL');
}

// ---------- E: CLI guard rails ----------
console.log('\nScenario E: CLI validation');
{
  const L = build();
  const bad = runCommands(L.r1, L.t, L.sim, [
    'configure terminal', 'access-list 500 permit ip any any'
  ]).lines.join('\n');
  ok(/Invalid access list number/.test(bad), 'out-of-range ACL number rejected');

  const missing = runCommands(L.r1, L.t, L.sim, [
    'configure terminal', 'interface Gi0/0', 'ip access-group 99 in'
  ]).lines.join('\n');
  ok(/does not exist/.test(missing), 'binding a non-existent ACL is rejected');

  const dir = runCommands(L.r1, L.t, L.sim, [
    'configure terminal', 'access-list 10 permit any',
    'interface Gi0/0', 'ip access-group 10 sideways'
  ]).lines.join('\n');
  ok(/Usage: ip access-group/.test(dir), 'invalid direction rejected');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
