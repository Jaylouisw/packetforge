'use strict';
// poe-injector-budget.test.js -- an injector is sold as a wattage, so it has to state one.
//
// `scripts/audit-poe-budget.js` counts the specs that source power, have no `poe.budgetW` and no
// "never published" marker. On 2026-11-21 all ten entries carrying `poe-injector` were in that
// cohort, and not one of them was missing the *ports*: every port already carried the vendor's
// per-port wattage. What each file lacked was the device total, so `Device` fell through to the
// model-name parser, found nothing in `POE60U-1BT-2-R` or `NetWay8G`, and `show power inline`
// answered "budget not modelled on <dev>: the ports are reported, the power they could supply is
// not" - the same shape this stream has now repaired four times (UDW, the five cloud gateways,
// the two 48-port EdgeSwitches, UMR/UMR-Industrial). The Dream Wall request that opened #130 is
// still blocked on a vendor page that does not exist; the boxes a lab would put underneath it are
// not, and an injector whose total is published but unwritten is exactly the "presence is not
// correctness" failure the file's own description warns about.
//
// Every number below is the vendor's, and every one is recorded in the spec's `poe.note` with the
// line it came from:
//
//   * phihong POE60U-1BT-2-R ................ 60 W  - "Output Power 60W @40C; 30W @50C"
//     (https://www.phihong.com/wp-content/uploads/POE60U-1BT-X-R.pdf)
//   * phihong POE90U-1BT-N6-R ................ 90 W  - "Output Power - 90W ... Power/Port - 90"
//     (https://www.phihong.com/products/power-over-ethernet/poe90u-1bt-n6-r/)
//   * microchip PD-9001GR/AT/AC .............. 30 W  - "Output power of 30W is guaranteed"
//     (https://ww1.microchip.com/downloads/en/DeviceDoc/PD-9001GR_Datasheet_00003973B.pdf)
//   * microchip PD-9501GCO ................... 60 W  - "PoE output: 60W"
//     (https://www.microchip.com/en-us/product/PD-9501GCO)
//   * microchip PD-9004G/AC ................. 120 W  - DERIVED: "up to 30W per port for all ports"
//     x 4 ports (https://ww1.microchip.com/downloads/en/DeviceDoc/PD-9004G_Datasheet_00003976B.pdf)
//   * altronix NetWay8G ..................... 240 W  - "Total power: NetWay8G - 240W"
//     (https://www.altronix.com/products/NetWay8G)
//   * tp-link TL-PoE150S ................... 15.4 W  - "Power Supply | 15.4W (Max. 48VDC)"
//     (https://www.omadanetworks.com/us/business-networking/omada-accessory-poe-adapter/poe150s/)
//   * ubiquiti POE-24-24W ................... 24 W  - "Output Voltage 24VDC @ 1.0A"
//     (https://dl.ui.com/datasheets/poe/PoE_Adapters_DS.pdf)
//   * ubiquiti POE-48-24W ................... 24 W  - "Output Voltage 48VDC @ 0.5A" (same sheet)
//   * mikrotik RBGPOE ................... unknown  - "Output Voltage Same as input", "Max. Current
//     2A": a bare injector has no wattage until a PSU is attached, so it is marked unknown rather
//     than credited with 24 V x 1 A that MikroTik never printed
//     (https://mikrotik.com/product/RBGPOE).
//
// The rule the class gate enforces is deliberately about the *class*: an entry in the catalogue
// that says "poe-injector" and nothing about how much it can inject is a question, and a question
// in a shipped catalogue is asked of every lab that cables one up.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog, effectiveInterfaces } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
function section(name) { console.log('\n' + name); }

const ROOT = path.join(__dirname, '..');
const CATALOGUE = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
const find = function (model) { return CATALOGUE.filter(function (s) { return s.model === model; })[0]; };

// model, the published total, and the host that publishes it
const ROWS = [
  { model: 'POE60U-1BT-2-R', budget: 60, host: 'phihong.com' },
  { model: 'POE90U-1BT-N6-R', budget: 90, host: 'phihong.com' },
  { model: 'PD-9001GR/AT/AC', budget: 30, host: 'microchip.com' },
  { model: 'PD-9501GCO', budget: 60, host: 'microchip.com' },
  { model: 'PD-9004G/AC', budget: 120, host: 'microchip.com' },
  { model: 'NetWay8G', budget: 240, host: 'altronix.com' },
  { model: 'TL-PoE150S', budget: 15.4, host: 'tp-link.com' },
  { model: 'POE-24-24W', budget: 24, host: 'dl.ui.com' },
  { model: 'POE-48-24W', budget: 24, host: 'dl.ui.com' },
  { model: 'RBGPOE', budget: null, host: 'mikrotik.com' }
];

