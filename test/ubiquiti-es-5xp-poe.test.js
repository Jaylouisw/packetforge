'use strict';
// The EdgeSwitch 5XP is a five-port 24 V passive PoE switch on an included 24 V / 2.5 A
// adapter, and until 2026-11-21 the catalogue said almost none of that in a machine-readable way:
//
//   * all five data ports carried the bare `poeOut: true` bit, which `poeDraw()` bills as 1 W
//     and which the faceplate prints as no figure at all;
//   * there was no `poe` block, so `Device` fell through to `parsePoeBudget('ES-5XP')`, found no
//     number in the name and got 0 - `show power inline` answered "budget not modelled" and
//     `computePoe()` had nothing to sum against;
//   * the 10/100 management socket, on a `poe-pse` device with no declared figure, was inferred
//     by `media.js` as a 15.4 W 802.3af PSE - a sixth power port on a five-port PoE switch, on a
//     box whose datasheet says "PoE Configurable Per Port: Management Port N/A".
//
// Every figure below is Ubiquiti's, read 2026-11-21:
//   https://dl.ui.com/datasheets/edgemax/EdgeSwitch_XP_DS.pdf  (200, application/pdf, 3,915,117 B, 7 pp, text layer)
//   https://techspecs.ui.com/uisp/wired/es-5xp                (200, 574,944 B, rendered table)
// p.5 (ES-5XP): "Data Ports (5) 10/100/1000 Ethernet Ports", "Management Port (1) 10/100 Ethernet Port",
// "PoE Out Voltage Range 22-24VDC", "Max. PoE Wattage Per Data Port 11.5 W", "PoE Method Passive",
// "PoE Configurable Per Port: Management Port N/A, Data Ports Off/24V",
// "Power Input 24VDC, 2.5A Power Adapter (Included)", "Max. Power Consumption 60 W".
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
function show(dev, t, sim, cmd) {
  return (new CliSession(dev, t, sim).run(cmd).output || []).map(String);
}

const SW = spec('ES-5XP');
const PD = spec('ACB-AC'); // airCube, 24 V passive PoE in, 8.5 W - fits an 11.5 W port

console.log('The vendor\'s census: five data ports plus a management port that carries no power');
ok(!!SW, 'ES-5XP is in the catalogue');
ok(!!PD, 'ACB-AC (an 8.5 W passive-PoE access point) is in the catalogue');
if (SW) {
  ok(SW.interfaces.length === 6, 'six sockets (' + SW.interfaces.length + ')');
  const data = SW.interfaces.filter(function (i) { return i.name.indexOf('eth') === 0; });
  const mgmt = SW.interfaces.filter(function (i) { return i.name === 'mgmt'; });
  ok(data.length === 5, 'five data ports (' + data.length + ')');
  ok(mgmt.length === 1 && mgmt[0].speed === '100M', 'one 10/100 management port');

  console.log('\nThe five data ports are 24 V passive PSEs at the published 11.5 W:');
  ok(data.every(function (i) { return i.poeOut === 11.5; }),
    'every data port carries poeOut 11.5 (' + data.map(function (i) { return i.poeOut; }).join(',') + ')');
  ok(data.every(function (i) { return i.poeOutClass === 'passive'; }),
    'and its class is passive, not 802.3af');
  ok((SW.capabilities || []).indexOf('802.3af') === -1 && (SW.capabilities || []).indexOf('802.3at') === -1,
    'the row claims no 802.3af/at capability');
  ok((SW.capabilities || []).indexOf('passive-poe') !== -1, 'and does claim passive PoE');

  console.log('\nThe management port is not a power port and is not billed as one:');
  ok(mgmt[0].poeOut === false, 'mgmt carries poeOut:false, the datasheet\'s "Management Port N/A"');
  const built = new (require('../engine/device').Device)('t', SW);
  ok(built.interfaces.get('mgmt').hardware.poeOut === false,
    'so the engine derives no 15.4 W 802.3af PSE on it (' + JSON.stringify(built.interfaces.get('mgmt').hardware.poeOut) + ')');
  const pse = Array.from(built.interfaces.values()).filter(function (i) { return i.hardware.poeOut; });
  ok(pse.length === 5, 'five PSE ports in total, not six (' + pse.length + ')');

  console.log('\nThe 60 W the sheet prints is recorded as the adapter envelope it is:');
  ok(SW.poe && SW.poe.budgetW === 60, 'the poe block carries 60 W (' + (SW.poe && SW.poe.budgetW) + ')');
  ok(SW.poe && /^https:\/\/dl\.ui\.com\/datasheets\/edgemax\/EdgeSwitch_XP_DS\.pdf$/.test(String(SW.poe.sourceUrl)),
    'citing the datasheet page that prints it');
  ok(SW.poe && /envelope/i.test(String(SW.poe.note)) && /no row labelled/i.test(String(SW.poe.note)),
    'and saying in the note that it is an input envelope, not a published PoE-budget row');
}

console.log('\nAn 8.5 W radio cabled to eth3 is powered, and the box can say how much is left:');
{
  const t = new Topology();
  const sw = t.addDevice(SW, 'sw1');
  const ap = t.addDevice(PD, 'ap1');
  ok(!!t.connect(sw.id, 'eth3', ap.id, 'eth0'), 'the radio cables to eth3');
  const sim = new Simulator(t);
  sim.computePoe();
  const dev = t.devices.get(sw.id);
  ok(dev.poeBudget === 60, 'the built device carries 60 W (' + dev.poeBudget + ')');
  ok(dev.poeBudgetSource === 'research', 'taken from the spec\'s poe block (' + dev.poeBudgetSource + ')');
  const entry = (sim.poe || []).filter(function (e) { return e.dev === sw.id; })[0];
  const row = entry && (entry.ports || []).filter(function (p) { return p.iface === 'eth3'; })[0];
  ok(!!row && row.powered === true, 'eth3 powers it (' + JSON.stringify(row) + ')');
  ok(entry && entry.used === 8.5, 'against the 60 W envelope, 8.5 W used (' + (entry && entry.used) + ')');

  const lines = show(dev, t, sim, 'show power inline');
  ok(lines[0] === 'Available:60.0(w) Used:8.5(w) Remaining:51.5(w)',
    'the summary is a real budget, not "not modelled": ' + lines[0]);
  const eth3row = lines.filter(function (l) { return /^eth3\s/.test(l); })[0] || '';
  ok(/\bon\b/.test(eth3row) && /8\.5/.test(eth3row), 'eth3 reads on and 8.5: ' + eth3row);
  const mgmt = show(dev, t, sim, 'show power inline mgmt');
  ok(/cannot supply power/.test(mgmt.join(' ')), 'and asking about mgmt says it cannot supply power: ' + mgmt.join(' '));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
