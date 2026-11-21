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
// The four VLANs a switch is born with. 1002-1005 are the reserved Token Ring / FDDI defaults: they exist on
// every IOS-like switch before a single line of configuration, no port may be put in one, and `show vlan`
// prints them as `act/unsup` with an empty Ports column (Cisco Catalyst 2960-X command reference, `show vlan`).
// The names sit beside the range they occupy, so the refusal ("VLAN id 1002 is reserved") and the row that
// prints it are talking about the same four ids.
const RESERVED_VLANS = Object.freeze([
  { id: 1002, name: 'fddi-default' },
  { id: 1003, name: 'token-ring-default' },
  { id: 1004, name: 'fddinet-default' },
  { id: 1005, name: 'trnet-default' }
]);
// How long a VLAN name may be. Every Cisco reference that documents the field gives the same range - 1 to 32
// characters - and the width of the Name column in `show vlan` is the same 32, so the two are one fact and live
// together: a name that cannot fit the field cannot be stored, and a stored name always fits the field.
//   * Cisco IOS LAN Switching Command Reference, `show vlan`: "the VLAN name is an ASCII string from 1 to 32
//     characters"
//     https://www.cisco.com/c/en/us/td/docs/ios/lanswitch/command/reference/lsw_book/lsw_s2.html
//   * Catalyst 2960-X 15.2(6)E command reference, `vlan`: "names the VLAN with an ASCII string from 1 to 32
//     characters that must be unique within the administrative domain"
//     https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15_2_6_e/command_reference/b_1526_2960x_cr.pdf
//   * Catalyst 1200/1300 CLI guide, `vlan`: "vlan-name - Specifies the VLAN name. (range: 1-32 characters)"
//     https://www.cisco.com/c/en/us/td/docs/switches/campus-lan-switches-access/Catalyst-1200-and-1300-Switches/cli/C1300-cli/vlan-commands.html
// What a box does with a longer one is not witnessed for IOS (research/vlan-name-length.md), so the refusal
// below speaks in this console's own words while the limit it quotes is the vendor's.
const VLAN_NAME_MAX = 32;
const VLAN_RESERVED_MIN = RESERVED_VLANS[0].id;                        // Cisco's media defaults: FDDI ...
const VLAN_RESERVED_MAX = RESERVED_VLANS[RESERVED_VLANS.length - 1].id; // ... Token Ring / FDDI / ATM-FUNI defaults

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function isReservedVlan(vid) {
  return Number.isInteger(vid) && vid >= VLAN_RESERVED_MIN && vid <= VLAN_RESERVED_MAX;
}

function isValidVlan(vid) {
  return Number.isInteger(vid) && vid >= VLAN_MIN && vid <= VLAN_MAX;
}

