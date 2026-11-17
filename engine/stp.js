'use strict';
// stp.js -- 802.1D spanning-tree election, computed as a pure graph problem.
//
// No BPDUs, no timers, no held state: runStp() takes a graph of bridges and
// links and returns the *converged* result -- who is root, what role/state
// every port ends up in, and which ports are blocking. Callers re-run it after
// any topology change, which keeps the simulator free of spanning-tree state
// machines and makes the whole thing trivially testable.
//
// Election, in order:
//   1. root bridge  = lowest bridge ID (priority, then MAC)
//   2. root path cost = shortest path from the root over per-port costs
//   3. root port    = the non-root bridge's cheapest port toward the root
//   4. per segment  = the bridge with the lower root path cost (ties: bridge
//                     ID) owns the designated port; the loser becomes an
//                     alternate/blocking port unless it is still its own
//                     root port
//   5. edge ports (to: null) are always designated + forwarding

const STP_DEFAULT_PRIORITY = 32768;
const DEFAULT_PORT_COST = 4; // short path-cost of a 1 Gb/s port

// Cisco's **short** path-cost method, which is the default on Catalyst and NX-OS switches: a port's cost is a
// small number set by its rated speed, and a whole hop costs at most 100. The table is the vendor's own default
// table - 10 Mb: 100, 100 Mb: 19, 1 Gb: 4, 10 Gb: 2, 25 Gb: 1, 40 Gb: 1, 100 Gb: 1 - and it is the *short*
// method, not the 32-bit one (2,000,000 / 200,000 / 20,000 / 2,000 / 800 / 500 / 200). This file used the long
// numbers under a comment that called them short: a 1 Gb port cost 20,000 here and 4 on the switch it is meant
// to imitate, and a ring of 1 Gb links elected a different root port than the real box would (research/
// stp-path-cost.md).
//
// Speeds with no row of their own take the cost of the next *slower* documented speed, so 2.5 Gb and 5 Gb cost
// what 1 Gb costs, and anything over 100 Gb costs what 100 Gb costs. Every cost this returns is therefore a
// number the vendor publishes, and cost never rises as a link gets faster.
const SHORT_PATH_COST = [
  [10, 100],
  [100, 19],
  [1000, 4],
  [10000, 2],
  [25000, 1],
  [40000, 1],
  [100000, 1]
];

// The default cost of a port at `mbps`, by the short path-cost method. A port whose speed is unknown - a link
// that has not negotiated one - costs like a 1 Gb/s port, which is what the vendor's own default for an
// unconfigured port works out to on the hardware this simulator draws.
function costForSpeedMbps(mbps) {
  const sp = Number(mbps);
  if (!Number.isFinite(sp) || sp <= 0) return DEFAULT_PORT_COST;
  let cost = SHORT_PATH_COST[0][1];
  for (const row of SHORT_PATH_COST) {
    if (sp < row[0]) break;
    cost = row[1];
  }
  return cost;
}

// ---------------------------------------------------------------------------
// bridge IDs
// ---------------------------------------------------------------------------

// Bridge priority is a 16-bit value in 4096 steps: 0, 4096, ... 61440.
function validateBridgePriority(p) {
  if (typeof p !== 'number' || !Number.isFinite(p)) return false;
  if (p < 0 || p > 61440) return false;
  return p % 4096 === 0;
}

// Canonical 12-hex-char form so string comparison == numeric comparison.
// Zero-padded, so "1" and "000000000001" sort together.
function normalizeMacKey(mac) {
  if (mac === null || mac === undefined) return '000000000000';
  const hex = String(mac).toLowerCase().replace(/[^0-9a-f]/g, '');
  if (!hex) return '000000000000';
  return hex.length >= 12 ? hex.slice(0, 12) : hex.padStart(12, '0');
}

function bridgePriority(b) {
  const p = Number(b && b.priority);
  if (!Number.isFinite(p)) return STP_DEFAULT_PRIORITY;
  return p;
}

// Negative when a's bridge ID is better (lower) than b's.
function compareBridgeIds(a, b) {
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.mac !== b.mac) return a.mac < b.mac ? -1 : 1;
  if (a.key !== b.key) return a.key < b.key ? -1 : 1;
  return 0;
}

// ---------------------------------------------------------------------------
// port IDs
// ---------------------------------------------------------------------------

