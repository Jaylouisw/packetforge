'use strict';
// A serial link's clock was invisible in three places at once (#1483).
//
// The cable that landed in #1483 refuses to exist without exactly one clocked end - `E_SERIAL_NO_CLOCK`, answered at
// cabling time with the command that fixes it. The clock itself lived on the interface object and nowhere else:
//
//   serialize()          the port document had speedMbps, natRole, maxRangeM ... and no clockRateBps
//   running-config       `clock rate 64000` took effect and left no line behind
//   show interfaces      "speed: 1.544Mb/s (auto), link runs at 0Mb/s" - a T1 rounded to 2M, a 64 kbps line to 0M
//
// So a saved WAN lab reopened unclocked, its own cable became invalid, traffic stopped, and the two number-shaped
// statements a reader was given were both false. This is the fifth time the save path has dropped a per-port fact
// (#1405 speed, #1459 spec, #1465 DHCP leases, #1467 LLDP neighbours), which is why the check below is written
// against a document round trip rather than against the field on its own.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const media = require('../engine/media');
const { loadCatalog } = require('../devices/registry');
const { validateTopology } = require('../engine/validation');
const cliModule = require('../engine/cli');
const CliSession = cliModule.CliSession || cliModule;

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const ROOT = path.join(__dirname, '..');
const catalog = loadCatalog(path.join(ROOT, 'devices'));
function spec(m) { return catalog.find(function (x) { return x.model === m; }); }

// Two 2811s back to back over a V.35 cable: the classic first WAN lab.
function lab(opts) {
  opts = opts || {};
  const t = new Topology();
  t.addDevice(spec('2811'), 'r1');
  t.addDevice(spec('2811'), 'r2');
  const cfg = function (id, lines) { runCommands(t.getDevice(id), t, null, ['configure terminal'].concat(lines)); };
  const clockLine = opts.clock === null ? [] : ['clock rate ' + (opts.clock || 64000)];
  cfg('r1', ['interface Se0/0/0', 'ip address 10.9.0.1 255.255.255.0', 'no shutdown'].concat(clockLine).concat(['end']));
  cfg('r2', ['interface Se0/0/0', 'ip address 10.9.0.2 255.255.255.0', 'no shutdown', 'end']);
  if (opts.connect !== false) t.connect('r1', 'Se0/0/0', 'r2', 'Se0/0/0', { mediaId: 'serial-v35' });
  return t;
}
const run = function (t, dev, cmd) {
  const sim = new Simulator(t);
  return ((new CliSession(t.getDevice(dev), t, sim).run(cmd) || {}).output || []).join('\n');
};
const linkOf = function (t) { return t.links.get(Array.from(t.links.keys())[0]) || null; };
const clockOf = function (t, dev, name) {
  const d = t.getDevice(dev);
  return d ? d.interfaces.get(name).clockRateBps : undefined;
};
const portDoc = function (doc, dev, name) {
  const d = (doc.devices || []).find(function (x) { return x.id === dev; });
  return (d && (d.interfaces || []).find(function (i) { return i.name === name; })) || {};
};
const reopen = function (t) { return Topology.fromJSON(JSON.parse(JSON.stringify(t.serialize()))); };
const issueCodes = function (t) {
  const v = validateTopology(t);
  return (v.issues || []).map(function (i) { return i.code; });
};

console.log('');
console.log('The document carries the clock, and only when there is one:');
{
  const t = lab();
  const doc = t.serialize();
  ok(portDoc(doc, 'r1', 'Se0/0/0').clockRateBps === 64000, 'the clocked end saves its rate',
    String(portDoc(doc, 'r1', 'Se0/0/0').clockRateBps));
  ok(portDoc(doc, 'r2', 'Se0/0/0').clockRateBps === undefined,
    'a DTE port grows no clockRateBps key at all, rather than a null on every port in the catalogue',
    JSON.stringify(portDoc(doc, 'r2', 'Se0/0/0').clockRateBps));
  // ...and a port that never had one stays clean in a lab with no serial link either.
  const noSerial = new Topology();
  noSerial.addDevice(spec('generic-switch'), 's1');
  const plain = portDoc(noSerial.serialize(), 's1', 'Fa0/1');
  ok(!Object.prototype.hasOwnProperty.call(plain, 'clockRateBps'), 'and an ordinary ethernet port never carries it',
    Object.keys(plain).join(','));
}

