'use strict';
// ospf.test.js -- unit tests for the OSPF adjacency / SPF model.
// Plain ok() assertions, no framework. Fixtures are hand-built plain objects so
// engine/ospf.js is exercised in isolation (no simulator, no CLI, no server).

const ospf = require('../engine/ospf');

let passed = 0;
let failed = 0;

function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log('  \u2713 ' + msg);
  } else {
    failed++;
    console.error('  \u2717 ' + msg);
  }
}

function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function codes(list) {
  return (list || []).map(function (e) { return e.code; });
}

function hasCode(list, code) {
  return codes(list).indexOf(code) !== -1;
}

function routeTo(routes, dest, mask) {
  for (const r of routes) {
    if (r.dest === dest && (mask === undefined || r.mask === mask)) return r;
  }
  return null;
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

// Three area-0 routers in a triangle. The direct r1-r3 link is deliberately
// the expensive one (100+100), so traffic must transit r2 (10+10 each way).
function triangle() {
  const routers = [
    {
      id: 'r1', routerId: '1.1.1.1', areaId: 0, interfaces: [
        { name: 'e12', ip: '10.0.12.1', mask: '255.255.255.0', cost: 10 },
        { name: 'e13', ip: '10.0.13.1', mask: '255.255.255.0', cost: 100 },
        { name: 'lo', ip: '10.0.1.1', mask: '255.255.255.255' }
      ]
    },
    {
      id: 'r2', routerId: '2.2.2.2', areaId: 0, interfaces: [
        { name: 'e12', ip: '10.0.12.2', mask: '255.255.255.0', cost: 10 },
        { name: 'e23', ip: '10.0.23.2', mask: '255.255.255.0', cost: 10 },
        { name: 'lo', ip: '10.0.2.2', mask: '255.255.255.255' }
      ]
    },
    {
      id: 'r3', routerId: '3.3.3.3', areaId: 0, interfaces: [
        { name: 'e13', ip: '10.0.13.3', mask: '255.255.255.0', cost: 100 },
        { name: 'e23', ip: '10.0.23.3', mask: '255.255.255.0', cost: 10 },
        { name: 'lo', ip: '10.0.3.3', mask: '255.255.255.255' }
      ]
    }
  ];
  const links = [
    { a: { router: 'r1', iface: 'e12' }, b: { router: 'r2', iface: 'e12' } },
    { a: { router: 'r2', iface: 'e23' }, b: { router: 'r3', iface: 'e23' } },
    { a: { router: 'r1', iface: 'e13' }, b: { router: 'r3', iface: 'e13' } }
  ];
  return { routers: routers, links: links };
}

// Two areas: r1-r2 inside area 0, r1-r5 across the area boundary.
function twoAreas() {
  const routers = [
    {
      id: 'r1', routerId: '1.1.1.1', areaId: 0, interfaces: [
        { name: 'e12', ip: '10.0.12.1', mask: '255.255.255.0', cost: 10 },
        { name: 'x', ip: '10.0.15.1', mask: '255.255.255.0' }
      ]
    },
    {
      id: 'r2', routerId: '2.2.2.2', areaId: 0, interfaces: [
        { name: 'e12', ip: '10.0.12.2', mask: '255.255.255.0', cost: 10 }
      ]
    },
    {
      id: 'r5', routerId: '5.5.5.5', areaId: 1, interfaces: [
        { name: 'x', ip: '10.0.15.5', mask: '255.255.255.0' }
      ]
    }
  ];
  const links = [
    { a: { router: 'r1', iface: 'e12' }, b: { router: 'r2', iface: 'e12' } },
    { a: { router: 'r1', iface: 'x' }, b: { router: 'r5', iface: 'x' } }
  ];
  return { routers: routers, links: links };
}

// Equal-cost diamond: r1 -> {r2, r3} -> r4, every link the same cost, so only
// the tie-break decides which next hop wins. No interface costs anywhere, so
// the links' own cost is used.
function diamond() {
  const routers = [
    {
      id: 'r1', routerId: '1.1.1.1', areaId: 0, interfaces: [
        { name: 'a1', ip: '10.1.12.1', mask: '255.255.255.0' },
        { name: 'a2', ip: '10.1.13.1', mask: '255.255.255.0' },
        { name: 'lo', ip: '10.0.1.1', mask: '255.255.255.255' }
      ]
    },
    {
      id: 'r2', routerId: '2.2.2.2', areaId: 0, interfaces: [
        { name: 'b1', ip: '10.1.12.2', mask: '255.255.255.0' },
        { name: 'b4', ip: '10.1.24.2', mask: '255.255.255.0' },
        { name: 'lo', ip: '10.0.2.2', mask: '255.255.255.255', passive: true }
      ]
    },
    {
      id: 'r3', routerId: '3.3.3.3', areaId: 0, interfaces: [
        { name: 'c1', ip: '10.1.13.3', mask: '255.255.255.0' },
        { name: 'c4', ip: '10.1.34.3', mask: '255.255.255.0' },
        { name: 'lo', ip: '10.0.3.3', mask: '255.255.255.255', passive: true }
      ]
    },
    {
      id: 'r4', routerId: '4.4.4.4', areaId: 0, interfaces: [
        { name: 'd2', ip: '10.1.24.4', mask: '255.255.255.0' },
        { name: 'd3', ip: '10.1.34.4', mask: '255.255.255.0' },
        { name: 'lo', ip: '10.0.4.4', mask: '255.255.255.255', passive: true }
      ]
    }
  ];
  const links = [
    { a: { router: 'r1', iface: 'a1' }, b: { router: 'r2', iface: 'b1' }, cost: 10 },
    { a: { router: 'r1', iface: 'a2' }, b: { router: 'r3', iface: 'c1' }, cost: 10 },
    { a: { router: 'r2', iface: 'b4' }, b: { router: 'r4', iface: 'd2' }, cost: 10 },
    { a: { router: 'r3', iface: 'c4' }, b: { router: 'r4', iface: 'd3' }, cost: 10 }
  ];
  return { routers: routers, links: links };
}

function jsonOfSpt(spt) {
  return JSON.stringify(Array.from(spt.entries()));
}

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

console.log('constants');
ok(ospf.OSPF_PROTOCOL === 89, 'OSPF_PROTOCOL is IP protocol 89');
ok(ospf.OSPF_ADMIN_DISTANCE === 110, 'OSPF_ADMIN_DISTANCE is 110');
ok(ospf.OSPF_ADMIN_DISTANCE > 90 && ospf.OSPF_ADMIN_DISTANCE < 115,
  'admin distance 110 beats EIGRP 90 and loses to IS-IS 115');
ok(ospf.DEFAULT_COST === 10, 'DEFAULT_COST is 10');
ok(ospf.DEFAULT_HELLO_SEC === 10, 'DEFAULT_HELLO_SEC is 10');
ok(ospf.DEFAULT_DEAD_SEC === 40, 'DEFAULT_DEAD_SEC is 40');
ok(ospf.DEFAULT_DEAD_SEC === 4 * ospf.DEFAULT_HELLO_SEC, 'dead interval is 4x the hello interval');

// ---------------------------------------------------------------------------
// validateRouter
// ---------------------------------------------------------------------------

console.log('\nvalidateRouter');
{
  const good = ospf.validateRouter({
    routerId: '1.1.1.1',
    areaId: 0,
    interfaces: [
      { name: 'e12', ip: '10.0.12.1', mask: '255.255.255.0', cost: 10 },
      { name: 'lo', ip: '10.0.1.1', mask: '255.255.255.255', passive: true }
    ]
  });
  ok(good.ok === true && good.errors.length === 0, 'a well-formed router validates clean');

  const noId = ospf.validateRouter({ interfaces: [{ name: 'e0', ip: '10.0.0.1', mask: '255.255.255.0' }] });
  ok(noId.ok === false && hasCode(noId.errors, 'BAD_ROUTER_ID'), 'missing routerId -> BAD_ROUTER_ID');

  const shortId = ospf.validateRouter({ routerId: '1.1.1', interfaces: [] });
  ok(hasCode(shortId.errors, 'BAD_ROUTER_ID'), 'short routerId "1.1.1" -> BAD_ROUTER_ID');

  const bigOctet = ospf.validateRouter({ routerId: '300.1.1.1', interfaces: [] });
  ok(hasCode(bigOctet.errors, 'BAD_ROUTER_ID'), 'routerId with an octet > 255 -> BAD_ROUTER_ID');

  const noIfaces = ospf.validateRouter({ routerId: '1.1.1.1', interfaces: [] });
  ok(hasCode(noIfaces.errors, 'NO_INTERFACES'), 'empty interface list -> NO_INTERFACES');

  const badIp = ospf.validateRouter({
    routerId: '1.1.1.1',
    interfaces: [{ name: 'e0', ip: '10.0.0.256', mask: '255.255.255.0' }]
  });
  ok(hasCode(badIp.errors, 'IFACE_BAD_IP'), 'interface ip 10.0.0.256 -> IFACE_BAD_IP');

  const missingIp = ospf.validateRouter({
    routerId: '1.1.1.1',
    interfaces: [{ name: 'e0', mask: '255.255.255.0' }]
  });
  ok(hasCode(missingIp.errors, 'IFACE_NO_IP'), 'interface without an ip -> IFACE_NO_IP');

  const netAddr = ospf.validateRouter({
    routerId: '1.1.1.1',
    interfaces: [{ name: 'e0', ip: '10.0.12.0', mask: '255.255.255.0' }]
  });
  ok(hasCode(netAddr.errors, 'IFACE_NOT_IN_NETWORK'), 'network address 10.0.12.0/24 -> IFACE_NOT_IN_NETWORK');

  const bcast = ospf.validateRouter({
    routerId: '1.1.1.1',
    interfaces: [{ name: 'e0', ip: '10.0.12.255', mask: '255.255.255.0' }]
  });
  ok(hasCode(bcast.errors, 'IFACE_NOT_IN_NETWORK'), 'broadcast address 10.0.12.255/24 -> IFACE_NOT_IN_NETWORK');

  const badMask = ospf.validateRouter({
    routerId: '1.1.1.1',
    interfaces: [{ name: 'e0', ip: '10.0.12.1', mask: '255.0.255.0' }]
  });
  ok(hasCode(badMask.errors, 'IFACE_BAD_MASK'), 'non-contiguous mask 255.0.255.0 -> IFACE_BAD_MASK');

  const dupName = ospf.validateRouter({
    routerId: '1.1.1.1',
    interfaces: [
      { name: 'e0', ip: '10.0.12.1', mask: '255.255.255.0' },
      { name: 'e0', ip: '10.0.13.1', mask: '255.255.255.0' }
    ]
  });
  ok(hasCode(dupName.errors, 'DUPLICATE_IFACE'), 'two interfaces named e0 -> DUPLICATE_IFACE');

  const dupSubnet = ospf.validateRouter({
    routerId: '1.1.1.1',
    interfaces: [
      { name: 'e0', ip: '10.0.12.1', mask: '255.255.255.0' },
      { name: 'e1', ip: '10.0.12.2', mask: '255.255.255.0' }
    ]
  });
  ok(hasCode(dupSubnet.errors, 'DUPLICATE_SUBNET'), 'two interfaces in 10.0.12.0/24 -> DUPLICATE_SUBNET');

  const badCost = ospf.validateRouter({
    routerId: '1.1.1.1',
    interfaces: [{ name: 'e0', ip: '10.0.12.1', mask: '255.255.255.0', cost: 0 }]
  });
  ok(hasCode(badCost.errors, 'IFACE_BAD_COST'), 'interface cost 0 -> IFACE_BAD_COST');

  const badArea = ospf.validateRouter({ routerId: '1.1.1.1', areaId: 'area-1', interfaces: [{ name: 'e0', ip: '10.0.12.1', mask: '255.255.255.0' }] });
  ok(hasCode(badArea.errors, 'BAD_AREA_ID'), 'areaId "area-1" -> BAD_AREA_ID');

  const badTimers = ospf.validateRouter({
    routerId: '1.1.1.1',
    helloSec: 10,
    deadSec: 5,
    interfaces: [{ name: 'e0', ip: '10.0.12.1', mask: '255.255.255.0' }]
  });
  ok(hasCode(badTimers.errors, 'BAD_TIMERS'), 'deadSec 5 with helloSec 10 -> BAD_TIMERS');

  const shapes = ospf.validateRouter({ routerId: 'nope', interfaces: [{ cost: 0 }] });
  let shaped = shapes.errors.length > 0;
  for (const e of shapes.errors) {
    if (typeof e.code !== 'string' || typeof e.message !== 'string' || !e.message) shaped = false;
  }
  ok(shaped, 'every error carries a non-empty string code and message');
  ok(codes(shapes.errors).indexOf('BAD_ROUTER_ID') === 0, 'router-level errors are reported first');
}

// ---------------------------------------------------------------------------
// buildGraph / adjacencies
// ---------------------------------------------------------------------------

console.log('\nbuildGraph / adjacencies');
{
  const tri = triangle();
  const g = ospf.buildGraph(tri.routers, tri.links);
  ok(g.nodes.length === 3, 'triangle graph has 3 nodes');
  ok(g.edges.length === 3, 'triangle graph has 3 edges');
  ok(eq(g.nodes.map(function (n) { return n.id; }), ['r1', 'r2', 'r3']), 'nodes are sorted by router id');

  const adj = ospf.adjacencies(g);
  ok(adj.length === 3, 'one adjacency per edge');
  ok(eq(adj[0], { a: 'r1', b: 'r2', cost: 20, costA: 10, costB: 10 }),
    'r1-r2 adjacency cost is costA + costB (10 + 10)');
  ok(adj[1].cost === 200, 'r1-r3 adjacency cost is 100 + 100');
  ok(adj[2].a === 'r2' && adj[2].b === 'r3' && adj[2].cost === 20, 'r2-r3 adjacency is 20');
  ok(adj[0].a === 'r1' && adj[0].b === 'r2', 'endpoints are stored in canonical (sorted) order');

  // Link cost is ignored when both interfaces carry an explicit cost.
  const overridden = ospf.buildGraph(tri.routers, [
    { a: { router: 'r1', iface: 'e12' }, b: { router: 'r2', iface: 'e12' }, cost: 999 }
  ]);
  ok(overridden.edges[0].cost === 20, 'explicit interface costs beat the link cost (999 ignored)');

  // Only one side configured -> the link's own cost wins.
  const pair = ospf.buildGraph([
    { id: 'p1', routerId: '1.1.1.1', areaId: 0, interfaces: [{ name: 'e', ip: '192.168.1.1', mask: '255.255.255.0', cost: 5 }] },
    { id: 'p2', routerId: '2.2.2.2', areaId: 0, interfaces: [{ name: 'e', ip: '192.168.1.2', mask: '255.255.255.0' }] }
  ], [{ a: { router: 'p1', iface: 'e' }, b: { router: 'p2', iface: 'e' }, cost: 42 }]);
  ok(eq(ospf.adjacencies(pair), [{ a: 'p1', b: 'p2', cost: 42, costA: 5, costB: null }]),
    'one unconfigured side falls back to the link cost, costB stays null');

  // No cost anywhere -> DEFAULT_COST.
  const bare = ospf.buildGraph([
    { id: 'b1', routerId: '1.1.1.1', areaId: 0, interfaces: [{ name: 'e', ip: '172.16.0.1', mask: '255.255.255.0' }] },
    { id: 'b2', routerId: '2.2.2.2', areaId: 0, interfaces: [{ name: 'e', ip: '172.16.0.2', mask: '255.255.255.0' }] }
  ], [{ a: { router: 'b1', iface: 'e' }, b: { router: 'b2', iface: 'e' } }]);
  ok(bare.edges[0].cost === ospf.DEFAULT_COST, 'no interface or link cost falls back to DEFAULT_COST');

  // Broken endpoints are dropped, not fatal.
  const broken = ospf.buildGraph(tri.routers, [
    { a: { router: 'r1', iface: 'nope' }, b: { router: 'r2', iface: 'e12' } },
    { a: { router: 'r1', iface: 'e12' }, b: { router: 'ghost', iface: 'e12' } },
    { a: { router: 'r1', iface: 'e12' }, b: { router: 'r1', iface: 'e13' } },
    { a: { router: 'r1', iface: 'e12' }, b: { router: 'r2', iface: 'e12' } }
  ]);
  ok(broken.edges.length === 1, 'unknown iface, unknown router and self-links are skipped');
  ok(ospf.adjacencies({ nodes: [], edges: [] }).length === 0, 'adjacencies of an empty graph is empty');
}

// ---------------------------------------------------------------------------
// cross-area links
// ---------------------------------------------------------------------------

console.log('\ncross-area links');
{
  const two = twoAreas();
  const g = ospf.buildGraph(two.routers, two.links);
  ok(g.nodes.length === 3, 'both areas contribute nodes (3)');
  ok(g.edges.length === 1, 'the area-1 link is not an adjacency (1 edge left)');
  ok(ospf.adjacencies(g)[0].a === 'r1' && ospf.adjacencies(g)[0].b === 'r2',
    'only the intra-area r1-r2 link survives');
  ok(g.nodes.filter(function (n) { return n.id === 'r5'; })[0].areaId === 1, 'r5 keeps areaId 1');

  // An interface-level area overrides the router's area: r1's "x" port joins
  // area 1 and the r1-r5 link becomes an adjacency.
  const abr = JSON.parse(JSON.stringify(two.routers));
  abr[0].interfaces[1].area = 1;
  const g2 = ospf.buildGraph(abr, two.links);
  ok(g2.edges.length === 2, 'interface area override makes the cross-area link usable');
  ok(ospf.spf(g2, 'r1').has('r5'), 'r5 is reachable once the areas line up');

  // '0.0.0.0' and 0 are the same area.
  const dotted = ospf.buildGraph([
    { id: 'r1', routerId: '1.1.1.1', areaId: '0.0.0.0', interfaces: [{ name: 'e', ip: '10.0.12.1', mask: '255.255.255.0', cost: 10 }] },
    { id: 'r2', routerId: '2.2.2.2', areaId: 0, interfaces: [{ name: 'e', ip: '10.0.12.2', mask: '255.255.255.0', cost: 10 }] }
  ], [{ a: { router: 'r1', iface: 'e' }, b: { router: 'r2', iface: 'e' } }]);
  ok(dotted.edges.length === 1 && dotted.nodes[0].areaId === 0,
    "areaId '0.0.0.0' normalises to 0 and matches area 0");
}

// ---------------------------------------------------------------------------
// spf
// ---------------------------------------------------------------------------

console.log('\nspf');
{
  const tri = triangle();
  const g = ospf.buildGraph(tri.routers, tri.links);
  const spt = ospf.spf(g, 'r1');

  ok(spt.size === 3, 'SPF from r1 reaches all 3 routers');
  ok(eq(spt.get('r1'), { cost: 0, nextHopRouterId: null, path: ['r1'] }),
    'the root costs 0 and has no next hop');
  ok(spt.get('r2').cost === 20, 'r1->r2 costs 20');
  ok(spt.get('r3').cost === 40, 'r1->r3 costs 40 via r2, not the 200 direct link');
  ok(eq(spt.get('r3').path, ['r1', 'r2', 'r3']), 'r3 path is r1 -> r2 -> r3');
  ok(spt.get('r3').nextHopRouterId === 'r2', 'r3 next hop is r2');
  ok(spt.get('r2').nextHopRouterId === 'r2', 'a directly connected router is its own next hop');

  // The view from the other end is not symmetric: r3 pays 200 for r1 because
  // that is what the r1-r3 link costs, so r2 still wins (40).
  const back = ospf.spf(g, 'r3');
  ok(back.get('r1').cost === 40 && back.get('r1').nextHopRouterId === 'r2',
    'SPF from r3 mirrors it: r1 costs 40 via r2');

  ok(ospf.spf(g, 'ghost').size === 0, 'unknown root yields an empty SPT');

  const two = twoAreas();
  const g2 = ospf.buildGraph(two.routers, two.links);
  const spt2 = ospf.spf(g2, 'r1');
  ok(spt2.has('r5') === false, 'a router in another area is absent from the SPT');
  ok(spt2.size === 2, 'SPF across an area boundary stops at the area edge');

  // Determinism: reversed input order produces a byte-identical SPT.
  const revLinks = tri.links.slice().reverse().map(function (l) {
    return { a: l.b, b: l.a };
  });
  const flipped = ospf.buildGraph(tri.routers.slice().reverse(), revLinks);
  ok(jsonOfSpt(ospf.spf(flipped, 'r1')) === jsonOfSpt(spt),
    'SPF is identical when routers and link endpoints are listed in reverse');
}

// ---------------------------------------------------------------------------
// tie-breaking
// ---------------------------------------------------------------------------

console.log('\ntie-breaking');
{
  const d = diamond();
  const g = ospf.buildGraph(d.routers, d.links);
  const spt = ospf.spf(g, 'r1');

  ok(spt.get('r4').cost === 20, 'both diamond paths to r4 cost 20');
  ok(spt.get('r4').nextHopRouterId === 'r2', 'equal cost: lexicographically smaller next hop r2 wins over r3');
  ok(eq(spt.get('r4').path, ['r1', 'r2', 'r4']), 'the winning path is r1 -> r2 -> r4');

  const revLinks = d.links.slice().reverse().map(function (l) {
    return { a: l.b, b: l.a };
  });
  const flipped = ospf.buildGraph(d.routers.slice().reverse(), revLinks);
  ok(jsonOfSpt(ospf.spf(flipped, 'r1')) === jsonOfSpt(spt),
    'tie-breaking does not depend on the order links were listed');

  const fromR4 = ospf.spf(g, 'r4');
  ok(fromR4.get('r1').nextHopRouterId === 'r2', 'the same tie-break applies from r4 (r2 < r3)');

  // A cheaper route always beats a lexicographically smaller next hop.
  const cheap = JSON.parse(JSON.stringify(d.routers));
  cheap[1].interfaces[1].cost = 1; // r2's b4 port
  cheap[2].interfaces[1].cost = 1; // r3's c4 port
  cheap[3].interfaces[0].cost = 1; // r4's d2 port
  cheap[3].interfaces[1].cost = 1; // r4's d3 port
  // Both ends of the r2-r4 / r3-r4 links now carry cost 1, so the edge cost is
  // 1 + 1 = 2 and r4 is reachable from r1 at 10 + 2 = 12.
  const g3 = ospf.buildGraph(cheap, d.links.map(function (l) {
    return { a: l.a, b: l.b, cost: 10 };
  }));
  const spt3 = ospf.spf(g3, 'r1');
  ok(spt3.get('r4').cost === 12 && spt3.get('r4').nextHopRouterId === 'r2',
    'a cheaper path (12) replaces the plain 20, tie-break unchanged');
}

// ---------------------------------------------------------------------------
// routesFromSpt
// ---------------------------------------------------------------------------

console.log('\nroutesFromSpt');
{
  const tri = triangle();
  const g = ospf.buildGraph(tri.routers, tri.links);
  const routes = ospf.routesFromSpt(g, 'r1', ospf.spf(g, 'r1'));

  ok(routes.length === 3, 'r1 learns 3 OSPF routes (r2 and r3 networks, deduped)');
  ok(routes.every(function (r) { return r.code === 'O'; }), 'every generated route carries code O');
  ok(routeTo(routes, '10.0.1.1') === null, "the root's own loopback is not re-advertised");
  ok(routeTo(routes, '10.0.12.0') === null, "the root's own transit network is not re-advertised");
  ok(routeTo(routes, '10.0.13.0') === null, 'networks the root already owns are skipped');

  const lo2 = routeTo(routes, '10.0.2.2');
  ok(lo2 !== null && lo2.mask === '255.255.255.255' && lo2.cost === 20, 'r2 loopback is 10.0.2.2/32 at cost 20');
  ok(lo2.nextHop === 'r2' && lo2.iface === 'e12', 'route to r2 leaves via e12 straight to r2');

  const lo3 = routeTo(routes, '10.0.3.3');
  ok(lo3 !== null && lo3.cost === 40 && lo3.nextHop === 'r2', 'r3 loopback costs 40 and is reached via r2');
  ok(lo3.iface === 'e12', 'the local interface towards r3 is still the r1-r2 port e12');

  const transit = routeTo(routes, '10.0.23.0');
  ok(transit !== null && transit.mask === '255.255.255.0' && transit.cost === 20,
    '10.0.23.0/24 is advertised once, by the cheaper (r2) path');

  const nets = routes.map(function (r) { return r.dest; });
  ok(eq(nets, ['10.0.2.2', '10.0.3.3', '10.0.23.0']), 'routes are sorted by network, most specific first');

  // Passive interfaces are still advertised (passive only stops hellos).
  const d = diamond();
  const gd = ospf.buildGraph(d.routers, d.links);
  const dr = ospf.routesFromSpt(gd, 'r1', ospf.spf(gd, 'r1'));
  const passiveLo = routeTo(dr, '10.0.2.2');
  ok(passiveLo !== null && passiveLo.cost === 10, 'a passive interface network is still advertised');
  ok(dr.length === 5, 'diamond gives r1 five OSPF routes');
  const net24 = routeTo(dr, '10.1.34.0');
  ok(net24 !== null && net24.cost === 10 && net24.nextHop === 'r3', 'r3 advertises 10.1.34.0/24 at cost 10');

  ok(ospf.routesFromSpt(g, 'r1', new Map()).length === 0, 'an empty SPT yields no routes');
  ok(ospf.routesFromSpt(g, 'ghost', ospf.spf(g, 'r1')).length === 0, 'an unknown root yields no routes');
}

// ---------------------------------------------------------------------------
// areasOf
// ---------------------------------------------------------------------------

console.log('\nareasOf');
{
  const maps = ospf.areasOf(twoAreas().routers);
  ok(maps instanceof Map, 'areasOf returns a Map');
  ok(eq(Array.from(maps.keys()), [0, 1]), 'areas are keyed 0 and 1, ascending');
  ok(eq(maps.get(0), ['r1', 'r2']), 'area 0 holds r1 and r2');
  ok(eq(maps.get(1), ['r5']), 'area 1 holds r5');
  ok(ospf.areasOf([]).size === 0, 'no routers means no areas');
  ok(eq(ospf.areasOf([{ id: 'r9' }]).get(0), ['r9']), 'a router with no areaId defaults to area 0');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
