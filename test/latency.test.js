'use strict';
// Latency: a ping has to take time, and the time has to depend on the path.
//
// The simulator used to answer a ping in zero seconds. `rtt` was set to
// `got.step - startStep` -- the number of queue steps the run took -- so it was a
// hop count wearing the name of a time, and every medium was equally fast. A 40 km
// cross-country fibre span and a 1 m patch lead came back in exactly the same
// "time", and the first number any network engineer looks at did not exist.
//
// engine/latency.js now models the two terms that are actually computable:
//
//   propagation   = length / (velocity factor * c)   -- time spent in the medium
//   serialisation = frame bits / line rate           -- time spent clocking it out
//
// plus one store-and-forward term per device on the path (an approximation, and
// labelled as one in the source). A ping's RTT is the sum of BOTH directions over
// every link, so distance and hop count both show up in the number.
//
// What this file pins down:
//   * copper and fibre do not propagate at the same speed, and the difference is
//     the real group-index difference (0.66c vs 0.68c), not a fudge factor
//   * 40 km of fibre is thousands of times slower than 1 m of copper
//   * the same frame takes 100x longer to serialise at 100 Mbps than at 10 Gbps
//   * an unstated length is UNKNOWN (0 m + serialisation only), never a fictional
//     distance invented from the medium's maximum reach
//   * an existing two-hop ping still succeeds, still takes the same number of
//     queue steps, and reports a plausible RTT
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { loadCatalog } = require('../devices/registry');
const latency = require('../engine/latency');
const media = require('../engine/media');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));

const pcSpec = {
  vendor: 'generic', model: 'generic-pc', label: 'PC', category: 'host',
  capabilities: ['host', 'cli'],
  interfaces: [{ name: 'eth0', type: 'ethernet', speed: '1G' }]
};

// A switch with both RJ45 access ports and SFP uplinks that take a 40 km
// 1000BASE-EX optic, so "a long fibre run" is a real cable in the catalogue
// rather than a forced link.
const SWITCH_MODEL = 'C2960X-24TS-L';
const RJ45 = 'Gi1/0/1';
const SFP = 'Gi1/0/25';

function switchSpec() {
  return catalog.find(function (s) { return s.vendor === 'cisco' && s.model === SWITCH_MODEL; });
}

// PC-A ---1 m--- SW1 ===span=== SW2 ---1 m--- PC-B
//
// The span is a 1000BASE-EX fibre run whose length the caller chooses, so two
// runs of this lab differ in exactly one thing: metres of glass. Same devices,
// same ports, same hop count, same frame.
function fibreLab(opts) {
  const o = opts || {};
  const leadM = (o.leadM === undefined) ? 1 : o.leadM;
  const t = new Topology();
  const sw1 = t.addDevice(switchSpec());
  const sw2 = t.addDevice(switchSpec());
  const a = t.addDevice(pcSpec);
  const b = t.addDevice(pcSpec);
  sw1.name = 'SW1'; sw2.name = 'SW2'; a.name = 'PC-A'; b.name = 'PC-B';
  a.interfaces.get('eth0').ip = '10.30.0.10';
  a.interfaces.get('eth0').mask = '255.255.255.0';
  b.interfaces.get('eth0').ip = '10.30.0.11';
  b.interfaces.get('eth0').mask = '255.255.255.0';
  t.connect(a.id, 'eth0', sw1.id, RJ45, { lengthM: leadM });
  t.connect(sw1.id, SFP, sw2.id, SFP, { mediaId: '1000base-ex', lengthM: o.spanM });
  t.connect(sw2.id, RJ45, b.id, 'eth0', { lengthM: leadM });
  return { t: t, a: a, b: b, sw1: sw1, sw2: sw2 };
}

