'use strict';
// vrrp.js -- VRRP (RFC 5798) group maths, computed as a pure function.
//
// Same philosophy as stp.js: no advertisements, no timers, no held state.
// electMaster() takes a snapshot of every router in one virtual-router group
// and returns the converged master plus the ordered backup list; groupState()
// answers the "someone just came back up" question. The simulator re-runs
// these after any state change, which keeps VRRP out of the timer loop and
// makes the whole election trivially testable.
//
// Election rules, in order:
//   1. routers that are down, and routers at priority 0 ("master
//      relinquished"), never win and are not listed as backups either
//   2. the address owner -- a router whose interface address is one of the
//      group's virtual IPs -- is implicitly priority 255
//   3. highest priority wins
//   4. ties break toward the HIGHER numeric IPv4 address; VRRP is the odd one
//      out here, everything else in the box prefers the lower address
//   5. a final tie on id keeps the result independent of input ordering

const net = require('./net');

const VRRP_PROTOCOL = 112;
const VRRP_DEFAULT_PRIORITY = 100;
const VRRP_OWNER_PRIORITY = 255;
const VRRP_DEFAULT_ADVERT_SEC = 1;
const VRRP_MAC_PREFIX = '00:00:5e:00:01';
const VRRP_MULTICAST_IP = '224.0.0.18';
const VRRP_AUTH_MAX = 8;

// ---------------------------------------------------------------------------
// small coercions
// ---------------------------------------------------------------------------

function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

// Integer from a number or a decimal string; NaN when it is not one.
function intOf(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^[+-]?\d+$/.test(s)) return parseInt(s, 10);
  }
  return NaN;
}

function numOf(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

function boolOf(v, dflt) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === 'yes' || s === 'on' || s === '1') return true;
    if (s === 'false' || s === 'no' || s === 'off' || s === '0') return false;
  }
  return dflt;
}

