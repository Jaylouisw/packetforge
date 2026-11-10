'use strict';
// vlan.js -- pure IEEE 802.1Q VLAN membership and frame-classification logic.
//
// This module knows nothing about devices, ports, links or the simulator: it is
// pure data + pure functions, safe to require from the engine, the server, the
// web UI or tests. A "port config" is a plain object:
//
//   { mode: 'access' | 'trunk',
//     accessVlan: <int>,           // access-mode VLAN
//     nativeVlan: <int>,           // untagged VLAN on a trunk (the PVID)
//     allowedVlans: [int] | 'all', // VLANs permitted on a trunk
//     pvid: <int>,                 // untagged / default VLAN actually in use
//     voiceVlan: <int> | null }    // auxiliary (voice) VLAN
//
// Egress classification decides tag / untag / drop for a frame leaving the
// port; ingress classification decides accept / drop for a frame arriving on
// it. 802.1Q is strict here: an access port drops every tagged frame, a trunk
// drops frames for VLANs it is not a member of.

const VLAN_MIN = 1;
const VLAN_MAX = 4094;          // 802.1Q usable range (0x001 .. 0xFFE)
const VLAN_DEFAULT = 1;         // default VLAN
const VLAN_RESERVED_MIN = 1002; // IEEE 802.1Q reserved range ...
const VLAN_RESERVED_MAX = 1005; // ... Token Ring / FDDI / ATM-FUNI defaults

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function isReservedVlan(vid) {
  return Number.isInteger(vid) && vid >= VLAN_RESERVED_MIN && vid <= VLAN_RESERVED_MAX;
}

function isValidVlan(vid) {
  return Number.isInteger(vid) && vid >= VLAN_MIN && vid <= VLAN_MAX;
}

// Every assignable VLAN id (1..4094 minus the reserved block). Built once; the
// returned copy is what callers get so nobody can corrupt the cache.
const ALL_VLANS = (function () {
  const list = [];
  for (let v = VLAN_MIN; v <= VLAN_MAX; v++) {
    if (!isReservedVlan(v)) list.push(v);
  }
  return list;
})();

function uniqSorted(values) {
  const seen = Object.create(null);
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (seen[v]) continue;
    seen[v] = true;
    out.push(v);
  }
  out.sort(function (a, b) { return a - b; });
  return out;
}

function pushUnique(list, entry) {
  for (let i = 0; i < list.length; i++) {
    if (list[i].code === entry.code && list[i].message === entry.message) return;
  }
  list.push(entry);
}

