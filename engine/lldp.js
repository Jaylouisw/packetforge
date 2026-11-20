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
// The other two numbers `show lldp` prints, and the reason they live here rather than in the printer: they are the
// protocol's defaults, not a layout choice. IOS sends an LLDPDU every 30 s and advertises 30 x 4 = 120 s as its TTL
// (`lldp timer` 30, `lldp holdtime` 120, reinit delay 2 - the same three defaults across 12.2 and 17.x). The model
// announces once, at the start of a run, so the interval is not a timer it keeps; it is the value the protocol is
// documented to use, and the status view is the only place it is visible.
const DEFAULT_TX_INTERVAL_S = 30;
const DEFAULT_REINIT_DELAY_S = 2;

// The System Capabilities TLV (type 7): two 2-byte bitmaps, "system" and "enabled", in one TLV. IEEE 802.1AB-2016
// Table 8-4 fixes the bits; Cisco's `show lldp neighbors` legend fixes the letters and their order, and the brief
// table prints the letters of the *system* bitmap in bit order, comma-separated (`B,R`). The two vocabularies are
// joined here once, so the wire and the printer cannot disagree about what a switch advertised.
//
// What a device advertises is decided by its own catalogue entry, not by its vendor: every PacketForge device
// already declares `capabilities` (`l2-forward`, `l3-forward`, `host`, ...), and those are the same facts a real
// LLDPDU's bitmap carries at the coarsest level - a bridge forwards layer 2, a router forwards layer 3, an end
// station does neither. The mapping below is therefore a translation, not a guess:
//
//   host          -> Station (S), and nothing else: an end station is not a bridge or a router
//   l2-forward    -> Bridge (B)
//   l3-forward    -> Router (R)   (so an L3 switch is `B,R`, which is what a Catalyst with `ip routing` sends)
//   neither       -> 0, printed as an empty Capability cell, which the capture in
//                    research/show-lldp-neighbors-columns.md shows a real IOS box printing for a neighbour that
//                    advertised no capabilities TLV
//
// Only S, B and R are ever emitted. The legend always lists all eight letters because a box prints the whole
// legend whatever its neighbours say; W (an AP), T (a telephone), C (a cable device), P (a repeater) and
// O (other) have no device in this catalogue that announces them, and inventing one from a model name would be
// the sort of guess this project does not print.
const LLDP_CAP_BITS = [
  { bit: 0x0001, letter: 'O' },
  { bit: 0x0002, letter: 'P' },
  { bit: 0x0004, letter: 'B' },
  { bit: 0x0008, letter: 'W' },
  { bit: 0x0010, letter: 'R' },
  { bit: 0x0020, letter: 'T' },
  { bit: 0x0040, letter: 'C' },
  { bit: 0x0080, letter: 'S' }
];

function capabilityMask(dev) {
  const has = function (cap) {
    return !!(dev && typeof dev.hasCap === 'function' && dev.hasCap(cap));
  };
  if (has('host')) return 0x0080;                       // Station only
  let mask = 0;
  if (has('l2-forward')) mask |= 0x0004;                // Bridge
  if (has('l3-forward')) mask |= 0x0010;                // Router
  return mask;
}

function capabilityLetters(mask) {
  return LLDP_CAP_BITS.filter(function (c) { return (mask & c.bit) !== 0; })
    .map(function (c) { return c.letter; }).join(',');
}

