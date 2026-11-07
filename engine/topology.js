'use strict';
// topology.js -- a container of devices + links, with (de)serialization.
const { Device } = require('./device');
const { Link } = require('./link');
const media = require('./media');
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
        devA: a,
        devB: b,
        mediaId: opts.mediaId,
        lengthM: opts.lengthM,
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
      mediaId: verdict.ok ? media.preferredMedia(verdict.media) : null,
      speedMbps: verdict.speedMbps || null
    };
  }

  // Media a user could pick between two ports (for the UI's link picker).
  mediaOptions(aId, aIface, bId, bIface) {
    const a = this.devices.get(aId);
    const b = this.devices.get(bId);
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

  // Connect two interfaces. Validates the physical layer first and throws a
  // descriptive error (with .code and .issues) when the cabling is impossible.
  // `opts` may carry { mediaId, lengthM, duplex, lagId, force }.
  connect(aId, aIface, bId, bIface, opts) {
    // Backwards compatibility: a bare string used to mean `type`.
    if (typeof opts === 'string') opts = { type: opts };
    opts = opts || {};

    const a = this.devices.get(aId);
    const b = this.devices.get(bId);
    if (!a) throw new Error('Unknown device: ' + aId);
    if (!b) throw new Error('Unknown device: ' + bId);
    const ai = a.interfaces.get(aIface);
    const bi = b.interfaces.get(bIface);
    if (!ai) throw new Error('Unknown interface ' + aIface + ' on ' + aId);
    if (!bi) throw new Error('Unknown interface ' + bIface + ' on ' + bId);
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
      type: 'media',
      mediaId: mediaId,
      speedMbps: opts.speedMbps || verdict.speedMbps || null,
      duplex: opts.duplex || 'full',
      lengthM: (opts.lengthM === undefined) ? null : opts.lengthM,
      lagId: opts.lagId || null
    });
    ai.peer = { deviceId: bId, iface: bIface };
    bi.peer = { deviceId: aId, iface: aIface };
    this.links.set(link.id, link);
    return link;
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
    return {
      format: 'packetforge-topology', version: 1,
      seq: this._seq,
      devices: devices, links: links, layout: this.layout
    };
  }

  static fromJSON(data) {
    const topo = new Topology();
    const devices = data.devices || [];
    // Two passes: create devices, then restore config/links.
    for (const d of devices) {
      const spec = {
        vendor: d.vendor, model: d.model, label: d.label, category: d.category,
        capabilities: d.capabilities,
        interfaces: (d.interfaces || []).filter(function (i) {
          return !i.parent;   // subinterfaces are rebuilt by Device.hydrate
        }).map(function (i) {
          return { name: i.name, type: i.type, speed: i.speed };
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
          lengthM: l.lengthM, lagId: l.lagId, type: l.type, force: true
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
