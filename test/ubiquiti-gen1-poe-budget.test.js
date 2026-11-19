'use strict';
// The Gen1 UniFi PoE switches carried their budget in the model name and nowhere else, so
// `engine/device.js` fell back to `parsePoeBudget(model)` and shipped two numbers the vendor
// never published: US-8-60W was credited 60 W against a stated "Total PoE Availability = 48W",
// US-8-150W 150 W against 130 W. The prose in each spec said one thing and the allocator used
// another, and a switch whose name overstates its budget powers a load the real PSU would drop.
//
// Ubiquiti's own tech-spec pages print the aggregate as its own row - "Max. PoE Output = Up to
// PoE / Total PoE Availability = 48W" - beside the port census, so every figure below is the
// vendor's, read 2026-11-19:
//   https://techspecs.ui.com/unifi/switching/us-8-60w    48 W   8 (4 PoE),    PoE 15.4W/port
//   https://techspecs.ui.com/unifi/switching/us-8-150w  130 W   8 (All PoE+)
//   https://techspecs.ui.com/unifi/switching/us-24-250w 250 W  24 (All PoE+), PoE 17W / PoE+ 34W per port
//   https://techspecs.ui.com/unifi/switching/us-24-500w 500 W  24 (All PoE+)
//   https://techspecs.ui.com/unifi/switching/us-48-500w 500 W  48 (All PoE+)
//   https://techspecs.ui.com/unifi/switching/us-48-750w 750 W  48 (All PoE+)
// Each page prints the copper group as "(1G/100M/10M)", which is also the 10M rung the rows lacked.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
function spec(model) {
  return catalog.find(function (s) { return s.vendor === 'ubiquiti' && s.model === model; });
}

const WANT = [
  ['US-8-60W', 48], ['US-8-150W', 130], ['US-24-250W', 250],
  ['US-24-500W', 500], ['US-48-500W', 500], ['US-48-750W', 750]
];

console.log('Every Gen1 PoE model states the budget its vendor prints:');
for (const [model, watts] of WANT) {
  const s = spec(model);
  ok(!!s, model + ' is in the catalogue');
  if (!s) continue;
  ok(s.poe && s.poe.budgetW === watts, model + ' carries ' + watts + ' W (' +
    (s.poe && s.poe.budgetW) + ')');
  ok(s.poe && /^https:\/\/techspecs\.ui\.com\/unifi\/switching\//.test(String(s.poe.sourceUrl)),
    model + ' cites the tech-spec page for it');
  ok(new RegExp('\\b' + watts + ' W\\b').test(String(s.description)),
    model + ': the prose and the hardware agree on ' + watts + ' W');
}

console.log('\nThe two figures the model name got wrong:');
{
  const a = new Topology().addDevice(spec('US-8-60W'), 'sw1');
  ok(a.poeBudget === 48, 'US-8-60W sources 48 W, not the 60 W its name suggests (' + a.poeBudget + ')');
  ok(a.poeBudgetSource === 'research', 'and it comes from the spec (' + a.poeBudgetSource + ')');
  const b = new Topology().addDevice(spec('US-8-150W'), 'sw2');
  ok(b.poeBudget === 130, 'US-8-150W sources 130 W, not 150 W (' + b.poeBudget + ')');
  ok(b.poeBudgetSource === 'research', 'and it comes from the spec (' + b.poeBudgetSource + ')');
  ok([...a.interfaces.values()].filter(function (i) { return i.poeOut; }).length === 4,
    'US-8-60W has exactly four PSE ports');
  ok([...b.interfaces.values()].filter(function (i) { return i.poeOut; }).length === 8,
    'US-8-150W powers all eight');
}

console.log('\nThe 48 W figure is the one the allocator enforces:');
{
  const t = new Topology();
  t.addDevice(spec('US-8-60W'), 'sw1');
  const ap = catalog.find(function (s) { return s.model === 'AP-515'; });
  if (!ap) { console.error('  \u2717 AP-515 is not in the catalogue'); process.exit(1); }
  for (let i = 1; i <= 2; i++) {
    t.addDevice(ap, 'ap' + i);
    t.connect('ap' + i, 'eth0', 'sw1', 'eth' + (i - 1));
  }
  const entry = new Simulator(t).computePoe()[0];
  const powered = entry.ports.filter(function (p) { return p.powered; });
  const denied = entry.ports.filter(function (p) { return !p.powered; });
  ok(entry.budget === 48, 'the run counts against 48 W (' + entry.budget + ')');
  ok(powered.length === 1, 'one 25.5 W access point fits, the second does not (' + powered.length + ')');
  ok(denied.length === 1 && /PSE budget exhausted/.test(String(denied[0] && denied[0].reason)),
    'and the refusal says why: ' + (denied[0] && denied[0].reason));
}

console.log('\nThe copper ports train at the vendor\'s 10M rung:');
for (const model of ['US-8-60W', 'US-8-150W', 'US-24', 'US-24-250W', 'US-24-500W', 'US-48', 'US-48-500W', 'US-48-750W']) {
  const s = spec(model);
  const copper = (s.interfaces || []).filter(function (i) { return i.connector === 'rj45'; });
  ok(copper.length > 0 && copper.every(function (i) {
    return Array.isArray(i.speedCaps) && i.speedCaps.indexOf('10M') !== -1;
  }), model + ': all ' + copper.length + ' copper ports list 10M');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
