'use strict';
// Optical distribution network: passive splitters and the PON loss budget.
//
// A PON is not a point-to-point link. One OLT port drives a passive splitter, and
// every ONT on that branch sees the downstream as a broadcast while sharing the
// upstream in time slots. The splitter has no MAC table and no power - it is a
// coupler - so it forwards everything both ways, and the price is insertion loss.
//
// That loss is what makes a PON branch possible or impossible in the field: a
// 1:64 split at 20 km does not fit inside a class B+ budget, and no amount of
// configuration will make it work. Modelling it means the simulator can say why.

const mediaModel = require('./media');

// ---------------------------------------------------------------------------
// Splitters
// ---------------------------------------------------------------------------
// These are the WORST CASE across the parts in catalogue/optics/odn.json, not the
// best: a design tool must plan against the part that loses the most. The 1:2
// figure was raised from 3.8 to 4.1 after the catalogue turned up a real Gigalight
// part at 4.1 dB - every other ratio in this table is more pessimistic than the
// catalogue, so only that one was optimistic.
//
// Real PLC insertion loss is worse than the ideal split ratio (10*log10(n)): a
// 1:2 ideal is 3.01 dB but a real part is about 3.6, and the penalty grows with
// the ratio. These are conservative catalogue figures; a specific vendor part can
// override them.
const SPLITTERS = {
  '1:2': { ratio: 2, minDb: 3.4, maxDb: 4.1 },
  '1:4': { ratio: 4, minDb: 7.0, maxDb: 7.6 },
  '1:8': { ratio: 8, minDb: 10.0, maxDb: 10.8 },
  '1:16': { ratio: 16, minDb: 13.4, maxDb: 14.2 },
  '1:32': { ratio: 32, minDb: 16.5, maxDb: 17.5 },
  '1:64': { ratio: 64, minDb: 19.8, maxDb: 21.0 }
};

function splitterById(ratio) { return SPLITTERS[String(ratio)] || null; }

// Worst-case insertion loss, which is what a design must be built against.
function splitterLossDb(ratio) {
  const s = splitterById(ratio);
  if (!s) return null;
  return s.maxDb;
}

// ---------------------------------------------------------------------------
// Fibre attenuation
// ---------------------------------------------------------------------------
// Single-mode attenuation is wavelength dependent: 1310 nm sits near the
// Rayleigh limit and is noticeably lossier than 1490/1550. A GPON downstream runs
// at 1490 and its upstream at 1310, so the two directions do not have the same
// budget - the upstream is the weaker one and is usually what limits reach.
const FIBRE_DB_PER_KM = {
  1270: 0.35,
  1310: 0.35,
  1490: 0.22,
  1550: 0.20,
  1577: 0.20
};

function fibreLossDbPerKm(wavelengthNm) {
  const w = Number(wavelengthNm);
  if (FIBRE_DB_PER_KM[w] !== undefined) return FIBRE_DB_PER_KM[w];
  // Nearest known wavelength, so an unlisted CWDM channel still gets a sane number.
  const known = Object.keys(FIBRE_DB_PER_KM).map(Number);
  let best = known[0];
  for (const k of known) if (Math.abs(k - w) < Math.abs(best - w)) best = k;
  return FIBRE_DB_PER_KM[best];
}

// ---------------------------------------------------------------------------
// PON power budgets
// ---------------------------------------------------------------------------
// ITU-T G.984 (GPON) and G.9807 (XGS-PON) classes. The number is the maximum
// allowed loss between OLT and ONT, so a design must land at or under it.
const PON_CLASSES = {
  'B+': { budgetDb: 28, minDb: 13, standard: 'G.984.2' },
  'C+': { budgetDb: 32, minDb: 17, standard: 'G.984.2' },
  'C++': { budgetDb: 35, minDb: 20, standard: 'G.984.2 Amd' },
  'N1': { budgetDb: 29, minDb: 14, standard: 'G.9807.1 (XGS-PON)' },
  'N2': { budgetDb: 31, minDb: 16, standard: 'G.9807.1 (XGS-PON)' }
};

