'use strict';
// `switchport trunk allowed vlan remove <list>` on a trunk that still allows the default "all" (#1746).
//
// The console refused it:
//
//   s1(config-if)# switchport trunk allowed vlan remove 10
//   % this trunk allows all VLANs: name the list it should allow instead (switchport trunk allowed vlan <list>)
//
// That sentence is not one a switch prints. A Catalyst accepts the command on a port that has never had an
// allowed list typed on it - Cisco's own "Removing a VLAN from a Port" example does exactly that, on a port
// whose list is the default - and starts printing the remainder: a c3550 transcript of `remove 5-10,12` +
// `add 7` shows `show interfaces fa0/2 trunk` answering `1-4,7,11,13-4094`
// (research/trunk-allowed-remove-from-all.md).
//
// The refusal existed for one reason, and it is in the old comment: "all minus 10" is 4,090 ids, and a console
// that stores that has written a line no operator would type. That reason is about the *printing*, not about
// the arithmetic: a switch prints an allowed list with ranges folded together, so the same configuration is
// one short line (`1,3-1001,1006-4094`). This file holds both halves - the device's answer and the shape it is
// printed in - and the three views of the port that have to agree about it.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const vlanLib = require('../engine/vlan');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const ROOT = path.join(__dirname, '..');
const catalog = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.find(function (s) { return s.model === 'generic-switch'; });

// Every assignable VLAN id: 1-4094 less the four reserved media defaults (1002-1005).
const ASSIGNABLE = vlanLib.allVlansExcept([]);

function session() {
  const t = new Topology();
  t.addDevice(SWITCH, 's1');
  const sim = new Simulator(t);
  const cli = new CliSession(t.getDevice('s1'), t, sim);
  cli.run('configure terminal');
  cli.run('interface Fa0/1');
  const put = function (cmd) { return cli.run(cmd).output; };
  put('switchport mode trunk');
  return {
    t: t, sim: sim, cli: cli, put: put,
    port: function () { return t.getDevice('s1').interfaces.get('Fa0/1').vlan; },
    allowed: function () {
      const v = t.getDevice('s1').interfaces.get('Fa0/1').vlan;
      return v.allowedVlans === 'all' ? 'all' : v.allowedVlans.slice();
    },
    config: function () {
      cli.run('end');
      const out = cli.run('show running-config').output.filter(function (l) {
        return /switchport trunk allowed vlan/.test(l);
      })[0] || '';
      cli.run('configure terminal'); cli.run('interface Fa0/1');
      return out.trim();
    },
    sentence: function () {
      cli.run('end');
      const out = cli.run('show interfaces Fa0/1').output.filter(function (l) {
        return /switchport:/.test(l);
      })[0] || '';
      cli.run('configure terminal'); cli.run('interface Fa0/1');
      return out.trim();
    }
  };
}

console.log('');
console.log('A list is printed the way a switch prints one - consecutive ids folded into a range:');
{
  ok(vlanLib.formatVlanList([1, 3, 4, 5, 7]) === '1,3-5,7', 'gaps and runs', vlanLib.formatVlanList([1, 3, 4, 5, 7]));
  ok(vlanLib.formatVlanList([3, 4]) === '3-4', 'a pair folds too, as the box prints it', vlanLib.formatVlanList([3, 4]));
  ok(vlanLib.formatVlanList([5, 3, 4]) === '3-5', 'the order the caller passed does not matter',
    vlanLib.formatVlanList([5, 3, 4]));
  ok(vlanLib.formatVlanList([]) === '', 'an empty list prints as nothing, so the caller keeps its own word for it',
    JSON.stringify(vlanLib.formatVlanList([])));
  ok(vlanLib.formatVlanList([4094]) === '4094', 'one id is one number', vlanLib.formatVlanList([4094]));
  const parsed = vlanLib.parseVlanList(vlanLib.formatVlanList(ASSIGNABLE));
  ok(parsed.ok && parsed.vlans.length === ASSIGNABLE.length, 'and the printed form parses back to the same ids',
    parsed.vlans.length + ' of ' + ASSIGNABLE.length);
}