// Merge sorted, overlapping spans; touching-but-distinct spans are kept apart
// so the parsed ranges still mirror what the operator wrote.
function mergeRanges(spans) {
  const sorted = spans.slice().sort(function (a, b) {
    return a[0] === b[0] ? a[1] - b[1] : a[0] - b[0];
  });
  const out = [];
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i];
    const last = out[out.length - 1];
    if (last && cur[0] <= last[1]) {
      if (cur[1] > last[1]) last[1] = cur[1];
    } else {
      out.push([cur[0], cur[1]]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// parseVlanList
// ---------------------------------------------------------------------------
// Accepts 10 | [1, 10, 20] | '10' | '10,20-30' | 'all' (case-insensitive).
// Returns { ok, vlans:[int], ranges:[[lo,hi]], duplicates:[int], errors:[] }
// plus error/message (first failure) when ok is false. Ranges are the spans
// as written (after de-duplication of overlap); vlans is the expanded,
// sorted, de-duplicated membership list.

function parseVlanList(spec) {
  const out = {
    ok: false,
    vlans: [],
    ranges: [],
    duplicates: [],
    errors: [],
    error: null,
    message: null
  };

  function fail(code, message) {
    pushUnique(out.errors, { code: code, message: message });
  }

  const tokens = [];
  const pushTokenStrings = function (value) {
    const parts = String(value).trim().split(/[\s,]+/);
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] !== '') tokens.push(parts[i]);
    }
  };

  if (spec === null || spec === undefined) {
    fail('E_VLAN_EMPTY', 'VLAN list is empty');
  } else if (typeof spec === 'number') {
    tokens.push(String(spec));
  } else if (Array.isArray(spec)) {
    if (spec.length === 0) fail('E_VLAN_EMPTY', 'VLAN list is empty');
    for (let i = 0; i < spec.length; i++) {
      const item = spec[i];
      if (typeof item === 'number') tokens.push(String(item));
      else if (typeof item === 'string') pushTokenStrings(item);
      else fail('E_VLAN_SYNTAX', 'cannot parse VLAN entry ' + JSON.stringify(item));
    }
  } else if (typeof spec === 'string') {
    if (spec.trim() === '') fail('E_VLAN_EMPTY', 'VLAN list is empty');
    else pushTokenStrings(spec);
  } else {
    fail('E_VLAN_SYNTAX', 'unsupported VLAN list of type ' + typeof spec);
  }

  // ---- token -> span ----
  const spans = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.toLowerCase() === 'all') {
      spans.push({ lo: VLAN_MIN, hi: VLAN_MAX, all: true, text: tok });
      continue;
    }
    let m = tok.match(/^([0-9]+)$/);
    if (m) {
      const n = parseInt(m[1], 10);
      spans.push({ lo: n, hi: n, all: false, text: tok });
      continue;
    }
    m = tok.match(/^([0-9]+)\s*-\s*([0-9]+)$/);
    if (m) {
      let lo = parseInt(m[1], 10);
      let hi = parseInt(m[2], 10);
      if (lo > hi) { const t = lo; lo = hi; hi = t; }
      spans.push({ lo: lo, hi: hi, all: false, text: tok });
      continue;
    }
    fail('E_VLAN_SYNTAX', 'cannot parse VLAN token "' + tok + '"');
  }

  // ---- span -> ids ----
  const seen = Object.create(null);
  const dup = Object.create(null);
  const vlans = [];
  const rawRanges = [];

  for (let i = 0; i < spans.length; i++) {
    const sp = spans[i];
    if (sp.lo < VLAN_MIN || sp.hi > VLAN_MAX) {
      fail('E_VLAN_RANGE', 'VLAN ' + sp.text + ' is outside ' + VLAN_MIN + '-' + VLAN_MAX);
    }
    const lo = Math.max(sp.lo, VLAN_MIN);
    const hi = Math.min(sp.hi, VLAN_MAX);
    if (lo > hi) continue;
    rawRanges.push([sp.lo, sp.hi]);
    for (let v = lo; v <= hi; v++) {
      if (isReservedVlan(v)) {
        // 'all' is a shorthand, not an explicit request for the IEEE block.
        if (!sp.all) {
          fail('E_VLAN_RESERVED', 'VLAN ' + v + ' is reserved by IEEE 802.1Q (' +
            VLAN_RESERVED_MIN + '-' + VLAN_RESERVED_MAX + ')');
        }
        continue;
      }
      if (seen[v]) {
        if (!sp.all) dup[v] = true;
        continue;
      }
      seen[v] = true;
      vlans.push(v);
    }
  }

  vlans.sort(function (a, b) { return a - b; });
  out.vlans = vlans;
  out.ranges = mergeRanges(rawRanges);
  out.duplicates = Object.keys(dup).map(Number).sort(function (a, b) { return a - b; });
  out.ok = out.errors.length === 0;
  if (!out.ok) {
    out.error = out.errors[0].code;
    out.message = out.errors[0].message;
  }
  return out;
}

// True when vid is a member of the given list spec ('all' covers every
// assignable VLAN). Malformed specs and out-of-range ids yield false.
function vlanListIncludes(listSpec, vid) {
  const v = typeof vid === 'number' ? vid : parseInt(vid, 10);
  if (!isValidVlan(v)) return false;
  // The IEEE reserved block is never assignable, 'all' included.
  if (isReservedVlan(v)) return false;
  if (listSpec === 'all') return true;
  if (typeof listSpec === 'string' && listSpec.trim().toLowerCase() === 'all') return true;
  const parsed = parseVlanList(listSpec);
  if (!parsed.ok) return false;
  return parsed.vlans.indexOf(v) !== -1;
}

// ---------------------------------------------------------------------------
// normalizePortConfig
// ---------------------------------------------------------------------------
// Coerces a loosely-specified port config into the canonical six-field shape.
// Numeric values that are merely wrong (0, 5000, 1003) are preserved so that
// validatePortConfig() can report them; only missing/absurd types fall back to
// defaults. Missing allowedVlans on a trunk means "all" (device default).

