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
const fs = require('fs');
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

console.log('\nThe transceiver view answers for the port, not only for the optic:');
{
  // A shut port still has an optic in its cage and a cable in the socket, so every number the table
  // prints above stays true. What it could not say was that nothing crosses: the detail line read
  // `(up)` from the cable's own state, and the cable was indeed up - so an operator chasing a dead
  // port was told about the one thing that was working.
  const lab = fibreLab();
  const shut = runCommands(lab.a, lab.t, lab.sim,
    ['enable', 'configure terminal', 'interface ' + lab.pa.name, 'shutdown', 'end',
      'show interfaces transceiver']).lines.filter(function (l) {
    return !/[>#](enable|show\b|configure|interface|shut|end|$)/.test(l);
  });
  // `shutdown` itself echoes `<port> administratively down`, which also starts with the port name, so
  // the table row is the matching line that carries the cage column.
  ok(shut.indexOf(lab.pa.name + ' administratively down') === 0 ||
    shut.some(function (l) { return l === lab.pa.name + ' administratively down'; }),
    'the console confirmed the shutdown');
  const row = shut.filter(function (l) {
    return l.trim().indexOf(lab.pa.name) === 0 && l.indexOf('sfp+') !== -1;
  })[0];
  ok(!!row, 'the shut port still has its row, because the optic is still in it: ' + JSON.stringify(row));
  match(/10GBASE-SR/, row, 'and the medium it would run is still reported');
  const note = shut.filter(function (l) { return l.trim().indexOf(lab.pa.name + ':') === 0; })[0] || '';
  match(/administratively down/, note, 'and the port says why no frame crosses it: ' + JSON.stringify(note));
  ok(shut.join('\n').indexOf('those ports are why no frame crosses') !== -1,
    'with one sentence tying the note to the table above it');

  // The same fact in the per-port record, beside the cable's own state rather than instead of it.
  const detail = show(lab.a, lab.t, lab.sim, 'show interfaces transceiver ' + lab.pa.name);
  const linkLine = detail.filter(function (l) { return /^\s{2}link\s*:/.test(l); })[0] || '';
  match(/administratively down/, linkLine, 'the detail line names the port state beside the cable state');
  match(/\(up, /, linkLine, 'and still reports the cable as up, because it is');

  // A shut port at the far end is named the same way, for the same reason: our port is fine.
  const far = fibreLab();
  runCommands(far.b, far.t, far.sim,
    ['enable', 'configure terminal', 'interface ' + far.pb.name, 'shutdown', 'end']);
  const farLines = show(far.a, far.t, far.sim, 'show interfaces transceiver');
  const farNote = farLines.filter(function (l) { return l.trim().indexOf(far.pa.name + ':') === 0; })[0] || '';
  match(/far port/, farNote, 'a shut port at the other end is named with its device: ' + JSON.stringify(farNote));

  // And an ordinary, working cable gets none of it.
  const healthy = show(fibreLab().a, fibreLab().t, fibreLab().sim, 'show interfaces transceiver');
  ok(healthy.filter(function (l) { return /^\s{2}\S+: (this|there|the)/.test(l); }).length === 0,
    'a working port gets no note at all');
}

console.log('\nThe transcript docs/CLI.md quotes is the one this code prints:');
{
  // A transcript written from a real run is still a copy, and copies drift. The doc block these lines
  // come from was first written by hand - plausible, and wrong in its port names - so the sentences it
  // quotes are pinned here: if the console stops saying them, the docs are not quietly left alone.
  const t = new Topology();
  const sw = t.addDevice(catalog.find(function (s) { return s.vendor === 'ubiquiti' && s.model === 'EP-S16'; }));
  sw.name = 'SW1';
  const r = t.addDevice(catalog.find(function (s) { return s.vendor === 'cisco' && s.model === 'ASR 1001-X'; }));
  r.name = 'R2';
  const link = t.connect(sw.id, 'sfp1', r.id, 'Te0/0/0', { mediaId: '10gbase-sr' });
  const sim = new Simulator(t);
  const docs = fs.readFileSync(path.join(__dirname, '..', 'docs', 'CLI.md'), 'utf8');
  const docsLines = docs.split('\n').map(function (l) { return l.replace(/\s+$/, ''); });

  runCommands(sw, t, sim, ['enable', 'configure terminal', 'interface sfp1', 'shutdown', 'end']);
  const detail = show(sw, t, sim, 'show interfaces transceiver sfp1').join('\n');
  const table = show(sw, t, sim, 'show interfaces transceiver').join('\n');

  const fenced = [
    '  link         : ' + link.id + ' -> R2/Te0/0/0 (up, this port is administratively down)',
    '  sfp1: this port is administratively down',
    '  The optic and the run are as above; those ports are why no frame crosses them.'
  ];
  for (const line of fenced) {
    ok(detail.indexOf(line) !== -1 || table.indexOf(line) !== -1,
      'the console still prints: ' + line.trim());
    ok(docsLines.indexOf(line) !== -1, 'and docs/CLI.md still quotes it verbatim');
  }

  // The far-end sentence is quoted inline in prose rather than in a fence, so it is found anywhere.
  runCommands(sw, t, sim, ['enable', 'configure terminal', 'interface sfp1', 'no shutdown', 'end']);
  runCommands(r, t, sim, ['enable', 'configure terminal', 'interface Te0/0/0', 'shutdown', 'end']);
  const farLine = 'sfp1: the far port Te0/0/0 on R2 is administratively down';
  ok(show(sw, t, sim, 'show interfaces transceiver').join('\n').indexOf(farLine) !== -1,
    'the console still names a shut far end: ' + farLine);
  ok(docs.indexOf(farLine) !== -1, 'and the doc still quotes that sentence');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
