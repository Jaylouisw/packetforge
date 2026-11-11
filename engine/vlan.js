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
// One sentence for what a port does with a frame. Two surfaces show it - the console (`show interfaces
// <port>`, after "switchport: ") and the inspector panel in the browser - so it is written once here and
// mirrored in web/app.js, with test/switchport-agreement.test.js comparing the two. Two renderings of one
// fact drift silently: the panel said `access 1` for a port the console reported as staged for a trunk,
// because only one of them knew about stored-but-not-in-use parameters.
function switchportSentence(portConfig) {
  const raw = (portConfig && typeof portConfig === 'object') ? portConfig : {};
  const cfg = normalizePortConfig(raw);
  const mode = cfg.mode === 'trunk' ? 'trunk' : 'access';
  // An empty list is a trunk that allows nothing - `classifyEgress` drops every VLAN on it - so it is printed
  // as `none`, not as `all`. Only the unset field means all.
  const allowed = (cfg.allowedVlans === 'all' || !Array.isArray(cfg.allowedVlans))
    ? 'all' : (cfg.allowedVlans.length ? cfg.allowedVlans.join(',') : 'none');
  const voiceText = cfg.voiceVlan !== null && cfg.voiceVlan !== undefined
    ? ' · voice ' + Number(cfg.voiceVlan) : '';
  if (mode === 'trunk') {
    return 'trunk · native ' + cfg.nativeVlan + ' · allowed ' + allowed + voiceText;
  }
  let line = 'access VLAN ' + cfg.accessVlan;
  // "Staged" is read from the stored fields, not from the normalised ones: the normaliser derives a native VLAN
  // from the access VLAN when the field is absent, so asking it would report a staged parameter on every access
  // port in a non-default VLAN.
  const staged = [];
  const rawNative = raw.nativeVlan;
  if (rawNative !== undefined && rawNative !== null && Number(rawNative) !== 1) {
    staged.push('native ' + Number(rawNative));
  }
  const rawAllowed = raw.allowedVlans;
  if (Array.isArray(rawAllowed) && rawAllowed.length) {
    staged.push('allowed ' + rawAllowed.join(','));
  } else if (typeof rawAllowed === 'string' && rawAllowed.trim() &&
      rawAllowed.trim().toLowerCase() !== 'all') {
    staged.push('allowed ' + rawAllowed.trim());
  }
  // Stored, not in force. Saying "access VLAN 1" alone would leave the operator believing the trunk settings
  // they typed a moment ago had gone somewhere.
  if (cfg.voiceVlan !== null && cfg.voiceVlan !== undefined) {
    staged.push('voice ' + Number(cfg.voiceVlan));
  }
  if (staged.length) line += ' · trunk staged: ' + staged.join(', ') + ' (not in use)';
  return line;
}

function classifyEgress(portConfig, vlanId) {
  const cfg = normalizePortConfig(portConfig);
  const vid = typeof vlanId === 'number' ? vlanId : parseInt(vlanId, 10);
  if (!isValidVlan(vid)) return { action: 'drop', vid: Number.isInteger(vid) ? vid : null };

  if (cfg.mode === 'access') {
    if (vid !== cfg.accessVlan) return { action: 'drop', vid: vid };
    return { action: 'untagged', vid: vid };
  }

  // trunk
  // The voice VLAN is carried by the trunk whether or not it appears in the allowed list: that field is how the
  // switch is told which VLAN voice traffic arrives on, and `validatePortConfig` already insists it be a trunk
  // because voice traffic is tagged. It was stored, validated, printed - and read by nothing (#1368).
  const voice = cfg.voiceVlan !== null && cfg.voiceVlan !== undefined ? Number(cfg.voiceVlan) : null;
  if (!vlanListIncludes(cfg.allowedVlans, vid) && !(voice !== null && vid === voice)) {
    return { action: 'drop', vid: vid };
  }
  if (vid === cfg.nativeVlan) return { action: 'untagged', vid: vid };
  const out = { action: 'tagged', vid: vid };
  // Only present when it is true: the verdict for an ordinary VLAN keeps exactly the shape it always had.
  if (voice !== null && vid === voice) out.voice = true;
  return out;
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
      // Strict 802.1Q: an access port has no tag awareness at all.
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
  const voiceIn = cfg.voiceVlan !== null && cfg.voiceVlan !== undefined ? Number(cfg.voiceVlan) : null;
  if (!vlanListIncludes(cfg.allowedVlans, vid) && !(voiceIn !== null && vid === voiceIn)) {
    return { action: 'drop', vlanId: null, reason: 'vlan-not-allowed' };
  }
  const accepted = { action: 'accept', vlanId: vid };
  if (voiceIn !== null && vid === voiceIn) accepted.voice = true;
  return accepted;
}

