'use strict';
// protocol-regression.test.js -- control-plane behaviour pins.
//
// One file for the routing / first-hop protocols that the engine models: BGP
// (decision process, advertisement, split horizon), OSPF (adjacency, SPF,
// route installation), VRRP (election, preemption, failover), DHCP (lease
// lifecycle), NAT (PAT, static, dynamic + the data path) and DNS (CNAME
// chains, NODATA, cache, name resolution from a host).
//
// These are behavioural assertions, not unit trivia. Where a rule is only
// visible through the simulator (iBGP split horizon, passive OSPF interfaces,
// area matching changing the data path) the simulator is driven directly.
//
// Assertions preceded by "DOCUMENTS BUG" pin a defect found while writing this
// file. They are written to pass against the current engine so the suite stays
// green, and they fail the moment somebody fixes the defect -- so a fix cannot
// land without flipping the assertion to the behaviour it should have had.
//
// No pin remains. The two this file originally carried were #240 (an OSPF
// adjacency forming between interfaces in different subnets) and #241 (NODATA
// reported as NXDOMAIN); both are fixed and now asserted as correct above, along
// with the cases that must keep working. If a new pin appears here, it names a
// live defect worth fixing rather than documenting.

const path = require('path');
const bgp = require('../engine/bgp');
const ospf = require('../engine/ospf');
const vrrp = require('../engine/vrrp');
const dhcp = require('../engine/dhcp');
const nat = require('../engine/nat');
const dns = require('../engine/dns');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0;
let failed = 0;

function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

function eq(actual, expected, msg) {
  ok(actual === expected, msg + ' (expected ' + JSON.stringify(expected) +
    ', got ' + JSON.stringify(actual) + ')');
}

function deq(actual, expected, msg) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), msg +
    ' (expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual) + ')');
}

function section(title) {
  console.log('\n' + title);
}

// ---------------------------------------------------------------------------
// simulator helpers
// ---------------------------------------------------------------------------

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));

function model(name) {
  const s = catalog.find(function (x) { return x.vendor === 'generic' && x.model === name; });
  if (!s) throw new Error('missing device model: ' + name);
  return s;
}

function newRouter(t, name) {
  const d = t.addDevice(model('generic-router'));
  d.name = name;
  return d;
}

function newPc(t, name) {
  const d = t.addDevice(model('generic-pc'));
  d.name = name;
  return d;
}

function cfg(dev, topo, sim, lines) {
  runCommands(dev, topo, sim, ['configure terminal'].concat(lines));
}

// Configure addresses (and optional OSPF cost) on a list of [name, ip, mask, cost].
function setInterfaces(dev, topo, sim, list) {
  const lines = [];
  for (const entry of list) {
    lines.push('interface ' + entry[0], 'ip address ' + entry[1] + ' ' + entry[2]);
    if (entry[3] !== undefined) lines.push('ip ospf cost ' + entry[3]);
    lines.push('exit');
  }
  cfg(dev, topo, sim, lines);
}

function ospfOn(dev, topo, sim, routerId, area) {
  cfg(dev, topo, sim, ['ospf router-id ' + routerId, 'ospf area ' + (area === undefined ? 0 : area)]);
}

function bgpOn(dev, topo, sim, as, routerId, neighbors) {
  const lines = ['router bgp ' + as, 'bgp router-id ' + routerId];
  for (const n of neighbors) lines.push('neighbor ' + n[0] + ' remote-as ' + n[1]);
  cfg(dev, topo, sim, lines);
}

function bgpRouteOf(routes, dest) {
  const list = routes || [];
  for (const r of list) { if (r.dest === dest) return r; }
  return null;
}

function ospfRouteOf(routes, dest) {
  const list = routes || [];
  for (const r of list) { if (r.dest === dest) return r; }
  return null;
}

function routeDestinations(routes) {
  return (routes || []).map(function (r) { return r.dest; }).sort();
}

function allUp(replies) {
  return replies.every(function (r) { return r.success; });
}

function allDown(replies) {
  return replies.every(function (r) { return !r.success; });
}

// ===========================================================================
// 1. BGP decision process
// ===========================================================================
section('1. BGP: best-path selection order');

const BGP_BASE = {
  prefix: '203.0.113.0/24', asPath: [], origin: 0, localPreference: 100,
  med: 0, weight: 0, type: 'ebgp', routerId: '1.1.1.1'
};

function bgpPath(over) {
  return Object.assign({}, BGP_BASE, over || {});
}

{
  ok(bgp.comparePaths(bgpPath({ weight: 10, localPreference: 10 }),
    bgpPath({ weight: 0, localPreference: 500 })) < 0,
  'weight outranks local preference');

  ok(bgp.comparePaths(bgpPath({ localPreference: 200, asPath: [1, 2, 3, 4] }),
    bgpPath({ localPreference: 100, asPath: [] })) < 0,
  'local preference outranks AS-path length');

  ok(bgp.comparePaths(bgpPath({ from: 'local', asPath: [1, 2, 3] }), bgpPath({ asPath: [] })) < 0,
    'a locally originated path outranks a longer, learned one');

  ok(bgp.comparePaths(bgpPath({ asPath: [1, 2], med: 500 }), bgpPath({ asPath: [1, 2, 3], med: 0 })) < 0,
    'shorter AS path outranks lower MED');

  ok(bgp.comparePaths(bgpPath({ origin: 0, med: 50 }), bgpPath({ origin: 2, med: 0 })) < 0,
    'IGP origin outranks INCOMPLETE before MED is considered');

  ok(bgp.comparePaths(bgpPath({ med: 10 }), bgpPath({ med: 20 })) < 0, 'the lower MED wins');

  ok(bgp.comparePaths(bgpPath({ med: 10, type: 'ibgp', routerId: '9.9.9.9' }),
    bgpPath({ med: 20, type: 'ebgp', routerId: '1.1.1.1' })) < 0,
  'MED outranks the eBGP-over-iBGP preference');

  ok(bgp.comparePaths(bgpPath({ type: 'ebgp', routerId: '9.9.9.9' }),
    bgpPath({ type: 'ibgp', routerId: '1.1.1.1' })) < 0,
  'eBGP beats iBGP once everything above ties');

  ok(bgp.comparePaths(bgpPath({ routerId: '2.2.2.2' }), bgpPath({ routerId: '1.1.1.1' })) > 0,
    'the lower router ID wins the final tie-break');

  ok(bgp.comparePaths(bgpPath({ routerId: '1.1.1.1' }), bgpPath({ routerId: '2.2.2.2' })) < 0,
    'the comparison is antisymmetric');

  eq(bgp.asPathLength([]), 0, 'an empty AS path has length 0');
  eq(bgp.asPathLength([65010, 65020]), 2, 'an AS_SEQUENCE counts one hop per AS');
  eq(bgp.asPathLength([[65010, 65020]]), 1, 'an AS_SET counts as a single hop');
}

{
  const candidates = [
    bgpPath({ routerId: '9.9.9.9', asPath: [65010] }),
    bgpPath({ routerId: '1.1.1.1', asPath: [65010] })
  ];
  const winner = bgp.bestPath(candidates);
  ok(winner === candidates[1], 'bestPath returns the winning candidate object itself');
  eq(candidates[0].routerId, '9.9.9.9', 'bestPath does not reorder the caller array');
  ok(bgp.bestPath([]) === null && bgp.bestPath(null) === null,
    'an empty or non-array candidate list yields no best path');

  ok(bgp.pathIsLoopFree([65010, 65020], 65001) === true, 'a path without the local AS is loop free');
  ok(bgp.pathIsLoopFree([65010, 65001], 65001) === false, 'a path containing the local AS is rejected');
  ok(bgp.pathIsLoopFree([[65010, 65001], 65020], 65001) === false,
    'an AS_SET member also triggers loop detection');
  ok(bgp.pathIsLoopFree([65010], 'not-an-as') === true,
    'an unparseable local AS never matches (documented fallback)');
}

{
  const source = [{
    prefix: '198.51.100.0/24', asPath: [65010, 65020], origin: 'igp',
    med: 7, localPreference: 150, nextHop: '192.0.2.1'
  }];
  const external = bgp.advertise(source, { localAs: 65001, type: 'ebgp' });
  deq(external[0].asPath, [65001, 65010, 65020], 'eBGP prepends the local AS exactly once');
  eq(external[0].nextHop, '192.0.2.1', 'the next hop is carried when no override is given');
  eq(external[0].med, 7, 'MED survives the advertisement');
  eq(external[0].localPreference, 150, 'local preference survives the advertisement');
  deq(source[0].asPath, [65010, 65020], 'advertising never mutates the input AS path');

  const internal = bgp.advertise(source, { localAs: 65001, type: 'ibgp', nextHop: '203.0.113.9' });
  deq(internal[0].asPath, [65010, 65020], 'iBGP does not prepend the local AS');
  eq(internal[0].nextHop, '203.0.113.9', 'an explicit next hop overrides the route next hop');

  const inferred = bgp.advertise(source, { localAs: 65001, peerAs: 65001 });
  deq(inferred[0].asPath, [65010, 65020],
    'a peer inside the local AS is inferred as iBGP, so nothing is prepended');
}

// ===========================================================================
// 2. BGP in the simulator
// ===========================================================================
section('2. BGP: sessions, propagation and split horizon');

