'use strict';

// `encapsulation dot1q <vid> [native]` - the one optional word, and what it does (research note:
// research/encapsulation-dot1q-native.md).
//
// The vendor's syntax has one optional keyword. `native` "make[s] a subinterface the default handler of
// untagged packets coming to the port" (Catalyst 9600 17.15 VLAN Configuration Guide, Configuring Layer 3
// Subinterfaces), and the same page warns not to encapsulate the native VLAN without it. This console read
// `tokens[1]` and dropped the rest, so the word was accepted in silence: the receipt said the line had been
// taken, `show running-config` did not carry it, and the subinterface kept tagging frames that a real box
// would have sent untagged. Any other word - `flurbish`, or a second VLAN id - was dropped the same way.
//
// The load-bearing checks: the word is applied (the parent's native VLAN is the subinterface's VLAN, and the
// parent's own stanza does not grow a `switchport` line); a word that is not `native` is refused with the
// state unchanged; a second native subinterface is refused rather than silently moving the first; taking the
// line, the subinterface or the config back restores VLAN 1 as the native VLAN; and the difference is visible
// on the wire, which is the whole point of the keyword.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { Topology, Simulator, CliSession, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const ROUTER = catalog.find(function (s) { return s.vendor === 'generic' && s.model === 'generic-router'; });
const SWITCH = catalog.find(function (s) { return s.vendor === 'generic' && s.model === 'generic-switch'; });
const PC = catalog.find(function (s) { return s.vendor === 'generic' && s.model === 'generic-pc'; });

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

// The lines between `interface <name>` and the `!` that closes the stanza.
function stanza(cfg, name) {
  const lines = cfg.split('\n');
  const at = lines.findIndex(function (l) { return l.trim() === 'interface ' + name; });
  assert.notStrictEqual(at, -1, 'no `interface ' + name + '` stanza in:\n' + cfg);
  const out = [];
  for (let i = at + 1; i < lines.length && lines[i].trim() !== '!'; i++) out.push(lines[i].trim());
  return out;
}

// A router-on-a-stick: one host in VLAN 10 behind a trunk, the router's VLAN 10 on a subinterface.
function stick(native, switchNative) {
  const t = new Topology();
  const sw = t.addDevice(SWITCH, 'sw');
  const r = t.addDevice(ROUTER, 'r1');
  const pc = t.addDevice(PC, 'pc1');
  t.connect(pc.id, 'eth0', sw.id, 'Fa0/1');
  t.connect(sw.id, 'Fa0/8', r.id, 'Gi0/0');
  const sim = new Simulator(t);
  runCommands(sw, t, sim, ['configure terminal', 'vlan 10',
    'interface Fa0/1', 'switchport mode access', 'switchport access vlan 10', 'exit',
    'interface Fa0/8', 'switchport mode trunk', 'switchport trunk native vlan ' + switchNative]);
  runCommands(r, t, sim, ['configure terminal',
    'interface Gi0/0.10', 'encapsulation dot1q 10' + (native ? ' native' : ''),
    'ip address 192.168.10.1 255.255.255.0']);
  runCommands(pc, t, sim, ['configure terminal', 'interface eth0',
    'ip address 192.168.10.10 255.255.255.0', 'exit', 'ip default-gateway 192.168.10.1']);
  return { t: t, sw: sw, r: r, pc: pc, sim: sim };
}

test('native is accepted and the receipt says the word back', () => {
  const env = lab();
  env.run('interface Gi0/0.10');
  const out = env.run('encapsulation dot1q 10 native');
  assert.match(out, /encapsulation dot1q 10 native/, out);
  assert.doesNotMatch(out, /^%/m, 'no refusal: ' + out);
  assert.strictEqual(env.dev.interfaces.get('Gi0/0.10').encapVid, 10);
  assert.strictEqual(env.dev.interfaces.get('Gi0/0.10').encapNative, true);
});

test('it makes the subinterface the untagged handler on the parent', () => {
  const env = lab();
  env.run('interface Gi0/0.10');
  env.run('encapsulation dot1q 10 native');
  const parent = env.dev.interfaces.get('Gi0/0');
  assert.strictEqual(parent.vlan.mode, 'trunk', 'the parent is a trunk, as before');
  assert.strictEqual(parent.vlan.nativeVlan, 10, 'the parent files untagged frames under VLAN 10');
  assert.strictEqual(parent.vlan.pvid, 10, 'and its PVID agrees with its native VLAN');
});

test('the config prints the word once, on the subinterface', () => {
  const env = lab();
  env.run('interface Gi0/0.10');
  env.run('encapsulation dot1q 10 native');
  env.run('end');
  const cfg = env.run('show running-config');
  assert.deepStrictEqual(stanza(cfg, 'GigabitEthernet0/0.10'), ['encapsulation dot1q 10 native']);
  assert.deepStrictEqual(stanza(cfg, 'GigabitEthernet0/0'), ['switchport mode trunk'],
    'the parent does not grow a switchport trunk native line of its own:\n' + cfg);
});

