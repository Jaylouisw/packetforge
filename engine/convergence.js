'use strict';
/**
 * convergence.js -- how long each control-plane process takes to finish.
 *
 * Every timer in this engine used to be validated and then never counted. `hello 10`,
 * `dead 40`, `advertise 1`, STP's `forward-delay 15` were all parsed, range-checked, and
 * discarded, because `computeStp()` blocked its ports and `computeOspf()` installed its routes
 * at t=0. The consequence was a lab that could not show the thing an operator actually watches:
 * power-on, then the seconds in which nothing works yet.
 *
 * This module answers one question, in milliseconds: **when is this process done?** It is pure -
 * it reads configuration and returns times, no state, no clock, no side effects. The simulator
 * decides what to do with the answer (see `Simulator.setRunTime`).
 *
 * The times are canonical, not measured:
 *
 *   STP     a port that will forward is not forwarding until it has been through Listening and
 *           Learning, one forward-delay each (802.1D defaults: 15 s + 15 s).
 *   OSPF    adjacency at first hello plus a DBD/LSDB exchange; routes after the SPF hold.
 *   VRRP    a master is only certain of its mastership after 3 advertisements plus skew
 *           (RFC 5798 §6.1), so that is when the group starts answering for the VIP.
 *   DHCP    a lease arrives after the four-message exchange, not with the cable.
 *
 * What this does NOT model, and does not pretend to: real-time interleaving. Nothing here runs a
 * clock during a run. A query is answered as of one instant, computed from the timers.
 */

const C = {
  // 802.1D defaults (§17.14): forward delay 15 s, max age 20 s, hello 2 s.
  stpForwardDelaySec: 15,
  stpMaxAgeSec: 20,
  stpHelloSec: 2,
  // RFC 2328 / common defaults on a broadcast segment.
  ospfHelloSec: 10,
  ospfDeadSec: 40,
  // DBD exchange and LSDB synchronisation after the first hello is heard.
  ospfExchangeSec: 1,
  // SPF hold before the first route from that adjacency reaches the table.
  ospfSpfDelaySec: 5,
  // RFC 5798 defaults: Advertisement_Interval 1 s.
  vrrpAdvertSec: 1,
  // The four-message DHCP exchange on a quiet segment.
  dhcpExchangeSec: 1
};

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

// ---------------------------------------------------------------------------
// The timers, per process, with the device's own configuration winning over the default.

function stpTimers(dev) {
  const cfg = (dev && dev.config) || {};
  const fd = num(cfg.stpForwardDelaySec, C.stpForwardDelaySec);
  // A port's path to Forwarding is Listening then Learning: two forward delays.
  return {
    forwardDelaySec: fd,
    listenEndMs: fd * 1000,
    learnEndMs: fd * 2000,
    forwardAtMs: fd * 2000,
    maxAgeMs: num(cfg.stpMaxAgeSec, C.stpMaxAgeSec) * 1000
  };
}

function ospfTimers(dev) {
  const ospf = (dev && dev.config && dev.config.ospf) || {};
  const hello = num(ospf.helloSec, C.ospfHelloSec);
  const exchange = num(ospf.exchangeSec, C.ospfExchangeSec);
  const spf = num(ospf.spfDelaySec, C.ospfSpfDelaySec);
  const adjMs = (hello + exchange) * 1000;
  return {
    helloSec: hello,
    deadSec: num(ospf.deadSec, C.ospfDeadSec),
    adjacentAtMs: adjMs,
    // The first hello goes out at t=0 (the instant the interface comes up), so the neighbour is
    // heard one hello later, and the exchange follows on that adjacency.
    routesAtMs: adjMs + spf * 1000
  };
}

function vrrpTimers(group, dev) {
  const g = group || {};
  const advert = num(g.advertSec, (g.advertCs !== undefined && g.advertCs !== null)
    ? Number(g.advertCs) / 100 : C.vrrpAdvertSec);
  // RFC 5798: Master_Down_Interval = 3 x Advertisement_Interval + Skew_Time,
  // Skew_Time = ((256 - priority) / 256) seconds. Priority 255 subverts it entirely.
  const priority = num(g.priority, 100);
  const skewSec = priority >= 255 ? 0 : (256 - priority) / 256;
  return {
    advertSec: advert,
    skewSec: skewSec,
    masterDownMs: (3 * advert + skewSec) * 1000
  };
}

function dhcpTimers(dev) {
  const cfg = (dev && dev.config) || {};
  return {
    exchangeSec: num(cfg.dhcpExchangeSec, C.dhcpExchangeSec),
    leaseAtMs: num(cfg.dhcpExchangeSec, C.dhcpExchangeSec) * 1000
  };
}

// ---------------------------------------------------------------------------
// Which processes does this device run at all?

function runsStp(dev) {
  // A node running the spanning tree is a bridge: it has ports to another bridge and it is not
  // a router doing L3 only. This mirrors the filter computeStp() uses.
  return !!(dev && typeof dev.isL2 === 'function' && dev.isL2());
}

