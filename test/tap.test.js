'use strict';
// Passive network taps.
//
// A tap sits in a live link, passes the traffic through untouched and hands a copy to a
// monitor port. The catalogue held three of them (Garland OM3501, OM4501 and P1GCCB) as
// `category: "firewall"` with an empty capability list, which the engine reads as "a box
// that drops everything". Inserting a tap therefore cut the link it was inserted into -
// the one thing a tap must never do - and nothing failed, because a link that carries no
// traffic looks exactly like a link with nothing to carry.
//
// Now they are category "tap" with `passive: true`, and the data path knows what that
// means: network ports pass frames through, monitor ports receive a duplicate, and a frame
// arriving on a monitor port is discarded because a tap is not a hub.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const tapSpec = catalog.find(function (s) { return s.model === 'P1GCCB'; });
const pcSpec = {
  vendor: 'generic', model: 'generic-pc', label: 'PC', category: 'host',
  capabilities: ['host', 'cli'],
  interfaces: [{ name: 'eth0', type: 'ethernet', speed: '1G' }]
};

function lab() {
  const t = new Topology();
  const tap = t.addDevice(tapSpec); tap.name = 'TAP';
  const a = t.addDevice(pcSpec), b = t.addDevice(pcSpec), mon = t.addDevice(pcSpec);
  a.name = 'A'; b.name = 'B'; mon.name = 'MON';
  a.interfaces.get('eth0').ip = '10.44.0.10'; a.interfaces.get('eth0').mask = '255.255.255.0';
  b.interfaces.get('eth0').ip = '10.44.0.20'; b.interfaces.get('eth0').mask = '255.255.255.0';
  mon.interfaces.get('eth0').ip = '10.44.0.30'; mon.interfaces.get('eth0').mask = '255.255.255.0';
  t.connect(a.id, 'eth0', tap.id, 'netA');
  t.connect(b.id, 'eth0', tap.id, 'netB');
  t.connect(mon.id, 'eth0', tap.id, 'monA');
  return { t: t, tap: tap, a: a, b: b, mon: mon };
}

console.log('A tap is catalogued honestly:');
{
  ok(!!tapSpec, 'the P1GCCB is in the catalogue');
  ok(tapSpec.category === 'tap', 'it is category tap, not firewall (' + tapSpec.category + ')');
  ok(tapSpec.passive === true, 'and marked passive');
  const t = new Topology();
  const d = t.addDevice(tapSpec);
  ok(d.isTap() && d.isPassiveTap(), 'the engine agrees it is a passive tap');

  const passive = catalog.filter(function (s) {
    return s.category === 'tap' && (s.capabilities || []).length === 0;
  });
  ok(passive.length >= 3, 'every capability-less tap is in the category (' + passive.length + ')');
  const misfiled = catalog.filter(function (s) {
    return s.category === 'firewall' && (s.capabilities || []).length === 0;
  });
  ok(misfiled.length === 0, 'no capability-less device is filed as a firewall' +
    (misfiled.length ? ' (' + misfiled.slice(0, 3).map(function (s) { return s.model; }).join(', ') + ')' : ''));
}

console.log('\nThe link a tap is inserted into still works:');
{
  const L = lab();
  const sim = new Simulator(L.t);
  const r = sim.ping(L.a.id, '10.44.0.20', { count: 2 });
  ok(r.success, 'a host on one network port reaches a host on the other');
  ok(r.replies.length === 2, 'both replies arrive (' + r.replies.length + ')');
  ok(r.events.some(function (e) { return e.type === 'tap'; }), 'the frames were carried by the tap');
}

console.log('\nThe monitor gets a copy, and only a copy:');
{
  const L = lab();
  const sim = new Simulator(L.t);
  const before = sim.events ? 0 : 0; // eslint-disable-line no-unused-vars
  const r = sim.ping(L.a.id, '10.44.0.20', { count: 1 });
  const taps = r.events.filter(function (e) { return e.type === 'tap'; });
  ok(taps.length > 0, 'the tap reported forwarding (' + taps.length + ' frames)');
  const toMonitor = taps.some(function (e) { return e.monitors > 0; });
  ok(toMonitor, 'at least one frame was copied to a monitor port');
  // The monitor must not have answered anything: it is a listener.
  ok(!r.events.some(function (e) { return e.dev === L.mon.id && e.type === 'icmp-reply'; }),
    'the monitor did not answer as a host');
}

console.log('\nA monitor port cannot inject traffic:');
{
  const L = lab();
  const sim = new Simulator(L.t);
  const r = sim.ping(L.mon.id, '10.44.0.20', { count: 1 });
  ok(!r.success, 'a host behind a monitor port cannot reach the link');
  ok(r.events.some(function (e) { return e.type === 'tap-inject-refused'; }),
    'and the refusal is recorded rather than silently dropped');
}

console.log('\nAn active tap is still an active device:');
{
  const active = catalog.find(function (s) { return s.model === 'EXA8'; });
  ok(!!active, 'EXA8 is in the catalogue');
  const t = new Topology();
  const d = t.addDevice(active);
  ok(d.isTap(), 'it is in the tap category');
  ok(!d.isPassiveTap(), 'but it is not passive: it has a software stack and can aggregate');
  ok(d.hasCap('l2-forward'), 'so it forwards as a switch does');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
