'use strict';
// latency.js -- how long a packet is actually on the wire.
//
// A ping in this simulator used to return in zero time: the reported "rtt" was the
// number of queue steps the run took, which is a hop count wearing the name of a
// time. Nothing in the model knew that a 40 km fibre span is slower than a 1 m
// patch lead, that a 100 Mbps port takes eighty times longer than a 10 Gbps port
// to put the same 102-byte frame on the wire, or that every switch in the path
// costs something. Those three things are what a network engineer measures first,
// so they belong in the model, not in a footnote.
//
// The delay of one link crossing is the sum of two real, computable terms:
//
//   propagation   = length / (velocity factor * c)      -- time in the medium
//   serialisation = bits / link rate                    -- time to clock the frame out
//
// and the delay of a path adds one store-and-forward term per device the frame
// passes through. Nothing here is a mystery constant except the store-and-forward
// figure, which is marked as an approximation wherever it is used (see
// SWITCH_DELAY_S below).
//
// Deliberately NOT modelled, because pretending to know them would be worse than
// saying nothing:
//   * queueing delay -- there is no congestion in this simulator (no shared
//     medium contention, no egress buffers), so there is no queue to wait behind
//   * jitter -- a number with no distribution is a lie dressed as realism
//   * host ICMP processing, NIC interrupts, kernel wakeups, ARP (the echo request
//     is timed from the moment the frame is handed to the first port)
//   * optical dispersion / FEC latency (a 400G-R4 pilot adds ~100 ns of RS-FEC;
//     small next to a 50 us store-and-forward hop, and indistinguishable from it)
//
// Everything in this file is pure: numbers in, numbers out, no timers, no async,
// no dependency on Device or Topology. That is what makes it unit-testable and
// what keeps the engine event loop untouched.

const mediaModel = require('./media');

// ---------------------------------------------------------------------------
// Constants, and where they come from
// ---------------------------------------------------------------------------

// Speed of light in vacuum, exact by definition (CGPM 1983, the metre is the
// length of the path travelled by light in vacuum in 1/299792458 s).
const C_M_PER_S = 299792458;

// Velocity factor: the fraction of c at which a signal travels in a medium,
// v = vf * c. Equivalently, the reciprocal of the medium's group refractive
// index at the signalling frequency, vf = 1/n_eff.
//
//   copper     0.66  Twisted-pair NVP is quoted by cable makers as 0.64-0.68
//                    (Cat5e/Cat6 datasheets: "NVP 69%", "NVP 0.66"), and
//                    1000BASE-T link-delay budgets are built on ~5.7 ns/m.
//                    0.66c = 5.05 ns/m.
//   fiber      0.68  Silica group index is 1.467 at 1310 nm and 1.468 at 1550 nm
//                    (ITU-T G.652), so vf = 1/1.468 = 0.681. Fibre is quoted at
//                    5 ns/m; 0.68c = 4.91 ns/m. Note fibre and copper are NOT
//                    the same speed -- that is the point of the test.
//   coax       0.77  Foam-dielectric HFC/MoCA plant, vf 0.77-0.87 depending on
//                    dielectric; hardline is nearer the top of that range. 0.77 is
//                    the conservative (slower, longer-delay) end.
//   dac        0.70  Twinax is quoted at ~4.5-5 ns/m in passive-cable datasheets
//                    (4.76 ns/m at 0.70c).
//   wireless   1.00  Free space, by definition. (Air's refractive index is
//                    1.0003; that is 0.03% and is not modelled.)
//   dsl        0.66  xDSL rides the same twisted pair as copper.
//   powerline  0.60  G.hn/HomePlug over mains cable: dielectric and topology
//                    dependent, ~0.5-0.7c in practice. A house estimate, labelled
//                    as one.
//   console    0.66  RS-232 in a cable; irrelevant to a ping, kept for completeness.
const VELOCITY_FACTOR = {
  copper: 0.66,
  fiber: 0.68,
  coax: 0.77,
  dac: 0.70,
  wireless: 1.0,
  dsl: 0.66,
  powerline: 0.60,
  console: 0.66
};