function runsOspf(dev) {
  return !!(dev && dev.config && dev.config.ospf);
}

function vrrpGroupsOf(dev) {
  if (!dev || !dev.config) return [];
  const g = dev.config.vrrp;
  if (!g) return [];
  if (Array.isArray(g)) return g;
  if (typeof g === 'object') return Object.keys(g).map(function (k) { return g[k]; });
  return [];
}

function runsDhcpClient(dev) {
  if (!dev) return false;
  if (dev.dhcp) return true;
  for (const iface of (dev.interfaces ? dev.interfaces.values() : [])) {
    if (iface.dhcp) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The schedule.

/**
 * buildSchedule(topology, opts) -> {
 *   entries: [{ deviceId, device, process, readyAtMs, basis }],
 *   convergedAtMs,
 *   byProcess: { stp: ms, ospf: ms, ... }   // the last completion of each process
 * }
 */
function buildSchedule(topo, opts) {
  opts = opts || {};
  const entries = [];
  const devices = topo && topo.devices ? Array.from(topo.devices.values()) : [];

  for (const dev of devices) {
    if (runsStp(dev)) {
      const t = stpTimers(dev);
      entries.push({
        deviceId: dev.id, device: dev, process: 'stp',
        readyAtMs: t.forwardAtMs,
        basis: 'listening + learning (' + t.forwardDelaySec + ' s forward-delay each)'
      });
    }
    if (runsOspf(dev)) {
      const t = ospfTimers(dev);
      entries.push({
        deviceId: dev.id, device: dev, process: 'ospf',
        readyAtMs: t.routesAtMs,
        basis: 'hello ' + t.helloSec + ' s + exchange, then SPF hold'
      });
    }
    if (runsDhcpClient(dev)) {
      const t = dhcpTimers(dev);
      entries.push({
        deviceId: dev.id, device: dev, process: 'dhcp',
        readyAtMs: t.leaseAtMs,
        basis: 'DISCOVER/OFFER/REQUEST/ACK'
      });
    }
    for (const group of vrrpGroupsOf(dev)) {
      const t = vrrpTimers(group, dev);
      entries.push({
        deviceId: dev.id, device: dev, process: 'vrrp',
        group: group.groupId !== undefined ? group.groupId : group.vrid,
        readyAtMs: t.masterDownMs,
        basis: '3 x advertise ' + t.advertSec + ' s + skew'
      });
    }
  }

  entries.sort(function (a, b) {
    if (a.readyAtMs !== b.readyAtMs) return a.readyAtMs - b.readyAtMs;
    if (a.process !== b.process) return a.process < b.process ? -1 : 1;
    return String(a.deviceId) < String(b.deviceId) ? -1 : 1;
  });

  let convergedAtMs = 0;
  const byProcess = {};
  for (const e of entries) {
    if (e.readyAtMs > convergedAtMs) convergedAtMs = e.readyAtMs;
    if (!(e.process in byProcess) || e.readyAtMs > byProcess[e.process]) byProcess[e.process] = e.readyAtMs;
  }

  return { entries: entries, convergedAtMs: convergedAtMs, byProcess: byProcess };
}

// The instant one process on one device is done, or null if that device does not run it.
function readyAt(schedule, process, deviceId) {
  for (const e of schedule.entries) {
    if (e.process === process && e.deviceId === deviceId) return e.readyAtMs;
  }
  return null;
}

// Split a schedule at an instant: what has finished, and what has not.
function at(schedule, atMs) {
  const ready = [], pending = [];
  for (const e of schedule.entries) {
    (e.readyAtMs <= atMs ? ready : pending).push(e);
  }
  return { ready: ready, pending: pending, fullyConverged: pending.length === 0 };
}

// The STP state a port is in at an instant: 'forwarding', 'learning', 'listening' or 'blocking'.
// `willForward` is the steady state from the spanning tree computation (a port that is destined to
// forward is only in a transitional state; a port that is destined to block was never forwarding).
function stpPortStateAt(dev, willForward, atMs) {
  const t = stpTimers(dev);
  if (!willForward) return 'blocking';
  if (atMs >= t.forwardAtMs) return 'forwarding';
  if (atMs >= t.learnEndMs - t.forwardDelaySec * 1000) return 'learning';
  return 'listening';
}

// A port drops traffic in every state but Forwarding. This is the fact that makes a lab able to
// show "the switch is up, the cable is green, and nothing passes yet".
function stpForwardsIn(state) {
  return state === 'forwarding';
}

module.exports = {
  DEFAULTS: C,
  stpTimers: stpTimers,
  ospfTimers: ospfTimers,
  vrrpTimers: vrrpTimers,
  dhcpTimers: dhcpTimers,
  runsStp: runsStp,
  runsOspf: runsOspf,
  runsDhcpClient: runsDhcpClient,
  buildSchedule: buildSchedule,
  readyAt: readyAt,
  at: at,
  stpPortStateAt: stpPortStateAt,
  stpForwardsIn: stpForwardsIn
};
