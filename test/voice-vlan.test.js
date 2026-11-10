'use strict';
// voice-vlan.test.js - the field that was validated, stored, printed - and read by nothing (issue #1369).
//
// `voiceVlan` has been in the port config shape since VLANs were modelled. `normalizePortConfig`
// kept it, `validatePortConfig` insisted the port be a trunk ("voice traffic is tagged"), the
// switchport reset listed it when it cleared. Nothing *wrote* it - there was no `switchport voice
// vlan` - and nothing *read* it: classifyEgress/classifyIngress only ever consulted the allowed
// list, `show interfaces <port> switchport` printed `Voice VLAN: none` on every port in the lab,
// and serialize() dropped it, so a saved lab came back with no voice VLANs at all.
//
// What this pins: a command that writes it and refuses the numbers that are wrong, the classifier
// carrying it in both directions, one sentence on each surface (console and inspector), the line in
// `show running-config`, a save that restores it - and that it stays a *parameter* of the port, not
// a way of silently changing the port's mode.
const path = require('path');
const { Topology, Simulator, Device, runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');
const vlan = require('../engine/vlan');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + (actual === expected ? '' : ' (got ' + JSON.stringify(actual) +
    ', want ' + JSON.stringify(expected) + ')'));
}
function text(out) { return out && out.output ? out.output.join('\n') : String(out); }
function saw(re, out, msg) { ok(re.test(text(out)), msg + (re.test(text(out)) ? '' : ' (in ' + JSON.stringify(text(out).slice(0, 300)) + ')')); }
function absent(re, out, msg) { ok(!re.test(text(out)), msg + (re.test(text(out)) ? ' (unexpectedly matched)' : '')); }

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(name) {
  const s = catalog.find(function (x) { return x.model === name; });
  if (!s) throw new Error('missing spec ' + name);
  return s;
}

// One switch, one PC, and a console on the switch. Nothing is cabled: this is about the
// configuration and the classifier, not about a path.
function lab() {
  const t = new Topology();
  const sw = t.addDevice(spec('generic-switch')); sw.name = 'SW1';
  const pc = t.addDevice(spec('generic-pc')); pc.name = 'PC1';
  const sim = new Simulator(t);
  const s = new CliSession(sw, t, sim);
  s.run('enable');
  return { t: t, sw: sw, pc: pc, sim: sim, s: s };
}
function trunkPort(l, port) {
  // A trunk with an explicit allowed list: 10 and 30, so a voice VLAN outside it can be refused.
  return runCommands(l.sw, l.t, l.sim, ['configure terminal', 'interface ' + port,
    'switchport mode trunk', 'switchport trunk allowed vlan 10,30', 'exit']).lines;
}

console.log('The command exists, and it is where a phone port is configured:');
{
  // A phone port is an access port plus a tagged second VLAN - the phone tags its own traffic, the
  // PC behind it speaks untagged. So the command works on an access port, and it does not turn the
  // port into a trunk to do it.
  const l = lab();
  l.s.run('configure terminal'); l.s.run('interface Fa0/1');
  const wrote = l.s.run('switchport voice vlan 20');
  saw(/Voice VLAN 20 on Fa0\/1 \(tagged; the untagged traffic on this port stays in VLAN 1\)/, wrote,
    'an access port accepts a voice VLAN and says which VLAN stays untagged');
  eq(l.sw.interfaces.get('Fa0/1').vlan.voiceVlan, 20, 'and it was stored');
  eq(l.sw.interfaces.get('Fa0/1').vlan.mode, 'access', 'while the mode did not move');
  eq(l.sw.interfaces.get('Fa0/1').vlan.accessVlan, 1, 'nor the access VLAN');

  saw(/is the VLAN that leaves Fa0\/1 untagged \(the access VLAN\)/, l.s.run('switchport voice vlan 1'),
    'the access VLAN itself is refused, and the refusal says why');
  eq(l.sw.interfaces.get('Fa0/1').vlan.voiceVlan, 20, 'and that refusal stored nothing');
}

console.log('\n`show vlan` lists it as a membership of the port, not as decoration:');
{
  const l = lab();
  l.s.run('configure terminal'); l.s.run('interface Fa0/1');
  l.s.run('switchport access vlan 10');
  l.s.run('switchport voice vlan 20');
  l.s.run('exit'); l.s.run('end');
  const table = l.s.run('show vlan').output.join('\n');
  ok(/^20\s+VLAN0020\s+active\s+Fa0\/1\(v\)$/m.test(table),
    'the voice VLAN row names the port that carries it, marked (v)');
  ok(/^10\s+VLAN0010\s+active\s+Fa0\/1$/m.test(table),
    'while the data VLAN row names the same port untagged');
}

