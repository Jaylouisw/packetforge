'use strict';
// Two CRS "-IN" switch sheets that accept power on one socket were drawing 12.95 W on every copper port.
//
// `engine/media.js` `derivePortHardware()` fills a silent `poeIn` from `isPoePd()`, which answers
// true for the `poe-pd` capability. The capability is a fact about the *box* - a CRS210 can be
// powered from a PoE injector - and it says nothing about *which* socket, so the loop filled the
// whole RJ45 population:
//
//   CRS210-8G-2S+IN   8 copper ports, 8 guessed    103.6 W   (its inlet is 13 W)
//   CRS304-4XG-IN     5 copper ports, 5 guessed     64.75 W  (its inlet is 21 W)
//
// 168.35 W of demand from two switches that take 34 W between them. Neither sources PoE at all,
// so nothing beside the inlet can be fed - and on the CRS304 the inlet is not `eth1`.
//
// Vendor material, all read 2026-11-28:
//   https://mikrotik.com/product/CRS210-8G-2SplusIN
//     "Number of DC inputs 2 (DC jack, PoE-IN)"; "PoE in Passive PoE"; "PoE in input Voltage
//      10-57 V"; "802.3af support Yes"; "Max power consumption 13 W"; "without attachments 13W"
//   https://cdn.mikrotik.com/web-assets/product_files/CRS210-8G-2SplusIN-141211150201_141201.pdf
//     "Power options: 10-57V, 24V 0.8A PSU included, PoE in: 10-57V on Ether1 (802.3af/at or
//      passive PoE)"; "Power consumption 13W"; "SFP+1 compatible with 1.25G and 10G, SFP+2
//      compatible 10G SFP modules only"
//   https://mikrotik.com/product/crs304_4xg_in
//     "Number of DC inputs 4 (DC jack, PoE-IN, 2-pin terminal)"; "PoE in 802.3af/at";
//     "Max power consumption 21 W"; "Max power consumption without attachments 15 W"
//   https://manual.mikrotik.com/hardware/crs304-4xg-in/
//     "The device can be powered through two DC power jacks ... a 2-pin terminal, or the
//      MGMT/BOOT Ethernet PoE-in port"; "MGMT/BOOT Ethernet PoE-in port accepts passive or
//      802.3af/at Power over Ethernet in the range of DC 36-57 V"; "The power consumption of this
//      device is 21 W at maximum load and 15 W at minimum"; "Four 1G/2.5G/5G/10G Ethernet ports"
//      beside "One Gigabit Ethernet port, suggested to be used for management"
//
// Both sheets were silent on every socket: `poeIn` was absent, which is the silence the guess
// refills. There was no `poeIn: true` to correct here - the defect was the empty field.
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
function spec(model) {
  return catalog.filter(function (s) { return s.vendor === 'mikrotik' && s.model === model; })[0];
}

// `was` is what the poe-pd guess asked for: every copper socket at 12.95 W.
const ROWS = [
  { file: 'crs210-8g-2s-in', model: 'CRS210-8G-2S+IN', copper: 8, inlet: 'eth1', watts: 13, was: 103.6, cages: 2 },
  { file: 'crs304-4xg-in', model: 'CRS304-4XG-IN', copper: 5, inlet: 'eth5', watts: 21, was: 64.75, cages: 0 }
];

let before = 0, after = 0;

ROWS.forEach(function (row) {
  console.log('');
  console.log('== ' + row.model + ': one inlet at ' + row.watts + ' W on ' + row.inlet + ', ' + (row.copper - 1) + ' sockets that say no');

  const sp = spec(row.model);
  ok(!!sp, row.model + ' is in the catalogue (' + row.file + '.json)');
  if (!sp) { return; }

  const copper = copperKeys(sp);
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

  const cages = sp.interfaces.filter(function (i) {
    return i.connector === 'sfp' || i.connector === 'sfp+';
  });
  ok(cages.length === row.cages, row.cages + ' optical cage(s) (' + cages.length + ')');
  ok(cages.every(function (i) { return i.poeIn === undefined; }),
    'a cage carries no PoE field - no watts travel down a strand of glass');
  ok(sp.interfaces.every(function (i) { return i.poeOut === undefined; }),
    'the sheet sources no PoE: not one port claims poeOut');

  ok(sp.capabilities.indexOf('poe-pd') !== -1,
    'the box still claims poe-pd - it accepts power, on one socket');
  ['802.3af', '802.3at'].forEach(function (c) {
    ok(sp.capabilities.indexOf(c) !== -1, 'it keeps the ' + c + ' its sheet prints for PoE-in');
  });
  ok(!!sp.sourceUrl && /^https:\/\//.test(sp.sourceUrl), 'the row names its source URL');
  ok(/mikrotik\.com/.test(String(sp.notes)), 'notes cite the vendor page that names the socket');
  ok(String(sp.notes).indexOf(String(row.watts) + ' W') !== -1,
    'notes quote the ' + row.watts + ' W figure they declare');

  const dev = new Topology().addDevice(sp);
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
  ok(hw.every(function (h) { return h.poeOut === null || h.poeOut === undefined; }),
    'and no derived port sources power');

  before += row.was;
  after += row.watts;
});

console.log('');
const beforeR = Math.round(before * 100) / 100;
console.log('The two sheets together: ' + beforeR + ' W of guessed demand became ' + after + ' W of stated draw');
ok(Math.abs(beforeR - 168.35) < 1e-9 && Math.abs(after - 34) < 1e-9,
  'the arithmetic is the one in the header (168.35 -> 34)');

console.log('');
console.log('Against a real PSE, only the inlet is a load:');
const pseSpec = catalog.find(function (s) { return s.vendor === 'aruba' && s.model === 'CX 6000 24G CL4 PoE 4SFP 370W'; });
ok(!!pseSpec, 'the Aruba 370 W reference PSE is in the catalogue');

if (pseSpec) {
  ROWS.forEach(function (row) {
    const sp = spec(row.model);
    if (!sp) { return; }

    const t1 = new Topology();
    t1.addDevice(pseSpec, 'sw1');
    t1.addDevice(sp, 'r1');
    t1.connect('r1', row.inlet, 'sw1', '1/1/1');
    const s1 = new Simulator(t1);
    s1.computePoe();
    ok(s1.poe[0].used === row.watts,
      row.model + ': the PSE spends ' + row.watts + ' W on the ' + row.inlet + ' inlet (' + s1.poe[0].used + ' W)');
    ok(s1.poe[0].ports.find(function (p) { return p.iface === '1/1/1'; }).powered === true,
      row.model + ': and that cable is powered');

    const other = copperKeys(sp).filter(function (i) { return i.name !== row.inlet; })[0].name;
    const t2 = new Topology();
    t2.addDevice(pseSpec, 'sw2');
    t2.addDevice(sp, 'r2');
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
