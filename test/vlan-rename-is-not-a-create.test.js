'use strict';
// A VLAN that is already there is not created again - and typing "vlan 20" does not wipe its name.
//
// The door took the VLAN name as tokens.slice(2) and wrote a fresh record every time, so re-entering a VLAN
// that exists was a silent rename to the default:
//
//   Switch(config)# vlan 20 name sales
//   VLAN 20 created (name: sales)
//   Switch(config)# vlan 20
//   VLAN 20 created (name: VLAN0020)      <-- the receipt says "created", and "sales" is gone
//   Switch# show vlan brief
//   20   VLAN0020   active
//
// Two faults in one line. The state change: a Cisco switch changes a VLAN name through the name keyword
// only - entering the VLAN again ("vlan 20") selects it and leaves the name alone, which is exactly how a
// worksheet sentence "enter VLAN 20" is meant to behave. Here it overwrote the stored name with the default,
// and nothing else in the console got "sales" back except retyping it. And the receipt: the word "created" for a
// VLAN that already existed is false in both spellings, the bare re-entry and the rename ("vlan 20 name ops" is a
// rename, and said "created" too).
//
// Nothing else moves: a VLAN made by id alone is still "VLAN 20 created (name: VLAN0020)", "vlan 1" keeps its own
// answer (test/default-vlan-is-not-deletable.test.js), and a rename goes through the same name rules
// (test/vlan-name-length.test.js).
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  ok   ' + msg); }
  else { failed++; console.error('  FAIL ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];

// What the console said, with the echoed prompts and the config-mode greeting removed.
function said(text) {
  return text.split(/\r?\n/).filter(function (l) {
    return l && !/^Switch \(L2\)-sw1/.test(l) && !/^Enter configuration commands/.test(l);
  }).join('\n');
}
function build() {
  const t = new Topology();
  const sw = t.addDevice(SWITCH, 'sw1');
  const sim = new Simulator(t);
  const run = function (line) {
    const lines = [].concat(line);
    return said(runCommands(sw, t, sim, ['enable', 'configure terminal'].concat(lines)).output);
  };
  return { t: t, sim: sim, sw: sw, run: run };
}
function vlanLines(s) {
  return s.run('show running-config').split('\n').filter(function (l) { return /^\s*vlan /.test(l); });
}
function vlanRow(s, id) {
  return s.run('show vlan brief').split('\n').filter(function (l) {
    return new RegExp('^' + id + ' ').test(l);
  })[0] || '';
}

console.log('');
console.log('A VLAN made by id alone is still created:');
{
  const s = build();
  const answer = s.run('vlan 20');
  ok(answer === 'VLAN 20 created (name: VLAN0020)', 'the first vlan 20 creates it', answer);
  ok(s.sw.config.vlans[20].name === 'VLAN0020', 'named after its id');
}

console.log('');
console.log('Entering an existing VLAN again does not rename it:');
{
  const s = build();
  const made = s.run('vlan 20 name sales');
  ok(made === 'VLAN 20 created (name: sales)', 'the first line creates and names the VLAN', made);

  const again = s.run('vlan 20');
  ok(s.sw.config.vlans[20].name === 'sales', 'the bare re-entry leaves the name alone',
    JSON.stringify(s.sw.config.vlans[20]));
  ok(!/created/.test(again), 'and the receipt does not claim it created the VLAN', again);
  ok(/already exists/.test(again), 'it says the VLAN is already there', again);
  ok(again.indexOf('sales') !== -1, 'and names it as it stands', again);
  ok(vlanRow(s, 20).indexOf('sales') !== -1, 'show vlan brief still shows sales', vlanRow(s, 20));
  ok(vlanLines(s).length === 1, 'running-config still prints one vlan line', vlanLines(s).join(' | '));
}

console.log('');
console.log('Re-entering by name - a real rename - is called a rename:');
{
  const s = build();
  s.run('vlan 20 name sales');
  const answer = s.run('vlan 20 name ops');
  ok(s.sw.config.vlans[20].name === 'ops', 'the name is changed', JSON.stringify(s.sw.config.vlans[20]));
  ok(!/created/.test(answer), 'the receipt does not say the VLAN was created', answer);
  ok(/renamed/.test(answer), 'it says the VLAN was renamed', answer);
  ok(answer.indexOf('ops') !== -1 && answer.indexOf('sales') !== -1,
    'and shows the new name and the old one', answer);

  const same = s.run('vlan 20 name ops');
  ok(/already exists/.test(same) && !/renamed|created/.test(same),
    'the same name typed again changes nothing and says so', same);
}

console.log('');
console.log('A VLAN a port made is not "created" by its own line either:');
{
  const s = build();
  const access = s.run(['interface FastEthernet0/1', 'switchport access vlan 30']);
  ok(/VLAN 30/.test(access), 'the access port makes VLAN 30', access);
  const answer = s.run('vlan 30');
  ok(s.sw.config.vlans[30].name === 'VLAN0030', 'the port-made VLAN keeps its default name',
    JSON.stringify(s.sw.config.vlans[30]));
  ok(!/created/.test(answer), 'and vlan 30 does not claim to have created it', answer);
  ok(/already exists/.test(answer), 'it says it is already there', answer);
}

console.log('');
console.log('Replaying the printed config changes nothing:');
{
  const s = build();
  s.run('vlan 20 name sales');
  s.run('vlan 20 name ops');
  const printed = vlanLines(s);
  const before = JSON.stringify(s.sw.config.vlans);
  printed.forEach(function (line) { s.run(line.trim()); });
  ok(JSON.stringify(s.sw.config.vlans) === before, 'the vlan lines typed back change nothing',
    before + ' -> ' + JSON.stringify(s.sw.config.vlans));
  ok(vlanLines(s).join(' | ') === printed.join(' | '), 'and the config looks the same',
    vlanLines(s).join(' | '));
}

console.log('');
console.log('The default VLAN keeps its own answer:');
{
  const s = build();
  const answer = s.run('vlan 1');
  ok(/already exists \(name: default\)/.test(answer), 'vlan 1 is still the default-VLAN line', answer);
  const renamed = s.run('vlan 1 name TEST');
  ok(renamed === '%Default VLAN 1 may not have its name changed.', 'and cannot be renamed', renamed);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
