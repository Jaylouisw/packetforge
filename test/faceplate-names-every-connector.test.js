'use strict';
// A connector the spec declares must be a connector the panel can name (#1511).
//
// The 2811 - the router every lab starts with - drew its two WIC-2T serial ports under a heading that read
// "Console", with the cage labelled "Connector unknown" and the group rate printed as 0.064M. All three were
// fixable by looking at the data the spec already carried:
//
//   1. `familyOf()` listed serial and console in one condition, so a serial port whose connector the cage table
//      did not know fell through to the console family and was titled "Console" - the same heading as the real
//      Console and Aux0.
//   2. `CAGE_INFO` had no `serial` entry, so a declared `connector: "serial"` resolved to the unknown placeholder
//      and the tooltip read "Connector unknown (serial)". The cable legend on the same screen already had a
//      Serial row: the legend knew about a connector the faceplate could not name.
//   3. `fmtRate()` printed sub-megabit rates as fractional megabits, so a 64 kbit line read `0.064M` while
//      `engine/media.js` `formatSpeedMbps` - the spelling `show interfaces` uses - called it `64K`.
//
// Asserted here: the ladder agrees with the engine for every rate the catalogue can produce, a serial port is
// never drawn in the console family, and every model in the catalogue names every port it declares.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Topology } = require('../engine');
const { loadCatalog } = require('../devices/registry');
const { formatSpeedMbps } = require('../engine/media');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const ROOT = path.join(__dirname, '..');
const sandbox = { console: console, window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'web', 'faceplate.js'), 'utf8'), sandbox, { filename: 'faceplate.js' });
const FP = sandbox.window.PFFaceplate;

const catalog = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
function spec(v, m) {
  const s = catalog.find(function (x) { return x.vendor === v && x.model === m; });
  if (!s) throw new Error('missing spec ' + v + '/' + m);
  return s;
}
function docFor(s, name) {
  const t = new Topology();
  t.addDevice(s, 'd1');
  if (name) t.getDevice('d1').name = name;
  return t.getDevice('d1').serialize();
}

console.log('');
console.log('A sub-megabit line is a number of kilobits, not a fraction of a megabit:');
{
  ok(FP.fmtRate(0.0096) === '9.6K', 'fmtRate(0.0096) === "9.6K"  (a 9600 baud console line)');
  ok(FP.fmtRate(0.064) === '64K', 'fmtRate(0.064) === "64K"  (a 64 kbit serial line)');
  ok(FP.fmtRate(0.128) === '128K', 'fmtRate(0.128) === "128K"');
  ok(FP.fmtRate(0.256) === '256K', 'fmtRate(0.256) === "256K"');
  ok(FP.fmtRate(0.512) === '512K', 'fmtRate(0.512) === "512K"');
  ok(FP.fmtRate(1.024) === '1.024M', 'fmtRate(1.024) === "1.024M"');
  ok(FP.fmtRate(1.544) === '1.544M', 'fmtRate(1.544) === "1.544M"  (a T1)');
  ok(FP.fmtRate(64) === '64M' && FP.fmtRate(100) === '100M', 'whole megabits keep their old spelling');
  ok(FP.fmtRate(1000) === '1G' && FP.fmtRate(2500) === '2.5G', 'gigabits are unchanged');
  ok(FP.fmtRate(400000) === '400G', 'fmtRate(400000) === "400G"');
  ok(FP.fmtRate(1000000) === '1T', 'fmtRate(1000000) === "1T"  (the ladder goes to terabit)');
  ok(FP.fmtRate(0) === '' && FP.fmtRate(-1) === '' && FP.fmtRate(null) === '' && FP.fmtRate('100') === '',
    'nothing to print prints nothing');

  // The faceplate and `show interfaces` must not spell one speed two ways.
  const rates = new Set();
  catalog.forEach(function (s) {
    const doc = docFor(s);
    doc.interfaces.forEach(function (i) {
      (Array.isArray(i.speedCaps) ? i.speedCaps : []).forEach(function (v) { if (typeof v === 'number' && v > 0) rates.add(v); });
    });
  });
  const numeric = Array.from(rates).sort(function (a, b) { return a - b; });
  const drift = numeric.filter(function (v) { return FP.fmtRate(v) !== formatSpeedMbps(v); });
  ok(numeric.length > 20, 'the catalogue exercises ' + numeric.length + ' distinct socket rates');
  ok(drift.length === 0, 'every catalogue rate is spelt the way engine/media.js spells it',
    drift.slice(0, 6).map(function (v) { return v + ' → ' + FP.fmtRate(v) + ' vs ' + formatSpeedMbps(v); }).join(', '));
}

