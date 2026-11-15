'use strict';
// output-filters.test.js - the pipe an operator actually types, and the values behind a placeholder.
//
//   R1#show running-config | include route
//   % show running-config takes one port, not "| include route"
//   % Try "show ip interface brief" for the ports this device has
//   R1(config)#interface Gi?
//   % Nothing after "interface" starts with "Gi"
//
// `| include`, `| exclude`, `| begin`, `| section` and `| count` are how IOS is used - a config dump is
// useless without them - and here the pipe was read as a *port name*, so the console blamed the port
// table for a filter it did not have. `interface Gi?` is the same kind of answer: the device holds three
// ports starting with Gi and the console said nothing does.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function text(out) { return out && out.output ? out.output.join('\n') : String(out); }
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const find = function (m) { return catalog.filter(function (x) { return x.model === m; })[0]; };

function lab() {
  const t = new Topology();
  const r = t.addDevice(find('generic-router')); r.name = 'R1';
  const sw = t.addDevice(find('generic-switch')); sw.name = 'SW1';
  const sim = new Simulator(t);
  const sr = new CliSession(r, t, sim);
  sr.run('enable', 'configure terminal', 'hostname EDGE1', 'interface Gi0/0',
    'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
    'interface Gi0/1', 'ip address 10.1.0.1 255.255.255.0', 'exit',
    'ip route 10.9.0.0 255.255.0.0 10.0.0.254', 'ip name-server 8.8.8.8', 'end');
  const ss = new CliSession(sw, t, sim);
  ss.run('enable', 'configure terminal', 'vlan 10', 'vlan 20',
    'interface Fa0/1', 'switchport access vlan 10', 'no shutdown', 'exit',
    'interface Fa0/2', 'switchport mode trunk', 'exit',
    'interface vlan 20', 'ip address 10.0.20.1 255.255.255.0', 'end');
  return { t: t, r: r, sw: sw, sr: sr, ss: ss };
}

console.log('The pipe filters what a view printed:');
{
  const env = lab();
  const route = text(env.sr.run('show running-config | include route'));
  ok(/^ip route 10\.9\.0\.0/m.test(route), 'include keeps the line with the word in it');
  ok(!/^hostname/m.test(route), 'and drops the lines without it');

  const notHost = text(env.sr.run('show running-config | exclude hostname'));
  ok(!/^hostname/m.test(notHost), 'exclude drops the matching line');
  ok(/^interface Gi0\/0/m.test(notHost), 'and keeps the rest');

  const brief = text(env.sr.run('show ip interface brief | include Gi0/1'));
  ok(/Gi0\/1/.test(brief) && !/Gi0\/0/.test(brief), 'it narrows a table to the row asked for');

  const fromGw = text(env.sr.run('show ip route | begin Gateway'));
  ok(/Gateway/.test(fromGw) && /10\.9\.0\.0\/16/.test(fromGw), 'begin starts at the first matching line');
  ok(!/^Route summary/.test(fromGw) || /Gateway/.test(fromGw.split('\n')[0]),
    'and drops what came before it');

  const sect = text(env.sr.run('show running-config | section interface'));
  ok(/^interface Gi0\/0$/m.test(sect), 'section keeps the stanza headline');
  ok(/^  ip address 10\.0\.0\.1/m.test(sect), 'and the lines indented under it');
  ok(!/^ip route/m.test(sect), 'and nothing from the next stanza');

  const counted = text(env.sr.run('show ip interface brief | count'));
  ok(/^\d+ lines?$/.test(counted.trim()), 'count answers a number of lines');

  const chained = text(env.sr.run('show running-config | include interface | count'));
  ok(/^\d+ lines?$/.test(chained.trim()), 'two pipes in a row apply in order');
}

console.log('\nA filter that matches nothing says so:');
{
  const env = lab();
  const none = text(env.sr.run('show version | include zzzznosuchtext'));
  ok(/nothing in this answer matches/.test(none), 'the empty result is explained');
  ok(/printed \d+ lines?/.test(none), 'and says how much the view did print');
  const noHeader = text(env.sr.run('show ip interface brief | exclude Interface'));
  ok(!/^Interface\s/m.test(noHeader) && /Gi0\/0/.test(noHeader),
    'exclude can take the table header away and leave the rows');
}

console.log('\nA refusal is never filtered away:');
{
  const env = lab();
  const body = text(env.sr.run('show interfaces nosuchport0/99 | include anything'));
  ok(/No interface named/.test(body), 'the refusal comes through the pipe intact');
  ok(!/nothing in this answer matches/.test(body), 'and is not replaced by a filter message');
}