// PC-A ---1 m--- SW1 ---1 m--- PC-B : the ordinary two-hop lab, no long span.
function twoHopLab(leadM) {
  const t = new Topology();
  const sw = t.addDevice(switchSpec());
  const a = t.addDevice(pcSpec);
  const b = t.addDevice(pcSpec);
  sw.name = 'SW1'; a.name = 'PC-A'; b.name = 'PC-B';
  a.interfaces.get('eth0').ip = '10.31.0.10';
  a.interfaces.get('eth0').mask = '255.255.255.0';
  b.interfaces.get('eth0').ip = '10.31.0.11';
  b.interfaces.get('eth0').mask = '255.255.255.0';
  t.connect(a.id, 'eth0', sw.id, 'Gi1/0/1', { lengthM: leadM === undefined ? 1 : leadM });
  t.connect(b.id, 'eth0', sw.id, 'Gi1/0/2', { lengthM: leadM === undefined ? 1 : leadM });
  return { t: t, a: a, b: b, sw: sw };
}

function close(a, b, tol) {
  const t = (tol === undefined) ? 1e-12 : tol;
  return Math.abs(a - b) <= t;
}

// ---------------------------------------------------------------------------
console.log('Propagation depends on the medium, and on real refractive indices:');
{
  const c = latency.C_M_PER_S;
  ok(close(c, 299792458, 0), 'c is the defined 299 792 458 m/s (' + c + ')');
  ok(latency.velocityFactor('1000base-t') === 0.66, 'copper twisted pair runs at 0.66c');
  ok(latency.velocityFactor('10gbase-lr') === 0.68, 'single-mode fibre runs at 0.68c');
  ok(latency.velocityFactor('wireless-5') === 1.0, 'a radio signal travels at c');
  ok(latency.velocityFactor('docsis-31') === 0.77, 'coax runs at 0.77c');

  // 1 km of each, in the units a cable datasheet quotes.
  const copperKm = latency.propagationDelayS({ mediaId: '1000base-t', lengthM: 1000 });
  const fibreKm = latency.propagationDelayS({ mediaId: '10gbase-lr', lengthM: 1000 });
  const airKm = latency.propagationDelayS({ mediaId: 'wireless-5', lengthM: 1000 });
  ok(close(copperKm, 1000 / (0.66 * c), 1e-18), '1 km of copper = 1000/(0.66c) = ' + latency.formatDelayS(copperKm));
  ok(close(fibreKm, 1000 / (0.68 * c), 1e-18), '1 km of fibre = 1000/(0.68c) = ' + latency.formatDelayS(fibreKm));
  ok(copperKm / fibreKm > 1.02 && copperKm / fibreKm < 1.04,
    'fibre is faster than copper by the 0.68/0.66 ratio (' + (copperKm / fibreKm).toFixed(4) + 'x)');
  ok(Math.abs(fibreKm - 4.9e-6) < 0.05e-6, 'a kilometre of glass costs ~4.9 us (' + latency.formatDelayS(fibreKm) + ')');
  ok(Math.abs(copperKm - 5.05e-6) < 0.1e-6, 'a kilometre of copper costs ~5.05 us (' + latency.formatDelayS(copperKm) + ')');
  ok(close(airKm, 1000 / c, 1e-18) && airKm < fibreKm, '1 km through the air is the fastest of the three (' + latency.formatDelayS(airKm) + ')');

  // Same length, different medium, different answer -- the property that was missing.
  const same = function (id) { return latency.propagationDelayS({ mediaId: id, lengthM: 2 }); };
  ok(same('1000base-t') !== same('10gbase-lr'), 'the same 2 m lead is not the same delay in copper and in glass');
}

// ---------------------------------------------------------------------------
console.log('\nSerialisation is the frame against the clock, and nothing to do with distance:');
{
  const bits = latency.pingFrameBits();
  ok(bits === 816, 'a default 56-byte-payload echo frame is 102 bytes = ' + bits + ' bits');
  ok(latency.pingFrameBits(0) === 368, 'an empty payload is 46 bytes = ' + latency.pingFrameBits(0) + ' bits');
  ok(latency.pingFrameBits(56, { vlan: true }) === 848, 'a VLAN tag adds four real bytes (' + latency.pingFrameBits(56, { vlan: true }) + ' bits)');
  ok(latency.pingFrameBits(1472) > bits, 'a bigger payload takes longer to serialise');

  const slow = latency.serialisationDelayS({ bits: bits, speedMbps: 100 });
  const fast = latency.serialisationDelayS({ bits: bits, speedMbps: 10000 });
  ok(close(slow, 816 / 100e6, 1e-18), '816 bits at 100 Mbps = ' + latency.formatDelayS(slow));
  ok(close(fast, 816 / 10e9, 1e-18), '816 bits at 10 Gbps = ' + latency.formatDelayS(fast));
  ok(close(slow / fast, 100, 1e-9), 'the same frame is exactly 100x longer on the wire at 100M than at 10G');

  const fibre1k = { mediaId: '10gbase-lr', lengthM: 1000, bits: bits };
  const oneG = latency.linkDelayS(Object.assign({}, fibre1k, { speedMbps: 1000 }));
  const tenG = latency.linkDelayS(Object.assign({}, fibre1k, { speedMbps: 10000 }));
  ok(oneG > tenG, 'over the same fibre, a 1G port is slower end to end than a 10G port');
  ok(close(oneG - tenG, 816 / 1e9 - 816 / 10e9, 1e-18), 'and the difference is exactly the serialisation difference');
  ok(latency.serialisationDelayS({ bits: bits, speedMbps: null }) === 0,
    'an unstated line rate is not charged a made-up serialisation time');
}