console.log('');
console.log('`remove` on a trunk that allows all of them does what the device does:');
{
  const L = session();
  ok(L.allowed() === 'all', 'the port starts on the default list', JSON.stringify(L.allowed()));
  const out = L.put('switchport trunk allowed vlan remove 2');
  ok(!/^%/.test(out[0]), 'the command is accepted, not refused', out[0]);
  ok(/removed 2/.test(out[0]), 'the answer names what came off', out[0]);
  const after = L.allowed();
  ok(Array.isArray(after), 'the port now carries an explicit list', typeof after);
  ok(after.length === ASSIGNABLE.length - 1, 'which is every assignable VLAN but one',
    after.length + ' of ' + (ASSIGNABLE.length - 1));
  ok(after.indexOf(2) === -1, 'VLAN 2 is not in it', String(after.indexOf(2)));
  ok([1, 3, 1001, 1006, 4094].every(function (v) { return after.indexOf(v) !== -1; }),
    'and 1, 3, 1001, 1006 and 4094 still are');
  ok([1002, 1003, 1004, 1005].every(function (v) { return after.indexOf(v) === -1; }),
    'the reserved media defaults are in no list at all', '1002-1005');

  const line = L.config();
  ok(line === 'switchport trunk allowed vlan 1,3-1001,1006-4094', 'the backup prints the remainder as ranges', line);
  ok(line.length < 50, 'which is one readable line, not 4,089 numbers', String(line.length) + ' chars');
  ok(L.sentence() === 'switchport: trunk \u00b7 native 1 \u00b7 allowed 1,3-1001,1006-4094',
    'and `show interfaces` says the same list, in the same shape', L.sentence());

  // Typing the printed line back has to be a no-op, or a backup cannot restore the box it came from.
  const before = JSON.stringify(L.allowed());
  L.put(line.replace(/^\s*switchport trunk allowed vlan\s+/, ''));
  ok(JSON.stringify(L.allowed()) === before, 'retyping the printed line changes nothing', L.config());
}

console.log('');
console.log('Two removals subtract one after the other, from the default list as from an explicit one:');
{
  const L = session();
  L.put('switchport trunk allowed vlan remove 10');
  L.put('switchport trunk allowed vlan remove 20');
  const after = L.allowed();
  ok(after.indexOf(10) === -1 && after.indexOf(20) === -1, 'both VLANs are gone', 'count ' + after.length);
  ok(after.length === ASSIGNABLE.length - 2, 'and nothing else is', after.length + ' ids');
  ok(L.config() === 'switchport trunk allowed vlan 1-9,11-19,21-1001,1006-4094',
    'the line reads as three runs', L.config());

  L.put('switchport trunk allowed vlan remove 2');
  ok(L.allowed().indexOf(2) === -1, 'a third removal takes VLAN 2 as well', 'index 2');
  const back = L.put('switchport trunk allowed vlan add 2');
  ok(/added 2/.test(back[0]), 'and a removed VLAN can be added back', back[0]);
  ok(L.allowed().indexOf(2) !== -1, 'so it is in the list again', 'index 2');

  const restored = L.cli.run('no switchport trunk allowed vlan').output;
  ok(/all VLANs again/.test(restored.join(' ')), '`no switchport trunk allowed vlan` returns the default',
    restored.join(' | '));
  ok(L.allowed() === 'all', 'which is "all", not a list of 4,090', JSON.stringify(L.allowed()));
  ok(L.config() === '', 'and the backup stops printing a list at all', L.config());
}

