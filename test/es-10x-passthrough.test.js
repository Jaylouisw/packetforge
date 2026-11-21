'use strict';
// The EdgeSwitch XP line is 24 V passive PoE, and two of its four catalogued members said otherwise.
//
//   * ES-10X carried `poeOut: true, poeOutClass: "PoE"` on all eight copper ports plus the `poe-pse`
//     capability. Ubiquiti's own copy for that SKU says the opposite - "PoE passthrough support", where
//     the ES-10XP beside it says "each equipped with a 24V passive PoE output" - and the supply settles
//     it: the 10X ships a 24V/1A (24 W) adapter, the 10XP a 24V/2.5A (60 W) one, against a published
//     "Max. passive PoE wattage per port: 15W" that eight ports would need 120 W for.
//   * ES-10XP, ES-18X and ES-5XP all frame their 24 V fixed-voltage ports as `poeOutClass: "PoE"`, which
//     in this catalogue's vocabulary is 802.3af - a negotiated 48 V standard. That is the fault
//     docs/DEVICE_SCHEMA.md names and test/uisp-r-poe.test.js / test/ep-s16-poe.test.js were written for.
//
// Every figure is the vendor's, read 2026-11-20 from the tech-spec table (HTTP 200, crawler UA):
//   https://techspecs.ui.com/uisp/wired/es-10x   574,925 B  "PoE interface 24V DC passive PoE (Pins 4, 5+;
//        7, 8-)"; "Power method 24V DC, 1A power adapter (Included), 24V passive PoE"; "Max. passive PoE
//        wattage per port 15W"; "Max. power consumption 8W (Excluding PoE output)"
//   https://techspecs.ui.com/uisp/wired/es-10xp  575,764 B  same rows with a 2.5 A adapter; LEDs row says
//        "RJ45 ports: link/speed/activity, PoE"
//   https://techspecs.ui.com/uisp/wired/es-18x   580,575 B  "PoE interface (1) 24V passive PoE port"
//        - which the ES-18X datasheet names: "PoE input on port 1 and PoE passthrough on port 16"
//        (https://media.dustin.eu/media/d200001001720050/edgeswitch-18x-product-data-sheet-brochure.pdf,
//        extracted 2026-11-21). The entry had put its one declared outlet on eth0 because the tech-spec
//        row does not say which port it is, and the `poe-pse` capability then made the engine promote
//        the other fifteen copper ports to 15.4 W sources - sixteen PSE ports where the box has one.
//   https://techspecs.ui.com/uisp/wired/es-5xp   574,944 B  "PoE method Passive"; "PoE Out voltage range
//        22-24V DC"; "Max. PoE wattage per port 11.5W"; "PoE configurable per port ... Data ports: Off/24V"
// The 10XP budget is DERIVED (60 W adapter - 8 W box draw), the same shape as devices/ubiquiti/uisp-r.json.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
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

const X = spec('ES-10X');
const XP = spec('ES-10XP');
const X18 = spec('ES-18X');
const X5 = spec('ES-5XP');

console.log('The four EdgeSwitch XP entries are in the catalogue:');
ok(!!X && !!XP && !!X18 && !!X5, 'ES-10X, ES-10XP, ES-18X, ES-5XP');

console.log('\nThe 10X is a passthrough box and does not source power:');
ok(X && X.interfaces.filter(function (i) { return i.connector === 'rj45'; }).length === 8,
  'eight RJ45 ports');
ok(X && X.interfaces.filter(function (i) { return i.connector === 'sfp'; }).length === 2,
  'two SFP cages');
ok(X && X.interfaces.every(function (i) { return !i.poeOut; }), 'no port claims to source power');
ok(X && X.capabilities.indexOf('poe-pse') === -1,
  'the poe-pse capability is gone, which is what stops inference re-promoting every copper port');
ok(X && /passthrough/.test(String(X.description)),
  'the description says passthrough, so prose and ports agree');
{
  const dev = X ? new Topology().addDevice(X, 'sw1') : null;
  const ifaces = dev ? [...dev.interfaces.values()] : [];
  const pse = ifaces.filter(function (i) { return i.poeOut; });
  ok(ifaces.length === 10 && pse.length === 0,
    'a built topology has ten interfaces and none of them is a PSE (' + pse.length + ')');
}

console.log('\nThe 10XP is the PSE, in the vendor\'s class:');
ok(XP && XP.interfaces.filter(function (i) { return i.poeOut; }).length === 8,
  'eight ports source power');
