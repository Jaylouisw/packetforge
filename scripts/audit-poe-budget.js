'use strict';
// audit-poe-budget.js -- does every device that sources power also say how much?
//
// The PoE invariants in test/hardware-invariants.test.js police one direction: a
// device that claims a budget must have a port to spend it on. The other
// direction was unpoliced, and it is the one that bit the Dream Wall (#130):
// `devices/ubiquiti/udw.json` carried 12 `poeOut` ports and no `poe.budgetW`, so
// `Device` fell through to the model-name parser, found nothing in `UDW`, and
// `show power inline` printed "budget not modelled" - a device that is present
// and a number that is not.
//
// Four cohorts, in the order a lab would hit them:
//
//   silent   - sources PoE, has no budget and no explicit "never published"
//              marker. The engine reports the ports and refuses the arithmetic.
//   inferred - budget came from the MODEL NAME, not from a document. Sometimes
//              right (ES-24-150W is 150 W of PoE), sometimes a PSU rating read
//              as a PSE ceiling (ES-24-500W). Every one wants a datasheet line.
//   prose    - silent, but the description already quotes a figure. These are
//              promotions waiting to be sourced, not new research.
//   unknown  - `poe.budgetUnknown: true`: the vendor was checked and publishes
//              nothing. Correct, and counted so it stays visible.
//
// Usage: node scripts/audit-poe-budget.js [--json] [--all] [--strict]
// Exit:   0 by default; with --strict, 1 if any device is silent or orphaned.
// ---------------------------------------------------------------------------
const path = require('path');
const { loadCatalog } = require('../devices/registry');
const { Topology } = require('../engine');

const ROOT = path.join(__dirname, '..');

// A figure the description already quotes as a BUDGET. The order matters: the
// number must sit before the word "budget", because Teltonika's TSW040 reads
// "a 240 W total budget and up to 30 W on any one port" and the earlier
// "budget ... digits" form happily matched the per-port ceiling, 30, as the
// switch's 240 W ceiling. A per-port wattage is never a budget.
const PROSE_BUDGET = /(\d{1,2}(?:,\d{3})|\d{2,4})\s*w\b[^.;]{0,20}\bbudget\b|\bbudget\b\s*(?:of|:)?\s*(\d{1,2}(?:,\d{3})|\d{2,4})\s*w\b/i;

function proseBudget(desc) {
  const m = PROSE_BUDGET.exec(String(desc || ''));
  if (!m) return null;
  const n = Number(String(m[1] || m[2]).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.indexOf('--json') !== -1;
  const showAll = argv.indexOf('--all') !== -1;
  const strict = argv.indexOf('--strict') !== -1;

  const cat = loadCatalog(path.join(ROOT, 'devices'));
  const report = { models: cat.length, sourcing: 0, silent: [], inferred: [], prose: [], unknown: [], orphan: [] };

  for (const spec of cat) {
    // The PSE census comes from the ENGINE's port hardware, not from the raw
    // `poeOut` key: a cage cannot source watts, and a port template's generated
    // ports never carry the literal key. Reading `spec.interfaces` here reported
    // 37 devices as "budget with no PSE port" that the invariants - which read
    // `hardware.poeOut` - correctly treat as fine.
    let dev;
    try { dev = new Topology().addDevice(spec); } catch (e) { continue; }
    const ports = dev.interfaces instanceof Map ? [...dev.interfaces.values()] : [];
    const pse = ports.filter(function (p) { return p.hardware && p.hardware.poeOut; });
    const declared = (spec.poe && spec.poe.budgetW != null) ? spec.poe.budgetW : spec.poeBudget;

    if (!pse.length) {
      // A budget with nothing to spend it on is the direction the invariants
      // already police; counted here so this audit is one view of both.
      if (declared > 0) report.orphan.push({ model: spec.vendor + '/' + spec.model, budget: declared });
      continue;
    }
    report.sourcing++;

    const row = {
      model: spec.vendor + '/' + spec.model,
      pse: pse.length,
      budget: dev.poeBudget,
      source: dev.poeBudgetSource
    };

    if (dev.poeBudgetSource === 'unknown') { report.unknown.push(row); continue; }
    if (dev.poeBudget > 0 && dev.poeBudgetSource === 'name') { report.inferred.push(row); continue; }
    if (dev.poeBudget > 0) continue;

    const prose = proseBudget(spec.description);
    if (prose != null) { row.prose = prose; report.prose.push(row); }
    report.silent.push(row);
  }

  if (asJson) { console.log(JSON.stringify(report, null, 2)); return 0; }

  const shown = function (a) { return showAll ? a.length : Math.min(a.length, 12); };
  const more = function (a, n) {
    if (!showAll && a.length > n) console.log('   ... and ' + (a.length - n) + ' more (--all to list)');
  };

  console.log('Models: ' + report.models + ', of which ' + report.sourcing + ' source PoE on at least one port');
  console.log('');
  console.log('Silent (PoE out, no budget, no "never published" marker): ' + report.silent.length);
  for (const r of report.silent.slice(0, shown(report.silent))) {
    console.log('   - ' + r.model + ' (' + r.pse + ' PSE)' + (r.prose != null ? '  [prose says ' + r.prose + ' W]' : ''));
  }
  more(report.silent, shown(report.silent));
  console.log('Inferred from the model name (budget not traced to a document): ' + report.inferred.length);
  for (const r of report.inferred.slice(0, shown(report.inferred))) console.log('   - ' + r.model + ' (' + r.budget + ' W from "name")');
  more(report.inferred, shown(report.inferred));
  console.log('Marked unknown on purpose (vendor publishes nothing): ' + report.unknown.length);
  console.log('Budget with no PSE port (the invariants refuse this): ' + report.orphan.length);
  for (const r of report.orphan.slice(0, shown(report.orphan))) console.log('   - ' + r.model + ' (' + r.budget + ' W, 0 PSE)');
  console.log('');
  console.log(report.silent.length + ' of ' + report.sourcing + ' PSEs cannot be asked how much they can supply' +
    (report.prose.length ? '; ' + report.prose.length + ' of those already quote a figure in prose' : '') + '.');

  const bad = report.silent.length + report.orphan.length;
  return (strict && bad) ? 1 : 0;
}

process.exit(main());