const CONNECTOR_LOSS_DB = 0.3;   // one mated pair
const SPLICE_LOSS_DB = 0.1;

// Work out whether an OLT-to-ONT path fits its optical budget.
//
//   lengthM          fibre run in metres (one way)
//   wavelengthNm     the direction being checked - 1490 downstream, 1310 upstream
//   splitters        array of ratios, e.g. ['1:8'] or ['1:4','1:8'] for cascaded
//   splices          number of fusion splices in the path
//   connectorPairs   number of mated connector pairs (default 2: OLT and ONT)
//   patchCordLossDb  insertion loss of a declared patch cord part (default 0)
//   ponClass         'B+', 'C+', 'N1', 'N2' ...
//
// Returns a structured verdict with the breakdown, so a failure can say which
// element ate the budget rather than just "too long".
function ponBudget(opts) {
  const o = opts || {};
  const lengthM = Number(o.lengthM) || 0;
  const wavelengthNm = Number(o.wavelengthNm) || 1490;
  const ratios = Array.isArray(o.splitters) ? o.splitters : (o.splitters ? [o.splitters] : []);
  const splices = Number(o.splices) || 0;
  const connectorPairs = o.connectorPairs === undefined ? 2 : Number(o.connectorPairs);
  const className = String(o.ponClass || 'B+');
  const cls = PON_CLASSES[className];

  if (!cls) {
    return { ok: false, code: 'E_UNKNOWN_PON_CLASS', message: 'Unknown PON class ' + className +
      '. Known: ' + Object.keys(PON_CLASSES).join(', ') };
  }

  const perKm = fibreLossDbPerKm(wavelengthNm);
  const fibreDb = (lengthM / 1000) * perKm;
  let splitterDb = 0;
  const splitterBreakdown = [];
  for (const r of ratios) {
    const loss = splitterLossDb(r);
    if (loss === null) {
      return { ok: false, code: 'E_UNKNOWN_SPLITTER', message: 'Unknown splitter ratio ' + r +
        '. Known: ' + Object.keys(SPLITTERS).join(', ') };
    }
    splitterDb += loss;
    splitterBreakdown.push({ ratio: String(r), lossDb: loss });
  }
  const spliceDb = splices * SPLICE_LOSS_DB;
  const connectorDb = connectorPairs * CONNECTOR_LOSS_DB;
  // A declared patch cord is a real part with a real insertion loss. Absent (the
  // normal case) it is zero, so a link that declares no cord budgets exactly as
  // it did before; declaring one charges what the vendor specifies.
  const patchCordDb = Number(o.patchCordLossDb) || 0;

  const lossDb = fibreDb + splitterDb + spliceDb + connectorDb + patchCordDb;
  const headroomDb = cls.budgetDb - lossDb;
  const ok = lossDb <= cls.budgetDb;

  return {
    ok: ok,
    code: ok ? null : 'E_OPTICAL_BUDGET',
    className: className,
    budgetDb: cls.budgetDb,
    standard: cls.standard,
    lossDb: Math.round(lossDb * 100) / 100,
    headroomDb: Math.round(headroomDb * 100) / 100,
    breakdown: {
      fibre: { lengthM: lengthM, dbPerKm: perKm, lossDb: Math.round(fibreDb * 100) / 100 },
      splitters: splitterBreakdown,
      splitterTotalDb: Math.round(splitterDb * 100) / 100,
      splices: { count: splices, lossDb: Math.round(spliceDb * 100) / 100 },
      connectors: { pairs: connectorPairs, lossDb: Math.round(connectorDb * 100) / 100 },
      patchCord: { lossDb: Math.round(patchCordDb * 100) / 100 }
    },
    message: ok
      ? 'Path loss ' + (Math.round(lossDb * 100) / 100) + ' dB fits the ' + className +
        ' budget of ' + cls.budgetDb + ' dB with ' + (Math.round(headroomDb * 100) / 100) + ' dB spare.'
      : 'Path loss ' + (Math.round(lossDb * 100) / 100) + ' dB exceeds the ' + className +
        ' budget of ' + cls.budgetDb + ' dB by ' + (Math.round(-headroomDb * 100) / 100) +
        ' dB. ' + describeOverrun(fibreDb, splitterDb, connectorDb + spliceDb)
  };
}

