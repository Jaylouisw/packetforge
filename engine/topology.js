'use strict';
// topology.js -- a container of devices + links, with (de)serialization.
const { Device } = require('./device');
const { Link } = require('./link');
const media = require('./media');
const ifaceName = require('./iface-name');
const net = require('./net');

// Expand a device spec's interfaces into a flat list.
//
// This used to be a second implementation of the rule in `devices/registry.js` (`effectiveInterfaces`), kept in
// step by a test that compared port NAMES over the catalogue - so a divergence in any other field, on any spec
// outside the catalogue, or in any edge case, was invisible by construction. Worse, the two copies disagreed about
// what to do with a template they could not honour: the loader refused `count: 1000000` and the engine obediently
// started building a million ports (#1319).
//
// There is now one implementation. A spec that cannot describe a device is refused here too, because a device can
// also arrive from a hand-edited saved board, which never passes through the loader.
const { effectiveInterfaces } = require('../devices/registry');

function expandInterfaces(spec) {
  return effectiveInterfaces(spec);
}

// What is wrong with a cable in a document, before anything is built from it. Returns null when it is fine.
//
// A cable is two ports. A document can describe one that is not: endpoints that do not exist, a port cabled to
// itself, a state nobody defines, or two cables sharing one id (the second silently replaced the first, because
// links are kept in a map). The HTTP API refuses a bad state with 422; the load path accepted anything, so a
// hand-edited or corrupted file produced a cable in a state that is neither up nor down (#1323).
const LINK_STATES = ['up', 'down', 'blocked'];

function cableProblem(link, topo) {
  if (!link || typeof link !== 'object') return { code: 'E_LINK_MALFORMED', message: 'not a cable' };
  const a = link.a, b = link.b;
  if (!a || typeof a !== 'object' || typeof a.deviceId !== 'string' || typeof a.iface !== 'string') {
    return { code: 'E_LINK_MALFORMED', message: 'cable has no a end (deviceId and iface)' };
  }
  if (!b || typeof b !== 'object' || typeof b.deviceId !== 'string' || typeof b.iface !== 'string') {
    return { code: 'E_LINK_MALFORMED', message: 'cable has no b end (deviceId and iface)' };
  }
  if (a.deviceId === b.deviceId && a.iface === b.iface) {
    return { code: 'E_LINK_SELF_LOOP', message: 'cable joins ' + a.deviceId + '/' + a.iface + ' to itself' };
  }
  if (link.state !== undefined && LINK_STATES.indexOf(link.state) === -1) {
    return { code: 'E_LINK_BAD_STATE', message: 'cable state ' + JSON.stringify(link.state) +
      ' is not one of ' + LINK_STATES.join(', ') };
  }
  if (link.id !== undefined && link.id !== null && topo.links.has(link.id)) {
    return { code: 'E_LINK_DUPLICATE_ID', message: 'two cables share the id ' + JSON.stringify(link.id) +
      '; the first one is kept' };
  }
  for (const end of [a, b]) {
    const dev = topo.devices.get(end.deviceId);
    if (!dev) return { code: 'E_LINK_ENDPOINT_MISSING', message: 'cable end ' + end.deviceId + '/' + end.iface +
      ' names a device that is not in the document' };
    if (!dev.interfaces.has(end.iface)) return { code: 'E_LINK_ENDPOINT_MISSING', message: 'cable end ' +
      end.deviceId + '/' + end.iface + ' names a port that device does not have' };
  }
  return null;
}

// Where the canvas's world ends, in pixels either side of the origin.
//
// A position has to be two finite numbers, and finite was where this stopped - which is not enough (#1421). `1e308`
// is a finite number and it is not a place: `fitView()` takes the board's width as the largest x minus the smallest,
// and the difference of two such positions is `Infinity`. Zoom then clamps to its 0.25 floor, `translate()` is handed
// `-Infinity`, and the board draws nothing - "Fit to view" included. The lab is not lost, but it cannot be seen or
// dragged back, which for a person is the same thing.
//
// The limit is deliberately generous: a person drags devices across a canvas of pixels, and the biggest lab the
// catalogue can build spans tens of thousands. It exists only so every accepted position keeps the framing
// arithmetic finite, which is the property `test/layout-positions.test.js` asserts over both doors that set one.
const WORLD_LIMIT = 1e6;

// A position is two finite numbers inside that world. Anything else is not a position.
function isPosition(p) {
  return !!p && typeof p === 'object' && !Array.isArray(p) &&
    typeof p.x === 'number' && isFinite(p.x) && Math.abs(p.x) <= WORLD_LIMIT &&
    typeof p.y === 'number' && isFinite(p.y) && Math.abs(p.y) <= WORLD_LIMIT;
}

