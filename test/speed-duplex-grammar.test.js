'use strict';
// What may follow the first word of `speed` and `duplex` - and what the `no` forms take.
//
// The vendor's syntax lines are one line each (Catalyst 2960-X 15.2(6)E command reference, Interface and
// Hardware Commands, `speed` and `duplex`):
//
//   speed { 10 | 100 | 1000 | 2500 | 5000 | auto [ 10 | 100 | 1000 | 2500 | 5000 ] | nonegotiate }
//   no speed
//   duplex { auto | full | half }
//   no duplex { auto | full | half }
//
// so exactly one shape carries a second word (`auto` followed by the rates it may advertise), one keyword is
// real but unimplemented (`nonegotiate`), and the `no` forms differ from each other: `no speed` takes nothing
// while `no duplex` takes the same three words as the positive form.
//
// This console read the first word and dropped the rest, and four orders lied in silence:
//
//   `speed 100 flurbish`   forced 100 Mb/s and never mentioned a word a real box rejects at parse time
//   `speed auto 10`        answered as a plain `speed auto`, which is a different setting on hardware
//   `speed nonegotiate`    called a legal keyword an "Invalid rate"
//   `no speed flurbish`    returned the port to autonegotiation anyway
//
// Every refusal below names the word back, says what it did not do, and leaves the port exactly as it was -
// the rule `ip address <ip> <mask> <word>` already follows (#1493, #1495).
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
function section(name) { console.log('\n' + name); }

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.filter(function (s) { return s.model === 'Catalyst2960'; })[0];
// A router with serial ports: the control for 'the line is parsed before the port is asked'.
const ROUTER = catalog.filter(function (s) { return s.model === '2811'; })[0];