// A port ID is two bytes: an 8-bit port priority in front of the port's number, and the number is the
// last thing that decides between two BPDUs whose root IDs, root costs and sender bridge IDs are all
// equal. Cisco states the order plainly - "if there is a tie with respect to the root path cost, the
// port on the local switch which receives the BPDU with the lowest sender bridge ID is selected as root
// port", and where both paths come from the same neighbour, "by the configured port priority and port
// ID of the neighboring attached ports" (research/stp-root-port-tiebreak.md) - so this file compares
// port IDs, and compares them as numbers.
//
// Per-port priority (`spanning-tree port-priority`) is not modelled: every port is at the default 128,
// so the priority byte is the same on both sides of every comparison and the number alone decides.
//
// The number has to be read out of the name the catalogue uses, and the name is not one field: `Fa0/9`
// is 9, `Gi1/0/10` is module 1, port 10, `Port 3` is 3, `Po1` is 1. Comparing those names as strings put
// `Fa0/10` *before* `Fa0/9` - the one place in this file where a sort said a higher-numbered port was the
// better one - so the comparison below splits each name into digit runs and text runs and compares the
// digit runs as numbers, in order. That is the same order an ifIndex follows: Gi1/0/10 sits ahead of
// Gi2/0/1, which a comparison of the *last* number in the name would get backwards.
function portIdParts(name) {
  const s = String(name === undefined || name === null ? '' : name).toLowerCase();
  return s.match(/\d+|\D+/g) || [];
}

// Negative when a's port ID is better (lower) than b's. Names with no number at all fall back to the
// text comparison, which keeps the answer stable whatever order the ports were listed in.
function comparePortIds(a, b) {
  const pa = portIdParts(a);
  const pb = portIdParts(b);
  const n = Math.min(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i];
    const y = pb[i];
    const xNum = x.charCodeAt(0) >= 48 && x.charCodeAt(0) <= 57;
    const yNum = y.charCodeAt(0) >= 48 && y.charCodeAt(0) <= 57;
    if (xNum && yNum) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  if (pa.length !== pb.length) return pa.length - pb.length;
  return 0;
}

// ---------------------------------------------------------------------------
// ports
// ---------------------------------------------------------------------------

function portCost(port) {
  if (port) {
    const raw = port.cost;
    if (raw !== null && raw !== undefined && raw !== '') {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0) return n;
    }
    return costForSpeedMbps(port.speedMbps);
  }
  return DEFAULT_PORT_COST;
}

function normalizePort(p) {
  const port = (p && typeof p === 'object') ? p : {};
  let to = null;
  if (port.to && typeof port.to === 'object' && port.to.bridge !== undefined && port.to.bridge !== null) {
    to = {
      bridge: String(port.to.bridge),
      port: (port.to.port === undefined || port.to.port === null) ? '' : String(port.to.port)
    };
  }
  return {
    name: (port.name === undefined || port.name === null) ? '' : String(port.name),
    cost: portCost(port),
    to: to,
    enabled: port.enabled !== false
  };
}

function normalizeBridge(b) {
  const src = (b && typeof b === 'object') ? b : {};
  const ports = [];
  const rawPorts = Array.isArray(src.ports) ? src.ports : [];
  for (const p of rawPorts) ports.push(normalizePort(p));
  return {
    key: String(src.key),
    priority: bridgePriority(src),
    mac: normalizeMacKey(src.mac),
    macRaw: (src.mac === undefined) ? null : src.mac,
    ports: ports
  };
}

// ---------------------------------------------------------------------------
// main entry
// ---------------------------------------------------------------------------