// Used only when a media id is not in the catalogue at all. Deliberately NOT the
// fastest (wireless) or the slowest (powerline) option: copper is the default
// physical layer of this simulator.
const DEFAULT_VELOCITY_FACTOR = 0.66;

// Store-and-forward delay per device, seconds.
//
// THIS IS AN APPROXIMATION, NOT A MEASURED FIGURE. 50 us is a round order-of-
// magnitude for a store-and-forward Gigabit switch under no load: it has to
// receive the whole frame before it forwards it, which is already counted as
// serialisation above, and then spends a few tens of microseconds on parse,
// lookup, ACL/TCAM evaluation and egress queueing. Published vendor latency
// figures for 1G access switches sit roughly between 5 us (cut-through, small
// frames) and 100 us; a router with a software data plane is worse. One number
// for every device in the model is the honest compromise: it makes hops cost
// something proportional to hop count without pretending to know which ASIC is
// fitted. Override with `processingS` when a caller knows better.
const SWITCH_DELAY_S = 50e-6;

// An unstated length is UNKNOWN, not zero-metres-and-therefore-instant, and it is
// certainly not the medium's maximum reach (that would invent a 40 km run for
// every unlabelled fibre lead in the lab). The documented behaviour is: treat the
// physical length as 0 m -- i.e. charge serialisation only -- and report
// lengthKnown:false so a caller can say "distance unknown" instead of quoting a
// number it does not have.
const DEFAULT_LENGTH_M = 0;

// Ethernet framing on the wire, in bytes. The frame counted is the L2 frame from
// the destination MAC to the FCS: 14 header + 4 FCS. The 8-byte preamble/SFD and
// the 12-byte inter-frame gap are not counted; they add 20 bytes, which is
// 0.16 us at 1 Gbps and 1.6 us at 100 Mbps.
const ETH_HEADER_BYTES = 14;
const ETH_FCS_BYTES = 4;
const VLAN_TAG_BYTES = 4;
const IPV4_HEADER_BYTES = 20;
const ICMP_HEADER_BYTES = 8;

// What `ping` sends by default: 56 data bytes, the classic figure that makes a
// 64-byte ICMP message and a 84-byte IP packet.
const DEFAULT_PING_PAYLOAD_BYTES = 56;

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function isKnownLength(lengthM) {
  if (lengthM === null || lengthM === undefined || lengthM === '') return false;
  const n = Number(lengthM);
  return isFinite(n) && n >= 0;
}

function isKnownRate(speedMbps) {
  if (speedMbps === null || speedMbps === undefined || speedMbps === '') return false;
  const n = Number(speedMbps);
  return isFinite(n) && n > 0;
}

// The catalogue's family for a media id ('copper', 'fiber', 'wireless', ...).
function familyOf(mediaId) {
  const m = mediaId ? mediaModel.mediaById(mediaId) : null;
  return (m && m.family) || null;
}

function velocityFactor(mediaId) {
  const fam = familyOf(mediaId);
  if (fam && VELOCITY_FACTOR[fam] !== undefined) return VELOCITY_FACTOR[fam];
  return DEFAULT_VELOCITY_FACTOR;
}

// Signal velocity in the medium, m/s.
function velocityMperS(mediaId) {
  return velocityFactor(mediaId) * C_M_PER_S;
}

// Propagation delay for a length of a given medium, seconds.
// Unknown length -> 0 s (see DEFAULT_LENGTH_M), never a guessed distance.
function propagationDelayS(leg) {
  const l = leg || {};
  if (!isKnownLength(l.lengthM)) return 0;
  return Number(l.lengthM) / velocityMperS(l.mediaId);
}