// R1 (AS 65001) -- R2 (AS 65002), one eBGP session, one prefix each.
function ebgpLab() {
  const t = new Topology();
  const r1 = newRouter(t, 'R1');
  const r2 = newRouter(t, 'R2');
  t.connect(r1.id, 'Gi0/0', r2.id, 'Gi0/0');
  const sim = new Simulator(t);
  setInterfaces(r1, t, sim, [['Gi0/0', '10.0.12.1', '255.255.255.0'],
    ['Gi0/1', '10.1.1.1', '255.255.255.0']]);
  setInterfaces(r2, t, sim, [['Gi0/0', '10.0.12.2', '255.255.255.0'],
    ['Gi0/1', '10.2.2.2', '255.255.255.0']]);
  bgpOn(r1, t, sim, 65001, '1.1.1.1', [['10.0.12.2', 65002]]);
  bgpOn(r2, t, sim, 65002, '2.2.2.2', [['10.0.12.1', 65001]]);
  return { t: t, sim: sim, r1: r1, r2: r2 };
}

// R1 and R2 in the same AS, R2 and R3 in the same AS: two iBGP sessions.
function ibgpLab() {
  const t = new Topology();
  const r1 = newRouter(t, 'R1');
  const r2 = newRouter(t, 'R2');
  const r3 = newRouter(t, 'R3');
  t.connect(r1.id, 'Gi0/0', r2.id, 'Gi0/0');
  t.connect(r2.id, 'Gi0/1', r3.id, 'Gi0/0');
  const sim = new Simulator(t);
  setInterfaces(r1, t, sim, [['Gi0/0', '10.0.12.1', '255.255.255.0'],
    ['Gi0/1', '10.1.1.1', '255.255.255.0']]);
  setInterfaces(r2, t, sim, [['Gi0/0', '10.0.12.2', '255.255.255.0'],
    ['Gi0/1', '10.0.23.2', '255.255.255.0']]);
  setInterfaces(r3, t, sim, [['Gi0/0', '10.0.23.3', '255.255.255.0']]);
  bgpOn(r1, t, sim, 65001, '1.1.1.1', [['10.0.12.2', 65001]]);
  bgpOn(r2, t, sim, 65001, '2.2.2.2', [['10.0.12.1', 65001], ['10.0.23.3', 65001]]);
  bgpOn(r3, t, sim, 65001, '3.3.3.3', [['10.0.23.2', 65001]]);
  return { t: t, sim: sim, r1: r1, r2: r2, r3: r3 };
}

{
  const lab = ebgpLab();
  const res = lab.sim.computeBgp();
  eq(lab.sim.bgpSessions, 1, 'a peering configured on both sides forms exactly one eBGP session');

  const learned = bgpRouteOf(res[lab.r1.id], '10.2.2.0');
  ok(learned !== null, 'R1 learns the prefix connected to R2');
  deq(learned.asPath, [65002], 'the eBGP route carries the advertising AS exactly once');
  eq(learned.session, 'ebgp', 'the learned route is marked eBGP');
  eq(learned.ad, 20, 'an eBGP route is installed with administrative distance 20');
  eq(learned.nextHop, '10.0.12.2', 'the next hop is the eBGP peer address');

  const reverse = bgpRouteOf(res[lab.r2.id], '10.1.1.0');
  ok(reverse !== null && JSON.stringify(reverse.asPath) === '[65001]',
    'R2 learns R1 prefix with R1 AS in the path');
  ok(bgpRouteOf(res[lab.r1.id], '10.1.1.0') === null,
    'a locally originated prefix is not installed as a BGP route on its originator');
}

{
  // Half a peering: R2 has BGP but never lists R1 as a neighbour.
  const t = new Topology();
  const r1 = newRouter(t, 'R1');
  const r2 = newRouter(t, 'R2');
  t.connect(r1.id, 'Gi0/0', r2.id, 'Gi0/0');
  const sim = new Simulator(t);
  setInterfaces(r1, t, sim, [['Gi0/0', '10.0.12.1', '255.255.255.0']]);
  setInterfaces(r2, t, sim, [['Gi0/0', '10.0.12.2', '255.255.255.0']]);
  bgpOn(r1, t, sim, 65001, '1.1.1.1', [['10.0.12.2', 65001]]);
  bgpOn(r2, t, sim, 65002, '2.2.2.2', []);
  const res = sim.computeBgp();
  eq(sim.bgpSessions, 0, 'half a peering is not a session');
  eq(res[r1.id].length, 0, 'no routes are exchanged over a half-configured peering');
}

{
  // Both sides list each other, but the remote-as values disagree.
  const t = new Topology();
  const r1 = newRouter(t, 'R1');
  const r2 = newRouter(t, 'R2');
  t.connect(r1.id, 'Gi0/0', r2.id, 'Gi0/0');
  const sim = new Simulator(t);
  setInterfaces(r1, t, sim, [['Gi0/0', '10.0.12.1', '255.255.255.0']]);
  setInterfaces(r2, t, sim, [['Gi0/0', '10.0.12.2', '255.255.255.0']]);
  bgpOn(r1, t, sim, 65001, '1.1.1.1', [['10.0.12.2', 65001]]);
  bgpOn(r2, t, sim, 65002, '2.2.2.2', [['10.0.12.1', 65001]]);
  sim.computeBgp();
  eq(sim.bgpSessions, 0, 'a remote-as that does not match the peer AS blocks the session');
}

{
  const lab = ibgpLab();
  const res = lab.sim.computeBgp();
  eq(lab.sim.bgpSessions, 2, 'two iBGP peerings are counted');

  const relayed = bgpRouteOf(res[lab.r2.id], '10.1.1.0');
  ok(relayed !== null, 'R2 learns R1 prefix over iBGP');
  deq(relayed.asPath, [], 'iBGP does not prepend an AS, so the path stays empty');
  eq(relayed.session, 'ibgp', 'the learned route is marked iBGP');

  // Fixed in #41 (engine/simulator.js, advertisement loop): a route learned
  // from an iBGP peer used to be relayed to every other iBGP peer, and the
  // relayed copy pointed at the relayer. Real BGP refuses both: inside one AS
  // a route needs a route reflector or a full mesh, and the next hop is not
  // rewritten, so R3 must not see R1 prefix through R2.
  const leaked = bgpRouteOf(res[lab.r3.id], '10.1.1.0');
  ok(leaked === null,
    'an iBGP-learned route is not re-advertised to another iBGP peer (#41)');
  eq(relayed.nextHop, '10.0.12.1',
    'the iBGP route names the originator, not the relayer, as its next hop (#41)');
}

{
  // #41, the other half: an eBGP route relayed into the AS keeps the original
  // next hop. R1 (65001) -eBGP- R2 (65002) -iBGP- R3 (65002).
  const t = new Topology();
  const r1 = newRouter(t, 'R1');
  const r2 = newRouter(t, 'R2');
  const r3 = newRouter(t, 'R3');
  t.connect(r1.id, 'Gi0/0', r2.id, 'Gi0/0');
  t.connect(r2.id, 'Gi0/1', r3.id, 'Gi0/0');
  const sim = new Simulator(t);
  setInterfaces(r1, t, sim, [['Gi0/0', '10.0.12.1', '255.255.255.0'],
    ['Gi0/1', '10.1.1.1', '255.255.255.0']]);
  setInterfaces(r2, t, sim, [['Gi0/0', '10.0.12.2', '255.255.255.0'],
    ['Gi0/1', '10.0.23.2', '255.255.255.0']]);
  setInterfaces(r3, t, sim, [['Gi0/0', '10.0.23.3', '255.255.255.0']]);
  bgpOn(r1, t, sim, 65001, '1.1.1.1', [['10.0.12.2', 65002]]);
  bgpOn(r2, t, sim, 65002, '2.2.2.2', [['10.0.12.1', 65001], ['10.0.23.3', 65002]]);
  bgpOn(r3, t, sim, 65002, '3.3.3.3', [['10.0.23.2', 65002]]);
  const res = sim.computeBgp();

  const atR3 = bgpRouteOf(res[r3.id], '10.1.1.0');
  ok(atR3 !== null, 'an eBGP route is re-advertised over iBGP (that part is allowed)');
  eq(atR3 ? atR3.nextHop : null, '10.0.12.1',
    'and keeps the original eBGP next hop instead of being rewritten to the relayer (#41)');
  deq(atR3 ? atR3.asPath : null, [65001], 'the AS path still names the origin AS only once');
}

{
  // AS loop: R1 (65001) - R2 (65002) - R3 (65001). R3 must reject R1 prefix.
  const t = new Topology();
  const r1 = newRouter(t, 'R1');
  const r2 = newRouter(t, 'R2');
  const r3 = newRouter(t, 'R3');
  t.connect(r1.id, 'Gi0/0', r2.id, 'Gi0/0');
  t.connect(r2.id, 'Gi0/1', r3.id, 'Gi0/0');
  const sim = new Simulator(t);
  setInterfaces(r1, t, sim, [['Gi0/0', '10.0.12.1', '255.255.255.0'],
    ['Gi0/1', '10.1.1.1', '255.255.255.0']]);
  setInterfaces(r2, t, sim, [['Gi0/0', '10.0.12.2', '255.255.255.0'],
    ['Gi0/1', '10.0.23.2', '255.255.255.0']]);
  setInterfaces(r3, t, sim, [['Gi0/0', '10.0.23.3', '255.255.255.0'],
    ['Gi0/1', '10.3.3.3', '255.255.255.0']]);
  bgpOn(r1, t, sim, 65001, '1.1.1.1', [['10.0.12.2', 65002]]);
  bgpOn(r2, t, sim, 65002, '2.2.2.2', [['10.0.12.1', 65001], ['10.0.23.3', 65001]]);
  bgpOn(r3, t, sim, 65001, '3.3.3.3', [['10.0.23.2', 65002]]);
  const res = sim.computeBgp();
  eq(sim.bgpSessions, 2, 'the two eBGP sessions form');
  ok(bgpRouteOf(res[r3.id], '10.1.1.0') === null,
    'a route whose AS path already contains the local AS is rejected');
  ok(bgpRouteOf(res[r1.id], '10.3.3.0') === null,
    'the loop is rejected in both directions');
  ok(bgpRouteOf(res[r3.id], '10.0.12.0') !== null,
    'loop detection does not block a legitimate remote prefix');
}

