'use strict';
// Port security: the switch's own answer to "which sources may I hear on this port".
//
// The model already learns a source MAC on the port it arrived from and forwards to whatever it has
// learned. That is a bridge doing its job with no opinion about who is allowed to speak. Port security
// is the opinion, and it is the one L2 feature an operator configures *before* an incident rather than
// after: a port that accepts one address, that refuses a second, and that says which of three things
// it did about it.
//
// The three violation modes are the whole point, because they differ in what they cost:
//
//   protect   drop the frame, say nothing, count nothing - the port keeps working for its own address
//   restrict  drop the frame, count it, log it - the port keeps working, and the counter is the evidence
//   shutdown  drop the frame, count it, and err-disable the port - the port stops working until somebody
//             comes back and types `shutdown` then `no shutdown`
//
// A port that err-disables is administratively fine and operationally dead, which the line state has to
// reflect or `show interfaces` lies about the one port the operator is looking for.

const DEFAULT_MAXIMUM = 1;
const DEFAULT_VIOLATION = 'shutdown';
const MAXIMUM_LIMIT = 3072;

const VIOLATIONS = ['protect', 'restrict', 'shutdown'];

// A MAC is broadcast or multicast if the low bit of the first octet is set. No single station owns one,
// so it can never be a secure source: a port that accepted ff:ff:ff:ff:ff:ff would accept every frame.
function isGroupMac(mac) {
  const first = parseInt(String(mac).slice(0, 2), 16);
  return !Number.isFinite(first) || (first & 1) === 1;
}

// The state of one port: on/off, the limits, what it has learned, and what it has refused.
function blankPort() {
  return {
    enabled: false,
    maximum: DEFAULT_MAXIMUM,
    violation: DEFAULT_VIOLATION,
    sticky: false,
    configured: [],       // MACs written by hand: always allowed, counted against the maximum
    stickyMacs: [],       // learned, and remembered across a clear of the dynamic table
    dynamic: [],          // learned and not sticky
    agingTimeMin: 0,      // 0 = addresses never age out (IOS default)
    agingType: 'absolute', // absolute counts from first sighting, inactivity from the last one
    agingStatic: false,   // whether configured addresses age too
    seen: {},             // mac -> { first, last } in lab milliseconds
    violations: 0,        // restrict and shutdown count; protect does not
    lastSource: null,     // last source address seen on the port, allowed or not
    lastViolationMac: null,
    errDisabled: false,
    shutdownReason: null
  };
}

function blankTable() { return { ports: {}, maxReached: 0 }; }

function portState(dev, portName) {
  if (!dev.portSecurity) dev.portSecurity = blankTable();
  if (!dev.portSecurity.ports[portName]) dev.portSecurity.ports[portName] = blankPort();
  return dev.portSecurity.ports[portName];
}

function peek(dev, portName) {
  const table = dev.portSecurity;
  return table && table.ports ? table.ports[portName] || null : null;
}

// Every address this port will accept: what was configured, what was learned as sticky, and what was
// learned since. The three are kept apart because `show port-security address` has to say which is
// which, and because only the first two survive `clear port-security dynamic`.
function allowedMacs(st) {
  return st.configured.concat(st.stickyMacs, st.dynamic);
}

function macCount(st) { return allowedMacs(st).length; }

