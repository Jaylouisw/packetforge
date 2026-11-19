'use strict';
// The Interface cell of `show ip interface brief` spells the type out (#fidelity: interface name spelling).
//
// Every published capture of the command prints `GigabitEthernet1/0/1`, `FastEthernet0/1` and `Vlan1`,
// never `Gi1/0/1` - while the catalogue stores what the panel says (short). The table therefore printed
// `Gi1/0/1` under a header that is the vendor's own, character for character, and whose 23-column
// Interface field was drawn for the long spelling. One rule, two surfaces: the brief row and the
// `show interfaces` block header name the port the way a box does, and the stored name is untouched, so
// a name pasted out of either view still resolves when it is typed back.
//
// research/interface-brief-name-spelling.md carries the samples and the parts that are still open.
const path = require('path');
const assert = require('assert');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');
const ifaceName = require('../engine/iface-name');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
function spec(model) {
  const s = catalog.filter(function (x) { return x.model === model; })[0];
  if (!s) throw new Error('spec not found: ' + model);
  return s;
}
function session(model, id) {
  const t = new Topology();
  const d = t.addDevice(spec(model), id || 'd1');
  const s = new CliSession(d, t, new Simulator(t));
  return { t: t, d: d, s: s, say: function (c) { return ((s.run(c).output) || []).map(String); } };
}

