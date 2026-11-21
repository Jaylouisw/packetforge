'use strict';
// The CRS418's Wi-Fi variant sourced power from all seventeen copper ports (#fidelity: CRS418 census).
//
// The row `devices/mikrotik/crs418-8p-8g-2s-5axq2axq-rm.json` was imported with `poe-pse` in
// `capabilities` and not one `poeOut` flag, and no `poe` block. The engine's switch rule
// (`isPoePse()` in engine/media.js) reads a switch that claims PoE as "every copper port sources
// 15.4 W", so the box reported **17** PSE sockets and a **0 W** supply: nine ports that cannot
// source power were listed as able to, and `show power inline` had nothing to spend.
//
// MikroTik's own page, read 2026-11-21 without following redirects
// (https://mikrotik.com/product/crs418_8p_8g_2s_wifi - HTTP 200, 448,215 B, `<h1>` =
// CRS418-8P-8G-2S+5axQ2axQ-RM), prints:
//
//   10/100/1000 Ethernet ports                          17
//   Number of 1G Ethernet ports with PoE-out              8
//   PoE-out ports                              Ether9-Ether16
//   PoE out                                    802.3af/at
//   Total output power                                  150
//   SFP+ ports                                            2
//   High voltage PoE-Out current limit               0.56 A
//   Max power consumption                              227 W
//
// and the marketing row says "8x PoE Output ports (802.3af/at and 24V Passive PoE Output) - up to
// 150 W total output". So the block is Ether9-Ether16, the budget is the printed 150 W, and the
// 24 V passive option is a per-port mode of the same eight ports, not extra ports.
//
// The non-WiFi sibling CRS418-8P-8G-2S+RM already carries the same 8-of-17 split and the same
// 150 W budget; this suite checks both, so the family cannot drift apart again.
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
function spec(m) {
  const s = catalog.find(function (x) { return x.vendor === 'mikrotik' && x.model === m; });
  if (!s) throw new Error('missing spec mikrotik/' + m);
  return s;
}
const WIFI = spec('CRS418-8P-8G-2S+5axQ2axQ-RM');
const PLAIN = spec('CRS418-8P-8G-2S+RM');
const AP = catalog.find(function (x) { return x.vendor === 'aruba' && x.model === 'AP-515'; }); // 25.5 W, 802.3at

function pseNames(s) {
  return s.interfaces.filter(function (i) { return i.poeOut; }).map(function (i) { return i.name; });
}
function show(t, id, sim, cmd) {
  return (new CliSession(t.devices.get(id), t, sim).run(cmd).output || []).map(String);
}

console.log('');
console.log("The Wi-Fi variant sources power on eight ports, not seventeen:");
{
  const pse = pseNames(WIFI);
  ok(pse.length === 8, 'eight copper ports are PSE ports (' + pse.length + ')');
  ok(pse.join(',') === 'eth9,eth10,eth11,eth12,eth13,eth14,eth15,eth16',
    'and they are Ether9-Ether16, the page\'s "PoE-out ports" row (' + pse.join(',') + ')');
  ok(WIFI.interfaces.filter(function (i) { return i.poeOut && i.poeOutClass !== 'PoE+'; }).length === 0,
    'each is classed 802.3at (PoE+), the "802.3af/at" the page prints');
  const silent = ['eth1', 'eth8', 'eth17'].filter(function (n) {
    const p = WIFI.interfaces.find(function (i) { return i.name === n; });
    return p && p.poeOut;
  });
  ok(silent.length === 0, 'Ether1-Ether8 and Ether17 declare no PoE-out (' + silent.join(',') + ')');
  ok(WIFI.interfaces.filter(function (i) { return /^SFP\+/.test(i.name) && i.poeOut; }).length === 0,
    'neither 10G cage sources power');
  ok(WIFI.interfaces.length - 4 === 17, 'the row still models 17 copper ports beside 2 SFP+ and 2 radios');
  ok(/Ether9-Ether16/.test(String(WIFI.poe && WIFI.poe.note)),
    'the poe block records the vendor\'s "PoE-out ports Ether9-Ether16" row');
  ok(WIFI.poe && WIFI.poe.budgetW === 150, 'the budget is the printed "Total output power 150" (' +
    (WIFI.poe && WIFI.poe.budgetW) + ')');
  ok(/^https:\/\/mikrotik\.com\/product\//.test(String(WIFI.poe && WIFI.poe.sourceUrl)),
    'and it cites its own product page (' + (WIFI.poe && WIFI.poe.sourceUrl) + ')');
}

console.log('\nThe built device spends that budget, and only on the eight:');
{
  const t = new Topology();
  const sw = t.addDevice(WIFI, 'sw1');
  const dev = t.devices.get(sw.id);
  ok(dev.poeBudget === 150, 'the device carries 150 W (' + dev.poeBudget + ')');
  ok(dev.poeBudgetSource === 'research', 'from the spec\'s poe block, not the model name (' +
    dev.poeBudgetSource + ')');
  for (let i = 1; i <= 6; i++) {
    const ap = t.addDevice(AP, 'ap' + i);
    ok(!!t.connect(ap.id, 'E0', sw.id, 'eth' + (8 + i)), 'a 25.5 W 802.3at AP cables to eth' + (8 + i));
  }
  const sim = new Simulator(t);
  sim.computePoe();
  const lines = show(t, sw.id, sim, 'show power inline');
  ok(lines[0] === 'Available:150.0(w) Used:127.5(w) Remaining:22.5(w)',
    'five 25.5 W loads fit and the summary says so: ' + lines[0]);
  ok(lines.some(function (l) { return /^eth14\s+auto\s+power-deny/.test(l); }),
    'the sixth on eth14 reads power-deny');
  ok(lines.some(function (l) { return /eth14: PSE budget exhausted: 25\.5 W requested, 22\.5 W left/.test(l); }),
    'with the arithmetic');
  ok(!lines.some(function (l) { return /^eth1\s/.test(l); }),
    'eth1 is not a PoE row at all - it cannot source power');
  ok(lines.some(function (l) { return /2 ports with nothing plugged in: eth15, eth16/.test(l); }),
    'the two unused PoE ports are named');
}

console.log('\nThe non-WiFi sibling still answers the same way:');
{
  ok(pseNames(PLAIN).join(',') === pseNames(WIFI).join(','),
    'CRS418-8P-8G-2S+RM sources on the same eight ports (' + pseNames(PLAIN).join(',') + ')');
  ok(PLAIN.poe && WIFI.poe && PLAIN.poe.budgetW === WIFI.poe.budgetW,
    'and both rows carry the same printed budget (' + PLAIN.poe.budgetW + ' W)');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