// ---------------------------------------------------------------------------
console.log('\n40 km of fibre against a 1 m patch lead:');
{
  const long = latency.propagationDelayS({ mediaId: '1000base-ex', lengthM: 40000 });
  const patch = latency.propagationDelayS({ mediaId: '1000base-t', lengthM: 1 });
  ok(close(long, 40000 / (0.68 * latency.C_M_PER_S), 1e-15),
    '40 km of fibre = ' + latency.formatDelayS(long));
  ok(close(patch, 1 / (0.66 * latency.C_M_PER_S), 1e-18),
    '1 m of copper = ' + latency.formatDelayS(patch));
  ok(long / patch > 10000, 'the span is ' + Math.round(long / patch) + 'x the patch lead');
  ok(long > 1.9e-4 && long < 2.0e-4, '40 km one way lands at ~196 us, as it does on real plant');
}

// ---------------------------------------------------------------------------
console.log('\nA ping across the span carries that difference (same devices, same hops):');
const shortRun = (function () {
  const L = fibreLab({ spanM: 1, leadM: 1 });
  const sim = new Simulator(L.t);
  const r = sim.ping(L.a.id, '10.30.0.11', { count: 1 });
  return { r: r, reply: r.replies[0] };
})();
const longRun = (function () {
  const L = fibreLab({ spanM: 40000, leadM: 1 });
  const sim = new Simulator(L.t);
  const r = sim.ping(L.a.id, '10.30.0.11', { count: 1 });
  return { r: r, reply: r.replies[0] };
})();
{
  ok(shortRun.r.success, 'a ping over the 1 m span succeeds');
  ok(longRun.r.success, 'a ping over the 40 km span succeeds');
  ok(longRun.reply.rtt > shortRun.reply.rtt * 2.5,
    '40 km is measurably slower than 1 m (' + latency.formatDelayS(longRun.reply.delay.totalS) +
    ' vs ' + latency.formatDelayS(shortRun.reply.delay.totalS) + ' RTT)');
  ok(longRun.reply.rtt > 0.55 && longRun.reply.rtt < 0.65,
    'the 40 km RTT is ~0.6 ms (' + longRun.reply.rtt.toFixed(3) + ' ms)');
  ok(shortRun.reply.rtt > 0.15 && shortRun.reply.rtt < 0.25,
    'the 1 m RTT is ~0.2 ms, dominated by the two store-and-forward hops (' + shortRun.reply.rtt.toFixed(3) + ' ms)');

  // The difference IS the propagation difference: 2 directions x 39 999 m of glass.
  const spanDelta = longRun.reply.delay.totalS - shortRun.reply.delay.totalS;
  const expected = 2 * (40000 - 1) / (0.68 * latency.C_M_PER_S);
  ok(close(spanDelta, expected, expected * 0.001),
    'the whole difference is the extra 39.999 km, out and back (' + latency.formatDelayS(spanDelta) + ')');

  // The delay is computed from the path, not from the queue-step count: both runs
  // take exactly the same number of steps because they are the same topology.
  ok(longRun.reply.hops === shortRun.reply.hops && longRun.reply.hops > 0,
    'both runs take the same ' + longRun.reply.hops + ' queue steps, so the delay is not the step count');
  ok(shortRun.reply.rtt !== shortRun.reply.hops,
    'rtt is a time in ms now, not the step count (' + shortRun.reply.rtt.toFixed(3) + ' vs ' + shortRun.reply.hops + ')');

  // Out and back really are both counted.
  const oneWay = latency.pathDelayS(longRun.reply.delay.forward.legs);
  ok(close(longRun.reply.delay.totalS, oneWay * 2, 1e-15),
    'the RTT is both directions summed (2 x ' + latency.formatDelayS(oneWay) + ')');
  ok(longRun.reply.delay.links === 6, 'six link crossings are counted (three links, twice)');
  ok(longRun.reply.delay.hops === 4, 'and one store-and-forward hop per switch per direction (4)');
  ok(longRun.reply.delay.processingS > longRun.reply.delay.serialisationS,
    'per-hop processing dominates serialisation on a 1G path, as it does in the field');
}