// ===========================================================================
// 3. OSPF adjacency and SPF (library)
// ===========================================================================
section('3. OSPF: adjacency, SPF and route installation');

function oRtr(id, routerId, area, interfaces) {
  return { id: id, routerId: routerId, areaId: area, interfaces: interfaces };
}

function triangleRouters(r3Area) {
  return [
    oRtr('r1', '1.1.1.1', 0, [
      { name: 'e12', ip: '10.0.12.1', mask: '255.255.255.0', cost: 5 },
      { name: 'e13', ip: '10.0.13.1', mask: '255.255.255.0', cost: 50 },
      { name: 'lo', ip: '10.0.1.1', mask: '255.255.255.255' }
    ]),
    oRtr('r2', '2.2.2.2', 0, [
      { name: 'e12', ip: '10.0.12.2', mask: '255.255.255.0', cost: 5 },
      { name: 'e23', ip: '10.0.23.2', mask: '255.255.255.0', cost: 5 }
    ]),
    oRtr('r3', '3.3.3.3', r3Area === undefined ? 0 : r3Area, [
      { name: 'e13', ip: '10.0.13.3', mask: '255.255.255.0', cost: 50 },
      { name: 'e23', ip: '10.0.23.3', mask: '255.255.255.0', cost: 5 },
      { name: 'lo', ip: '10.0.3.3', mask: '255.255.255.255' }
    ])
  ];
}

const TRIANGLE_LINKS = [
  { a: { router: 'r1', iface: 'e12' }, b: { router: 'r2', iface: 'e12' } },
  { a: { router: 'r2', iface: 'e23' }, b: { router: 'r3', iface: 'e23' } },
  { a: { router: 'r1', iface: 'e13' }, b: { router: 'r3', iface: 'e13' } }
];

{
  const graph = ospf.buildGraph(triangleRouters(), TRIANGLE_LINKS);
  eq(graph.edges.length, 3, 'three same-area links form three adjacencies');

  const r12 = graph.edges.filter(function (e) { return e.a === 'r1' && e.b === 'r2'; })[0];
  eq(r12 ? r12.cost : null, 10, 'an OSPF link costs the sum of both interface costs (5 + 5)');

  const spt = ospf.spf(graph, 'r1');
  const toR3 = spt.get('r3');
  eq(toR3 ? toR3.cost : null, 20, 'SPF prefers the cheap two-hop path (10 + 10) over the direct 100');
  eq(toR3 ? toR3.nextHopRouterId : null, 'r2', 'the next hop for r3 is r2, not the expensive link');
  deq(toR3 ? toR3.path : null, ['r1', 'r2', 'r3'], 'the shortest path tree records the full path');

  const back = ospf.spf(graph, 'r3').get('r1');
  eq(back ? back.cost : null, 20, 'the SPF result is symmetric');
  eq(back ? back.nextHopRouterId : null, 'r2', 'the reverse path also transits r2');

  const routes = ospf.routesFromSpt(graph, 'r1', spt);
  const loopback = routes.filter(function (r) { return r.dest === '10.0.3.3'; })[0];
  ok(!!loopback, 'a remote /32 loopback is installed');
  eq(loopback ? loopback.cost : null, 20, 'the installed route carries the SPF cost');
  eq(loopback ? loopback.nextHop : null, 'r2', 'the next hop is the first-hop router id');
  eq(loopback ? loopback.iface : null, 'e12', 'the egress interface is the one facing that next hop');
  eq(loopback ? loopback.code : null, 'O', 'installed routes carry code O');

  ok(ospfRouteOf(routes, '10.0.12.0') === null, 'the root own connected network is not installed');
  ok(ospfRouteOf(routes, '10.0.13.0') === null, 'a second own connected network is not installed');
  ok(ospfRouteOf(routes, '10.0.1.1') === null, 'the root own loopback is not installed');
  const shared = ospfRouteOf(routes, '10.0.23.0');
  eq(shared ? shared.cost : null, 10,
    'a network advertised by two routers keeps the cheaper entry (r2 at cost 10, not r3 at 20)');
}

{
  const graph = ospf.buildGraph(triangleRouters(1), TRIANGLE_LINKS);
  eq(graph.edges.length, 1, 'links that cross an area boundary do not become adjacencies');
  ok(graph.edges[0].a === 'r1' && graph.edges[0].b === 'r2',
    'the remaining adjacency is the one wholly inside area 0');
  eq(ospf.adjacencies(graph).length, 1, 'the adjacency list reflects the same area filtering');

  const areas = ospf.areasOf(triangleRouters(1));
  deq(Array.from(areas.keys()), [0, 1], 'areas are reported in ascending order');
  deq(areas.get(0), ['r1', 'r2'], 'area 0 members are sorted by id');
  deq(areas.get(1), ['r3'], 'the router that moved is the only member of area 1');
}

{
  // Unreachable router: no link, so it must not appear in the SPT or routes.
  const graph = ospf.buildGraph([
    oRtr('a', '1.1.1.1', 0, [{ name: 'x', ip: '10.9.9.1', mask: '255.255.255.0' }]),
    oRtr('b', '2.2.2.2', 0, [{ name: 'y', ip: '10.8.8.2', mask: '255.255.255.0' }])
  ], []);
  const spt = ospf.spf(graph, 'a');
  deq(Array.from(spt.keys()), ['a'], 'an unconnected router is absent from the SPT');
  eq(ospf.routesFromSpt(graph, 'a', spt).length, 0, 'and contributes no routes');
}

{
  // Equal-cost diamond: only the deterministic tie-break decides.
  const diamondRouters = [
    oRtr('d1', '1.1.1.1', 0, [{ name: 'p', ip: '10.0.0.1', mask: '255.255.255.0', cost: 10 }]),
    oRtr('d2', '2.2.2.2', 0, [
      { name: 'p', ip: '10.0.0.2', mask: '255.255.255.0', cost: 10 },
      { name: 'q', ip: '10.0.2.2', mask: '255.255.255.0', cost: 10 }
    ]),
    oRtr('d3', '3.3.3.3', 0, [
      { name: 'p', ip: '10.0.0.3', mask: '255.255.255.0', cost: 10 },
      { name: 'q', ip: '10.0.3.3', mask: '255.255.255.0', cost: 10 }
    ]),
    oRtr('d4', '4.4.4.4', 0, [
      { name: 'q', ip: '10.0.2.4', mask: '255.255.255.0', cost: 10 },
      { name: 'q2', ip: '10.0.3.4', mask: '255.255.255.0', cost: 10 },
      { name: 'lo', ip: '10.0.4.4', mask: '255.255.255.255' }
    ])
  ];
  const diamondLinks = [
    { a: { router: 'd1', iface: 'p' }, b: { router: 'd2', iface: 'p' } },
    { a: { router: 'd1', iface: 'p' }, b: { router: 'd3', iface: 'p' } },
    { a: { router: 'd2', iface: 'q' }, b: { router: 'd4', iface: 'q' } },
    { a: { router: 'd3', iface: 'q' }, b: { router: 'd4', iface: 'q2' } }
  ];
  const graph = ospf.buildGraph(diamondRouters, diamondLinks);
  const fwd = ospf.spf(graph, 'd1').get('d4');
  eq(fwd ? fwd.nextHopRouterId : null, 'd2', 'equal-cost paths break the tie on the lower next-hop id');
  const rev = ospf.spf(graph, 'd4').get('d1');
  eq(rev ? rev.nextHopRouterId : null, 'd2', 'the tie-break gives the same answer in reverse');
  const routes = ospf.routesFromSpt(graph, 'd1', ospf.spf(graph, 'd1'));
  eq(routes.length, 3, 'the diamond yields exactly three routes (two neighbours plus the far loopback)');
}

// ===========================================================================
// 4. OSPF in the simulator / data path
// ===========================================================================
section('4. OSPF: learned routes carry traffic and require a matching area');

