'use strict';
// l3.test.js -- router-on-a-stick: 802.1Q subinterfaces routing between VLANs.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');
const vlan = require('../engine/vlan');
const net = require('../engine/net');

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

// Build the standard router-on-a-stick lab and return the pieces.
function buildLab() {
  const t = new Topology();
  const sw = t.addDevice(spec('generic', 'generic-switch'));
  const r = t.addDevice(spec('generic', 'generic-router'));
  const pc1 = t.addDevice(spec('generic', 'generic-pc'));
  const pc2 = t.addDevice(spec('generic', 'generic-pc'));
  t.connect(pc1.id, 'eth0', sw.id, 'Fa0/1');
  t.connect(pc2.id, 'eth0', sw.id, 'Fa0/2');
  t.connect(sw.id, 'Fa0/8', r.id, 'Gi0/0');

  const sim = new Simulator(t);
  runCommands(sw, t, sim, [
    'configure terminal', 'vlan 10 USERS', 'vlan 20 GUEST',
    'interface Fa0/1', 'switchport mode access', 'switchport access vlan 10', 'exit',
    'interface Fa0/2', 'switchport mode access', 'switchport access vlan 20', 'exit',
    'interface Fa0/8', 'switchport mode trunk', 'switchport trunk allowed vlan 10,20'
  ]);
  const routerOut = runCommands(r, t, sim, [
    'configure terminal',
    'interface Gi0/0.10', 'encapsulation dot1q 10',
    'ip address 192.168.10.1 255.255.255.0', 'exit',
    'interface Gi0/0.20', 'encapsulation dot1q 20',
    'ip address 192.168.20.1 255.255.255.0'
  ]);
  runCommands(pc1, t, sim, [
    'configure terminal', 'interface eth0', 'ip address 192.168.10.10 255.255.255.0',
    'exit', 'ip default-gateway 192.168.10.1'
  ]);
  runCommands(pc2, t, sim, [
    'configure terminal', 'interface eth0', 'ip address 192.168.20.20 255.255.255.0',
    'exit', 'ip default-gateway 192.168.20.1'
  ]);
  return { t: t, sim: sim, sw: sw, r: r, pc1: pc1, pc2: pc2, routerOut: routerOut };
}

// ---------- A: subinterfaces exist and the parent became a trunk ----------
console.log('Scenario A: subinterface creation');
{
  const L = buildLab();
  const r = L.r;
  ok(r.interfaces.has('Gi0/0.10') && r.interfaces.has('Gi0/0.20'),
    'CLI created Gi0/0.10 and Gi0/0.20');
  ok(r.interfaces.get('Gi0/0.10').isSubinterface() === true,
    'subinterface reports isSubinterface()');
  ok(r.interfaces.get('Gi0/0').vlan.mode === 'trunk',
    'parent Gi0/0 automatically became an 802.1Q trunk');
  ok(r.interfaces.get('Gi0/0.10').encapVid === 10 && r.interfaces.get('Gi0/0.20').encapVid === 20,
    'encapsulation dot1q set the VLAN ids');
  ok(r.interfaces.get('Gi0/0.10').mac === r.interfaces.get('Gi0/0').mac,
    'subinterface borrows the parent MAC');
  ok(r.interfaces.get('Gi0/0.10').ip === '192.168.10.1',
    'subinterface holds its own IP address');
}

// ---------- B: routing between VLANs over one physical link ----------
console.log('\nScenario B: router-on-a-stick routes between VLANs');
{
  const L = buildLab();
  const res = L.sim.ping(L.pc1.id, '192.168.20.20', { count: 2 });
  ok(allUp(res.replies), 'ping from VLAN 10 host to VLAN 20 host succeeds');

  const vids = res.events.filter(function (e) {
    return e.type === 'frame' && e.frame && e.frame.wireTagged;
  }).map(function (e) { return e.frame.wireVid; });
  const uniq = vids.filter(function (v, i) { return vids.indexOf(v) === i; }).sort(function (a, b) { return a - b; });
  ok(uniq.length === 2 && uniq[0] === 10 && uniq[1] === 20,
    'trunk carried both VLAN 10 and VLAN 20 tagged frames (' + uniq.join(', ') + ')');

  const routes = L.r.routesTable().map(function (x) { return x.dest + '/' + net.prefixOf(x.mask); });
  ok(routes.indexOf('192.168.10.0/24') !== -1 && routes.indexOf('192.168.20.0/24') !== -1,
    'router installed a connected route per subinterface');

  const noRoute = L.sim.ping(L.pc1.id, '10.9.9.9', { count: 1 });
  ok(allDown(noRoute.replies), 'unrouted destination still fails (no default route)');
}

