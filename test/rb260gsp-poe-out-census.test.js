'use strict';
// The RB260GSP is in the catalogue twice - once under its product code (CSS106-1G-4P-1S, #405)
// and once under its marketing name (RB260GSP, #1153) - and only one of the two was repaired by
// the MikroTik PoE census (#2294). The product-code entry kept the engine's switch-wide guess,
// which is wrong twice over on this box:
//
//   * five PSE sockets (`isPoePse()` gives every RJ45 port of a `poe-pse` switch 15.4 W when the
//     spec says nothing) where the hardware has four - Ether1 is the power *inlet*;
//   * 15.4 W of 802.3af on each of them, when the vendor's row says "PoE out Passive PoE" - a
//     fixed-voltage pair, not a negotiated 48 V standard.
//
// MikroTik's own specification table, read 2026-11-21 (HTTP 200, text/html, 344,158 B):
//   https://mikrotik.com/product/RB260GSP
//     "Number of DC inputs 2 (DC jack, PoE-IN)"   "PoE in Passive PoE"   "PoE in input Voltage 11-30 V"
//     "PoE-out ports Ether2-Ether5"   "PoE out Passive PoE"
//     "Low voltage PoE-Out current limit 1 A"   "Max total out (A) 2 A"
//
// The page publishes no watt figure for the outputs, so the budget stays `budgetUnknown` with the
// quoted current limit in the note - the same treatment the sibling entry got in #2294, and the
// same arithmetic MikroTik did not do.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog, effectiveInterfaces } = require('../devices/registry');
const { derivePortHardware } = require('../engine/media');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
function section(name) { console.log('\n' + name); }

const CATALOGUE = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
function spec(model) {
  return CATALOGUE.filter(function (s) { return s.vendor === 'mikrotik' && s.model === model; })[0];
}
const OUTLETS = ['eth2', 'eth3', 'eth4', 'eth5'];

section('One box, two catalogue names - both present, so both are checked');
const byCode = spec('CSS106-1G-4P-1S');
const byName = spec('RB260GSP');
ok(!!byCode, 'CSS106-1G-4P-1S is in the catalogue (the product-code entry)');
ok(!!byName, 'RB260GSP is in the catalogue (the marketing-name entry)');

[['CSS106-1G-4P-1S', byCode], ['RB260GSP', byName]].forEach(function (pair) {
  const model = pair[0], s = pair[1];
  if (!s) return;
  section(model + ': PoE-out is Ether2-Ether5, passive, and Ether1 is the inlet');
  const ports = effectiveInterfaces(s);
  const names = ports.map(function (p) { return p.name; });
  ok(names.join(',') === 'eth1,eth2,eth3,eth4,eth5,SFP1', 'the five copper ports and the cage: ' + names.join(','));
  const pse = ports.filter(function (p) { return p.poeOut; }).map(function (p) { return p.name; });
  ok(pse.join(',') === OUTLETS.join(','), 'exactly four sockets source power: ' + pse.join(','));
  const inlet = ports.filter(function (p) { return p.name === 'eth1'; })[0];
  const inletHw = derivePortHardware(s.interfaces.filter(function (i) { return i.name === 'eth1'; })[0], s);
  ok(inlet && inlet.poeOut === false && inletHw.poeOutDeclared === true,
    'eth1 declares poeOut: false, so the switch-wide guess cannot promote the inlet',
    inlet && (inlet.poeOut + '/' + inletHw.poeOutDeclared));
  const sfp = ports.filter(function (p) { return p.name === 'SFP1'; })[0];
  ok(sfp && !sfp.poeOut, 'the SFP cage sources nothing', sfp && String(sfp.poeOut));
  ok(ports.filter(function (p) { return p.poeOut; })
    .every(function (p) { return p.poeOutClass === 'passive'; }),
    'every outlet is classed passive, not 802.3af',
    ports.filter(function (p) { return p.poeOut; }).map(function (p) { return p.poeOutClass; }).join(','));
  ok(ports.filter(function (p) { return p.poeOut; }).every(function (p) { return p.poeOut !== 15.4; }),
    'no outlet carries the 15.4 W 802.3af default the engine guessed');
});

section('The two entries describe the same hardware');
if (byCode && byName) {
  const shape = function (s) {
    return effectiveInterfaces(s).map(function (p) {
      return p.name + '=' + (p.poeOut === null ? 'null' : p.poeOut) + '/' + (p.poeOutClass || '-');
    }).join(' ');
  };
  ok(shape(byCode) === shape(byName), 'port for port:', shape(byCode) + '  vs  ' + shape(byName));
  ok(byCode.sourceUrl === byName.sourceUrl, 'and both cite the same vendor page', byCode.sourceUrl);
}

section('The budget is unknown because the vendor prints amps, not watts');
[['CSS106-1G-4P-1S', byCode], ['RB260GSP', byName]].forEach(function (pair) {
  const model = pair[0], s = pair[1];
  if (!s) return;
  ok(s.poe && s.poe.budgetUnknown === true, model + ' marks the budget unknown');
  ok(!s.poe || s.poe.budgetW === undefined, model + ' does not invent a wattage', s.poe && String(s.poe.budgetW));
  ok(/2 A/.test(String(s.poe && s.poe.note)), model + ' records the vendor\'s "Max total out (A) 2 A"');
  ok(/^https:\/\/mikrotik\.com\//.test(String(s.poe && s.poe.sourceUrl)), model + ' cites mikrotik.com',
    s.poe && s.poe.sourceUrl);
});

section('The engine reads it: four sockets, and a total it does not claim to have');
[['CSS106-1G-4P-1S', byCode], ['RB260GSP', byName]].forEach(function (pair) {
  const model = pair[0], s = pair[1];
  if (!s) return;
  const t = new Topology();
  const dev = t.addDevice(s, 'd1');
  const sim = new Simulator(t);
  sim.computePoe();
  const rows = [...dev.interfaces.values()].filter(function (p) { return p.poeOut; });
  ok(rows.length === 4, model + ' lights four PoE sockets (' + rows.length + ')');
  ok(rows.every(function (p) { return p.poeOut !== 15.4; }),
    model + ' lights none of them at the 802.3af default',
    rows.map(function (p) { return String(p.poeOut); }).join(','));
  ok(dev.poeBudget === 0 && dev.poeBudgetSource === 'unknown',
    model + ' reports the budget as unknown (' + dev.poeBudget + ' / ' + dev.poeBudgetSource + ')');
  const said = new CliSession(dev, t, sim).run('show power inline').output.join('\n');
  const listed = said.split('\n').filter(function (l) { return /^eth\d/.test(l); }).map(function (l) { return l.split(/\s+/)[0]; });
  ok(listed.join(',') === OUTLETS.join(','), model + ' lists ' + listed.join(','), said.split('\n')[0]);
  ok(said.indexOf('eth1 ') === -1, model + ' does not list the inlet as a supply');
  ok(said.indexOf('budget not modelled') !== -1,
    model + ' says the total is not modelled instead of printing a measurement');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