// PC1 -- R1 -- R2 -- R3 -- PC3, every interface in area 0.
function ospfChain() {
  const t = new Topology();
  const pc1 = newPc(t, 'PC1');
  const pc3 = newPc(t, 'PC3');
  const r1 = newRouter(t, 'R1');
  const r2 = newRouter(t, 'R2');
  const r3 = newRouter(t, 'R3');
  t.connect(pc1.id, 'eth0', r1.id, 'Gi0/2');
  t.connect(r1.id, 'Gi0/0', r2.id, 'Gi0/0');
  t.connect(r2.id, 'Gi0/1', r3.id, 'Gi0/0');
  t.connect(r3.id, 'Gi0/2', pc3.id, 'eth0');
  const sim = new Simulator(t);
  setInterfaces(pc1, t, sim, [['eth0', '10.0.1.10', '255.255.255.0']]);
  cfg(pc1, t, sim, ['ip default-gateway 10.0.1.1']);
  setInterfaces(pc3, t, sim, [['eth0', '10.0.3.10', '255.255.255.0']]);
  cfg(pc3, t, sim, ['ip default-gateway 10.0.3.1']);
  setInterfaces(r1, t, sim, [['Gi0/0', '10.0.12.1', '255.255.255.0'],
    ['Gi0/2', '10.0.1.1', '255.255.255.0']]);
  setInterfaces(r2, t, sim, [['Gi0/0', '10.0.12.2', '255.255.255.0'],
    ['Gi0/1', '10.0.23.2', '255.255.255.0']]);
  setInterfaces(r3, t, sim, [['Gi0/0', '10.0.23.3', '255.255.255.0'],
    ['Gi0/2', '10.0.3.1', '255.255.255.0']]);
  ospfOn(r1, t, sim, '1.1.1.1');
  ospfOn(r2, t, sim, '2.2.2.2');
  ospfOn(r3, t, sim, '3.3.3.3');
  return { t: t, sim: sim, pc1: pc1, pc3: pc3, r1: r1, r2: r2, r3: r3 };
}

{
  const lab = ospfChain();
  const res = lab.sim.computeOspf();

  const toPc3 = ospfRouteOf(res[lab.r1.id], '10.0.3.0');
  ok(toPc3 !== null, 'R1 learns the far stub through OSPF');
  eq(toPc3 ? toPc3.nextHop : null, '10.0.12.2', 'the route points at the adjacent OSPF router');
  eq(toPc3 ? toPc3.iface : null, 'Gi0/0', 'the route leaves through the interface facing it');
  eq(toPc3 ? toPc3.cost : null, 40, 'the cost accumulates across both transit links (20 + 20)');

  const toPc1 = ospfRouteOf(res[lab.r3.id], '10.0.1.0');
  ok(toPc1 !== null && toPc1.nextHop === '10.0.23.2', 'R3 learns the stub behind R1 symmetrically');

  ok(allUp(lab.sim.ping(lab.pc1.id, '10.0.3.10', { count: 2 }).replies),
    'traffic from PC1 to PC3 is carried by the OSPF routes');
  ok(allUp(lab.sim.ping(lab.pc3.id, '10.0.1.10', { count: 2 }).replies),
    'and the reverse direction works too');

  ospfOn(lab.r3, lab.t, lab.sim, '3.3.3.3', 1);
  const after = lab.sim.computeOspf();
  eq(after[lab.r3.id].length, 0, 'a router moved to another area loses every adjacency');
  ok(ospfRouteOf(after[lab.r1.id], '10.0.3.0') === null,
    'the other routers withdraw its networks');
  ok(allDown(lab.sim.ping(lab.pc1.id, '10.0.3.10', { count: 1 }).replies),
    'and the data path breaks: OSPF really is what was forwarding those packets');
}

// Triangle with a deliberately expensive direct link and a cheap transit path.
function ospfTriangle() {
  const t = new Topology();
  const r1 = newRouter(t, 'R1');
  const r2 = newRouter(t, 'R2');
  const r3 = newRouter(t, 'R3');
  t.connect(r1.id, 'Gi0/0', r2.id, 'Gi0/0');
  t.connect(r2.id, 'Gi0/1', r3.id, 'Gi0/0');
  t.connect(r1.id, 'Gi0/1', r3.id, 'Gi0/1');
  const sim = new Simulator(t);
  ospfOn(r1, t, sim, '1.1.1.1');
  ospfOn(r2, t, sim, '2.2.2.2');
  ospfOn(r3, t, sim, '3.3.3.3');
  setInterfaces(r1, t, sim, [
    ['Gi0/0', '10.0.12.1', '255.255.255.0', 5],
    ['Gi0/1', '10.0.13.1', '255.255.255.0', 50],
    ['Gi0/2', '10.0.1.1', '255.255.255.0']
  ]);
  setInterfaces(r2, t, sim, [
    ['Gi0/0', '10.0.12.2', '255.255.255.0', 5],
    ['Gi0/1', '10.0.23.2', '255.255.255.0', 5]
  ]);
  setInterfaces(r3, t, sim, [
    ['Gi0/0', '10.0.23.3', '255.255.255.0', 5],
    ['Gi0/1', '10.0.13.3', '255.255.255.0', 50],
    ['Gi0/2', '10.0.3.3', '255.255.255.0']
  ]);
  return { t: t, sim: sim, r1: r1, r2: r2, r3: r3 };
}

{
  const lab = ospfTriangle();
  const res = lab.sim.computeOspf();

  const stub = ospfRouteOf(res[lab.r1.id], '10.0.3.0');
  eq(stub ? stub.cost : null, 20, 'the lower-cost transit path (20) beats the direct link (100)');
  eq(stub ? stub.nextHop : null, '10.0.12.2', 'the next hop is the cheap neighbour');

  // 10, not 20: 10.0.12.0 is advertised by both R1 (reached at 20 over the cheap
  // transit) and R2 (reached at 10); keeping the cheaper advertisement is what
  // #44 fixed, so R3 takes R2's.
  const back = ospfRouteOf(res[lab.r3.id], '10.0.12.0');
  eq(back ? back.cost : null, 10, 'the reverse route also avoids the expensive link');

  // Fixed in #42 (engine/simulator.js, route installation): computeOspf() used
  // to install an OSPF route for every interface of every reachable router,
  // including the root's own connected networks. 10.0.13.0/24 is directly
  // connected on R1 Gi0/1, so the connected route is the route and no code O
  // entry may appear for it -- the same rule routesFromSpt() already applies in
  // engine/ospf.js.
  const own = ospfRouteOf(res[lab.r1.id], '10.0.13.0');
  ok(own === null,
    'a router installs no OSPF route for a network it is directly connected to (#42)');
  eq(routeDestinations(res[lab.r1.id])
    .filter(function (d) { return ['10.0.12.0', '10.0.13.0', '10.0.1.0'].indexOf(d) !== -1; })
    .length, 0,
    'none of R1 own connected networks appears in its OSPF table (#42)');
}

{
  // Passive interface: the network must still be advertised as a stub.
  const t = new Topology();
  const a = newRouter(t, 'A');
  const b = newRouter(t, 'B');
  t.connect(a.id, 'Gi0/0', b.id, 'Gi0/0');
  const sim = new Simulator(t);
  ospfOn(a, t, sim, '1.1.1.1');
  ospfOn(b, t, sim, '2.2.2.2');
  setInterfaces(a, t, sim, [['Gi0/0', '10.0.12.1', '255.255.255.0'],
    ['Gi0/1', '10.0.1.1', '255.255.255.0']]);
  setInterfaces(b, t, sim, [['Gi0/0', '10.0.12.2', '255.255.255.0']]);

  cfg(a, t, sim, ['interface Gi0/1', 'ip ospf passive']);
  let res = sim.computeOspf();
  // Fixed in #43 (engine/simulator.js, interface collection): computeOspf()
  // used to drop a passive interface entirely, so its network was never
  // advertised. Real OSPF suppresses hellos but still puts the network in the
  // router LSA, so B learns it as a stub one hop away and no adjacency to A
  // hangs off Gi0/1.
  const stub = ospfRouteOf(res[b.id], '10.0.1.0');
  ok(stub !== null,
    'a passive interface network is still advertised as a stub (#43)');
  eq(stub ? stub.cost : null, 20,
    'and costs a single hop to the router that owns it (#43)');
  eq(stub ? stub.nextHop : null, '10.0.12.1',
    'with the active interface as the next hop, not the passive one (#43)');

  cfg(a, t, sim, ['interface Gi0/1', 'no ip ospf passive']);
  res = sim.computeOspf();
  ok(ospfRouteOf(res[b.id], '10.0.1.0') !== null,
    'the same network is advertised once the interface is active, isolating the passive handling');
}

{
  // The same network advertised by two routers: the table must keep the cheaper
  // advertisement (routesFromSpt in engine/ospf.js does exactly that).
  const t = new Topology();
  const r1 = newRouter(t, 'R1');
  const expensive = newRouter(t, 'X');   // lower device id, worse path
  const cheap = newRouter(t, 'Y');       // higher device id, better path
  t.connect(r1.id, 'Gi0/0', expensive.id, 'Gi0/0');
  t.connect(r1.id, 'Gi0/1', cheap.id, 'Gi0/0');
  t.connect(expensive.id, 'Gi0/1', cheap.id, 'Gi0/1');
  const sim = new Simulator(t);
  ospfOn(r1, t, sim, '1.1.1.1');
  ospfOn(expensive, t, sim, '2.2.2.2');
  ospfOn(cheap, t, sim, '3.3.3.3');
  setInterfaces(r1, t, sim, [
    ['Gi0/0', '10.0.1.1', '255.255.255.0', 200],
    ['Gi0/1', '10.0.2.1', '255.255.255.0', 5]
  ]);
  setInterfaces(expensive, t, sim, [
    ['Gi0/0', '10.0.1.2', '255.255.255.0', 5],
    ['Gi0/1', '10.0.23.2', '255.255.255.0', 200]
  ]);
  setInterfaces(cheap, t, sim, [
    ['Gi0/0', '10.0.2.2', '255.255.255.0', 5],
    ['Gi0/1', '10.0.23.3', '255.255.255.0', 200],
    // A stub reachable only through the cheap neighbour, so the SPF cost to that
    // neighbour stays observable now that a router no longer installs OSPF
    // routes for its own connected networks (#42).
    ['Gi0/2', '10.0.99.2', '255.255.255.0']
  ]);
  const res = sim.computeOspf();
  const near = ospfRouteOf(res[r1.id], '10.0.99.0');
  eq(near ? near.cost : null, 10, 'SPF reaches the cheap neighbour at cost 10');
  eq(near ? near.nextHop : null, '10.0.2.2', 'and installs that route out of the cheap interface');

  const shared = ospfRouteOf(res[r1.id], '10.0.23.0');
  ok(shared !== null, 'a network advertised by two routers is installed once');
  // Fixed in #44 (engine/simulator.js, route installation): computeOspf() kept
  // the first advertisement it met, so the cost of a shared network depended on
  // which router id the SPT happened to reach first. It keeps the lowest cost
  // now -- X reaches 10.0.23.0 at 205, Y at 10.
  eq(shared ? shared.cost : null, 10,
    'a network shared by two routers keeps the cheaper advertisement (10, not 205) (#44)');
  eq(shared ? shared.nextHop : null, '10.0.2.2',
    'and points at the cheap neighbour, whatever the device id order (#44)');
}

