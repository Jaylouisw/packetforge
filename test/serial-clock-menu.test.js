'use strict';
// What `clock rate` accepts on a serial port (#2126).
//
// The console checked the typed number against the port's *link-speed* ladder - the six rates
// the serial cage lists (64k, 128k, 256k, 512k, 1.024M, 1.544M on a 2811) - so it refused
// 9600, 19200, 38400, 72000, 125000, 128000, 148000, 250000, 500000, 800000 and 1000000,
// every one of which a Cisco serial port's own `clock rate ?` prints as a value it takes:
//
//   Router(config-if)#clock rate ?
//   Speed (bits per second)
//   1200 2400 4800 9600 19200 38400 56000 64000 72000 125000 148000 250000 500000
//   800000 1000000 1300000 2000000 4000000
//   <300-4000000> Choose clockrate from list above
//
// The `<300-4000000>` line is the parser's other half: any whole number of bits per second in
// the range is accepted, and one that is not on the menu is rounded to the nearest rate the
// hardware supports, with the command reference's console line
//   `%Clockrate rounded to nearest value that your hardware can support.`
// Sources and the parts still open: research/serial-clock-menu.md.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + ' (expected ' + JSON.stringify(expected) +
    ', got ' + JSON.stringify(actual) + ')');
}
function section(name) { console.log('\n' + name); }

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(model) { return catalog.find(function (x) { return x.model === model; }); }

// The vendor's menu as the transcripts print it, and the rate the 2811's Se ports declare.
const MENU = [1200, 2400, 4800, 9600, 19200, 38400, 56000, 64000, 72000, 125000, 128000,
  148000, 250000, 500000, 800000, 1000000, 1300000, 2000000, 4000000];
const PORT_TOP = 1544000;
const ROUNDED = '%Clockrate rounded to nearest value that your hardware can support.';

// One session, one port, so a command's effect is the port's state afterwards.
function open() {
  const t = new Topology();
  const r = t.addDevice(spec('2811'), 'r1');
  const sim = new Simulator(t);
  const s = new CliSession(r, t, sim);
  s.run('enable');
  s.run('configure terminal');
  s.run('interface Se0/0/0');
  return {
    t: t, sim: sim, r: r, s: s,
    run: function (cmd) { return String(((s.run(cmd).output) || []).join('\n')); },
    clock: function () { return r.interfaces.get('Se0/0/0').clockRateBps; }
  };
}

section('1. Every standard rate the port reaches is accepted, as typed');
{
  const env = open();
  MENU.filter(function (r) { return r <= PORT_TOP; }).forEach(function (rate) {
    const out = env.run('clock rate ' + rate);
    eq(env.clock(), rate, rate + ' bps is stored on the port');
    ok(out.indexOf('Clock rate set to ' + rate + ' bps') !== -1, 'and confirmed at that rate');
    ok(out.indexOf('Clockrate rounded') === -1, 'and not reported as rounded');
  });
}

section('2. The port\'s own declared line rate is still a rate it can clock');
{
  const env = open();
  const out = env.run('clock rate 1544000');
  eq(env.clock(), 1544000, 'T1 is accepted verbatim');
  ok(/Clock rate set to 1544000 bps/.test(out), 'with the console\'s own confirmation');
}

section('3. A standard rate above the port is refused, and the refusal quotes the range');
{
  const env = open();
  MENU.filter(function (r) { return r > PORT_TOP; }).forEach(function (rate) {
    const out = env.run('clock rate ' + rate);
    ok(new RegExp('% ' + rate + ' bps is outside the range Se0/0/0 can clock \\(300-1544000 bps\\)').test(out),
      rate + ' bps is refused with the range it enforces');
    eq(env.clock(), undefined, 'and nothing is stored for it');
  });
}

section('4. The stated range is the enforced range');
{
  const env = open();
  ok(/% 299 bps is outside the range Se0\/0\/0 can clock \(300-1544000 bps\)/.test(env.run('clock rate 299')),
    '299 bps is refused, one below the low edge');
  const atLow = env.run('clock rate 300');
  ok(atLow.indexOf('outside the range') === -1, '300 bps is inside the range');
  ok(env.clock() >= 300 && env.clock() <= PORT_TOP, 'and it lands on a rate the port lists', String(env.clock()));
  env.run('clock rate 1544000');
  eq(env.clock(), 1544000, 'the top edge is accepted');
  ok(/outside the range/.test(env.run('clock rate 1544001')), 'one above the top edge is refused');
}

section('5. A value inside the range that is not on the menu is rounded, in the box\'s words');
{
  const env = open();
  const out = env.run('clock rate 1234567').trim();
  eq(out, ROUNDED, 'the console line is the command reference\'s, verbatim');
  eq(env.clock(), 1300000, 'and the port takes the nearest rate it lists');
  env.run('end');
  const running = env.run('show running-config');
  ok(/^ {2}clock rate 1300000$/m.test(running), 'running-config prints the rounded rate',
    running.split('\n').filter(function (l) { return /clock/.test(l); }).join(' | '));
  ok(running.indexOf('1234567') === -1, 'and not the number that was typed');
  ok(/DCE, clock rate 1300000/.test(env.run('show interfaces Se0/0/0')),
    'the port\'s own block prints it too');
}

section('6. Rounding goes the short way, at both ends of the menu');
{
  const env = open();
  const cases = [[999, 1200], [2000, 2400], [100000, 125000], [1400000, 1300000]];
  cases.forEach(function (pair) {
    env.run('clock rate ' + pair[0]);
    eq(env.clock(), pair[1], pair[0] + ' bps rounds to ' + pair[1]);
  });
}

section('7. A refused rate changes nothing, and the clock can still be cleared');
{
  const env = open();
  env.run('clock rate 64000');
  env.run('clock rate 9000000');
  eq(env.clock(), 64000, 'a refused rate leaves the clock alone');
  env.run('clock rate nonsense');
  eq(env.clock(), 64000, 'and so does a word');
  env.run('no clock rate');
  eq(env.clock(), null, 'no clock rate clears it');
}

section('8. The clock is still the link\'s rate, at a menu rate');
{
  const t = new Topology();
  const r1 = t.addDevice(spec('2811'), 'r1');
  const r2 = t.addDevice(spec('2811'), 'r2');
  const sim = new Simulator(t);
  const s1 = new CliSession(r1, t, sim);
  const s2 = new CliSession(r2, t, sim);
  [s1, s2].forEach(function (s) { s.run('enable'); s.run('configure terminal'); });
  s1.run('interface Se0/0/0');
  s1.run('clock rate 9600');
  s1.run('ip address 10.9.0.1 255.255.255.252');
  s1.run('no shutdown');
  s2.run('interface Se0/0/0');
  s2.run('ip address 10.9.0.2 255.255.255.252');
  s2.run('no shutdown');
  const v = t.validateLink(r1.id, 'Se0/0/0', r2.id, 'Se0/0/0');
  ok(v.errors.length === 0, 'a link clocked at 9600 bps is a valid link',
    v.errors.map(function (e) { return e.code; }).join(', '));
  eq(v.speedMbps, 0.0096, 'and the link runs at 9.6 kbps');
  t.connect('r1', 'Se0/0/0', 'r2', 'Se0/0/0');
  const ping = (s1.run('end') && s1.run('ping 10.9.0.2 3').output || []).join('\n');
  ok(/Success rate is 100 percent \(3\/3\)/.test(ping), 'and it carries the pings', ping);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
