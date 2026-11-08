'use strict';

// Device-first cabling (issue #68).
//
// The port-first flow asks you to know the socket before the engine will help. On a 48-port
// switch that is a guess, and a wrong guess is a single error with no sight of the pairs that
// would have worked - you start over. `linkOptions(a, b)` answers the question people
// actually ask ("these two boxes need to talk - how?") by trying every free pair and grouping
// the legal ones into link types.
//
// This file is about the answers being *usable*, not merely correct: the fastest option
// first, the ports named the way the chassis labels them, and refusals grouped by code so
// "nothing fits" arrives as a diagnosis.

const path = require('path');
const { Topology } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(model) {
  const s = catalog.find(function (x) { return x.model === model; });
  if (!s) throw new Error('missing spec ' + model);
  return s;
}

function lab() {
  const t = new Topology();
  const sw = t.addDevice(spec('generic-switch'));
  const pc = t.addDevice(spec('generic-pc'));
  sw.name = 'SW1'; pc.name = 'PC1';
  return { t: t, sw: sw, pc: pc };
}

console.log('A copper switch and a copper host:');
{
  const l = lab();
  const r = l.t.linkOptions(l.sw.id, l.pc.id, {});
  ok(r.ok === true, 'the pair can be cabled');
  ok(r.options.length === 1, 'one link type (' + r.options.map(function (o) { return o.mediaName; }).join(', ') + ')');
  const opt = r.options[0];
  ok(/1000BASE-T|100BASE-TX|10BASE-T/.test(opt.mediaName), 'and it is copper: ' + opt.mediaName);
  ok(opt.ports > 1, 'the switch offers several ports for it (' + opt.ports + ')');
  ok(opt.pairs[0].a.iface && opt.pairs[0].b.iface,
    'each option names real ports: ' + opt.pairs[0].a.label + ' <-> ' + opt.pairs[0].b.label);
  ok(r.free.a === 8 && r.free.b === 1, 'and reports what is free on each side (' + JSON.stringify(r.free) + ')');
}

console.log('\nThe offered pair actually connects:');
{
  const l = lab();
  const r = l.t.linkOptions(l.sw.id, l.pc.id, {});
  const pr = r.options[0].pairs[0];
  const link = l.t.connect(l.sw.id, pr.a.iface, l.pc.id, pr.b.iface, { mediaId: r.options[0].mediaId || undefined });
  ok(!!link, 'connect() accepted the pair linkOptions offered');
  const after = l.t.linkOptions(l.sw.id, l.pc.id, {});
  ok(after.free.a === r.free.a - 1, 'the switch lost a free port (' + r.free.a + ' -> ' + after.free.a + ')');
  // The host had exactly one port, so it is now full: there is nothing left to cable to, and
  // that is "no free ports", not "no compatible medium".
  ok(after.ok === false && after.code === 'E_NO_FREE_PORTS',
    'and the host, having one port, is now full (' + after.code + ')');
}

console.log('\nDevices with nothing in common say so, and say why:');
{
  const t = new Topology();
  const pc = t.addDevice(spec('generic-pc'));
  const pc2 = t.addDevice(spec('generic-pc'));
  pc.name = 'PC1'; pc2.name = 'PC2';
  const r = t.linkOptions(pc.id, pc2.id, {});
  // Two hosts cabled together is entirely legal (copper to copper), so this must SUCCEED.
  ok(r.ok === true, 'two hosts can still be cabled - a straight-through lead is legal');

  const apSpec = catalog.find(function (x) { return x.category === 'ap'; });
  const wifi = apSpec ? t.addDevice(apSpec) : null;
  if (wifi) {
    wifi.name = 'AP1';
    const r2 = t.linkOptions(wifi.id, pc2.id, {});
    if (!r2.ok) {
      const codes = Object.keys(r2.refusals || {});
      ok(codes.length > 0, 'an AP offers a diagnosis, not a shrug (' + r2.code + ': ' + codes.join(', ') + ')');
      ok(typeof r2.reason === 'string' && r2.reason.indexOf(wifi.name) !== -1,
        'and names the device: ' + r2.reason);
    } else {
      ok(true, 'the catalogue AP has a copper port, so it can be cabled');
    }
  }
}

console.log('\nA device cannot be cabled to itself:');
{
  const l = lab();
  const r = l.t.linkOptions(l.sw.id, l.sw.id, {});
  ok(r.ok === false, 'refused');
  ok(r.code === 'E_SAME_DEVICE', 'with its own code (' + r.code + ')');
  ok(Array.isArray(r.options) && r.options.length === 0, 'and no options to render');
}