// The decision. `mac` is the frame's source, `vid` the VLAN it arrived in.
//
// Returns { action: 'forward' } when the source is acceptable - learning it first if there is room -
// or { action: 'drop', mode, count, errDisable, reason } when it is not. The caller does not decide
// anything: protect, restrict and shutdown differ here, where the mode is read, and nowhere else.
function checkIngress(dev, portName, mac, vid, nowMs) {
  const st = peek(dev, portName);
  if (!st || !st.enabled) return { action: 'forward', secured: false };
  const source = String(mac || '').toLowerCase();
  if (!source) return { action: 'forward', secured: true };
  // A group address is never a station. Dropping it here rather than learning it keeps
  // ff:ff:ff:ff:ff:ff out of a table that represents "the one device on this port".
  if (isGroupMac(source)) {
    return { action: 'drop', mode: st.violation, count: false, errDisable: false,
      reason: source + ' is a group address, not a station, so it cannot be a secure source' };
  }
  st.lastSource = source;
  if (st.errDisabled) {
    return { action: 'drop', mode: st.violation, count: false, errDisable: false,
      reason: 'the port is err-disabled by a port security violation' };
  }
  if (allowedMacs(st).indexOf(source) !== -1) {
    // Seen again: inactivity aging counts from here, absolute aging does not move.
    touch(st, source, nowMs, false);
    return { action: 'forward', secured: true, learned: false };
  }
  if (macCount(st) < st.maximum) {
    // Room for one more: this is learning, not a violation.
    if (st.sticky) st.stickyMacs.push(source);
    else st.dynamic.push(source);
    touch(st, source, nowMs, true);
    return { action: 'forward', secured: true, learned: true, sticky: !!st.sticky, vlan: vid };
  }
  // Full. What happens next is the configured mode, and the three differ in cost on purpose.
  st.lastViolationMac = source;
  if (st.violation === 'protect') {
    return { action: 'drop', mode: 'protect', count: false, errDisable: false,
      reason: 'the port is full (' + st.maximum + ') and the violation mode is protect' };
  }
  st.violations += 1;
  if (st.violation === 'shutdown') {
    st.errDisabled = true;
    st.shutdownReason = 'port security violation: ' + source + ' on a port that allows ' + st.maximum;
    return { action: 'drop', mode: 'shutdown', count: true, errDisable: true,
      reason: 'the port is full (' + st.maximum + ') and the violation mode is shutdown - the port is now err-disabled' };
  }
  return { action: 'drop', mode: 'restrict', count: true, errDisable: false,
    reason: 'the port is full (' + st.maximum + ') and the violation mode is restrict' };
}

// Clear what was learned, leaving what was configured and what was made sticky.
function clearDynamic(dev, portName) {
  const st = portName ? peek(dev, portName) : null;
  if (st) { const n = st.dynamic.length; st.dynamic = []; return n; }
  let n = 0;
  for (const name of Object.keys((dev.portSecurity && dev.portSecurity.ports) || {})) {
    n += dev.portSecurity.ports[name].dynamic.length;
    dev.portSecurity.ports[name].dynamic = [];
  }
  return n;
}

function clearSticky(dev, portName) {
  const st = portName ? peek(dev, portName) : null;
  if (st) { const n = st.stickyMacs.length; st.stickyMacs = []; return n; }
  let n = 0;
  for (const name of Object.keys((dev.portSecurity && dev.portSecurity.ports) || {})) {
    n += dev.portSecurity.ports[name].stickyMacs.length;
    dev.portSecurity.ports[name].stickyMacs = [];
  }
  return n;
}

// Recover an err-disabled port. IOS does this with `shutdown` then `no shutdown`; the counter is kept,
// because the violation still happened and the operator may be reading it to decide what to do next.
function recover(dev, portName) {
  const st = peek(dev, portName);
  if (!st || !st.errDisabled) return null;
  st.errDisabled = false;
  const why = st.shutdownReason;
  st.shutdownReason = null;
  return why;
}

function securedPorts(dev) {
  const table = dev.portSecurity;
  if (!table || !table.ports) return [];
  return Object.keys(table.ports).filter(function (name) { return table.ports[name].enabled; }).sort();
}

// Every address a secured port holds, for `show port-security address`.
function addressRows(dev) {
  const rows = [];
  for (const name of securedPorts(dev)) {
    const st = dev.portSecurity.ports[name];
    for (const mac of st.configured) rows.push({ mac: mac, port: name, type: 'SecureConfigured', age: '-' });
    for (const mac of st.stickyMacs) rows.push({ mac: mac, port: name, type: 'SecureSticky', age: '-' });
    for (const mac of st.dynamic) rows.push({ mac: mac, port: name, type: 'SecureDynamic', age: '0' });
  }
  return rows.sort(function (a, b) { return a.mac.localeCompare(b.mac); });
}