{
  // Two OSPF speakers cabled together but addressed in different subnets.
  const t = new Topology();
  const a = newRouter(t, 'A');
  const b = newRouter(t, 'B');
  t.connect(a.id, 'Gi0/0', b.id, 'Gi0/0');
  const sim = new Simulator(t);
  ospfOn(a, t, sim, '1.1.1.1');
  ospfOn(b, t, sim, '2.2.2.2');
  setInterfaces(a, t, sim, [['Gi0/0', '10.0.12.1', '255.255.255.0'],
    ['Gi0/1', '10.0.1.1', '255.255.255.0']]);
  setInterfaces(b, t, sim, [['Gi0/0', '10.0.99.2', '255.255.255.0'],
    ['Gi0/1', '10.0.2.2', '255.255.255.0']]);
  const res = sim.computeOspf();
  const bogus = ospfRouteOf(res[a.id], '10.0.2.0');
  // Real OSPF requires both ends of a broadcast link to share a subnet. Without
  // that check the adjacency forms from the cable alone and the route behind it
  // points at a next hop that is on no connected subnet (#240).
  eq(bogus, null,
    'no adjacency forms between interfaces addressed in different subnets (#240)');
  ok(!(res[a.id] || []).some(function (r) {
    return String(r.nextHop).indexOf('10.0.99.') === 0;
  }), 'no route is installed via an off-subnet next hop (#240)');

  // Same subnet, same mask: the adjacency is still built, so the check rejects
  // the mismatch rather than OSPF itself.
  const t2 = new Topology();
  const a2 = newRouter(t2, 'A2');
  const b2 = newRouter(t2, 'B2');
  t2.connect(a2.id, 'Gi0/0', b2.id, 'Gi0/0');
  const sim2 = new Simulator(t2);
  ospfOn(a2, t2, sim2, '3.3.3.3');
  ospfOn(b2, t2, sim2, '4.4.4.4');
  setInterfaces(a2, t2, sim2, [['Gi0/0', '10.0.12.1', '255.255.255.0'],
    ['Gi0/1', '10.0.1.1', '255.255.255.0']]);
  setInterfaces(b2, t2, sim2, [['Gi0/0', '10.0.12.2', '255.255.255.0'],
    ['Gi0/1', '10.0.2.2', '255.255.255.0']]);
  const res2 = sim2.computeOspf();
  const good = ospfRouteOf(res2[a2.id], '10.0.2.0');
  ok(good !== null, 'a matching subnet still forms an adjacency');
  eq(good ? good.nextHop : null, '10.0.12.2', 'and the next hop is the on-link neighbour');

  // A /24 cabled to a /25 that happens to hold the same addresses is a mismatch
  // too: the masks disagree, so neither end can agree on what "on-link" means.
  const t3 = new Topology();
  const a3 = newRouter(t3, 'A3');
  const b3 = newRouter(t3, 'B3');
  t3.connect(a3.id, 'Gi0/0', b3.id, 'Gi0/0');
  const sim3 = new Simulator(t3);
  ospfOn(a3, t3, sim3, '5.5.5.5');
  ospfOn(b3, t3, sim3, '6.6.6.6');
  setInterfaces(a3, t3, sim3, [['Gi0/0', '10.0.12.1', '255.255.255.0'],
    ['Gi0/1', '10.0.1.1', '255.255.255.0']]);
  setInterfaces(b3, t3, sim3, [['Gi0/0', '10.0.12.2', '255.255.255.128'],
    ['Gi0/1', '10.0.2.2', '255.255.255.0']]);
  const res3 = sim3.computeOspf();
  eq(ospfRouteOf(res3[a3.id], '10.0.2.0'), null,
    'no adjacency forms when the two ends disagree on the mask (#240)');
}

// ===========================================================================
// 5. VRRP
// ===========================================================================
section('5. VRRP: election, preemption and failover');

const VRRP_GROUP = { vrid: 42, advertSec: 1, preempt: true, ips: ['10.0.0.1'], interfaceName: 'Gi0/1' };

function vRouter(id, priority, ip, up) {
  return { id: id, priority: priority, ip: ip, up: (up === undefined) ? true : up };
}

{
  const elected = vrrp.electMaster([
    vRouter('r1', 150, '10.0.0.2'),
    vRouter('r2', 200, '10.0.0.3')
  ], VRRP_GROUP);
  eq(elected.masterId, 'r2', 'the higher priority router is elected master');
  eq(elected.reason, 'priority', 'the election reports priority as the reason');
  deq(elected.backups, ['r1'], 'the loser becomes a backup');

  const tied = vrrp.electMaster([
    vRouter('r1', 150, '10.0.0.9'),
    vRouter('r2', 150, '10.0.0.15')
  ], VRRP_GROUP);
  eq(tied.masterId, 'r2', 'equal priorities are broken by the higher interface address');
  eq(tied.reason, 'tiebreak-ip', 'the reason names the address tie-break');

  const identical = vrrp.electMaster([
    vRouter('r2', 150, '10.0.0.9'),
    vRouter('r1', 150, '10.0.0.9')
  ], VRRP_GROUP);
  eq(identical.masterId, 'r1', 'a full tie falls back to the lowest id, independent of input order');

  const owner = vrrp.electMaster([
    vRouter('r1', 100, '10.0.0.1'),
    vRouter('r2', 200, '10.0.0.3')
  ], VRRP_GROUP);
  eq(owner.masterId, 'r1', 'the address owner is implicitly priority 255 and wins');
  eq(owner.reason, 'owner', 'the election is reported as an owner win');

  const relinquished = vrrp.electMaster([vRouter('r1', 0, '10.0.0.2')], VRRP_GROUP);
  ok(relinquished.masterId === null && relinquished.reason === 'no-candidates',
    'priority 0 (master relinquished) does not participate');

  const halfDown = vrrp.electMaster([
    vRouter('r1', 200, '10.0.0.2', false),
    vRouter('r2', 100, '10.0.0.3')
  ], VRRP_GROUP);
  eq(halfDown.masterId, 'r2', 'a down router is excluded even with the highest priority');
}

{
  const routers = function () {
    return [vRouter('r1', 200, '10.0.0.2'), vRouter('r2', 100, '10.0.0.3')];
  };

  const preempted = vrrp.groupState(routers(), {
    preempt: true, currentMaster: 'r2', group: VRRP_GROUP
  });
  ok(preempted.masterId === 'r1' && preempted.changed === true,
    'with preemption a higher-priority router takes the mastership back');
  eq(preempted.reason, 'preempt', 'the transition is reported as preempt');
  eq(preempted.previousMasterId, 'r2', 'the previous master is reported');

  const held = vrrp.groupState(routers(), {
    preempt: false, currentMaster: 'r2', group: VRRP_GROUP
  });
  ok(held.masterId === 'r2' && held.changed === false,
    'without preemption the incumbent keeps the role');
  eq(held.reason, 'incumbent-keeps', 'and the result says so');

  const dead = vrrp.groupState([
    vRouter('r1', 200, '10.0.0.2'),
    vRouter('r2', 100, '10.0.0.3', false)
  ], { preempt: false, currentMaster: 'r2', group: VRRP_GROUP });
  ok(dead.masterId === 'r1' && dead.changed === true,
    'a dead master is replaced even when preemption is off');
  eq(dead.reason, 'failover', 'the transition is reported as failover');

  const stable = vrrp.groupState(routers(), {
    preempt: true, currentMaster: 'r1', group: VRRP_GROUP
  });
  ok(stable.masterId === 'r1' && stable.changed === false && stable.reason === 'unchanged',
    'a master that is still the best stays master with no transition');
}

{
  eq(vrrp.virtualMac(42), '00:00:5e:00:01:2a', 'the virtual MAC encodes the VRID in the last octet');
  ok(vrrp.virtualMac(42) !== vrrp.virtualMac(43), 'different VRIDs use different virtual MACs');
  eq(vrrp.skewTime({ priority: 100 }), 0.609375, 'skew time is (256 - priority) / 256');
  eq(vrrp.masterDownInterval({ advertSec: 1, priority: 100 }), 3.609375,
    'master-down is three advertisements plus the skew time');
  eq(vrrp.masterDownInterval({ advertCs: 25, priority: 100 }), 1.359375,
    'a 250 ms advertisement interval shortens the failover timer to 0.75 s + skew');
}

