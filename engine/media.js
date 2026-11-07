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
  // 200G/400G ride in QSFP-DD cages. DR4/FR4 are the short and metro reaches;
  // an 800G class exists but no hardware in this catalogue uses it yet.
  '200gbase-dr4': { name: '200GBASE-DR4', family: 'fiber', connector: 'mpo', speedMbps: 200000, maxRangeM: 500, fiber: 'smf', wavelengthNm: 1311 },
  '200gbase-fr4': { name: '200GBASE-FR4', family: 'fiber', connector: 'lc', speedMbps: 200000, maxRangeM: 2000, fiber: 'smf', wavelengthNm: 1311 },
  '400gbase-dr4': { name: '400GBASE-DR4', family: 'fiber', connector: 'mpo', speedMbps: 400000, maxRangeM: 500, fiber: 'smf', wavelengthNm: 1311 },
  '400gbase-fr4': { name: '400GBASE-FR4', family: 'fiber', connector: 'lc', speedMbps: 400000, maxRangeM: 2000, fiber: 'smf', wavelengthNm: 1311 },

  // ---- subscriber access: coax, twisted pair, mains ----
  // These are SHARED mediums in reality: an HFC segment, a binder group, a ring
  // main. Modelling them as a point-to-point run is a simplification, but the
  // part that matters for a lab is honest: the class rate, the asymmetry, and the
  // fact that reach falls off with distance far sooner than fibre does.
  'docsis-31': { name: 'DOCSIS 3.1 (coax)', family: 'coax', connector: 'f', speedMbps: 10000, upstreamMbps: 1000, maxRangeM: 300, shared: true },
  'docsis-30': { name: 'DOCSIS 3.0 (coax)', family: 'coax', connector: 'f', speedMbps: 1000, upstreamMbps: 200, maxRangeM: 300, shared: true },
  'moca-25': { name: 'MoCA 2.5 (coax)', family: 'coax', connector: 'f', speedMbps: 2500, maxRangeM: 100, shared: true },
  'moca-11': { name: 'MoCA 1.1 (coax)', family: 'coax', connector: 'f', speedMbps: 175, maxRangeM: 100, shared: true },
  'vdsl2-35b': { name: 'VDSL2 35b (twisted pair)', family: 'dsl', connector: 'rj11', speedMbps: 300, maxRangeM: 400 },
  'vdsl2-17a': { name: 'VDSL2 17a (twisted pair)', family: 'dsl', connector: 'rj11', speedMbps: 100, maxRangeM: 900 },
  'adsl2plus': { name: 'ADSL2+ (twisted pair)', family: 'dsl', connector: 'rj11', speedMbps: 24, maxRangeM: 3000 },
  'homeplug-av2': { name: 'HomePlug AV2 (mains)', family: 'powerline', connector: 'mains', speedMbps: 1000, maxRangeM: 300, shared: true },
  'ghn': { name: 'G.hn (mains)', family: 'powerline', connector: 'mains', speedMbps: 1700, maxRangeM: 300, shared: true },
  'homeplug-av': { name: 'HomePlug AV (mains)', family: 'powerline', connector: 'mains', speedMbps: 200, maxRangeM: 300, shared: true },
  'ghn-25': { name: 'G.hn 2.5G (mains)', family: 'powerline', connector: 'mains', speedMbps: 2500, maxRangeM: 300, shared: true },

  // ---- fiber, PON (single-mode, outside plant) ----
  // A PON is the one place where the connector belongs to the medium rather than
  // the cage: the same OLT port takes an SC/APC or an SC/UPC module, and the two
  // will not mate. GPON is 2.488 Gbit/s down over 1.244 up; XGS-PON is symmetric
  // 9.953. Reach is the class budget: 20 km at a 1:32 split.
  'gpon-sc-apc': { name: 'GPON (SC/APC)', family: 'fiber', connector: 'sc-apc', speedMbps: 2488, maxRangeM: 20000, fiber: 'smf', wavelengthNm: 1490, upstreamMbps: 1244 },
  'gpon-sc-upc': { name: 'GPON (SC/UPC)', family: 'fiber', connector: 'sc-upc', speedMbps: 2488, maxRangeM: 20000, fiber: 'smf', wavelengthNm: 1490, upstreamMbps: 1244 },
  'xgspon-sc-apc': { name: 'XGS-PON (SC/APC)', family: 'fiber', connector: 'sc-apc', speedMbps: 9953, maxRangeM: 20000, fiber: 'smf', wavelengthNm: 1577, upstreamMbps: 9953 },
  'xgspon-sc-upc': { name: 'XGS-PON (SC/UPC)', family: 'fiber', connector: 'sc-upc', speedMbps: 9953, maxRangeM: 20000, fiber: 'smf', wavelengthNm: 1577, upstreamMbps: 9953 },

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
  // A combo port is one physical cage position that takes EITHER an RJ45
  // copper port or an SFP module - never both at once. Real switches present
  // it as two logical interfaces that are mutually exclusive.
  combo: { name: 'Combo', family: 'combo', label: 'Combo RJ45 / SFP' },
  'qsfp+': { name: 'QSFP+', family: 'optical', label: 'QSFP+ cage (40G)' },
  qsfpdd: { name: 'QSFP-DD', family: 'optical', label: 'QSFP-DD cage (200/400G)' },
  qsfp28: { name: 'QSFP28', family: 'optical', label: 'QSFP28 cage (100G)' },
  // SC is the PON connector. APC and UPC are separate cages deliberately: an
  // 8-degree angled ferrule and a flat one cannot mate, and forcing them costs
  // about 3 dB of loss and can chip the endface.
  'sc-apc': { name: 'SC/APC', family: 'optical', label: 'SC/APC (green, angled 8 deg)' },
  'sc-upc': { name: 'SC/UPC', family: 'optical', label: 'SC/UPC (blue, flat)' },
  // Subscriber-access connectors. An F-connector is not an RJ45 and a mains plug
  // never meets one, so each gets its own cage rather than being flattened into
  // copper ethernet.
  coax: { name: 'F-connector', family: 'coax', label: 'F-connector (coax)' },
  dsl: { name: 'RJ11', family: 'dsl', label: 'RJ11 (twisted pair)' },
  powerline: { name: 'Mains', family: 'powerline', label: 'Mains plug' },
  console: { name: 'Console', family: 'management', label: 'Console (RS-232)' },
  usb: { name: 'USB', family: 'management', label: 'USB' },
  antenna: { name: 'Antenna', family: 'wireless', label: 'Wireless radio' }
};

