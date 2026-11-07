'use strict';
// ospf.js -- OSPF adjacency + shortest-path-first, computed as a pure graph
// problem.
//
// Like stp.js there is no protocol state here: buildGraph() turns a router/link
// description into a node/edge graph, spf() runs Dijkstra over it, and
// routesFromSpt() turns the resulting tree into code 'O' routes. Callers re-run
// the pipeline after any topology change, so the simulator never has to keep
// neighbour state machines or LSAs around.
//
// Deliberate simplifications:
//   * one area per link -- a link is usable only when both endpoints sit in the
//     same area (no virtual links, no ABR route leaking)
//   * link metric = the two interface costs added together when both ends
//     configure one, otherwise the link's own cost, otherwise DEFAULT_COST
//   * every edge is bidirectional with the same metric in both directions
//   * an interface area overrides its router's area, which is how a real ABR
//     puts different interfaces in different areas
//
// Everything is deterministic: no clocks, no randomness, and every list that
// leaves this module is sorted, so the same topology always yields the same
// SPT and the same routing table no matter what order the caller listed
// routers, interfaces or links in.

const net = require('./net');

const OSPF_PROTOCOL = 89;        // IP protocol number carried in the header
const OSPF_ADMIN_DISTANCE = 110; // Cisco-style administrative distance
const DEFAULT_COST = 10;
const DEFAULT_HELLO_SEC = 10;
const DEFAULT_DEAD_SEC = 40;

const MAX_COST = 65535;
const MAX_AREA = 4294967295;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function compareStrings(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function isDottedQuad(v) {
  if (typeof v !== 'string' && typeof v !== 'number') return false;
  const s = String(v).trim();
  if (!net.isIp(s)) return false;
  try {
    net.ipToInt(s);
    return true;
  } catch (err) {
    return false;
  }
}

// Area IDs are 32-bit values normally written dotted-quad. Normalise to an
// integer so 0, '0' and '0.0.0.0' are the same area and compare cheaply.
function parseAreaId(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    if (!Number.isInteger(v) || v < 0 || v > MAX_AREA) return null;
    return v;
  }
  const s = String(v).trim();
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    return (n >= 0 && n <= MAX_AREA) ? n : null;
  }
  if (net.isIp(s)) {
    try {
      return net.ipToInt(s);
    } catch (err) {
      return null;
    }
  }
  return null;
}

function areaOf(v) {
  const a = parseAreaId(v);
  return (a === null) ? 0 : a;
}

// Prefix length of a contiguous mask, or null when the mask is missing or is
// not a run of ones followed by zeros.
function maskPrefix(mask) {
  if (mask === null || mask === undefined || mask === '') return null;
  let m;
  try {
    m = net.maskToInt(mask) >>> 0;
    const prefix = net.prefixOf(mask);
    const rebuilt = (prefix === 0) ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (rebuilt === m) ? prefix : null;
  } catch (err) {
    return null;
  }
}

// OSPF interface cost: 1-65535. null means "not configured" (or invalid).
function ifaceCost(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n < 1 || n > MAX_COST) return null;
  return n;
}