console.log('\nA number that is wrong is refused by naming what is wrong:');
{
  const l = lab();
  l.s.run('configure terminal'); l.s.run('interface Fa0/1');
  l.s.run('switchport mode trunk');
  l.s.run('switchport trunk allowed vlan 10,30');
  saw(/VLAN id must be a number, not "phone"/, l.s.run('switchport voice vlan phone'), 'a word is not a VLAN id');
  saw(/VLAN 0 is outside 1-4094/, l.s.run('switchport voice vlan 0'), 'VLAN 0 is out of range');
  saw(/VLAN 4095 is outside 1-4094/, l.s.run('switchport voice vlan 4095'), 'VLAN 4095 is out of range');
  saw(/Incomplete command: switchport voice vlan <id>/, l.s.run('switchport voice vlan'), 'a bare command says what it needs');
  saw(/Unexpected argument "30"/, l.s.run('switchport voice vlan 20 30'), 'a second argument is refused, not ignored');
  saw(/is the VLAN that leaves Fa0\/1 untagged \(the native VLAN\)/, l.s.run('switchport voice vlan 1'),
    'the native VLAN cannot also be the voice VLAN');
  saw(/not in the allowed list/, l.s.run('switchport voice vlan 20'),
    'a voice VLAN the trunk does not carry is refused');
  saw(/switchport trunk allowed vlan 10,20,30/, l.s.run('switchport voice vlan 20'),
    'and the refusal prints the exact command that fixes it');
}

console.log('\nIt is a parameter of the port, not a mode:');
{
  const l = lab();
  trunkPort(l, 'Fa0/1');
  const before = JSON.parse(JSON.stringify(l.sw.interfaces.get('Fa0/1').vlan));
  runCommands(l.sw, l.t, l.sim, ['configure terminal', 'interface Fa0/1',
    'switchport voice vlan 30', 'exit']).lines;
  const after = l.sw.interfaces.get('Fa0/1').vlan;
  eq(after.voiceVlan, 30, 'the voice VLAN was written');
  eq(after.mode, before.mode, 'and the mode did not change');
  eq(after.nativeVlan, before.nativeVlan, 'nor the native VLAN');
  eq(JSON.stringify(after.allowedVlans), JSON.stringify(before.allowedVlans), 'nor the allowed list');

  const s = runCommands(l.sw, l.t, l.sim, ['enable', 'show interfaces Fa0/1 switchport']).lines.join('\n');
  ok(/Voice VLAN: 30 \(tagged\)/.test(s), 'the console sentence names it, and says it is tagged');
  ok(!/Voice VLAN: none/.test(s), 'and does not also print `none`');
  const rg = runCommands(l.sw, l.t, l.sim, ['enable', 'show running-config']).lines.join('\n');
  ok(/switchport voice vlan 30/.test(rg), '`show running-config` prints the line a paste would need');
}

console.log('\nThe classifier carries it, in both directions:');
{
  // A trunk that carries 10 and 30, with voice on 30. Built through the library rather than the
  // console, because the point here is the classifier's own answer.
  const cfg = vlan.normalizePortConfig({ mode: 'trunk', nativeVlan: 10, allowedVlans: [10, 30], voiceVlan: 30 });
  const voiceOut = vlan.classifyEgress(cfg, 30);
  eq(voiceOut.action, 'tagged', 'a frame for the voice VLAN leaves tagged');
  eq(voiceOut.voice, true, 'and is marked as voice traffic');
  eq(vlan.classifyEgress(cfg, 10).action, 'untagged', 'the native VLAN still leaves untagged');
  eq(vlan.classifyEgress(cfg, 20).action, 'drop', 'a VLAN the trunk does not carry is still dropped');

  const inVoice = vlan.classifyIngress(cfg, { tagged: true, vid: 30 });
  eq(inVoice.action, 'accept', 'a tagged frame in the voice VLAN is accepted');
  eq(inVoice.vlanId, 30, 'into the voice VLAN');
  eq(inVoice.voice, true, 'and is marked as voice traffic');
  eq(vlan.classifyIngress(cfg, { tagged: false }).vlanId, 10, 'an untagged frame still lands in the native VLAN');
  eq(vlan.classifyIngress(cfg, { tagged: true, vid: 20 }).reason, 'vlan-not-allowed',
    'and a tagged frame in a VLAN the trunk does not carry is still refused');

  // Voice wins over the native rule: a file that carries both numbers as one VLAN must not strip the
  // tag that identifies the traffic. (The console refuses to create this pair; a hand-edited lab can
  // still contain it, and the classifier answers it rather than choosing silently.)
  const legacy = vlan.normalizePortConfig({ mode: 'trunk', nativeVlan: 20, allowedVlans: [20], voiceVlan: 20 });
  eq(vlan.classifyEgress(legacy, 20).action, 'tagged', 'voice beats native when both name one VLAN');
  ok(!vlan.validatePortConfig({ mode: 'trunk', nativeVlan: 20, allowedVlans: [20], voiceVlan: 20 }).ok,
    'and that pair is refused by validation rather than only handled at the classifier');

  // A phone on an access port: untagged data, tagged voice. `validatePortConfig` warns that voice
  // wants a trunk, but a lab file can hold it and the classifier must still classify it.
  const phone = { mode: 'access', accessVlan: 10, voiceVlan: 20 };
  eq(vlan.classifyEgress(phone, 20).action, 'tagged', 'the voice VLAN leaves tagged on an access port too');
  eq(vlan.classifyEgress(phone, 10).action, 'untagged', 'while the data VLAN leaves untagged');
  eq(vlan.classifyIngress(phone, { tagged: true, vid: 20 }).vlanId, 20, 'and its tagged frames are accepted');
  eq(vlan.classifyIngress(phone, { tagged: true, vid: 99 }).reason, 'tagged-frame-on-access',
    'while any other tag is still refused on an access port');
}

