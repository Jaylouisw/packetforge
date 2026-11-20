'use strict';
// lag.js -- LACP / LAG (link aggregation) model.
//
// Covers the three things a topology editor and the CLI need:
//   1. normalising a LAG definition (mode, hash policy, members, min links)
//   2. hashing a frame into [0,1) and picking a bundle member from it
//   3. validating a bundle against the physical ports it claims
//
// Everything here is pure data + pure functions. No dependency on Device,
// Topology or the simulator, so it is safe to require from the engine, the
// server, the CLI or the tests. Hashes are deterministic (FNV-1a over the
// selected tuple) -- never Math.random -- so a given frame always lands on the
// same member, which is what makes flows stable across calls and across runs.

// Port order, not string order: an active link is chosen by port number, and `Fa0/10` is not before `Fa0/2`.
const ifaceName = require('./iface-name');

const LAG_MODES = ['lacp-active', 'lacp-passive', 'static'];

// Two vocabularies for one fact. The console says `channel-group 1 mode active|passive|on`, the way IOS does;
// the model says `lacp-active|lacp-passive|static`, the way the rest of the engine reads it. They were never
// translated, so every correct `channel-group` line stored the console's word and then validated it against
// the model's list:
//
//   Interface Fa0/1 added to channel group 1 (mode active)
//   % Warning: LAG lag1: unknown mode "active" (expected one of lacp-active, lacp-passive, static).
//
// - a warning on every correct command, and the mode left as a string nothing downstream recognised.
// One table, both directions, so the two cannot drift apart again.
const MODE_ALIASES = {
  active: 'lacp-active',
  'lacp-active': 'lacp-active',
  passive: 'lacp-passive',
  'lacp-passive': 'lacp-passive',
  on: 'static',
  static: 'static'
};

// What the operator typed (or a saved lab holds) -> what the model stores.
function canonicalMode(mode) {
  const raw = String(mode == null ? '' : mode).trim().toLowerCase();
  if (!raw) return DEFAULT_MODE;
  return MODE_ALIASES[raw] || raw;    // unknown words survive, so validation can name them
}

// What the model stores -> what the console prints.
function cliMode(mode) {
  const canonical = canonicalMode(mode);
  if (canonical === 'lacp-active') return 'active';
  if (canonical === 'lacp-passive') return 'passive';
  if (canonical === 'static') return 'on';
  return canonical;
}

// The name a box prints for a bundle, in every view that names one: `Po1` in the Port-channel cell of
// `show etherchannel summary` and in the `Ports` column of `show mac address-table`. One function, so a table
// and a summary cannot call the same bundle two different things.
function portChannelName(id) {
  return 'Po' + id;
}

// The same bundle spelled out, for the views where the interface name is the subject of the row rather than a
// cell in a table - `show ip interface brief` prints `Port-channel1` where the MAC table prints `Po1`. Both name
// one object, and one library names it, so the long and the short form cannot disagree about which bundle it is.
function portChannelIfaceName(id) {
  return 'Port-channel' + id;
}

// The line a box prints on the command that *builds* the bundle - `Creating a port-channel interface
// Port-channel 1` - and on no other command.
//
// The vendor inserts a space between the type and the number here, and nowhere else: the interface this line
// names is spelled `Port-channel1` in `show ip interface brief`, in a syslog line and in `show running-config`.
// So the sentence is not `portChannelIfaceName()` with a prefix in front of it, and it is built here rather
// than in the console, so the one place that knows how a bundle is named also knows the one sentence whose
// spacing disagrees with it (research/channel-group-creating-receipt.md).
function createReceipt(id) {
  return 'Creating a port-channel interface Port-channel ' + id;
}