// Name the element that consumed the budget, so the refusal is actionable.
function describeOverrun(fibreDb, splitterDb, passiveDb) {
  const parts = [];
  if (splitterDb > 0) parts.push('splitting costs ' + (Math.round(splitterDb * 10) / 10) + ' dB');
  if (fibreDb > 0) parts.push('fibre costs ' + (Math.round(fibreDb * 10) / 10) + ' dB');
  if (passiveDb > 0) parts.push('connectors and splices cost ' + (Math.round(passiveDb * 10) / 10) + ' dB');
  return parts.join(', ') + '. Reduce the split ratio, shorten the run, or move to a higher class.';
}


// ---------------------------------------------------------------------------
// The parts catalogue
// ---------------------------------------------------------------------------
// Real part numbers beat generic assumptions: "10GBASE-LR" is a standard, but a
// GLC-SX-MMD has a specific reach and a specific ferrule, and a 1x2 PLC splitter
// from a given vendor loses more than the ideal 3.01 dB. These live in
// catalogue/optics/ rather than in code so a contributor can add a part without
// touching the engine.
let _transceivers = null;
let _odn = null;

function _load(file) {
  const fs = require('fs');
  const path = require('path');
  try {
    const p = path.join(__dirname, '..', 'catalogue', 'optics', file);
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return null;
  }
}

function transceivers() {
  if (_transceivers === null) {
    const raw = _load('transceivers.json');
    _transceivers = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.transceivers) ? raw.transceivers : []);
  }
  return _transceivers;
}

function transceiverByPart(partNumber) {
  const want = String(partNumber || '').toLowerCase().trim();
  return transceivers().filter(function (t) {
    return String(t.partNumber || '').toLowerCase() === want;
  })[0] || null;
}

// Which real modules a cage can take, e.g. everything that fits an SFP+ slot.
function transceiversForCage(cage) {
  return transceivers().filter(function (t) { return t.formFactor === cage; });
}

// Single-strand bidirectional optics only work as a PAIR with crossed
// wavelengths: a 1270/1330 module must meet a 1330/1270 module. Mating two
// identical BiDi parts leaves both ends transmitting on the same wavelength and
// both receivers deaf - a real and very common mistake.
function biDiPairsWith(a, b) {
  const ta = typeof a === 'string' ? transceiverByPart(a) : a;
  const tb = typeof b === 'string' ? transceiverByPart(b) : b;
  if (!ta || !tb) return { ok: false, code: 'E_UNKNOWN_PART', message: 'Unknown transceiver part.' };
  if (!ta.biDi && !tb.biDi) return { ok: true, code: null, message: 'Not BiDi; both directions use their own strand.' };
  if (!ta.biDi || !tb.biDi) {
    return { ok: false, code: 'E_BIDI_MISMATCH',
      message: (ta.partNumber) + ' and ' + (tb.partNumber) + ' cannot be paired: one is single-strand ' +
        'BiDi and the other needs two strands.' };
  }
  const aTx = Number(ta.wavelengthNm), bTx = Number(tb.wavelengthNm);
  const aRx = Number(ta.pairWavelengthNm), bRx = Number(tb.pairWavelengthNm);
  if (aTx === bTx) {
    return { ok: false, code: 'E_BIDI_SAME_WAVELENGTH',
      message: ta.partNumber + ' and ' + tb.partNumber + ' both transmit at ' + aTx +
        ' nm. A BiDi pair must be crossed (1270/1330 with 1330/1270), or both receivers ' +
        'stay deaf.' };
  }
  if (aRx && bRx && (aTx !== bRx || bTx !== aRx)) {
    return { ok: false, code: 'E_BIDI_MISMATCH',
      message: ta.partNumber + ' transmits ' + aTx + ' nm and listens on ' + aRx +
        ' nm, which does not cross with ' + tb.partNumber + ' (' + bTx + '/' + bRx + ' nm).' };
  }
  return { ok: true, code: null, message: 'Crossed BiDi pair: ' + aTx + '/' + aRx + ' nm against ' + bTx + '/' + bRx + ' nm.' };
}