// Why something is not a position, in words a person can act on. Kept beside `isPosition()` so the refusal and the
// rule cannot disagree about what went wrong.
function positionProblem(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'not { x, y } with two numbers';
  if (typeof p.x !== 'number' || typeof p.y !== 'number' || !isFinite(p.x) || !isFinite(p.y)) {
    return 'not { x, y } with two numbers';
  }
  return 'outside the canvas - x and y are pixel positions within ' + WORLD_LIMIT + ' of the origin';
}

function copyLayout(layout) {
  const out = {};
  for (const id of Object.keys(layout || {})) {
    const p = layout[id];
    if (p && typeof p === 'object') out[id] = Object.assign({}, p);
  }
  return out;
}

// Read a layout out of a document, keeping only positions that name a device the board actually has.
function readLayout(raw, devices) {
  const layout = {};
  const issues = [];
  if (raw === undefined || raw === null) return { layout: layout, issues: issues };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push({ severity: 'error', code: 'E_LAYOUT_MALFORMED',
      message: 'layout is ' + (Array.isArray(raw) ? 'an array' : typeof raw) + ', not a map of device id to position' });
    return { layout: layout, issues: issues };
  }
  for (const id of Object.keys(raw)) {
    const p = raw[id];
    if (!isPosition(p)) {
      issues.push({ severity: 'error', code: 'E_LAYOUT_BAD_ENTRY',
        message: 'position for ' + id + ' is ' + positionProblem(p) + ': ' + JSON.stringify(p) });
      continue;
    }
    if (!devices.has(id)) {
      issues.push({ severity: 'warning', code: 'E_LAYOUT_UNKNOWN_DEVICE',
        message: 'position for ' + id + ', which is not a device in this document' });
      continue;
    }
    layout[id] = { x: p.x, y: p.y };
  }
  return { layout: layout, issues: issues };
}

class Topology {
  constructor() {
    this.devices = new Map();
    this.links = new Map();
    this.layout = {}; // deviceId -> { x, y }
    this._seq = 1;
    this._macBase = 0x020000000000; // locally administered unicast base
    // The instant of the last link-state change, in milliseconds since power-on. It belongs to the
    // network rather than to a query, because the cable that was pulled at t=10 s is still pulled
    // when the next question is asked at t=41 s.
    this.lastChangeAtMs = 0;
  }

  // Record that something changed at an instant, so every later question can say whether the
  // network has finished reacting to it.
  markChange(atMs) {
    const n = Number(atMs);
    this.lastChangeAtMs = Number.isFinite(n) && n >= 0 ? n : 0;
    return this.lastChangeAtMs;
  }

  // Keep the id counter ahead of every id actually present.
//
// Ids are allocated as `'d' + _seq++`, so the counter is normally already one past the highest id.
// That stops being true the moment a caller supplies its own id: a topology built as `d0` and `d2`
// still had `_seq = 1`, so `serialize()` wrote `seq: 1` next to a `d2`, and loading that document
// pushed the counter to 3. Save, load and save again then produced a *different* file - one integer
// of churn per open/save cycle in a lab file that is meant to be diffed in git.
_advanceSeq(id) {
    const m = /^[dl](\d+)$/.exec(String(id == null ? '' : id));
    if (m) this._seq = Math.max(this._seq, Number(m[1]) + 1);
    return this._seq;
}

addDevice(spec, id) {
    const fullSpec = Object.assign({}, spec, { interfaces: expandInterfaces(spec) });
    if (id) {
      // An explicit id that is already taken used to overwrite the existing device
      // without a word. Losing a device because two callers picked the same name is
      // not something a simulator should do quietly.
      if (this.devices.has(id)) throw new Error('device id already in use: ' + id);
      this._advanceSeq(id);
    } else {
      // Skip any id already present. A restored topology can arrive with a sequence
      // that is behind its own contents (see fromJSON), and the honest outcome there
      // is a fresh id, not a replaced device.
      do { id = 'd' + (this._seq++); } while (this.devices.has(id));
    }
    const dev = new Device(id, fullSpec);
    this._assignMacs(dev);
    this.devices.set(id, dev);
    return dev;
  }

  _assignMacs(dev) {
    const base = this._macBase;
    this._macBase += 0x100;
    let i = 0;
    for (const iface of dev.interfaces.values()) {
      // Subinterfaces have no MAC of their own: they share the parent's.
      if (iface.parent) continue;
      iface.mac = net.intToMac(base + i);
      i++;
    }
    for (const iface of dev.interfaces.values()) {
      if (!iface.parent) continue;
      const parent = dev.interfaces.get(iface.parent);
      if (parent) iface.mac = parent.mac;
    }
  }

  getDevice(id) { return this.devices.get(id) || null; }

  getLink(id) { return this.links.get(id) || null; }

