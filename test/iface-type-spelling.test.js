'use strict';

// One port, several spellings - the TYPE half of it.
//
// The naming table in engine/iface-name.js folded vendors' console spellings onto the panel
// spelling (ether1 -> eth1, sfp-sfpplus1 -> SFP+1), and had no notion that the interface TYPE
// also has more than one spelling. So `interface Gi1/0/1` opened a Catalyst port and
// `interface GigabitEthernet1/0/1` - the spelling every Cisco document writes and every
// `show running-config` prints, i.e. the one an operator is most likely to paste - was
// refused with "% Interface not found". Cisco states the rule in the same sentence that
// documents the space: "you can specify either gigabitethernet 0/1, gigabitethernet0/1,
// gi 0/1, or gi0/1" (Configuring Interface Characteristics, Catalyst Digital Building
// Series 15.2(6)E).
//
// What is held here: the four documented spellings are one port, on a box whose catalogue
// name is short (Cisco) and on one whose name is long (Huawei); a name typed the long way
// prints the panel spelling afterwards, so the running-config it produces still replays; a
// subinterface can be created through the long name; and the fold cannot invent a socket -
// a Ubiquiti "Port 1" is not reachable as Po1, and a type that is not the port's type is
// still refused. Partial spellings (Gig1/0/1) are no longer one of them: a shortened type expands
// against the types the device actually has, which is its own question and its own file -
// test/iface-type-prefix.test.js (research/interface-type-spellings.md records the evidence).

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { Topology, Simulator, CliSession } = require('../engine');
const { loadCatalog } = require('../devices/registry');
const ifaceName = require('../engine/iface-name');

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));

function specFor(model) {
  const spec = catalog.find(function (s) { return s.model === model; });
  assert.ok(spec, 'the catalogue has ' + model);
  return spec;
}

function open(model, id) {
  const t = new Topology();
  const dev = t.addDevice(specFor(model), id || 'd1');
  const sim = new Simulator(t);
  const cli = new CliSession(dev, t, sim);
  return {
    t: t,
    dev: dev,
    cli: cli,
    run: function (cmd) { return cli.run(cmd).output.join('\n'); }
  };
}

const catalyst = 'C2960X-24TS-L';

test('the four documented spellings of one port share a key', function () {
  const forms = ['GigabitEthernet1/0/1', 'gigabitethernet1/0/1', 'GigabitEthernet 1/0/1', 'gi 1/0/1', 'GI1/0/1'];
  for (const f of forms) {
    assert.strictEqual(ifaceName.portKey(f), ifaceName.portKey('Gi1/0/1'), f + ' is the same port as Gi1/0/1');
  }
  assert.strictEqual(ifaceName.foldInterfaceType('GigabitEthernet1/0/1'), 'gigabitethernet1/0/1');
  assert.strictEqual(ifaceName.foldInterfaceType('Ten-GigabitEthernet0/16'), 'tengigabitethernet0/16');
  // A name the table does not know passes through unchanged (lowercased: it is a key, not a
  // panel name) - SFP+1 and SFP1 stay two ports.
  assert.strictEqual(ifaceName.foldInterfaceType('SFP+1'), 'sfp+1');
  assert.strictEqual(ifaceName.foldInterfaceType('sfp28-1'), 'sfp28-1');
  assert.notStrictEqual(ifaceName.portKey('SFP+1'), ifaceName.portKey('SFP1'));
});

