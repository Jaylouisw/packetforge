'use strict';

// The interface TYPE, shortened. `interface g1/0/1` is `interface GigabitEthernet1/0/1` on a real
// box: IOS abbreviates every keyword to the number of characters that keep it unique, and the type
// word in an interface name is a keyword. Cisco's own platform guide types the command as
// `interface g 0/1/0` and the check as `show interface g0/1/0` (Cisco Embedded Service 6300 Series
// Software Configuration Guide, "Configuring Ethernet Switch Ports"), and a Catalyst 6500 config in
// Cisco's support library opens `interface g0/12` (Port-Security for mobile devices as laptops).
//
// This console refused every prefix shorter than the documented `gi`/`ga` spellings until now; the
// record of why it was left alone is research/interface-type-spellings.md, and this file holds the
// rule that replaced it:
//
//   * a prefix expands to the ONE type the device actually carries (`g` -> gigabitethernet on the
//     2960-X, `f` -> fastethernet and `s` -> serial on a 2811), attached or spaced, and on a
//     subinterface as well as a port;
//   * a prefix that could mean two types on that device resolves to neither - a guessed port is
//     worse than a refusal;
//   * a prefix that names no type the device has is still refused;
//   * the expansion never reaches a name the table does not know: a UniFi "Port 1" is not `p1`,
//     and it is not `po1` either;
//   * the panel spelling still prints, so a running-config built from a shortened command replays.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { Topology, Simulator, CliSession } = require('../engine');
const { loadCatalog } = require('../devices/registry');
const ifaceName = require('../engine/iface-name');

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });

function specFor(model) {
  const spec = catalog.find(function (s) { return s.model === model; });
  assert.ok(spec, 'the catalogue has ' + model);
  return spec;
}

function open(model, id) {
  const t = new Topology();
  const dev = t.addDevice(specFor(model), id || 'd1');
  const cli = new CliSession(dev, t, new Simulator(t));
  cli.run('enable');
  cli.run('configure terminal');
  return {
    t: t,
    dev: dev,
    cli: cli,
    run: function (cmd) { return cli.run(cmd).output.join('\n'); }
  };
}

test('a one-letter type opens the port on a switch whose only G-type is gigabitethernet', function () {
  const s = open('C2960X-24TS-L');
  assert.strictEqual(s.run('interface g1/0/1'), '', 'g1/0/1 is not refused');
  assert.ok(s.cli.prompt().endsWith('(config-if)#'), 'the prompt is the interface prompt');
  s.run('description shortened');
  s.run('end');
  assert.match(s.run('show running-config'), /^interface Gi1\/0\/1$/m, 'the config keeps the panel spelling');
  assert.match(s.run('show interfaces g1/0/1'), /desc: shortened/, 'and the shortened name reads the same port back');
});

test('a longer prefix, and the space form, are the same command', function () {
  const s = open('C2960X-24TS-L');
  assert.strictEqual(s.run('interface gig1/0/24'), '');
  assert.strictEqual(s.cli.prompt().indexOf('(config-if)') !== -1, true);
  s.run('exit');
  assert.strictEqual(s.run('interface g 1/0/2'), '', 'type and number may be separated');
  assert.strictEqual(s.dev.interfaces.get('Gi1/0/2').name, 'Gi1/0/2');
});

test('a prefix resolves to the type this device carries, not to a Cisco default', function () {
  // The 2811 has Fa0/0 and Fa0/1 and Se0/0/0: `f` is fastethernet and `s` is serial on it.
  const s = open('2811');
  assert.strictEqual(s.run('interface f0/1'), '');
  assert.match(s.cli.prompt(), /\(config-if\)#$/);
  s.run('exit');
  assert.strictEqual(s.run('interface s0/0/0'), '');
  assert.match(s.run('show running-config'), /^interface Se0\/0\/0$/m);
});

test('a shortened type works on a subinterface', function () {
  const s = open('C2960X-24TS-L');
  const out = s.run('interface g1/0/24.10');
  assert.match(out, /Created subinterface Gi1\/0\/24\.10/, 'the child is created under the panel name');
  assert.match(s.cli.prompt(), /\(config-subif\)#$/);
});

test('a prefix that could be two types on the same box is refused, not guessed', function () {
  // No catalogue device has two types sharing a leading letter, so the ambiguity is built here:
  // TenGigabitEthernet and TwentyFiveGigE both answer to `t`.
  const twoT = { interfaces: new Map([['Te1/0/1', {}], ['Twe1/0/2', {}]]) };
  assert.strictEqual(ifaceName.resolvePortName(twoT, 't1/0/1'), null, 't is ambiguous');
  assert.strictEqual(ifaceName.resolvePortName(twoT, 'te1/0/1'), 'Te1/0/1', 'te is unique');
  assert.strictEqual(ifaceName.resolvePortName(twoT, 'tw1/0/2'), 'Twe1/0/2', 'tw is unique');
});

test('a prefix that names no type the device has is still refused', function () {
  const s = open('C2960X-24TS-L');
  assert.match(s.run('interface x1/0/1'), /% Interface not found: x1\/0\/1/, 'no type starts with x');
  // The 2960-X has no fastethernet port at all, so `f` names no type it carries.
  assert.match(s.run('interface f1/0/1'), /% Interface not found: f1\/0\/1/);
});

test('the expansion cannot invent a socket the naming table refuses to fold', function () {
  // Ubiquiti prints "Port 1"; it is not a `port-channel` and must not be reachable as Po1 or p1.
  const u = { interfaces: new Map([['Port 1', {}], ['SFP+ 1', {}]]) };
  assert.strictEqual(ifaceName.resolvePortName(u, 'p1'), null);
  assert.strictEqual(ifaceName.resolvePortName(u, 'po1'), null);
  const sfp = { interfaces: new Map([['SFP+1', {}]]) };
  assert.strictEqual(ifaceName.resolvePortName(sfp, 'sfp-sfpplus1'), 'SFP+1', 'the documented spelling still folds');
});

test('a view word is not a port, shortened or not', function () {
  const s = open('C2960X-24TS-L');
  s.run('exit');
  assert.match(s.run('show interfaces status'), /is a view, not a port/);
});
