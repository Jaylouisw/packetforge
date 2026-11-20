'use strict';
// The six devices whose PoE budget was written in prose and never in the field the engine reads.
//
// `scripts/audit-poe-budget.js` counts the specs that source power on at least one port, have no
// `poe.budgetW` and no "never published" marker. On 2026-11-20 it named six whose own `description`
// already quoted a total: netgear/GS724TP (192 W), moxa/EDS-G4012-8P-4QGS-LVB-T (150 W),
// dahua/NVR5216-16P-EI2 (130 W), hikvision/DS-7616NI-K2/16P (200 W), hikvision/DS-7608NI-K2/8P
// (80 W) and aruba/2540-48g-poe-4sfp-plus-jl357a (370 W - the HPE host had answered 403 to the
// previous pass's crawler). A figure a human can read and the engine cannot use is the defect:
// `show power inline` answered "budget not modelled on <dev>" for a box the catalogue could quote
// to the watt.
//
// Two of the six needed more than the number:
//
//   * netgear/GS724TP. The 192 W figure is the 2007 GS724TPv1's - 802.3af, 15.4 W a port, 225 W
//     supply, 2 combo copper/SFP slots. The port table in this file is 24 PoE+ copper ports plus
//     two *dedicated* SFP, which is the v2/v3 layout, and that revision's budget is 190 W. The
//     entry was quoting one revision's supply beside another's ports.
//   * moxa/EDS-G4012-8P-4QGS-LVB-T. Its eight copper ports carried no `poeOut` at all, so the
//     engine's own inference gave them 15.4 W 802.3af apiece - on a switch whose data sheet says
//     IEEE 802.3bt, 90 W per port. The budget could not be written without the ports it is spent
//     on, so both are fixed here.
//
// research/poe-budget-prose-six-remaining.md carries the verbatim quotes and what is still open
// (the Moxa's supply-dependent total, and the NVRs' aggregate-versus-per-port headroom).
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
function section(name) { console.log('\n' + name); }

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const find = function (model) { return catalog.filter(function (s) { return s.model === model; })[0]; };

// model, the wattage the vendor document states, and the host that document is served from
const SIX = [
  { model: 'GS724TP', budget: 190, host: 'netgear.com' },
  { model: 'EDS-G4012-8P-4QGS-LVB-T', budget: 150, host: 'moxa.com' },
  { model: 'NVR5216-16P-EI2', budget: 130, host: 'dahuasecurity.com' },
  { model: 'DS-7616NI-K2/16P', budget: 200, host: 'hikvision.com' },
  { model: 'DS-7608NI-K2/8P', budget: 80, host: 'hikvision.com' },
  { model: '2540-48g-poe-4sfp-plus-jl357a', budget: 370, host: 'hpe.com' }
];

const specs = SIX.map(function (row) { return find(row.model); });
if (specs.some(function (s) { return !s; })) {
  console.error('  \u2717 one of the six specs is not in the catalogue: ' +
    SIX.filter(function (r, i) { return !specs[i]; }).map(function (r) { return r.model; }).join(', '));
  process.exit(1);
}

section('Each spec now carries the vendor figure, sourced to the vendor');
SIX.forEach(function (row, i) {
  const spec = specs[i];
  ok(spec.poe && spec.poe.budgetW === row.budget,
    spec.model + ' states ' + row.budget + ' W', spec.poe && spec.poe.budgetW);
  ok(spec.poe && new RegExp('^https://(www\\.)?' + row.host.replace(/\./g, '\\.') + '/').test(String(spec.poe.sourceUrl)),
    '  and cites a ' + row.host + ' document', spec.poe && spec.poe.sourceUrl);
});

section('The engine reads it: no box answers "budget not modelled"');
SIX.forEach(function (row, i) {
  const t = new Topology();
  const dev = t.addDevice(specs[i], 'd1');
  ok(dev.poeBudget === row.budget && dev.poeBudgetSource === 'research',
    row.model + ' resolves ' + dev.poeBudget + ' W from the document (' + dev.poeBudgetSource + ')');
  const sim = new Simulator(t);
  sim.computePoe();
  const cli = new CliSession(dev, t, sim);
  const said = cli.run('show power inline').output.join('\n');
  ok(new RegExp('^Available:' + row.budget + '\\.0\\(w\\)', 'm').test(said),
    '  `show power inline` prints Available:' + row.budget + '.0(w)', said.split('\n')[0]);
  ok(said.indexOf('budget not modelled') === -1, '  and never the not-modelled sentence');
});

section('Every one of them is a budget that actually binds');
// A total below the sum of the port ceilings is the case worth having in the catalogue: the budget,
// not the port class, decides how many devices come up.
SIX.forEach(function (row, i) {
  const t = new Topology();
  const dev = t.addDevice(specs[i], 'd1');
  const ports = [...dev.interfaces.values()].filter(function (p) { return p.poeOut; });
  const ceiling = ports.reduce(function (a, p) { return a + (typeof p.poeOut === 'number' ? p.poeOut : 15.4); }, 0);
  ok(ports.length > 0 && ceiling > dev.poeBudget,
    row.model + ': ' + ports.length + ' PSE ports want ' + Math.round(ceiling) + ' W against a ' + dev.poeBudget + ' W budget');
});

section('GS724TP: the 190 W PoE+ layout, and the 192 W v1 sheet is still explained');
{
  const gs = specs[0];
  const ports = gs.interfaces.filter(function (p) { return p.poeOut; });
  ok(ports.length === 24, '24 ports source power (' + ports.length + ')');
  ok(ports.every(function (p) { return p.poeOutClass === 'PoE+'; }), 'all of them are PoE+');
  ok(gs.capabilities.indexOf('802.3at') !== -1, 'and the spec keeps the 802.3at capability');
  ok(/192\s*W/.test(String(gs.poe.note)) && /GS724TPv1/.test(String(gs.poe.note)),
    'the note still records the 192 W v1 figure and which revision it belongs to');
  ok(!/192\s*W/.test(String(gs.description)), 'the description no longer quotes 192 W', gs.description);
}

section('Moxa: eight 802.3bt ports at 90 W, not the engine\'s 15.4 W 802.3af guess');
{
  const mx = specs[1];
  const t = new Topology();
  const dev = t.addDevice(mx, 'mx1');
  const copper = [...dev.interfaces.values()].filter(function (p) { return p.cage === 'rj45'; });
  ok(copper.length === 8, 'eight copper ports (' + copper.length + ')');
  ok(copper.every(function (p) { return p.poeOut === 90; }), 'each declared at 90 W');
  ok(copper.every(function (p) { return p.hardware.poeOutDeclared === true; }),
    'each declared by the spec rather than inferred by the engine');
  ok(mx.capabilities.indexOf('poe-pse') !== -1 && mx.capabilities.indexOf('802.3bt') !== -1,
    'the spec claims poe-pse and 802.3bt');
  ok(/180 W/.test(String(mx.poe.note)) && /62 W/.test(String(mx.poe.note)),
    'the note keeps the 48 VDC and 12 VDC totals the single field cannot hold');
  ok(/24 VDC/.test(String(mx.poe.note)), 'and says which row the field carries');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