function timerValue(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

function pushError(errors, code, message) {
  errors.push({ code: code, message: message });
}

function validateRouter(cfg) {
  const errors = [];
  const src = (cfg && typeof cfg === 'object') ? cfg : {};

  if (!isDottedQuad(src.routerId)) {
    pushError(errors, 'BAD_ROUTER_ID', 'routerId must be a dotted-quad IPv4 address');
  }

  if (src.areaId !== undefined && src.areaId !== null && src.areaId !== '' &&
      parseAreaId(src.areaId) === null) {
    pushError(errors, 'BAD_AREA_ID', 'areaId must be 0-4294967295 or a dotted-quad');
  }

  const hello = timerValue(src.helloSec, DEFAULT_HELLO_SEC);
  const dead = timerValue(src.deadSec, DEFAULT_DEAD_SEC);
  if (hello === null) {
    pushError(errors, 'BAD_TIMERS', 'helloSec must be a positive integer number of seconds');
  }
  if (dead === null) {
    pushError(errors, 'BAD_TIMERS', 'deadSec must be a positive integer number of seconds');
  }
  if (hello !== null && dead !== null && dead < hello) {
    pushError(errors, 'BAD_TIMERS', 'deadSec (' + dead + ') must be at least helloSec (' + hello + ')');
  }

  const ifaces = src.interfaces;
  if (!Array.isArray(ifaces) || ifaces.length === 0) {
    pushError(errors, 'NO_INTERFACES', 'at least one interface is required');
    return { ok: errors.length === 0, errors: errors };
  }

  const names = new Set();
  const subnets = new Set();

  for (let n = 0; n < ifaces.length; n++) {
    const raw = (ifaces[n] && typeof ifaces[n] === 'object') ? ifaces[n] : {};
    const label = 'interfaces[' + n + ']';

    const name = (raw.name === undefined || raw.name === null) ? '' : String(raw.name).trim();
    if (!name) {
      pushError(errors, 'IFACE_BAD_NAME', label + ': name is required');
    } else if (names.has(name)) {
      pushError(errors, 'DUPLICATE_IFACE', label + ': duplicate interface name "' + name + '"');
    } else {
      names.add(name);
    }
    const where = name ? (label + ' (' + name + ')') : label;

    const ip = (raw.ip === undefined || raw.ip === null) ? '' : String(raw.ip).trim();
    let ipOk = false;
    if (!ip) {
      pushError(errors, 'IFACE_NO_IP', where + ': ip is required');
    } else if (!isDottedQuad(ip)) {
      pushError(errors, 'IFACE_BAD_IP', where + ': "' + ip + '" is not a valid IPv4 address');
    } else {
      ipOk = true;
    }

    const prefix = maskPrefix(raw.mask);
    if (prefix === null) {
      const msg = (raw.mask === undefined || raw.mask === null || raw.mask === '')
        ? where + ': mask is required'
        : where + ': "' + raw.mask + '" is not a contiguous mask or prefix length';
      pushError(errors, 'IFACE_BAD_MASK', msg);
    }

    if (ipOk && prefix !== null) {
      try {
        const maskInt = net.maskToInt(raw.mask) >>> 0;
        const addr = net.ipToInt(ip);
        const network = (addr & maskInt) >>> 0;
        const broadcast = (network | (~maskInt >>> 0)) >>> 0;
        if (prefix <= 30 && (addr === network || addr === broadcast)) {
          pushError(errors, 'IFACE_NOT_IN_NETWORK', where + ': ' + ip + ' is the ' +
            (addr === network ? 'network' : 'broadcast') + ' address of ' +
            net.intToIp(network) + '/' + prefix + ', not a usable host address');
        }
        const key = net.intToIp(network) + '/' + prefix;
        if (subnets.has(key)) {
          pushError(errors, 'DUPLICATE_SUBNET', where + ': ' + key + ' is already configured on another interface');
        } else {
          subnets.add(key);
        }
      } catch (err) {
        pushError(errors, 'IFACE_BAD_IP', where + ': "' + ip + '" is not a valid IPv4 address');
      }
    }

    if (raw.cost !== undefined && raw.cost !== null && raw.cost !== '' && ifaceCost(raw.cost) === null) {
      pushError(errors, 'IFACE_BAD_COST', where + ': cost must be an integer between 1 and 65535');
    }

    if (raw.area !== undefined && raw.area !== null && raw.area !== '' && parseAreaId(raw.area) === null) {
      pushError(errors, 'BAD_AREA_ID', where + ': area must be 0-4294967295 or a dotted-quad');
    }

    if (raw.passive !== undefined && raw.passive !== null && typeof raw.passive !== 'boolean') {
      pushError(errors, 'IFACE_BAD_PASSIVE', where + ': passive must be true or false');
    }
  }

  return { ok: errors.length === 0, errors: errors };
}

// ---------------------------------------------------------------------------
// normalisation
// ---------------------------------------------------------------------------

function normalizeIface(raw, routerArea) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const name = (src.name === undefined || src.name === null) ? '' : String(src.name);
  const ip = (src.ip === undefined || src.ip === null) ? '' : String(src.ip).trim();
  const mask = (src.mask === undefined || src.mask === null) ? '' : String(src.mask).trim();
  const prefix = maskPrefix(mask);

  let maskInt = null;
  let network = null;
  if (isDottedQuad(ip) && prefix !== null) {
    try {
      maskInt = net.maskToInt(mask) >>> 0;
      network = (net.ipToInt(ip) & maskInt) >>> 0;
    } catch (err) {
      maskInt = null;
      network = null;
    }
  }

  return {
    name: name,
    ip: ip,
    mask: mask,
    maskInt: maskInt,
    prefix: prefix,
    network: network,
    cost: ifaceCost(src.cost),
    passive: src.passive === true,
    area: (src.area === undefined || src.area === null) ? routerArea : areaOf(src.area)
  };
}