// ---------------------------------------------------------------------------
// validatePortConfig
// ---------------------------------------------------------------------------
// ctx is advisory only ({ portName, lag, supportsVoice }); messages may quote a
// port name. Severity: range/reserved/missing-native/empty-trunk are errors,
// everything else is a warning. Note E_VOICE_VLAN_UNSUPPORTED keeps its
// historical E_ code but is reported as a warning.

// How a refused value is named back to the caller: a NaN or an object would otherwise read as "got NaN" or
// "got [object Object]" and tell the operator nothing about what they typed.
function describe(value) {
  if (typeof value === 'number' && Number.isNaN(value)) return 'NaN';
  if (typeof value === 'string') return '"' + value + '"';
  if (value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function validatePortConfig(cfg, ctx) {
  const context = (ctx && typeof ctx === 'object') ? ctx : {};
  const prefix = context.portName ? (String(context.portName) + ': ') : '';
  const raw = (cfg && typeof cfg === 'object') ? cfg : {};
  const norm = normalizePortConfig(cfg);

  const errors = [];
  const warnings = [];
  const err = function (code, message) { pushUnique(errors, { code: code, message: prefix + message }); };
  const warn = function (code, message) { pushUnique(warnings, { code: code, message: prefix + message }); };

  // Validate what the caller passed, not what the normaliser made of it (#1409).
  //
  // `normalizePortConfig` exists to hand the engine a usable port, so it replaces a value it cannot read with
  // VLAN 1. Feeding the *normalised* copy to the validator therefore meant every unusable value arrived as a
  // safe 1 and passed: `{ accessVlan: NaN }`, `{ accessVlan: 1.5 }` and `{ accessVlan: 'WORD' }` all came back
  // ok, and the integer rule below - written for exactly those values - could never fire, because the only
  // numbers that reached it were the ones the normaliser had already turned into integers.
  //
  // The console then used its own `parseInt` result rather than the normalised one, so `vlan WORD` created a
  // VLAN numbered NaN and `switchport access vlan WORD` answered "Access VLAN NaN on 1", while `show
  // interfaces`, `show vlan` and the saved file all reported VLAN 1 - four reports of one port, two of them
  // about a number that does not exist.
  const valueOf = function (field) {
    const rawValue = raw[field];
    if (rawValue === undefined || rawValue === null) return norm[field];
    // A voice VLAN of 0 has always meant "none" in this file, and the normaliser turns it into null.
    if (field === 'voiceVlan' && rawValue === 0) return null;
    return rawValue;
  };

  // An all-digit string is a VLAN id the caller may legitimately hold ("20" out of a config file or a form),
  // and the normaliser accepts it; anything else is refused with the value that was given.
  const asWholeNumber = function (value) {
    if (typeof value === 'number') return Number.isInteger(value) ? value : null;
    if (typeof value === 'string' && /^[0-9]+$/.test(value.trim())) return parseInt(value.trim(), 10);
    return null;
  };

  const checkField = function (value, field) {
    if (value === null || value === undefined) return;
    const id = asWholeNumber(value);
    if (id === null) {
      err('E_VLAN_RANGE', field + ' must be a whole-number VLAN id, got ' + describe(value));
      return;
    }
    if (id < VLAN_MIN || id > VLAN_MAX) {
      err('E_VLAN_RANGE', field + ' ' + id + ' is outside ' + VLAN_MIN + '-' + VLAN_MAX);
      return;
    }
    if (isReservedVlan(id)) {
      err('E_VLAN_RESERVED', field + ' ' + id + ' is reserved by IEEE 802.1Q (' +
        VLAN_RESERVED_MIN + '-' + VLAN_RESERVED_MAX + ')');
    }
  };

  checkField(valueOf('accessVlan'), 'accessVlan');
  checkField(valueOf('nativeVlan'), 'nativeVlan');
  checkField(valueOf('pvid'), 'pvid');
  checkField(valueOf('voiceVlan'), 'voiceVlan');

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
  if (norm.voiceVlan !== null && norm.mode === 'access') {
    warn('E_VOICE_VLAN_UNSUPPORTED',
      'voiceVlan ' + norm.voiceVlan + ' needs a trunk (voice traffic is tagged)');
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
  switchportSentence,
  classifyIngress,
  validatePortConfig,
  framesCompatible
};
