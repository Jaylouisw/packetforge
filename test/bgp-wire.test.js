'use strict';
// Proves BGP is wired into the forwarding path: three routers in three
// different ASes, NO static routes and NO OSPF. The far subnet is only
// reachable once BGP sessions form and routes are installed.
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

const t = new Topology();
function cli(dev, cmds, exec) {
  const pre = exec ? ['enable'] : ['enable', 'configure terminal'];
  return runCommands(dev, t, null, pre.concat(cmds)).lines;
}

const r1 = t.addDevice(spec('generic', 'generic-router'));
const r2 = t.addDevice(spec('generic', 'generic-router'));
const r3 = t.addDevice(spec('generic', 'generic-router'));
const pc1 = t.addDevice(spec('generic', 'generic-pc'));
const pc2 = t.addDevice(spec('generic', 'generic-pc'));
r1.name = 'R1'; r2.name = 'R2'; r3.name = 'R3'; pc1.name = 'PC1'; pc2.name = 'PC2';

t.connect(pc1.id, 'eth0', r1.id, 'Gi0/0');
t.connect(r1.id, 'Gi0/1', r2.id, 'Gi0/0');
t.connect(r2.id, 'Gi0/1', r3.id, 'Gi0/0');
t.connect(r3.id, 'Gi0/1', pc2.id, 'eth0');

// Addressing only -- no static routes anywhere.
cli(pc1, ['interface eth0', 'ip address 10.0.1.10 255.255.255.0', 'exit', 'ip default-gateway 10.0.1.1']);
cli(pc2, ['interface eth0', 'ip address 10.0.3.10 255.255.255.0', 'exit', 'ip default-gateway 10.0.3.1']);
cli(r1, ['interface Gi0/0', 'ip address 10.0.1.1 255.255.255.0', 'exit',
  'interface Gi0/1', 'ip address 10.0.12.1 255.255.255.0', 'exit']);
cli(r2, ['interface Gi0/0', 'ip address 10.0.12.2 255.255.255.0', 'exit',
  'interface Gi0/1', 'ip address 10.0.23.2 255.255.255.0', 'exit']);
cli(r3, ['interface Gi0/0', 'ip address 10.0.23.3 255.255.255.0', 'exit',
  'interface Gi0/1', 'ip address 10.0.3.1 255.255.255.0', 'exit']);

console.log('Before BGP:');
let sim = new Simulator(t);
let res = sim.ping(pc1.id, '10.0.3.10', { count: 1 });
ok(!res.replies[0].success, 'ping PC1 -> PC2 fails with no routing protocol');
ok(r1.bgpRoutes.length === 0, 'R1 has no BGP routes');

console.log('\nPeering built through the CLI:');
const o1 = cli(r1, ['router bgp 65001']);
ok(/BGP enabled, local AS 65001/.test(o1.join(' ')), 'CLI accepts "router bgp 65001"');
ok(r1.config.bgp && r1.config.bgp.as === 65001, 'local AS stored');
const o2 = cli(r1, ['router bgp 65001', 'neighbor 10.0.12.2 remote-as 65002']);
ok(/BGP neighbor 10\.0\.12\.2 remote-as 65002/.test(o2.join(' ')), 'CLI adds a neighbour');
const o3 = cli(r1, ['router bgp 65001', 'neighbor 10.0.12.2 remote-as 70000']);
ok(r1.config.bgp.neighbors.length === 1, 're-declaring a neighbour updates it rather than duplicating');
ok(r1.config.bgp.neighbors[0].remoteAs === 70000, 'remote-as was updated');
const o4 = cli(r1, ['router bgp 65001', 'bgp router-id 1.1.1.1']);
ok(/BGP router-id 1\.1\.1\.1/.test(o4.join(' ')), 'CLI accepts "bgp router-id"');