// ---------- C: without the subinterface the VLANs stay isolated ----------
console.log('\nScenario C: shut the subinterface down and isolation returns');
{
  const L = buildLab();
  runCommands(L.r, L.t, L.sim, ['configure terminal', 'interface Gi0/0.20', 'shutdown']);
  const res = L.sim.ping(L.pc1.id, '192.168.20.20', { count: 2 });
  ok(allDown(res.replies), 'ping fails once the VLAN 20 subinterface is shut down');

  runCommands(L.r, L.t, L.sim, ['configure terminal', 'interface Gi0/0.20', 'no shutdown']);
  const res2 = L.sim.ping(L.pc1.id, '192.168.20.20', { count: 2 });
  ok(allUp(res2.replies), 'ping works again after no shutdown');
}

// ---------- D: subinterfaces survive save / load ----------
console.log('\nScenario D: serialization round-trip');
{
  const L = buildLab();
  const json = JSON.parse(JSON.stringify(L.t.serialize()));
  const t2 = Topology.fromJSON(json);
  const r2 = t2.getDevice(L.r.id);
  ok(r2.interfaces.has('Gi0/0.10') && r2.interfaces.has('Gi0/0.20'),
    'subinterfaces recreated after load');
  ok(r2.interfaces.get('Gi0/0.10').encapVid === 10,
    'encapVid restored after load');
  ok(r2.interfaces.get('Gi0/0.10').ip === '192.168.10.1',
    'subinterface IP restored after load');

  const sim2 = new Simulator(t2);
  const pc1b = t2.getDevice(L.pc1.id);
  const res = sim2.ping(pc1b.id, '192.168.20.20', { count: 2 });
  ok(allUp(res.replies), 'reloaded lab still routes between VLANs');
}

// ---------- E: CLI guard rails ----------
console.log('\nScenario E: CLI validation');
{
  const L = buildLab();
  const out = runCommands(L.r, L.t, L.sim, [
    'configure terminal', 'interface Gi0/1', 'encapsulation dot1q 10'
  ]).lines.join('\n');
  ok(/only valid on a subinterface/.test(out),
    'encapsulation dot1q rejected on a physical interface');

  const bad = runCommands(L.r, L.t, L.sim, [
    'configure terminal', 'interface Gi0/0.9999'
  ]).lines.join('\n');
  ok(/VLAN out of range/.test(bad), 'subinterface with an out-of-range VLAN rejected');

  const run = runCommands(L.r, L.t, L.sim, ['show running-config']).lines.join('\n');
  ok(/interface Gi0\/0\.10/.test(run) && /encapsulation dot1q 10/.test(run),
    'running-config shows the subinterface and its encapsulation');

  const brief = runCommands(L.r, L.t, L.sim, ['show ip interface brief']).lines.join('\n');
  ok(/Gi0\/0\.10/.test(brief), 'show ip interface brief lists the subinterface');

  const del = runCommands(L.r, L.t, L.sim, [
    'configure terminal', 'no interface Gi0/0.20'
  ]).lines.join('\n');
  ok(/removed/.test(del) && !L.r.interfaces.has('Gi0/0.20'), 'no interface removes the subinterface');

  const delPhys = runCommands(L.r, L.t, L.sim, [
    'configure terminal', 'no interface Gi0/1'
  ]).lines.join('\n');
  ok(/cannot be removed/.test(delPhys), 'physical interfaces cannot be removed');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