function runStp(input) {
  const rawBridges = (input && Array.isArray(input.bridges)) ? input.bridges : [];

  // --- index the bridges (first definition of a key wins) -----------------
  const byKey = new Map();
  const order = [];
  for (const b of rawBridges) {
    if (!b || b.key === undefined || b.key === null) continue;
    const nb = normalizeBridge(b);
    if (byKey.has(nb.key)) continue;
    byKey.set(nb.key, nb);
    order.push(nb.key);
  }

  const portsOut = {};
  for (const key of order) portsOut[key] = {};

  if (order.length === 0) {
    // No bridges, no election, and so no root. This used to answer `{ priority: 32768, mac: null }` - a root
    // object with no identity, which is the root of nothing wearing a default's clothes. Every caller that asked
    // "who is the root?" then printed it: `show spanning-tree` on a router - a box that is not a bridge and never
    // took part - read "root bridge undefined priority 32768" on 1,026 models of the catalogue (#1399).
    // `null` is the honest answer, and it is the same answer the console already gives when no election has run.
    return {
      root: null,
      ports: portsOut,
      blocked: []
    };
  }

  // --- 1. root election ---------------------------------------------------
  let root = byKey.get(order[0]);
  for (const key of order) {
    const b = byKey.get(key);
    if (compareBridgeIds(b, root) < 0) root = b;
  }

  // --- 2. root path costs (Dijkstra from the root) ------------------------
  // Edge weight when leaving u over port p is p's own cost, so
  // dist(v) = dist(u) + cost(p_u->v).
  const dist = new Map();
  for (const key of order) dist.set(key, Infinity);
  dist.set(root.key, 0);

  const visited = new Set();
  for (;;) {
    let u = null;
    let best = Infinity;
    for (const key of order) {
      if (visited.has(key)) continue;
      const d = dist.get(key);
      if (d < best) { best = d; u = key; }
    }
    if (u === null) break;
    visited.add(u);
    const ub = byKey.get(u);
    for (const p of ub.ports) {
      if (!p.enabled || !p.to) continue;
      if (!byKey.has(p.to.bridge) || visited.has(p.to.bridge)) continue;
      const d = best + p.cost;
      if (d < dist.get(p.to.bridge)) dist.set(p.to.bridge, d);
    }
  }

  // --- 3. root port per non-root bridge -----------------------------------
  // The vector 802.1D compares, in its order: cheapest (dist(peer) + own port cost), then the lowest
  // sender bridge ID, then the lowest **sender** port ID, and only then this bridge's own port ID.
  //
  // The third term was missing here, and the fourth compared names as strings. Two parallel links to the
  // same neighbour have identical root cost *and* identical sender bridge ID, so the sender port ID is the
  // one field that decides between them - and the old chain skipped straight to the local name, which picks
  // the local port rather than the link. With `Fa0/9` and `Fa0/10` both cabled to the root it then also
  // preferred `Fa0/10`, because '1' < '9' compares true, so the tree blocked the lower-numbered port and
  // forwarded the frame on the higher one - the opposite of what the box does
  // (research/stp-root-port-tiebreak.md).
  const rootPortOf = new Map();
  for (const key of order) {
    if (key === root.key) continue;
    const b = byKey.get(key);
    let bestPort = null;
    let bestCost = Infinity;
    let bestPeer = null;
    for (const p of b.ports) {
      if (!p.enabled || !p.to) continue;
      const peer = byKey.get(p.to.bridge);
      if (!peer) continue;
      const dpeer = dist.get(peer.key);
      const cand = (dpeer === Infinity) ? Infinity : dpeer + p.cost;
      let better = false;
      if (bestPort === null) {
        better = true;
      } else if (cand !== bestCost) {
        better = cand < bestCost;
      } else if (compareBridgeIds(peer, bestPeer) < 0) {
        better = true;
      } else if (compareBridgeIds(peer, bestPeer) === 0) {
        // Same sender bridge: the BPDUs differ only in the port they left by. Only when even that is
        // equal (two logical ports onto one neighbour port, which a box can only produce on an
        // aggregator) does the receiving port decide.
        const sender = comparePortIds(p.to.port, bestPort.to.port);
        if (sender !== 0) {
          better = sender < 0;
        } else {
          better = comparePortIds(p.name, bestPort.name) < 0;
        }
      }
      if (better) {
        bestPort = p;
        bestCost = cand;
        bestPeer = peer;
      }
    }
    if (bestPort) rootPortOf.set(key, bestPort.name);
  }

  // --- 4+5. port roles, states and the blocked list ----------------------
  const blocked = [];

  function segmentWinner(bridgeKey, peerKey) {
    const dA = dist.get(bridgeKey);
    const dB = dist.get(peerKey);
    if (dA !== dB) return dA < dB;
    return compareBridgeIds(byKey.get(bridgeKey), byKey.get(peerKey)) < 0;
  }

  for (const key of order) {
    const b = byKey.get(key);
    const isRoot = (key === root.key);
    const rootPortName = rootPortOf.get(key);
    const out = portsOut[key];

    for (const p of b.ports) {
      let role;
      let state;

      if (!p.enabled) {
        role = 'disabled';
        state = 'blocking';
      } else if (!p.to || !byKey.has(p.to.bridge)) {
        // Edge / host port: nothing to negotiate with, always forwarding.
        role = 'designated';
        state = 'forwarding';
      } else if (isRoot) {
        role = 'designated';
        state = 'forwarding';
      } else if (p.name === rootPortName) {
        role = 'root';
        state = 'forwarding';
      } else if (segmentWinner(key, p.to.bridge)) {
        role = 'designated';
        state = 'forwarding';
      } else {
        role = 'alternate';
        state = 'blocking';
      }

      out[p.name] = { role: role, state: state, cost: p.cost };
      if (state === 'blocking' && role === 'alternate') {
        blocked.push({ bridge: key, port: p.name });
      }
    }
  }

  return {
    root: {
      // The root used to be reported as a priority and a MAC, which is the bridge ID and not a device:
      // a caller could not say *which* box won the election, so `show spanning-tree` on a switch that
      // had just been made root still read the same as one that had not (#1364).
      key: root.key,
      priority: root.priority,
      mac: (root.macRaw === null) ? root.mac : root.macRaw
    },
    ports: portsOut,
    blocked: blocked
  };
}

// The words for one port's spanning-tree state, in one place (#1441).
//
// `show spanning-tree` printed `blocking   (traffic dropped)` for a port the tree had shut, and the board painted
// the same port green: `portState()` in the faceplate - the single rule the canvas, the panel and the inspector all
// ask - knew about shut ports, unplugged sockets, link-down cables and a shut peer, and nothing about the tree. So
// the one view an operator looks at when a link will not pass traffic said the port was fine, and the console said
// the frame was dropped. The sentence is written here so both surfacing paths print the same words.
function stpPortText(state) {
  if (state === 'blocking') return 'blocking (traffic dropped)';
  return String(state);
}

module.exports = {
  STP_DEFAULT_PRIORITY,
  DEFAULT_PORT_COST,
  SHORT_PATH_COST,
  costForSpeedMbps,
  validateBridgePriority,
  stpPortText,
  comparePortIds,
  runStp
};