// Build the Ethernet frame a device sends out of one port.
function buildFrame(dev, iface, opts) {
  const o = opts || {};
  const chassisId = iface.mac || (dev.mac || null);
  const systemName = o.systemName ||
    (dev.config && dev.config.hostname) ||
    dev.name || dev.label || dev.model || dev.id;
  // How many bytes the LLDPDU actually puts on the wire, from the TLVs it is made of: two header bytes
  // per TLV plus its value. Interface counters count LLDP, and a counted packet that reports zero bytes
  // reads as a modelling gap (#1251).
  const tlv = function (len) { return 2 + Number(len || 0); };
  const portDescText = describePort(iface);
  const payloadBytes = tlv(1 + 6)                                  // chassis id: subtype + MAC
    + tlv(1 + String(iface.name).length)                           // port id: subtype + name
    + tlv(2)                                                       // ttl
    + tlv(portDescText ? String(portDescText).length : 0)
    + tlv(String(systemName).length)
    + tlv(dev.model ? String(dev.model).length : 0)
    + tlv(4)                                                       // system capabilities: two 2-byte bitmaps
    + (iface.ip ? tlv(1 + 1 + 4 + 1 + 2) : 0)                      // management address (IPv4)
    + 2;                                                           // end of LLDPDU
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
      // The System Capabilities TLV's two bitmaps. A device enables everything it supports, which is what the
      // second bitmap means; the brief table prints the first.
      capabilities: capabilityLetters(capabilityMask(dev)),
      capabilityMask: capabilityMask(dev),
      ttl: o.ttl || DEFAULT_TTL_S,
      // The cage/rate is what a real neighbour entry shows in the port description.
      cage: (iface.hardware && iface.hardware.cage) || null,
      speedMbps: (iface.hardware && iface.hardware.maxSpeedMbps) || null,
      bytes: payloadBytes
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
// serializes straight into the topology state and reaches the UI unchanged - which is also why the instant it was
// heard is *not* one of its fields: a clock reading is not something the far end advertised, and a saved lab that
// carried one would age a neighbour against a clock that has since started again. The receiving device keeps that
// instant beside the record (`Device.lldpSeenAt`), the way `arpSeenAt` sits beside the ARP cache.
//
// The TTL it does carry is the sender's own word on how long it may be kept. IEEE 802.1AB defines the Time To Live
// TLV as "the number of seconds that the recipient LLDP agent is to regard the information associated with this
// MSAP identifier to be valid" (8.5.4), and the information is discarded when that lapses without a refresh; Cisco
// ships the same rule as `lldp timer` 30 s and `lldp holdtime` 120 s, and its `Hold-time` column repeats that
// advertised number. The countdown is a different field - `Time remaining` in the detail view - and the
// evidence for that split is in research/lldp-hold-time-column.md.
//
// A TTL of 0 is not "unset": 802.1AB-2016 §8.5.4.1 uses it to say the whole MSAP identifier is no longer valid
// (the port is shutting down), so it is kept as 0 rather than replaced by the default, and the table drops the
// entry at once. `|| DEFAULT_TTL_S` turned that signal into a 120-second claim, which is the opposite meaning.
function neighbourFrom(frame, receivedOn) {
  const l = frame.lldp || {};
  const ttl = Number(l.ttl);
  return {
    chassisId: l.chassisId || frame.srcMac || null,
    portId: l.portId || null,
    portDesc: l.portDesc || null,
    systemName: l.systemName || null,
    systemDesc: l.systemDesc || null,
    mgmtIp: l.mgmtIp || null,
    // Letters, as the box's brief table prints them. A neighbour whose LLDPDU carried no capabilities TLV -
    // or one this model cannot map - stores an empty string, and the column prints blank rather than `?`.
    capabilities: (typeof l.capabilities === 'string') ? l.capabilities : '',
    cage: l.cage || null,
    speedMbps: l.speedMbps || null,
    ttl: (l.ttl === undefined || l.ttl === null || !Number.isFinite(ttl)) ? DEFAULT_TTL_S : ttl,
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
  DEFAULT_TX_INTERVAL_S: DEFAULT_TX_INTERVAL_S,
  DEFAULT_REINIT_DELAY_S: DEFAULT_REINIT_DELAY_S,
  buildFrame: buildFrame,
  describePort: describePort,
  capabilityMask: capabilityMask,
  capabilityLetters: capabilityLetters,
  LLDP_CAP_BITS: LLDP_CAP_BITS,
  isLldp: isLldp,
  neighbourFrom: neighbourFrom
};
