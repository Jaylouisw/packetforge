'use strict';
// A 100G port's name: IOS XE says `HundredGigE`, not `HundredGigabitEthernet`.
//
// The display table expanded the type `hu` onto `HundredGigabitEthernet`, which is a word no
// IOS capture prints. IOS XE's own interface-type lists spell three of the high-speed types
// differently: `TwentyFiveGigE or twe`, `FortyGigabitEthernet or fo`, and `HundredGigE or hu`
// - the 40G word is long and the 100G word is not. A Catalyst 9500 prints
// `interface HundredGigE1/0/2` in running-config and `HundredGigE1/0/1 is up, line protocol
// is down` from `show interfaces`. FSOS really does print `HundredGigabitEthernet`, but its
// catalogue ports already carry that word and pass through `displayName()` untouched, so the
// binding is one-way: short Cisco spellings expand to IOS XE's word, long spellings from other
// vendors are left alone.
//
// research/hundredgige-interface-spelling.md has the sources, and the one cell this does not
// settle: no capture of a 100G port in `show ip interface brief` was found, so whether that
// table prints `HundredGigE1/0/1` or `Hu1/0/1` is still open. The long form is used here for
// the same reason the table uses it for every other type - it is the name, not an abbreviation.
const path = require('path');
const { Topology, Simulator, CliSession } = require('../engine');
const { loadCatalog } = require('../devices/registry');
const ifaceName = require('../engine/iface-name');

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
function specFor(model) {
  const s = catalog.filter(function (x) { return x.model === model && !x.error; })[0];
  if (!s) throw new Error('spec not found: ' + model);
  return s;
}
function open(model, id) {
  const t = new Topology();
  const d = t.addDevice(specFor(model), id || 'd1');
  const s = new CliSession(d, t, new Simulator(t));
  return { t: t, d: d, s: s, say: function (c) { return (s.run(c).output || []).map(String); } };
}

console.log('');
console.log('The expansion table, on the name a Catalyst catalogue stores:');
{
  ok(ifaceName.displayName('Hu1/0/1') === 'HundredGigE1/0/1',
    '`hu` expands to HundredGigE', ifaceName.displayName('Hu1/0/1'));
  ok(ifaceName.displayName('Hu1/0/1.10') === 'HundredGigE1/0/1.10',
    'and a subinterface keeps its tag on the same word', ifaceName.displayName('Hu1/0/1.10'));
  ok(ifaceName.displayName('Twe1/0/1') === 'TwentyFiveGigE1/0/1',
    'TwentyFiveGigE is unchanged, because IOS XE already spells it that way');
  ok(ifaceName.displayName('Fo1/0/1') === 'FortyGigabitEthernet1/0/1',
    'and FortyGigabitEthernet is unchanged, because IOS XE spells that one out');
  ok(ifaceName.portKey('HundredGigE1/0/1') === ifaceName.portKey('Hu1/0/1'),
    'the long and short spellings are one port key');
}

console.log('');
console.log('On a Catalyst 9500, whose four 100G cages the catalogue stores as Hu1/0/1-4:');
{
  const env = open('C9500-24Y4C', 'sw1');
  const lines = env.say('show ip interface brief');
  const row = lines.filter(function (l) { return /^HundredGigE1\/0\/1\s/.test(l); })[0];
  ok(!!row, 'the 100G port has a row spelled HundredGigE1/0/1', lines.filter(function (l) { return /Hu1\/0\/1/.test(l); })[0]);
  ok(row && row.indexOf('unassigned') === 23,
    'and the address cell starts in the vendor header\'s 23rd column', row && String(row.indexOf('unassigned')));
  ok(!lines.some(function (l) { return /HundredGigabitEthernet/.test(l); }),
    'no row uses HundredGigabitEthernet');
  ok(lines.some(function (l) { return /^TwentyFiveGigE1\/0\/1\s/.test(l); }),
    'the 25G rows are untouched beside it');

  const run = env.say('show running-config');
  ok(run.indexOf('interface HundredGigE1/0/1') !== -1,
    'the stanza header reads interface HundredGigE1/0/1', run.filter(function (l) { return /interface.*1\/0\/1$/.test(l); })[0]);
  ok(!run.some(function (l) { return /HundredGigabitEthernet/.test(l); }),
    'and the file has no HundredGigabitEthernet in it');
}

console.log('');
console.log('Every spelling of the port still reaches it:');
{
  const forms = ['HundredGigE1/0/1', 'hundredgige 1/0/1', 'HundredGigabitEthernet1/0/1', 'Hu1/0/1', 'hu 1/0/1'];
  for (const f of forms) {
    const env = open('C9500-24Y4C', 'sw1');
    env.say('enable'); env.say('configure terminal');
    const out = env.say('interface ' + f);
    ok(!out.some(function (l) { return /not found/i.test(l); }), '`interface ' + f + '` opens the port', out.join(' | '));
    env.say('description hundred');
    ok(env.say('show running-config').indexOf('interface HundredGigE1/0/1') !== -1,
      'and the edit lands in the HundredGigE1/0/1 stanza');
  }
  const env = open('C9500-24Y4C', 'sw1');
  ok(env.d.interfaces.has('Hu1/0/1') && !env.d.interfaces.has('HundredGigE1/0/1'),
    'the stored key is still the panel name Hu1/0/1');
}

console.log('');
console.log('A vendor that really prints the long word is left alone:');
{
  const fs = open('N8560-32C', 'sw1');
  const lines = fs.say('show ip interface brief');
  ok(lines.some(function (l) { return /^HundredGigabitEthernet0\/1\s/.test(l); }),
    'FSOS\'s own HundredGigabitEthernet0/1 row is unchanged', lines.filter(function (l) { return /HundredGig/.test(l); })[0]);
  ok(ifaceName.displayName('HundredGigabitEthernet1/1') === 'HundredGigabitEthernet1/1',
    'and the long spelling passes through displayName() untouched');
}

console.log('');
if (failed) { console.error(failed + ' failed, ' + passed + ' passed'); process.exit(1); }
console.log(passed + ' passed, 0 failed');
