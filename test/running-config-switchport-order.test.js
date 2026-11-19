'use strict';
// The order of the switchport lines in a `show running-config` interface block.
//
// PacketForge printed `switchport mode <x>` first, then the VLAN parameters, then the voice VLAN - the order
// the code happens to hold them in. A real IOS switch prints the parameters first, then the mode they select,
// and the voice line last, so a reader comparing a lab against any vendor sample, or pasting the block into a
// real box beside one, saw a block recognisably not the same shape. Two Cisco-published `show running-config`
// samples fix the order (research/running-config-switchport-order.md):
//
//   interface GigabitEthernet1/1              interface GigabitEthernet1/4
//    switchport access vlan 2                  switchport trunk encapsulation dot1q
//    switchport mode access                    switchport trunk native vlan 4
//    switchport port-security                  switchport mode trunk
//    ...                                       switchport nonegotiate
//
//   interface GigabitEthernet2/2
//    switchport access vlan 2
//    switchport mode access
//    switchport voice vlan 3
//
// `switchport trunk allowed vlan` was the one line no sample showed when this test was written. A later
// capture does show it - Cisco support doc 68100, `show running-config interface gigabitethernet 2/1` on a
// Catalyst: trunk encapsulation, trunk native vlan 999, trunk allowed vlan 1,81,82,171,999, mode trunk
// (research/running-config-switchport-order.md). It follows the native VLAN, which is where the engine put it,
// so the order is observed now and the assertion below pins both halves of it.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];

function lab() {
  const t = new Topology();
  const d = t.addDevice(SWITCH, 'sw');
  const sim = new Simulator(t);
  return {
    t: t, d: d, sim: sim,
    run: function (lines) { return runCommands(d, t, sim, lines).lines; },
    config: function () { return runCommands(d, t, sim, ['enable', 'show running-config']).lines; }
  };
}

// The lines of one interface's block, prompts and the closing `!` separator stripped.
// The stanza header is the vendor's full type word (`interface FastEthernet0/1`), so the block is
// matched on the port KEY rather than on the string: `Fa0/1` and `FastEthernet0/1` are one port, and
// this test is about the order of the lines, not about the spelling of the header
// (research/running-config-interface-name.md).
const ifaceName = require('../engine/iface-name');
function block(lines, name) {
  const out = [];
  let inside = false;
  for (const raw of lines) {
    const line = String(raw).replace(/^.*?#\s*/, '');
    const m = /^interface (.+)$/.exec(line);
    if (m) { inside = ifaceName.portKey(m[1]) === ifaceName.portKey(name); continue; }
    if (!inside) continue;
    if (/^!$/.test(line) || /^exit$/.test(line)) break;
    if (line.trim()) out.push(line.trim());
  }
  return out;
}

function setConfig(lines) {
  return ['enable', 'configure terminal'].concat(lines).concat(['end']);
}

console.log('');
console.log('An access port prints its VLAN before the mode that selects it:');
{
  const env = lab();
  env.run(setConfig([
    'interface Fa0/1', 'switchport mode access', 'switchport access vlan 20', 'exit',
    'interface Fa0/2', 'switchport access vlan 30', 'switchport mode access', 'switchport voice vlan 40',
    'end'
  ]));
  const cfg = env.config();

  const one = block(cfg, 'Fa0/1');
  ok(one[0] === 'switchport access vlan 20', 'access VLAN is the first switchport line', JSON.stringify(one));
  ok(one[1] === 'switchport mode access', 'and `switchport mode access` follows it', JSON.stringify(one));

  const phone = block(cfg, 'Fa0/2');
  ok(phone.indexOf('switchport access vlan 30') < phone.indexOf('switchport mode access'),
    'the same order with the commands typed the other way round', JSON.stringify(phone));
  ok(phone.indexOf('switchport mode access') < phone.indexOf('switchport voice vlan 40'),
    'the voice VLAN line comes after the mode, as the vendor sample shows', JSON.stringify(phone));
}

console.log('');
console.log('A trunk prints its parameters before `switchport mode trunk`:');
{
  const env = lab();
  env.run(setConfig([
    'interface Fa0/3', 'switchport mode trunk', 'switchport trunk native vlan 99',
    'switchport trunk allowed vlan 10,20', 'end'
  ]));
  const t = block(env.config(), 'Fa0/3');
  ok(t.indexOf('switchport trunk native vlan 99') < t.indexOf('switchport mode trunk'),
    'native VLAN before the mode', JSON.stringify(t));
  ok(t.indexOf('switchport trunk native vlan 99') < t.indexOf('switchport trunk allowed vlan 10,20'),
    'the allowed list follows the native VLAN, as the captured trunk block shows', JSON.stringify(t));
  ok(t.indexOf('switchport trunk allowed vlan 10,20') < t.indexOf('switchport mode trunk'),
    'and the allowed list comes before the mode', JSON.stringify(t));
  ok(t[t.length - 1] === 'switchport mode trunk', 'and the mode is the last switchport line', JSON.stringify(t));
}

console.log('');
console.log('A port with nothing configured prints no switchport line:');
{
  const env = lab();
  const plain = block(env.config(), 'Fa0/4');
  ok(plain.length === 0, 'a default port has an empty block', JSON.stringify(plain));

  env.run(setConfig(['interface Fa0/4', 'switchport voice vlan 40', 'end']));
  const voiceOnly = block(env.config(), 'Fa0/4');
  ok(voiceOnly.length === 1 && voiceOnly[0] === 'switchport voice vlan 40',
    'a voice VLAN alone prints alone, with no mode line the vendor would not print', JSON.stringify(voiceOnly));
}

console.log('');
console.log('The order survives a save and replay:');
{
  const env = lab();
  env.run(setConfig([
    'interface Fa0/1', 'switchport access vlan 20', 'switchport mode access', 'switchport voice vlan 30', 'exit',
    'interface Fa0/2', 'switchport mode trunk', 'switchport trunk native vlan 99',
    'switchport trunk allowed vlan 10,20', 'end'
  ]));
  const saved = env.config();

  const t2 = new Topology();
  const d2 = t2.addDevice(SWITCH, 'sw');
  const sim2 = new Simulator(t2);
  runCommands(d2, t2, sim2, setConfig(saved.filter(function (l) { return !/^\S*[#>]\s*show/.test(l); })));
  const replayed = runCommands(d2, t2, sim2, ['enable', 'show running-config']).lines;
  const same = JSON.stringify(saved.map(function (l) { return String(l).replace(/^.*?#\s*/, ''); })) ===
    JSON.stringify(replayed.map(function (l) { return String(l).replace(/^.*?#\s*/, ''); }));
  ok(same, 'the printed config replays to the same text, order included');
  ok(JSON.stringify(block(saved, 'Fa0/1')) === JSON.stringify(block(replayed, 'Fa0/1')),
    'and Fa0/1 still reads access VLAN, mode, voice', JSON.stringify(block(replayed, 'Fa0/1')));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
