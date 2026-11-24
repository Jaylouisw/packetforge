'use strict';
// The bare `switchport` line: a real command, and the empty answer this console used to give it.
//
// `switchport` with no keywords is the inverse of `no switchport`, and the vendor's own words are the syntax
// line: "To put an interface that is in Layer 3 mode into Layer 2 mode for Layer 2 configuration, use the
// switchport command in interface configuration mode. To put an interface in Layer 3 mode, use the no form of
// this command." (Catalyst 9300 command reference, IOS XE 16.5.x, Layer 2/3 Commands, `switchport` -
// https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/16-5/command_reference/b_165_9300_cr/b_165_9300_cr_chapter_0111.html
// - and the same entry in the 9200 16.12, 9300 17.12 and 2960-S/2960-C 15.2(4)E books).
//
// This console answered it with `% Unrecognized switchport command: ` - the word the operator typed was the
// command itself, so the sentence had nothing after its colon, and it told the reader the console does not know
// a line five command references document. The line now names the state it found and changes nothing, because
// this engine has no routed port for the command to return to Layer 2 (a limitation recorded, with the LAN Base
// half of the question, in research/bare-switchport-command.md).
//
// The load-bearing section is the last one: the bare form must not become a second way to wipe a port. Every
// field `switchport mode trunk` / `switchport trunk native vlan` wrote has to survive it byte for byte.
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
function spec(re) {
  const s = catalog.filter(function (x) { return re.test(x.model); })[0];
  if (!s) throw new Error('spec not found: ' + re);
  return s;
}
const L2SW = spec(/^Catalyst2960$/);          // LAN Base 24-port: no l3-forward
const L3SW = spec(/^WS-C3560G-24TS-S$/);      // L3 switch: routed ports exist on the real box
const ROUTER = spec(/ASR 1001-X/);

function lab(which, name) {
  const t = new Topology();
  const dev = t.addDevice(which, name || 'sw1');
  const sim = new Simulator(t);
  const cli = new CliSession(dev, t, sim);
  return { t: t, dev: dev, sim: sim, cli: cli, port: [...dev.interfaces.keys()][0] };
}
function say(cli, line) { return cli.run(line).output.join('\n'); }

// A port with something on it that a reset would erase: a description, a trunk, a native VLAN and an
// allowed list narrower than "all".
function staged(which) {
  const l = lab(which);
  l.cli.run('configure terminal');
  l.cli.run('interface ' + l.port);
  l.cli.run('description uplink to core');
  l.cli.run('switchport mode trunk');
  l.cli.run('switchport trunk native vlan 20');
  l.cli.run('switchport trunk allowed vlan 10,20,30');
  l.cli.run('end');
  return l;
}

console.log('');
console.log('The bare line is answered, and not with a colon and nothing after it:');
{
  const l = lab(L2SW);
  l.cli.run('configure terminal');
  l.cli.run('interface ' + l.port);
  const out = l.cli.run('switchport').output;
  ok(out.length === 1, '`switchport` answers one line', JSON.stringify(out));
  ok(out[0].indexOf('% Unrecognized switchport command: ') === -1,
    'and it is no longer `% Unrecognized switchport command: ` with no word after the colon', out[0]);
  ok(/is already a Layer 2 switchport/.test(out[0]), 'it says the port is already a Layer 2 switchport', out[0]);
  ok(out[0].indexOf(l.port) !== -1, 'and names the port it is about', out[0]);
  ok(/returns a routed port to Layer 2 mode/.test(out[0]),
    'it says what the command is for on a box - the inverse of `no switchport`', out[0]);
  ok(/nothing changed/.test(out[0]), 'and that nothing changed', out[0]);
  ok(out[0].trim() === out[0], 'no trailing space in the answer', JSON.stringify(out[0]));
  ok(out[0].indexOf('  ') === -1, 'and no run of spaces inside it', out[0]);
}

console.log('');
console.log('The same answer on an L3 switch, where the real box does have routed ports:');
{
  const l = lab(L3SW, 'l3sw');
  l.cli.run('configure terminal');
  l.cli.run('interface ' + l.port);
  const out = l.cli.run('switchport').output;
  ok(out.length === 1 && /is already a Layer 2 switchport/.test(out[0]),
    '`switchport` answers the same sentence on a 3560', JSON.stringify(out));
  ok(out[0].indexOf('no routed port') !== -1,
    'and says this console has no routed port, which is the reason the line cannot do its box job', out[0]);
}

console.log('');
console.log('It changes nothing - the trunk, native VLAN, allowed list and description all survive:');
{
  const l = staged(L2SW);
  const before = say(l.cli, 'show interfaces ' + l.port);
  const beforeRun = say(l.cli, 'show running-config');
  l.cli.run('configure terminal');
  l.cli.run('interface ' + l.port);
  l.cli.run('switchport');
  l.cli.run('end');
  const after = say(l.cli, 'show interfaces ' + l.port);
  const afterRun = say(l.cli, 'show running-config');
  ok(after === before, '`show interfaces <port>` is byte for byte the same before and after', after);
  ok(afterRun === beforeRun, 'and so is `show running-config`', afterRun.slice(0, 300));
  ok(/switchport: trunk/.test(after), 'the port is still a trunk', after);
  ok(/native 20/.test(after), 'the native VLAN is still 20', after);
  ok(/uplink to core/.test(after), 'and the description is still there', after);
}

console.log('');
console.log('Typed twice, the answer is the same and still nothing changed:');
{
  const l = staged(L2SW);
  l.cli.run('configure terminal');
  l.cli.run('interface ' + l.port);
  const first = l.cli.run('switchport').output;
  const second = l.cli.run('switchport').output;
  ok(JSON.stringify(first) === JSON.stringify(second), 'the second answer is the first answer',
    JSON.stringify(second));
}

console.log('');
console.log('The neighbouring forms are untouched:');
{
  const l = staged(L2SW);
  l.cli.run('configure terminal');
  l.cli.run('interface ' + l.port);
  ok(/Unrecognized switchport command: flurbish/.test(say(l.cli, 'switchport flurbish')),
    'an unknown keyword is still quoted back as an unknown keyword');
  ok(/Switchport mode access on /.test(say(l.cli, 'switchport mode access')),
    '`switchport mode access` still sets the mode');
  ok(/Access VLAN 40 on /.test(say(l.cli, 'switchport access vlan 40')),
    'and `switchport access vlan 40` still stores its VLAN');
  ok(/Switchport reset to defaults on /.test(say(l.cli, 'no switchport')),
    '`no switchport` is still the whole-port reset, so the pair still differs where a box differs');
  ok(/already has default switchport settings/.test(say(l.cli, 'no switchport')),
    'and still says so when there is nothing left to reset');
}

console.log('');
console.log('A box that does not switch is refused for the reason it already gave:');
{
  const l = lab(ROUTER, 'r1');
  l.cli.run('configure terminal');
  l.cli.run('interface ' + l.port);
  const out = l.cli.run('switchport').output;
  ok(/cannot switch frames: it has no l2-forward capability/.test(out[0]),
    '`switchport` on a router is still the capability refusal', out[0]);
  ok(out[0].indexOf('is already a Layer 2 switchport') === -1,
    'and the new sentence does not replace it', out[0]);
}

console.log('');
console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
