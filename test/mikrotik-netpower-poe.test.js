'use strict';
// Three MikroTik netPower switches declared PoE and powered nothing (#fidelity: netPower census).
//
// Each of these rows listed `poe-pse`, `802.3af` and `802.3at` in `capabilities` and then left every
// interface without `poeOut`, and none of them carried a `poe` block:
//
//   * CSS610-8P-2S+OUT / netPower Lite 8P - eight 802.3af/at PoE-out ports (Ether1-Ether8).
//   * CRS318-16P-2S+OUT / netPower 16P     - sixteen 802.3af/at PoE-out ports (Ether1-Ether16).
//   * CRS112-8P-4S-IN                      - eight 802.3af/at PoE-out ports (Ether1-Ether8), the row
//                                            with no source URL at all.
//
// The engine takes its PSE census from port hardware (scripts/audit-poe-budget.js), so all three
// boxes were read as non-PSE: `show power inline` answered `% No PoE on ...: no port on this device
// can supply power` on an eight-port PoE switch, and the audit counted each one "silent".
//
// MikroTik's own pages, read 2026-11-20, without following redirects:
//   * https://mikrotik.com/product/netpower_lite_ups - 200, 387,171 B. "PoE-out ports Ether1-Ether8",
//     "PoE out 802.3af/at", "Low voltage PoE-Out current limit 1.0 A", "High voltage PoE-Out current
//     limit 0.64 A", "Total output power 120". The 120 W is printed, so it is the budget.
//   * https://mikrotik.com/product/netpower_16p - 200, 375,838 B. "PoE-out ports Ether1-Ether16",
//     "PoE out 802.3af/at", "Low voltage PoE-Out current limit 1.1 A", "High voltage PoE-Out current
//     limit 0.6 A", "Max total out (A) 2.8A (18V-30V) & 1.4A (48V-57V) x2". No watt figure; the
//     RouterOS manual (https://manual.mikrotik.com/hardware/netpower-16p/, 200, 53,837 B) splits the
//     amperes per 8-port group and says the box has no onboard converter.
//   * https://mikrotik.com/product/crs112_8p_4s_in - 200, 364,485 B. "PoE-out ports Ether1-Ether8",
//     "PoE out 802.3af/at", "Low voltage PoE-Out current limit 1 A", "High voltage PoE-Out current
//     limit 450 mA", "Max total out (A) 2.8A (18V-28V) & 1.4A (48V-57V)". No watt figure either.
//
// Two of the three therefore carry `poe.budgetUnknown: true` - the amperes scale with the applied
// input voltage, and multiplying them out would invent a wattage MikroTik never printed. Only the
// Lite 8P, whose page prints "Total output power 120", gets a numeric budget.
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
function spec(m, vendor) {
  const v = vendor || 'mikrotik';
  const s = catalog.find(function (x) { return x.vendor === v && x.model === m; });
  if (!s) throw new Error('missing spec ' + v + '/' + m);
  return s;
}

const LITE8 = spec('CSS610-8P-2S+OUT');
const NET16 = spec('CRS318-16P-2S+OUT');
const CRS112 = spec('CRS112-8P-4S');
const AT_PD = spec('AP-515', 'aruba');    // 25.5 W, an 802.3at draw

function show(t, id, sim, cmd) {
  return (new CliSession(t.devices.get(id), t, sim).run(cmd).output || []).map(String);
}
function pseNames(s) {
  return s.interfaces.filter(function (i) { return i.poeOut; }).map(function (i) { return i.name; });
}

console.log('');
console.log('The spec states the vendor\'s PoE row:');
for (const [s, n, uplinks] of [[LITE8, 8, ['SFP+1', 'SFP+2']], [NET16, 16, ['SFP+1', 'SFP+2']], [CRS112, 8, ['SFP1', 'SFP2', 'SFP3', 'SFP4']]]) {
  const pse = pseNames(s);
  ok(pse.length === n, s.model + ' sources power on ' + n + ' copper ports (' + pse.length + ')');
  ok(/Ether1-Ether\d+/.test(String(s.poe && s.poe.note)),
    s.model + ' records the vendor\'s "PoE-out ports Ether1-Ether' + n + '" row');
  const uplinkPse = uplinks.filter(function (u) { return pse.indexOf(u) !== -1; });
  ok(uplinkPse.length === 0, s.model + ' does not model its SFP cage(s) as PSE ports');
  ok(s.interfaces.filter(function (i) { return i.poeOut; })
    .every(function (i) { return i.poeOutClass === 'PoE+'; }),
    s.model + ' classes them 802.3at (PoE+), the "802.3af/at" the page prints');
  ok((s.capabilities || []).indexOf('poe-pse') !== -1, s.model + ' declares the poe-pse capability');
  ok(/^https:\/\/mikrotik\.com\/product\//.test(String(s.poe && s.poe.sourceUrl)),
    s.model + ' cites its own MikroTik product page (' + (s.poe && s.poe.sourceUrl) + ')');
  ok(/^https:\/\/mikrotik\.com\/product\//.test(String(s.sourceUrl)),
    s.model + ' has a source URL on the row itself, not only in the poe block (' + s.sourceUrl + ')');
}