// Which cages can physically mate with which.
const CAGE_MATE = {
  rj45: ['rj45', 'combo'],
  combo: ['combo', 'rj45', 'sfp', 'sfp+', 'sfp28'],
  sfp: ['sfp', 'sfp+', 'sfp28', 'combo'],
  'sfp+': ['sfp', 'sfp+', 'sfp28', 'combo'],
  sfp28: ['sfp', 'sfp+', 'sfp28', 'combo'],
  'qsfp+': ['qsfp+', 'qsfp28', 'qsfpdd'],
  qsfp28: ['qsfp+', 'qsfp28', 'qsfpdd'],
  // A QSFP-DD cage takes a QSFP28 or QSFP+ module and negotiates down to that
  // module's rate. Refusing the pair would make a 400G port unable to accept the
  // 100G optic most labs actually have.
  qsfpdd: ['qsfpdd', 'qsfp28', 'qsfp+'],
  // SC never mates across polish: APC to APC, UPC to UPC, nothing else.
  'sc-apc': ['sc-apc'],
  'sc-upc': ['sc-upc'],
  coax: ['coax'],
  dsl: ['dsl'],
  powerline: ['powerline'],
  console: ['console'],
  usb: ['usb', 'console'],
  antenna: ['antenna']
};

function cagesMate(a, b) {
  const list = CAGE_MATE[a];
  return !!list && list.indexOf(b) !== -1;
}

// Ferrule geometry. Two connectors with the same shape but a different polish are
// the classic field mistake: an SC/APC (8 degree angled, green) ferrule pushed
// into an SC/UPC (flat, blue) socket does not seat, loses about 3 dB, and can
// chip the endface. That is not a "wrong cable, try another" error - it is a
// physically impossible link, so it gets its own verdict instead of hiding
// behind a generic connector mismatch.
const FERRULE = {
  'sc-apc': { shape: 'sc', polish: 'apc', colour: 'green', angleDeg: 8 },
  'sc-upc': { shape: 'sc', polish: 'upc', colour: 'blue', angleDeg: 0 },
  lc: { shape: 'lc', polish: 'upc', colour: 'blue', angleDeg: 0 },
  mpo: { shape: 'mpo', polish: 'upc', colour: 'aqua', angleDeg: 0 }
};

function ferrule(cage) { return FERRULE[cage] || null; }

