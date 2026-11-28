'use strict';
// OSPF neighbours on a broadcast *segment*, not on a cable.
//
// `computeOspf()` walked `topo.links`, so two routers were neighbours only when a cable joined the
// two of them. Three routers cabled into one access switch - the commonest OSPF lab there is, and
// the one every DR/BDR lesson is taught on - formed no adjacency at all, and `show ip ospf neighbor`
// answered "nothing on the other end of an OSPF interface is running OSPF" on all three.
//
// A Hello is a multicast within a broadcast domain, so the adjacency set is the segment's, and
// `segmentOf()` (engine/segment.ts, the walk DHCP already uses) is that set: it crosses bridges,
// honours the VLAN a port is in, and passes nothing over a link that is down or a port the spanning
// tree is holding. The election follows the same correction - a Designated Router is elected per
// network (RFC 2328 7.3: "The Designated Router becomes adjacent to all other routers on the
// network"; 7.4 says the same of the Backup) - so a segment of three routers elects one DR and one
// BDR, and the third is a DROTHER that is FULL with both and prints `2WAY/DROTHER` for the other
// DROTHERs (Cisco Learning Network, "DROther routers stay in a 2-way state? Or no?", a transcript
// of three routers on a 2960: the BDR's table reads `2.2.2.2 1 FULL/DR` and `3.3.3.3 1
// FULL/DROTHER`; research/ospf-segment-adjacency.md carries the captures).
const { loadCatalog } = require('../devices/registry');
const { Topology } = require('../engine/topology');
const { Simulator } = require('../engine/simulator');
const cliModule = require('../engine/cli');
const CliSession = cliModule.CliSession || cliModule;

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const ROOT = require('path').join(__dirname, '..');
const specs = loadCatalog(ROOT + '/devices').filter(function (s) { return !s.error; });
const ROUTER = specs.find(function (s) { return /^ISR 4331$/.test(s.model); });
const SWITCH = specs.find(function (s) { return /2960/i.test(s.model); });

function sess(t, id, sim) { return new CliSession(t.getDevice(id), t, sim || null); }
function configure(t, id, cmds) {
  const s = sess(t, id);
  ['enable', 'configure terminal'].concat(cmds).forEach(function (c) { s.run(c); });
}
function show(t, sim, id, cmd) { return ((sess(t, id, sim).run(cmd) || {}).output || []).join('\n'); }
function stateOf(text, peer) {
  const row = text.split('\n').filter(function (l) { return l.trim().indexOf(peer + ' ') === 0; })[0] || '';
  const m = /\s(FULL|2WAY)\s*\/\s*(\S+)/.exec(row);
  return m ? m[1] + '/' + m[2] : '';
}

// n routers in one VLAN on one access switch, each with a second network on Gi0/0/1 so there is
// something to route. `vlanOf` puts a named router's switch port in another VLAN, which is a
// different segment.
function segmentOfRouters(n, opts) {
  const o = opts || {};
  const t = new Topology();
  const ids = [];
  for (let i = 1; i <= n; i++) ids.push('r' + i);
  ids.forEach(function (id) { t.addDevice(ROUTER, id); });
  t.addDevice(SWITCH, 'sw1');
  ids.forEach(function (id, i) {
    const dev = t.getDevice(id);
    const port = dev.interfaces.get('Gi0/0/0');
    port.enabled = true;
    port.ip = '10.0.0.' + (i + 1);
    port.mask = '255.255.255.0';
    const back = dev.interfaces.get('Gi0/0/1');
    back.enabled = true;
    back.ip = '10.' + (i + 1) + '.0.1';
    back.mask = '255.255.255.0';
    configure(t, id, [
      'hostname ' + id,
      'ospf router-id ' + (i + 1) + '.' + (i + 1) + '.' + (i + 1) + '.' + (i + 1),
      'ospf area 0'
    ]);
  });
  ids.forEach(function (id, i) {
    t.connect(id, 'Gi0/0/0', 'sw1', 'Fa0/' + (i + 1));
  });
  if (o.vlanOf) {
    Object.keys(o.vlanOf).forEach(function (id) {
      const s = sess(t, 'sw1');
      s.run('configure terminal');
      s.run('interface Fa0/' + (ids.indexOf(id) + 1));
      s.run('switchport access vlan ' + o.vlanOf[id]);
    });
  }
  return { t: t, ids: ids };
}
function run(t) { const sim = new Simulator(t); sim.computeOspf(); return sim; }

console.log('');
console.log('Two routers on one access switch are neighbours, not two islands:');
{
  const env = segmentOfRouters(2);
  const sim = run(env.t);
  const r1 = show(env.t, sim, 'r1', 'show ip ospf neighbor');
  const r2 = show(env.t, sim, 'r2', 'show ip ospf neighbor');
  ok((env.t.getDevice('r1').ospfNeighbors || []).length === 1,
    'r1 has one neighbour across the switch', JSON.stringify(env.t.getDevice('r1').ospfNeighbors));
  ok(/2\.2\.2\.2/.test(r1), 'and it is r2', r1);
  const roles = [stateOf(r1, '2.2.2.2'), stateOf(r2, '1.1.1.1')].sort().join(',');
  ok(roles === 'FULL/BDR,FULL/DR', 'the pair elects a DR and a BDR, as a cable does', roles);
  const routes = show(env.t, sim, 'r1', 'show ip route');
  ok(/^O\s+10\.2\.0\.0\/24/m.test(routes), 'r1 learns r2\'s network as an O route', routes);
  ok(/10\.2\.0\.0\/24 \[110\/\d+\] via 10\.0\.0\.2/.test(routes),
    'and the next hop is r2 across the segment', routes);
}