function lab(spec) {
  const t = new Topology();
  const d = t.addDevice(spec || SWITCH, 'sw');
  const sim = new Simulator(t);
  const ports = [...d.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
  const port = ports[0].name;
  return {
    t: t, d: d, sim: sim, port: port,
    run: function (lines) {
      return runCommands(d, t, sim, ['enable', 'configure terminal', 'interface ' + port]
        .concat(lines).concat(['end'])).lines;
    },
    // What the console says about the port now, and whether the configuration moved.
    probe: function (lines) {
      const before = runCommands(d, t, sim, ['show running-config']).lines.join('\n');
      const said = this.run(lines).filter(function (l) { return /^\s*%/.test(l); });
      const after = runCommands(d, t, sim, ['show running-config']).lines.join('\n');
      return { said: said, changed: before !== after, iface: d.interfaces.get(port) };
    }
  };
}

// ---------------------------------------------------------------------------
section('a word after the rate is a parse error, and the rate does not move');
{
  const e = lab();
  const before = e.d.interfaces.get(e.port).speedMbps;
  ok(before === null, 'the port starts negotiating (no forced rate)', String(before));

  const bad = e.probe(['speed 100 flurbish']);
  ok(bad.said.length === 1, 'a word after `speed 100` is refused', JSON.stringify(bad.said));
  ok(/flurbish/.test(bad.said.join(' ')), 'and the refusal names the word back', bad.said.join(' '));
  ok(/takes one rate/.test(bad.said.join(' ')), 'as a parse error, not as a rate the port lacks',
    bad.said.join(' '));
  ok(e.d.interfaces.get(e.port).speedMbps === null, 'and the port is still negotiating',
    String(e.d.interfaces.get(e.port).speedMbps));
  ok(!bad.changed, 'nothing was written to the configuration');

  // A rate is a word too: the syntax line has no second position, so `speed 100 1000` is refused as well.
  const second = e.probe(['speed 100 1000']);
  ok(second.said.length === 1 && /1000/.test(second.said.join(' ')),
    'a second rate after the first is refused and named', second.said.join(' '));
  ok(e.d.interfaces.get(e.port).speedMbps === null, 'and neither rate was applied',
    String(e.d.interfaces.get(e.port).speedMbps));

  // The valid form still sets it, and a refusal after that leaves the forced rate alone.
  e.run(['speed 100']);
  ok(e.d.interfaces.get(e.port).speedMbps === 100, '`speed 100` sets it',
    String(e.d.interfaces.get(e.port).speedMbps));
  const after = e.probe(['speed auto flurbish']);
  ok(after.said.length === 1, 'a non-rate word after `speed auto` is refused', JSON.stringify(after.said));
  ok(e.d.interfaces.get(e.port).speedMbps === 100, 'and the forced 100 Mb/s survives it',
    String(e.d.interfaces.get(e.port).speedMbps));

  const block = runCommands(e.d, e.t, e.sim, ['show interfaces ' + e.port]).lines;
  ok(block.some(function (l) { return l.indexOf('Fa0/1 (ethernet') === 0; }),
    'the port still answers about itself', JSON.stringify(block.slice(-4)));
}

// ---------------------------------------------------------------------------
section('`speed auto <rates>` is real syntax, and this console says it has not got it');
{
  const e = lab();
  e.run(['speed 100']);
  const subset = e.probe(['speed auto 10']);
  ok(subset.said.length === 1, '`speed auto 10` is refused rather than silently reduced to `speed auto`',
    JSON.stringify(subset.said));
  ok(/not modelled/.test(subset.said.join(' ')), 'and the answer says it is not modelled, which it is',
    subset.said.join(' '));
  ok(/10/.test(subset.said.join(' ')), 'naming the rates that were typed', subset.said.join(' '));
  ok(e.d.interfaces.get(e.port).speedMbps === 100, 'the port keeps the rate it had',
    String(e.d.interfaces.get(e.port).speedMbps));
  ok(!subset.changed, 'and nothing was written');

  const two = e.probe(['speed auto 10 100']);
  ok(/10 100/.test(two.said.join(' ')), 'both rates are quoted back', two.said.join(' '));
  ok(e.d.interfaces.get(e.port).speedMbps === 100, 'and the port still holds 100 Mb/s',
    String(e.d.interfaces.get(e.port).speedMbps));

  // `speed auto` on its own is the setting this console does have.
  e.run(['speed auto']);
  ok(e.d.interfaces.get(e.port).speedMbps === null, '`speed auto` alone still returns it to negotiation',
    String(e.d.interfaces.get(e.port).speedMbps));
}

// ---------------------------------------------------------------------------
section('`speed nonegotiate` is a real keyword, so it is not an invalid rate');
{
  const e = lab();
  const got = e.probe(['speed nonegotiate']);
  const said = got.said.join(' ');
  ok(got.said.length === 1, 'it is refused', JSON.stringify(got.said));
  ok(!/Invalid rate/.test(said), 'and no longer called an invalid rate', said);
  ok(/not modelled/.test(said), 'the answer says the console does not model it', said);
  ok(/nonegotiate/.test(said), 'and names the keyword', said);
  ok(e.d.interfaces.get(e.port).speedMbps === null, 'nothing was set',
    String(e.d.interfaces.get(e.port).speedMbps));
  ok(!got.changed, 'and the configuration is unchanged');
}

// ---------------------------------------------------------------------------
section('`no speed` takes nothing, and `no duplex` takes its own three words');
{
  const e = lab();
  e.run(['speed 100']);
  const noSpeed = e.probe(['no speed flurbish']);
  ok(noSpeed.said.length === 1, '`no speed flurbish` is refused', JSON.stringify(noSpeed.said));
  ok(/flurbish/.test(noSpeed.said.join(' ')), 'naming the word', noSpeed.said.join(' '));
  ok(e.d.interfaces.get(e.port).speedMbps === 100, 'and the forced rate is still there',
    String(e.d.interfaces.get(e.port).speedMbps));
  ok(!noSpeed.changed, 'nothing was written');

  e.run(['no speed']);
  ok(e.d.interfaces.get(e.port).speedMbps === null, '`no speed` alone still returns it to negotiation',
    String(e.d.interfaces.get(e.port).speedMbps));

  // duplex: force half on a 100 Mb/s port (a 1000BASE-T port refuses `duplex half` by design).
  ok(e.d.interfaces.get(e.port).hardware.speedCaps.indexOf(100) !== -1, 'the port offers 100 Mb/s',
    JSON.stringify(e.d.interfaces.get(e.port).hardware.speedCaps));
  e.run(['speed 100', 'duplex half']);
  ok(e.d.interfaces.get(e.port).duplex === 'half', 'the port is in half duplex',
    e.d.interfaces.get(e.port).duplex);

  const bad = e.probe(['no duplex flurbish']);
  ok(bad.said.length === 1, '`no duplex flurbish` is refused', JSON.stringify(bad.said));
  ok(/auto, full or half/.test(bad.said.join(' ')), 'and the answer lists the words it takes',
    bad.said.join(' '));
  ok(e.d.interfaces.get(e.port).duplex === 'half', 'the half-duplex setting survives it',
    e.d.interfaces.get(e.port).duplex);

  // `no duplex half` is real syntax: it does not mean "unset half", it means "back to the default", auto.
  e.run(['no duplex half']);
  ok(e.d.interfaces.get(e.port).duplex === 'full', '`no duplex half` returns the port to auto (full)',
    e.d.interfaces.get(e.port).duplex);
  e.run(['duplex half']);
  e.run(['no duplex']);
  ok(e.d.interfaces.get(e.port).duplex === 'full', 'and `no duplex` on its own does the same',
    e.d.interfaces.get(e.port).duplex);

  const after = e.probe(['no duplex full extra']);
  ok(after.said.length === 1 && /extra/.test(after.said.join(' ')),
    'a word after `no duplex <mode>` is refused and named', after.said.join(' '));
}

// ---------------------------------------------------------------------------
section('a word after the duplex mode is refused, and the mode does not move');
{
  const e = lab();
  e.run(['speed 100', 'duplex half']);
  const bad = e.probe(['duplex full flurbish']);
  ok(bad.said.length === 1, '`duplex full flurbish` is refused', JSON.stringify(bad.said));
  ok(/flurbish/.test(bad.said.join(' ')), 'naming the word', bad.said.join(' '));
  ok(e.d.interfaces.get(e.port).duplex === 'half', 'and the port is still in half duplex',
    e.d.interfaces.get(e.port).duplex);
  ok(!bad.changed, 'nothing was written');

  e.run(['duplex full']);
  ok(e.d.interfaces.get(e.port).duplex === 'full', '`duplex full` still sets it',
    e.d.interfaces.get(e.port).duplex);
}

// ---------------------------------------------------------------------------
section('the stray word is a parse error before the port is consulted');
{
  // A serial port has no line rate at all, so a capability refusal exists for it: `speed 100` there answers
  // about the port. A trailing word is a parse error, and a box parses the line before it asks the port.
  const t = new Topology();
  const r = t.addDevice(ROUTER, 'r1');
  const sim = new Simulator(t);
  const serialPort = [...r.interfaces.values()].filter(function (i) { return i.type === 'serial'; })[0];
  ok(!!serialPort, 'the router model has a serial port');
  if (serialPort) {
    const lines = runCommands(r, t, sim, ['enable', 'configure terminal', 'interface ' + serialPort.name,
      'speed 100 flurbish']).lines;
    const said = lines.filter(function (l) { return /^\s*%/.test(l); }).join(' ');
    ok(/flurbish/.test(said), 'the stray word is what the answer is about', said);
  }
}

// ---------------------------------------------------------------------------
section('');
if (failed) {
  console.error(passed + ' passed, ' + failed + ' failed');
  process.exit(1);
}
console.log(passed + ' passed, 0 failed');