function normalizePortConfig(cfg) {
  const raw = (cfg && typeof cfg === 'object') ? cfg : {};
  const mode = (typeof raw.mode === 'string' && raw.mode.trim().toLowerCase() === 'trunk')
    ? 'trunk' : 'access';

  const asInt = function (value) {
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^[0-9]+$/.test(value.trim())) return parseInt(value, 10);
    return null;
  };

  let accessVlan = asInt(raw.accessVlan);
  if (accessVlan === null) accessVlan = VLAN_DEFAULT;

  let nativeVlan = asInt(raw.nativeVlan);
  if (nativeVlan === null) nativeVlan = (mode === 'trunk') ? VLAN_DEFAULT : accessVlan;

  let allowedVlans;
  if (raw.allowedVlans === 'all') {
    allowedVlans = 'all';
  } else if (typeof raw.allowedVlans === 'string' && raw.allowedVlans.trim().toLowerCase() === 'all') {
    allowedVlans = 'all';
  } else if (raw.allowedVlans === undefined || raw.allowedVlans === null) {
    allowedVlans = (mode === 'trunk') ? 'all' : [];
  } else if (Array.isArray(raw.allowedVlans)) {
    allowedVlans = raw.allowedVlans.length === 0
      ? []
      : parseVlanList(raw.allowedVlans).vlans.slice();
  } else if (typeof raw.allowedVlans === 'string') {
    allowedVlans = parseVlanList(raw.allowedVlans).vlans.slice();
  } else {
    allowedVlans = [];
  }

  let pvid = asInt(raw.pvid);
  if (pvid === null) pvid = (mode === 'trunk') ? nativeVlan : accessVlan;

  let voiceVlan = asInt(raw.voiceVlan);
  if (voiceVlan === null || voiceVlan === 0) voiceVlan = null;

  return {
    mode: mode,
    accessVlan: accessVlan,
    nativeVlan: nativeVlan,
    allowedVlans: allowedVlans,
    pvid: pvid,
    voiceVlan: voiceVlan
  };
}

// ---------------------------------------------------------------------------
// frame classification
// ---------------------------------------------------------------------------

// Egress: which 802.1Q treatment does a frame for vlanId get on this port?
//
// `voiceVlan` is a second membership, not decoration. It was stored, validated and printed by the
// switchport reset - and read by nothing, so a phone's frames were classified into the data VLAN and
// the VLAN an operator had configured for voice carried nothing. Voice traffic is *tagged by
// definition* (that is what makes it distinguishable from the untagged data VLAN on the same port),
// so it wins over the native-VLAN rule: a port whose native VLAN happens to equal the voice VLAN
// still tags voice frames rather than stripping the tag that identifies them.
function classifyEgress(portConfig, vlanId) {
  const cfg = normalizePortConfig(portConfig);
  const vid = typeof vlanId === 'number' ? vlanId : parseInt(vlanId, 10);
  if (!isValidVlan(vid)) return { action: 'drop', vid: Number.isInteger(vid) ? vid : null };

  if (cfg.voiceVlan !== null && vid === cfg.voiceVlan) {
    return { action: 'tagged', vid: vid, voice: true };
  }

  if (cfg.mode === 'access') {
    if (vid !== cfg.accessVlan) return { action: 'drop', vid: vid };
    return { action: 'untagged', vid: vid };
  }

  // trunk
  if (!vlanListIncludes(cfg.allowedVlans, vid)) return { action: 'drop', vid: vid };
  if (vid === cfg.nativeVlan) return { action: 'untagged', vid: vid };
  return { action: 'tagged', vid: vid };
}