// ===========================================================================
// 6. DHCP
// ===========================================================================
section('6. DHCP: offer, lease, renewal, release and expiry');

const DHCP_RESERVED = 'aa:bb:cc:00:00:05';

function dhcpPool(over) {
  return Object.assign({
    name: 'lan1',
    network: '192.168.10.0',
    mask: '255.255.255.0',
    rangeStart: '192.168.10.100',
    rangeEnd: '192.168.10.105',
    gateway: '192.168.10.1',
    dns: ['192.168.10.1', '1.1.1.1'],
    reservations: { 'aa:bb:cc:00:00:05': '192.168.10.100' },
    excluded: [],
    leaseSec: 600
  }, over || {});
}

const MAC_A = '02:00:00:00:00:0a';
const MAC_B = '02:00:00:00:00:0b';
const MAC_C = '02:00:00:00:00:0c';

{
  const pool = dhcpPool();
  const state = dhcp.createLeaseState();

  const offer = dhcp.handleDiscover(pool, state, { mac: MAC_A, step: 0 });
  eq(offer ? offer.type : null, dhcp.DHCP_MESSAGE_TYPES.OFFER, 'DISCOVER is answered with an OFFER');
  eq(offer ? offer.ip : null, '192.168.10.101',
    'the reserved address is skipped, so the first client gets the next free one');
  eq(offer ? offer.gateway : null, '192.168.10.1', 'the OFFER carries the gateway');
  deq(offer ? offer.dns : [], ['192.168.10.1', '1.1.1.1'], 'the OFFER carries both DNS servers');
  eq(offer ? offer.leaseSec : null, 600, 'the OFFER carries the lease time');
  eq(dhcp.leaseTable(state).length, 0, 'an OFFER alone commits nothing');

  const ack = dhcp.handleRequest(pool, state, { mac: MAC_A, requestedIp: '192.168.10.101', step: 0 });
  eq(ack ? ack.type : null, dhcp.DHCP_MESSAGE_TYPES.ACK, 'REQUEST is acknowledged');
  eq(ack ? ack.expiresStep : null, 600, 'the lease expires at step + lease time');
  const table = dhcp.leaseTable(state);
  eq(table.length, 1, 'the ACK installed exactly one lease');
  ok(table[0].mac === MAC_A && table[0].ip === '192.168.10.101', 'the lease is bound to the client MAC');

  const bOffer = dhcp.handleDiscover(pool, state, { mac: MAC_B, step: 0 });
  eq(bOffer ? bOffer.ip : null, '192.168.10.102',
    'a second client is offered the next address, not the leased one');

  const reservedOffer = dhcp.handleDiscover(pool, state, { mac: DHCP_RESERVED, step: 0 });
  eq(reservedOffer ? reservedOffer.ip : null, '192.168.10.100',
    'a reservation always wins: its owner is offered the reserved address');

  const stolen = dhcp.handleRequest(pool, state, { mac: MAC_C, requestedIp: '192.168.10.100', step: 0 });
  eq(stolen ? stolen.type : null, dhcp.DHCP_MESSAGE_TYPES.NAK, 'a foreign MAC asking for a reserved address is NAKed');
  eq(stolen ? stolen.reason : null, 'RESERVED', 'the NAK names the reservation conflict');

  const renewed = dhcp.handleRequest(pool, state, { mac: MAC_A, requestedIp: '192.168.10.101', step: 100 });
  eq(renewed ? renewed.type : null, dhcp.DHCP_MESSAGE_TYPES.ACK, 'renewing the held address is ACKed, never NAKed');
  eq(renewed ? renewed.ip : null, '192.168.10.101', 'the renewal keeps the same address');
  eq(renewed ? renewed.expiresStep : null, 700, 'the renewal extends the lease by the full lease time');
  eq(dhcp.leaseTable(state).length, 1, 'a renewal does not create a second lease');

  eq(dhcp.releaseLease(pool, state, MAC_A), true, 'DHCPRELEASE drops the lease');
  eq(dhcp.leaseTable(state).length, 0, 'the lease table is empty after the release');
  const reused = dhcp.handleDiscover(pool, state, { mac: MAC_C, step: 200 });
  eq(reused ? reused.ip : null, '192.168.10.101', 'the released address is offered to the next client');
}

{
  const pool = dhcpPool();
  const state = dhcp.createLeaseState();
  const ack = dhcp.handleRequest(pool, state, { mac: MAC_A, requestedIp: '192.168.10.101', step: 20 });
  eq(ack ? ack.expiresStep : null, 620, 'a lease taken at step 20 with 600 s runs to step 620');
  eq(dhcp.expireLeases(state, 619), 0, 'one step before expiry the lease is still valid');
  eq(dhcp.expireLeases(state, 620), 1, 'reaching expiresStep releases the lease');
  eq(dhcp.leaseTable(state).length, 0, 'the expired lease is gone from the table');
  eq(state.byIp.size, 0, 'expiry also clears the reverse index');

  const moved = dhcp.handleRequest(pool, state, { mac: MAC_A, requestedIp: '192.168.10.105', step: 700 });
  eq(moved ? moved.type : null, dhcp.DHCP_MESSAGE_TYPES.ACK, 'a client may move to another free address');
  eq(state.byIp.has('192.168.10.101'), false, 'moving drops the old address binding');
  eq(dhcp.leaseTable(state).length, 1, 'a MAC holds at most one address');
}

{
  const pool = dhcpPool({ reservations: {}, excluded: ['192.168.10.100'] });
  const state = dhcp.createLeaseState();
  const offer = dhcp.handleDiscover(pool, state, { mac: MAC_A, step: 0 });
  eq(offer ? offer.ip : null, '192.168.10.101', 'an excluded address is skipped by the allocator');

  const excluded = dhcp.handleRequest(pool, state, { mac: MAC_A, requestedIp: '192.168.10.100', step: 0 });
  eq(excluded ? excluded.type : null, dhcp.DHCP_MESSAGE_TYPES.NAK, 'requesting an excluded address is NAKed');
  eq(excluded ? excluded.reason : null, 'EXCLUDED', 'the NAK names the exclusion');

  const outsidePool = dhcp.handleRequest(pool, state, { mac: MAC_A, requestedIp: '192.168.10.200', step: 0 });
  eq(outsidePool ? outsidePool.reason : null, 'OUTSIDE_POOL', 'an address outside the range is NAKed');

  const outsideSubnet = dhcp.handleRequest(pool, state, { mac: MAC_A, requestedIp: '10.9.9.9', step: 0 });
  eq(outsideSubnet ? outsideSubnet.reason : null, 'OUTSIDE_SUBNET',
    'an address outside the pool subnet is NAKed separately');
}

{
  const pool = dhcpPool({ rangeStart: '192.168.10.100', rangeEnd: '192.168.10.101', reservations: {} });
  const state = dhcp.createLeaseState();
  dhcp.handleRequest(pool, state, { mac: MAC_A, requestedIp: '192.168.10.100', step: 0 });
  dhcp.handleRequest(pool, state, { mac: MAC_B, requestedIp: '192.168.10.101', step: 0 });
  ok(dhcp.handleDiscover(pool, state, { mac: MAC_C, step: 0 }) === null,
    'a full pool produces no OFFER (the client stays silent, it is not NAKed)');
}

// ===========================================================================
// 7. NAT
// ===========================================================================
section('7. NAT: PAT, static and dynamic translation');