// ---------------------------------------------------------------------------
console.log('\nAn unstated length is unknown, never a made-up distance:');
{
  const unknown = latency.linkDelayDetail({
    mediaId: '1000base-ex', lengthM: null, bits: latency.pingFrameBits(), speedMbps: 1000
  });
  ok(unknown.lengthKnown === false, 'the detail says the length is not known');
  ok(unknown.lengthM === null, 'and reports null rather than a number (' + unknown.lengthM + ')');
  ok(unknown.propagationS === 0, 'an unknown length contributes no propagation delay');
  ok(close(unknown.totalS, unknown.serialisationS, 1e-18),
    'so the crossing costs serialisation only (' + latency.formatDelayS(unknown.totalS) + ')');

  // The two temptations it must not give in to:
  const reach = media.MEDIA['1000base-ex'].maxRangeM;
  const reachDelay = latency.propagationDelayS({ mediaId: '1000base-ex', lengthM: reach });
  ok(reach === 40000, 'the optic reaches 40 km (' + reach + ' m)');
  ok(!close(unknown.totalS, reachDelay, 1e-12),
    'an unlabelled fibre is not silently installed at its maximum reach (' +
    latency.formatDelayS(unknown.totalS) + ' is not ' + latency.formatDelayS(reachDelay) + ')');
  ok(unknown.totalS !== 0, 'and it is not treated as instantaneous either');

  // Same rule through the whole engine: an unstated span and an explicit 0 m span
  // must produce the same RTT, because the documented default IS 0 m.
  const unstated = (function () {
    const L = fibreLab({ spanM: null, leadM: 1 });
    const sim = new Simulator(L.t);
    return sim.ping(L.a.id, '10.30.0.11', { count: 1 }).replies[0];
  })();
  const zero = (function () {
    const L = fibreLab({ spanM: 0, leadM: 1 });
    const sim = new Simulator(L.t);
    return sim.ping(L.a.id, '10.30.0.11', { count: 1 }).replies[0];
  })();
  ok(unstated.success, 'a ping over an unlabelled span still succeeds');
  ok(unstated.lengthKnown === false, 'and its reply admits the distance is unknown');
  ok(close(unstated.delay.totalS, zero.delay.totalS, 1e-18),
    'the documented default is 0 m: same RTT as an explicit 0 m span (' +
    latency.formatDelayS(unstated.delay.totalS) + ')');
  ok(unstated.delay.totalS < longRun.reply.delay.totalS / 2,
    'which is far below the stated 40 km run, so the default never flatters the path');
  ok(longRun.reply.lengthKnown === true, 'a stated length is reported as known');
}