console.log('');
console.log('The table is the vendor\'s, and so is the spelling in its first column:');
{
  const env = session('C2960X-24TS-L', 'sw1');
  const lines = env.say('show ip interface brief');
  ok(lines[0] === 'Interface              IP-Address      OK? Method Status                Protocol',
    'the header is the vendor header, unchanged', lines[0]);
  // A Catalyst 2960-X prints `GigabitEthernet1/0/1`, and its uplink cages are 25-28: both are in the
  // sample captures, and both are 21 characters, inside the 23-column field.
  ok(lines[1] === 'GigabitEthernet1/0/1   unassigned      YES unset  down                  down',
    'the first copper port reads GigabitEthernet1/0/1', lines[1]);
  ok(lines.some(function (l) { return /^GigabitEthernet1\/0\/25\s/.test(l); }),
    'and the SFP cage 25 is spelled out too');
  ok(!lines.some(function (l) { return /^Gi1\/0\//.test(l); }),
    'no row uses the short spelling');
}

console.log('');
console.log('The stored name is not renamed - only the printed one:');
{
  const env = session('C2960X-24TS-L', 'sw1');
  ok(env.d.interfaces.has('Gi1/0/1'), 'the catalogue still keys the port `Gi1/0/1`');
  ok(!env.d.interfaces.has('GigabitEthernet1/0/1'), 'and does not invent a long-named second port');
  ok(env.say('interface GigabitEthernet1/0/1').every(function (l) { return !/not found/i.test(l); }),
    'the long spelling typed back still reaches the port');
  ok(env.say('interface Gi1/0/1').every(function (l) { return !/not found/i.test(l); }),
    'and so does the short one');
}

console.log('');
console.log('A subinterface and a 10G cage are spelled out by the same rule:');
{
  const env = session('generic-router', 'r1');
  env.say('enable'); env.say('configure terminal');
  env.say('interface Gi0/0.20'); env.say('encapsulation dot1q 20'); env.say('end');
  const lines = env.say('show ip interface brief');
  ok(lines.some(function (l) { return /^GigabitEthernet0\/0\.20\s/.test(l); }),
    'GigabitEthernet0/0.20 is a row', lines.filter(function (l) { return /\.20/.test(l); })[0]);

  const ten = session('C1000-24FP-4X-L', 'sw1');
  const tlines = ten.say('show ip interface brief');
  ok(tlines.some(function (l) { return /^TenGigabitEthernet1\/0\/1\s/.test(l); }),
    'a 10G cage reads TenGigabitEthernet1/0/1');
  // TenGigabitEthernet1/0/1 is 23 characters, exactly the field width: the rest of the row still starts
  // where the heading starts it.
  const row = tlines.filter(function (l) { return /^TenGigabitEthernet1\/0\/1\s/.test(l); })[0];
  ok(row.indexOf('10.0.0.0') === -1 && row.split(/\s+/)[1] === 'unassigned',
    'and the address cell still sits in its column', row);
}

console.log('');
console.log('Only IOS-style abbreviations are expanded. A spelling a vendor prints as-is is left alone:');
{
  const mk = session('CCR1009-7G-1C-1S+', 'r1');
  ok(mk.say('show ip interface brief').some(function (l) { return /^eth1\s/.test(l); }),
    'RouterOS `eth1` stays `eth1`, not `Ethernet1`');
  const ec = session('ECS4120-28Fv2', 'sw1');
  ok(ec.say('show ip interface brief').some(function (l) { return /^Eth1\/1\s/.test(l); }),
    'Edgecore `Eth1/1` stays `Eth1/1`');
  const ar = session('7280R3-48YC8', 'sw1');
  ok(ar.say('show ip interface brief').some(function (l) { return /^Ethernet1\s/.test(l); }),
    'EOS `Ethernet1` is already long and is unchanged');
  const hw = session('S5735-L24T4S', 'sw1');
  ok(hw.say('show ip interface brief').some(function (l) { return /^GigabitEthernet0\/0\/1\s/.test(l); }),
    'VRP `GE0/0/1` reads GigabitEthernet0/0/1, the word its own display command prints');
}

console.log('');
console.log('The per-port block keeps the panel spelling - the split is deliberate, not a leftover:');
{
  // `show interfaces`' block is this console's own shape, and `test/iface-type-spelling.test.js` owns the
  // rule that it prints the panel name. The brief table is the vendor's table, and only its cell changed.
  const env = session('C2960X-24TS-L', 'sw1');
  const block = env.say('show interfaces Gi1/0/1');
  ok(/^Gi1\/0\/1 \(ethernet, 1G\), MAC /.test(block[0]),
    '`show interfaces` still heads the block with `Gi1/0/1`', block[0]);
  ok(!/^GigabitEthernet1\/0\/1 \(/.test(block[0]), 'and not with the brief table\'s spelling');
}

console.log('');
console.log('The rule itself, on names no device carries:');
{
  const cases = [
    ['Gi1/0/1', 'GigabitEthernet1/0/1'],
    ['Fa0/24', 'FastEthernet0/24'],
    ['Te1/1/1', 'TenGigabitEthernet1/1/1'],
    ['Twe1/0/1', 'TwentyFiveGigE1/0/1'],
    ['Fo1/0/1', 'FortyGigabitEthernet1/0/1'],
    ['Hu1/0/1', 'HundredGigabitEthernet1/0/1'],
    ['Se0/0/0', 'Serial0/0/0'],
    ['Vl10', 'Vlan10'],
    ['Lo0', 'Loopback0'],
    ['Po1', 'Port-channel1'],
    ['GE0/0/1', 'GigabitEthernet0/0/1']
  ];
  const wrong = cases.filter(function (c) { return ifaceName.displayName(c[0]) !== c[1]; })
    .map(function (c) { return c[0] + ' -> ' + ifaceName.displayName(c[0]) + ' (wanted ' + c[1] + ')'; });
  ok(wrong.length === 0, cases.length + ' abbreviated types expand to the vendor\'s long word', wrong.join(' | '));
  ['eth1', 'Eth1/1', 'Ethernet1', 'xe-0/0/0', 'Port 1', 'sfp+1', '1/1/1', 'mgmt0']
    .forEach(function (n) {
      ok(ifaceName.displayName(n) === n, '`' + n + '` passes through untouched', ifaceName.displayName(n));
    });
}

console.log('');
if (failed) { console.error(failed + ' failed, ' + passed + ' passed'); process.exit(1); }
console.log(passed + ' passed, 0 failed');