// Ingress: is an arriving frame accepted, and into which VLAN does it land?
// frame = { tagged: true|false, vid: int|null }
function classifyIngress(portConfig, frame) {
  const cfg = normalizePortConfig(portConfig);
  if (!frame || typeof frame !== 'object') {
    return { action: 'drop', vlanId: null, reason: 'malformed-frame' };
  }

  if (cfg.mode === 'access') {
    if (frame.tagged) {
      // A voice VLAN is the one tag an access port understands: the phone tags its own traffic and
      // the PC behind it speaks untagged, which is the whole point of the pair. Anything else
      // tagged is still refused, because an access port otherwise has no tag awareness at all.
      const vtag = typeof frame.vid === 'number' ? frame.vid : parseInt(frame.vid, 10);
      if (cfg.voiceVlan !== null && Number.isInteger(vtag) && vtag === cfg.voiceVlan) {
        return { action: 'accept', vlanId: vtag, voice: true };
      }
      return { action: 'drop', vlanId: null, reason: 'tagged-frame-on-access' };
    }
    return { action: 'accept', vlanId: cfg.accessVlan };
  }

  // trunk
  if (!frame.tagged) {
    return { action: 'accept', vlanId: cfg.nativeVlan };
  }
  const vid = typeof frame.vid === 'number' ? frame.vid : parseInt(frame.vid, 10);
  if (!Number.isInteger(vid)) {
    return { action: 'drop', vlanId: null, reason: 'tagged-frame-missing-vid' };
  }
  if (!isValidVlan(vid)) {
    return { action: 'drop', vlanId: null, reason: 'invalid-vid' };
  }
  if (!vlanListIncludes(cfg.allowedVlans, vid)) {
    return { action: 'drop', vlanId: null, reason: 'vlan-not-allowed' };
  }
  // Tagged on the trunk and in the voice VLAN: accepted, and said out loud. The classification is
  // the same VLAN either way - what differs is that a voice frame arrived tagged, which is the only
  // shape it ever has.
  if (cfg.voiceVlan !== null && vid === cfg.voiceVlan) {
    return { action: 'accept', vlanId: vid, voice: true };
  }
  return { action: 'accept', vlanId: vid };
}

// ---------------------------------------------------------------------------
// validatePortConfig
// ---------------------------------------------------------------------------
// ctx is advisory only ({ portName, lag, supportsVoice }); messages may quote a
// port name. Severity: range/reserved/missing-native/empty-trunk are errors,
// everything else is a warning. Note E_VOICE_VLAN_UNSUPPORTED keeps its
// historical E_ code but is reported as a warning.