  // All links touching a device.
  linksFor(deviceId) {
    const out = [];
    for (const l of this.links.values()) if (l.touches(deviceId)) out.push(l);
    return out;
  }

  // The `revalidate` pair for a cable that already exists, in the shape the port-in-use rule
  // expects: each entry names the peer of that side. An id that is not a link here resolves to
  // null, which grants nothing - a stale or invented id must never be able to wave a second cable
  // into an occupied socket.
  // The marker `validateLink` needs to re-check a cable that already exists: for each side, the peer it is
  // expected to be cabled to. Orientation matters - `a` must be the far end *as seen from the caller's A
  // side* - and it used to be assumed that the caller's A side was `link.a`. A caller holding the link from
  // the other end then handed the validator its own port as "the peer", which came back as two
  // E_PORT_IN_USE errors and made the cable look like a second cable (#1259). Naming the device you are
  // asking from removes the assumption; the one-argument form keeps its old meaning.
  revalidateFor(linkId, fromDeviceId) {
    const link = this.links.get(linkId);
    if (!link || !link.a || !link.b) return null;
    const callerIsA = !fromDeviceId || String(link.a.deviceId) === String(fromDeviceId);
    const near = callerIsA ? link.a : link.b;
    const far = callerIsA ? link.b : link.a;
    return {
      a: { deviceId: far.deviceId, iface: far.iface },
      b: { deviceId: near.deviceId, iface: near.iface }
    };
  }

  // Physical feasibility of cabling two ports. Returns a verdict:
  //   { ok, errors:[{code,message}], warnings:[{code,message}],
  //     media:[ids], mediaId, speedMbps }
  // Delegates to engine/validation.js when present, else to media.canMate().
  validateLink(aId, aIface, bId, bIface, opts) {
    opts = opts || {};
    const a = this.devices.get(aId);
    const b = this.devices.get(bId);
    // Placeholders so the rest of the function reads the resolved names, not the typed
    // ones: validateLink must agree with connect() about which socket 'ether1' is.
    const aIfaceResolved = (a && ifaceName.resolvePortName(a, aIface)) || aIface;
    const bIfaceResolved = (b && ifaceName.resolvePortName(b, bIface)) || bIface;
    aIface = aIfaceResolved;
    bIface = bIfaceResolved;
    const ai = a && a.interfaces.get(aIface);
    const bi = b && b.interfaces.get(bIface);

    let V = null;
    try { V = require('./validation'); } catch (e) { V = null; }

    // A combo port shares one physical cage with a sibling interface: cabling
    // either half occupies the cage, so the other half is unusable until that
    // cable is pulled. Checked here (not in connect()) so the dry-run endpoint
    // reports it exactly like a real link attempt.
    const comboSides = [{ dev: a, iface: ai }, { dev: b, iface: bi }];
    for (const side of comboSides) {
      if (!side.iface || !side.iface.comboWith) continue;
      const sib = side.dev.interfaces.get(side.iface.comboWith);
      if (sib && sib.peer && !opts.force) {
        return {
          ok: false,
          errors: [{
            code: 'E_COMBO_OCCUPIED',
            message: side.dev.name + '/' + side.iface.name + ' cannot be cabled: it shares one ' +
              'physical combo cage with ' + side.iface.comboWith + ', which is already in use.',
            port: side.iface.name,
            partner: side.iface.comboWith
          }],
          warnings: []
        };
      }
    }

    // `opts.revalidate` says "this cable already exists, do not refuse it for being there".
    // The rule compares each side against the PEER it is meant to be cabled to, so the pair that
    // satisfies it is the far end seen from each side - an easy thing to get backwards, and getting
    // it backwards fails silently: the verdict comes back E_PORT_IN_USE for a cable that plainly
    // exists. Callers that already hold the link id can simply name it.
    let revalidate = opts.revalidate || null;
    if (typeof revalidate === 'string') revalidate = this.revalidateFor(revalidate);

    if (V && typeof V.validateConnection === 'function') {
      // A port whose rate was forced offers exactly that rate, so auto-negotiation has one option left
      // instead of a ladder. Written as a narrowed capability rather than a special case inside the
      // negotiator: two ends forced to different rates then intersect emptily and the existing
      // "no common line rate" rule refuses the link, which is what real gear does.
      const forcedA = (ai && ai.speedMbps) ? [ai.speedMbps] : null;
      const forcedB = (bi && bi.speedMbps) ? [bi.speedMbps] : null;
      const portA = ai && ai.hardware
        ? Object.assign({}, ai.hardware, forcedA ? { speedCaps: forcedA } : null) : null;
      const portB = bi && bi.hardware
        ? Object.assign({}, bi.hardware, forcedB ? { speedCaps: forcedB } : null) : null;
      return V.validateConnection({
        portA: portA,
        portB: portB,
        ifaceA: ai,
        ifaceB: bi,
        // A caller that is re-checking an existing cable says which pair it is, so the
        // port-in-use rule does not refuse a cable that is plainly there.
        revalidate: revalidate,
        devA: a,
        devB: b,
        mediaId: opts.mediaId,
        lengthM: opts.lengthM,
        patchCord: opts.patchCord,
        duplexA: ai && ai.duplex,
        duplexB: bi && bi.duplex
      });
    }

    // Fallback: connector / media / speed checks only.
    const verdict = media.canMate(ai && ai.hardware, bi && bi.hardware);
    return {
      ok: verdict.ok,
      errors: verdict.ok ? [] : [{ code: verdict.code, message: verdict.message }],
      warnings: [],
      media: verdict.media || [],
      mediaId: verdict.ok ? media.preferredMedia(verdict.media, verdict.speedMbps) : null,
      speedMbps: verdict.speedMbps || null
    };
  }