{
  const table = nat.createNatTable();
  table.rules.push({ type: 'pat', insideLocal: '192.168.1.0/24', insideGlobal: '203.0.113.5' });

  const original = {
    srcIp: '192.168.1.10', srcPort: 5000, dstIp: '198.51.100.9', dstPort: 80, protocol: 'tcp'
  };
  const out1 = nat.translateOutbound(table, original, 1);
  eq(out1.action, 'translate', 'a PAT rule matches an inside source');
  eq(out1.pkt.srcIp, '203.0.113.5', 'the source address is replaced by the global address');
  eq(out1.pkt.srcPort, 1024, 'PAT allocates the first port above the reserved range');
  eq(original.srcIp, '192.168.1.10', 'the caller packet is never mutated');
  eq(original.srcPort, 5000, 'the caller source port is never mutated either');

  const out2 = nat.translateOutbound(table, {
    srcIp: '192.168.1.11', srcPort: 5000, dstIp: '198.51.100.9', dstPort: 80, protocol: 'tcp'
  }, 1);
  eq(out2.pkt.srcIp, '203.0.113.5', 'a second host overloads the same global address');
  eq(out2.pkt.srcPort, 1025, 'and is told apart by a different global source port');
  ok(out1.pkt.srcPort !== out2.pkt.srcPort, 'the two inside hosts never share a global port');

  const repeat = nat.translateOutbound(table, {
    srcIp: '192.168.1.10', srcPort: 5000, dstIp: '198.51.100.9', dstPort: 80, protocol: 'tcp'
  }, 2);
  eq(repeat.pkt.srcPort, 1024, 'the same flow reuses its existing translation');
  eq(table.translations.length, 2, 'reusing a translation does not add a row');

  const reply = nat.translateInbound(table, {
    srcIp: '198.51.100.9', srcPort: 80, dstIp: '203.0.113.5', dstPort: 1024, protocol: 'tcp'
  }, 3);
  eq(reply.action, 'translate', 'an inbound reply to the global port is translated');
  eq(reply.pkt.dstIp, '192.168.1.10', 'the reply is sent to the original inside host');
  eq(reply.pkt.dstPort, 5000, 'and to the original source port');

  const reply2 = nat.translateInbound(table, {
    srcIp: '198.51.100.9', srcPort: 80, dstIp: '203.0.113.5', dstPort: 1025, protocol: 'tcp'
  }, 3);
  ok(reply2.pkt.dstIp === '192.168.1.11' && reply2.pkt.dstPort === 5000,
    'each global port maps back to its own inside host');

  const unknown = nat.translateInbound(table, {
    srcIp: '198.51.100.9', srcPort: 80, dstIp: '203.0.113.5', dstPort: 9999, protocol: 'tcp'
  }, 3);
  eq(unknown.action, 'pass', 'a packet to a port with no translation is left alone');

  const lines = nat.formatTable(table);
  eq(lines.length, 2, 'show ip nat translations prints one line per translation');
  ok(lines.every(function (l) { return /pat$/.test(l); }), 'each line ends with the translation type');

  // Fixed in #54 (engine/nat.js, flowKeyOf): a PAT translation was keyed on the
  // inside address, the destination and the protocol but not on the inside
  // source port, so every connection from one host to the same destination
  // reused one global port and the replies for all of them were delivered to
  // the first socket. The key is the full 5-tuple now.
  const secondSocket = nat.translateOutbound(table, {
    srcIp: '192.168.1.10', srcPort: 5001, dstIp: '198.51.100.9', dstPort: 80, protocol: 'tcp'
  }, 4);
  ok(secondSocket.pkt.srcPort !== 1024,
    'a second socket from the same host gets a global port of its own (#54)');
  const ownReply = nat.translateInbound(table, {
    srcIp: '198.51.100.9', srcPort: 80, dstIp: '203.0.113.5',
    dstPort: secondSocket.pkt.srcPort, protocol: 'tcp'
  }, 5);
  ok(ownReply.pkt.dstIp === '192.168.1.10' && ownReply.pkt.dstPort === 5001,
    'replies for the second socket reach that socket, not the first (#54)');
  eq(table.translations.length, 3, 'the second socket added a translation of its own (#54)');
}

{
  // Ageing: PAT entries expire after the protocol idle timeout, statics never do.
  eq(nat.DEFAULT_TIMEOUTS.udp, 300, 'the default UDP translation timeout is 300 steps');
  const table = nat.createNatTable();
  table.rules.push({ type: 'pat', insideLocal: '192.168.1.0/24', insideGlobal: '203.0.113.5' });
  nat.translateOutbound(table, {
    srcIp: '192.168.1.10', srcPort: 5000, dstIp: '8.8.8.8', dstPort: 53, protocol: 'udp'
  }, 10);
  eq(nat.expireTranslations(table, null, 309), 0, 'a PAT entry is kept until its idle timeout is reached');
  eq(nat.expireTranslations(table, null, 310), 1, 'a PAT entry idles out exactly at lastStep + timeout');

  const staticTable = nat.createNatTable();
  staticTable.rules.push({ type: 'static', insideLocal: '192.168.1.20', insideGlobal: '203.0.113.20' });
  nat.translateOutbound(staticTable, {
    srcIp: '192.168.1.20', srcPort: 1, dstIp: '8.8.8.8', dstPort: 53, protocol: 'udp'
  }, 10);
  eq(nat.expireTranslations(staticTable, null, 999999), 0,
    'static translations are configuration and never age out');
}

{
  const table = nat.createNatTable();
  table.rules.push({ type: 'static', insideLocal: '192.168.1.20', insideGlobal: '203.0.113.20' });
  const out = nat.translateOutbound(table, {
    srcIp: '192.168.1.20', srcPort: 1234, dstIp: '8.8.8.8', dstPort: 53, protocol: 'udp'
  }, 1);
  ok(out.pkt.srcIp === '203.0.113.20' && out.pkt.srcPort === 1234,
    'static NAT rewrites the address and leaves the port alone');
  const inbound = nat.translateInbound(table, {
    srcIp: '8.8.8.8', srcPort: 53, dstIp: '203.0.113.20', dstPort: 1234, protocol: 'udp'
  }, 2);
  ok(inbound.pkt.dstIp === '192.168.1.20' && inbound.pkt.dstPort === 1234,
    'and reverses the reply to the inside local address');
}

{
  const table = nat.createNatTable();
  table.rules.push({
    type: 'dynamic', insideLocal: '192.168.1.0/24',
    insideGlobal: '203.0.113.10-203.0.113.11'
  });
  const first = nat.translateOutbound(table, { srcIp: '192.168.1.10', dstIp: '8.8.8.8', protocol: 'icmp' }, 1);
  const second = nat.translateOutbound(table, { srcIp: '192.168.1.11', dstIp: '8.8.8.8', protocol: 'icmp' }, 1);
  eq(first.pkt.srcIp, '203.0.113.10', 'dynamic NAT takes the first address of the pool');
  eq(second.pkt.srcIp, '203.0.113.11', 'the next host takes the next pool address');
  const again = nat.translateOutbound(table, { srcIp: '192.168.1.10', dstIp: '192.0.2.1', protocol: 'icmp' }, 2);
  eq(again.pkt.srcIp, '203.0.113.10', 'a translated host keeps its global address for new destinations');
  const exhausted = nat.translateOutbound(table, { srcIp: '192.168.1.12', dstIp: '8.8.8.8', protocol: 'icmp' }, 1);
  eq(exhausted.action, 'drop', 'a third host cannot be translated when the pool is spent');
  eq(exhausted.reason, 'E_NAT_POOL_EXHAUSTED', 'the drop names pool exhaustion');
}

{
  // The data path: a TCP flow from inside to outside must be translated both ways.
  const t = new Topology();
  const pc = newPc(t, 'PC1');
  const r1 = newRouter(t, 'R1');
  const srv = t.addDevice(model('generic-server'));
  srv.name = 'WEB';
  t.connect(pc.id, 'eth0', r1.id, 'Gi0/0');
  t.connect(r1.id, 'Gi0/1', srv.id, 'eth0');
  const sim = new Simulator(t);
  setInterfaces(pc, t, sim, [['eth0', '192.168.1.10', '255.255.255.0']]);
  cfg(pc, t, sim, ['ip default-gateway 192.168.1.1']);
  setInterfaces(r1, t, sim, [['Gi0/0', '192.168.1.1', '255.255.255.0'],
    ['Gi0/1', '203.0.113.1', '255.255.255.0']]);
  setInterfaces(srv, t, sim, [['eth0', '203.0.113.9', '255.255.255.0']]);
  cfg(srv, t, sim, ['ip default-gateway 203.0.113.1']);
  r1.config.nat = { rules: [{ type: 'pat', insideLocal: '192.168.1.0/24', insideGlobal: '203.0.113.1' }] };

  const flow = sim.openFlow({ proto: 'tcp', srcDevice: pc.id, dstDevice: srv.id, dstPort: 80, bytes: 500 });
  eq(flow.ok, true, 'a TCP flow through a PAT router opens successfully');

  const natEvents = sim.events.filter(function (e) { return e.type === 'nat-outbound' || e.type === 'nat-inbound'; });
  const outbound = natEvents.filter(function (e) { return e.type === 'nat-outbound'; });
  const inbound = natEvents.filter(function (e) { return e.type === 'nat-inbound'; });
  ok(outbound.length >= 1, 'the outbound packets are translated');
  ok(inbound.length >= 1, 'the replies are translated back');
  eq(outbound[0].insideGlobal, '203.0.113.1', 'the global address visible outside is the PAT address');
  ok(outbound[0].globalPort >= 1024, 'the outside world sees an overloaded source port');
  eq(inbound[0].insideLocal, '192.168.1.10', 'the reply is restored to the inside host');
  eq(inbound[0].localPort, outbound[0].localPort,
    'the reply reaches the original inside source port');

  const translations = nat.formatTable(sim._natTableOf(r1));
  eq(translations.length, 1, 'the whole conversation uses a single PAT translation');
}

// ===========================================================================
// 8. DNS
// ===========================================================================
section('8. DNS: CNAME chains, negative answers, cache and host resolution');

function dnsZone(over) {
  return Object.assign({
    name: 'lab',
    defaultTtl: 300,
    records: [
      { name: 'lab', type: 'SOA', value: 'ns1.lab. hostmaster.lab. 1 3600 600 86400 300' },
      { name: 'lab', type: 'NS', value: 'ns1.lab.' },
      { name: 'ns1', type: 'A', value: '10.0.0.53' },
      { name: 'web', type: 'A', value: '10.0.0.10' },
      { name: 'web', type: 'A', value: '10.0.0.11' },
      { name: 'www', type: 'CNAME', value: 'web.lab' },
      { name: 'alias', type: 'CNAME', value: 'www.lab' },
      { name: 'txt', type: 'TXT', value: 'v=spf1 -all' }
    ]
  }, over || {});
}

const ZONE = dnsZone();

function answerTypes(res) {
  return (res.answers || []).map(function (a) { return a.type; });
}

function answerValues(res) {
  return (res.answers || []).map(function (a) { return a.value; });
}