function validatePortConfig(cfg, ctx) {
  const context = (ctx && typeof ctx === 'object') ? ctx : {};
  const prefix = context.portName ? (String(context.portName) + ': ') : '';
  const raw = (cfg && typeof cfg === 'object') ? cfg : {};
  const norm = normalizePortConfig(cfg);

  const errors = [];
  const warnings = [];
  const err = function (code, message) { pushUnique(errors, { code: code, message: prefix + message }); };
  const warn = function (code, message) { pushUnique(warnings, { code: code, message: prefix + message }); };

  const checkField = function (value, field) {
    if (value === null || value === undefined) return;
    if (!Number.isInteger(value)) {
      err('E_VLAN_RANGE', field + ' must be an integer VLAN id, got ' + String(value));
      return;
    }
    if (value < VLAN_MIN || value > VLAN_MAX) {
      err('E_VLAN_RANGE', field + ' ' + value + ' is outside ' + VLAN_MIN + '-' + VLAN_MAX);
      return;
    }
    if (isReservedVlan(value)) {
      err('E_VLAN_RESERVED', field + ' ' + value + ' is reserved by IEEE 802.1Q (' +
        VLAN_RESERVED_MIN + '-' + VLAN_RESERVED_MAX + ')');
    }
  };

  checkField(norm.accessVlan, 'accessVlan');
  checkField(norm.nativeVlan, 'nativeVlan');
  checkField(norm.pvid, 'pvid');
  checkField(norm.voiceVlan, 'voiceVlan');

  // ---- trunk membership ----
  let allowedIsAll = (norm.allowedVlans === 'all');
  let listParseFailed = false;

  if (norm.mode === 'trunk') {
    if (!allowedIsAll && raw.allowedVlans !== undefined && raw.allowedVlans !== null) {
      // An explicitly empty list is reported as E_TRUNK_NO_VLANS, not as a
      // parse failure, so do not hand it to the parser.
      const rawEmpty =
        (typeof raw.allowedVlans === 'string' && raw.allowedVlans.trim() === '') ||
        (Array.isArray(raw.allowedVlans) && raw.allowedVlans.length === 0);
      if (!rawEmpty) {
        const parsed = parseVlanList(raw.allowedVlans);
        if (!parsed.ok) {
          listParseFailed = true;
          for (let i = 0; i < parsed.errors.length; i++) {
            err(parsed.errors[i].code, parsed.errors[i].message);
          }
        }
        if (parsed.duplicates.length) {
          warn('W_DUP_VLAN_IN_LIST', 'duplicate VLAN(s) in allowed list: ' +
            parsed.duplicates.join(', '));
        }
      }
    }

    if (!allowedIsAll && norm.allowedVlans.length === 0 && !listParseFailed) {
      err('E_TRUNK_NO_VLANS', 'trunk port has an empty allowed VLAN list');
    }

    if (!allowedIsAll && norm.allowedVlans.length > 0) {
      if (!vlanListIncludes(norm.allowedVlans, norm.nativeVlan)) {
        err('E_NATIVE_NOT_ALLOWED', 'native VLAN ' + norm.nativeVlan +
          ' is not in the allowed VLAN list');
      }
    }

    if (norm.nativeVlan === VLAN_DEFAULT) {
      warn('W_VLAN1_AS_NATIVE', 'VLAN 1 is used as the trunk native VLAN; ' +
        'best practice is an unused VLAN');
    }

    if (raw.accessVlan !== undefined && raw.accessVlan !== null) {
      warn('W_ACCESS_ON_TRUNK', 'accessVlan ' + norm.accessVlan +
        ' is set on a trunk port and is ignored');
    }
  }

  // ---- voice VLAN ----
  //
  // A phone port is an access port *plus* a tagged second VLAN: the phone tags its own traffic into
  // the voice VLAN, the PC behind it speaks untagged in the access VLAN. This used to be reported as
  // unsupported ("voiceVlan 20 needs a trunk"), which was true only while nothing classified voice
  // traffic at all - the warning described the missing classifier, not the hardware (issue #1369).
  if (norm.voiceVlan !== null && norm.mode === 'access' && norm.voiceVlan === norm.accessVlan) {
    err('E_VOICE_VLAN_ACCESS',
      'voice VLAN ' + norm.voiceVlan + ' is the access VLAN on this port, which is the VLAN that ' +
      'leaves untagged - voice traffic is always tagged, so it needs a VLAN of its own');
  }
  // A voice VLAN *is* always tagged, so a port cannot use the same VLAN for both: an untagged
  // native VLAN and a tagged voice VLAN are the two halves of what a phone port distinguishes.
  // Setting both to one number used to be accepted and stored, and the classifier then had two
  // rules for one VLAN and picked one silently.
  if (norm.voiceVlan !== null && norm.mode === 'trunk' && norm.voiceVlan === norm.nativeVlan) {
    err('E_VOICE_VLAN_NATIVE', 'voice VLAN ' + norm.voiceVlan + ' is also the native VLAN, ' +
      'which is the VLAN that leaves untagged - voice traffic is always tagged, so pick another');
  }
  if (norm.voiceVlan !== null && norm.mode === 'trunk' && !allowedIsAll &&
      norm.allowedVlans.length > 0 && !vlanListIncludes(norm.allowedVlans, norm.voiceVlan)) {
    err('E_VOICE_NOT_ALLOWED', 'voice VLAN ' + norm.voiceVlan + ' is not in the allowed VLAN ' +
      'list, so a phone\'s tagged frames would be dropped by the same port that was told to carry ' +
      'them');
  }

  return { ok: errors.length === 0, errors: errors, warnings: warnings };
}

// ---------------------------------------------------------------------------
// framesCompatible
// ---------------------------------------------------------------------------
// LAG members must classify frames identically. Access ports match when they
// carry the same VLAN; trunks match when native VLAN and allowed set are equal.

function framesCompatible(cfgA, cfgB) {
  const a = normalizePortConfig(cfgA);
  const b = normalizePortConfig(cfgB);
  if (a.mode !== b.mode) return false;

  if (a.mode === 'access') return a.accessVlan === b.accessVlan;

  if (a.nativeVlan !== b.nativeVlan) return false;
  if (a.allowedVlans === 'all' || b.allowedVlans === 'all') {
    return a.allowedVlans === 'all' && b.allowedVlans === 'all';
  }
  const listA = Array.isArray(a.allowedVlans) ? a.allowedVlans : [];
  const listB = Array.isArray(b.allowedVlans) ? b.allowedVlans : [];
  if (listA.length !== listB.length) return false;
  for (let i = 0; i < listA.length; i++) {
    if (listA[i] !== listB[i]) return false;
  }
  return true;
}

module.exports = {
  VLAN_MIN,
  VLAN_MAX,
  VLAN_DEFAULT,
  parseVlanList,
  vlanListIncludes,
  normalizePortConfig,
  classifyEgress,
  classifyIngress,
  validatePortConfig,
  framesCompatible
};