console.log('');
console.log('A reopened WAN lab is still a WAN lab:');
{
  const t = lab();
  const before = {
    clock: clockOf(t, 'r1', 'Se0/0/0'), rate: linkOf(t).speedMbps,
    verdict: issueCodes(t), ping: /Success rate is (\d+)/.exec(run(t, 'r1', 'ping 10.9.0.2 1'))
  };
  const t2 = reopen(t);
  const after = {
    clock: clockOf(t2, 'r1', 'Se0/0/0'), rate: linkOf(t2).speedMbps,
    verdict: issueCodes(t2), ping: /Success rate is (\d+)/.exec(run(t2, 'r1', 'ping 10.9.0.2 1'))
  };
  ok(before.ping && before.ping[1] === '100', 'the lab answers before saving', String(before.ping && before.ping[0]));
  ok(after.clock === 64000, 'the clock is back on the port', String(after.clock));
  ok(after.rate === before.rate, 'and the line still runs at the clock, not at the port maximum',
    before.rate + ' -> ' + after.rate);
  ok(after.rate === 0.064, 'which is 64 kbps', String(after.rate));
  ok(after.verdict.length === 0, 'the reopened cable is still valid', after.verdict.join(',') || 'clean');
  ok(after.ping && after.ping[1] === '100', 'and traffic still crosses it', String(after.ping && after.ping[0]));
  // The failure this fix removes, stated as its own assertion: strip the field the old save path dropped, and the
  // reopened cable is exactly as invalid as it used to be - that is what made the bug expensive, quietly.
  const stripped = JSON.parse(JSON.stringify(lab().serialize()));
  const port = stripped.devices.find(function (d) { return d.id === 'r1'; })
    .interfaces.find(function (i) { return i.name === 'Se0/0/0'; });
  delete port.clockRateBps;
  ok(issueCodes(Topology.fromJSON(stripped)).indexOf('E_SERIAL_NO_CLOCK') !== -1,
    'and a document missing the clock really is invalid on reopen, which is what the dropped field produced',
    issueCodes(Topology.fromJSON(stripped)).join(','));
}

console.log('');
console.log('The config says who clocks the line:');
{
  const t = lab();
  const cfg = run(t, 'r1', 'show running-config');
  ok(/interface Se0\/0\/0/.test(cfg), 'the port has a config block');
  ok(/^\s+clock rate 64000$/m.test(cfg), 'with the clock rate in it, at the rate that was typed', cfg.split('\n').filter(function (l) { return /clock/.test(l); }).join(' | '));
  ok(!/clock rate/.test(run(t, 'r2', 'show running-config')), 'and the DTE end claims no clock');
  ok(/^\s+clock rate 64000$/m.test(run(reopen(t), 'r1', 'show running-config')),
    'which survives the round trip, so a backup restores a clocked link');
  // `no clock rate` clears it, in the config and in the document.
  const cleared = lab();
  runCommands(cleared.getDevice('r1'), cleared, null, ['configure terminal', 'interface Se0/0/0', 'no clock rate', 'end']);
  ok(!/clock rate/.test(run(cleared, 'r1', 'show running-config')), 'no clock rate removes the line from the config');
  ok(portDoc(cleared.serialize(), 'r1', 'Se0/0/0').clockRateBps === undefined, 'and from the document');
}