// ---------------------------------------------------------------------------
// aging
// ---------------------------------------------------------------------------
//
// The detail view printed `Aging Time : 0 mins`, `Aging Type : Absolute` and
// `SecureStatic Address Aging : Disabled` from the day the feature landed, and none of the three could
// be configured. Printing a setting that has no command is the same defect as recommending a command
// that does not exist: it describes a device that is not there.
//
// Aging is what stops a secure port from being pinned to a laptop that has left the building. In this
// lab "now" is the instant a question is asked about (the same `at <ms>` the rest of the console uses),
// so an address is aged against that instant rather than against a wall clock that does not exist.

function agingDefaults() {
  return { agingTimeMin: 0, agingType: 'absolute', agingStatic: false };
}

// When an address was first learned, and when it was last seen. Two times because the two aging types
// ask different questions: absolute counts from the first sighting, inactivity from the latest one.
function touch(st, mac, nowMs, isNew) {
  if (!st.seen) st.seen = {};
  const at = Number.isFinite(Number(nowMs)) ? Number(nowMs) : 0;
  const rec = st.seen[mac] || null;
  if (isNew || !rec) st.seen[mac] = { first: at, last: at };
  else rec.last = at;
}

// Remove the addresses aging says are gone. Returns the addresses removed, in table order.
//
// `nowMs` is the instant being asked about. With no aging configured nothing is ever removed, so a port
// that never asked for aging cannot lose an address to it.
function age(dev, nowMs) {
  const table = dev.portSecurity;
  if (!table || !table.ports) return [];
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : 0;
  const removed = [];
  for (const name of Object.keys(table.ports)) {
    const st = table.ports[name];
    if (!st.enabled || !st.agingTimeMin) continue;
    const limitMs = Number(st.agingTimeMin) * 60 * 1000;
    const sweep = function (list, isStaticList) {
      const keep = [];
      for (const mac of list) {
        // Static addresses are configuration: they only age when aging static was asked for.
        if (isStaticList && !st.agingStatic) { keep.push(mac); continue; }
        const rec = (st.seen && st.seen[mac]) || null;
        if (!rec) { keep.push(mac); continue; }
        const since = st.agingType === 'inactivity' ? rec.last : rec.first;
        if (now - since >= limitMs) { removed.push({ port: name, mac: mac, type: isStaticList ? 'SecureConfigured' : 'SecureDynamic' }); continue; }
        keep.push(mac);
      }
      return keep;
    };
    const beforeSticky = st.stickyMacs.length;
    // A sticky address is learned, so it ages like a learned one; forgetting it is the point of aging.
    const before = st.dynamic.length;
    st.dynamic = sweep(st.dynamic, false);
    st.stickyMacs = sweep(st.stickyMacs, false);
    if (st.agingStatic) st.configured = sweep(st.configured, true);
    if (st.dynamic.length !== before || st.stickyMacs.length !== beforeSticky) {
      for (const mac of Object.keys(st.seen || {})) {
        if (allowedMacs(st).indexOf(mac) === -1) delete st.seen[mac];
      }
    }
  }
  return removed;
}

module.exports = {
  DEFAULT_MAXIMUM: DEFAULT_MAXIMUM,
  DEFAULT_VIOLATION: DEFAULT_VIOLATION,
  MAXIMUM_LIMIT: MAXIMUM_LIMIT,
  VIOLATIONS: VIOLATIONS,
  blankPort: blankPort,
  portState: portState,
  peek: peek,
  allowedMacs: allowedMacs,
  macCount: macCount,
  checkIngress: checkIngress,
  clearDynamic: clearDynamic,
  clearSticky: clearSticky,
  recover: recover,
  securedPorts: securedPorts,
  addressRows: addressRows,
  isGroupMac: isGroupMac,
  age: age,
  touch: touch,
  agingDefaults: agingDefaults
};
