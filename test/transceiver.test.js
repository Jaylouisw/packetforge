'use strict';
// transceiver.test.js — `show interfaces transceiver [<port>]`.
//
// The physical layer decides whether a link can exist: cage, the medium that mates with
// it, the rate both ends agree on, and whether the cable is longer than the optic can
// drive. validation.js refuses a bad mate outright but only *warns* about distance
// (W_DISTANCE), so a lab can hold a link that mates cleanly and will never carry a
// frame - and before this command nothing in the console said so.
//
// The point of these assertions is that the CLI is not a second opinion: the verdict it
// prints is the code validateLink() produced for the same pair.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + (actual === expected ? '' : ' (got ' + JSON.stringify(actual) +
    ', want ' + JSON.stringify(expected) + ')'));
}
function match(re, text, msg) {
  ok(re.test(text), msg + (re.test(text) ? '' : ' (no match in ' + JSON.stringify(text) + ')'));
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function model(name) { return catalog.find(function (x) { return x.model === name; }); }
const sfpDevices = catalog.filter(function (d) {
  return (d.interfaces || []).some(function (i) {
    return String(i.connector || i.cage || '') === 'sfp+';
  });
});

// Table rows are indented under their heading, so match on the trimmed line.
function rowFor(lines, portName) {
  return lines.filter(function (l) { return l.trim().indexOf(portName) === 0; })[0];
}

function show(dev, topo, sim, cmd) {
  // A prompt is "<device name><>|#>", and a name can contain a space ("Switch (L2)-d1"),
  // so the filter keys on the echo of the command rather than on the start of the line.
  return runCommands(dev, topo, sim, ['enable', cmd]).lines.filter(function (l) {
    return !/[>#](enable|show\b|$)/.test(l);
  });
}

// A fibre pair with one cage port each, cabled at a chosen length.
function fibreLab(lengthM) {
  const t = new Topology();
  const a = t.addDevice(sfpDevices[0]);
  const b = t.addDevice(sfpDevices[1]);
  a.name = 'SW1'; b.name = 'SW2';
  const pa = Array.from(a.interfaces.values()).filter(function (i) { return i.hardware.cage === 'sfp+'; })[0];
  const pb = Array.from(b.interfaces.values()).filter(function (i) { return i.hardware.cage === 'sfp+'; })[0];
  const opts = lengthM === undefined ? {} : { lengthM: lengthM };
  t.connect(a.id, pa.name, b.id, pb.name, opts);
  return { t: t, sim: new Simulator(t), a: a, b: b, pa: pa, pb: pb };
}

console.log('A cable longer than the optic can drive is reported, not swallowed:');
{
  const lab = fibreLab(1200);
  const lines = show(lab.a, lab.t, lab.sim, 'show interfaces transceiver');
  const row = rowFor(lines, lab.pa.name);
  ok(!!row, 'the port has a row: ' + JSON.stringify(row));
  match(/10GBASE-SR/, row, 'the negotiated medium is named');
  match(/\s10G\s/, row, 'the rate is printed in the negotiated units');
  match(/300 m/, row, 'the medium reach is printed');
  match(/1\.2 km/, row, 'the cable length is printed in km');
  match(/W_DISTANCE: 1\.2 km > 300 m reach/, row, 'and the verdict says which way round it is');

  // The code is not invented here: it is what validation produced for this very cable.
  const verdict = lab.t.validateLink(lab.a.id, lab.pa.name, lab.b.id, lab.pb.name, { lengthM: 1200 });
  const codes = (verdict.warnings || []).map(function (w) { return w.code; });
  ok(codes.indexOf('W_DISTANCE') !== -1, 'validation.js raised W_DISTANCE for the same pair: ' + codes.join(','));
  const warnCode = codes.filter(function (c) { return /^W_/.test(c); })[0];
  ok(!!row && row.indexOf(warnCode) !== -1, 'the row carries that exact code (' + warnCode + ')');
  ok(lines.some(function (l) { return /^1 link exceeds the reach of its medium/.test(l.trim()); }),
    'and a warning line says how many links are affected');
  ok(lines.findIndex(function (l) { return /link exceeds the reach/.test(l); }) <
     lines.findIndex(function (l) { return /^\s+Port\s+Cage/.test(l); }),
    'the warning comes before the table, not after it');
}

console.log('\nA cable within reach says so, and says nothing else:');
{
  const lab = fibreLab(100);
  const lines = show(lab.a, lab.t, lab.sim, 'show interfaces transceiver');
  const row = rowFor(lines, lab.pa.name);
  match(/within reach/, row, 'the verdict is "within reach"');
  ok(row.indexOf('W_DISTANCE') === -1, 'and no warning code is printed');
  ok(!lines.some(function (l) { return /exceed the reach/.test(l); }), 'no summary line either');
}

console.log('\nA cable with no declared length is not judged:');
{
  const lab = fibreLab();
  const lines = show(lab.a, lab.t, lab.sim, 'show interfaces transceiver');
  const row = rowFor(lines, lab.pa.name);
  match(/reach unchecked \(no cable length\)/, row,
    'the verdict names the missing fact instead of guessing');
  match(/\s-\s/, row, 'and the length column is a dash, not 0 m');
}

console.log('\nOne port named gives the whole physical record:');
{
  const lab = fibreLab(1200);
  const lines = show(lab.a, lab.t, lab.sim, 'show interfaces transceiver ' + lab.pa.name);
  const text = lines.join('\n');
  match(new RegExp('^' + lab.pa.name + ' \\(ethernet, sfp\\+\\) - transceiver'), lines[0],
    'the heading names the port and its cage');
  match(/cage\s+: sfp\+/, text, 'cage');
  match(/rate\s+: 10G/, text, 'rate');
  match(/optics\s+: \d+ for this cage \(SFP-10G-SR/, text, 'the catalogued optics for the cage');
  match(/link\s+: l\d+ -> SW2\//, text, 'the link and the far end by name');
  match(/medium\s+: 10GBASE-SR \(fiber, lc, 850 nm\)/, text, 'the medium with its wavelength');
  match(/reach\s+: 300 m/, text, 'reach');
  match(/length\s+: 1\.2 km/, text, 'length');
  match(/verdict\s+: W_DISTANCE/, text, 'verdict');
}

console.log('\nA copper-only box has no transceivers and says so:');
{
  const t = new Topology();
  const sw = t.addDevice(model('generic-switch'));
  sw.name = 'SW9';
  const sim = new Simulator(t);
  const lines = show(sw, t, sim, 'show interfaces transceiver');
  eq(lines.length, 1, 'one line of answer');
  match(/^% Every port on SW9 is copper: there are no module bays$/, lines[0],
    'and it explains why rather than printing an empty table');
}

console.log('\nA port that does not exist is refused, and the real bays are named:');
{
  const lab = fibreLab(100);
  const lines = show(lab.a, lab.t, lab.sim, 'show interfaces transceiver Gi0/99');
  match(/^% No transceiver port named Gi0\/99 on SW1/, lines[0], 'the refusal names the port and device');
  match(/module bays: /, lines[0], 'and lists the bays that do exist');
}

console.log('\nA module bay with no catalogued optic is still a module bay:');
{
  const t = new Topology();
  const fc = t.addDevice(model('G610'));
  fc.name = 'FC1';
  const sim = new Simulator(t);
  const lines = show(fc, t, sim, 'show interfaces transceiver');
  match(/FC1 transceivers \(24 cage ports\):/, lines[0], 'all 24 FC cages are listed');
  const row = lines.filter(function (l) { return /^\s+0\s/.test(l); })[0];
  ok(!!row, 'port 0 has a row');
  match(/fc-sfp28/, row, 'with its FC cage');
  match(/28\.05G/, row, 'and the rate the cage really trains at, not the "32G" label');
  match(/not cabled/, row, 'uncabled is stated rather than left blank');
  const detail = show(fc, t, sim, 'show interfaces transceiver 0').join('\n');
  match(/optics\s+: none catalogued - this cage is described by its rate class/, detail,
    'the missing optic catalogue is admitted, not faked');
}

console.log('\nA radio is not a module bay:');
{
  const t = new Topology();
  const ap = t.addDevice(model('RT-AX89X'));
  ap.name = 'AP1';
  const sim = new Simulator(t);
  const lines = show(ap, t, sim, 'show interfaces transceiver');
  const bays = Array.from(ap.interfaces.values()).filter(function (i) {
    return i.hardware.cage === 'antenna';
  }).length;
  ok(bays > 0, 'the device has antenna cages (' + bays + ')');
  ok(!/\bantenna\b/.test(lines.join('\n')), 'and none of them is offered as a transceiver port');
  match(/^AP1 transceivers \(1 cage port\):/, lines[0], 'only the SFP+ bay is listed');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