// Now build the real peering.
cli(r1, ['router bgp 65001', 'neighbor 10.0.12.2 remote-as 65002']);
cli(r2, ['router bgp 65002', 'neighbor 10.0.12.1 remote-as 65001', 'neighbor 10.0.23.3 remote-as 65003']);
cli(r3, ['router bgp 65003', 'neighbor 10.0.23.2 remote-as 65002']);

sim = new Simulator(t);
sim.computeBgp();
ok(sim.bgpSessions === 2, 'two eBGP sessions formed (got ' + sim.bgpSessions + ')');

const far = r1.bgpRoutes.filter(function (r) { return r.dest === '10.0.3.0'; })[0];
ok(!!far, 'R1 learned 10.0.3.0/24 over BGP');
ok(far && far.nextHop === '10.0.12.2', 'next hop is the eBGP peer 10.0.12.2');
ok(far && far.ad === 20, 'route carries eBGP administrative distance 20');
ok(far && far.asPath.join(' ') === '65002 65003', 'AS path is "65002 65003" (got "' + (far && far.asPath.join(' ')) + '")');
ok(far && far.iface === 'Gi0/1', 'egress interface is Gi0/1');

const mid = r1.bgpRoutes.filter(function (r) { return r.dest === '10.0.23.0'; })[0];
ok(!!mid, 'R1 learned the transit subnet 10.0.23.0/24');
ok(mid && mid.asPath.join(' ') === '65002', 'the transit subnet has a one-AS path');

const back = r3.bgpRoutes.filter(function (r) { return r.dest === '10.0.1.0'; })[0];
ok(!!back, 'R3 learned 10.0.1.0/24 in the other direction');
ok(back && back.asPath.join(' ') === '65002 65001', 'reverse path is "65002 65001"');

console.log('\nForwarding with BGP installed:');
res = sim.ping(pc1.id, '10.0.3.10', { count: 2 });
ok(res.replies.every(function (r) { return r.success; }), 'ping succeeds across three ASes using only BGP');
ok(r1.routeTo('10.0.3.10').type === 'bgp', 'routeTo() reports the route as bgp');

console.log('\nRoute table shows code B:');
const rt = cli(r1, ['show ip route'], true).join('\n');
ok(/\bB\b/.test(rt), '"show ip route" includes code B rows');
ok(rt.indexOf('10.0.3.0') !== -1, 'the learned prefix appears in the table');

console.log('\nAdministrative distance: static (1) beats eBGP (20):');
cli(r1, ['ip route 10.0.3.0 255.255.255.0 192.0.2.99']);
sim = new Simulator(t);
sim.computeBgp();
ok(r1.routeTo('10.0.3.10').type === 'static', 'static route wins over the eBGP route for the same prefix');
ok(r1.bgpRoutes.some(function (r) { return r.dest === '10.0.3.0'; }), 'the BGP route is still present in the RIB, just not preferred');
res = sim.ping(pc1.id, '10.0.3.10', { count: 1 });
ok(!res.replies[0].success, 'the black-hole static route breaks the path, proving it is preferred');
r1.config.routes = [];

console.log('\nA peering needs both sides:');
cli(r3, ['no neighbor 10.0.23.2']);
sim = new Simulator(t);
sim.computeBgp();
ok(sim.bgpSessions === 1, 'removing one side of the peering drops a session (got ' + sim.bgpSessions + ')');
ok(!r1.bgpRoutes.some(function (r) { return r.dest === '10.0.3.0'; }), 'R1 withdraws the far route');
res = sim.ping(pc1.id, '10.0.3.10', { count: 1 });
ok(!res.replies[0].success, 'ping fails once the session is gone');

console.log('\nWithdrawing BGP entirely:');
cli(r3, ['router bgp 65003', 'neighbor 10.0.23.2 remote-as 65002']);
cli(r2, ['no router bgp']);
sim = new Simulator(t);
sim.computeBgp();
ok(r2.config.bgp === null, 'R2 BGP config cleared');
ok(!r1.bgpRoutes.some(function (r) { return r.dest === '10.0.3.0'; }), 'R1 withdraws the route when R2 stops speaking BGP');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