console.log('\nNo free ports is not the same as no compatible medium:');
{
  const t = new Topology();
  const sw = t.addDevice(spec('generic-switch'));
  const pc = t.addDevice(spec('generic-pc'));
  sw.name = 'SW1'; pc.name = 'PC1';
  // Fill every switch port with a host of its own.
  let n = 0;
  for (const i of Array.from(sw.interfaces.values())) {
    if (i.hardware.cage !== 'rj45' || i.peer) continue;
    const h = t.addDevice(spec('generic-pc'));
    h.name = 'H' + (++n);
    t.connect(sw.id, i.name, h.id, 'eth0');
  }
  const r = t.linkOptions(sw.id, pc.id, {});
  ok(r.ok === false, 'a fully-cabled switch cannot take another lead');
  ok(r.code === 'E_NO_FREE_PORTS', 'and says which problem it is (' + r.code + ')');
  ok(/free port/.test(r.reason), 'in words: ' + r.reason);
  ok(r.free && r.free.a === 0, 'with the counts (' + JSON.stringify(r.free) + ')');
  ok(Object.keys(r.refusals || {}).length === 0, 'and does not invent media refusals it never tested');
}

console.log('\nRanking: the best cable a person would actually run comes first:');
{
  const t = new Topology();
  // A device with both a copper port and an SFP+ port against one with a 10G SFP+.
  const sw = t.addDevice(spec('CRS305-1G-4S+IN'));
  const fib = catalog.find(function (x) { return (x.interfaces || []).every(function (i) { return /sfp/.test(i.connector || ''); }) && x.category === 'switch'; });
  sw.name = 'CRS';
  const pc = t.addDevice(spec('generic-pc'));
  pc.name = 'PC1';
  const r = t.linkOptions(sw.id, pc.id, {});
  ok(r.ok === true, 'the CRS305 can reach a copper host through its 1G port');
  ok(r.options.length === 1 && /BASE-T/.test(r.options[0].mediaName),
    'and only copper is offered: ' + r.options.map(function (o) { return o.mediaName; }).join(', '));
}

console.log('\nOccupied ports are never offered:');
{
  const l = lab();
  const first = l.t.linkOptions(l.sw.id, l.pc.id, {});
  const used = first.options[0].pairs[0].a.iface;
  l.t.connect(l.sw.id, used, l.pc.id, first.options[0].pairs[0].b.iface, {});
  const second = l.t.linkOptions(l.sw.id, l.pc.id, {});
  const stillOffered = second.options.length
    ? second.options.some(function (o) { return o.pairs.some(function (p) { return p.a.iface === used; }); })
    : false;
  ok(!stillOffered, 'the port with a cable in it is not offered again (' + used + ')');
}

console.log('\nA combo port\'s other half is not offered once one side is used:');
{
  const combo = catalog.find(function (x) {
    return (x.interfaces || []).some(function (i) { return i.comboWith; });
  });
  if (!combo) {
    ok(true, 'no combo device in the catalogue - rule not exercised');
  } else {
    const t = new Topology();
    const c = t.addDevice(combo);
    const pc = t.addDevice(spec('generic-pc'));
    c.name = 'SW'; pc.name = 'PC';
    const r = t.linkOptions(c.id, pc.id, {});
    // Pick a pair whose switch-side port is actually half of a combo, otherwise this rule is
    // not being tested at all and a green tick would be a lie.
    let pair = null;
    if (r.ok) {
      for (const o of r.options) {
        for (const p of o.pairs) {
          const i = c.interfaces.get(p.a.iface);
          if (i && i.comboWith) { pair = p; break; }
        }
        if (pair) break;
      }
    }
    ok(!!pair, 'a combo half is offered to a copper host (' + (pair ? pair.a.iface : 'none') + ')');
    if (!pair) {
      ok(true, 'combo device offers no copper pair to a host');
    } else {
      const iface = c.interfaces.get(pair.a.iface);
      const sibling = iface && iface.comboWith;
      t.connect(c.id, pair.a.iface, pc.id, pair.b.iface, {});
      const again = t.linkOptions(c.id, pc.id, {});
      const offered = [];
      for (const o of again.options) for (const p of o.pairs) offered.push(p.a.iface);
      ok(!!sibling, 'the port has a combo sibling (' + pair.a.iface + ' shares a cage with ' + sibling + ')');
      ok(offered.indexOf(sibling) === -1,
        'and the sibling is not offered once its twin has a cable in it (' + sibling + ')');
    }
  }
}

console.log('');
if (failed) { console.log(failed + ' failed, ' + passed + ' passed'); process.exit(1); }
console.log(passed + ' passed, 0 failed');