test('on a Catalyst, the long name opens the port the catalogue calls Gi1/0/1', function () {
  const s = open(catalyst);
  s.run('enable');
  s.run('configure terminal');
  assert.strictEqual(s.run('interface GigabitEthernet1/0/1'), '', 'no refusal');
  assert.match(s.cli.prompt(), /\(config-if\)#$/, 'the prompt is the interface prompt');
  s.run('description uplink to core');
  s.run('end');
  const conf = s.run('show running-config');
  assert.match(conf, /^interface Gi1\/0\/1$/m, 'the running-config uses the panel spelling');
  assert.doesNotMatch(conf, /^interface GigabitEthernet1\/0\/1$/m, 'and never the typed one');
  assert.match(s.run('show interfaces Gi1/0/1'), /desc: uplink to core/, 'the description landed on the port');
});

test('the space form is the same command', function () {
  const s = open(catalyst);
  s.run('enable');
  s.run('configure terminal');
  assert.strictEqual(s.run('interface GigabitEthernet 1/0/2'), '');
  s.run('description spaced');
  s.run('end');
  assert.match(s.run('show interfaces Gi1/0/2'), /desc: spaced/);
});

test('a subinterface can be created through the long name', function () {
  const s = open(catalyst);
  s.run('enable');
  s.run('configure terminal');
  s.run('interface GigabitEthernet1/0/3.10');
  assert.match(s.cli.prompt(), /\(config-subif\)#$/, 'a subinterface prompt');
  assert.ok(s.dev.interfaces.has('Gi1/0/3.10'), 'it is on the parent the panel names');
});

test('show interfaces answers the long name and prints the panel name', function () {
  const s = open(catalyst);
  s.run('enable');
  const out = s.run('show interfaces GigabitEthernet 1/0/4');
  assert.match(out, /^Gi1\/0\/4 /, 'the block is about the one port asked for');
  assert.doesNotMatch(out, /Gi1\/0\/5/, 'and not its neighbour');
});

test('a box whose own ports are named GE accepts the long name', function () {
  const s = open('S5735-L24T4S');
  s.run('enable');
  s.run('configure terminal');
  assert.strictEqual(s.run('interface GigabitEthernet0/0/1'), '', 'the vendor full name resolves');
  s.run('description huawei uplink');
  s.run('end');
  assert.match(s.run('show interfaces GE0/0/1'), /desc: huawei uplink/, 'it landed on the GE port');
});

test('the type has to be the port own type', function () {
  const arista = open('7280R3-48YC8');
  arista.run('enable');
  arista.run('configure terminal');
  assert.strictEqual(arista.run('interface Et1'), '', 'Arista abbreviates Ethernet as Et');
  assert.strictEqual(arista.run('interface Ethernet2'), '', 'and spells it out');
  arista.run('end');
  assert.match(arista.run('show interfaces Ethernet1'), /^Ethernet1 /);
  // GigabitEthernet is not an Ethernet port under another name, and a box with no Gi ports
  // must not grow one.
  arista.run('configure terminal');
  assert.match(arista.run('interface Gi1'), /% Interface not found: Gi1/);
});

test('the fold cannot invent a socket that the box never had', function () {
  const s = open('UCG-Fiber');
  s.run('enable');
  s.run('configure terminal');
  // UniFi ports are silkscreened "Port 1"; Po1 is Port-channel 1 on a Cisco and nothing here.
  assert.match(s.run('interface Po1'), /% Interface not found: Po1/);
  assert.match(s.run('interface Port-channel1'), /% Interface not found: Port-channel1/);
  assert.strictEqual(s.run('interface Port 1'), '', 'the panel spelling still works');
});

test('a cable saved under the long name lands on the panel name', function () {
  const t = new Topology();
  t.addDevice(specFor(catalyst), 'sw1');
  t.addDevice(specFor(catalyst), 'sw2');
  const link = t.connect('sw1', 'GigabitEthernet1/0/24', 'sw2', 'GigabitEthernet1/0/24');
  assert.ok(link, 'the cable was made');
  assert.strictEqual(link.a.iface, 'Gi1/0/24', 'stored under the name the box uses');
  assert.strictEqual(link.b.iface, 'Gi1/0/24');
});

test('a partial type spelling opens the port too, on the rule its own file holds', function () {
  const s = open(catalyst);
  s.run('enable');
  s.run('configure terminal');
  assert.strictEqual(s.run('interface Gig1/0/1'), '', 'Gig1/0/1 is the documented long name, shortened');
  assert.ok(s.cli.prompt().endsWith('(config-if)#'), 'and it is the interface prompt');
});