console.log('\nRemoving it is as narrow as setting it:');
{
  const l = lab();
  trunkPort(l, 'Fa0/1');
  runCommands(l.sw, l.t, l.sim, ['configure terminal', 'interface Fa0/1', 'switchport voice vlan 30']).lines;
  const gone = runCommands(l.sw, l.t, l.sim, ['configure terminal', 'interface Fa0/1',
    'no switchport voice vlan']).lines;
  ok(/Voice VLAN removed from Fa0\/1 \(was VLAN 30/.test(gone.join('\n')), 'the removal says what it removed');
  eq(l.sw.interfaces.get('Fa0/1').vlan.voiceVlan, null, 'and the field is clear');
  eq(l.sw.interfaces.get('Fa0/1').vlan.mode, 'trunk', 'while the trunk stayed a trunk');
  saw(/no voice VLAN - nothing to remove/, runCommands(l.sw, l.t, l.sim,
    ['configure terminal', 'interface Fa0/1', 'no switchport voice vlan']).lines,
    'removing it twice says so instead of inventing a removal');
}

console.log('\nA reset clears it, and a save restores it:');
{
  const l = lab();
  trunkPort(l, 'Fa0/1');
  runCommands(l.sw, l.t, l.sim, ['configure terminal', 'interface Fa0/1', 'switchport voice vlan 30']).lines;
  const saved = JSON.parse(JSON.stringify(l.sw.serialize()));
  const savedIface = saved.interfaces.filter(function (i) { return i.name === 'Fa0/1'; })[0];
  eq(savedIface.vlan.voiceVlan, 30, 'the file carries it');

  // Reload it the way the board does: Topology.fromJSON() over the saved file, which is the only
  // path a lab actually takes (`POST /load`, and every restart).
  const board = JSON.parse(JSON.stringify(l.t.serialize()));
  const t2 = Topology.fromJSON(board);
  const sw2 = t2.getDevice(l.sw.id);
  eq(sw2.interfaces.get('Fa0/1').vlan.voiceVlan, 30, 'and the reload restores it');
  const s2 = new CliSession(sw2, t2, new Simulator(t2));
  s2.run('enable');
  saw(/Voice VLAN: 30/, s2.run('show interfaces Fa0/1 switchport'), 'so the console after a reload still prints it');
  saw(/switchport voice vlan 30/, s2.run('show running-config'), 'and the dump still has the line');

  runCommands(sw2, t2, null, ['configure terminal', 'interface Fa0/1', 'switchport reset']);
  eq(sw2.interfaces.get('Fa0/1').vlan.voiceVlan, null, 'a switchport reset clears it');
}

console.log('\nAn old file, with no voice VLAN in it, still loads:');
{
  // A file written before this field existed has no `voiceVlan` key at all, and one hand-written by
  // the UI may carry a zero. Neither may become NaN, and neither may turn into a voice VLAN.
  const t = new Topology();
  const sw = t.addDevice(spec('generic-switch'), 'd-old');
  const board = JSON.parse(JSON.stringify(t.serialize()));
  const name = board.devices[0].interfaces[0].name;
  delete board.devices[0].interfaces[0].vlan.voiceVlan;
  board.devices[0].interfaces[0].vlan.mode = 'trunk';
  const old = Topology.fromJSON(board).getDevice('d-old');
  eq(old.interfaces.get(name).vlan.voiceVlan, null,
    'a port config with no voiceVlan restores as none, not as NaN');

  const board3 = JSON.parse(JSON.stringify(t.serialize()));
  board3.devices[0].interfaces[0].vlan.voiceVlan = 0;
  const zero = Topology.fromJSON(board3).getDevice('d-old');
  eq(zero.interfaces.get(name).vlan.voiceVlan, null,
    'and a zero in the file means none, the same as normalizePortConfig()');
}

console.log('\nThe help page offers the command:');
{
  const l = lab();
  const help = runCommands(l.sw, l.t, l.sim, ['enable', 'configure terminal', 'interface Fa0/1', '?']).lines.join('\n');
  ok(/switchport voice vlan <id>/.test(help), 'the interface help lists switchport voice vlan <id>');

  // The absent-command table is what an operator typing `show switchport` is sent to, so it has to
  // name the view that carries this line.
  const redirect = runCommands(l.sw, l.t, l.sim, ['enable', 'show switchport']).lines.join('\n');
  ok(/show interfaces <port> switchport/.test(redirect), '`show switchport` still points at the L2 view');
  const l2 = runCommands(l.sw, l.t, l.sim, ['enable', 'show interfaces Fa0/1 switchport']).lines.join('\n');
  ok(/Voice VLAN:/.test(l2), 'and that view carries the voice VLAN line');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