console.log('');
console.log('The data plane follows the list, not the command history:');
{
  const L = session();
  L.put('switchport trunk allowed vlan remove 2');
  const cfg = L.port();
  ok(vlanLib.classifyEgress(cfg, 2).action === 'drop', 'a frame for VLAN 2 is dropped on the way out',
    vlanLib.classifyEgress(cfg, 2).action);
  ok(vlanLib.classifyEgress(cfg, 3).action === 'tagged', 'VLAN 3 leaves tagged',
    vlanLib.classifyEgress(cfg, 3).action);
  ok(vlanLib.classifyEgress(cfg, 1).action === 'untagged', 'VLAN 1 is still the untagged native VLAN',
    vlanLib.classifyEgress(cfg, 1).action);
  ok(vlanLib.classifyIngress(cfg, { tagged: true, vid: 2 }).action === 'drop',
    'and VLAN 2 is dropped on the way in', vlanLib.classifyIngress(cfg, { tagged: true, vid: 2 }).action);
  ok(vlanLib.classifyIngress(cfg, { tagged: true, vid: 4000 }).action === 'accept', 'while 4000 is accepted',
    vlanLib.classifyIngress(cfg, { tagged: true, vid: 4000 }).action);

  // A list this long is classified per frame, so the parser must not run per frame: 4,089 ids parsed on every
  // call would put ~4,000 regexes in front of every frame. The bound is loose on purpose - it catches the
  // shape (a parse in the data plane runs into seconds here), not a micro-benchmark.
  const start = Date.now();
  for (let i = 0; i < 2000; i++) vlanLib.classifyEgress(cfg, (i % 4094) + 1);
  const ms = Date.now() - start;
  ok(ms < 3000, '2,000 frames are classified against the long list in well under three seconds', ms + ' ms');
}

console.log('');
console.log('Removing VLAN 1 is how a trunk is told to stop carrying it:');
{
  // Cisco: "To reduce the risk of spanning-tree loops or storms, you can disable VLAN 1 on any individual VLAN
  // trunk port by removing VLAN 1 from the allowed list." Management traffic keeps flowing in VLAN 1 - this
  // model does not carry CDP/DTP/LACP frames as data, so what is checked is that VLAN 1 traffic stops.
  const L = session();
  const out = L.put('switchport trunk allowed vlan remove 1');
  ok(!/^%/.test(out[0]), 'the command is accepted', out[0]);
  ok(L.allowed().indexOf(1) === -1, 'and VLAN 1 leaves the allowed list', 'index 1');
  ok(vlanLib.classifyEgress(L.port(), 1).action === 'drop', 'so VLAN 1 frames are dropped',
    vlanLib.classifyEgress(L.port(), 1).action);
  ok(L.config() === 'switchport trunk allowed vlan 2-1001,1006-4094', 'the line starts at 2', L.config());
}

console.log('');
console.log('A removal that would empty the trunk is still refused:');
{
  const L = session();
  const out = L.put('switchport trunk allowed vlan remove 1-1001,1006-4094');
  ok(/^%/.test(out[0]), 'removing every assignable VLAN is refused', out[0].slice(0, 80));
  ok(/no VLANs/.test(out[0]) && /no switchport trunk allowed vlan/.test(out[0]),
    'naming the way back', out[0].slice(0, 120));
  ok(L.allowed() === 'all', 'and the default list is untouched', JSON.stringify(L.allowed()));

  // `1-4094` spans the reserved block, which this console refuses in any explicit list; the refusal has to be
  // about the VLAN, not about the word `remove`, which it used to say instead.
  const reserved = L.put('switchport trunk allowed vlan remove 1-4094');
  ok(/reserved/.test(reserved[0]) && /1002/.test(reserved[0]),
    'a range through the reserved block names the reserved VLAN', reserved[0].slice(0, 90));
  ok(!/Unrecognized/.test(reserved[0]), 'and does not call the verb unrecognized', reserved[0].slice(0, 60));
}

console.log('');
console.log('A switchport sentence never prints a wall of numbers:');
{
  const cfg = { mode: 'trunk', nativeVlan: 1, allowedVlans: vlanLib.allVlansExcept([2]) };
  const text = vlanLib.switchportSentence(cfg);
  ok(/allowed 1,3-1001,1006-4094$/.test(text), 'the sentence carries the folded list', text);
  ok(text.indexOf('3,4,5') === -1, 'so no run of numbers appears in it', 'no run');
  const staged = vlanLib.switchportSentence({ mode: 'access', accessVlan: 5, allowedVlans: vlanLib.allVlansExcept([2]) });
  ok(/allowed 1,3-1001,1006-4094/.test(staged), 'a trunk staged on an access port reads the same way', staged);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