// Clamp an already-parsed integer into [lo, hi], falling back on garbage.
function clampInt(n, lo, hi, dflt) {
  if (!Number.isInteger(n)) return dflt;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

// Round to 9 decimals so 3 * 0.29 does not come back as 0.8699999999999999
// while small skew times (0.00390625s at priority 255) stay exact.
function round9(n) { return Math.round(n * 1000000000) / 1000000000; }

// IPv4 -> unsigned int, or -1 when the string is not a usable address.
function ipIntOf(ip) {
  if (ip === null || ip === undefined) return -1;
  const s = String(ip).trim();
  if (s === '') return -1;
  try { return net.ipToInt(s); } catch (e) { return -1; }
}

function ipListOf(v) {
  if (Array.isArray(v)) return v;
  if (v === null || v === undefined || v === '') return [];
  return [v];
}

// The group's virtual IPs, accepted as a bare array or as { ips: [...] }.
function groupIpsOf(group) {
  if (Array.isArray(group)) return group;
  if (isObj(group)) return ipListOf(group.ips);
  return [];
}

// Null when the address is not a virtual address of this group.
function normalizedIp(ip) {
  const n = ipIntOf(ip);
  return n < 0 ? null : net.intToIp(n);
}

// ---------------------------------------------------------------------------
// virtual MAC
// ---------------------------------------------------------------------------

// 00:00:5e:00:01:<vrid>, lowercase and zero padded. Null for a VRID that
// cannot be encoded in one octet.
function virtualMac(vrid) {
  const v = intOf(vrid);
  if (!Number.isInteger(v) || v < 0 || v > 255) return null;
  return VRRP_MAC_PREFIX + ':' + (v < 16 ? '0' : '') + v.toString(16);
}

function virtualMacMatches(mac, vrid) {
  const expected = virtualMac(vrid);
  if (!expected) return false;
  if (mac === null || mac === undefined || String(mac).trim() === '') return false;
  try { return net.normalizeMac(mac) === expected; } catch (e) { return false; }
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

// Error codes this module can emit.
const VRRP_RULES = [
  { code: 'E_GROUP_OBJECT', description: 'the group spec is missing or not an object' },
  { code: 'E_VRID_RANGE', description: 'the VRID is not an integer between 1 and 255' },
  { code: 'E_PRIORITY_RANGE', description: 'the priority is not an integer between 0 and 255' },
  { code: 'E_NO_VIRTUAL_IP', description: 'the group advertises no virtual IP address' },
  { code: 'E_IP_INVALID', description: 'a virtual IP is not a valid IPv4 address' },
  { code: 'E_DUPLICATE_IP', description: 'the same virtual IP is listed more than once' },
  { code: 'E_ADVERT_RANGE', description: 'the advertisement interval is not a positive value' },
  { code: 'E_PREEMPT_BOOL', description: 'preempt must be a boolean' },
  { code: 'E_AUTH_LENGTH', description: 'the VRRPv2 authentication text is longer than 8 characters' }
];

function validateGroup(group) {
  const errors = [];
  function err(code, message) { errors.push({ code: code, message: message }); }

  if (!isObj(group)) {
    err('E_GROUP_OBJECT', 'group must be an object');
    return { ok: false, errors: errors };
  }

  // --- VRID ---------------------------------------------------------------
  const vrid = intOf(group.vrid);
  if (!Number.isInteger(vrid) || vrid < 1 || vrid > 255) {
    err('E_VRID_RANGE', 'vrid must be an integer between 1 and 255, got ' + String(group.vrid));
  }

  // --- priority -----------------------------------------------------------
  if (group.priority !== undefined && group.priority !== null && group.priority !== '') {
    const p = intOf(group.priority);
    if (!Number.isInteger(p) || p < 0 || p > 255) {
      err('E_PRIORITY_RANGE', 'priority must be an integer between 0 and 255, got ' + String(group.priority));
    }
  }

  // --- virtual IPs --------------------------------------------------------
  if (group.ips !== undefined && group.ips !== null && !Array.isArray(group.ips)) {
    err('E_IP_INVALID', 'ips must be an array of IPv4 addresses');
  } else {
    const ips = ipListOf(group.ips);
    if (ips.length === 0) {
      err('E_NO_VIRTUAL_IP', 'a virtual router group needs at least one virtual IP address');
    }
    const seen = {};
    for (const raw of ips) {
      const ip = normalizedIp(raw);
      if (ip === null) {
        err('E_IP_INVALID', 'not a valid IPv4 address: ' + String(raw));
        continue;
      }
      if (seen[ip]) {
        err('E_DUPLICATE_IP', 'duplicate virtual IP address: ' + ip);
        continue;
      }
      seen[ip] = true;
    }
  }

  // --- advertisement interval --------------------------------------------
  if (group.advertCs !== undefined && group.advertCs !== null && group.advertCs !== '') {
    const cs = intOf(group.advertCs);
    if (!Number.isInteger(cs) || cs <= 0) {
      err('E_ADVERT_RANGE', 'advertCs must be a positive integer number of centiseconds, got ' + String(group.advertCs));
    }
  } else if (group.advertSec !== undefined && group.advertSec !== null && group.advertSec !== '') {
    const sec = numOf(group.advertSec);
    if (!(sec > 0)) {
      err('E_ADVERT_RANGE', 'advertSec must be greater than zero, got ' + String(group.advertSec));
    }
  }

  // --- preempt ------------------------------------------------------------
  // Boolean, or one of the usual on/off spellings; anything else is an error.
  if (group.preempt !== undefined && group.preempt !== null) {
    if (typeof group.preempt !== 'boolean' && boolOf(group.preempt, null) === null) {
      err('E_PREEMPT_BOOL', 'preempt must be a boolean, got ' + String(group.preempt));
    }
  }

  // --- auth text ----------------------------------------------------------
  if (group.authText !== undefined && group.authText !== null && String(group.authText).length > VRRP_AUTH_MAX) {
    err('E_AUTH_LENGTH', 'authText must be at most ' + VRRP_AUTH_MAX + ' characters, got ' +
      String(group.authText).length);
  }

  return { ok: errors.length === 0, errors: errors };
}

// ---------------------------------------------------------------------------
// normalisation
// ---------------------------------------------------------------------------

// Fills in every default and coerces whatever the caller supplied. Values that
// are out of range are clamped rather than rejected: validateGroup() is the
// gate that reports them.
function normalizeGroup(spec) {
  const src = isObj(spec) ? spec : {};

  const ips = [];
  for (const raw of ipListOf(src.ips)) {
    const ip = normalizedIp(raw);
    if (ip === null) continue;
    if (ips.indexOf(ip) === -1) ips.push(ip);
  }

  let advertSec;
  const cs = intOf(src.advertCs);
  if (Number.isInteger(cs) && cs > 0) {
    advertSec = round9(cs / 100);
  } else {
    const sec = numOf(src.advertSec);
    advertSec = (sec > 0) ? round9(sec) : VRRP_DEFAULT_ADVERT_SEC;
  }

  let interfaceName = src.interfaceName;
  if (interfaceName === undefined || interfaceName === null || interfaceName === '') {
    interfaceName = src.interface;
  }
  if (interfaceName === undefined || interfaceName === null || interfaceName === '') {
    interfaceName = src.iface;
  }
  const iface = (interfaceName === undefined || interfaceName === null) ? 'eth0' : String(interfaceName).trim();
  const authText = (src.authText === undefined || src.authText === null) ? '' : String(src.authText);

  return {
    vrid: clampInt(intOf(src.vrid), 1, 255, 1),
    priority: clampInt(intOf(src.priority), 0, 255, VRRP_DEFAULT_PRIORITY),
    preempt: boolOf(src.preempt, true),
    advertSec: advertSec,
    ips: ips,
    interfaceName: iface === '' ? 'eth0' : iface,
    authText: authText.length > VRRP_AUTH_MAX ? authText.slice(0, VRRP_AUTH_MAX) : authText
  };
}

// ---------------------------------------------------------------------------
// timers
// ---------------------------------------------------------------------------

// Advertisements run every 1s by default; advertCs lets a lab dial them down
// to the RFC 5798 minimum of 25 centiseconds without touching advertSec.
function advertInterval(group) {
  const src = isObj(group) ? group : {};
  const cs = intOf(src.advertCs);
  if (Number.isInteger(cs) && cs > 0) return round9(cs / 100);
  const sec = numOf(src.advertSec);
  if (sec > 0) return round9(sec);
  const adv = numOf(src.advert);
  if (adv > 0) return round9(adv);
  return VRRP_DEFAULT_ADVERT_SEC;
}

// Skew time: (256 - priority) / 256 seconds, so the highest-priority backup
// waits the least before declaring itself master.
function skewTime(group) {
  const src = isObj(group) ? group : ((group === undefined || group === null) ? {} : { priority: group });
  const p = intOf(src.priority);
  const priority = (Number.isInteger(p) && p >= 0 && p <= 255) ? p : VRRP_DEFAULT_PRIORITY;
  return round9((256 - priority) / 256);
}

// Master-down interval: 3 * advertisement interval + skew time.
function masterDownInterval(group, skew) {
  const src = isObj(group) ? group : {};
  const advert = advertInterval(src);
  let s = numOf(skew);
  if (!(s >= 0)) s = skewTime(src);
  return round9(3 * advert + s);
}

// ---------------------------------------------------------------------------
// election
// ---------------------------------------------------------------------------

function priorityOf(r) {
  const p = intOf(r.priority);
  if (!Number.isInteger(p)) return VRRP_DEFAULT_PRIORITY;
  if (p < 0) return 0;
  if (p > 255) return 255;
  return p;
}

// An owner holds one of the group's virtual IPs on its own interface, so it is
// implicitly priority 255 and always wins while it is up.
function isOwner(r, groupIps) {
  if (r.owner === true) return true;
  const ipInt = ipIntOf(r.ip);
  if (ipInt < 0) return false;
  const own = groupIps.concat(ipListOf(r.virtualIps)).concat(ipListOf(r.groupIps));
  for (const raw of own) {
    if (ipIntOf(raw) === ipInt) return true;
  }
  return false;
}

// Higher priority first, then the higher IPv4 address, then id ascending so the
// result never depends on the order the caller listed its routers in.
function compareCandidates(a, b) {
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.ipInt !== b.ipInt) return b.ipInt - a.ipInt;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function candidateList(routers, groupIps) {
  const out = [];
  const list = Array.isArray(routers) ? routers : [];
  for (const r of list) {
    if (!isObj(r)) continue;
    if (r.id === undefined || r.id === null || r.id === '') continue;
    if (r.up === false) continue;
    const configured = priorityOf(r);
    if (configured === 0) continue; // master relinquished: does not participate
    const owner = isOwner(r, groupIps);
    out.push({
      id: String(r.id),
      priority: owner ? VRRP_OWNER_PRIORITY : configured,
      configured: configured,
      owner: owner,
      ip: (r.ip === undefined || r.ip === null) ? '' : String(r.ip),
      ipInt: ipIntOf(r.ip)
    });
  }
  out.sort(compareCandidates);
  return out;
}

function idsExcept(cands, id) {
  const out = [];
  for (const c of cands) {
    if (c.id !== id) out.push(c.id);
  }
  return out;
}

// routers: [{ id, priority, ip, preempt, up }]. The optional second argument is
// the group (or its ips array) and is what makes owner detection possible.
function electMaster(routers, group) {
  const cands = candidateList(routers, groupIpsOf(group));
  if (cands.length === 0) {
    return { masterId: null, backups: [], reason: 'no-candidates' };
  }
  const master = cands[0];
  let reason;
  if (master.owner) reason = 'owner';
  else if (cands.length === 1) reason = 'only-candidate';
  else if (cands[1].priority === master.priority) reason = 'tiebreak-ip';
  else reason = 'priority';
  return {
    masterId: master.id,
    backups: idsExcept(cands, master.id),
    reason: reason
  };
}

// Converged state when a router rejoins the group. opts:
//   preempt        -- what the group (or the rejoining router) is configured with
//   currentMaster  -- who holds the role now (alias: previousMaster, or a
//                     router carrying master:true / role:'master')
//   group / ips    -- the virtual IPs, for owner detection
function groupState(routers, opts) {
  const options = isObj(opts) ? opts : {};
  const preempt = boolOf(options.preempt, true);
  const cands = candidateList(routers, groupIpsOf(options.group || options.ips));

  let incumbent = null;
  if (options.currentMaster !== undefined && options.currentMaster !== null) {
    incumbent = String(options.currentMaster);
  } else if (options.previousMaster !== undefined && options.previousMaster !== null) {
    incumbent = String(options.previousMaster);
  } else {
    for (const r of (Array.isArray(routers) ? routers : [])) {
      if (!isObj(r) || r.id === undefined || r.id === null) continue;
      if (r.master === true || r.role === 'master' || r.state === 'master') {
        incumbent = String(r.id);
        break;
      }
    }
  }

  const base = {
    preempt: preempt,
    masterId: null,
    backups: [],
    previousMasterId: incumbent,
    changed: false,
    reason: ''
  };

  if (cands.length === 0) {
    base.reason = 'no-candidates';
    return base;
  }

  // Nothing was master before: this is the group's first election.
  if (incumbent === null) {
    base.masterId = cands[0].id;
    base.backups = idsExcept(cands, cands[0].id);
    base.reason = 'initial';
    return base;
  }

  const inc = cands.filter(function (c) { return c.id === incumbent; })[0] || null;

  // The best candidate is already the master: nothing moves.
  if (cands[0].id === incumbent) {
    base.masterId = incumbent;
    base.backups = idsExcept(cands, incumbent);
    base.reason = 'unchanged';
    return base;
  }

  // A better router is up. With preempt it takes the role back immediately.
  if (inc && preempt) {
    base.masterId = cands[0].id;
    base.backups = idsExcept(cands, cands[0].id);
    base.changed = true;
    base.reason = 'preempt';
    return base;
  }

  // Without preempt a live, participating master keeps the role, even though a
  // higher-priority router is now advertising.
  if (inc) {
    base.masterId = incumbent;
    base.backups = idsExcept(cands, incumbent);
    base.reason = 'incumbent-keeps';
    return base;
  }

  // The incumbent is down (or stopped participating): normal failover.
  base.masterId = cands[0].id;
  base.backups = idsExcept(cands, cands[0].id);
  base.changed = true;
  base.reason = 'failover';
  return base;
}

module.exports = {
  VRRP_PROTOCOL,
  VRRP_DEFAULT_PRIORITY,
  VRRP_OWNER_PRIORITY,
  VRRP_DEFAULT_ADVERT_SEC,
  VRRP_MAC_PREFIX,
  VRRP_MULTICAST_IP,
  VRRP_RULES,
  validateGroup,
  normalizeGroup,
  virtualMac,
  virtualMacMatches,
  electMaster,
  groupState,
  advertInterval,
  skewTime,
  masterDownInterval
};