// A VLAN the bridge always holds, whatever `config.vlans` says: the default VLAN and the four media defaults.
// Their existence cannot be deleted, so a port sitting on one of them is never waiting for a VLAN to come
// back - which is what makes it the complete test for "is this port's VLAN still in the database?".
function vlanIsBuiltIn(vid) {
  const id = Number(vid);
  return id === VLAN_DEFAULT || isReservedVlan(id);
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

function parseVlanList(spec, opts) {
  // A vlan-list is read by two kinds of caller, and they disagree about the four
  // media defaults. A port's access, native or voice VLAN cannot be 1002: the
  // VLAN's media is Token Ring/FDDI, nothing Ethernet can join it, so naming one
  // is an error. A trunk's *allowed* list is the other case - 1002-1005 are
  // members of it on every box (the default list is `1-4094`, and a switch
  // refuses to remove them), so the caller that reads an allowed list passes
  // `keepReserved: true` and gets them back as ordinary members instead of a
  // refusal. The default stays strict, which is what keeps the access door honest.
  const options = (opts && typeof opts === 'object') ? opts : {};
  const keepReserved = options.keepReserved === true;
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
      const lo = parseInt(m[1], 10);
      const hi = parseInt(m[2], 10);
      // A range is written low-to-high, and a switch does not read `30-20` as `20-30` - Cisco's own
      // vlan-list note says the range is "two VLAN numbers, the lower one first"
      // (research/vlan-range-order.md). This parser used to swap the pair and carry on, so a transposed
      // range silently configured the VLANs the operator had *not* named, and every view then reported
      // the swap as if it were what was typed.
      if (lo > hi) {
        fail('E_VLAN_RANGE_ORDER', 'VLAN range ' + tok + ' runs backwards: give the lower id first (' +
          hi + '-' + lo + ')');
        continue;
      }
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
        // 'all' is a shorthand for the assignable range, never an explicit request
        // for the four media defaults, so it skips them whatever the caller asked.
        if (sp.all) continue;
        if (!keepReserved) {
          fail('E_VLAN_RESERVED', 'VLAN ' + v + ' is reserved: it is one of the four FDDI and ' +
            'Token Ring defaults (' + VLAN_RESERVED_MIN + '-' + VLAN_RESERVED_MAX + ')');
          continue;
        }
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

// A list already in the shape parseVlanList() would produce: integers, in range,
// none of the reserved block, strictly ascending. Recognising it is one pass of
// integer comparisons, where parsing it is a string conversion, a regex and a
// sort per entry. That difference is the whole of #1809: a trunk built by
// `switchport trunk allowed vlan remove 2` allows 4,089 ids, and every frame on
// it asked a yes/no question that cost a full tokenisation to answer.
function isCanonicalVlanArray(list) {
  if (!Array.isArray(list) || list.length === 0) return false;
  let prev = 0;                       // VLAN_MIN is 1, so the first id must exceed it
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    // v <= prev also rejects duplicates and any unsorted list, both of which have
    // to keep going through the parser so they normalise to one answer.
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= prev) return false;
    // The media defaults are not rejected here: a trunk's allowed list holds them
    // (parseVlanList(..., { keepReserved: true })), and a canonical array is a
    // member list, not an assignable list - the assignable question is asked by
    // the parsers and by classifyEgress, not by this shape check.
    if (v > VLAN_MAX) return false;                        // v >= VLAN_MIN follows from v > prev >= 0
    prev = v;
  }
  return true;
}