// ---------------------------------------------------------------------------
console.log('\nAn existing two-hop ping still succeeds, and reports a plausible RTT:');
{
  const L = twoHopLab(1);
  const sim = new Simulator(L.t);
  const r = sim.ping(L.a.id, '10.31.0.11', { count: 2 });
  ok(r.success, 'the two-hop ping succeeds, as it did before');
  ok(r.replies.length === 2, 'both echo requests are answered (' + r.replies.length + ')');
  ok(r.replies.every(function (x) { return x.success; }), 'neither reply is lost');
  ok(r.replies.every(function (x) { return x.hops > 0; }), 'the step count is still reported (' + r.replies[0].hops + ')');
  ok(r.replies[0].rtt > 0.05 && r.replies[0].rtt < 0.5,
    'the RTT is plausible for a 1 m two-hop path over copper (' + r.replies[0].rtt.toFixed(3) + ' ms)');

  // Every term of the number can be checked by hand.
  const d = r.replies[0].delay;
  const bits = latency.pingFrameBits();
  const prop = 2 * (2 * 1 / (0.66 * latency.C_M_PER_S));   // two links, both directions
  const ser = 4 * (bits / 1e9);                            // four serialisations at 1G
  const proc = 2 * latency.SWITCH_DELAY_S;                 // one switch, both directions
  ok(close(d.propagationS, prop, 1e-18), 'propagation is 2x2x1 m of copper (' + latency.formatDelayS(d.propagationS) + ')');
  ok(close(d.serialisationS, ser, 1e-18), 'serialisation is four 816-bit frames at 1 Gbps (' + latency.formatDelayS(d.serialisationS) + ')');
  ok(close(d.processingS, proc, 1e-18), 'processing is two store-and-forward hops at the documented 50 us (' + latency.formatDelayS(d.processingS) + ')');
  ok(close(d.totalS, prop + ser + proc, 1e-18), 'and the three add up to the reported RTT');
}

// ---------------------------------------------------------------------------
console.log('\nEvery extra device in the path costs another store-and-forward delay:');
{
  const twoLab = twoHopLab(1);
  const two = new Simulator(twoLab.t).ping(twoLab.a.id, '10.31.0.11', { count: 1 });
  // Build the same lab with a second switch in line: PC-A - SW1 - SW2 - PC-B.
  const t = new Topology();
  const sw1 = t.addDevice(switchSpec());
  const sw2 = t.addDevice(switchSpec());
  const a = t.addDevice(pcSpec);
  const b = t.addDevice(pcSpec);
  a.interfaces.get('eth0').ip = '10.32.0.10'; a.interfaces.get('eth0').mask = '255.255.255.0';
  b.interfaces.get('eth0').ip = '10.32.0.11'; b.interfaces.get('eth0').mask = '255.255.255.0';
  t.connect(a.id, 'eth0', sw1.id, 'Gi1/0/1', { lengthM: 1 });
  t.connect(sw1.id, 'Gi1/0/2', sw2.id, 'Gi1/0/2', { lengthM: 1 });
  t.connect(sw2.id, 'Gi1/0/1', b.id, 'eth0', { lengthM: 1 });
  const three = new Simulator(t).ping(a.id, '10.32.0.11', { count: 1 });

  ok(two.success && three.success, 'both the one-switch and two-switch paths answer');
  ok(three.replies[0].delay.hops === two.replies[0].delay.hops + 2,
    'the extra switch adds two hops, one each way (' + two.replies[0].delay.hops + ' -> ' + three.replies[0].delay.hops + ')');
  ok(close(three.replies[0].delay.processingS - two.replies[0].delay.processingS,
    2 * latency.SWITCH_DELAY_S, 1e-18),
    'and exactly two store-and-forward delays to the RTT (' +
    latency.formatDelayS(three.replies[0].rtt / 1000 - two.replies[0].rtt / 1000) + ')');
  ok(three.replies[0].rtt > two.replies[0].rtt, 'so more hops really is more latency');
}

// ---------------------------------------------------------------------------
console.log('\nThe renderer says something a human can read:');
{
  ok(latency.formatDelayS(4.9e-9) === '4.9 ns', 'nanoseconds for a patch lead (' + latency.formatDelayS(4.9e-9) + ')');
  ok(latency.formatDelayS(150e-6) === '150 us', 'microseconds for a metro span (' + latency.formatDelayS(150e-6) + ')');
  ok(latency.formatDelayS(2.5e-3) === '2.5 ms', 'milliseconds for a ping across a country (' + latency.formatDelayS(2.5e-3) + ')');
  ok(latency.formatDelayS(0.5973e-3) === '597.3 us', 'and a sub-millisecond ping stays in us (' + latency.formatDelayS(0.5973e-3) + ')');
  ok(latency.formatDelayS(0) === '0 ns', 'and zero means zero (' + latency.formatDelayS(0) + ')');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
