'use strict';
// Five MikroTik sheets that accept power on one socket were drawing 12.95 W on every copper port.
//
// engine/media.js `derivePortHardware()` fills a silent `poeIn` from `isPoePd()`, which answers
// true for `category: wireless` and for the `poe-pd` capability. None of these facts says WHICH
// socket, so the loop filled the whole RJ45 population:
//
//   RB4011iGS+5HacQ2HnD-IN  10 copper ports, 8 guessed     103.6 W  (its inlet is 23 W)
//   RB2011UiAS-2HnD         10 copper ports, 8 guessed     103.6 W  (inlet 6 W)
//   RB2011UiAS-2HnD-IN      10 copper ports, 8 guessed     103.6 W  (inlet 11 W)
//   L009UiGS-2HaxD-IN        8 copper ports, 6 guessed      77.7 W  (inlet 14 W)
//   RB450Gx4                 5 copper ports, 5 guessed      64.75 W (inlet 5 W)
//
// 453.25 W of demand from five boards that take 59 W between them, and one of them
// (RB450Gx4) would not run from the 802.3af class the guess assumed at all.
//
// Vendor material, all read 2026-11-28:
//   https://mikrotik.com/product/rb4011igs_5hacq2hnd_in
//     "Number of DC inputs 2 (DC jack, PoE-IN)"; "PoE in Passive PoE"; "PoE in input Voltage
//      18-57 V"; "Max power consumption 44 W"; "Max power consumption without attachments 23 W"
//   https://manual.mikrotik.com/hardware/rb4011igs-plus-5hacq2hnd-in/
//     "The device accepts power from the power jack or from the first Ethernet port: ...
//      First Ethernet port accepts Power over Ethernet 18-57 V DC."
//   https://mikrotik.com/product/RB2011UiAS-2HnD  (6 W) and .../RB2011UiAS-2HnD-IN  (11 W)
//     "PoE in Passive PoE"; "PoE in input Voltage 8-30 V"; "PoE-out ports Ether10"
//   https://help.mikrotik.com/docs/spaces/UM/pages/16351574/RB2011UiAS-2HnD-IN
//     "The device accepts powering from either the power jack or from the LAN1 Ethernet port ...
//      Eth1 port accepts 8-30 V DC input ... from non-standard (passive) Power over Ethernet
//      injectors. The board does not work with IEEE802.3af compliant 48 V power injectors."
//   https://mikrotik.com/product/l009uigs_2haxd_in
//     "There's PoE-in on the first port. ... And there's PoE-Out* on the last port";
//     "PoE in 802.3af/at"; "Max power consumption without attachments 14 W"; "PoE-out ports Ether8"
//   https://mikrotik.com/product/rb450gx4 and https://manual.mikrotik.com/hardware/rb450gx4/
//     "Ether1 Ethernet port accepts 12-57 V DC input ... from 802.3af/at or passive Power over
//      Ethernet sources. Max total power consumption with all interfaces loaded is 5 W."
//     "The other four Ethernet ports do not support PoE input."
//
// The inlets were spelled `poeIn: true` before (a shape DEVICE_SCHEMA.md rules out: "watts this
// port draws, as a number - 12.95 and 25.5 are different devices, so `true` is wrong").
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const COPPER = ['rj45', 'combo'];

function copperKeys(spec) {
  return spec.interfaces.filter(function (i) {
    return i.type === 'ethernet' && (i.connector || 'rj45') === 'rj45';
  });
}
function copperHardware(dev) {
  return [...dev.interfaces.values()].map(function (i) { return i.hardware; })
    .filter(function (h) { return h && COPPER.indexOf(h.cage) !== -1; });
}

const ROWS = [
  { file: 'rb4011igs-5hacq2hnd-in', model: 'RB4011iGS+5HacQ2HnD-IN', copper: 10, inlet: 'eth1', watts: 23, was: 103.6, psePort: 'eth10', standard: 'passive' },
  { file: 'rb2011uias-2hnd', model: 'RB2011UiAS-2HnD', copper: 10, inlet: 'eth1', watts: 6, was: 103.6, psePort: 'eth10', standard: 'passive' },
  { file: 'rb2011uias-2hnd-in', model: 'RB2011UiAS-2HnD-IN', copper: 10, inlet: 'eth1', watts: 11, was: 103.6, psePort: 'eth10', standard: 'passive' },
  { file: 'l009uigs-2haxd-in', model: 'L009UiGS-2HaxD-IN', copper: 8, inlet: 'eth1', watts: 14, was: 77.7, psePort: 'eth8', standard: 'af-at' },
  { file: 'rb450gx4', model: 'RB450Gx4', copper: 5, inlet: 'eth1', watts: 5, was: 64.75, psePort: 'eth5', standard: 'af-at' }
];

let before = 0, after = 0;

