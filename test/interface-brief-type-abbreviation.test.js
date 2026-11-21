'use strict';
// `show ip interface brief` abbreviates the interface type when the long name would fill its
// 23-character Interface field, and spells it out when it fits.
//
// The column is IOS's, 23 wide (engine/cli.js BRIEF_COLUMNS). A real box's own table prints
// `GigabitEthernet1/0/1` (20) and `TwentyFiveGigE1/1/1` (19) in full, and `Te1/1/1`,
// `Tw1/0/1` and `Fo1/1/1` where the full names are 23, 23 and 25 characters - one threshold
// explains every row in the captures, where a list of "types that abbreviate" would have to
// explain why 10G is short and 25G long on the same box.
//
// Evidence (research/interface-brief-type-abbreviation.md):
//   * Cisco's Zero-Touch Provisioning guide, IOS XE 17.1-17.18, `*** Executing show ip interface
//     brief ***` on a C9300-48UXM: `Tw1/0/1`, `Te1/1/1`, `Fo1/1/1` short beside
//     `GigabitEthernet1/0/1` and `TwentyFiveGigE1/1/1` long.
//   * A live Catalyst 9200 (community transcript): brief prints `Te1/1/1` while `show
//     running-config` and `show ip route` print `TenGigabitEthernet1/1/1`.
//   * Cisco Press, router-on-a-stick: `GigabitEthernet0/0/1` long beside `Gi0/0/1.10` short
//     (the child's full name is 23 characters).
//
// The stored name is not renamed and no other view changes: `show running-config` still writes
// `interface TenGigabitEthernet1/1/1`, and both spellings still reach the port.
const path = require('path');
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
function spec(model) { return catalog.filter(function (x) { return x.model === model; })[0]; }
function session(model, id) {
  const t = new Topology();
  const d = t.addDevice(spec(model), id || 'd1');
  const s = new CliSession(d, t, new Simulator(t));
  return { t: t, d: d, s: s, say: function (c) { return ((s.run(c).output) || []).map(String); } };
}

console.log('');
console.log('A 23-character name is abbreviated; a shorter one is not:');
{
  const env = session('C9200L-24P-4X', 'sw1');
  const lines = env.say('show ip interface brief');
  ok(lines[1] === 'GigabitEthernet1/0/1   unassigned      YES unset  down                  down',
    'the copper row still spells GigabitEthernet out', lines[1]);
  // TenGigabitEthernet1/1/1 is exactly 23 characters, the width of the Interface field.
  ok(lines.some(function (l) { return l === 'Te1/1/1                unassigned      YES unset  down                  down'; }),
    'the 10G uplink reads Te1/1/1', lines.filter(function (l) { return /^Te/.test(l); })[0]);
  ok(!lines.some(function (l) { return /^TenGigabitEthernet/.test(l); }),
    'and no row prints the 23-character name');
  ok(env.d.interfaces.has('Te1/1/1'),
    'the stored name is still the panel spelling, unchanged');
}

console.log('');
console.log('A name that fits is printed in full, even when it is a high-speed type:');
{
  const env = session('C9500-24Y4C', 'sw1');
  const lines = env.say('show ip interface brief');
  ok(lines.some(function (l) { return /^TwentyFiveGigE1\/0\/1\s/.test(l); }),
    'TwentyFiveGigE1/0/1 (19 characters) is spelled out');
  ok(lines.some(function (l) { return /^HundredGigE1\/0\/1\s/.test(l); }),
    'HundredGigE1/0/1 (16) is spelled out');
  ok(!lines.some(function (l) { return /^(Twe|Hu)\d/.test(l); }),
    'and neither is abbreviated');

  const y = session('C9200L-24PXG-2Y', 'sw2');
  ok(y.say('show ip interface brief').some(function (l) { return /^TwentyFiveGigE1\/1\/1\s/.test(l); }),
    'a 25G cage on a 9200L is long too');

  const old = session('C2960X-24TS-L', 'sw3');
  ok(old.say('show ip interface brief').some(function (l) { return /^GigabitEthernet1\/0\/1\s/.test(l); }),
    'a 2960-X copper port is long, as every published capture shows');
}