  // Re-run the verdict for the cable on this port, after something changed that the verdict depends on -
  // a forced rate, a duplex mode. The link keeps its identity and its length; what it runs at is recomputed
  // by the same rule that created it, so `speed 100` cannot leave a link claiming 1G (#1259).
  renegotiate(devId, ifaceName) {
    const dev = this.devices.get(devId);
    if (!dev) return null;
    const iface = dev.interfaces.get(ifaceName);
    if (!iface || !iface.peer) return null;
    const peer = this.devices.get(iface.peer.deviceId);
    if (!peer) return null;
    const link = [...this.links.values()].filter(function (l) {
      return (l.a.deviceId === devId && l.a.iface === ifaceName) ||
        (l.b.deviceId === devId && l.b.iface === ifaceName);
    })[0];
    if (!link) return null;
    const verdict = this.validateLink(devId, ifaceName, iface.peer.deviceId, iface.peer.iface, {
      mediaId: link.mediaId, lengthM: link.lengthM,
      revalidate: this.revalidateFor(link.id, devId)
    });
    link.lastVerdict = verdict;
    link.speedMbps = verdict.ok ? (verdict.speedMbps || null) : null;
    if (verdict.ok && verdict.mediaId) link.mediaId = verdict.mediaId;
    // Two ends forced to different rates have no line rate in common, and a cable that cannot agree on
    // one does not come up: the frames do not cross, they are dropped with a reason. Only a link this
    // function took down is brought back up, so a cable somebody deliberately pulled stays pulled.
    if (!verdict.ok) {
      if (link.state === 'up') link.state = 'down';
      link.negotiationFailed = true;
    } else if (link.negotiationFailed) {
      link.negotiationFailed = false;
      link.state = 'up';
    }
    this.lastChangeAtMs = this.lastChangeAtMs || 0;
    return { link: link, verdict: verdict };
  }

  // Media a user could pick between two ports (for the UI's link picker).
  mediaOptions(aId, aIface, bId, bIface) {
    const a = this.devices.get(aId);
    const b = this.devices.get(bId);
    aIface = (a && ifaceName.resolvePortName(a, aIface)) || aIface;
    bIface = (b && ifaceName.resolvePortName(b, bIface)) || bIface;
    const ai = a && a.interfaces.get(aIface);
    const bi = b && b.interfaces.get(bIface);
    if (!ai || !bi) return [];
    return media.commonMedia(ai.hardware, bi.hardware).map(function (id) {
      const m = media.mediaById(id);
      return {
        id: id,
        name: m ? m.name : id,
        family: m ? m.family : null,
        speedMbps: m ? m.speedMbps : null,
        maxRangeM: m ? m.maxRangeM : null
      };
    });
  }