// The inverse of the two above: a bundle's id, read back from a name an operator typed.
//
// A box accepts every spelling of its own interface name - `show interfaces port-channel 1`, and the short
// form its own tables print (`Po1`) - so the console has to recognise them before it can decide whether it
// has anything to say about one. Returns null for anything that is not a bundle name, so a caller can tell
// "not a bundle" from bundle 1.
function bundleIdFromName(typed) {
  const m = /^(?:po|port-?channel)\s*(\d+)$/i.exec(String(typed == null ? '' : typed).trim());
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

const HASH_POLICIES = ['l2', 'l3', 'l3l4'];

const DEFAULT_LAG_ID = 'lag1';
const DEFAULT_MODE = 'lacp-active';
const DEFAULT_HASH_POLICY = 'l3l4';
const DEFAULT_MIN_LINKS = 2;

// How many links one bundle can carry, and how many members a group can hold.
//
// One number, stated the same way by every Catalyst chapter that documents EtherChannels: "Each EtherChannel
// can consist of up to eight compatibly configured Ethernet ports ... For a PAgP EtherChannel, you can
// configure up to eight ports of the same type and speed for the same group. For a LACP EtherChannel, you can
// configure up to 16 Ethernet ports of the same type. Up to eight ports can be active, and up to eight ports
// can be in standby mode" (Cisco, *Configuring EtherChannels*, Catalyst 2960-X 15.2E).
//
// The console modelled neither: a bundle took as many members as the operator typed, every one of them was
// `(P)`, and the data plane hashed frames across all of them, so a ten-member "bundle" carried ten links'
// worth of traffic - a switch no vendor sells. The `H - Hot-standby (LACP only)` line in the key above
// `show etherchannel summary` was unreachable for the same reason (research/etherchannel-member-limit.md).
const MAX_ACTIVE_LINKS = 8;
const MAX_MEMBERS_LACP = 16;
const MAX_MEMBERS_STATIC = 8;

// The member cap depends on whether the bundle negotiates: LACP may hold 16 members because 8 of them can sit
// in hot-standby; a non-negotiating (`on`) group has nowhere to park a ninth, so it takes eight.
function maxMembers(mode) {
  const canonical = canonicalMode(mode);
  return canonical.indexOf('lacp') === 0 ? MAX_MEMBERS_LACP : MAX_MEMBERS_STATIC;
}

// ---------------------------------------------------------------------------
// normalisation
// ---------------------------------------------------------------------------

// Normalise a (possibly partial) LAG config into the canonical shape.
//
// `mode` and `hashPolicy` keep the caller's raw string when it is not a known
// value, so validateLag() can report E_LAG_BAD_MODE instead of silently
// "fixing" a typo. `members` keeps duplicates on purpose for the same reason;
// de-duplication is a validation error, not a normalisation step.
function normalizeLag(cfg) {
  const c = (cfg && typeof cfg === 'object') ? cfg : {};

  const id = (typeof c.id === 'string' && c.id.trim()) ? c.id.trim() : DEFAULT_LAG_ID;

  // Canonicalised on the way in, so a lab saved by an older build (holding "active") normalises to the same
  // state as one configured today.
  const mode = canonicalMode(c.mode);

  const hashPolicy = (typeof c.hashPolicy === 'string' && c.hashPolicy.trim())
    ? c.hashPolicy.trim().toLowerCase()
    : DEFAULT_HASH_POLICY;

  const members = [];
  const rawMembers = Array.isArray(c.members) ? c.members : [];
  for (const m of rawMembers) {
    let name = '';
    if (typeof m === 'string') name = m.trim();
    else if (m && typeof m.name === 'string') name = m.name.trim();
    if (name) members.push(name);
  }

  let minLinks = Number(c.minLinks);
  if (!Number.isFinite(minLinks) || minLinks < 1) minLinks = DEFAULT_MIN_LINKS;
  minLinks = Math.floor(minLinks);

  return { id: id, mode: mode, hashPolicy: hashPolicy, members: members, minLinks: minLinks };
}

// ---------------------------------------------------------------------------
// tuple normalisation (format-insensitive, so "AA-BB-.." == "aabb.ccdd.eeff")
// ---------------------------------------------------------------------------

// MAC -> lowercase hex only (aa:bb:cc:dd:ee:ff, aabb.ccdd.eeff and
// AABBCCDDEEFF all collapse to the same string).
function normalizeMac(v) {
  if (v === null || v === undefined) return '';
  return String(v).toLowerCase().replace(/[^0-9a-f]/g, '');
}

// IP -> lowercase hex digits only. This keeps every digit of an IPv4 address
// and, additionally, the hex letters of an IPv6 address.
function normalizeIp(v) {
  if (v === null || v === undefined) return '';
  return String(v).toLowerCase().replace(/[^0-9a-f]/g, '');
}

// L4 port -> canonical decimal string (so 80, '80' and ' 080 ' agree).
function normalizePort(v) {
  if (v === null || v === undefined || v === '') return '';
  const m = String(v).match(/[0-9]+/);
  if (m) return String(parseInt(m[0], 10));
  return String(v).trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// hashing
// ---------------------------------------------------------------------------

// FNV-1a, 32 bit, over the UTF-16 code units of the tuple string.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// Build the exact byte tuple a policy hashes over.
//   l2    -> srcMac + dstMac
//   l3    -> srcIp  + dstIp
//   l3l4  -> srcIp  + dstIp + srcPort + dstPort
// Missing fields hash as the empty string, which is deliberate: a frame with
// no L3 header still has to land somewhere.
function hashTuple(frame, policy) {
  const f = (frame && typeof frame === 'object') ? frame : {};
  switch (policy) {
    case 'l2':
      return ['l2', normalizeMac(f.srcMac), normalizeMac(f.dstMac)].join('\u0001');
    case 'l3':
      return ['l3', normalizeIp(f.srcIp), normalizeIp(f.dstIp)].join('\u0001');
    case 'l3l4':
    default:
      return [
        'l3l4',
        normalizeIp(f.srcIp),
        normalizeIp(f.dstIp),
        normalizePort(f.srcPort),
        normalizePort(f.dstPort)
      ].join('\u0001');
  }
}

// Hash a frame to a float in [0, 1). Deterministic for a given frame+policy.
function hashFrame(frame, policy) {
  let p = (typeof policy === 'string' && policy.trim()) ? policy.trim().toLowerCase() : DEFAULT_HASH_POLICY;
  if (HASH_POLICIES.indexOf(p) === -1) p = DEFAULT_HASH_POLICY;
  const h = fnv1a(hashTuple(frame, p));
  // 2^32 = 4294967296; h <= 4294967295 so the result is strictly < 1.
  return h / 4294967296;
}

// ---------------------------------------------------------------------------
// member selection
// ---------------------------------------------------------------------------

// A member may be a bare name or a { name, enabled } record.
function memberName(m) {
  if (typeof m === 'string') return m.trim();
  if (m && typeof m.name === 'string') return m.name.trim();
  return '';
}

function memberEnabled(m) {
  if (m && typeof m === 'object' && m.enabled === false) return false;
  return true;
}

// Pick the bundle member that carries a frame.
//
// Only enabled members are eligible, they are sorted by name first (so the
// result does not depend on the order the config happened to list them in),
// and the index is floor(hash * n). Returns null when nothing is eligible.
//
// `opts.canCarry` decides whether a member is *operationally* usable - its cable is in, its link is up, the
// far port is up. It is a predicate rather than a flag so this module stays free of topology: the caller
// already knows how to answer, and every caller must get the same answer. Without it a bundle whose member
// had been unplugged still hashed a share of the traffic onto that dead member and dropped it, while a
// perfectly good member sat idle (#1263).
function selectMember(members, frame, policy, opts) {
  const o = opts || {};
  const canCarry = (typeof o.canCarry === 'function') ? o.canCarry : null;
  const eligible = eligibleMembers(members, canCarry);
  if (eligible.length === 0) return null;

  const h = hashFrame(frame, policy);
  let idx = Math.floor(h * eligible.length);
  if (idx < 0) idx = 0;
  if (idx >= eligible.length) idx = eligible.length - 1;
  return eligible[idx];
}

// Every member that could carry a frame right now, in PORT order.
//
// Port order, not string order, because that is the tie-break the hardware uses to decide which links are in
// the bundle: "If you configure more than eight links for an EtherChannel group, the software automatically
// decides which of the hot-standby ports to make active based on the LACP priority ... The hot-standby ports
// that have lower port numbers become active in the channel first" (Cisco, Configuring EtherChannels). With
// one system priority and the default port priority on every port, that reduces to port number.
function carryingMembers(members, canCarry) {
  const list = Array.isArray(members) ? members : [];
  const out = [];
  const seen = new Set();
  for (const m of list) {
    if (!memberEnabled(m)) continue;
    const name = memberName(m);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    if (canCarry && !canCarry(name)) continue;
    out.push(name);
  }
  return out.sort(ifaceName.comparePortNames);
}

// The members that are IN the channel: at most eight, the lowest-numbered ones that can carry.
function activeMembers(members, canCarry) {
  return carryingMembers(members, canCarry).slice(0, MAX_ACTIVE_LINKS);
}

// The members that can carry but are not in the channel because eight already are - LACP's hot-standby list.
function standbyMembers(members, canCarry) {
  return carryingMembers(members, canCarry).slice(MAX_ACTIVE_LINKS);
}

// Which members of a bundle could carry a frame right now, in the order the selection rule uses.
// Exported so the CLI's `show etherchannel` and the data plane cannot hold two opinions about a bundle.
//
// The order here is the hash's, not the panel's (it sorts by name, so it is stable whatever order the config
// listed the members in); the SET is the active eight, so a frame can never be hashed onto a hot-standby link.
function eligibleMembers(members, canCarry) {
  const list = Array.isArray(members) ? members : [];
  const active = new Set(activeMembers(list, canCarry));
  const out = [];
  const seen = new Set();
  for (const m of list) {
    if (!memberEnabled(m)) continue;
    const name = memberName(m);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    if (!active.has(name)) continue;
    out.push(name);
  }
  return out.sort(function (a, b) { return a < b ? -1 : (a > b ? 1 : 0); });
}

// Does this member's mode negotiate with the mode at the far end of its cable?
//
// One rule, because it is the one the vendor states in as many words: "A port in the passive mode cannot form
// an EtherChannel with another port that is also in the passive mode because neither port starts LACP
// negotiation" (Cisco, Configuring EtherChannels, LACP modes). A passive port answers LACP and never starts
// it, so two passive ends wait for a partner neither of them sends:
//
//   active  + active   -> bundle
//   active  + passive  -> bundle
//   passive + passive  -> no bundle
//   on      + on       -> bundle (no protocol at all)
//
// `on` against a negotiating end is deliberately NOT decided here: the real pair is asymmetric - the `on` side
// shows a bundle while the LACP side suspends, and the two ends disagree about the same cable - and this model
// has one opinion per member, not one per end. research/lacp-passive-both-ends.md names that as unresolved.
function negotiationVerdict(myMode, peerMode) {
  const mine = canonicalMode(myMode);
  const theirs = canonicalMode(peerMode);
  if (mine === 'lacp-passive' && theirs === 'lacp-passive') {
    return { bundled: false, why: 'both ends are passive: neither starts LACP' };
  }
  return { bundled: true, why: null };
}

// A member that never negotiated is not in the bundle - but it is not dead either. The vendor's own sentence:
// "Incompatible ports are put into an independent state and continue to carry data traffic as would any other
// single link. The port configuration does not change, but the port does not participate in the EtherChannel"
// (Cisco, Configuring EtherChannels). So the port leaves the bundle without dying: it forwards as itself, and
// `show etherchannel summary` marks it `(I)` stand-alone - the letter the key printed above the table gives to
// a port that is "operating independently", and not `(s)`, which the key gives to a suspended one.
//
// Three ways to lose the negotiation, all one outcome:
//
//   1. both ends passive          - neither starts LACP (negotiationVerdict);
//   2. a far port in no group     - nothing at the far end answers LACP at all;
//   3. a far port that cannot     - a PC, a router port, anything with no channel group to answer with.
//
// (2) and (3) are the same fact from this side of the cable: an LACP speaker needs an LACP partner, and a port
// that never configured a channel group never sends or answers an LACPDU. The vendor states the pair rule -
// "you must configure both ends in the same mode ... the other end must also be configured in the on mode;
// otherwise, packet loss can occur" - and the 2960 chapter states what a port does when the negotiation comes
// back empty: since 12.2(35)SE it is put into an independent state and goes on carrying traffic as any other
// single link (research/lacp-one-sided-group.md). Before this, a group configured at one end alone came up as a
// bundle and hashed frames across members that, on the wire, were two unrelated single links.
//
// `on` is deliberately NOT covered: it negotiates nothing, so there is no response to wait for and the vendor
// says the switch *forces* the bundle up (`show etherchannel summary` on that side really does read SU/P) while
// the far end treats its port as a plain access port - the asymmetry research/lacp-passive-both-ends.md names.
function memberSuspension(dev, ifaceName, topo) {
  if (!dev || !topo || typeof dev.lagFor !== 'function') return null;
  const iface = dev.interfaces ? dev.interfaces.get(ifaceName) : null;
  if (!iface || !iface.peer) return null;
  const mine = dev.lagFor(ifaceName);
  if (!mine) return null;
  const peerDev = typeof topo.getDevice === 'function' ? topo.getDevice(iface.peer.deviceId) : null;
  const theirs = (peerDev && typeof peerDev.lagFor === 'function') ? peerDev.lagFor(iface.peer.iface) : null;
  if (!theirs) {
    // No channel group on the far port: nothing over there speaks LACP, whatever this end says. A static
    // (`on`) member is left alone - it never asked a question, so it cannot go unanswered.
    const canonical = canonicalMode(mine.mode);
    if (canonical !== 'lacp-active' && canonical !== 'lacp-passive') return null;
    return { why: 'the far end is in no channel group: nothing there answers LACP',
      mode: mine.mode, peerMode: null, peer: iface.peer };
  }
  const verdict = negotiationVerdict(mine.mode, theirs.mode);
  if (verdict.bundled) return null;
  return { why: verdict.why, mode: mine.mode, peerMode: theirs.mode, peer: iface.peer };
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

function splitMemberPorts(memberPorts) {
  const byName = new Map();
  const list = Array.isArray(memberPorts) ? memberPorts : [];
  for (const p of list) {
    if (p && typeof p.name === 'string' && p.name.trim()) byName.set(p.name.trim(), p);
  }
  return byName;
}

function uniqueMembers(members) {
  const out = [];
  const seen = new Set();
  for (const m of members) {
    if (seen.has(m)) continue;
    seen.add(m);
    out.push(m);
  }
  return out;
}

// Validate a LAG definition against the physical ports it bundles.
//   memberPorts = [{ name, speedMbps, duplex, vlanCompatible, enabled }]
// Returns { ok, errors: [{code,message}], warnings: [{code,message}] }.
function validateLag(lag, memberPorts) {
  const cfg = normalizeLag(lag);
  const ports = splitMemberPorts(memberPorts);
  const errors = [];
  const warnings = [];

  function err(code, message) { errors.push({ code: code, message: message }); }
  function warn(code, message) { warnings.push({ code: code, message: message }); }

  // --- mode ---------------------------------------------------------------
  if (LAG_MODES.indexOf(cfg.mode) === -1) {
    err('E_LAG_BAD_MODE',
      'LAG ' + cfg.id + ': unknown mode "' + cfg.mode + '" (expected one of ' +
      LAG_MODES.join(', ') + ').');
  }

  // --- member count -------------------------------------------------------
  if (cfg.members.length < 2) {
    err('E_LAG_TOO_FEW',
      'LAG ' + cfg.id + ': needs at least 2 member ports, has ' + cfg.members.length + '.');
  }

  // --- duplicates ---------------------------------------------------------
  const seen = new Set();
  const dupes = [];
  for (const m of cfg.members) {
    if (seen.has(m)) {
      if (dupes.indexOf(m) === -1) dupes.push(m);
    } else {
      seen.add(m);
    }
  }
  for (const m of dupes) {
    err('E_LAG_DUPLICATE_MEMBER', 'LAG ' + cfg.id + ': member port ' + m + ' is listed more than once.');
  }

  // --- per-port properties (only for members we have a port record for) ----
  const names = uniqueMembers(cfg.members);
  const known = [];
  for (const name of names) {
    const p = ports.get(name);
    if (p) known.push({ name: name, port: p });
  }

  const speeds = [];
  for (const k of known) {
    const s = Number(k.port.speedMbps);
    if (Number.isFinite(s) && s > 0 && speeds.indexOf(s) === -1) speeds.push(s);
  }
  if (speeds.length > 1) {
    speeds.sort(function (a, b) { return a - b; });
    err('E_LAG_SPEED_MISMATCH',
      'LAG ' + cfg.id + ': member speeds differ (' + speeds.join('/') + ' Mbps); ' +
      'all members must run at the same link speed.');
  }

  const duplexes = [];
  for (const k of known) {
    const d = k.port.duplex;
    if (typeof d === 'string' && d.trim() && duplexes.indexOf(d.trim().toLowerCase()) === -1) {
      duplexes.push(d.trim().toLowerCase());
    }
  }
  if (duplexes.length > 1) {
    // Sorted like the rates above: one bundle must not be described two ways depending on which member was
    // typed first.
    duplexes.sort();
    err('E_LAG_DUPLEX_MISMATCH',
      'LAG ' + cfg.id + ': member duplex settings differ (' + duplexes.join('/') + '); ' +
      'all members must agree on duplex.');
  }

  const vlanBad = [];
  for (const k of known) {
    if (k.port.vlanCompatible === false) vlanBad.push(k.name);
  }
  if (vlanBad.length) {
    err('E_LAG_VLAN_MISMATCH',
      'LAG ' + cfg.id + ': member(s) ' + vlanBad.join(', ') +
      ' are not VLAN-compatible; every member must be in the same VLAN set.');
  }

  for (const k of known) {
    if (k.port.enabled === false) {
      warn('W_LAG_DISABLED_MEMBER',
        'LAG ' + cfg.id + ': member ' + k.name + ' is administratively down and carries no traffic.');
    }
  }

  return { ok: errors.length === 0, errors: errors, warnings: warnings };
}

module.exports = {
  MAX_ACTIVE_LINKS,
  MAX_MEMBERS_LACP,
  MAX_MEMBERS_STATIC,
  maxMembers,
  LAG_MODES,
  MODE_ALIASES,
  canonicalMode,
  cliMode,
  portChannelName,
  portChannelIfaceName,
  createReceipt,
  bundleIdFromName,
  HASH_POLICIES,
  normalizeLag,
  hashFrame,
  selectMember,
  carryingMembers,
  activeMembers,
  standbyMembers,
  eligibleMembers,
  negotiationVerdict,
  memberSuspension,
  validateLag
};