function normalizeRouter(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const areaId = areaOf(src.areaId);
  const interfaces = [];
  const rawIfaces = Array.isArray(src.interfaces) ? src.interfaces : [];
  for (const i of rawIfaces) interfaces.push(normalizeIface(i, areaId));
  return {
    id: String(src.id),
    routerId: (src.routerId === undefined || src.routerId === null) ? '' : String(src.routerId),
    areaId: areaId,
    interfaces: interfaces
  };
}

// Interfaces that can carry an adjacency: they have an address and a mask.
function usableInterfaces(node) {
  const out = [];
  if (!node) return out;
  for (const i of node.interfaces) {
    if (i.network !== null && i.prefix !== null) out.push(i);
  }
  return out;
}

// An interface may be named by the link; when it is not, a router with exactly
// one usable interface is unambiguous.
function ifaceOf(node, name) {
  const usable = usableInterfaces(node);
  if (name) {
    for (const i of usable) {
      if (i.name === name) return i;
    }
    return null;
  }
  return (usable.length === 1) ? usable[0] : null;
}

function endpointOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const routerRaw = raw.router;
  let router = null;
  if (routerRaw && typeof routerRaw === 'object') {
    if (routerRaw.id !== undefined && routerRaw.id !== null) router = String(routerRaw.id);
  } else if (routerRaw !== undefined && routerRaw !== null && routerRaw !== '') {
    router = String(routerRaw);
  }
  if (router === null) return null;
  const iface = (raw.iface === undefined || raw.iface === null) ? '' : String(raw.iface);
  return { router: router, iface: iface };
}

function compareEdges(a, b) {
  let c = compareStrings(a.a, b.a);
  if (c !== 0) return c;
  c = compareStrings(a.b, b.b);
  if (c !== 0) return c;
  if (a.cost !== b.cost) return a.cost - b.cost;
  c = compareStrings(a.ifA, b.ifA);
  if (c !== 0) return c;
  return compareStrings(a.ifB, b.ifB);
}

// ---------------------------------------------------------------------------
// graph building
// ---------------------------------------------------------------------------

function normalizeLink(raw, byId) {
  if (!raw || typeof raw !== 'object') return null;
  const ea = endpointOf(raw.a);
  const eb = endpointOf(raw.b);
  if (!ea || !eb) return null;

  const na = byId.get(ea.router);
  const nb = byId.get(eb.router);
  if (!na || !nb || na.id === nb.id) return null;

  const ia = ifaceOf(na, ea.iface);
  const ib = ifaceOf(nb, eb.iface);
  if (!ia || !ib) return null;

  // Only same-area endpoints form an adjacency.
  if (ia.area !== ib.area) return null;

  const costA = ia.cost;
  const costB = ib.cost;
  const linkCost = ifaceCost(raw.cost);
  let cost;
  if (costA !== null && costB !== null) cost = costA + costB;
  else if (linkCost !== null) cost = linkCost;
  else cost = DEFAULT_COST;

  // Canonical orientation (lower id first) so the edge list, the adjacency
  // list and the SPT never depend on which endpoint the caller listed first.
  if (na.id < nb.id) {
    return { a: na.id, b: nb.id, cost: cost, costA: costA, costB: costB, area: ia.area, ifA: ia.name, ifB: ib.name };
  }
  return { a: nb.id, b: na.id, cost: cost, costA: costB, costB: costA, area: ia.area, ifA: ib.name, ifB: ia.name };
}

function buildGraph(routers, links) {
  const nodes = [];
  const byId = new Map();

  for (const raw of (Array.isArray(routers) ? routers : [])) {
    if (!raw || raw.id === undefined || raw.id === null || raw.id === '') continue;
    const node = normalizeRouter(raw);
    if (byId.has(node.id)) continue; // first definition of an id wins
    byId.set(node.id, node);
    nodes.push(node);
  }
  nodes.sort(function (x, y) { return compareStrings(x.id, y.id); });

  const edges = [];
  for (const raw of (Array.isArray(links) ? links : [])) {
    const edge = normalizeLink(raw, byId);
    if (edge) edges.push(edge);
  }
  edges.sort(compareEdges);

  return { nodes: nodes, edges: edges };
}

// Accept either a graph from buildGraph() or a bare { routers, links } pair.
function asGraph(graph) {
  if (!graph || typeof graph !== 'object') return { nodes: [], edges: [] };
  if (Array.isArray(graph.nodes) && Array.isArray(graph.edges)) {
    return { nodes: graph.nodes, edges: graph.edges };
  }
  return buildGraph(graph.routers, graph.links);
}

