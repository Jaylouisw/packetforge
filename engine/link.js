'use strict';
// link.js -- a physical link (cable / optic / DAC) between two interfaces.
//
// The Link carries the *physical* description of the connection: which medium
// was chosen, the negotiated line rate, duplex and the operational state.
// L2 configuration (VLANs) lives on the Interface, not here.

class Link {
  constructor(id, aDeviceId, aIface, bDeviceId, bIface, opts) {
    this.id = id;
    this.a = { deviceId: aDeviceId, iface: aIface };
    this.b = { deviceId: bDeviceId, iface: bIface };

    // Backwards compatibility: callers used to pass a bare type string
    // ('copper'); they may now pass an options object.
    let o;
    if (typeof opts === 'string' || opts === undefined || opts === null) {
      o = { type: opts || 'copper' };
    } else {
      o = opts;
    }

    this.type = o.type || 'media';        // legacy label, kept for old topologies
    this.mediaId = o.mediaId || null;     // e.g. '1000base-t', '10gbase-sr', 'dac-10g'
    this.speedMbps = (o.speedMbps === undefined) ? null : o.speedMbps;
    this.duplex = o.duplex || 'full';
    this.lengthM = (o.lengthM === undefined) ? null : o.lengthM;
    this.lagId = o.lagId || null;
    // The patch cord actually installed, by catalogue part number (e.g. the FS
    // SMSCSX hybrid SC/UPC-to-SC/APC lead). null means ordinary fibre: a saved
    // topology that predates this field loads as plain cable, and a link that
    // never mentions a cord is not charged one.
    this.patchCord = o.patchCord || null;
    this.state = o.state || 'up';         // 'up' | 'down' | 'blocked' (STP)
    // When this state last changed. A cable that was pulled at t=10 s is still pulled at t=41 s,
    // and every later question has to know when it happened to say whether the network has
    // finished reacting to it.
    // A timestamp that is not a number is not a time. `Number('soon')` is NaN, which serialises as null and
    // compares false against everything, so a cable would claim it changed "not at any known time" (#1323).
    const since = (o.stateSinceMs === undefined || o.stateSinceMs === null) ? 0 : Number(o.stateSinceMs);
    this.stateSinceMs = isFinite(since) ? since : 0;
  }

  // The endpoint record matching (deviceId, iface), or null.
  endpoint(deviceId, iface) {
    if (this.a.deviceId === deviceId && this.a.iface === iface) return this.a;
    if (this.b.deviceId === deviceId && this.b.iface === iface) return this.b;
    return null;
  }

  otherEndpoint(deviceId, iface) {
    if (this.a.deviceId === deviceId && this.a.iface === iface) return this.b;
    if (this.b.deviceId === deviceId && this.b.iface === iface) return this.a;
    return null;
  }

  touches(deviceId) {
    return this.a.deviceId === deviceId || this.b.deviceId === deviceId;
  }

  isUp() { return this.state === 'up'; }

  serialize() {
    const out = {
      id: this.id,
      // Copies, not the live endpoint records. `serialize()` is what the API hands out and what the UI, the
      // example builder and every test fixture receives; a caller that adjusts the document it was given must not
      // be adjusting the board (#1323).
      a: { deviceId: this.a.deviceId, iface: this.a.iface },
      b: { deviceId: this.b.deviceId, iface: this.b.iface },
      type: this.type,
      mediaId: this.mediaId,
      speedMbps: this.speedMbps,
      duplex: this.duplex,
      lengthM: this.lengthM,
      lagId: this.lagId,
      patchCord: this.patchCord,
      state: this.state
    };
    // Only for a cable that is not up: an up link at t=0 is the default and does not need a field,
    // and adding one to every saved lab would be noise in every diff.
    if (this.state !== 'up' || this.stateSinceMs) out.stateSinceMs = this.stateSinceMs;
    return out;
  }
}

module.exports = { Link };