// Membership in a list isCanonicalVlanArray() accepted: strictly ascending, so a
// binary search. Correctness against a linear scan is pinned by
// test/vlan-membership-lookup.test.js for every id 1-4094.
function canonicalVlanIncludes(sorted, v) {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cur = sorted[mid];
    if (cur === v) return true;
    if (cur < v) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

// True when vid is a member of the given list spec ('all' covers every
// assignable VLAN). Malformed specs and out-of-range ids yield false.
function vlanListIncludes(listSpec, vid) {
  const v = typeof vid === 'number' ? vid : parseInt(vid, 10);
  if (!isValidVlan(v)) return false;
  // The four media defaults are never assignable, 'all' included.
  if (isReservedVlan(v)) return false;
  if (listSpec === 'all') return true;
  if (typeof listSpec === 'string' && listSpec.trim().toLowerCase() === 'all') return true;
  if (isCanonicalVlanArray(listSpec)) return canonicalVlanIncludes(listSpec, v);
  const parsed = parseVlanList(listSpec);
  if (!parsed.ok) return false;
  return parsed.vlans.indexOf(v) !== -1;
}

// ---------------------------------------------------------------------------
// formatVlanList / allVlansExcept
// ---------------------------------------------------------------------------
// A VLAN list as the box prints it: a run of consecutive ids folds into a range, but a pair does not.
//
// A Catalyst prints a trunk's allowed list as `1-4,7,11,13-4094`, not one number per VLAN - the allowed list
// in a c3550 transcript of `switchport trunk allowed vlan remove 5-10,12` plus `add 7`
// (research/trunk-allowed-remove-from-all.md). Keeping that shape matters once a list can be "all but one
// VLAN": the same configuration is one short line (`1,3-1001,1006-4094`) instead of 4,090 numbers, which is
// what makes it something an operator can read, diff and type back.
//
// The threshold is three ids, not two. A range is written only where it is **shorter** than the comma list it
// replaces - `3-5` for `3,4,5`, but `81,82` (five characters either way) stays spelled out. Three
// `show running-config` captures print a pair as two ids and no capture prints a pair as a range:
//
//   switchport trunk allowed vlan 1,81,82,171,999            (Cisco support doc 68100, `w-backbone-6k`)
//   switchport trunk allowed vlan 59,157,158,160             (MEXSWP04-NAP, `sh run int fa2/0/39`)
//   switchport trunk allowed vlan 55,56,59,155,157,158,160,200 (MEXSW09-NAP, `sh run int gi1/0/3`)
//
// while the c3550 folds a run of four (`1-4`) and the four-thousand-long tail (`13-4094`). Folding a pair was this
// file's guess - the research note recorded it as the unsettled half - and it made a replayed backup differ
// from the line the box prints, which is what a diff against a real device compares.
// research/trunk-allowed-two-id-run.md carries the captures and the arithmetic.
function formatVlanList(ids) {
  const list = Array.isArray(ids) ? ids.slice() : [];
  list.sort(function (a, b) { return Number(a) - Number(b); });
  const out = [];
  // One band as the box writes it: one id, two ids, or a range from three up.
  const band = function (a, b) {
    if (a === b) return String(a);
    if (b === a + 1) return a + ',' + b;
    return a + '-' + b;
  };
  let lo = null;
  let hi = null;
  for (let i = 0; i < list.length; i++) {
    const v = Number(list[i]);
    if (!Number.isInteger(v)) continue;
    if (lo === null) { lo = v; hi = v; continue; }
    if (v === hi) continue;
    if (v === hi + 1) { hi = v; continue; }
    out.push(band(lo, hi));
    lo = v; hi = v;
  }
  if (lo !== null) out.push(band(lo, hi));
  return out.join(',');
}

// What `switchport trunk allowed vlan remove <list>` means on a trunk that still allows the default "all":
// every id in 1-4094 except the ones named - *including* the four media defaults, because they cannot be
// removed from a trunk. That is why the c3550's answer to `remove 5-10,12` is `1-4,11,13-4094` and not
// `1-4,11,13-1001,1006-4094`: the device's remainder runs through 1002-1005 as one range, and a model that
// deleted them printed a list the box cannot produce (research/trunk-allowed-reserved-vlans.md).
function allVlansExcept(removed) {
  const gone = Object.create(null);
  const list = Array.isArray(removed) ? removed : [];
  for (let i = 0; i < list.length; i++) gone[Number(list[i])] = true;
  const out = [];
  for (let v = VLAN_MIN; v <= VLAN_MAX; v++) {
    if (gone[v]) continue;
    out.push(v);
  }
  return out;
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
    // A list that is already canonical parses to itself, so the copy is the only
    // work left to do. Copying it anyway is deliberate: the returned config owns
    // its array, and a caller must not be able to edit the input through it.
    allowedVlans = raw.allowedVlans.length === 0
      ? []
      : (isCanonicalVlanArray(raw.allowedVlans)
        ? raw.allowedVlans.slice()
        : parseVlanList(raw.allowedVlans, { keepReserved: true }).vlans.slice());
  } else if (typeof raw.allowedVlans === 'string') {
    allowedVlans = parseVlanList(raw.allowedVlans, { keepReserved: true }).vlans.slice();
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
    ? 'all' : (cfg.allowedVlans.length ? formatVlanList(cfg.allowedVlans) : 'none');
  const voice = cfg.voiceVlan !== null && cfg.voiceVlan !== undefined ? Number(cfg.voiceVlan) : null;
  if (mode === 'trunk') {
    // A trunk stores this parameter and never consults it. Cisco voice VLAN is an access-port feature and its
    // configuration is not supported on trunk ports - a trunk carries any number of VLANs similar to regular
    // VLANs, so the allowed list alone decides what it carries (Catalyst 9200 VLAN guide, Configuring Voice
    // VLANs). The parameter is still printed: it is still in the configuration an operator would copy back.
    return 'trunk · native ' + cfg.nativeVlan + ' · allowed ' + allowed +
      (voice === null ? '' : ' · voice ' + voice + ' (no effect on a trunk)');
  }
  let line = 'access VLAN ' + cfg.accessVlan;
  // The voice VLAN is in force on an access port: the phone tags its own frames with it and the PC behind the
  // phone sends untagged frames into the access VLAN, so the port carries two VLANs without becoming a trunk.
  // The same vendor note rules the other way - voice VLAN configuration is only supported on device access
  // ports - which is the reverse of what this console used to say (research/voice-vlan-port-mode.md).
  // A voice VLAN equal to the access VLAN adds a second name for the VLAN the port already carries, so the
  // sentence stays short: the classifier files a tagged frame there as the access VLAN, which is untagged.
  if (voice !== null && voice !== cfg.accessVlan) line += ' · voice ' + voice + ' (tagged)';
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
    staged.push('allowed ' + formatVlanList(rawAllowed));
  } else if (typeof rawAllowed === 'string' && rawAllowed.trim() &&
      rawAllowed.trim().toLowerCase() !== 'all') {
    staged.push('allowed ' + rawAllowed.trim());
  }
  // Stored, not in force. Saying "access VLAN 1" alone would leave the operator believing the trunk settings
  // they typed a moment ago had gone somewhere. The voice VLAN is not one of them any more: on an access port
  // it is live, and it is printed above as the second VLAN the port carries.
  if (staged.length) line += ' · trunk staged: ' + staged.join(', ') + ' (not in use)';
  return line;
}