console.log('');
console.log('A subinterface follows the same boundary:');
{
  const env = session('ISR 4331', 'r1');
  env.say('enable');
  env.say('configure terminal');
  env.say('interface Gi0/0/0.10');
  env.say('end');
  const lines = env.say('show ip interface brief');
  const parent = lines.filter(function (l) { return /^GigabitEthernet0\/0\/0\s/.test(l); })[0] || '';
  const child = lines.filter(function (l) { return /^Gi0\/0\/0\.10\s/.test(l); })[0] || '';
  ok(parent !== '', 'the parent, GigabitEthernet0/0/0 (20), is spelled out', parent);
  // GigabitEthernet0/0/0.10 is 23 characters.
  ok(child !== '', 'the child reads Gi0/0/0.10', lines.filter(function (l) { return /\.10\s/.test(l); })[0]);
  ok(!lines.some(function (l) { return /^GigabitEthernet0\/0\/0\.10\s/.test(l); }),
    'and not the 23-character spelling');
}

console.log('');
console.log('The row still lines up under the vendor header:');
{
  const env = session('C9200L-24P-4X', 'sw1');
  const lines = env.say('show ip interface brief');
  const header = lines[0];
  const rows = lines.slice(1).filter(function (l) { return /\sYES\s/.test(l); });
  ok(header.indexOf('IP-Address') === 23, 'the header puts IP-Address at column 23', String(header.indexOf('IP-Address')));
  ok(rows.length > 0 && rows.every(function (l) { return /^(unassigned|\d)/.test(l.slice(23)); }),
    'and every row starts its address cell at column 23', rows[0]);
}

console.log('');
console.log('The abbreviation is a display rule - nothing is renamed and both spellings still work:');
{
  const env = session('C9200L-24P-4X', 'sw1');
  const rc = env.say('show running-config');
  ok(rc.some(function (l) { return l === 'interface TenGigabitEthernet1/1/1'; }),
    'show running-config still prints the long stanza header');
  ok(!rc.some(function (l) { return l === 'interface Te1/1/1'; }),
    'and never the brief table\'s abbreviation');
  const block = env.say('show interfaces Te1/1/1');
  ok(block.some(function (l) { return /^Te1\/1\/1 \(ethernet, 10G\), MAC /.test(l); }),
    'show interfaces Te1/1/1 answers about that cage', block[0]);
  env.say('enable');
  env.say('configure terminal');
  const byShort = env.say('interface Te1/1/1');
  ok(byShort.length === 0 || !/No interface/.test(byShort.join(' ')),
    'the short name printed by the table opens the port', byShort.join(' / '));
  ok(env.say('description core uplink').some(function (l) { return l === 'Description set: core uplink'; }),
    'and takes a command');
  const byLong = env.say('interface tengigabitethernet1/1/1');
  ok(byLong.length === 0 || !/No interface/.test(byLong.join(' ')),
    'the long spelling opens the same port', byLong.join(' / '));
  ok(env.d.interfaces.get('Te1/1/1').description === 'core uplink',
    'and both names landed in one object, not two');
}

console.log('');
console.log('The rule itself, on names no device carries:');
{
  const cases = [
    ['Te1/1/1', 'Te1/1/1'],                   // full name is 23: abbreviated
    ['Tw1/0/1', 'Tw1/0/1'],                   // 23
    ['Fo1/1/1', 'Fo1/1/1'],                   // 25
    ['Twe1/1/1', 'TwentyFiveGigE1/1/1'],      // 19: long
    ['Hu1/0/1', 'HundredGigE1/0/1'],          // 16: long
    ['Gi1/0/1', 'GigabitEthernet1/0/1'],      // 20: long
    ['Gi0/0/1.10', 'Gi0/0/1.10'],             // 24: abbreviated
    ['eth1', 'eth1'],                         // a spelling this table does not expand
    ['HundredGigabitEthernet0/1', 'HundredGigabitEthernet0/1'], // FSOS's own word, not IOS's
    ['xe-0/0/0', 'xe-0/0/0']
  ];
  for (const c of cases) {
    const got = ifaceName.briefName(c[0]);
    ok(got === c[1], c[0] + ' -> ' + c[1], got);
  }
  ok(ifaceName.briefName('Te1/1/1').length < ifaceName.BRIEF_NAME_WIDTH &&
    ifaceName.briefName('GigabitEthernet1/0/1').length < ifaceName.BRIEF_NAME_WIDTH,
    'no printed name fills the field it sits in');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