// Serialisation delay: time to clock `bits` onto the wire at `speedMbps`.
// Unknown rate -> 0 s: a rate nobody stated cannot be charged a time.
function serialisationDelayS(leg) {
  const l = leg || {};
  if (!isKnownRate(l.speedMbps)) return 0;
  const bits = Number(l.bits);
  if (!isFinite(bits) || bits <= 0) return 0;
  return bits / (Number(l.speedMbps) * 1e6);
}

// Store-and-forward delay for the devices charged to this leg.
function processingDelayS(leg) {
  const l = leg || {};
  const hops = Number(l.hops);
  if (!isFinite(hops) || hops <= 0) return 0;
  const per = (l.processingS === undefined || l.processingS === null)
    ? SWITCH_DELAY_S : Number(l.processingS);
  return hops * (isFinite(per) && per > 0 ? per : 0);
}

// Bits an ICMP echo frame puts on the wire: Ethernet header + FCS, IPv4, ICMP and
// the payload. `opts.vlan` adds the 802.1Q tag, which is four real bytes of
// transmission time on every link of a tagged path.
function pingFrameBits(payloadBytes, opts) {
  const o = opts || {};
  const payload = (payloadBytes === undefined || payloadBytes === null)
    ? DEFAULT_PING_PAYLOAD_BYTES : Number(payloadBytes);
  const bytes = ETH_HEADER_BYTES + ETH_FCS_BYTES + IPV4_HEADER_BYTES + ICMP_HEADER_BYTES +
    (isFinite(payload) && payload > 0 ? payload : 0) +
    (o.vlan ? VLAN_TAG_BYTES : 0);
  return bytes * 8;
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

// Delay of ONE link crossing.
//
//   linkDelayS({ mediaId, lengthM, bits, hops })
//
//   mediaId  catalogue id of the medium ('1000base-t', '10gbase-lr', 'wireless-5')
//   lengthM  physical length of the lead in metres; null/undefined = unknown
//   bits     frame size on the wire in bits (see pingFrameBits)
//   hops     store-and-forward devices charged to this crossing (default 0)
//
// Returns seconds.
function linkDelayS(leg) {
  return propagationDelayS(leg) + serialisationDelayS(leg) + processingDelayS(leg);
}

// The same crossing, itemised, so a caller can explain the number instead of
// quoting it. `lengthKnown`/`rateKnown` are false when the input was unknown and
// a documented default was used -- the caller should then say "unknown", not
// print the default as if it were measured.
function linkDelayDetail(leg) {
  const l = leg || {};
  const propagationS = propagationDelayS(l);
  const serialisationS = serialisationDelayS(l);
  const processingS = processingDelayS(l);
  return {
    mediaId: l.mediaId || null,
    family: familyOf(l.mediaId),
    lengthM: isKnownLength(l.lengthM) ? Number(l.lengthM) : null,
    lengthKnown: isKnownLength(l.lengthM),
    bits: isFinite(Number(l.bits)) ? Number(l.bits) : 0,
    speedMbps: isKnownRate(l.speedMbps) ? Number(l.speedMbps) : null,
    rateKnown: isKnownRate(l.speedMbps),
    velocityFactor: velocityFactor(l.mediaId),
    velocityMperS: velocityMperS(l.mediaId),
    hops: isFinite(Number(l.hops)) && Number(l.hops) > 0 ? Number(l.hops) : 0,
    propagationS: propagationS,
    serialisationS: serialisationS,
    processingS: processingS,
    totalS: propagationS + serialisationS + processingS
  };
}

// Delay along ONE direction of a path: the sum over its link crossings.
//
//   pathDelayS([{ mediaId, lengthM, bits, hops }, ...])
//
// Returns seconds.
function pathDelayS(paths) {
  const legs = paths || [];
  let total = 0;
  for (let i = 0; i < legs.length; i++) total += linkDelayS(legs[i]);
  return total;
}

// The itemised sum for one direction, plus the totals a report wants.
function pathDelayDetail(paths) {
  const legs = paths || [];
  const detail = {
    links: legs.length,
    hops: 0,
    propagationS: 0,
    serialisationS: 0,
    processingS: 0,
    totalS: 0,
    lengthKnown: true,
    unknownLengthLinks: 0,
    unknownRateLinks: 0,
    legs: []
  };
  for (let i = 0; i < legs.length; i++) {
    const d = linkDelayDetail(legs[i]);
    detail.legs.push(d);
    detail.hops += d.hops;
    detail.propagationS += d.propagationS;
    detail.serialisationS += d.serialisationS;
    detail.processingS += d.processingS;
    detail.totalS += d.totalS;
    if (!d.lengthKnown) { detail.lengthKnown = false; detail.unknownLengthLinks++; }
    if (!d.rateKnown) detail.unknownRateLinks++;
  }
  // A path with no recorded link tells us nothing about distance; saying
  // "unknown" is the only honest answer.
  if (!legs.length) detail.lengthKnown = false;
  return detail;
}

// Round trip = out and back, each summed over its own legs. A ping's number is
// the sum of BOTH directions -- the frame crosses every link twice, at the same
// velocity, and is serialised at every port twice.
//
//   roundTripDelayS(forwardPaths, reversePaths) -> seconds
function roundTripDelayS(forwardPaths, reversePaths) {
  return pathDelayS(forwardPaths) + pathDelayS(reversePaths);
}

// The itemised round trip: totals across both directions, in seconds and in the
// milliseconds a real `ping` prints.
function roundTripDetail(forwardPaths, reversePaths) {
  const fwd = pathDelayDetail(forwardPaths);
  const rev = pathDelayDetail(reversePaths);
  const totalS = fwd.totalS + rev.totalS;
  return {
    forwardS: fwd.totalS,
    reverseS: rev.totalS,
    totalS: totalS,
    totalMs: totalS * 1000,
    totalUs: totalS * 1e6,
    propagationS: fwd.propagationS + rev.propagationS,
    serialisationS: fwd.serialisationS + rev.serialisationS,
    processingS: fwd.processingS + rev.processingS,
    links: fwd.links + rev.links,
    hops: fwd.hops + rev.hops,
    // Known only if every link in both directions had a stated length.
    lengthKnown: fwd.lengthKnown && rev.lengthKnown,
    unknownLengthLinks: fwd.unknownLengthLinks + rev.unknownLengthLinks,
    unknownRateLinks: fwd.unknownRateLinks + rev.unknownRateLinks,
    forward: fwd,
    reverse: rev
  };
}

// Render a delay the way a report would: ns under a microsecond, us under a
// millisecond, ms beyond. Purely for humans; the numbers above are the truth.
function formatDelayS(seconds) {
  const s = Number(seconds);
  if (!isFinite(s)) return 'n/a';
  if (s === 0) return '0 ns';
  if (s < 1e-6) return round(s * 1e9, 1) + ' ns';
  if (s < 1e-3) return round(s * 1e6, 1) + ' us';
  if (s < 1) return round(s * 1000, 3) + ' ms';
  return round(s, 3) + ' s';
}

function round(v, digits) {
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}

module.exports = {
  C_M_PER_S,
  VELOCITY_FACTOR,
  DEFAULT_VELOCITY_FACTOR,
  SWITCH_DELAY_S,
  DEFAULT_LENGTH_M,
  DEFAULT_PING_PAYLOAD_BYTES,
  familyOf,
  velocityFactor,
  velocityMperS,
  propagationDelayS,
  serialisationDelayS,
  processingDelayS,
  pingFrameBits,
  linkDelayS,
  linkDelayDetail,
  pathDelayS,
  pathDelayDetail,
  roundTripDelayS,
  roundTripDetail,
  formatDelayS
};