console.log('');
console.log('Serial is a connector family of its own, not a synonym for console:');
{
  ok(FP.cageLabel('serial') === 'Serial', 'cageLabel("serial") === "Serial"');
  ok(FP.FAMILY_ORDER.indexOf('serial') > FP.FAMILY_ORDER.indexOf('console'),
    'serial is ordered after console, so management ports stay together');
}

console.log('');
console.log('The 2811 draws its WIC-2T as serial:');
{
  const doc = docFor(spec('cisco', '2811'), 'R1');
  const groups = FP.plan(doc);
  const serial = groups.find(function (g) { return g.cage === 'serial'; });
  ok(!!serial, 'the panel has a serial group');
  ok(serial && serial.family === 'serial', 'the serial group belongs to the serial family (not console)');
  ok(serial && serial.label === 'Serial' && serial.familyLabel === 'Serial',
    'the serial group is titled "Serial" both ways (' + (serial && serial.label + ' / ' + serial.familyLabel) + ')');
  ok(serial && serial.ports.length === 2 && serial.ports[0].name === 'Se0/0/0',
    'both WIC-2T ports are in it (Se0/0/0, Se0/0/1)');
  const consoleGroup = groups.find(function (g) { return g.cage === 'console'; });
  ok(consoleGroup && consoleGroup.ports.length === 2 &&
    consoleGroup.ports.every(function (p) { return p.type === 'console'; }),
    'the console group is the console ports and only them');
  ok(!groups.some(function (g) {
    return g.family === 'console' && g.ports.some(function (p) { return p.type !== 'console'; });
  }), 'no data port is drawn in the console family');

  const html = FP.render(doc, {});
  ok(html.indexOf('Connector unknown') < 0, 'nothing on the panel is an unnamed connector');
  ok(html.indexOf('2\u00d7 RJ45 \u00b7 2\u00d7 Console \u00b7 2\u00d7 Serial') >= 0,
    'the model line reads "2\u00d7 RJ45 \u00b7 2\u00d7 Console \u00b7 2\u00d7 Serial"');
  ok(html.indexOf('64K/128K/256K/512K/1.024M/1.544M') >= 0,
    'the serial group prints its rate ladder as 64K/128K/\u2026/1.544M');
  const se = html.slice(html.indexOf('data-port="Se0/0/0"') - 400, html.indexOf('data-port="Se0/0/0"') + 500);
  ok(se.indexOf('Serial') >= 0, 'the socket tooltip names Serial');
  ok(se.indexOf('Connector unknown') < 0, 'no socket on the panel calls its own connector unknown');
  const secAt = html.indexOf('<section class="fp-group" data-family="serial"');
  ok(secAt >= 0, 'the serial group is rendered as its own family');
  const serialSection = secAt < 0 ? '' : html.slice(secAt, html.indexOf('</section>', secAt));
  ok(/data-cage="serial"/.test(serialSection) && /Serial/.test(serialSection),
    'the serial section holds the serial sockets under the Serial heading');
  const consoleSectionAt = html.indexOf('<section class="fp-group" data-family="console"');
  const consoleSection = consoleSectionAt < 0 ? '' : html.slice(consoleSectionAt, html.indexOf('</section>', consoleSectionAt));
  ok(consoleSection.indexOf('data-port="Se0/0/0"') < 0, 'the serial sockets are not inside the console section');
}
console.log('');
console.log('Every model in the catalogue names every connector it declares:');
{
  const unnamed = [];
  const misfiled = [];
  const families = new Set();
  for (const s of catalog) {
    const label = s.vendor + '/' + s.model;
    let doc;
    try { doc = docFor(s); } catch (e) { unnamed.push(label + ': ' + e.message); continue; }
    let groups;
    try { groups = FP.plan(doc); } catch (e) { unnamed.push(label + ': plan ' + e.message); continue; }
    for (const g of groups) {
      families.add(g.family);
      const declared = g.ports.filter(function (p) { return p.type === 'serial' || p.type === 'console' || p.connector === 'serial'; });
      if (g.cage === 'unknown' && declared.length) unnamed.push(label + ': ' + declared.length + ' port(s) unnamed');
      const data = g.ports.filter(function (p) { return p.type !== 'console'; });
      if (g.family === 'console' && data.length) {
        misfiled.push(label + ': ' + data.map(function (p) { return p.name + '/' + p.type; }).join(','));
      }
    }
  }
  ok(unnamed.length === 0, 'no catalogue model leaves a declared connector unnamed', unnamed.slice(0, 6).join('; '));
  ok(misfiled.length === 0, 'no catalogue model draws a data port as a management port', misfiled.slice(0, 6).join('; '));
  ok(families.has('serial'), 'the sweep actually covered serial ports');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