test('a word that is neither the VLAN id nor native is refused', () => {
  const env = lab();
  env.run('interface Gi0/0.10');
  env.run('encapsulation dot1q 10 native');
  const out = env.run('encapsulation dot1q 20 flurbish');
  assert.match(out, /^%/, out);
  assert.match(out, /"flurbish"/, 'the word is named: ' + out);
  assert.match(out, /unchanged/, 'and nothing changed: ' + out);
  assert.strictEqual(env.dev.interfaces.get('Gi0/0.10').encapVid, 10, 'the VLAN is not changed');
  assert.strictEqual(env.dev.interfaces.get('Gi0/0.10').encapNative, true, 'nor the native claim');
  assert.strictEqual(env.dev.interfaces.get('Gi0/0').vlan.nativeVlan, 10);
});

test('native with a word after it is refused', () => {
  const env = lab();
  env.run('interface Gi0/0.10');
  const out = env.run('encapsulation dot1q 10 native 20');
  assert.match(out, /^%/, out);
  assert.match(out, /"20" was not used/, out);
  assert.strictEqual(env.dev.interfaces.get('Gi0/0.10').encapVid, 10,
    'the seeded VLAN id is untouched');
  assert.strictEqual(env.dev.interfaces.get('Gi0/0.10').encapNative, false);
});

test('a second native subinterface is refused, naming the first', () => {
  const env = lab();
  env.run('interface Gi0/0.10');
  env.run('encapsulation dot1q 10 native');
  env.run('interface Gi0/0.20');
  env.run('encapsulation dot1q 20');
  const out = env.run('encapsulation dot1q 20 native');
  assert.match(out, /^%/, out);
  assert.match(out, /Gi0\/0\.10 is already the native subinterface/, out);
  assert.match(out, /one native VLAN/, out);
  assert.strictEqual(env.dev.interfaces.get('Gi0/0.20').encapNative, false,
    'the second subinterface is not made native');
  assert.strictEqual(env.dev.interfaces.get('Gi0/0').vlan.nativeVlan, 10,
    'and the first keeps its claim');
});

test('typing the line without the word gives the untagged handling back', () => {
  const env = lab();
  env.run('interface Gi0/0.10');
  env.run('encapsulation dot1q 10 native');
  const out = env.run('encapsulation dot1q 10');
  assert.doesNotMatch(out, /^%/m, out);
  assert.strictEqual(env.dev.interfaces.get('Gi0/0.10').encapNative, false);
  assert.strictEqual(env.dev.interfaces.get('Gi0/0').vlan.nativeVlan, 1,
    'no explicitly defined native VLAN leaves VLAN 1 as the native VLAN');
  env.run('end');
  assert.deepStrictEqual(stanza(env.run('show running-config'), 'GigabitEthernet0/0.10'),
    ['encapsulation dot1q 10']);
});

test('removing the native subinterface gives the parent VLAN 1 back', () => {
  const env = lab();
  env.run('interface Gi0/0.10');
  env.run('encapsulation dot1q 10 native');
  env.run('exit');
  const out = env.run('no interface Gi0/0.10');
  assert.match(out, /Subinterface Gi0\/0\.10 removed/, out);
  assert.strictEqual(env.dev.interfaces.get('Gi0/0').vlan.nativeVlan, 1);
  assert.strictEqual(env.dev.interfaces.get('Gi0/0').vlan.pvid, 1);
});

test('the native claim survives save and load', () => {
  const env = lab();
  env.run('interface Gi0/0.10');
  env.run('encapsulation dot1q 10 native');
  env.run('ip address 192.168.10.1 255.255.255.0');
  env.run('end');
  const doc = JSON.parse(JSON.stringify(env.t.serialize()));
  const back = Topology.fromJSON(doc).getDevice('r1');
  assert.strictEqual(back.interfaces.get('Gi0/0.10').encapNative, true);
  assert.strictEqual(back.interfaces.get('Gi0/0.10').encapVid, 10);
  assert.strictEqual(back.interfaces.get('Gi0/0').vlan.nativeVlan, 10,
    'the parent came back with the same untagged VLAN');
});

test('on the wire, the native subinterface sends untagged frames', () => {
  // The far trunk's native VLAN is VLAN 1, so an untagged frame from the router is filed under VLAN 1 there and
  // the VLAN 10 host cannot answer: the packet left untagged because of the keyword, and nothing else changed.
  const tagged = stick(false, 1);
  const t1 = tagged.sim.ping(tagged.r.id, '192.168.10.10', { count: 2 });
  assert.deepStrictEqual(t1.replies.map(function (r) { return r.success; }), [true, true],
    'a tagged subinterface reaches the host');

  const native = stick(true, 1);
  const t2 = native.sim.ping(native.r.id, '192.168.10.10', { count: 2 });
  assert.deepStrictEqual(t2.replies.map(function (r) { return r.success; }), [false, false],
    'the native subinterface sent it untagged, and the far end files untagged as VLAN 1');

  // ...and when the far end's native VLAN is the same VLAN, the same lab works: the two ends agree on what an
  // untagged frame means.
  const agreed = stick(true, 10);
  const t3 = agreed.sim.ping(agreed.r.id, '192.168.10.10', { count: 2 });
  assert.deepStrictEqual(t3.replies.map(function (r) { return r.success; }), [true, true]);
});