console.log('');
console.log('Three routers on one segment: one DR, one BDR, one DROTHER:');
{
  const env = segmentOfRouters(3);
  const sim = run(env.t);
  const seen = ['r1', 'r2', 'r3'].map(function (id) { return show(env.t, sim, id, 'show ip ospf neighbor'); });
  const text = seen.join(' ');   // one line is enough to count the roles the three tables name
  const drs = text.split('FULL/DR ').length - 1;
  ok(stateOf(seen[0], '3.3.3.3') === 'FULL/DR', 'r3 (highest ID) is the DR, seen from r1', seen[0]);
  ok(stateOf(seen[0], '2.2.2.2') === 'FULL/BDR', 'r2 is the BDR, seen from r1', seen[0]);
  ok(stateOf(seen[2], '1.1.1.1') === 'FULL/DROTHER', 'and the DR sees r1 as a DROTHER', seen[2]);
  ok(stateOf(seen[2], '2.2.2.2') === 'FULL/BDR', 'and the BDR as a BDR', seen[2]);
  ok(drs === 2, 'exactly one DR exists - the two DROTHER/BDR tables name it, and the DR names none', String(drs));
  ok(!/2WAY/.test(text), 'with one DROTHER there is no 2WAY pair on this segment', text);
  const proc = show(env.t, sim, 'r1', 'show ip ospf');
  ok(/Neighbours: 2/.test(proc), 'the process view counts both neighbours', proc);
}

console.log('');
console.log('Four routers: the two DROTHERs stop at 2WAY with each other, as a box prints:');
{
  const env = segmentOfRouters(4);
  const sim = run(env.t);
  const r1 = show(env.t, sim, 'r1', 'show ip ospf neighbor');
  ok(stateOf(r1, '2.2.2.2') === '2WAY/DROTHER', 'r1 lists r2 - the other DROTHER - as 2WAY/DROTHER', r1);
  ok(stateOf(r1, '4.4.4.4') === 'FULL/DR', 'and is FULL with the DR', r1);
  ok(stateOf(r1, '3.3.3.3') === 'FULL/BDR', 'and FULL with the BDR', r1);
  ok(/3 neighbour\(s\), 2 fully adjacent \(1 in 2WAY\/DROTHER\)/.test(r1),
    'the sentence under the table does not call a 2WAY row fully adjacent', r1);
  const routes = show(env.t, sim, 'r1', 'show ip route');
  const row = routes.split('\n').filter(function (l) { return /^O\s+10\.2\.0\.0\/24/.test(l); })[0] || '';
  ok(!!row, 'r1 still reaches r2\'s network', routes);
  ok(!/via 10\.0\.0\.2\b/.test(row), 'but never with r2 as the next hop - they are not adjacent', row);
  ok(/via 10\.0\.0\.(3|4)\b/.test(row), 'the next hop is the DR or the BDR', row);
  const iface = show(env.t, sim, 'r1', 'show ip ospf interface');
  const line = iface.split('\n').filter(function (l) { return /^Gi0\/0\/0/.test(l); })[0] || '';
  ok(/\syes\s+no\s*$/.test(line), 'the port is still an adjacent OSPF interface', iface);
}

console.log('');
console.log('A segment is a broadcast domain, so a VLAN or a pulled cable is still a boundary:');
{
  const env = segmentOfRouters(2, { vlanOf: { r2: 20 } });
  const sim = run(env.t);
  ok((env.t.getDevice('r1').ospfNeighbors || []).length === 0,
    'r2 on VLAN 20 is not a neighbour of r1 on VLAN 1',
    JSON.stringify(env.t.getDevice('r1').ospfNeighbors));
  ok((env.t.getDevice('r2').ospfNeighbors || []).length === 0, 'and neither is r1');

  const env2 = segmentOfRouters(2);
  const sim2 = run(env2.t);
  ok((env2.t.getDevice('r1').ospfNeighbors || []).length === 1, 'the same pair on one VLAN is adjacent');
  const link = [...env2.t.links.values()].filter(function (l) {
    return (l.a.deviceId === 'r1' || l.b.deviceId === 'r1');
  })[0];
  sim2.setLinkState(link.id, 'down', { atMs: 1000 });
  sim2.computeOspf();
  ok((env2.t.getDevice('r1').ospfNeighbors || []).length === 0,
    'and pulling r1\'s cable removes the adjacency behind the switch',
    JSON.stringify(env2.t.getDevice('r1').ospfNeighbors));
}

console.log('');
console.log('A direct cable is one segment of two, so a two-router lab is unchanged:');
{
  const t = new Topology();
  t.addDevice(ROUTER, 'a');
  t.addDevice(ROUTER, 'b');
  ['a', 'b'].forEach(function (id, i) {
    const port = t.getDevice(id).interfaces.get('Gi0/0/0');
    port.enabled = true;
    port.ip = '10.7.0.' + (i + 1);
    port.mask = '255.255.255.0';
    configure(t, id, ['ospf router-id 7.7.7.' + (i + 1)]);
  });
  t.connect('a', 'Gi0/0/0', 'b', 'Gi0/0/0', { mediaId: '1000base-t', speedMbps: 1000 });
  const sim = run(t);
  const a = show(t, sim, 'a', 'show ip ospf neighbor');
  ok((t.getDevice('a').ospfNeighbors || []).length === 1, 'one neighbour over the cable', a);
  ok(stateOf(a, '7.7.7.2') === 'FULL/DR', 'and it is the DR (higher ID)', a);
  ok(/1 neighbour\(s\), all Fully adjacent/.test(a), 'with the unchanged closing sentence', a);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