ok(XP && XP.interfaces.filter(function (i) { return i.poeOut; })
  .every(function (i) { return i.poeOutClass === 'passive'; }),
  'all eight are classed passive, not 802.3af');
ok(XP && XP.poe && XP.poe.budgetW === 52, 'the derived budget is 52 W (' +
  (XP && XP.poe && XP.poe.budgetW) + ')');
ok(XP && XP.poe && /techspecs\.ui\.com\/uisp\/wired\/es-10xp/.test(String(XP.poe.sourceUrl)),
  'and it cites the vendor page it was derived from');
ok(XP && XP.poe && /DERIVED/.test(String(XP.poe.note)),
  'and says it is derived rather than quoted');

console.log('\nThe 18X has one PoE outlet, and it is port 16 - not port 1, and not all sixteen:');
ok(X18 && X18.interfaces.filter(function (i) { return i.poeOut; }).length === 1,
  'the 18X has exactly one PoE port');
ok(X18 && X18.interfaces.filter(function (i) { return i.poeOut; })
  .every(function (i) { return i.poeOutClass === 'passive'; }), 'classed passive');
{
  // The vendor names the sockets: "PoE input on port 1 and PoE passthrough on port 16". Ports are
  // catalogued from 1, so p1 is eth0 and p16 is eth15.
  const t = new Topology();
  const sw = X18 ? t.addDevice(X18, 'sw1') : null;
  if (sw) sw.name = 'SW1';
  const ifaces = sw ? [...sw.interfaces.values()] : [];
  const sourcing = ifaces.filter(function (i) { return i.hardware.poeOut; })
    .map(function (i) { return i.name + '=' + i.hardware.poeOut; });
  ok(JSON.stringify(sourcing) === '["eth15=15"]',
    'exactly one PSE, eth15 (port 16), at the vendor\'s 15 W per-port ceiling (' + (sourcing.join(',') || 'none') + ')');
  ok(ifaces.filter(function (i) { return i.name !== 'eth15' && i.hardware.poeOut; }).length === 0,
    'and no other port sources power - the switch-wide inference used to promote all sixteen');
  const sinking = ifaces.filter(function (i) { return i.hardware.poeIn; })
    .map(function (i) { return i.name + '=' + i.hardware.poeIn; });
  ok(JSON.stringify(sinking) === '["eth0=14"]',
    'the inlet is eth0 (port 1) at the box\'s own 14 W max draw (' + (sinking.join(',') || 'none') + ')');
  ok(X18 && X18.poe && X18.poe.budgetW === 10,
    'the derived budget is 10 W: the 24 W adapter less the 14 W the box draws (' +
    (X18 && X18.poe && X18.poe.budgetW) + ')');
  ok(X18 && X18.poe && /DERIVED/.test(String(X18.poe.note)),
    'and the note says it is derived rather than quoted');
  ok(X18 && X18.poe && /edgeswitch-18x/.test(String(X18.poe.sourceUrl)),
    'citing the ES-18X datasheet it was derived from');
  if (sw) {
    const sim = new Simulator(t);
    sim.computePoe();
    const out = new CliSession(sw, t, sim).run('show power inline').output;
    // Nothing is plugged into the one outlet, so the table has no data rows and the port is named once,
    // in the line below it - the view's own way of keeping a wall of empty rows out of the answer.
    const named = out.filter(function (l) { return /eth15/.test(l); });
    ok(named.length > 0 && named.every(function (l) { return /nothing plugged in: eth15$/.test(l); }),
      'the console names the outlet as the one port with nothing plugged in (' + (named.join(' / ') || 'none') + ')');
    ok(!out.some(function (l) { return /^eth(0|1|2|3|4|5|6|7|8|9|10|11|12|13|14)\s/.test(l); }),
      'and names none of the fifteen sockets that source nothing');
    ok(/^Available:10\.0\(w\)/.test(out[0] || ''), 'and prints the derived budget above the table', out[0]);
  }
}
ok(X5 && X5.interfaces.filter(function (i) { return i.poeOut; }).length === 5,
  'the 5XP has five PoE ports');
ok(X5 && X5.interfaces.filter(function (i) { return i.poeOut; })
  .every(function (i) { return i.poeOutClass === 'passive'; }), 'all classed passive');
ok(X5 && !/not captured during intake/.test(String(X5.notes)),
  'and its note no longer says the standard was never captured');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
