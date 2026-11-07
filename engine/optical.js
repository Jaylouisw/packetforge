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

  const lossDb = fibreDb + splitterDb + spliceDb + connectorDb;
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
      connectors: { pairs: connectorPairs, lossDb: Math.round(connectorDb * 100) / 100 }
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

function odnParts() {
  if (_odn === null) {
    const raw = _load('odn.json');
    _odn = Array.isArray(raw) ? raw : [];
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


module.exports = {
  SPLITTERS, PON_CLASSES, FIBRE_DB_PER_KM,
  transceivers, transceiverByPart, transceiversForCage, biDiPairsWith,
  odnParts, catalogueSplitterLossDb,
  CONNECTOR_LOSS_DB, SPLICE_LOSS_DB,
  splitterById, splitterLossDb, fibreLossDbPerKm, ponBudget
};
