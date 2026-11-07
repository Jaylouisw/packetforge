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
    this.state = o.state || 'up';         // 'up' | 'down' | 'blocked' (STP)
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
    return {
      id: this.id,
      a: this.a,
      b: this.b,
      type: this.type,
      mediaId: this.mediaId,
      speedMbps: this.speedMbps,
      duplex: this.duplex,
      lengthM: this.lengthM,
      lagId: this.lagId,
      state: this.state
    };
  }
}

module.exports = { Link };
