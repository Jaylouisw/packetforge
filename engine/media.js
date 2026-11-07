'use strict';
// media.js -- physical media, transceiver and port-hardware model.
//
// A port is modelled as a *cage* (the physical connector/cage on the box) plus
// the set of media (optics / copper / DAC) it can carry. Cabling two ports is
// only valid when the cages mate, at least one medium is shared by both ports,
// and a common speed can be negotiated.
//
// Everything here is pure data + pure functions: no dependency on Device or
// Topology, so it is safe to require from the engine, the server or tests.

// ---------------------------------------------------------------------------
// speed helpers
// ---------------------------------------------------------------------------

// Parse the terse speed strings used in device specs ("1G", "10G", "2.5G",
// "100M", "867M", "100G") into Mbps. A bare number is treated as Mbps.
function parseSpeedMbps(s) {
  if (s === null || s === undefined || s === '') return null;
  if (typeof s === 'number') return s;
  const m = String(s).trim().match(/^([0-9]*\.?[0-9]+)\s*([KMGT]?)\s*(?:b(?:it)?s?)?(?:\/s)?$/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  if (isNaN(v)) return null;
  switch (m[2].toUpperCase()) {
    case '': return v;
    case 'K': return v / 1000;
    case 'M': return v;
    case 'G': return v * 1000;
    case 'T': return v * 1000000;
    default: return null;
  }
}

// Render Mbps back to the short form used in the specs/UI.
function formatSpeedMbps(mbps) {
  if (mbps === null || mbps === undefined) return null;
  if (mbps >= 1000000) return (mbps / 1000000) + 'T';
  if (mbps >= 1000) return (mbps / 1000) + 'G';
  return Math.round(mbps) + 'M';
}

// ---------------------------------------------------------------------------
// media catalogue (one entry per cable/optic type)
// ---------------------------------------------------------------------------
// family: 'copper' | 'fiber' | 'dac' | 'console' | 'wireless'
// connector: physical connector the medium presents ('rj45' | 'lc' | 'mpo' | 'sfp' | 'qsfp' | 'usb' | 'console')
// speedMbps: line rate
// maxRangeM: practical maximum reach in metres (null = unbounded / n/a)
// cable: minimum copper cable category (copper only)
// fiber: 'mmf' | 'smf' | 'both'
// poe: true if the medium can carry PoE (copper only)

const MEDIA = {
  // ---- copper ----
  '10base-t': { name: '10BASE-T', family: 'copper', connector: 'rj45', speedMbps: 10, maxRangeM: 100, cable: 'cat3', poe: true },
  '100base-tx': { name: '100BASE-TX', family: 'copper', connector: 'rj45', speedMbps: 100, maxRangeM: 100, cable: 'cat5', poe: true },
  '1000base-t': { name: '1000BASE-T', family: 'copper', connector: 'rj45', speedMbps: 1000, maxRangeM: 100, cable: 'cat5e', poe: true },
  '2.5gbase-t': { name: '2.5GBASE-T', family: 'copper', connector: 'rj45', speedMbps: 2500, maxRangeM: 100, cable: 'cat5e', poe: true },
  '5gbase-t': { name: '5GBASE-T', family: 'copper', connector: 'rj45', speedMbps: 5000, maxRangeM: 100, cable: 'cat6', poe: true },
  '10gbase-t': { name: '10GBASE-T', family: 'copper', connector: 'rj45', speedMbps: 10000, maxRangeM: 100, cable: 'cat6a', poe: false },

  // ---- fiber, 1G ----
  '1000base-sx': { name: '1000BASE-SX', family: 'fiber', connector: 'lc', speedMbps: 1000, maxRangeM: 550, fiber: 'mmf', wavelengthNm: 850 },
  '1000base-lx': { name: '1000BASE-LX', family: 'fiber', connector: 'lc', speedMbps: 1000, maxRangeM: 10000, fiber: 'both', wavelengthNm: 1310 },
  '1000base-ex': { name: '1000BASE-EX', family: 'fiber', connector: 'lc', speedMbps: 1000, maxRangeM: 40000, fiber: 'smf', wavelengthNm: 1310 },
  '1000base-zx': { name: '1000BASE-ZX', family: 'fiber', connector: 'lc', speedMbps: 1000, maxRangeM: 80000, fiber: 'smf', wavelengthNm: 1550 },

  // ---- fiber, 10G ----
  '10gbase-sr': { name: '10GBASE-SR', family: 'fiber', connector: 'lc', speedMbps: 10000, maxRangeM: 300, fiber: 'mmf', wavelengthNm: 850 },
  '10gbase-lr': { name: '10GBASE-LR', family: 'fiber', connector: 'lc', speedMbps: 10000, maxRangeM: 10000, fiber: 'smf', wavelengthNm: 1310 },
  '10gbase-er': { name: '10GBASE-ER', family: 'fiber', connector: 'lc', speedMbps: 10000, maxRangeM: 40000, fiber: 'smf', wavelengthNm: 1550 },

  // ---- fiber, 25G ----
  '25gbase-sr': { name: '25GBASE-SR', family: 'fiber', connector: 'lc', speedMbps: 25000, maxRangeM: 100, fiber: 'mmf', wavelengthNm: 850 },
  '25gbase-lr': { name: '25GBASE-LR', family: 'fiber', connector: 'lc', speedMbps: 25000, maxRangeM: 10000, fiber: 'smf', wavelengthNm: 1310 },

  // ---- fiber, 40G ----
  '40gbase-sr4': { name: '40GBASE-SR4', family: 'fiber', connector: 'mpo', speedMbps: 40000, maxRangeM: 150, fiber: 'mmf', wavelengthNm: 850 },
  '40gbase-lr4': { name: '40GBASE-LR4', family: 'fiber', connector: 'lc', speedMbps: 40000, maxRangeM: 10000, fiber: 'smf', wavelengthNm: 1310 },

  // ---- fiber, 100G ----
  '100gbase-sr4': { name: '100GBASE-SR4', family: 'fiber', connector: 'mpo', speedMbps: 100000, maxRangeM: 100, fiber: 'mmf', wavelengthNm: 850 },
  '100gbase-lr4': { name: '100GBASE-LR4', family: 'fiber', connector: 'lc', speedMbps: 100000, maxRangeM: 10000, fiber: 'smf', wavelengthNm: 1310 },

  // ---- DAC / AOC ----
  'dac-1g': { name: '1G DAC (passive)', family: 'dac', connector: 'sfp', speedMbps: 1000, maxRangeM: 3 },
  'dac-10g': { name: '10G DAC (passive)', family: 'dac', connector: 'sfp', speedMbps: 10000, maxRangeM: 7 },
  'dac-10g-active': { name: '10G DAC (active)', family: 'dac', connector: 'sfp', speedMbps: 10000, maxRangeM: 15 },
  'aoc-10g': { name: '10G AOC', family: 'dac', connector: 'sfp', speedMbps: 10000, maxRangeM: 20 },
  'dac-25g': { name: '25G DAC (passive)', family: 'dac', connector: 'sfp', speedMbps: 25000, maxRangeM: 5 },
  'dac-40g': { name: '40G QSFP+ DAC', family: 'dac', connector: 'qsfp', speedMbps: 40000, maxRangeM: 5 },
  'dac-100g': { name: '100G QSFP28 DAC', family: 'dac', connector: 'qsfp', speedMbps: 100000, maxRangeM: 3 },

  // ---- copper SFP (1000BASE-T module) ----
  '1000base-t-sfp': { name: '1000BASE-T SFP', family: 'copper', connector: 'sfp', speedMbps: 1000, maxRangeM: 100, cable: 'cat5e', poe: false },

  // ---- console / serial ----
  'console-rs232': { name: 'Console (RS-232)', family: 'console', connector: 'console', speedMbps: 0.1152, maxRangeM: 15 },
  'usb-console': { name: 'USB Console', family: 'console', connector: 'usb', speedMbps: 12, maxRangeM: 5 },

  // ---- wireless ----
  'wireless-2.4': { name: '2.4 GHz radio', family: 'wireless', connector: 'antenna', speedMbps: 600, maxRangeM: null, band: '2.4' },
  'wireless-5': { name: '5 GHz radio', family: 'wireless', connector: 'antenna', speedMbps: 1000, maxRangeM: null, band: '5' },
  'wireless-60': { name: '60 GHz radio', family: 'wireless', connector: 'antenna', speedMbps: 5000, maxRangeM: null, band: '60' }
};

function mediaById(id) { return MEDIA[id] || null; }

// ---------------------------------------------------------------------------
// cages -- the physical connector/cage fitted to a port
// ---------------------------------------------------------------------------
const CAGES = {
  rj45: { name: 'RJ45', family: 'copper', label: 'RJ45 copper' },
  sfp: { name: 'SFP', family: 'optical', label: 'SFP cage' },
  'sfp+': { name: 'SFP+', family: 'optical', label: 'SFP+ cage (10G)' },
  sfp28: { name: 'SFP28', family: 'optical', label: 'SFP28 cage (25G)' },
  'qsfp+': { name: 'QSFP+', family: 'optical', label: 'QSFP+ cage (40G)' },
  qsfp28: { name: 'QSFP28', family: 'optical', label: 'QSFP28 cage (100G)' },
  console: { name: 'Console', family: 'management', label: 'Console (RS-232)' },
  usb: { name: 'USB', family: 'management', label: 'USB' },
  antenna: { name: 'Antenna', family: 'wireless', label: 'Wireless radio' }
};

// Which cages can physically mate with which.
const CAGE_MATE = {
  rj45: ['rj45'],
  sfp: ['sfp', 'sfp+', 'sfp28'],
  'sfp+': ['sfp', 'sfp+', 'sfp28'],
  sfp28: ['sfp', 'sfp+', 'sfp28'],
  'qsfp+': ['qsfp+', 'qsfp28'],
  qsfp28: ['qsfp+', 'qsfp28'],
  console: ['console'],
  usb: ['usb', 'console'],
  antenna: ['antenna']
};

function cagesMate(a, b) {
  const list = CAGE_MATE[a];
  return !!list && list.indexOf(b) !== -1;
}

// ---------------------------------------------------------------------------
// per-cage media + speed capabilities
// ---------------------------------------------------------------------------
const CAGE_MEDIA = {
  rj45: function (maxMbps) {
    const out = ['10base-t', '100base-tx', '1000base-t'];
    if (maxMbps >= 2500) out.push('2.5gbase-t');
    if (maxMbps >= 5000) out.push('5gbase-t');
    if (maxMbps >= 10000) out.push('10gbase-t');
    return out.filter(function (id) { return MEDIA[id].speedMbps <= maxMbps; });
  },
  sfp: function () {
    // '1000base-t-sfp' is the copper SFP module, which is legitimate in this
    // cage. Bare '1000base-t' is RJ45 copper cabling and must NOT be offered
    // here: it let two fibre cages be joined by a copper run.
    return ['1000base-sx', '1000base-lx', '1000base-ex', '1000base-zx', '1000base-t-sfp', 'dac-1g'];
  },
  'sfp+': function () {
    return ['10gbase-sr', '10gbase-lr', '10gbase-er', '1000base-sx', '1000base-lx',
      '1000base-t-sfp', 'dac-10g', 'dac-10g-active', 'aoc-10g'];
  },
  sfp28: function () {
    return ['25gbase-sr', '25gbase-lr', '10gbase-sr', '10gbase-lr', 'dac-25g', 'dac-10g'];
  },
  'qsfp+': function () { return ['40gbase-sr4', '40gbase-lr4', 'dac-40g']; },
  qsfp28: function () { return ['100gbase-sr4', '100gbase-lr4', 'dac-100g', '40gbase-sr4', '40gbase-lr4']; },
  console: function () { return ['console-rs232']; },
  usb: function () { return ['usb-console']; },
  antenna: function () { return ['wireless-2.4', 'wireless-5', 'wireless-60']; }
};

const CAGE_SPEEDS = {
  rj45: function (maxMbps) {
    const out = [10, 100, 1000];
    if (maxMbps >= 2500) out.push(2500);
    if (maxMbps >= 5000) out.push(5000);
    if (maxMbps >= 10000) out.push(10000);
    return out.filter(function (s) { return s <= maxMbps; });
  },
  sfp: function () { return [1000]; },
  'sfp+': function () { return [1000, 10000]; },
  sfp28: function () { return [10000, 25000]; },
  'qsfp+': function () { return [40000]; },
  qsfp28: function () { return [40000, 100000]; },
  console: function () { return [0.1152]; },
  usb: function () { return [12]; },
  antenna: function (maxMbps) { return [maxMbps]; }
};

// ---------------------------------------------------------------------------
// port hardware derivation
// ---------------------------------------------------------------------------
// Device specs are terse: { name: 'ether1', type: 'ethernet', speed: '1G' }.
// We derive a full hardware description from the name + type + speed, and let
// a spec override any field explicitly with a `hardware` block:
//   { "hardware": { "cage": "sfp+", "poeOut": 30 } }
// or per-field: { "connector": "sfp+", "poeOut": 30 }

function inferCage(ifaceSpec, maxMbps) {
  const name = String(ifaceSpec.name || '').toLowerCase();
  const type = String(ifaceSpec.type || 'ethernet').toLowerCase();

  if (type === 'wireless' || type === 'radio') return 'antenna';
  if (type === 'console') return 'console';
  if (type === 'usb') return 'usb';
  if (/console|con\d|tty|aux/.test(name)) return 'console';
  if (/usb/.test(name)) return 'usb';

  const optical = /sfp|qsfp|xfp|cfp|xe-|et-|fc\d/.test(name) ||
    /(^|[^0-9])(25|40|100)\s*g/i.test(String(ifaceSpec.speed || ''));

  if (!optical) return 'rj45';

  if (maxMbps >= 100000) return 'qsfp28';
  if (maxMbps >= 40000) return 'qsfp+';
  if (maxMbps >= 25000) return 'sfp28';
  if (maxMbps >= 10000) return 'sfp+';
  return 'sfp';
}

// Derive a complete port-hardware descriptor from a terse interface spec.
function derivePortHardware(ifaceSpec, deviceSpec) {
  const spec = ifaceSpec || {};
  const dev = deviceSpec || {};
  const maxMbps = parseSpeedMbps(spec.speed) || 1000;
  const cage = spec.cage || spec.connector || inferCage(spec, maxMbps);

  const cageDef = CAGES[cage] || CAGES.rj45;
  let media = (CAGE_MEDIA[cage] || CAGE_MEDIA.rj45)(maxMbps);
  let speeds = (CAGE_SPEEDS[cage] || CAGE_SPEEDS.rj45)(maxMbps);

  // A wireless radio only carries its own band.
  if (cage === 'antenna') {
    const band = maxMbps >= 5000 ? 'wireless-60' : (maxMbps >= 1000 ? 'wireless-5' : 'wireless-2.4');
    media = [band];
  }

  // Explicit overrides.
  if (Array.isArray(spec.media)) media = spec.media.slice();
  if (Array.isArray(spec.supportedMedia)) media = spec.supportedMedia.slice();

  const hw = spec.hardware || {};

  const port = {
    name: spec.name,
    type: spec.type || 'ethernet',
    cage: cage,
    cageName: cageDef.name,
    family: cageDef.family,
    media: media,
    speedCaps: (hw.speedCaps || spec.speedCaps || speeds).slice(),
    maxSpeedMbps: maxMbps,
    // PoE
    poeOut: hw.poeOut !== undefined ? hw.poeOut : (spec.poeOut !== undefined ? spec.poeOut : null),
    poeIn: hw.poeIn !== undefined ? hw.poeIn : (spec.poeIn !== undefined ? spec.poeIn : null),
    // distance / cabling hints
    maxRangeM: hw.maxRangeM !== undefined ? hw.maxRangeM : null
  };

  // Best-effort PoE inference for common device classes when the spec is silent.
  if (port.poeOut === null && port.poeIn === null) {
    if (isPoePse(spec, dev)) port.poeOut = 15.4;     // 802.3af default
    else if (isPoePd(dev)) port.poeIn = 12.95;
  }

  return port;
}

function isPoePse(ifaceSpec, dev) {
  const model = String(dev.model || '') + ' ' + String(dev.label || '');
  if (/poe/i.test(model)) return true;
  const caps = dev.capabilities || [];
  if (caps.indexOf('poe-pse') !== -1) return true;
  return false;
}

function isPoePd(dev) {
  const model = String(dev.model || '') + ' ' + String(dev.label || '');
  const caps = dev.capabilities || [];
  if (caps.indexOf('poe-pd') !== -1) return true;
  // APs and PTP radios are typically PoE-powered.
  const cat = String(dev.category || '');
  if (cat === 'wireless' || cat === 'ptp') return true;
  if (/litebeam|nanobeam|powerbeam|unifi|u6|u7|eap|wap|cube|lhg|sxt|mantbox/i.test(model)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// compatibility / negotiation
// ---------------------------------------------------------------------------

// Media ids that BOTH ports can carry, given their cages.
function commonMedia(pa, pb) {
  if (!cagesMate(pa.cage, pb.cage)) return [];
  const setB = {};
  for (const m of pb.media) setB[m] = true;
  return pa.media.filter(function (m) { return setB[m]; });
}

// Highest speed both ports support (ethernet auto-negotiation), or null.
function negotiateSpeed(pa, pb) {
  const setB = {};
  for (const s of pb.speedCaps) setB[s] = true;
  const shared = pa.speedCaps.filter(function (s) { return setB[s]; });
  if (!shared.length) return null;
  return Math.max.apply(null, shared);
}

// Can these two ports be cabled at all? Returns a structured verdict.
function canMate(pa, pb) {
  if (!pa || !pb) {
    return { ok: false, code: 'E_NO_PORT', message: 'Port does not exist.' };
  }
  if (pa.cage === 'antenna' || pb.cage === 'antenna') {
    if (pa.cage !== pb.cage) {
      return { ok: false, code: 'E_WIRELESS_TO_WIRED', message: 'A wireless radio cannot be cabled to a wired port.' };
    }
  }
  if (!cagesMate(pa.cage, pb.cage)) {
    return {
      ok: false, code: 'E_CONNECTOR_MISMATCH',
      message: 'Cannot mate ' + pa.cageName + ' to ' + pb.cageName + ' (incompatible connectors).'
    };
  }
  const media = commonMedia(pa, pb);
  if (!media.length) {
    return {
      ok: false, code: 'E_NO_COMMON_MEDIA',
      message: 'No shared medium between ' + pa.cageName + ' and ' + pb.cageName + '.'
    };
  }
  const speed = negotiateSpeed(pa, pb);
  if (speed === null) {
    return {
      ok: false, code: 'E_NO_COMMON_SPEED',
      message: 'No common speed between ' + pa.cageName + ' and ' + pb.cageName +
        ' (A: ' + pa.speedCaps.join('/') + ', B: ' + pb.speedCaps.join('/') + ').'
    };
  }
  return { ok: true, code: 'OK', media: media, speedMbps: speed };
}

// Preferred medium when several are possible (prefer fiber/DAC over copper SFP,
// prefer the highest speed).
function preferredMedia(mediaIds) {
  if (!mediaIds || !mediaIds.length) return null;
  const rank = { fiber: 3, dac: 2, copper: 1, console: 1, wireless: 1 };
  let best = mediaIds[0];
  for (const id of mediaIds) {
    const a = MEDIA[best]; const b = MEDIA[id];
    if (!b) continue;
    if (!a) { best = id; continue; }
    if ((rank[b.family] || 0) > (rank[a.family] || 0)) best = id;
    else if ((rank[b.family] || 0) === (rank[a.family] || 0) && b.speedMbps > a.speedMbps) best = id;
  }
  return best;
}

// Budget encoded in a model name ("... PoE+ 370W", "740W") is the only source
// most datasheets give us in the model string itself.
function parsePoeBudget(model) {
  if (!model) return 0;
  const m = String(model).match(/(\d{2,4})\s*W\b/i);
  if (!m) return 0;
  const w = parseInt(m[1], 10);
  return (w >= 30 && w <= 2000) ? w : 0;
}

module.exports = {
  MEDIA, CAGES, CAGE_MATE, CAGE_MEDIA, CAGE_SPEEDS,
  parseSpeedMbps, formatSpeedMbps, parsePoeBudget, mediaById,
  cagesMate, derivePortHardware, commonMedia, negotiateSpeed, canMate, preferredMedia,
  inferCage, isPoePse, isPoePd
};