  // Every cable that could be drawn between two devices, ranked (issue #68).
  //
  // Cabling was port-first: you had to name the socket before the engine would help, so on a
  // 48-port switch the first click was a guess and a wrong guess was rejected with an error
  // that did not say which of the other few hundred pairs would have worked. This answers
  // the question people actually ask - "these two boxes need to talk, how?" - by trying every
  // free pair, keeping the ones that are legal, and grouping them by the medium they'd use.
  //
  // Nothing here is new physics: it is validateLink() run over the pairs, plus the refusals
  // counted by code so "nothing works" can say why instead of failing one pair at a time.
  linkOptions(aId, bId, opts) {
    const o = opts || {};
    const a = this.devices.get(aId);
    const b = this.devices.get(bId);
    if (!a) return { ok: false, code: 'E_NO_DEVICE', reason: 'no device ' + aId, options: [], refusals: {} };
    if (!b) return { ok: false, code: 'E_NO_DEVICE', reason: 'no device ' + bId, options: [], refusals: {} };
    if (a === b) {
      return { ok: false, code: 'E_SAME_DEVICE', reason: 'a device cannot be cabled to itself', options: [], refusals: {} };
    }

    // Only free ports. A port already carrying a cable is not a candidate, and a combo's
    // sibling is reported as occupied by validateLink, so both cases fall out correctly.
    const free = function (dev) {
      const out = [];
      for (const i of dev.interfaces.values()) if (!i.peer) out.push(i);
      return out;
    };

    const refusals = Object.create(null);
    const byKey = new Map();

    for (const ai of free(a)) {
      for (const bi of free(b)) {
        const v = this.validateLink(aId, ai.name, bId, bi.name, o);
        if (!v || !v.ok) {
          const code = (v && v.errors && v.errors[0] && v.errors[0].code) || 'E_UNKNOWN';
          refusals[code] = (refusals[code] || 0) + 1;
          continue;
        }
        // One "link type" per medium+speed: the choice a person makes is "10GBASE-T or
        // 10GBASE-LR", not "Gi0/1 or Gi0/2". The port pairs are the detail underneath.
        const mediaIds = v.media && v.media.length ? v.media : [];
        const id = v.mediaId || mediaIds.join('|') || 'link';
        const key = id + '@' + (v.speedMbps || 0);
        let group = byKey.get(key);
        if (!group) {
          const m = media.mediaById(v.mediaId || mediaIds[0]);
          group = {
            id: id,
            key: key,
            media: mediaIds,
            mediaId: v.mediaId || null,
            mediaName: m ? m.name : (v.mediaId || id),
            family: m ? m.family : null,
            speedMbps: v.speedMbps || (m ? m.speedMbps : null) || null,
            maxRangeM: m ? m.maxRangeM : null,
            warnings: v.warnings || [],
            pairs: []
          };
          byKey.set(key, group);
        }
        group.pairs.push({
          a: { iface: ai.name, cage: ai.hardware && ai.hardware.cage, label: ai.label || ai.name },
          b: { iface: bi.name, cage: bi.hardware && bi.hardware.cage, label: bi.label || bi.name }
        });
      }
    }

    const options = Array.from(byKey.values());
    // Fastest first: the link a person wants is usually the best one available. On a tie,
    // copper before fibre - a DAC or a patch lead is what most labs actually have.
    options.sort(function (x, y) {
      const sx = x.speedMbps || 0, sy = y.speedMbps || 0;
      if (sx !== sy) return sy - sx;
      const fx = x.family === 'copper' ? 0 : 1, fy = y.family === 'copper' ? 0 : 1;
      if (fx !== fy) return fx - fy;
      return x.mediaName.localeCompare(y.mediaName);
    });
    for (const opt of options) opt.ports = opt.pairs.length;

    if (!options.length) {
      // "No cable fits" is a diagnosis, not a shrug. Two very different situations arrive
      // here and must not be reported as the same thing: nothing was even attempted because
      // every port already has a cable ("no free ports" - unplug something), versus pairs
      // were tried and the hardware refused them (a connector or medium problem).
      const freeA = free(a).length, freeB = free(b).length;
      const tried = Object.keys(refusals).reduce(function (n, k) { return n + refusals[k]; }, 0);

      if (!freeA || !freeB) {
        const which = !freeA && !freeB ? 'both devices have'
          : (!freeA ? a.name : b.name) + ' has';
        return {
          ok: false,
          code: 'E_NO_FREE_PORTS',
          reason: which + ' no free port to cable (' + a.name + ': ' + freeA +
            ' free, ' + b.name + ': ' + freeB + ' free)',
          options: [],
          refused: 0,
          refusals: {},
          free: { a: freeA, b: freeB }
        };
      }

      const ranked = Object.keys(refusals).sort(function (x, y) { return refusals[y] - refusals[x]; });
      const top = ranked[0] || null;
      return {
        ok: false,
        code: top || 'E_NO_COMMON_MEDIA',
        reason: top
          ? 'no port pair on ' + a.name + ' and ' + b.name + ' can be cabled (' + top +
            (ranked.length > 1 ? ', among ' + ranked.length + ' reasons' : '') + ')'
          : 'no port pair on ' + a.name + ' and ' + b.name + ' can be cabled',
        options: [],
        refused: tried,
        refusals: refusals,
        free: { a: freeA, b: freeB }
      };
    }

    return {
      ok: true,
      a: { id: a.id, name: a.name, model: a.model, vendor: a.vendor },
      b: { id: b.id, name: b.name, model: b.model, vendor: b.vendor },
      options: options,
      refusals: refusals,
      free: { a: free(a).length, b: free(b).length }
    };
  }

