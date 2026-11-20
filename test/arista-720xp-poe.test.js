'use strict';
// The Arista 720XP-48Y6 described PoE+ and could not source a watt (#fidelity: 720XP PoE).
//
// Its spec read "48x 10M/100M/1G RJ45 PoE+" in prose, and the same box declared no `poe-pse`
// capability and no `poe.budgetW`. The engine's PSE rule asks a device's capabilities (or its model
// name) whether it sources power, so this one answered no to every port: `show power inline` printed
// `% No PoE on SW1: no port on this device can supply power`, and an access point cabled to
// Ethernet1 stayed dark on a switch that ships to power 48 of them.
//
// Arista's own two surfaces, read 2026-11-20:
//   * data sheet, https://www.arista.com/assets/data/pdf/Datasheets/CCS-720XP-Datasheet.pdf -
//     "720XP-48Y6 - 48 x 10M-1GbE RJ45 @ 30W - Uplinks: 6x 25G", and the series blurb "Managed
//     802.3af/at/bt power services deliver up to 90W per RJ45 port" (90 W is the mGig 48TXH-2C-S,
//     not this model; 30 W is 802.3at).
//   * 720XP/722XPM 1RU quick start,
//     https://www.arista.com/en/qsg-720xp-series-1ru/720xp-series-1ru-overview - "PoE Power Budget
//     Single / Dual PSU: CCS-720XP-48Y6 ... 982 W / 1850 W" (supported supply PWR-1021-AC).
// The switch is ordered with one 1050 W supply (`CCS-720XP-48Y6-F ... 1 x 1050W AC`), so 982 W is
// the budget it can hand out as shipped. The dual-supply 1850 W ceiling is recorded in `poe.note`
// and not used, the same choice the Aruba 3810M rows make.
//
// What this suite pins down: the budget is the vendor's 982 W rather than the model name (which
// carries no wattage), the 48 copper ports are PSE ports at 30 W each, the six SFP28 uplinks are
// not, and the allocator spends the vendor's number - all 48 802.3af access points fit, and the
// 39th 802.3at access point is refused the 13 W that is left.
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
function spec(v, m) {
  const s = catalog.find(function (x) { return x.vendor === v && x.model === m; });
  if (!s) throw new Error('missing spec ' + v + '/' + m);
  return s;
}

const SWITCH = spec('arista', '720XP-48Y6');
const AF_PD = spec('aruba', 'AP-505');    // 12.95 W, the 802.3af ceiling
const AT_PD = spec('aruba', 'AP-515');    // 25.5 W, an 802.3at draw

function show(dev, t, sim, cmd) {
  return (new CliSession(dev, t, sim).run(cmd).output || []).map(String);
}

console.log('');
console.log('The spec states the vendor\'s PoE row:');
ok((SWITCH.capabilities || []).indexOf('poe-pse') !== -1, 'the 48Y6 declares it is a PSE');
ok((SWITCH.capabilities || []).indexOf('802.3af') !== -1, 'and 802.3af');
ok((SWITCH.capabilities || []).indexOf('802.3at') !== -1, 'and 802.3at, which is its 30 W per port');
ok(SWITCH.poe && SWITCH.poe.budgetW === 982, 'the budget is Arista\'s 982 W (' + (SWITCH.poe && SWITCH.poe.budgetW) + ')');
ok(SWITCH.poe && /^https:\/\/www\.arista\.com\//.test(String(SWITCH.poe.sourceUrl)),
  'and it is cited to an Arista page', SWITCH.poe && SWITCH.poe.sourceUrl);
ok(SWITCH.portTemplate && SWITCH.portTemplate.poeOut === 30,
  'the 48 copper ports declare 30 W each, so the port, not a guess, says they source power');

console.log('\nThe box serves power from its 48 copper ports and not its six uplinks:');
{
  const t = new Topology();
  const sw = t.addDevice(SWITCH, 'sw1');
  const ap = t.addDevice(AF_PD, 'ap1');
  const dev = t.devices.get(sw.id);
  ok(dev.poeBudget === 982, 'the built device carries 982 W (' + dev.poeBudget + ')');
  ok(dev.poeBudgetSource === 'research', 'taken from the spec\'s poe block, not from the model name (' + dev.poeBudgetSource + ')');
  const copper = ['Ethernet1', 'Ethernet24', 'Ethernet48'];
  const uplink = ['Ethernet49', 'Ethernet54'];
  ok(copper.every(function (n) { return dev.interfaces.get(n).poeOut === 30; }),
    'Ethernet1..48 are PSE ports at 30 W');
  ok(copper.every(function (n) { return dev.interfaces.get(n).cage === 'rj45'; }), 'and they are RJ45 sockets');
  ok(uplink.every(function (n) { return !dev.interfaces.get(n).poeOut; }),
    'Ethernet49..54 (SFP28 cages) source nothing');
  ok(uplink.every(function (n) { return dev.interfaces.get(n).cage === 'sfp28'; }), 'and they are cages');

  const link = t.connect(ap.id, 'E0', sw.id, 'Ethernet1');
  ok(!!link, 'an 802.3af access point cables to Ethernet1');
  const sim = new Simulator(t);
  sim.computePoe();
  const entry = sim.poe.filter(function (p) { return p.dev === sw.id; })[0];
  const row = entry && entry.ports.filter(function (p) { return p.iface === 'Ethernet1'; })[0];
  ok(!!row && row.powered === true, 'and it is powered (' + JSON.stringify(row) + ')');
  ok(!!row && row.draw === 12.95, 'drawing its declared 12.95 W (' + (row && row.draw) + ')');

  const lines = show(dev, t, sim, 'show power inline');
  ok(lines[0] === 'Available:982.0(w) Used:13.0(w) Remaining:969.0(w)',
    'the summary line is the vendor budget, one decimal: ' + lines[0]);
  const apRow = lines.filter(function (l) { return /^Ethernet1\s/.test(l); })[0] || '';
  ok(/\bon\b/.test(apRow) && /13\.0/.test(apRow), 'the port reads on and 13.0: ' + apRow);

  const sfp = show(dev, t, sim, 'show power inline Ethernet49');
  ok(/cannot supply power/.test(sfp.join(' ')), 'asking about an uplink says it cannot supply power: ' + sfp.join(' '));
}