section('No injector in the catalogue is a question about its own output');
{
  const injectors = CATALOGUE.filter(function (s) {
    return (s.capabilities || []).indexOf('poe-injector') !== -1;
  });
  ok(injectors.length === ROWS.length, injectors.length + ' poe-injector entries, all listed here');
  const silent = injectors.filter(function (s) {
    const pse = effectiveInterfaces(s).filter(function (i) { return i && i.poeOut; });
    if (!pse.length) return false;
    const stated = (s.poe && s.poe.budgetW !== undefined && s.poe.budgetW !== null) ||
      (s.poe && s.poe.budgetUnknown === true);
    return !stated;
  });
  ok(silent.length === 0,
    'every injector that sources power declares a total or marks it unknown',
    silent.map(function (s) { return s.vendor + '/' + s.model; }).join(', '));
}

section('Each total is the vendor\'s, cited to the vendor\'s own host');
ROWS.forEach(function (row) {
  const spec = find(row.model);
  if (!spec) { ok(false, row.model + ' is in the catalogue'); return; }
  if (row.budget === null) {
    ok(spec.poe && spec.poe.budgetUnknown === true && spec.poe.budgetW === undefined,
      row.model + ' is marked unknown, not given a made-up wattage',
      spec.poe && JSON.stringify(spec.poe.budgetW));
  } else {
    ok(spec.poe && spec.poe.budgetW === row.budget,
      row.model + ' states ' + row.budget + ' W', spec.poe && spec.poe.budgetW);
  }
  const cited = String((spec.poe && spec.poe.sourceUrl) || '');
  ok(new RegExp('^https://(www\\.|dl\\.|ww1\\.)?' + row.host.replace(/\./g, '\\.') + '/').test(cited),
    '  and cites a ' + row.host + ' document', cited);
  ok(/read 2026-11-21/.test(String(spec.poe && spec.poe.note)),
    '  and the note records the reading that produced it');
});

section('The engine reads it: the total is spent, not ignored');
ROWS.filter(function (r) { return r.budget !== null; }).forEach(function (row) {
  const spec = find(row.model);
  if (!spec) return;
  const t = new Topology();
  const dev = t.addDevice(spec, 'd1');
  ok(dev.poeBudget === row.budget && dev.poeBudgetSource === 'research',
    row.model + ' resolves ' + dev.poeBudget + ' W from the document (' + dev.poeBudgetSource + ')');
  const sim = new Simulator(t);
  sim.computePoe();
  const said = new CliSession(dev, t, sim).run('show power inline').output.join('\n');
  ok(new RegExp('^Available:' + String(row.budget).replace('.', '\\.') + '(?:\\.0)?\\(w\\)', 'm').test(said),
    '  `show power inline` prints Available:' + row.budget + '(w)', said.split('\n')[0]);
  ok(said.indexOf('budget not modelled') === -1, '  and never the not-modelled sentence');
  // A total can never be more than the sockets could draw, and never less than one socket may.
  const ports = [...dev.interfaces.values()].filter(function (p) { return p.poeOut; });
  const ceiling = ports.reduce(function (a, p) { return a + (typeof p.poeOut === 'number' ? p.poeOut : 0); }, 0);
  ok(dev.poeBudget <= ceiling && dev.poeBudget >= Math.max.apply(null, ports.map(function (p) { return p.poeOut; })),
    '  ' + ports.length + ' port(s) worth ' + ceiling + ' W bound a ' + dev.poeBudget + ' W total');
});

section('RBGPOE stays honest: a pass-through injector is refused, not guessed');
{
  const spec = find('RBGPOE');
  const t = new Topology();
  const dev = t.addDevice(spec, 'd1');
  ok(dev.poeBudget === 0 && dev.poeBudgetSource === 'unknown',
    'the budget is explicitly unknown (' + dev.poeBudget + ' / ' + dev.poeBudgetSource + ')');
  const sim = new Simulator(t);
  sim.computePoe();
  const said = new CliSession(dev, t, sim).run('show power inline').output.join('\n');
  ok(said.indexOf('budget not modelled') !== -1,
    'and `show power inline` says so instead of printing 0.0 as a measurement');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
