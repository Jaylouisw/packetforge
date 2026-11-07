'use strict';
// LLDP: the protocol that exists to answer "what is plugged into this port".
//
// On real hardware you do not guess which socket a cable runs to - you read the
// neighbour table, and it is LLDP that filled it in. Modelling it here means the
// simulator can tell you the same thing, and it is the honest counterpart to the port
// labels in the UI: the labels come from the spec, the neighbour comes from a frame
// that actually crossed the link.
//
// LLDPDUs are sent to the "nearest bridge" multicast address, which by definition is
// NOT forwarded by a bridge. That is the whole point: the frame carries one hop and
// dies. A simulator that flooded it would invent neighbours that do not exist.
const LLDP_MULTICAST = '01:80:c2:00:00:0e';
const ETH_LLDP = 0x88cc;
const DEFAULT_TTL_S = 120;

// Build the Ethernet frame a device sends out of one port.
function buildFrame(dev, iface, opts) {
  const o = opts || {};
  const chassisId = iface.mac || (dev.mac || null);
  const systemName = o.systemName ||
    (dev.config && dev.config.hostname) ||
    dev.name || dev.label || dev.model || dev.id;
  return {
    srcMac: iface.mac,
    dstMac: LLDP_MULTICAST,
    etherType: ETH_LLDP,
    type: 'lldp',
    lldp: {
      chassisId: chassisId,
      portId: iface.name,
      portDesc: describePort(iface),
      systemName: systemName,
      systemDesc: dev.model || null,
      mgmtIp: iface.ip || null,
      ttl: o.ttl || DEFAULT_TTL_S,
      // The cage/rate is what a real neighbour entry shows in the port description.
      cage: (iface.hardware && iface.hardware.cage) || null,
      speedMbps: (iface.hardware && iface.hardware.maxSpeedMbps) || null
    }
  };
}

function describePort(iface) {
  const hw = iface.hardware || {};
  const bits = [];
  if (hw.cage) bits.push(hw.cage);
  if (hw.maxSpeedMbps) bits.push(hw.maxSpeedMbps >= 1000 ? (hw.maxSpeedMbps / 1000) + 'G' : hw.maxSpeedMbps + 'M');
  return bits.length ? bits.join(' ') : (iface.name || 'port');
}

function isLldp(frame) {
  return !!frame && (frame.etherType === ETH_LLDP || frame.type === 'lldp');
}

// The neighbour record a receiving port stores. Deliberately a plain object so it
// serializes straight into the topology state and reaches the UI unchanged.
function neighbourFrom(frame, receivedOn) {
  const l = frame.lldp || {};
  return {
    chassisId: l.chassisId || frame.srcMac || null,
    portId: l.portId || null,
    portDesc: l.portDesc || null,
    systemName: l.systemName || null,
    systemDesc: l.systemDesc || null,
    mgmtIp: l.mgmtIp || null,
    cage: l.cage || null,
    speedMbps: l.speedMbps || null,
    ttl: l.ttl || DEFAULT_TTL_S,
    // Which of *our* ports heard it. Kept on the record so a table can be printed
    // without walking the device.
    localPort: receivedOn || null,
    via: 'lldp'
  };
}

module.exports = {
  LLDP_MULTICAST: LLDP_MULTICAST,
  ETH_LLDP: ETH_LLDP,
  DEFAULT_TTL_S: DEFAULT_TTL_S,
  buildFrame: buildFrame,
  describePort: describePort,
  isLldp: isLldp,
  neighbourFrom: neighbourFrom
};