// The ODN catalogue is two files, in this order:
//
//   odn.json                 splitters and the two hybrid leads that predate the
//                            dedicated catalogue
//   hybrid-patch-cords.json  the factory UPC/APC assemblies from issue #18
//
// odn.json is read first on purpose. A part number that appears in both belongs
// to the older file, and hybridCord() returns the first match, so the default
// answer for SC/UPC -> SC/APC stays SMSCSX - the part the docs, the tests and
// the issue all name.
//
// The two files overlap on SMSCSX and SMLCSX, and they do not say the same
// things: the older entries predate `polishBridge`, `insertionLossBasis` and
// the vendor field. So a duplicate is merged rather than dropped - the first
// record keeps its position and identity, the later one fills in whatever it
// knows that the first does not, and its catalogue id is kept as an alias so
// either id finds the part. Dropping the later record outright would make
// `patchCord('patch-cord-hybrid-sc-upc-apc-fs-smscsx')` fail, which is the kind
// of papercut that makes a catalogue look empty.
//
// A missing or malformed file is skipped rather than fatal (see _load), so a
// checkout without the hybrid catalogue still runs the rest of the engine.
const ODN_FILES = ['odn.json', 'hybrid-patch-cords.json'];

function odmMerge(into, from) {
  // Fill gaps only: what the first record says about the part is what the rest
  // of the engine was written against, and reordering keys here would change
  // nothing except the diff.
  for (const key of Object.keys(from)) {
    if (into[key] === undefined || into[key] === null) into[key] = from[key];
  }
  const alias = String(from.id || '').trim();
  if (alias && alias !== into.id) {
    into.aliasIds = (into.aliasIds || []).concat([alias]);
  }
  return into;
}

function odnParts() {
  if (_odn === null) {
    const parts = [];
    const byKey = new Map();
    for (const file of ODN_FILES) {
      const raw = _load(file);
      const list = Array.isArray(raw) ? raw : [];
      for (const part of list) {
        if (!part || typeof part !== 'object') continue;
        // One part per part number: it is what a technician orders against. A
        // splitter entry has no orderable number (only a model and a ratio), so
        // it is simply appended - there is nothing to collide with.
        const key = String(part.partNumber || part.id || '').trim().toLowerCase();
        if (!key) { parts.push(part); continue; }
        const seen = byKey.get(key);
        if (seen) { odmMerge(seen, part); continue; }
        byKey.set(key, part);
        parts.push(part);
      }
    }
    _odn = parts;
  }
  return _odn;
}

// Real measured insertion loss for a ratio, if the catalogue has one. Falls back
// to the built-in conservative table.
function catalogueSplitterLossDb(ratio) {
  const want = String(ratio);
  const hit = odnParts().filter(function (p) {
    return String(p.kind || '') === 'splitter' && String(p.ratio || '') === want;
  })[0];
  if (!hit || !hit.insertionLossDb) return null;
  const loss = hit.insertionLossDb;
  return (typeof loss === 'number') ? loss : (Number(loss.max) || null);
}