// ---------------------------------------------------------------------------
// adjacencies
// ---------------------------------------------------------------------------

function adjacencies(graph) {
  const g = asGraph(graph);
  const out = [];
  for (const e of g.edges) {
    out.push({
      a: e.a,
      b: e.b,
      cost: e.cost,
      costA: (e.costA === undefined) ? null : e.costA,
      costB: (e.costB === undefined) ? null : e.costB
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// SPF (Dijkstra)
// ---------------------------------------------------------------------------

function adjacencyIndex(graph) {
  const index = new Map();
  for (const n of graph.nodes) index.set(n.id, []);
  for (const e of graph.edges) {
    if (index.has(e.a)) index.get(e.a).push({ to: e.b, cost: e.cost });
    if (index.has(e.b)) index.get(e.b).push({ to: e.a, cost: e.cost });
  }
  for (const list of index.values()) {
    list.sort(function (x, y) {
      const c = compareStrings(x.to, y.to);
      if (c !== 0) return c;
      return x.cost - y.cost;
    });
  }
  return index;
}

// Candidate ordering for the SPT: cost, then the next hop we would use, then
// the router we came from, then the node id. Every OSPF tie-break in this
// module goes through here, which is what makes equal-cost topologies stable.
function compareHops(x, xId, y, yId) {
  if (x.cost !== y.cost) return x.cost < y.cost ? -1 : 1;
  const xn = (x.nextHop === null) ? '' : x.nextHop;
  const yn = (y.nextHop === null) ? '' : y.nextHop;
  if (xn !== yn) return xn < yn ? -1 : 1;
  const xp = (x.prev === null) ? '' : x.prev;
  const yp = (y.prev === null) ? '' : y.prev;
  if (xp !== yp) return xp < yp ? -1 : 1;
  return compareStrings(xId, yId);
}

function pathTo(best, root, id) {
  const path = [];
  let cur = id;
  let guard = best.size + 2;
  while (cur !== null && guard > 0) {
    guard--;
    path.push(cur);
    if (cur === root) break;
    const rec = best.get(cur);
    cur = rec ? rec.prev : null;
  }
  path.reverse();
  return path;
}

// spf(graph, rootId) -> Map(destRouterId -> { cost, nextHopRouterId, path })
// The root maps to { cost: 0, nextHopRouterId: null, path: [root] }; anything
// the root cannot reach is simply absent from the map.
function spf(graph, rootId) {
  const g = asGraph(graph);
  const index = adjacencyIndex(g);
  const ids = [];
  for (const n of g.nodes) ids.push(n.id);
  ids.sort(compareStrings);

  const root = (rootId === undefined || rootId === null) ? '' : String(rootId);
  const spt = new Map();
  if (!index.has(root)) return spt;

  const best = new Map();
  best.set(root, { cost: 0, nextHop: null, prev: null });
  const done = new Set();

  for (;;) {
    let pick = null;
    for (const id of ids) {
      if (done.has(id)) continue;
      const cand = best.get(id);
      if (!cand) continue;
      if (pick === null || compareHops(cand, id, best.get(pick), pick) < 0) pick = id;
    }
    if (pick === null) break;

    done.add(pick);
    const here = best.get(pick);
    const links = index.get(pick) || [];

    for (const link of links) {
      if (done.has(link.to)) continue;
      const cand = {
        cost: here.cost + link.cost,
        nextHop: (pick === root) ? link.to : here.nextHop,
        prev: pick
      };
      const cur = best.get(link.to);
      if (!cur || compareHops(cand, link.to, cur, link.to) < 0) best.set(link.to, cand);
    }
  }

  for (const id of ids) {
    const rec = best.get(id);
    if (!rec) continue;
    spt.set(id, {
      cost: rec.cost,
      nextHopRouterId: rec.nextHop,
      path: pathTo(best, root, id)
    });
  }
  return spt;
}

// ---------------------------------------------------------------------------
// SPF -> routing table
// ---------------------------------------------------------------------------

function networkKey(network, prefix) {
  return network + '/' + prefix;
}

function betterRoute(cand, candOwner, cur, curOwner) {
  if (cand.cost !== cur.cost) return cand.cost < cur.cost;
  const cn = (cand.nextHop === null) ? '' : cand.nextHop;
  const un = (cur.nextHop === null) ? '' : cur.nextHop;
  if (cn !== un) return cn < un;
  return candOwner < curOwner;
}

// routesFromSpt(graph, rootId, spfResult) -> [{ dest, mask, cost, nextHop, iface, code: 'O' }]
// Every reachable router contributes its connected networks. The root's own
// connected networks are left out because those are code 'C'. A network
// advertised by several routers keeps the cheapest entry (ties: lower next
// hop, then lower owner id).
function routesFromSpt(graph, rootId, spfResult) {
  const g = asGraph(graph);
  const root = (rootId === undefined || rootId === null) ? '' : String(rootId);
  const spt = (spfResult instanceof Map) ? spfResult : new Map();

  const byId = new Map();
  for (const n of g.nodes) byId.set(n.id, n);

  const rootNode = byId.get(root);
  if (!rootNode) return [];
  const ownNets = new Set();
  for (const i of usableInterfaces(rootNode)) {
    ownNets.add(networkKey(i.network, i.prefix));
  }

  // Local interface used to reach each directly connected neighbour: cheapest
  // edge first, then the lexicographically smaller interface name.
  const egress = new Map();
  for (const e of g.edges) {
    let peer = null;
    let iface = null;
    if (e.a === root) {
      peer = e.b;
      iface = e.ifA;
    } else if (e.b === root) {
      peer = e.a;
      iface = e.ifB;
    }
    if (peer === null || !iface) continue;
    const cur = egress.get(peer);
    if (!cur || e.cost < cur.cost || (e.cost === cur.cost && iface < cur.iface)) {
      egress.set(peer, { iface: iface, cost: e.cost });
    }
  }

  const destIds = [];
  for (const id of spt.keys()) destIds.push(String(id));
  destIds.sort(compareStrings);

  const chosen = new Map();
  for (const id of destIds) {
    if (id === root) continue;
    const rec = spt.get(id);
    const node = byId.get(id);
    if (!rec || !node) continue;

    const nextHop = (rec.nextHopRouterId === undefined || rec.nextHopRouterId === null)
      ? id
      : String(rec.nextHopRouterId);
    const hop = egress.get(nextHop);
    const cost = Number(rec.cost);

    for (const i of usableInterfaces(node)) {
      const key = networkKey(i.network, i.prefix);
      if (ownNets.has(key)) continue;
      const route = {
        dest: net.intToIp(i.network),
        mask: net.intToIp(i.maskInt),
        cost: cost,
        nextHop: nextHop,
        iface: hop ? hop.iface : null,
        code: 'O'
      };
      const cur = chosen.get(key);
      if (!cur || betterRoute(route, id, cur.route, cur.owner)) {
        chosen.set(key, { route: route, owner: id });
      }
    }
  }

  const decorated = [];
  for (const v of chosen.values()) {
    decorated.push({
      route: v.route,
      net: net.ipToInt(v.route.dest),
      maskInt: net.maskToInt(v.route.mask) >>> 0
    });
  }
  decorated.sort(function (x, y) {
    if (x.net !== y.net) return x.net < y.net ? -1 : 1;
    if (x.maskInt !== y.maskInt) return x.maskInt > y.maskInt ? -1 : 1;
    return compareStrings(x.route.nextHop, y.route.nextHop);
  });

  const routes = [];
  for (const entry of decorated) routes.push(entry.route);
  return routes;
}

// ---------------------------------------------------------------------------
// areas
// ---------------------------------------------------------------------------

// areasOf(routers) -> Map(areaId -> [routerId]), areas ascending, ids sorted.
function areasOf(routers) {
  const byArea = new Map();
  for (const raw of (Array.isArray(routers) ? routers : [])) {
    if (!raw || raw.id === undefined || raw.id === null || raw.id === '') continue;
    const area = areaOf(raw.areaId);
    if (!byArea.has(area)) byArea.set(area, []);
    byArea.get(area).push(String(raw.id));
  }

  const areas = [];
  for (const area of byArea.keys()) areas.push(area);
  areas.sort(function (x, y) { return x - y; });

  const out = new Map();
  for (const area of areas) {
    const ids = byArea.get(area);
    ids.sort(compareStrings);
    out.set(area, ids);
  }
  return out;
}

module.exports = {
  OSPF_PROTOCOL,
  OSPF_ADMIN_DISTANCE,
  DEFAULT_COST,
  DEFAULT_HELLO_SEC,
  DEFAULT_DEAD_SEC,
  validateRouter,
  buildGraph,
  adjacencies,
  spf,
  routesFromSpt,
  areasOf
};
