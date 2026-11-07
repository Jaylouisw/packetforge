'use strict';
// validation.js -- cabling-feasibility rules engine.
//
// validateConnection() answers one question: "may these two ports be cabled,
// and what should the user be warned about if they are?" It is pure: it reads
// the media model (./media), derives port hardware when the caller only
// supplies terse interface specs, and returns a verdict. It never mutates the
// devices, interfaces or topology it is handed.
//
// Verdict shape:
//   {
//     ok: boolean,
//     errors:   [ { code, message } ],   // blocking, empty when none
//     warnings: [ { code, message } ],   // advisory, empty when none
//     media:    [ mediaId ],             // media both ports can carry
//     mediaId:  string|null,             // the medium that would be used
//     speedMbps: number|null             // negotiated (and media-capped) rate
//   }
//
// Codes are stable strings: the UI switches on them, so never rename one
// without adding the replacement to RULES.
//
// Caller input (all optional except the two ports):
//   { portA, portB, devA, devB, ifaceA, ifaceB, mediaId, lengthM,
//     duplexA, duplexB }
//
// A "port" may be a derived hardware descriptor (the object returned by
// media.derivePortHardware) or a raw interface spec; both are normalised to
// the same internal shape, so callers never have to prepare ports themselves.
// When only devA/B are given, the interfaces are resolved by name from the
// device's interface collection (Map, array or plain object).

const mediaModel = require('./media');

const MEDIA = mediaModel.MEDIA;
const CAGES = mediaModel.CAGES;
const derivePortHardware = mediaModel.derivePortHardware;
const canMate = mediaModel.canMate;
const commonMedia = mediaModel.commonMedia;
const negotiateSpeed = mediaModel.negotiateSpeed;
const preferredMedia = mediaModel.preferredMedia;
const mediaById = mediaModel.mediaById;

// ---------------------------------------------------------------------------
// rule catalogue
// ---------------------------------------------------------------------------
// Every code this module can emit, with its severity. validateTopology() uses
// this as the authority for counts, and the UI can render documentation
// straight out of it.

const RULES = [
  {
    code: 'E_NO_PORT', severity: 'error',
    description: 'One of the two ports does not exist on its device.'
  },
  {
    code: 'E_SELF_LINK', severity: 'error',
    description: 'A device cannot be cabled to itself.'
  },
  {
    code: 'E_PORT_IN_USE', severity: 'error',
    description: 'A port that already carries a link cannot take a second one.'
  },
  {
    code: 'E_CONNECTOR_MISMATCH', severity: 'error',
    description: 'The two cages cannot physically mate (for example RJ45 to an optical SFP cage).'
  },
  {
    code: 'E_NO_COMMON_MEDIA', severity: 'error',
    description: 'The cages mate but the ports share no medium (no optic, DAC or copper module in common).'
  },
  {
    code: 'E_NO_COMMON_SPEED', severity: 'error',
    description: 'The ports share a medium but no common line rate can be negotiated.'
  },
  {
    code: 'E_WIRELESS_TO_WIRED', severity: 'error',
    description: 'A radio/antenna port cannot be cabled to a wired port.'
  },
  {
    code: 'E_CONSOLE_TO_DATA', severity: 'error',
    description: 'A console port can only be cabled to another console or USB console port.'
  },
  {
    code: 'E_MEDIA_NOT_SUPPORTED', severity: 'error',
    description: 'The requested medium is not supported by both ports.'
  },
  {
    code: 'E_POE_BUDGET', severity: 'error',
    description: 'The powered ports of a PSE device draw more than its PoE power budget.'
  },
  {
    code: 'E_LAG_SPEED_MISMATCH', severity: 'error',
    description: 'Members of one LAG do not run at the same line rate.'
  },
  {
    code: 'W_DISTANCE', severity: 'warning',
    description: 'Cable length exceeds the reach of the chosen medium.'
  },
  {
    code: 'W_DUPLEX_MISMATCH', severity: 'warning',
    description: 'The two ends are configured with different duplex modes.'
  },
  {
    code: 'W_SPEED_DOWNGRADE', severity: 'warning',
    description: 'The link runs below the maximum speed of both ports.'
  },
  {
    code: 'W_POE_DRAW', severity: 'warning',
    description: 'A PoE-powered device is cabled to a port that cannot supply power.'
  },
  {
    code: 'W_COPPER_LONGRUN', severity: 'warning',
    description: 'Copper link is longer than the 90 m horizontal-run limit.'
  }
];

