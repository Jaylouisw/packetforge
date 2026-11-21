'use strict';

// A subinterface number is a name, not a VLAN id (#2260).
//
// `interface Gi0/0.10` plus `encapsulation dot1q 10` is how this console models a router-on-a-stick
// VLAN interface, and the two numbers were treated as one value: the name after the dot was checked
// against the 802.1Q range 1-4094, so `interface Gi0/0.5000` - a legal subinterface on IOS - was
// refused with `% VLAN out of range: 5000`, and a `.9999` was answered with a VLAN error for a number
// that was never a VLAN.
//
// On a box the number after the dot runs 1 to 4294967293 and the VLAN is set by `encapsulation dot1q`
// (1 to 4094); the number does not have to match, and Cisco's own Q-in-Q tables map one subinterface to
// a whole range of VLANs. Evidence and the platform differences are in
// research/subinterface-number.md.
//
// The load-bearing checks: a number above 4094 opens and carries no tag until one is typed, the tag is
// the one `encapsulation dot1q` names and not the name, a number outside 1-4294967293 is refused as a
// number, and the one-line form this model has always answered (`.10` with no encapsulation line) still
// writes `encapsulation dot1q 10` into running-config.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { Topology, Simulator, CliSession } = require('../engine');
const { loadCatalog } = require('../devices/registry');

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const ROUTER = catalog.find(function (s) { return s.vendor === 'generic' && s.model === 'generic-router'; });

function lab() {
  const t = new Topology();
  const dev = t.addDevice(ROUTER, 'r1');
  const sim = new Simulator(t);
  const cli = new CliSession(dev, t, sim);
  const run = function (cmd) { return cli.run(cmd).output.join('\n'); };
  run('enable');
  run('configure terminal');
  run('hostname r1');
  return { t: t, dev: dev, sim: sim, cli: cli, run: run };
}

// The lines between `interface <name>` and the `!` that closes the stanza, exactly as an operator
// copies them out of `show running-config`.
function stanza(cfg, name) {
  const lines = cfg.split('\n');
  const at = lines.findIndex(function (l) { return l.trim() === 'interface ' + name; });
  assert.notStrictEqual(at, -1, 'no `interface ' + name + '` stanza in:\n' + cfg);
  const out = [];
  for (let i = at + 1; i < lines.length && lines[i].trim() !== '!'; i++) out.push(lines[i].trim());
  return out;
}

test('a subinterface number above the VLAN range opens', () => {
  const env = lab();
  const out = env.run('interface Gi0/0.5000');
  assert.match(out, /Created subinterface Gi0\/0\.5000/, out);
  assert.strictEqual(env.cli.prompt(), 'r1(config-subif)#', 'a subinterface, not a physical port');
  assert.ok(env.dev.interfaces.has('Gi0/0.5000'), 'the port exists');
});

test('a subinterface above 4094 carries no tag until one is typed', () => {
  const env = lab();
  env.run('interface Gi0/0.5000');
  env.run('ip address 10.9.0.1 255.255.255.0');
  env.run('end');
  assert.strictEqual(env.dev.interfaces.get('Gi0/0.5000').encapVid, null,
    'the number is not a VLAN id');
  const cfg = env.run('show running-config');
  const body = stanza(cfg, 'GigabitEthernet0/0.5000');
  assert.ok(body.some(function (l) { return l === 'ip address 10.9.0.1 255.255.255.0'; }),
    'the address is in the stanza: ' + body.join(' | '));
  assert.ok(!body.some(function (l) { return /^encapsulation dot1q/.test(l); }),
    'no encapsulation line is invented: ' + body.join(' | '));
});

test('the tag is the one encapsulation names, not the number', () => {
  const env = lab();
  env.run('interface Gi0/0.5000');
  const out = env.run('encapsulation dot1q 100');
  assert.match(out, /encapsulation dot1q 100/, out);
  assert.strictEqual(env.dev.interfaces.get('Gi0/0.5000').encapVid, 100);
  env.run('end');
  const cfg = env.run('show running-config');
  const body = stanza(cfg, 'GigabitEthernet0/0.5000');
  assert.deepStrictEqual(body, ['encapsulation dot1q 100'],
    'one line, the one that was typed: ' + body.join(' | '));
});

test('an encapsulation VLAN outside 1-4094 is still refused', () => {
  const env = lab();
  env.run('interface Gi0/0.5000');
  assert.strictEqual(env.run('encapsulation dot1q 5000'), '% VLAN out of range: 5000');
  assert.strictEqual(env.run('encapsulation dot1q 4095'), '% VLAN out of range: 4095');
  assert.strictEqual(env.run('encapsulation dot1q 4094'), 'Subinterface Gi0/0.5000 encapsulation dot1q 4094');
});

test('a number outside 1-4294967293 is refused as a number', () => {
  const env = lab();
  assert.strictEqual(env.run('interface Gi0/0.0'), '% Subinterface number out of range: 0');
  assert.strictEqual(env.run('interface Gi0/0.4294967294'),
    '% Subinterface number out of range: 4294967294');
  // The ceiling itself is a name a box opens (Cisco IOS `interface`, subinterface-number 1-4294967293).
  assert.match(env.run('interface Gi0/0.4294967293'), /Created subinterface Gi0\/0\.4294967293/);
  assert.strictEqual(env.cli.prompt(), 'r1(config-subif)#', 'refusals above did not move the mode');
});

test('the one-line router-on-a-stick form still prints its encapsulation', () => {
  const env = lab();
  env.run('interface Gi0/0.10');
  env.run('end');
  const body = stanza(env.run('show running-config'), 'GigabitEthernet0/0.10');
  assert.deepStrictEqual(body, ['encapsulation dot1q 10'],
    'a number that can be a VLAN id still seeds one: ' + body.join(' | '));
});

test('a .5000 subinterface is listed with its address', () => {
  const env = lab();
  env.run('interface Gi0/0.5000');
  env.run('encapsulation dot1q 100');
  env.run('ip address 10.9.0.1 255.255.255.0');
  env.run('end');
  const brief = env.run('show ip interface brief');
  // `GigabitEthernet0/0.5000` would be 23 characters - the width of the Interface field - so the row
  // abbreviates the type word, as a box does at that boundary
  // (research/interface-brief-type-abbreviation.md).
  assert.match(brief, /^Gi0\/0\.5000\s+10\.9\.0\.1\s+YES manual/m, brief);
});

test('a .5000 subinterface survives save and load', () => {
  const env = lab();
  env.run('interface Gi0/0.5000');
  env.run('encapsulation dot1q 100');
  env.run('ip address 10.9.0.1 255.255.255.0');
  env.run('interface Gi0/0.6000');
  env.run('end');
  const json = JSON.parse(JSON.stringify(env.t.serialize()));
  const t2 = Topology.fromJSON(json);
  const r2 = t2.getDevice(env.dev.id);
  assert.ok(r2.interfaces.has('Gi0/0.5000'), 'the tagged subinterface came back');
  assert.strictEqual(r2.interfaces.get('Gi0/0.5000').encapVid, 100);
  assert.strictEqual(r2.interfaces.get('Gi0/0.5000').ip, '10.9.0.1');
  assert.ok(r2.interfaces.has('Gi0/0.6000'), 'the untagged one came back too');
  assert.strictEqual(r2.interfaces.get('Gi0/0.6000').encapVid, null);
});