console.log('');
console.log('A rate is printed in a unit that does not lie:');
{
  const cases = [
    [1.544, '1.544M'], [0.064, '64K'], [0.1152, '115.2K'], [0.0096, '9.6K'],
    [10, '10M'], [100, '100M'], [1000, '1G'], [2500, '2.5G'], [10000, '10G'], [1000000, '1T']
  ];
  const wrong = cases.filter(function (c) { return media.formatSpeedMbps(c[0]) !== c[1]; })
    .map(function (c) { return c[0] + ' -> ' + media.formatSpeedMbps(c[0]) + ' (wanted ' + c[1] + ')'; });
  ok(wrong.length === 0, 'every rate keeps its own unit and its own digits', wrong.join('; '));
  ok(media.formatSpeedMbps(1.544) !== '2M', 'a T1 is not rounded up to 2M');
  ok(media.formatSpeedMbps(0.064) !== '0M', 'and a 64 kbps line is not reported as zero');
  ok(media.formatSpeedMbps(null) === null, 'no rate still prints null');
}

console.log('');
console.log('show interfaces names the rate and the clock:');
{
  const t = lab();
  const block = run(t, 'r1', 'show interfaces Se0/0/0');
  ok(/speed: 1\.544Mb\/s \(auto\)/.test(block), 'the port states its own rated speed exactly',
    block.split('\n').filter(function (l) { return /speed/.test(l); }).join(' | '));
  ok(/link runs at 64Kb\/s/.test(block), 'the line states the rate it actually runs at', block.split('\n').filter(function (l) { return /link runs/.test(l); }).join(' | '));
  ok(!/0Mb\/s/.test(block), 'and never claims a live link runs at zero');
  ok(/DCE, clock rate 64000/.test(block), 'and says that this end is the one clocking it', block.split('\n').filter(function (l) { return /DCE/.test(l); }).join(' | '));
  const dte = run(t, 'r2', 'show interfaces Se0/0/0');
  ok(!/DCE/.test(dte), 'the far end does not claim the clock', dte.split('\n').filter(function (l) { return /speed/.test(l); }).join(' | '));
  ok(/link runs at 64Kb\/s/.test(dte), 'though it does see the rate it receives at');
  // After a reopen, the same block - the view reads the state, not the session that configured it.
  const again = run(reopen(t), 'r1', 'show interfaces Se0/0/0');
  ok(/DCE, clock rate 64000/.test(again), 'and the reopened lab prints the same block', again.split('\n').filter(function (l) { return /DCE/.test(l); }).join(' | '));
}

console.log('');
console.log('A hand-edited document cannot invent a clock:');
{
  const t = lab();
  const doc = JSON.parse(JSON.stringify(t.serialize()));
  const port = doc.devices.find(function (d) { return d.id === 'r1'; }).interfaces.find(function (i) { return i.name === 'Se0/0/0'; });
  port.clockRateBps = 'fast';
  ok(clockOf(Topology.fromJSON(doc), 'r1', 'Se0/0/0') === undefined, 'a clock rate that is not a number is not restored');
  port.clockRateBps = -64000;
  ok(clockOf(Topology.fromJSON(doc), 'r1', 'Se0/0/0') === undefined, 'and neither is a negative one');
  port.clockRateBps = 64000.7;
  ok(clockOf(Topology.fromJSON(doc), 'r1', 'Se0/0/0') === 64001, 'a fractional rate is rounded like the command rounds it',
    String(clockOf(Topology.fromJSON(doc), 'r1', 'Se0/0/0')));
}

console.log('');
console.log('Saving a reopened lab changes nothing:');
{
  const t = lab();
  const once = t.serialize();
  const twice = reopen(t).serialize();
  ok(JSON.stringify(twice) === JSON.stringify(once),
    'the document is byte-identical after a load and a save, so a lab file stays diffable in git');
  const thrice = Topology.fromJSON(JSON.parse(JSON.stringify(twice))).serialize();
  ok(JSON.stringify(thrice) === JSON.stringify(once), 'and again a third time');
}

console.log('');
if (failed) {
  console.error(passed + ' passed, ' + failed + ' failed');
  process.exit(1);
}
console.log(passed + ' passed, 0 failed');