console.log('\nThe pipe is checked, not swallowed:');
{
  const env = lab();
  const unknown = text(env.sr.run('show version | grep IOS'));
  ok(/no "\| grep"/.test(unknown), 'an unknown filter is refused by name');
  ok(/include, exclude, begin, section and count/.test(unknown), 'and the filters that do exist are listed');
  const bare = text(env.sr.run('show version | include'));
  ok(/needs a word/.test(bare), '"| include" with no word says what is missing');
  const leading = text(env.sr.run('| include route'));
  ok(/needs a command before it/.test(leading), 'a pipe with nothing before it says what is missing');
  const inBlock = text(env.sr.run('configure terminal'));
  void inBlock;
  env.sr.run('configure terminal');
  const viaDo = text(env.sr.run('do show running-config | include route'));
  ok(/^ip route 10\.9\.0\.0/m.test(viaDo), '"do show … | include …" works inside a block');
  ok(/\(config\)#/.test(env.sr.prompt()), 'and the prompt stays where it was');
}

console.log('\nA placeholder is completed from the device:');
{
  const env = lab();
  env.ss.run('configure terminal');
  const ports = text(env.ss.run('interface Fa?'));
  ok(/Completions for "interface Fa"/.test(ports), 'interface Fa? answers with a list');
  ok(/Fa0\/1/.test(ports), 'which contains the ports that start with Fa');
  ok(/access VLAN 10/.test(ports), 'and says what each one is');
  ok(/trunk/.test(ports), 'including the trunk');
  const sviv = text(env.ss.run('interface vlan 2?'));
  ok(/^\s*20\s/m.test(sviv), 'interface vlan 2? offers the VLAN id the device has');
  ok(/SVI 10\.0\.20\.1\/24/.test(sviv), 'and says that VLAN already has an address');
  ok(!/^\s*10\s/m.test(sviv), 'and does not offer VLAN 10, which starts with 1 not 2');
  const miss = text(env.ss.run('interface Zz?'));
  ok(/Nothing after "interface" starts with "Zz"/.test(miss), 'a fragment that fits no port is still refused');
  const routed = text(env.sr.run('configure terminal') !== undefined ? env.sr.run('interface Gi?') : '');
  void routed;
}

console.log('\nA `?` against a pipe filter is a question, not filter text:');
{
  // `| inc?` was read as a filter whose text was the help character ("nothing in this answer matches
  // "| inc?""), `| c?` applied count and printed "7 lines", and `| e?` printed the unfiltered view -
  // each of them answering a question nobody asked.
  const env = lab();
  const s = env.sr;
  const inc = text(s.run('show version | inc?'));
  ok(/Filters for "show version"/.test(inc), 'show version | inc? answers with the filters');
  ok(/include <text>/.test(inc), '  narrowing to include');
  ok(/takes the text to look for/.test(inc), '  and saying include takes text');
  ok(!/nothing in this answer matches/.test(inc), '  not by filtering on the help character');
  const i = text(s.run('show version | i?'));
  ok(/include <text>/.test(i) && !/exclude|begin|section|count/.test(i), '| i? narrows to include alone');
  const c = text(s.run('show version | c?'));
  ok(/count/.test(c) && /takes no text/.test(c), '| c? answers about count');
  ok(!/^7 lines$/m.test(c), '  and does not run count');
  const e = text(s.run('show version | e?'));
  ok(/exclude <text>/.test(e), '| e? answers about exclude');
  ok(/PacketForge Router/.test(e) === false, '  and does not print the unfiltered view');
  const s2 = text(s.run('show version | s?'));
  ok(/section <text>/.test(s2), '| s? answers about section');
  // A chain answers about the filter being typed, and names what is already applied.
  const chain = text(s.run('show version | include version | co?'));
  ok(/after \| include version/.test(chain), 'a chained ? names the filters already applied');
  ok(/count/.test(chain), '  and answers about the one being typed');
  // A prefix that matches nothing says so, and lists the five.
  const none = text(s.run('show version | zz?'));
  ok(/No filter starts with "zz"/.test(none), 'a filter prefix that matches nothing is named');
  ok(/include, exclude, begin, section, count/.test(none), '  with the five that exist');
  // The plain trailing-space form still lists everything.
  const all = text(s.run('show version | include ?'));
  ok(/include <text>/.test(all) && /count/.test(all), '| include ? still lists all five');
  // And a real filter still filters.
  ok(/^7 lines$/m.test(text(s.run('show version | count'))), 'a typed filter still runs');
}

console.log('\n`do` is an exec escape from every block, and the page says so:');
{
  // `do show version` runs in every configuration block, but two pages did not name it: `do ?` in
  // interface mode and in a DHCP pool answered "No completions for \"do\"" while completing one mode
  // up. A word the parser takes everywhere is a word the page owes everywhere.
  const blocks = [
    ['config mode', ['configure terminal']],
    ['interface block', ['configure terminal', 'interface Gi0/0']],
    ['OSPF block', ['configure terminal', 'router ospf 1']],
    ['BGP block', ['configure terminal', 'router bgp 65001']],
    ['DHCP pool', ['configure terminal', 'ip dhcp pool LAN']],
    ['standard ACL block', ['configure terminal', 'ip access-list standard 10']],
    ['extended ACL block', ['configure terminal', 'ip access-list extended 101']]
  ];
  for (const [name, steps] of blocks) {
    const t2 = new Topology();
    const d2 = t2.addDevice(find('generic-router')); d2.name = 'R1';
    const s2 = new CliSession(d2, t2, new Simulator(t2)); s2.run('enable');
    for (const step of steps) s2.run(step);
    const q = text(s2.run('do ?'));
    ok(/Next: show/.test(q), name + ': do ? completes to show');
    ok(/PacketForge Router/.test(text(s2.run('do show version'))), name + ': and do show version answers');
    // The page it printed has to contain the word, or the help page and the completion disagree.
    const page = text(s2.run('?'));
    ok(/do show/.test(page), name + ': and the page names do show');
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
