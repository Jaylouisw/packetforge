'use strict';
// link.js — a physical link between two device interfaces.

class Link {
  constructor(id, aDeviceId, aIface, bDeviceId, bIface, type) {
    this.id = id;
    this.a = { deviceId: aDeviceId, iface: aIface };
    this.b = { deviceId: bDeviceId, iface: bIface };
    this.type = type || 'copper';
  }

  otherEndpoint(deviceId, iface) {
    if (this.a.deviceId === deviceId && this.a.iface === iface) return this.b;
    if (this.b.deviceId === deviceId && this.b.iface === iface) return this.a;
    return null;
  }

  touches(deviceId) {
    return this.a.deviceId === deviceId || this.b.deviceId === deviceId;
  }

  serialize() {
    return { id: this.id, a: this.a, b: this.b, type: this.type };
  }
}

module.exports = { Link };