// Same shape, different polish: physically incompatible.
function polishMismatch(a, b) {
  const fa = ferrule(a), fb = ferrule(b);
  return !!(fa && fb && fa.shape === fb.shape && fa.polish !== fb.polish);
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
  // A combo port accepts either the copper side or the optical side, so its
  // media set is the union of both. Whether the RJ45 or the SFP half is in use
  // is decided by the cable plugged in, not by the cage.
  combo: function (maxMbps) {
    const copper = CAGE_MEDIA.rj45(maxMbps);
    const optical = CAGE_MEDIA.sfp();
    return copper.concat(optical.filter(function (id) { return copper.indexOf(id) === -1; }));
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
  qsfpdd: function () {
    return ['200gbase-dr4', '200gbase-fr4', '400gbase-dr4', '400gbase-fr4',
            // backward-compatible modules, which run at their own rate
            '100gbase-sr4', '100gbase-lr4', '40gbase-sr4', '40gbase-lr4', 'dac-100g'];
  },
  'sc-apc': function (maxMbps) {
    const out = ['gpon-sc-apc'];
    if (maxMbps >= 9000) out.push('xgspon-sc-apc');
    return out;
  },
  'sc-upc': function (maxMbps) {
    const out = ['gpon-sc-upc'];
    if (maxMbps >= 9000) out.push('xgspon-sc-upc');
    return out;
  },
  coax: function (maxMbps) {
    const out = ['moca-11', 'moca-25', 'docsis-30'];
    if (maxMbps >= 1000) out.push('docsis-31');
    return out;
  },
  dsl: function (maxMbps) {
    const out = ['adsl2plus', 'vdsl2-17a'];
    if (maxMbps >= 300) out.push('vdsl2-35b');
    return out;
  },
  powerline: function () { return ['homeplug-av', 'homeplug-av2', 'ghn', 'ghn-25']; },
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
  // A combo port runs either at copper rates or at the optical module's rate.
  combo: function (maxMbps) {
    const out = [10, 100, 1000];
    if (maxMbps >= 10000) out.push(10000);
    return out.filter(function (v) { return v <= maxMbps; });
  },
  sfp: function () { return [1000]; },
  'sfp+': function () { return [1000, 10000]; },
  sfp28: function () { return [10000, 25000]; },
  'qsfp+': function () { return [40000]; },
  qsfp28: function () { return [40000, 100000]; },
  qsfpdd: function (maxMbps) {
    const out = [40000, 100000, 200000, 400000];
    return out.filter(function (v) { return v <= maxMbps; });
  },
  'sc-apc': function (maxMbps) {
    const out = [1244, 2488];
    if (maxMbps >= 9000) out.push(9953);
    return out;
  },
  'sc-upc': function (maxMbps) {
    const out = [1244, 2488];
    if (maxMbps >= 9000) out.push(9953);
    return out;
  },
  coax: function (maxMbps) {
    const out = [175, 1000];
    if (maxMbps >= 2500) out.push(2500);
    if (maxMbps >= 5000) out.push(5000);
    if (maxMbps >= 10000) out.push(10000);
    return out.filter(function (v) { return v <= maxMbps; }).concat([Math.min(1000, maxMbps)]).filter(function (v, i, a) { return a.indexOf(v) === i; }).sort(function (a, b) { return a - b; });
  },
  dsl: function (maxMbps) {
    const out = [24, 100];
    if (maxMbps >= 300) out.push(300);
    return out.filter(function (v) { return v <= maxMbps; });
  },
  powerline: function () { return [200, 1000, 1700, 2500]; },
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
  // Subscriber-access line types are their own connector families.
  if (type === 'coax') return 'coax';
  if (type === 'dsl' || type === 'adsl' || type === 'vdsl') return 'dsl';
  if (type === 'powerline' || type === 'plc' || type === 'mains') return 'powerline';
  if (/console|con\d|tty|aux/.test(name)) return 'console';
  if (/usb/.test(name)) return 'usb';

  // A PON port is an SC connector on the outside plant, not RJ45 copper. APC
  // (green, angled 8 degrees) is the norm on OLT and ONT PON ports; a spec that
  // knows better can say connector: "sc-upc".
  if (/sc\/?apc|scapc/.test(name)) return 'sc-apc';
  if (/sc\/?upc|scupc/.test(name)) return 'sc-upc';
  if (/gpon|xgs-?pon|xg-?s-?pon|(^|[-_ /])pon(\d|$)|^pon/.test(name)) return 'sc-apc';

  const optical = /sfp|qsfp|xfp|cfp|xe-|et-|fc\d/.test(name) ||
    /(^|[^0-9])(25|40|100)\s*g/i.test(String(ifaceSpec.speed || ''));

  if (!optical) return 'rj45';

  // A port named for its cage wins over its rate: qsfpdd1/1 carrying 200G is a
  // QSFP-DD cage, not a QSFP28 that happens to be fast.
  if (/qsfp-?dd|qsfpdd/.test(name)) return 'qsfpdd';

  if (maxMbps >= 200000) return 'qsfpdd';
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
    if (polishMismatch(pa.cage, pb.cage)) {
      const fa = ferrule(pa.cage), fb = ferrule(pb.cage);
      return {
        ok: false, code: 'E_POLISH_MISMATCH',
        message: pa.cageName + ' and ' + pb.cageName + ' take the same ' +
          fa.shape.toUpperCase() + ' ferrule but not the same polish (' +
          fa.polish.toUpperCase() + (fa.angleDeg ? ' angled ' + fa.angleDeg + ' deg' : ' flat') +
          ' vs ' + fb.polish.toUpperCase() + (fb.angleDeg ? ' angled ' + fb.angleDeg + ' deg' : ' flat') +
          '). They are not intermateable - forcing it costs about 3 dB and can chip the endface.'
      };
    }
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
  FERRULE, ferrule, polishMismatch,
  inferCage, isPoePse, isPoePd
};