  // Connect two interfaces. Validates the physical layer first and throws a
  // descriptive error (with .code and .issues) when the cabling is impossible.
  // `opts` may carry { mediaId, lengthM, duplex, lagId, force, patchCord }.
  // patchCord is a catalogue part number (a hybrid UPC/APC lead); omitted or null
  // means ordinary cable.
  connect(aId, aIface, bId, bIface, opts) {
    // Backwards compatibility: a bare string used to mean `type`.
    if (typeof opts === 'string') opts = { type: opts };
    opts = opts || {};

    const a = this.devices.get(aId);
    const b = this.devices.get(bId);
    if (!a) throw new Error('Unknown device: ' + aId);
    if (!b) throw new Error('Unknown device: ' + bId);
    // A caller may use the console spelling ('ether1'), an old lab file may predate a
    // catalogue rename, or it may type the panel name. All of them mean one socket
    // (issue #39), so resolve first and store the device's own name on the link.
    const aName = ifaceName.resolvePortName(a, aIface);
    const bName = ifaceName.resolvePortName(b, bIface);
    if (!aName) throw new Error('Unknown interface ' + aIface + ' on ' + aId);
    if (!bName) throw new Error('Unknown interface ' + bIface + ' on ' + bId);
    aIface = aName;
    bIface = bName;
    const ai = a.interfaces.get(aIface);
    const bi = b.interfaces.get(bIface);
    if (ai.peer) throw new Error(aId + '/' + aIface + ' is already connected');
    if (bi.peer) throw new Error(bId + '/' + bIface + ' is already connected');

    const verdict = this.validateLink(aId, aIface, bId, bIface, opts);
    if (!verdict.ok && !opts.force) {
      const err = new Error(verdict.errors.map(function (e) { return e.message; }).join(' '));
      err.code = verdict.errors[0] ? verdict.errors[0].code : 'E_LINK';
      err.issues = verdict.errors;
      throw err;
    }

    const mediaId = opts.mediaId || verdict.mediaId || null;
    // A link may carry its own id, so restoring a topology keeps the cable ids the
    // saved file used. Without this every save/load cycle renumbered the links, which
    // made a link id useless as a reference and inflated the sequence counter.
    let linkId;
    if (opts.id) {
      if (this.links.has(opts.id)) throw new Error('link id already in use: ' + opts.id);
      linkId = opts.id;
      this._advanceSeq(linkId);
    } else {
      do { linkId = 'l' + (this._seq++); } while (this.links.has(linkId));
    }
    const link = new Link(linkId, aId, aIface, bId, bIface, {
      // A cable can be loaded already down: the state is part of the lab, and a topology saved with
      // a failed link must not come back with every link up.
      state: opts.state || 'up',
      stateSinceMs: (opts.stateSinceMs === undefined) ? 0 : opts.stateSinceMs,
      type: 'media',
      mediaId: mediaId,
      speedMbps: opts.speedMbps || verdict.speedMbps || null,
      duplex: opts.duplex || 'full',
      lengthM: (opts.lengthM === undefined) ? null : opts.lengthM,
      lagId: opts.lagId || null,
      patchCord: opts.patchCord || verdict.patchCord || null
    });
    ai.peer = { deviceId: bId, iface: bIface };
    bi.peer = { deviceId: aId, iface: aIface };
    this.links.set(link.id, link);
    return link;
  }

  // Change how long a lead is, after the fact.
  //
  // Length belongs to the cable, not to the wiring job: you pull a longer run, or you find
  // out the 7 m you picked is really a 3 m part. Without this the only moment a length
  // could be set was while a cable was being created, so a link that already existed could
  // never be given one - and W_DISTANCE could never fire on a real over-length run.
  setLinkLength(linkId, lengthM) {
    const link = this.links.get(linkId);
    if (!link) {
      return { ok: false, errors: [{ code: 'E_NO_LINK', message: 'No such link: ' + linkId + '.' }], warnings: [] };
    }
    const length = (lengthM === null || lengthM === undefined || lengthM === '') ? null
      : Number(lengthM);
    if (length !== null && (!isFinite(length) || length <= 0)) {
      return {
        ok: false,
        errors: [{ code: 'E_BAD_LENGTH', message: 'A cable length must be a positive number of metres.' }],
        warnings: []
      };
    }
    // Re-run the full physical verdict with the new length, so a run that is now beyond
    // the medium's reach is reported the same way it would have been at cabling time.
    const verdict = this.validateLink(link.a.deviceId, link.a.iface, link.b.deviceId, link.b.iface, {
      mediaId: link.mediaId,
      lengthM: length,
      // This pair is already cabled to each other. Say so, or the port-in-use check
      // refuses to look at a cable that plainly exists.
      revalidate: this.revalidateFor(link.id)
    });
    if (!verdict.ok) return { ok: false, errors: verdict.errors, warnings: verdict.warnings || [] };
    link.lengthM = length;
    return { ok: true, link: link, warnings: verdict.warnings || [], errors: [] };
  }

