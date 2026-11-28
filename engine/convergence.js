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

const stpLib = require('./stp');

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
    // The two numbers `show spanning-tree` prints beside the forward delay. They are returned here rather than
    // written into the report as literals because a box prints the timers it is *running*: a capture of
    // `spanning-tree vlan 1 max-age 10` shows `Max Age 10 sec` in both blocks, and this model's schedule already
    // waits out whatever `stpMaxAgeSec`/`stpHelloSec` say, so a report with the factory numbers in it would
    // contradict the box's own convergence (research/stp-timer-lines-source.md).
    helloSec: num(cfg.stpHelloSec, C.stpHelloSec),
    maxAgeSec: num(cfg.stpMaxAgeSec, C.stpMaxAgeSec),
    listenEndMs: fd * 1000,
    learnEndMs: fd * 2000,
    forwardAtMs: fd * 2000,
    maxAgeMs: num(cfg.stpMaxAgeSec, C.stpMaxAgeSec) * 1000
  };
}

// ---------------------------------------------------------------------------
// Whose forward delay paces the tree.
//
// 802.1D: a non-root adopts the root's hello, max age and forward delay from the configuration BPDU,
// and its own values are remembered but unused while a root is advertising — "only a timer that is
// configured on the root bridge of the STP is important" (Cisco doc 19120). So the numbers that time a
// port's Listening and Learning belong to the root, not to the box whose ports those are. This model
// timed every port by its own box, which let a lab converge in 30 s on a non-root while every report
// — and the root's own BPDU — said 8 (#1722).

// A bridge ID as the election sees it: priority, then the box's lowest MAC. Nothing about a device's
// ports can change who wins the root election, so the root is read from these two fields with the
// election's own comparison rather than by running the tree a second time.
function bridgeIdOf(dev) {
  const cfg = (dev && dev.config) || {};
  // Not `|| default`: 0 is a legal bridge priority and the best one there is (#1364).
  const p = (cfg.stpPriority === null || cfg.stpPriority === undefined)
    ? stpLib.STP_DEFAULT_PRIORITY : Number(cfg.stpPriority);
  const mac = (dev && typeof dev.lowestInterfaceMac === 'function') ? dev.lowestInterfaceMac() : null;
  return {
    key: (dev && dev.id !== undefined) ? dev.id : null,
    priority: Number.isFinite(p) ? p : stpLib.STP_DEFAULT_PRIORITY,
    mac: stpLib.normalizeMacKey(mac)
  };
}

function devicesOf(topo) {
  return (topo && topo.devices) ? Array.from(topo.devices.values()) : [];
}

// The elected root, or null when the topology holds no bridge at all.
function stpRoot(topo) {
  let root = null;
  for (const dev of devicesOf(topo)) {
    if (!runsStp(dev)) continue;
    const id = bridgeIdOf(dev);
    if (!root || stpLib.compareBridgeIds(id, root.id) < 0) root = { id: id, device: dev };
  }
  return root;
}

// The timers every port transition in this topology runs on, resolved once per schedule or per run.
//
// `stpTimers()` still answers for one device: it is what the Bridge ID line prints, and what a box that
// is its own root runs. Nothing that times a transition asks a non-root for its own configuration any
// more.
function stpTreeTimers(topo) {
  const root = stpRoot(topo);
  return { root: root ? root.device : null, timers: stpTimers(root ? root.device : null) };
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
  // `fromMs` re-bases the whole schedule at an instant. It is 0 for a lab that has just been
  // powered on, and the instant of the change for a lab where a cable was pulled: the timers run
  // again from there, which is the only honest way to say "the network is converging".
  const fromMs = Number.isFinite(Number(opts.fromMs)) ? Number(opts.fromMs) : 0;
  const entries = [];
  const devices = devicesOf(topo);
  // The tree's timers, asked once rather than per device: a non-root's ports come up on the root's
  // forward delay, the number its Root ID line prints. Wherever the two disagree — the case this
  // schedule used to get wrong — the basis says whose number it is, so a reader can trace the
  // seconds in the table back to the box they came from (#1722).
  const tree = stpTreeTimers(topo);

  for (const dev of devices) {
    if (runsStp(dev)) {
      const t = tree.timers;
      const inherited = t.forwardDelaySec !== stpTimers(dev).forwardDelaySec;
      entries.push({
        deviceId: dev.id, device: dev, process: 'stp',
        readyAtMs: t.forwardAtMs,
        basis: 'listening + learning (' + t.forwardDelaySec + ' s forward-delay each' +
          (inherited ? ", the root's" : '') + ')'
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

  for (const e of entries) {
    e.readyAtMs = fromMs + e.readyAtMs;
    e.basis = e.basis + (fromMs ? ' (after the change at ' + fromMs + ' ms)' : '');
  }
  if (fromMs) {
    // The schedule is not worth reporting as "converged" before the change happened.
    entries.push({
      deviceId: null, device: { name: '(change)', id: null }, process: 'change',
      readyAtMs: fromMs, basis: 'the link state changed'
    });
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

  return { entries: entries, convergedAtMs: convergedAtMs, byProcess: byProcess, fromMs: fromMs };
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
// `timers` is the tree's, from `stpTreeTimers()`: a non-root walks Listening and Learning on the root's
// forward delay, not its own. Omitted, it falls back to this device's own configuration, which is what a
// box that is its own root runs.
function stpPortStateAt(dev, willForward, atMs, timers) {
  const t = timers || stpTimers(dev);
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
  stpRoot: stpRoot,
  stpTreeTimers: stpTreeTimers,
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