ROWS.forEach(function (row) {
  console.log('');
  console.log('== ' + row.model + ': one inlet at ' + row.watts + ' W, ' + (row.copper - 1) + ' sockets that say no');

  const spec = catalog.filter(function (s) { return s.vendor === 'mikrotik' && s.model === row.model; })[0];
  ok(!!spec, row.model + ' is in the catalogue (' + row.file + '.json)');
  if (!spec) { return; }

  const copper = copperKeys(spec);
  ok(copper.length === row.copper, row.copper + ' copper sockets (' + copper.length + ')');

  const inlet = copper.filter(function (i) { return i.name === row.inlet; })[0];
  ok(!!inlet, row.inlet + ' is one of them');
  ok(inlet && inlet.poeIn === row.watts,
    'it draws the board ceiling, ' + row.watts + ' W (' + (inlet && inlet.poeIn) + ')');
  ok(inlet && typeof inlet.poeIn === 'number',
    'and states watts as a number, not true (12.95 and 25.5 are different devices)');

  const others = copper.filter(function (i) { return i.name !== row.inlet; });
  ok(others.length === row.copper - 1, (row.copper - 1) + ' sockets beside the inlet');
  ok(others.every(function (i) { return i.poeIn === false; }),
    'every one declares poeIn: false - a claim, not the silence the guess refills',
    others.filter(function (i) { return i.poeIn !== false; })
      .map(function (i) { return i.name + '=' + JSON.stringify(i.poeIn); }).join(','));
  ok(copper.every(function (i) { return typeof i.poeIn === 'number' || i.poeIn === false; }),
    'no copper socket on the sheet is left silent for isPoePd() to fill in');

  const cages = spec.interfaces.filter(function (i) {
    return i.connector === 'sfp' || i.connector === 'sfp+';
  });
  ok(cages.every(function (i) { return i.poeIn === undefined; }),
    'the SFP cage carries no PoE field (' + cages.length + ')');

  const pse = copper.filter(function (i) { return i.name === row.psePort; })[0];
  ok(!!pse && pse.poeOut === true && pse.poeIn === false,
    row.psePort + ' is the PoE-out port: it sources power and is not a PD');

  if (row.standard === 'passive') {
    ok(spec.capabilities.indexOf('802.3af') === -1 && spec.capabilities.indexOf('802.3at') === -1,
      'it claims no 802.3 standard: the manual says the board will not run from an 802.3af injector');
  } else {
    ok(spec.capabilities.indexOf('802.3af') !== -1 || spec.capabilities.indexOf('802.3at') !== -1,
      'it keeps the 802.3 standard its table prints for PoE in');
  }

  ok(!!spec.sourceUrl && /^https:\/\//.test(spec.sourceUrl), 'the row names its source URL');
  ok(/mikrotik\.com/.test(String(spec.notes)), 'notes cite the vendor page that names the socket');
  ok(String(spec.notes).indexOf(String(row.watts) + ' W') !== -1,
    'notes quote the ' + row.watts + ' W figure they declare');

  const dev = new Topology().addDevice(spec);
  const hw = copperHardware(dev);
  ok(hw.length === row.copper, 'the engine derives ' + row.copper + ' copper ports (' + hw.length + ')');
  const drawing = hw.filter(function (h) { return typeof h.poeIn === 'number' && h.poeIn > 0; });
  ok(drawing.length === 1, 'exactly one of them draws power (' + drawing.length + ')');
  ok(drawing.length === 1 && drawing[0].poeIn === row.watts,
    'and it draws ' + row.watts + ' W (' + (drawing[0] && drawing[0].poeIn) + ')');
  const total = hw.reduce(function (a, h) { return a + (typeof h.poeIn === 'number' ? h.poeIn : 0); }, 0);
  ok(Math.abs(total - row.watts) < 1e-9,
    'the whole board asks for ' + row.watts + ' W, not ' + row.was + ' W (' + total + ')');
  ok(hw.filter(function (h) { return h.poeIn === 12.95; }).length === 0,
    'no port carries the inferred 12.95 W 802.3af figure any more');

  before += row.was;
  after += row.watts;
});

console.log('');
const beforeR = Math.round(before * 100) / 100;
console.log('The five sheets together: ' + beforeR + ' W of guessed demand became ' + after + ' W of stated draw');
ok(Math.abs(beforeR - 453.25) < 1e-9 && Math.abs(after - 59) < 1e-9,
  'the arithmetic is the one in the header (453.25 -> 59)');

console.log('');
console.log('Against a real PSE, only the inlet is a load:');
const pseSpec = catalog.find(function (s) { return s.vendor === 'aruba' && s.model === 'CX 6000 24G CL4 PoE 4SFP 370W'; });
ok(!!pseSpec, 'the Aruba 370 W reference PSE is in the catalogue');

if (pseSpec) {
  ROWS.forEach(function (row) {
    const spec = catalog.filter(function (s) { return s.vendor === 'mikrotik' && s.model === row.model; })[0];
    if (!spec) { return; }

    const t1 = new Topology();
    t1.addDevice(pseSpec, 'sw1');
    t1.addDevice(spec, 'r1');
    t1.connect('r1', row.inlet, 'sw1', '1/1/1');
    const s1 = new Simulator(t1);
    s1.computePoe();
    ok(s1.poe[0].used === row.watts,
      row.model + ': the PSE spends ' + row.watts + ' W on the ' + row.inlet + ' inlet (' + s1.poe[0].used + ' W)');
    ok(s1.poe[0].ports.find(function (p) { return p.iface === '1/1/1'; }).powered === true,
      row.model + ': and that cable is powered');

    const other = copperKeys(spec).filter(function (i) { return i.name !== row.inlet; })[0].name;
    const t2 = new Topology();
    t2.addDevice(pseSpec, 'sw2');
    t2.addDevice(spec, 'r2');
    t2.connect('r2', other, 'sw2', '1/1/2');
    const s2 = new Simulator(t2);
    s2.computePoe();
    ok(s2.poe[0].used === 0,
      row.model + ': a cable into ' + other + ' buys 0 W, because it is not a PD (' + s2.poe[0].used + ' W)');
  });
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
