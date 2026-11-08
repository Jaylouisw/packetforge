'use strict';
// topology.js -- a container of devices + links, with (de)serialization.
const { Device } = require('./device');
const { Link } = require('./link');
const media = require('./media');
const ifaceName = require('./iface-name');
const net = require('./net');

// Expand a device spec's interfaces into a flat list. A spec may provide an
// explicit `interfaces` array, a `portTemplate` (N generated ports), or BOTH —
// in which case generated ports come first, then the explicit ones (so a spec
// can describe "24x RJ45 + 2x SFP+" compactly).
function expandInterfaces(spec) {
  const out = [];
  if (spec.portTemplate) {
    const t = spec.portTemplate;
    const prefix = t.prefix || 'eth';
    const start = (t.start === undefined || t.start === null) ? 1 : t.start;
    const count = (t.count === undefined || t.count === null) ? 1 : t.count;
    const type = t.type || 'ethernet';
    const speed = t.speed || '1G';
    // carry explicit hardware hints (cage / media / PoE) onto every port
    const extra = {};
    for (const k of ['cage', 'connector', 'media', 'supportedMedia', 'speedCaps', 'poeOut', 'poeIn', 'hardware']) {
      if (t[k] !== undefined) extra[k] = t[k];
    }
    for (let i = 0; i < count; i++) {
      out.push(Object.assign({ name: prefix + (start + i), type: type, speed: speed }, extra));
    }
  }
  if (Array.isArray(spec.interfaces)) {
    for (const s of spec.interfaces) out.push(Object.assign({}, s));
  }
  if (!out.length) out.push({ name: 'eth0', type: 'ethernet', speed: '1G' });
  return out;
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

  addDevice(spec, id) {
    const fullSpec = Object.assign({}, spec, { interfaces: expandInterfaces(spec) });
    if (id) {
      // An explicit id that is already taken used to overwrite the existing device
      // without a word. Losing a device because two callers picked the same name is
      // not something a simulator should do quietly.
      if (this.devices.has(id)) throw new Error('device id already in use: ' + id);
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

    if (V && typeof V.validateConnection === 'function') {
      return V.validateConnection({
        portA: ai && ai.hardware,
        portB: bi && bi.hardware,
        ifaceA: ai,
        ifaceB: bi,
        // A caller that is re-checking an existing cable says which pair it is, so the
        // port-in-use rule does not refuse a cable that is plainly there.
        revalidate: opts.revalidate || null,
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
      // refuses to look at a cable that plainly exists. Each entry names the PEER of
      // that side, because the rule is "is this port already connected to the port I am
      // validating against".
      revalidate: {
        a: { deviceId: link.b.deviceId, iface: link.b.iface },
        b: { deviceId: link.a.deviceId, iface: link.a.iface }
      }
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
      devices: devices, links: links, layout: this.layout
    };
    // Only when a change has happened: a lab built and never disturbed has nothing to say about it,
    // and a field on every saved file is noise in every diff and every regenerated example.
    if (this.lastChangeAtMs) out.lastChangeAtMs = this.lastChangeAtMs;
    return out;
  }

  static fromJSON(data) {
    const topo = new Topology();
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
          // `cage` is saved (see Device.serialize) because it is physical hardware,
          // not something to re-derive: an OLT whose PON module is SC/UPC would
          // otherwise reload as SC/APC from the port name alone, and its hybrid
          // cord would look like it was joining two APC ports.
          return { name: i.name, type: i.type, speed: i.speed, cage: i.cage };
        })
      };
      const dev = Device.hydrate(d.id, spec, d);
      topo.devices.set(d.id, dev);
    }
    // recompute MACs so they remain unique regardless of load order
    topo._macBase = 0x020000000000;
    for (const dev of topo.devices.values()) topo._assignMacs(dev);

    for (const l of (data.links || [])) {
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
        // Skip links that can no longer be made (device/port removed).
      }
    }
    topo.layout = (data.layout && typeof data.layout === 'object') ? data.layout : {};

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

    return topo;
  }
}

module.exports = { Topology, expandInterfaces };