console.log('\nOf the three, only the Lite 8P prints a wattage:');
ok(LITE8.poe && LITE8.poe.budgetW === 120 && !LITE8.poe.budgetUnknown,
  'the Lite 8P takes MikroTik\'s printed "Total output power 120" (' + (LITE8.poe && LITE8.poe.budgetW) + ')');
ok(NET16.poe && NET16.poe.budgetUnknown === true && NET16.poe.budgetW === undefined,
  'the netPower 16P budget is marked unknown - the page prints amperes only');
ok(CRS112.poe && CRS112.poe.budgetUnknown === true && CRS112.poe.budgetW === undefined,
  'so is the CRS112-8P-4S');

console.log('\nThe 120 W the Lite 8P prints is what its ports can spend:');
{
  const t = new Topology();
  const sw = t.addDevice(LITE8, 'sw1');
  const dev = t.devices.get(sw.id);
  ok(dev.poeBudget === 120, 'the built device carries 120 W (' + dev.poeBudget + ')');
  ok(dev.poeBudgetSource === 'research', 'from the spec\'s poe block, not the model name (' + dev.poeBudgetSource + ')');
  ok(dev.interfaces.get('eth1').poeOut && dev.interfaces.get('eth8').poeOut,
    'eth1..eth8 are PSE ports');
  ok(!dev.interfaces.get('SFP+1').poeOut, 'and the 10G uplink sources nothing');

  for (let i = 1; i <= 5; i++) {
    const ap = t.addDevice(AT_PD, 'ap' + i);
    ok(!!t.connect(ap.id, 'E0', sw.id, 'eth' + i), 'a 25.5 W 802.3at AP cables to eth' + i);
  }
  const sim = new Simulator(t);
  sim.computePoe();
  const entry = sim.poe.filter(function (p) { return p.dev === sw.id; })[0];
  const powered = entry.ports.filter(function (p) { return p.powered; });
  const denied = entry.ports.filter(function (p) { return !p.powered; })[0];
  ok(powered.length === 4, 'four are powered out of the printed 120 W (' + powered.length + ')');
  ok(!!denied && denied.iface === 'eth5', 'the fifth on eth5 is refused (' + (denied && denied.iface) + ')');
  ok(!!denied && denied.reason === 'PSE budget exhausted: 25.5 W requested, 18 W left',
    'with the arithmetic: ' + (denied && denied.reason));

  const lines = show(t, sw.id, sim, 'show power inline');
  ok(lines[0] === 'Available:120.0(w) Used:102.0(w) Remaining:18.0(w)',
    'and the summary is the vendor budget: ' + lines[0]);
  ok(lines.some(function (l) { return /^eth5.*power-deny/.test(l); }), 'eth5 reads power-deny');
  ok(!lines.some(function (l) { return /no port on this device can supply power/.test(l); }),
    'the box no longer answers that it cannot supply power');
}

console.log('\nThe two current-limited boxes report their ports and refuse the arithmetic:');
for (const [s, n] of [[NET16, 16], [CRS112, 8]]) {
  const t = new Topology();
  const sw = t.addDevice(s, 'sw1');
  const dev = t.devices.get(sw.id);
  ok(dev.poeBudget === 0, s.model + ' carries no wattage (' + dev.poeBudget + ')');
  ok(dev.poeBudgetSource === 'unknown', s.model + ' says the vendor never printed one (' + dev.poeBudgetSource + ')');
  const sim = new Simulator(t);
  sim.computePoe();
  const lines = show(t, sw.id, sim, 'show power inline');
  const listed = lines.filter(function (l) { return /^eth\d+\s/.test(l); }).length;
  ok(listed === n, s.model + ' lists all ' + n + ' PoE ports (' + listed + ')');
  ok(lines[lines.length - 1].indexOf('budget not modelled') === 0,
    s.model + ' says the budget is not modelled: ' + lines[lines.length - 1]);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