{
  const chained = dns.resolve(ZONE, 'alias.lab', 'A');
  eq(chained.rcode, dns.RCODE.NOERROR, 'a CNAME chain resolves with NOERROR');
  deq(chained.cnameChain, ['alias.lab', 'www.lab'], 'every CNAME owner is reported in the chain');
  deq(answerTypes(chained), ['CNAME', 'CNAME', 'A', 'A'],
    'the answer section holds both CNAMEs followed by every A record of the target');
  deq(answerValues(chained).slice(2), ['10.0.0.10', '10.0.0.11'],
    'both addresses of the target name are returned');

  const single = dns.resolve(ZONE, 'www.lab', 'A');
  deq(single.cnameChain, ['www.lab'], 'a single-hop CNAME chain records one owner');
  deq(answerTypes(single), ['CNAME', 'A', 'A'], 'and returns the CNAME plus the A records');

  const direct = dns.resolve(ZONE, 'web.lab', 'A');
  eq(direct.cnameChain.length, 0, 'a direct A query has no CNAME chain');
  eq(direct.answers.length, 2, 'every A record for the name is returned');

  const emptyTarget = dns.resolve(ZONE, 'alias.lab', 'AAAA');
  deq(answerTypes(emptyTarget), ['CNAME', 'CNAME'],
    'a chain that ends at a name with no record of the requested type returns only the CNAMEs');
  eq(emptyTarget.rcode, dns.RCODE.NOERROR, 'that is still a NOERROR answer, not an error');

  const normalised = dns.resolve(ZONE, 'WWW.Lab.', 'A');
  deq(answerTypes(normalised), ['CNAME', 'A', 'A'],
    'owner names are case-insensitive and ignore the trailing dot');
}

{
  const missing = dns.resolve(ZONE, 'nope.lab', 'A');
  eq(missing.rcode, dns.RCODE.NXDOMAIN, 'an unknown name is NXDOMAIN');
  eq(missing.answers.length, 0, 'nothing is answered for an unknown name');

  const nodata = dns.resolve(ZONE, 'txt.lab', 'A');
  ok(nodata.rcode === dns.RCODE.NOERROR && nodata.answers.length === 0,
    'a name that exists without the requested type is NOERROR with an empty answer section');

  const brokenChain = dns.resolve({
    name: 'lab', records: [{ name: 'dead', type: 'CNAME', value: 'gone.lab' }]
  }, 'dead.lab', 'A');
  eq(brokenChain.rcode, dns.RCODE.NXDOMAIN, 'a CNAME pointing at a name that does not exist is NXDOMAIN');
  deq(answerTypes(brokenChain), ['CNAME'], 'the partial chain is still returned');

  const loop = dns.resolve({
    name: 'cyc',
    records: [
      { name: 'a', type: 'CNAME', value: 'b.cyc' },
      { name: 'b', type: 'CNAME', value: 'a.cyc' }
    ]
  }, 'a.cyc', 'A');
  eq(loop.rcode, dns.RCODE.SERVFAIL, 'a CNAME loop is SERVFAIL, never an infinite loop');
  eq(loop.answers.length, 0, 'SERVFAIL drops the answer section');
  ok(loop.note.indexOf('loop') !== -1, 'the note explains where resolution gave up');
}

{
  function chainZone(depth) {
    const records = [];
    for (let i = 0; i < depth; i++) {
      records.push({ name: 'd' + i, type: 'CNAME', value: 'd' + (i + 1) + '.ch' });
    }
    records.push({ name: 'd' + depth, type: 'A', value: '10.9.9.9' });
    return { name: 'ch', defaultTtl: 60, records: records };
  }
  eq(dns.MAX_CNAME_DEPTH, 8, 'the resolver bounds CNAME depth at 8 hops');
  const atLimit = dns.resolve(chainZone(dns.MAX_CNAME_DEPTH), 'd0.ch', 'A');
  eq(atLimit.rcode, dns.RCODE.NOERROR, 'a chain of exactly the maximum depth resolves');
  eq(atLimit.answers.length, dns.MAX_CNAME_DEPTH + 1, 'it returns every link plus the final A record');
  const pastLimit = dns.resolve(chainZone(dns.MAX_CNAME_DEPTH + 1), 'd0.ch', 'A');
  eq(pastLimit.rcode, dns.RCODE.SERVFAIL, 'one hop past the limit is SERVFAIL');
  eq(pastLimit.answers.length, 0, 'the over-long chain answers nothing');
}

{
  const cache = dns.createCache();
  const answers = dns.resolve(ZONE, 'alias.lab', 'A').answers;
  dns.cachePut(cache, 'alias.lab', 'A', answers, 60, 10);
  const hit = dns.cacheLookup(cache, 'alias.lab', 'A', 50);
  ok(hit.hit === true, 'a stored answer is served from the cache inside its TTL');
  eq(hit.ttlRemaining, 20, 'the remaining TTL counts down from the step it was stored at');
  const wrongType = dns.cacheLookup(cache, 'alias.lab', 'AAAA', 50);
  eq(wrongType.hit, false, 'the cache key includes the query type');
  const mixedCase = dns.cacheLookup(cache, 'ALIAS.Lab.', 'A', 50);
  eq(mixedCase.hit, true, 'the cache key normalises case and the trailing dot');
  eq(dns.cacheLookup(cache, 'alias.lab', 'A', 70).hit, false, 'the entry expires exactly at its TTL');
  eq(cache.entries.size, 0, 'an expired entry is evicted lazily');

  eq(dns.reverseName('10.0.0.53'), '53.0.0.10.in-addr.arpa', 'reverseName builds the in-addr.arpa name');
}

{
  // Host resolution: PC1 asks DNS1 for a name that is a CNAME chain, then pings it.
  const t = new Topology();
  const pc = newPc(t, 'PC1');
  const web = t.addDevice(model('generic-server'));
  web.name = 'WEB';
  const dnsd = t.addDevice(model('generic-server'));
  dnsd.name = 'DNS1';
  const sw = t.addDevice(model('generic-switch'));
  sw.name = 'SW1';
  t.connect(pc.id, 'eth0', sw.id, 'Fa0/1');
  t.connect(web.id, 'eth0', sw.id, 'Fa0/2');
  t.connect(dnsd.id, 'eth0', sw.id, 'Fa0/3');
  const sim = new Simulator(t);
  setInterfaces(pc, t, sim, [['eth0', '10.0.0.10', '255.255.255.0']]);
  setInterfaces(web, t, sim, [['eth0', '10.0.0.80', '255.255.255.0']]);
  setInterfaces(dnsd, t, sim, [['eth0', '10.0.0.53', '255.255.255.0']]);
  cfg(dnsd, t, sim, ['dns zone lab', 'dns add web A 10.0.0.80', 'dns add www CNAME web.lab',
    'dns add txt TXT hello']);

  const resolved = sim.resolveName(pc, 'www.lab');
  ok(resolved.ok === true, 'a host resolves a CNAME through the lab DNS server');
  eq(resolved.address, '10.0.0.80', 'the address of the end of the chain is returned');
  eq(resolved.server, 'DNS1', 'the answering server is reported');

  const ping = sim.ping(pc.id, 'www.lab', { count: 2 });
  eq(ping.resolved, '10.0.0.80', 'ping resolves the name before sending anything');
  ok(allUp(ping.replies), 'and the pinged host answers at the resolved address');
  const dnsEvent = sim.events.filter(function (e) { return e.type === 'dns'; })[0];
  ok(dnsEvent && dnsEvent.ok === true && dnsEvent.address === '10.0.0.80',
    'the run log records the DNS lookup and its answer');
  ok(dnsEvent && dnsEvent.rcode === dns.RCODE.NOERROR, 'the logged rcode is NOERROR');

  // Three failures, three answers. A name that exists without an A record is
  // NODATA (NOERROR, zero answers), not a missing domain (#241).
  const nodata = sim.resolveName(pc, 'txt.lab');
  eq(nodata.ok, false, 'a name with no A record cannot be used by a host');
  eq(nodata.rcode, dns.RCODE.NOERROR,
    'NODATA is NOERROR with an empty answer, not NXDOMAIN (#241)');
  eq(nodata.status, 'NODATA', 'and the result says which failure it was (#241)');
  eq(nodata.answers.length, 0, 'with no answers');

  const missing = sim.resolveName(pc, 'nosuch.lab');
  eq(missing.rcode, dns.RCODE.NXDOMAIN, 'a name the zone does not hold is NXDOMAIN');
  eq(missing.status, 'NXDOMAIN', 'and is reported as such (#241)');

  // A lab with no DNS server at all cannot answer for any name: that is a server
  // failure, not a statement about the name.
  const bare = new Topology();
  const lonely = newPc(bare, 'LONELY');
  const simBare = new Simulator(bare);
  setInterfaces(lonely, bare, simBare, [['eth0', '10.9.9.9', '255.255.255.0']]);
  const noServer = simBare.resolveName(lonely, 'www.lab');
  eq(noServer.rcode, dns.RCODE.SERVFAIL,
    'no server hosting a zone is SERVFAIL, not NXDOMAIN (#241)');
  eq(noServer.status, 'SERVFAIL', 'and says so');

  // The ping path reports the same distinction instead of always saying nxdomain.
  const pingNodata = sim.ping(pc.id, 'txt.lab', { count: 1 });
  eq(pingNodata.replies[0].reason, 'dns-nodata',
    'a ping to a NODATA name fails as dns-nodata, not dns-nxdomain (#241)');
  const pingMissing = sim.ping(pc.id, 'nosuch.lab', { count: 1 });
  eq(pingMissing.replies[0].reason, 'dns-nxdomain',
    'and a genuinely missing name still fails as dns-nxdomain');
}

// ---------------------------------------------------------------------------
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
