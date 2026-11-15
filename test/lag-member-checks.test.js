'use strict';
// The per-member LAG checks exist and never ran (#1524).
//
// `engine/lag.js` validates each member's rate, duplex and VLAN set, but the one caller that builds a
// bundle - the `channel-group` handler - passed no memberPorts, so every one of those loops was skipped.
// A bundle of ports that cannot carry traffic the same way was accepted with a receipt and no word:
//
//   Interface Fa0/1 added to channel group 1 (mode active)
//
// ...and the mismatch then showed up as intermittent, half-working traffic that `show etherchannel
// summary` reads as a healthy bundle, because every member is up and every member is forwarding.
//
// What is locked here:
//   1. members running at different rates are named, with both rates;
//   2. members configured half-duplex against full-duplex are named;
//   3. members that file frames into different VLANs are named;
//   4. an administratively down member is named as carrying nothing;
//   5. a correctly built bundle stays completely silent, because a warning on every correct command is a
//      refusal that has learned to whisper.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];

function ports(dev) {
  return [...dev.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
}

// Two switches, two cables between them: room for a two-member bundle.
function lab() {
  const t = new Topology();
  const a = t.addDevice(SWITCH, 'sw1');
  const b = t.addDevice(SWITCH, 'sw2');
  const pa = ports(a);
  const pb = ports(b);
  t.connect('sw1', pa[0].name, 'sw2', pb[0].name);
  t.connect('sw1', pa[1].name, 'sw2', pb[1].name);
  const sim = new Simulator(t);
  const s = new CliSession(a, t, sim);
  s.run('enable');
  s.run('configure terminal');
  return { t: t, a: a, b: b, sim: sim, s: s, pa: pa };
}

function say(env, cmd) {
  return ((env.s.run(cmd).output) || []).map(String);
}

function warnings(lines) {
  return lines.filter(function (l) { return /^% Warning:/.test(l); });
}

console.log('');
console.log('Members at different rates are named, with both rates:');
{
  const env = lab();
  say(env, 'interface ' + env.pa[0].name);
  say(env, 'speed 100');
  const out = [].concat(say(env, 'channel-group 1 mode active'),
    say(env, 'interface ' + env.pa[1].name),
    say(env, 'channel-group 1 mode active'));
  const w = warnings(out);
  ok(w.some(function (l) { return /member speeds differ \(100\/1000 Mbps\)/.test(l); }),
    'the mismatch is reported, naming both member rates', JSON.stringify(w));
  ok(w.some(function (l) { return /all members must run at the same link speed/.test(l); }),
    'and it says what the rule is', JSON.stringify(w));
  ok(w.some(function (l) { return /^% Warning: LAG 1: /.test(l); }),
    'and names the group the operator typed, not a default', JSON.stringify(w));
}

console.log('');
console.log('Members with different duplex settings are named:');
{
  const env = lab();
  say(env, 'interface ' + env.pa[0].name);
  say(env, 'duplex half');
  const out = [].concat(say(env, 'channel-group 1 mode active'),
    say(env, 'interface ' + env.pa[1].name),
    say(env, 'channel-group 1 mode active'));
  const w = warnings(out);
  ok(w.some(function (l) { return /member duplex settings differ \(full\/half\)/.test(l); }),
    'the mismatch is reported, naming both duplex settings', JSON.stringify(w));
}

console.log('');
console.log('Members that would file frames into different VLANs are named:');
{
  const env = lab();
  say(env, 'interface ' + env.pa[0].name);
  say(env, 'switchport access vlan 10');
  say(env, 'channel-group 1 mode active');
  say(env, 'interface ' + env.pa[1].name);
  say(env, 'switchport access vlan 20');
  const out = say(env, 'channel-group 1 mode active');
  const w = warnings(out);
  ok(w.some(function (l) { return /VLAN-compatible/.test(l); }),
    'the mismatch is reported', JSON.stringify(w));
  ok(w.some(function (l) { return /every member must be in the same VLAN set/.test(l); }),
    'and it says what the rule is', JSON.stringify(w));
}

console.log('');
console.log('A member that is administratively down is named:');
{
  const env = lab();
  say(env, 'interface ' + env.pa[0].name);
  say(env, 'channel-group 1 mode active');
  say(env, 'interface ' + env.pa[1].name);
  say(env, 'shutdown');
  const out = say(env, 'channel-group 1 mode active');
  const w = warnings(out);
  ok(w.some(function (l) { return /administratively down and carries no traffic/.test(l); }),
    'the shut member is reported as carrying nothing', JSON.stringify(w));
}

console.log('');
console.log('A correct bundle says nothing:');
{
  const env = lab();
  const out = [].concat(say(env, 'interface ' + env.pa[0].name),
    say(env, 'channel-group 1 mode active'),
    say(env, 'interface ' + env.pa[1].name),
    say(env, 'channel-group 1 mode active'));
  ok(warnings(out).length === 0, 'no warning on a healthy two-member bundle', JSON.stringify(out));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