function classifyEgress(portConfig, vlanId) {
  const cfg = normalizePortConfig(portConfig);
  const vid = typeof vlanId === 'number' ? vlanId : parseInt(vlanId, 10);
  if (!isValidVlan(vid)) return { action: 'drop', vid: Number.isInteger(vid) ? vid : null };

  const voice = cfg.voiceVlan !== null && cfg.voiceVlan !== undefined ? Number(cfg.voiceVlan) : null;

  if (cfg.mode === 'access') {
    // An access port with a voice VLAN is a two-VLAN port: untagged data in the access VLAN and tagged voice in
    // the voice VLAN. It is still not a trunk, so every other VLAN is dropped - the parameter adds one VLAN to
    // an access port rather than letting it carry an arbitrary set.
    if (voice !== null && vid === voice && vid !== cfg.accessVlan) {
      return { action: 'tagged', vid: vid, voice: true };
    }
    if (vid !== cfg.accessVlan) return { action: 'drop', vid: vid };
    return { action: 'untagged', vid: vid };
  }

  // trunk
  // The allowed list is the whole answer. A voice VLAN on a trunk is stored and never consulted: the vendor note
  // is that a trunk can carry any number of voice VLANs similar to regular VLANs, while the configuration of
  // voice VLANs is not supported on trunk ports - so the parameter neither adds a VLAN to the trunk nor exempts
  // one from the allowed list (research/voice-vlan-port-mode.md).
  if (!vlanListIncludes(cfg.allowedVlans, vid)) {
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
      // The one tag an access port understands is its voice VLAN: a phone tags its own traffic and the switch
      // puts that traffic in the voice VLAN. Every other tagged frame is still refused - that is what keeps the
      // port an access port and not a trunk.
      const voiceIn = cfg.voiceVlan === null || cfg.voiceVlan === undefined ? null : Number(cfg.voiceVlan);
      const vid = typeof frame.vid === 'number' ? frame.vid : parseInt(frame.vid, 10);
      if (voiceIn !== null && Number.isInteger(vid) && vid === voiceIn && vid !== cfg.accessVlan) {
        return { action: 'accept', vlanId: vid, voice: true };
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
  // No voice exemption here either: a trunk is told what to carry by its allowed list, and a voice VLAN in the
  // configuration without a matching entry in that list is not carried - the parameter has no effect on a trunk.
  if (!vlanListIncludes(cfg.allowedVlans, vid)) {
    return { action: 'drop', vlanId: null, reason: 'vlan-not-allowed' };
  }
  const voiceIn = cfg.voiceVlan !== null && cfg.voiceVlan !== undefined ? Number(cfg.voiceVlan) : null;
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
      err('E_VLAN_RESERVED', field + ' ' + id + ' is reserved: it is one of the four FDDI and ' +
        'Token Ring defaults (' + VLAN_RESERVED_MIN + '-' + VLAN_RESERVED_MAX + ')');
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
        const parsed = parseVlanList(raw.allowedVlans, { keepReserved: true });
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
  // A voice VLAN is an access-port feature: the phone tags its own frames and the PC behind it stays untagged in
  // the access VLAN. On a trunk the parameter is accepted and stored - the vendor note says the configuration is
  // allowed there - but it has no effect, because a trunk carries any number of VLANs as ordinary VLANs. This
  // check said the opposite in both directions: it refused the feature on an access port, the one place it
  // works, and said nothing on a trunk, the one place it does not.
  if (norm.voiceVlan !== null && norm.mode === 'trunk') {
    warn('E_VOICE_VLAN_UNSUPPORTED',
      'voiceVlan ' + norm.voiceVlan + ' has no effect on a trunk port: a voice VLAN applies to access ports');
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

  if (a.mode === 'access') {
    // Two access ports in the same data VLAN still file a phone tagged frame differently when their voice VLANs
    // differ, so a LAG needs the voice VLAN to match as well.
    return a.accessVlan === b.accessVlan && a.voiceVlan === b.voiceVlan;
  }

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

// Why two switchports cannot carry each other's frames, in one sentence, or null when they can (#1445).
//
// `framesCompatible()` answers yes or no, and its only caller has been its own test: it is the rule for "do these two
// ports file a frame the same way", which is exactly what the two ends of a trunk must do. A reader told "no" needs
// the reason, and the reason is what belongs in the cable inspector and in the drop a dead frame leaves behind - one
// sentence, so the two surfaces cannot describe the same misconfiguration differently.
function mismatchReason(cfgA, cfgB) {
  const a = normalizePortConfig(cfgA);
  const b = normalizePortConfig(cfgB);
  if (framesCompatible(cfgA, cfgB)) return null;
  // The sentence is written so it reads the same from either end of the cable, and so the same cable cannot be
  // described two ways depending on which box asked: the smaller number comes first, whatever the caller passed.
  const pair = function (one, two, what) {
    const lo = Math.min(Number(one), Number(two));
    const hi = Math.max(Number(one), Number(two));
    return what + ' ' + lo + ' against ' + what + ' ' + hi;
  };
  if (a.mode !== b.mode) {
    const label = function (mode) { return mode === 'access' ? 'an access port' : 'a trunk port'; };
    return 'one end is ' + label(a.mode) + ' and the other is ' + label(b.mode);
  }
  if (a.mode === 'access') {
    if (a.accessVlan !== b.accessVlan) return pair(a.accessVlan, b.accessVlan, 'access VLAN');
    const voiceName = function (v) { return v === null || v === undefined ? 'none' : String(v); };
    return 'different voice VLANs (' + voiceName(a.voiceVlan) + ' against ' + voiceName(b.voiceVlan) + ')';
  }
  if (a.nativeVlan !== b.nativeVlan) return pair(a.nativeVlan, b.nativeVlan, 'native VLAN') + ' on a trunk';
  const lists = [describeAllowed(a.allowedVlans), describeAllowed(b.allowedVlans)].sort();
  return 'different allowed VLAN lists (' + lists[0] + ' against ' + lists[1] + ')';
}

// `all` and a list are both legal; a sentence has to say which without printing `[object Object]`.
function describeAllowed(allowed) {
  if (allowed === 'all') return 'all';
  if (!Array.isArray(allowed)) return String(allowed);
  return allowed.length ? formatVlanList(allowed) : 'none';
}

module.exports = {
  VLAN_MIN,
  VLAN_NAME_MAX,
  RESERVED_VLANS,
  vlanIsBuiltIn,
  VLAN_MAX,
  VLAN_DEFAULT,
  parseVlanList,
  formatVlanList,
  allVlansExcept,
  vlanListIncludes,
  normalizePortConfig,
  isReservedVlan,
  classifyEgress,
  switchportSentence,
  classifyIngress,
  validatePortConfig,
  framesCompatible,
  mismatchReason
};