// ---------------------------------------------------------------------------
// Patch cords: the hybrid UPC/APC escape hatch
// ---------------------------------------------------------------------------
// A single cable with an SC/APC ferrule on one end and an SC/UPC ferrule on the
// other is still not a thing - the flat endface and the 8-degree one do not seat
// against each other. What exists, and what every OLT-to-ODN run actually uses, is
// a *hybrid patch cord*: a factory-terminated assembly with one polish on each
// end, so the transition happens inside the lead rather than at a mated pair.
//
// That is why this is a part lookup and not a loosened rule. Ordinary fibre still
// has one polish and still fails against the other; only a catalogue part that
// declares both ends can bridge them.

function patchCords() {
  return odnParts().filter(function (p) { return String(p.kind || '') === 'patch-cord'; });
}

function patchCord(partNumber) {
  const want = String(partNumber || '').trim().toLowerCase();
  if (!want) return null;
  // Either the vendor part number a technician orders (SMSCSX) or a catalogue's
  // stable id (patch-cord-hybrid-sc-upc-apc) identifies the part. A part that
  // appears in both catalogue files answers to both ids - see odmMerge().
  return patchCords().filter(function (p) {
    if (String(p.partNumber || '').toLowerCase() === want) return true;
    if (String(p.id || '').toLowerCase() === want) return true;
    const aliases = Array.isArray(p.aliasIds) ? p.aliasIds : [];
    return aliases.some(function (a) { return String(a).toLowerCase() === want; });
  })[0] || null;
}

// Worst-case insertion loss of a cord, accepting either a plain number or the
// {min,max} shape the splitter entries use.
function cordLossDb(part) {
  if (!part) return 0;
  const loss = part.insertionLossDb;
  if (typeof loss === 'number' && isFinite(loss)) return loss;
  if (loss && typeof loss === 'object') {
    const max = Number(loss.max);
    if (isFinite(max)) return max;
    const min = Number(loss.min);
    if (isFinite(min)) return min;
  }
  return 0;
}

function cageIdOf(c) {
  const id = String(c || '');
  return mediaModel.CAGE_ALIAS[id] || id;
}

// The hybrid cord that can join these two cages, or null.
//
// Returns a part only when the two cages are the same connector *shape* with
// different polishes (the pair that is otherwise impossible) AND the catalogue
// has a cord terminated one way on each end. Both argument orders work, because
// which port is A and which is B is an accident of how the link was drawn.
function hybridCord(a, b) {
  const ca = cageIdOf(a), cb = cageIdOf(b);
  if (!ca || !cb || ca === cb) return null;
  const fa = mediaModel.ferrule(ca), fb = mediaModel.ferrule(cb);
  if (!fa || !fb || fa.shape !== fb.shape || fa.polish === fb.polish) return null;
  const hit = patchCords().filter(function (p) {
    const ea = cageIdOf(p.endA), eb = cageIdOf(p.endB);
    return (ea === ca && eb === cb) || (ea === cb && eb === ca);
  })[0];
  return hit || null;
}

// Does this cord terminate in exactly these two connectors? A hybrid SC lead on
// an LC port is the wrong part, not a working link.
function cordFits(cord, a, b) {
  if (!cord) return false;
  const ca = cageIdOf(a), cb = cageIdOf(b);
  const ea = cageIdOf(cord.endA), eb = cageIdOf(cord.endB);
  return (ea === ca && eb === cb) || (ea === cb && eb === ca);
}


module.exports = {
  SPLITTERS, PON_CLASSES, FIBRE_DB_PER_KM,
  transceivers, transceiverByPart, transceiversForCage, biDiPairsWith,
  odnParts, catalogueSplitterLossDb,
  patchCords, patchCord, hybridCord, cordFits, cordLossDb,
  CONNECTOR_LOSS_DB, SPLICE_LOSS_DB,
  splitterById, splitterLossDb, fibreLossDbPerKm, ponBudget
};
