'use strict';
// Proves OSPF is wired into the forwarding path, not just unit-tested.
// Three routers in a line with NO static routes: the far subnet is only
// reachable once OSPF installs a route for it.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('  \u2713 ' + msg); } else { failed++; console.error('  \u2717 ' + msg); } }

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(vendor, model) {
  const s = catalog.find(function (x) { return x.vendor === vendor && x.model === model; });
  if (!s) throw new Error('missing spec ' + vendor + '/' + model);
  return s;
}

// Small wrapper: run CLI commands on a device and return the output lines.
// Each runCommands() call starts a fresh session in EXEC mode, so config
// commands need 'configure terminal' first (exec=true skips it for show ops).
function cli(dev, cmds, exec) {
  const pre = exec ? ['enable'] : ['enable', 'configure terminal'];
  return runCommands(dev, t, null, pre.concat(cmds)).lines;
}

const t = new Topology();
const r1 = t.addDevice(spec('generic', 'generic-router'));
const r2 = t.addDevice(spec('generic', 'generic-router'));
const r3 = t.addDevice(spec('generic', 'generic-router'));
const pc1 = t.addDevice(spec('generic', 'generic-pc'));
const pc2 = t.addDevice(spec('generic', 'generic-pc'));
r1.name = 'R1'; r2.name = 'R2'; r3.name = 'R3';
pc1.name = 'PC1'; pc2.name = 'PC2';

t.connect(pc1.id, 'eth0', r1.id, 'Gi0/0');
t.connect(r1.id, 'Gi0/1', r2.id, 'Gi0/0');
t.connect(r2.id, 'Gi0/1', r3.id, 'Gi0/0');
t.connect(r3.id, 'Gi0/1', pc2.id, 'eth0');

// --- addressing only; deliberately no static routes anywhere ---
cli(pc1, ['interface eth0', 'ip address 10.0.1.10 255.255.255.0', 'exit',
  'ip default-gateway 10.0.1.1']);
cli(pc2, ['interface eth0', 'ip address 10.0.3.10 255.255.255.0', 'exit',
  'ip default-gateway 10.0.3.1']);
cli(r1, ['interface Gi0/0', 'ip address 10.0.1.1 255.255.255.0', 'exit',
  'interface Gi0/1', 'ip address 10.0.12.1 255.255.255.0', 'exit']);
cli(r2, ['interface Gi0/0', 'ip address 10.0.12.2 255.255.255.0', 'exit',
  'interface Gi0/1', 'ip address 10.0.23.2 255.255.255.0', 'exit']);
cli(r3, ['interface Gi0/0', 'ip address 10.0.23.3 255.255.255.0', 'exit',
  'interface Gi0/1', 'ip address 10.0.3.1 255.255.255.0', 'exit']);

console.log('Without OSPF (no static routes, so no path to 10.0.3.0/24):');
let sim = new Simulator(t);
let res = sim.ping(pc1.id, '10.0.3.10', { count: 1 });
ok(!res.replies[0].success, 'ping PC1 -> PC2 fails before OSPF is configured');
ok(r1.ospfRoutes.length === 0, 'R1 has no OSPF routes yet');
ok(r1.routeTo('10.0.3.10') === null, 'R1 cannot resolve a route to 10.0.3.10 yet');

console.log('\nEnabling OSPF through the CLI:');
const out1 = cli(r1, ['enable', 'configure terminal', 'ospf router-id 1.1.1.1']);
ok(/OSPF enabled, router-id 1\.1\.1\.1/.test(out1.join(' ')), 'R1 CLI accepts "ospf router-id 1.1.1.1"');
ok(r1.config.ospf && r1.config.ospf.routerId === '1.1.1.1', 'router-id stored in device config');
cli(r2, ['enable', 'configure terminal', 'ospf router-id 2.2.2.2']);
cli(r3, ['enable', 'configure terminal', 'ospf router-id 3.3.3.3']);
ok(r2.config.ospf.routerId === '2.2.2.2' && r3.config.ospf.routerId === '3.3.3.3', 'R2 and R3 enabled');

sim = new Simulator(t);
sim.computeOspf();
ok(r1.ospfRoutes.length > 0, 'R1 learned ' + r1.ospfRoutes.length + ' OSPF route(s)');
const far = r1.ospfRoutes.find(function (r) { return r.dest === '10.0.3.0'; });
ok(!!far, 'R1 learned the far subnet 10.0.3.0/24');
ok(far && far.nextHop === '10.0.12.2', 'next hop is the adjacent R2 interface (10.0.12.2)');
ok(far && far.iface === 'Gi0/1', 'egress interface is Gi0/1');
ok(far && far.cost > 0, 'route carries a path cost (' + (far && far.cost) + ')');

const r2Route = r2.ospfRoutes.find(function (r) { return r.dest === '10.0.3.0'; });
ok(!!r2Route, 'R2 learned 10.0.3.0/24 directly');
ok(r2Route && r2Route.iface === 'Gi0/1', 'R2 reaches it out Gi0/1');

console.log('\nRoute table shows the OSPF routes:');
const rt = cli(r1, ['show ip route'], true).join('\n');
ok(/\bO\b/.test(rt), '"show ip route" includes code O rows');
ok(rt.indexOf('10.0.3.0') !== -1, 'route table lists 10.0.3.0');

console.log('\nForwarding with OSPF installed:');
res = sim.ping(pc1.id, '10.0.3.10', { count: 2 });
ok(res.replies.every(function (r) { return r.success; }), 'ping PC1 -> PC2 now succeeds over 3 routers');
ok(res.events.length > 0, 'the run produced ' + res.events.length + ' events');

// The route must be the thing carrying the packet, not a fluke of ARP flooding:
// removing OSPF from the middle router must break it again.
console.log('\nWithdrawing OSPF on R2:');
cli(r2, ['enable', 'configure terminal', 'no ospf']);
ok(r2.config.ospf === null, 'R2 OSPF config cleared by "no ospf"');
sim = new Simulator(t);
sim.computeOspf();
ok(!r1.ospfRoutes.some(function (r) { return r.dest === '10.0.3.0'; }),
  'R1 withdraws the 10.0.3.0 route once R2 stops speaking OSPF');
res = sim.ping(pc1.id, '10.0.3.10', { count: 1 });
ok(!res.replies[0].success, 'ping fails again after the route is withdrawn');

console.log('\nInterface cost and passive interfaces:');
cli(r2, ['enable', 'configure terminal', 'ospf router-id 2.2.2.2']);
const cout = cli(r2, ['interface Gi0/0', 'ip ospf cost 500']);
ok(/OSPF cost 500 on Gi0\/0/.test(cout.join(' ')), 'CLI accepts "ip ospf cost 500"');
sim = new Simulator(t);
sim.computeOspf();
const viaExpensive = r3.ospfRoutes.find(function (r) { return r.dest === '10.0.1.0'; });
ok(!!viaExpensive, 'R3 still reaches 10.0.1.0/24 over the expensive link');
ok(viaExpensive && viaExpensive.cost >= 500, 'R3 path cost reflects R2 Gi0/0 cost (' + (viaExpensive && viaExpensive.cost) + ')');

const pout = cli(r2, ['interface Gi0/1', 'ip ospf passive']);
ok(/OSPF passive on Gi0\/1/.test(pout.join(' ')), 'CLI accepts "ip ospf passive"');
sim = new Simulator(t);
sim.computeOspf();
ok(!r3.ospfRoutes.some(function (r) { return r.dest === '10.0.1.0'; }),
  'a passive interface forms no adjacency, so R3 loses the 10.0.1.0 route');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