const SEVERITY_BY_CODE = (function () {
  const map = {};
  for (const r of RULES) map[r.code] = r.severity;
  return map;
})();

const DESCRIPTION_BY_CODE = (function () {
  const map = {};
  for (const r of RULES) map[r.code] = r.description;
  return map;
})();

// Default link budget for a horizontal copper run, per TIA-568 / 802.3.
const COPPER_RUN_LIMIT_M = 90;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (typeof n !== 'number' || !isFinite(n)) return null;
  return n;
}

function numOr(v, dflt) {
  const n = numOrNull(v);
  return n === null ? dflt : n;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function speedLabel(mbps) {
  if (mbps === null || mbps === undefined) return 'unknown';
  const s = mediaModel.formatSpeedMbps(mbps);
  return s === null ? String(mbps) : s;
}

function mediaName(id) {
  const m = MEDIA[id];
  return m ? m.name : String(id);
}

function mediaLabelList(ids) {
  if (!ids || !ids.length) return 'none';
  return ids.map(mediaName).join(', ');
}

function nameOf(ref) {
  if (!ref) return null;
  if (typeof ref === 'string') return ref;
  if (typeof ref === 'object' && typeof ref.name === 'string') return ref.name;
  return null;
}

function deviceLabel(dev) {
  if (!dev) return 'device';
  return dev.label || dev.name || dev.hostname || dev.id || 'device';
}

function portLabel(dev, port, iface) {
  const pname = (port && port.name) || (iface && iface.name) || 'port';
  return deviceLabel(dev) + '/' + pname;
}

function peerLabel(peer) {
  if (!peer) return 'another port';
  if (typeof peer === 'string') return peer;
  const dev = peer.deviceId || peer.dev || 'device';
  const iface = peer.iface || peer.name || 'port';
  return dev + '/' + iface;
}

// Enumerate a device's interfaces whatever collection type it uses.
function eachIface(dev) {
  if (!dev || !dev.interfaces) return [];
  const coll = dev.interfaces;
  if (typeof coll.values === 'function') return Array.from(coll.values());
  if (Array.isArray(coll)) return coll.slice();
  if (typeof coll === 'object') {
    return Object.keys(coll).map(function (k) { return coll[k]; });
  }
  return [];
}

function lookupIface(dev, name) {
  if (!dev || !dev.interfaces || !name) return null;
  const coll = dev.interfaces;
  if (typeof coll.get === 'function') return coll.get(name) || null;
  if (Array.isArray(coll)) {
    for (const i of coll) if (i && i.name === name) return i;
    return null;
  }
  if (typeof coll === 'object') return coll[name] || null;
  return null;
}

// ---------------------------------------------------------------------------
// port normalisation
// ---------------------------------------------------------------------------
// Two accepted shapes: a derived hardware descriptor (has a cage plus media
// and speedCaps arrays) and a terse interface spec ({ name, type, speed }),
// which is expanded through media.derivePortHardware.

function isPortHardware(o) {
  return !!o && typeof o === 'object' &&
    typeof o.cage === 'string' &&
    Array.isArray(o.media) &&
    Array.isArray(o.speedCaps);
}

const SPEC_FIELDS = [
  'name', 'type', 'speed', 'cage', 'connector',
  'media', 'supportedMedia', 'hardware',
  'poeOut', 'poeIn', 'maxRangeM'
];

function pickSpecFields(src) {
  const out = {};
  if (!src || typeof src !== 'object') return out;
  for (const k of SPEC_FIELDS) {
    if (src[k] !== undefined) out[k] = src[k];
  }
  return out;
}

function devSpecOf(dev) {
  if (!dev) return {};
  return {
    model: dev.model,
    label: dev.label,
    category: dev.category,
    vendor: dev.vendor,
    capabilities: dev.capabilities
  };
}

function maxOf(list) {
  if (!list || !list.length) return null;
  return Math.max.apply(null, list);
}

// Fill in every field the rules rely on, so hand-built and derived ports are
// interchangeable downstream.
function completeHardware(port, iface) {
  const src = port || {};
  const cage = src.cage || (iface && iface.cage) || 'rj45';
  const cageDef = CAGES[cage] || CAGES.rj45;
  const speeds = Array.isArray(src.speedCaps) ? src.speedCaps.slice() : [];
  return {
    name: src.name || (iface && iface.name) || 'port',
    type: src.type || (iface && iface.type) || 'ethernet',
    cage: cage,
    cageName: src.cageName || cageDef.name,
    family: src.family || cageDef.family,
    media: Array.isArray(src.media) ? src.media.slice() : [],
    speedCaps: speeds,
    maxSpeedMbps: src.maxSpeedMbps !== undefined && src.maxSpeedMbps !== null
      ? numOrNull(src.maxSpeedMbps)
      : maxOf(speeds),
    poeOut: numOrNull(src.poeOut),
    poeIn: numOrNull(src.poeIn),
    maxRangeM: numOrNull(src.maxRangeM)
  };
}

function normalizePort(portOrSpec, iface, dev) {
  if (isPortHardware(portOrSpec)) return completeHardware(portOrSpec, iface);
  if (!portOrSpec && !iface) return null;
  // A bare name is resolved against the device below by the caller; here we
  // simply merge whatever we were given, interface first, explicit spec last.
  const spec = Object.assign({}, pickSpecFields(iface), pickSpecFields(portOrSpec));
  return completeHardware(derivePortHardware(spec, devSpecOf(dev)), iface);
}

// Derive (and memoise) the hardware of an interface that is not part of the
// link being validated -- used by the PoE budget rule.
function cachePort(cache, iface, dev) {
  if (!iface) return null;
  if (cache.has(iface)) return cache.get(iface);
  const hw = completeHardware(derivePortHardware(pickSpecFields(iface), devSpecOf(dev)), iface);
  cache.set(iface, hw);
  return hw;
}

// ---------------------------------------------------------------------------
// individual rules
// ---------------------------------------------------------------------------

// Total PoE draw of the powered ports of one PSE, or null when the device has
// no budget to police (budget 0 / absent == unlimited or no PoE at all).
function pseDraw(cache, dev, connecting) {
  if (!dev) return null;
  const budget = numOrNull(dev.poeBudget);
  if (budget === null || !(budget > 0)) return null;

  let total = 0;
  const ports = [];
  const seen = new Set();

  for (const iface of eachIface(dev)) {
    seen.add(iface);
    const hw = cachePort(cache, iface, dev);
    if (!hw || !(hw.poeOut > 0)) continue;
    const inPlay = !!iface.peer || connecting.indexOf(iface) !== -1;
    if (!inPlay) continue;
    total += hw.poeOut;
    ports.push(hw.name);
  }

  // A caller may hand us a port object that is not (yet) in device.interfaces.
  for (const iface of connecting) {
    if (!iface || seen.has(iface)) continue;
    const hw = cachePort(cache, iface, dev);
    if (hw && hw.poeOut > 0) {
      total += hw.poeOut;
      ports.push(hw.name);
    }
  }

  return { budget: budget, total: round1(total), ports: ports };
}

function lagIdOf(iface, port) {
  const v = (iface && iface.lagId !== undefined && iface.lagId !== null)
    ? iface.lagId
    : (port && port.lagId !== undefined ? port.lagId : null);
  return (v === undefined || v === null || v === '') ? null : String(v);
}

// The line rate a LAG member is expected to run at: an explicitly declared LAG
// rate wins, otherwise the port's own maximum capability.
function lagRateMbps(dev, iface, port) {
  if (iface && iface.lagSpeedMbps !== undefined && iface.lagSpeedMbps !== null) {
    const n = numOrNull(iface.lagSpeedMbps);
    if (n !== null) return n;
  }
  const lagId = lagIdOf(iface, port);
  if (dev && dev.lags && lagId !== null) {
    const lag = dev.lags[lagId] || null;
    if (lag && lag.speedMbps !== undefined && lag.speedMbps !== null) {
      const n = numOrNull(lag.speedMbps);
      if (n !== null) return n;
    }
  }
  return port && port.maxSpeedMbps !== undefined ? port.maxSpeedMbps : null;
}

// ---------------------------------------------------------------------------
// validateConnection
// ---------------------------------------------------------------------------

function validateConnection(input) {
  const inp = input || {};
  const errors = [];
  const warnings = [];
  const verdict = {
    ok: false,
    errors: errors,
    warnings: warnings,
    media: [],
    mediaId: null,
    speedMbps: null
  };

  const devA = inp.devA || null;
  const devB = inp.devB || null;
  const cache = new Map();

  const ifaceA = inp.ifaceA ||
    lookupIface(devA, nameOf(inp.portA) || inp.portAName || inp.ifaceAName);
  const ifaceB = inp.ifaceB ||
    lookupIface(devB, nameOf(inp.portB) || inp.portBName || inp.ifaceBName);

  let specA = inp.portA;
  let specB = inp.portB;
  if (typeof specA === 'string') specA = lookupIface(devA, specA);
  if (typeof specB === 'string') specB = lookupIface(devB, specB);

  const portA = normalizePort(specA, ifaceA, devA);
  const portB = normalizePort(specB, ifaceB, devB);

  // -- E_NO_PORT ------------------------------------------------------------
  if (!portA || !portB) {
    if (!portA) {
      errors.push({
        code: 'E_NO_PORT',
        message: 'Port A does not exist on ' + deviceLabel(devA) + '.'
      });
    }
    if (!portB) {
      errors.push({
        code: 'E_NO_PORT',
        message: 'Port B does not exist on ' + deviceLabel(devB) + '.'
      });
    }
    return verdict;
  }

  const lblA = portLabel(devA, portA, ifaceA);
  const lblB = portLabel(devB, portB, ifaceB);

  // -- E_SELF_LINK ----------------------------------------------------------
  const idA = devA && devA.id !== undefined ? devA.id : null;
  const idB = devB && devB.id !== undefined ? devB.id : null;
  if (idA !== null && idB !== null && String(idA) === String(idB)) {
    errors.push({
      code: 'E_SELF_LINK',
      message: deviceLabel(devA) + ' cannot be cabled to itself (' +
        portA.name + ' to ' + portB.name + ').'
    });
    return verdict;
  }

  // -- E_PORT_IN_USE --------------------------------------------------------
  if (ifaceA && ifaceA.peer) {
    errors.push({
      code: 'E_PORT_IN_USE',
      message: lblA + ' is already connected to ' + peerLabel(ifaceA.peer) + '.'
    });
  }
  if (ifaceB && ifaceB.peer) {
    errors.push({
      code: 'E_PORT_IN_USE',
      message: lblB + ' is already connected to ' + peerLabel(ifaceB.peer) + '.'
    });
  }

  // -- E_CONSOLE_TO_DATA ----------------------------------------------------
  // A console port is a management port: it may only meet another console-ish
  // cage. Connector verdicts themselves stay delegated to canMate().
  function isConsoleLike(cage) { return cage === 'console' || cage === 'usb'; }
  let consoleToData = false;
  if ((portA.cage === 'console' || portB.cage === 'console') &&
      !(isConsoleLike(portA.cage) && isConsoleLike(portB.cage))) {
    consoleToData = true;
    const conLbl = portA.cage === 'console' ? lblA : lblB;
    const dataLbl = portA.cage === 'console' ? lblB : lblA;
    errors.push({
      code: 'E_CONSOLE_TO_DATA',
      message: 'Console port ' + conLbl + ' cannot be cabled to the data port ' +
        dataLbl + '.'
    });
  }

  // -- connector / media / speed verdicts (delegated to canMate) ------------
  const mate = canMate(portA, portB);
  if (!mate.ok && !consoleToData) {
    errors.push({
      code: mate.code,
      message: lblA + ' <-> ' + lblB + ': ' + mate.message
    });
  }

  // -- medium selection -----------------------------------------------------
  const common = mate.ok ? mate.media.slice() : commonMedia(portA, portB);
  verdict.media = common.slice();

  let mediaId = null;
  const requested = inp.mediaId ? String(inp.mediaId) : null;
  if (requested) {
    if (common.indexOf(requested) === -1) {
      errors.push({
        code: 'E_MEDIA_NOT_SUPPORTED',
        message: mediaName(requested) + ' (' + requested + ') is not supported by both ' +
          lblA + ' and ' + lblB + '; possible media: ' + mediaLabelList(common) + '.'
      });
    } else {
      mediaId = requested;
    }
  } else {
    mediaId = preferredMedia(common);
  }
  verdict.mediaId = mediaId;

  const chosen = mediaId ? mediaById(mediaId) : null;

  // -- negotiated speed -----------------------------------------------------
  // Auto-negotiation first, then clamp to the chosen medium: you cannot run
  // 10G through a 1000BASE-T module even if both cages could do 10G.
  let speed = mate.ok ? mate.speedMbps : negotiateSpeed(portA, portB);
  if (speed !== null && speed !== undefined && chosen &&
      typeof chosen.speedMbps === 'number' && chosen.speedMbps > 0) {
    speed = Math.min(speed, chosen.speedMbps);
  }
  if (speed === undefined) speed = null;
  verdict.speedMbps = speed;

  // -- E_OPTICAL_BUDGET -----------------------------------------------------
  // A PON link is not just a cable. The passive splitter and the fibre both eat
  // the class budget, and once the total passes it no amount of configuration
  // will make the branch work - so say so at cabling time rather than leaving a
  // link that silently never passes traffic. Checked in BOTH directions: the
  // upstream runs at 1310 nm, which is lossier than the 1490 nm downstream, so
  // the reverse direction is usually the one that fails.
  const isPonCage = function (c) {
    return c === 'sc-apc' || c === 'sc-upc' || c === 'lc-upc' || c === 'lc-apc';
  };
  if (isPonCage(portA.cage) && isPonCage(portB.cage)) {
    const optical = require('./optical');
    const ratios = [];
    for (const d of [devA, devB]) {
      const spec = d && d.spec;
      if (spec && spec.category === 'splitter' && spec.splitRatio) {
        // splitRatio may be written as 8 or as "1:8" depending on who authored it.
        const r = String(spec.splitRatio);
        ratios.push(r.indexOf(':') === -1 ? '1:' + r : r);
      }
    }
    const ponClass = (devA && devA.spec && devA.spec.ponClass) ||
      (devB && devB.spec && devB.spec.ponClass) || 'B+';
    const lengthM = (inp.lengthM === undefined || inp.lengthM === null) ? 0 : Number(inp.lengthM);
    const down = optical.ponBudget({ lengthM: lengthM, wavelengthNm: 1490, splitters: ratios, ponClass: ponClass });
    const up = optical.ponBudget({ lengthM: lengthM, wavelengthNm: 1310, splitters: ratios, ponClass: ponClass });
    const bad = !down.ok ? down : (!up.ok ? up : null);
    if (bad) {
      const dir = !down.ok ? 'downstream at 1490 nm' : 'upstream at 1310 nm';
      errors.push({
        code: 'E_OPTICAL_BUDGET',
        message: lblA + ' <-> ' + lblB + ': ' + dir + ' ' + bad.message
      });
    } else {
      const spare = Math.min(down.headroomDb, up.headroomDb);
      if (spare < 3) {
        warnings.push({
          code: 'W_OPTICAL_HEADROOM',
          message: lblA + ' <-> ' + lblB + ' leaves only ' + spare + ' dB of the ' +
            ponClass + ' budget. Any extra splice or a dirtier connector will put it over.'
        });
      }
    }
  }

  // -- E_POE_BUDGET ---------------------------------------------------------
  const connecting = [];
  if (ifaceA) connecting.push(ifaceA);
  if (ifaceB) connecting.push(ifaceB);

  const sides = [
    { dev: devA, other: 'B' },
    { dev: devB, other: 'A' }
  ];
  for (const side of sides) {
    const draw = pseDraw(cache, side.dev, connecting);
    if (draw && draw.total > draw.budget) {
      errors.push({
        code: 'E_POE_BUDGET',
        message: deviceLabel(side.dev) + ' PoE budget exceeded: ' + draw.ports.length +
          ' powered port' + (draw.ports.length === 1 ? '' : 's') + ' draw ' +
          draw.total + ' W of a ' + draw.budget + ' W budget (' +
          draw.ports.join(', ') + ').'
      });
    }
  }

  // -- E_LAG_SPEED_MISMATCH -------------------------------------------------
  const lagA = lagIdOf(ifaceA, portA);
  const lagB = lagIdOf(ifaceB, portB);
  if (lagA !== null && lagB !== null && lagA === lagB) {
    const rateA = lagRateMbps(devA, ifaceA, portA);
    const rateB = lagRateMbps(devB, ifaceB, portB);
    if (rateA !== null && rateB !== null && rateA !== rateB) {
      errors.push({
        code: 'E_LAG_SPEED_MISMATCH',
        message: 'LAG ' + lagA + ' members must run at the same rate: ' + lblA +
          ' is ' + speedLabel(rateA) + ' but ' + lblB + ' is ' + speedLabel(rateB) + '.'
      });
    } else if (speed !== null && rateA !== null && rateA !== speed) {
      errors.push({
        code: 'E_LAG_SPEED_MISMATCH',
        message: 'LAG ' + lagA + ' is declared at ' + speedLabel(rateA) + ' but ' +
          lblA + ' <-> ' + lblB + ' negotiated ' + speedLabel(speed) + '.'
      });
    } else if (speed !== null && rateB !== null && rateB !== speed) {
      errors.push({
        code: 'E_LAG_SPEED_MISMATCH',
        message: 'LAG ' + lagB + ' is declared at ' + speedLabel(rateB) + ' but ' +
          lblA + ' <-> ' + lblB + ' negotiated ' + speedLabel(speed) + '.'
      });
    }
  }

  // -- W_DISTANCE -----------------------------------------------------------
  const lengthM = numOrNull(inp.lengthM);
  if (lengthM !== null && chosen && chosen.maxRangeM !== null &&
      chosen.maxRangeM !== undefined && lengthM > chosen.maxRangeM) {
    warnings.push({
      code: 'W_DISTANCE',
      message: lengthM + ' m exceeds the ' + chosen.maxRangeM + ' m reach of ' +
        chosen.name + ' between ' + lblA + ' and ' + lblB + '.'
    });
  }

  // -- W_COPPER_LONGRUN -----------------------------------------------------
  if (lengthM !== null && chosen && chosen.family === 'copper' &&
      lengthM > COPPER_RUN_LIMIT_M) {
    warnings.push({
      code: 'W_COPPER_LONGRUN',
      message: 'Copper run of ' + lengthM + ' m between ' + lblA + ' and ' + lblB +
        ' exceeds the ' + COPPER_RUN_LIMIT_M + ' m horizontal-run limit.'
    });
  }

  // -- W_DUPLEX_MISMATCH ----------------------------------------------------
  const duplexA = inp.duplexA ? String(inp.duplexA).toLowerCase()
    : (ifaceA && ifaceA.duplex ? String(ifaceA.duplex).toLowerCase() : null);
  const duplexB = inp.duplexB ? String(inp.duplexB).toLowerCase()
    : (ifaceB && ifaceB.duplex ? String(ifaceB.duplex).toLowerCase() : null);
  if (duplexA && duplexB && duplexA !== duplexB) {
    warnings.push({
      code: 'W_DUPLEX_MISMATCH',
      message: lblA + ' is ' + duplexA + '-duplex but ' + lblB + ' is ' +
        duplexB + '-duplex; the link will fall back or error.'
    });
  }

  // -- W_SPEED_DOWNGRADE ----------------------------------------------------
  if (speed !== null &&
      portA.maxSpeedMbps !== null && portB.maxSpeedMbps !== null &&
      speed < portA.maxSpeedMbps && speed < portB.maxSpeedMbps) {
    warnings.push({
      code: 'W_SPEED_DOWNGRADE',
      message: 'Link ' + lblA + ' <-> ' + lblB + ' runs at ' + speedLabel(speed) +
        ', below the ' + speedLabel(portA.maxSpeedMbps) + ' of ' + portA.name +
        ' and the ' + speedLabel(portB.maxSpeedMbps) + ' of ' + portB.name + '.'
    });
  }

  // -- W_POE_DRAW -----------------------------------------------------------
  if (portB.poeIn !== null && portB.poeIn > 0 && !(portA.poeOut > 0)) {
    warnings.push({
      code: 'W_POE_DRAW',
      message: lblB + ' is PoE-powered but ' + lblA +
        ' supplies no PoE; the device will need its own power supply.'
    });
  }
  if (portA.poeIn !== null && portA.poeIn > 0 && !(portB.poeOut > 0)) {
    warnings.push({
      code: 'W_POE_DRAW',
      message: lblA + ' is PoE-powered but ' + lblB +
        ' supplies no PoE; the device will need its own power supply.'
    });
  }

  verdict.ok = errors.length === 0;
  return verdict;
}

// ---------------------------------------------------------------------------
// validateTopology
// ---------------------------------------------------------------------------
// Aggregates the issues produced by (possibly many) validateConnection calls.
// Accepts a flat list of issues ({ code, message? }), validateConnection
// verdicts, or nested arrays of either, and preserves any extra fields
// (linkId, deviceId, ...) the caller attached.

function severityOf(code) {
  if (SEVERITY_BY_CODE[code]) return SEVERITY_BY_CODE[code];
  if (typeof code === 'string' && code.indexOf('W_') === 0) return 'warning';
  return 'error';
}

function collectIssues(list, out, inherited) {
  if (!list) return;
  if (Array.isArray(list)) {
    for (const item of list) collectIssues(item, out, inherited);
    return;
  }
  if (typeof list !== 'object') return;

  // A validateConnection() verdict: split errors/warnings out.
  if (Array.isArray(list.errors) || Array.isArray(list.warnings)) {
    const ctx = {};
    for (const k of Object.keys(list)) {
      if (k !== 'errors' && k !== 'warnings' && k !== 'ok' &&
          k !== 'media' && k !== 'mediaId' && k !== 'speedMbps') {
        ctx[k] = list[k];
      }
    }
    const base = Object.assign({}, inherited, ctx);
    for (const e of (list.errors || [])) {
      collectIssues(Object.assign({ severity: 'error' }, base, e), out, null);
    }
    for (const w of (list.warnings || [])) {
      collectIssues(Object.assign({ severity: 'warning' }, base, w), out, null);
    }
    return;
  }

  if (typeof list.code !== 'string') return;
  const issue = Object.assign({}, inherited, list);
  issue.severity = list.severity || severityOf(issue.code);
  if (!issue.message) {
    issue.message = DESCRIPTION_BY_CODE[issue.code] || issue.code;
  }
  out.push(issue);
}

function validateTopology(linkIssueList) {
  const issues = [];
  collectIssues(linkIssueList, issues, null);

  let errorCount = 0;
  let warningCount = 0;
  for (const issue of issues) {
    if (issue.severity === 'error') errorCount++;
    else if (issue.severity === 'warning') warningCount++;
  }

  return {
    ok: errorCount === 0,
    errorCount: errorCount,
    warningCount: warningCount,
    issues: issues
  };
}

module.exports = { validateConnection, validateTopology, RULES };