console.log('\nThe allocator spends the vendor\'s 982 W:');
{
  // 48 x 12.95 W = 621.6 W. Every copper port can power an 802.3af access point at once, and the
  // 982 W supply covers the lot with 360.4 W to spare.
  //
  // The cables are forced, and the reason is a rule of this engine rather than of the hardware: the
  // cabling guard (`pseDraw` in engine/validation.js) charges every cabled PSE port its declared
  // 30 W capability, so it refuses the 33rd PoE cable on this box even when every powered device
  // draws 12.95 W. That guard is the same one the C9200L-48P meets (48 x 30 W against a 740 W
  // budget), and changing it is not this run's question - but the allocator below is where the
  // budget is actually spent, so the cables are forced to reach it.
  const t = new Topology();
  const sw = t.addDevice(SWITCH, 'sw1');
  const dev = t.devices.get(sw.id);
  const pds = [];
  for (let i = 1; i <= 48; i++) {
    const pd = t.addDevice(AF_PD, 'ap' + i);
    pds.push(pd);
    t.connect(pd.id, 'E0', sw.id, 'Ethernet' + i, i <= 32 ? undefined : { force: true });
  }
  let guard = null;
  {
    const t2 = new Topology();
    const sw2 = t2.addDevice(SWITCH, 'sw2');
    for (let i = 1; i <= 33; i++) {
      const pd = t2.addDevice(AF_PD, 'p' + i);
      if (i < 33) { t2.connect(pd.id, 'E0', sw2.id, 'Ethernet' + i); continue; }
      try { t2.connect(pd.id, 'E0', sw2.id, 'Ethernet' + i); }
      catch (e) { guard = e; }
    }
  }
  ok(!!guard && guard.code === 'E_POE_BUDGET',
    'the cabling guard charges 30 W a cabled port and stops at the 33rd (E_POE_BUDGET)');
  ok(/33 powered ports draw 990 W of a 982 W budget/.test(String(guard && guard.message)),
    'and names the vendor budget it measured against: ' + (guard && guard.message));

  const sim = new Simulator(t);
  sim.computePoe();
  const entry = sim.poe.filter(function (p) { return p.dev === sw.id; })[0] || { ports: [] };
  const powered = entry.ports.filter(function (p) { return p.powered; }).length;
  ok(powered === 48, 'all 48 ports power an 802.3af access point (' + powered + '/48)');
  ok(Math.round(entry.used * 10) / 10 === 621.6, 'and the box reports 621.6 W used (' + entry.used + ')');
  const lines = show(dev, t, sim, 'show power inline');
  ok(lines[0] === 'Available:982.0(w) Used:621.6(w) Remaining:360.4(w)',
    'Available/Used/Remaining add up: ' + lines[0]);
}
{
  // 38 x 25.5 W = 969 W fit; the 39th needs 25.5 W against 13 W left. That refusal is the 982 W
  // budget and not a smaller number: a 900 W budget would have stopped at port 36.
  const t = new Topology();
  const sw = t.addDevice(SWITCH, 'sw1');
  for (let i = 1; i <= 39; i++) {
    const pd = t.addDevice(AT_PD, 'at' + i);
    t.connect(pd.id, 'eth0', sw.id, 'Ethernet' + i, { force: true });
  }
  const sim = new Simulator(t);
  sim.computePoe();
  const dev = t.devices.get(sw.id);
  const entry = sim.poe.filter(function (p) { return p.dev === sw.id; })[0] || { ports: [] };
  const powered = entry.ports.filter(function (p) { return p.powered; });
  const denied = entry.ports.filter(function (p) { return !p.powered; })[0];
  ok(powered.length === 38, '38 802.3at access points are powered (' + powered.length + ')');
  ok(!!denied && denied.iface === 'Ethernet39', 'the 39th is the one refused (' + (denied && denied.iface) + ')');
  ok(!!denied && denied.reason === 'PSE budget exhausted: 25.5 W requested, 13 W left',
    'with the arithmetic that refused it: ' + (denied && denied.reason));
  const lines = show(dev, t, sim, 'show power inline');
  ok(lines[0] === 'Available:982.0(w) Used:969.0(w) Remaining:13.0(w)',
    'and the total is still the vendor budget: ' + lines[0]);
  ok(lines.some(function (l) { return /Ethernet39: PSE budget exhausted/.test(l); }),
    'the denial is named under the table');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