  disconnect(linkId) {
    const link = this.links.get(linkId);
    if (!link) return false;
    const a = this.devices.get(link.a.deviceId);
    const b = this.devices.get(link.b.deviceId);
    if (a) {
      const i = a.interfaces.get(link.a.iface);
      if (i) i.peer = null;
      // Forget what LLDP learned on that port. The far end is gone, so a neighbour
      // entry left behind would be a lie the UI then shows as fact.
      if (a.lldp) a.lldp.delete(link.a.iface);
    }
    if (b) {
      const i = b.interfaces.get(link.b.iface);
      if (i) i.peer = null;
      if (b.lldp) b.lldp.delete(link.b.iface);
    }
    this.links.delete(linkId);
    return true;
  }

  removeDevice(id) {
    for (const [lid, link] of Array.from(this.links.entries())) {
      if (link.touches(id)) this.disconnect(lid);
    }
    // Where a device sat is part of the device. The server remembered to delete this and the engine did not, so a
    // removal from anywhere else - a script, a test, a future caller - left the position behind, and it was written
    // into the next save as a box that is not on the board (#1325).
    delete this.layout[id];
    return this.devices.delete(id);
  }

  // Map an interface's peer ref into a canonical {deviceId, iface} link record.
  serialize() {
    const devices = Array.from(this.devices.values()).map(function (d) { return d.serialize(); });
    const links = Array.from(this.links.values()).map(function (l) { return l.serialize(); });
    // The id sequence is part of the state. Omitting it meant a reloaded topology
    // restarted at d1 and its next addDevice() overwrote an existing device (#13).
    const out = {
      format: 'packetforge-topology', version: 1,
      seq: this._seq,
      devices: devices, links: links,
      // A copy, for the same reason link endpoints are copies (#1323): the document that goes out is what the API,
      // the UI and every fixture receives, and adjusting it must not adjust the board (#1325).
      layout: copyLayout(this.layout)
    };
    // `lastChangeAtMs` is deliberately NOT written. It is an instant in a run, and a run ends: a board reopened
    // tomorrow inherited an instant from a session that no longer exists and built its convergence schedule from it
    // (#1331). What survives is the thing that happened - a cable is down, and since when - and the clock is
    // derived from that on the way back in.
    return out;
  }

