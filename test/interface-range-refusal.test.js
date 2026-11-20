'use strict';

// `interface range` is a command a box has, and this console answered as if a port were missing.
//
// The syntax is `interface range {port-range | macro macro_name}`: it enters interface-range configuration
// mode and applies each line typed there to every port in the range. Cisco's own example is
//
//   Device(config)# interface range tengigabitethernet 1/1/1-2
//   Device(config-if-range)# shut
//
// (Cisco IOS XE 17 Interface Characteristics Configuration Guide, "Example: Configuring a range of
// interfaces"), and the Catalyst 2960 command reference prints `Switch(config)# interface range
// gigabitethernet0/1 - 2` followed by `Switch(config-if-range)#`. This console opens one port per line and
// has no range mode, so the line cannot do what it says - but it used to read the keyword as a port name:
//
//   s1(config)# interface range Fa0/1 - 3
//   % Interface not found: range Fa0/1 - 3
//
// which is the sentence a misspelt socket gets, about a command the box really has. A reader goes looking
// for a socket called `range`. The refusal now names the command, in the shape of the `vlan 10-12` list
// refusal, and changes nothing. Evidence and what is still open are in
// research/interface-range-refusal.md.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { Topology, Simulator, CliSession } = require('../engine');
const { loadCatalog } = require('../devices/registry');

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const SWITCH = catalog.find(function (s) { return s.vendor === 'generic' && s.model === 'generic-switch'; });

function lab() {
  const t = new Topology();
  const dev = t.addDevice(SWITCH, 's1');
  const sim = new Simulator(t);
  const cli = new CliSession(dev, t, sim);
  const run = function (cmd) { return cli.run(cmd).output.join('\n'); };
  run('enable');
  run('configure terminal');
  run('hostname s1');
  return { t: t, dev: dev, sim: sim, cli: cli, run: run };
}

function isRangeRefusal(out, tail) {
  return out.indexOf('% interface range "' + tail + '" is not modelled') === 0 &&
    out.indexOf('no port was opened') !== -1 &&
    out.indexOf('Interface not found') === -1;
}

test('the range keyword is refused by name, not read as a missing port', function () {
  const s = lab();
  const forms = [
    'Fa0/1 - 3',
    'Fa0/1-3',
    'Fa0/1 , Fa0/3',
    'FastEthernet0/1 - 3',
    'macro UPLINK',
    'Fa0/1 - Fa0/3'
  ];
  for (const tail of forms) {
    const out = s.run('interface range ' + tail);
    assert.ok(isRangeRefusal(out, tail), 'interface range ' + tail + ' -> ' + JSON.stringify(out));
    // A refusal opens nothing and moves nothing: the cursor is still at global config.
    assert.strictEqual(s.cli.prompt(), 's1(config)#', 'still at (config)# after ' + tail);
    assert.strictEqual(s.cli.iface, null, 'no port was selected by ' + tail);
  }
});

test('the abbreviation of the command word reaches the same refusal', function () {
  const s = lab();
  const out = s.run('int range Fa0/1-3');
  assert.ok(isRangeRefusal(out, 'Fa0/1-3'), JSON.stringify(out));
  assert.strictEqual(s.cli.prompt(), 's1(config)#');
});

test('a bare `interface range` names the form a box takes instead of a missing socket', function () {
  const s = lab();
  const out = s.run('interface range');
  assert.match(out, /^% interface range is not modelled: a box takes `interface range <first> - <last>`/);
  assert.match(out, /no port was opened$/);
  assert.doesNotMatch(out, /Interface not found/);
  assert.strictEqual(s.cli.prompt(), 's1(config)#');
});

test('the help key is answered as the help key, not quoted as a range', function () {
  const s = lab();
  const out = s.run('interface range ?');
  assert.match(out, /^% "\?" is the help key, not a value: `interface range \{<first> - <last> \| macro <name>\}` is a command this console does not model/);
  assert.doesNotMatch(out, /is not modelled: a box takes/);
  assert.strictEqual(s.cli.prompt(), 's1(config)#');
});

test('typed from inside a port, the refusal leaves the cursor on that port', function () {
  const s = lab();
  assert.strictEqual(s.run('interface Fa0/1'), '');
  assert.strictEqual(s.cli.prompt(), 's1(config-if)#');
  const out = s.run('interface range Fa0/1-3');
  assert.ok(isRangeRefusal(out, 'Fa0/1-3'), JSON.stringify(out));
  assert.strictEqual(s.cli.prompt(), 's1(config-if)#', 'the refused line did not move the session');
  // The next line still lands on the port the operator was on, as a pasted block expects.
  s.run('description uplink to core');
  assert.strictEqual(s.dev.interfaces.get('Fa0/1').description, 'uplink to core');
});

test('`no interface range` says what it did not remove', function () {
  const s = lab();
  const out = s.run('no interface range Fa0/1-3');
  assert.match(out, /^% interface range "Fa0\/1-3" is not modelled/);
  assert.match(out, /nothing was removed$/);
  assert.doesNotMatch(out, /Interface not found/);
  const bare = s.run('no interface range');
  assert.match(bare, /^% interface range is not modelled/);
  assert.match(bare, /nothing was removed$/);
  assert.strictEqual(s.cli.prompt(), 's1(config)#');
});

test('the refusals write nothing into the configuration', function () {
  const s = lab();
  const before = s.run('show running-config');
  s.run('interface range Fa0/1 - 3');
  s.run('no interface range Fa0/1 - 3');
  assert.strictEqual(s.run('show running-config'), before);
});

test('the port-name door is unchanged: a range with no keyword is still a name', function () {
  const s = lab();
  const out = s.run('interface Fa0/1 - 3');
  assert.strictEqual(out, '% Interface not found: Fa0/1 - 3');
  const real = s.run('interface Fa0/2');
  assert.strictEqual(real, '');
  assert.strictEqual(s.cli.prompt(), 's1(config-if)#');
});