  static fromJSON(data) {
    const topo = new Topology();
    // What a document said that could not be restored, one entry per cable. A board that loses a cable used to do
    // it in silence: the link was skipped by a bare `catch`, so an imported lab came back one cable short and the
    // only way to find out was to count them (#1323).
    topo.loadIssues = [];
    // The board last changed when its newest cable fault happened; a lab that has been saved and reopened has no
    // other evidence, and an instant out of a dead run is not evidence. A document written before this rule can
    // still carry `lastChangeAtMs`, which is used only when no cable says anything (#1331).
    topo.lastChangeAtMs = Number(data.lastChangeAtMs) || 0;
    const devices = data.devices || [];
    // Two passes: create devices, then restore config/links.
    for (const d of devices) {
      const spec = {
        vendor: d.vendor, model: d.model, label: d.label, category: d.category,
        capabilities: d.capabilities,
        interfaces: (d.interfaces || []).filter(function (i) {
          return !i.parent;   // subinterfaces are rebuilt by Device.hydrate
        }).map(function (i) {
          // The whole port document, not four keys of it.
          //
          // `cage` was the first field found to be un-derivable (an OLT whose PON module is SC/UPC reloaded as
          // SC/APC from the port name alone). The same is true of every other physical fact the file states, and
          // narrowing to four keys silently dropped the rest: a combo port forgot its sibling, a 115.2 kbps console
          // came back as 1 Gbps, and 1,499 ports that declared their own PoE came back looking guessed (#1321).
          // Rebuilding a port from less than was saved is how a board stops being the lab it was.
          return Object.assign({}, i);
        })
      };
      const dev = Device.hydrate(d.id, spec, d);
      topo.devices.set(d.id, dev);
    }
    // An address a document states is either restored or explained, like a cable (#1413).
    //
    // `Device.hydrate` copies the port document through, which is right - it is the lab that was saved - but the
    // address on a port is the one field the engine has rules about, and a hand-written or older document can carry
    // a mask the console refuses. Adopting it meant state held a mask no door would accept, and `show
    // running-config` then printed `ip address 10.5.5.1 255.0.255.0`, a line the console itself refuses to type
    // back: a lab that cannot be replayed from its own configuration.
    //
    // So: a bare number is the old spelling of a prefix length and is rewritten to a dotted mask; anything that is
    // not a mask at all costs the port its address, and the document is told why.
    for (const dev of topo.devices.values()) {
      for (const iface of dev.interfaces.values()) {
        const issue = restoreAddress(iface);
        if (issue) topo.loadIssues.push(issue);
      }
    }

    // recompute MACs so they remain unique regardless of load order
    topo._macBase = 0x020000000000;
    for (const dev of topo.devices.values()) topo._assignMacs(dev);

    // Every cable a document describes is either restored or explained.
    for (const l of (data.links || [])) {
      const problem = cableProblem(l, topo);
      if (problem) {
        topo.loadIssues.push({ severity: 'error', linkId: l && l.id, code: problem.code, message: problem.message });
        continue;
      }
      // force: true so legacy topologies (no media info) still load.
      try {
        topo.connect(l.a.deviceId, l.a.iface, l.b.deviceId, l.b.iface, {
          id: l.id,
          mediaId: l.mediaId, speedMbps: l.speedMbps, duplex: l.duplex,
          lengthM: l.lengthM, lagId: l.lagId, type: l.type, force: true,
          // Absent in every topology saved before hybrid cords existed, which is
          // exactly what "ordinary fibre" means, so old files load unchanged.
          patchCord: l.patchCord,
          state: l.state || 'up',
          stateSinceMs: l.stateSinceMs
        });
      } catch (e) {
        // The cable cannot be made - a port the engine refuses, a cage already occupied - and it is reported
        // rather than dropped quietly.
        topo.loadIssues.push({ severity: 'error', linkId: l && l.id, code: 'E_LINK_NOT_RESTORED', message: e.message });
      }
    }
    // Where each box sits. Validated, because the canvas draws `pos.x` straight from here: a document with
    // `{"x": "left"}` put a device at NaN, and `layout: []` - an array is an object - kept the positions in memory
    // and then dropped them at the next save, because JSON.stringify of an array ignores its string keys (#1325).
    const layoutResult = readLayout(data.layout, topo.devices);
    topo.layout = layoutResult.layout;
    for (const issue of layoutResult.issues) topo.loadIssues.push(issue);

    // Restore the id sequence LAST, after the devices and links are in place.
    //
    // Doing it before the link loop was wrong: connect() allocates from the same
    // counter, so the sequence ended up ahead of the highest id by however many links
    // had just been restored. Harmless-looking (ids stay unique) but the counter no
    // longer means anything, and a file written before #13 has no `seq` field, so the
    // high-water mark must come from the ids actually present.
    let high = Number(data.seq) || 1;
    function note(id) {
      const m = /^[dl](\d+)$/.exec(String(id || ''));
      if (m) high = Math.max(high, Number(m[1]) + 1);
    }
    for (const d of devices) note(d.id);
    for (const l of (data.links || [])) note(l.id);
    for (const id of topo.devices.keys()) note(id);
    for (const id of topo.links.keys()) note(id);
    topo._seq = high;

    // The newest thing that happened to a cable is when this board last changed. A document that carried an
    // instant from an old run cannot outrank a cable that says it went down at 9000 ms.
    let newest = 0;
    for (const l of topo.links.values()) {
      if (typeof l.stateSinceMs === 'number' && isFinite(l.stateSinceMs) && l.stateSinceMs > newest) newest = l.stateSinceMs;
    }
    topo.lastChangeAtMs = newest || topo.lastChangeAtMs;
    return topo;
  }
}

// One port's address, as a document states it. Returns a load issue when the address cannot be used, or null when
// there was nothing to fix. `net` is required at the top of this file.
function restoreAddress(iface) {
  if (!iface || !iface.ip) return null;
  const where = { severity: 'error', port: iface.name, device: iface.deviceId };
  if (!net.isIp(String(iface.ip))) {
    where.code = 'E_IFACE_BAD_ADDRESS';
    where.message = 'port ' + iface.name + ': "' + iface.ip + '" is not an IPv4 address, so the port has no address';
    iface.ip = null;
    iface.mask = null;
    return where;
  }
  const mask = iface.mask;
  if (mask === null || mask === undefined || mask === '') {
    where.code = 'E_IFACE_NO_MASK';
    where.message = 'port ' + iface.name + ': ' + iface.ip + ' has no mask, so the port has no address';
    iface.ip = null;
    iface.mask = null;
    return where;
  }
  const text = String(mask).trim();
  // The old spelling: `ip address 10.5.5.1 24` stored "24" before one spelling was settled on.
  if (/^\d{1,2}$/.test(text) && Number(text) <= 32) {
    iface.mask = net.maskFromPrefix(Number(text));
    return null;
  }
  if (!net.isContiguousMask(text)) {
    where.code = 'E_IFACE_BAD_MASK';
    where.message = 'port ' + iface.name + ': ' + iface.ip + ' ' + text +
      ' is not a mask (a netmask is a run of ones then zeros), so the port has no address';
    iface.ip = null;
    iface.mask = null;
    return where;
  }
  iface.mask = text;
  return null;
}

module.exports = { Topology, expandInterfaces, isPosition, positionProblem, WORLD_LIMIT };
