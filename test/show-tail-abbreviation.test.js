'use strict';
// A shortened keyword is still a keyword - at the tail of a `show` line, not just its first word.
//
// The vendor's rule is written for "commands and keywords", with no position and no mode in it: "You need to enter
// only enough characters for the switch to recognize the command as unique" (Catalyst 2960 12.2(46)SE Software
// Configuration Guide, Using the Command-Line Interface - the same sentence appears under "Understanding Abbreviated
// Commands" in the 2960-X 15.2(2)E routing guide). Operators write exactly that, and their pasted sessions prove the
// box accepted it:
//
//   switch01# sh ip int br          Community attachment "ports.txt" (a 2960/3560 stack, `sh int status` beside it)
//   CoreSW1#sh ip int br | ex un    community.cisco.com/t5/routing/please-help-me-to-configure-below-network-topology/td-p/4054592
//   SW1#sh vlan  br                 community.cisco.com/t5/switching/cant-access-my-management-vlan-address-of-my-switch/td-p/3712129
//   CORE#sh etherc summ             community.cisco.com/t5/routing-and-sd-wan/ospf-neighborship-keeps-dropping-and-reforming/td-p/4402814
//   SW1#sh etherchannel sum         community.cisco.com/t5/switching/few-questions-about-etherchannel/m-p/1056635
//   R1#sh lldp nei                  learningnetwork.cisco.com/s/question/0D53i00000Kt0IKCAZ/speed-mismatch-magic
//
// This console resolved the first word after `show` (research/command-word-abbreviation.md) and nothing after it, so
// every one of those lines answered the typo sentence - `% show vlan does not take "br"`, `% Invalid show command: ip
// int br`. research/show-tail-abbreviation.md carries the sources and the boundary: a shortening is accepted only at
// a slot where the vendor's own syntax lists nothing else starting with the same letters, and the positions where an
// image may hold a rival (`show mac add`, `show ip i`) keep their refusal, because accepting there would claim an
// answer another image calls `% Ambiguous command`.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const ROOT = path.join(__dirname, '..');
const catalog = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
function spec(model) { return catalog.filter(function (s) { return s.model === model; })[0]; }

const t = new Topology();
const sim = new Simulator(t);
function add(model, name) {
  t.addDevice(spec(model), name);
  return t.getDevice(name);
}
const sw = add('generic-switch', 'sw1');
const rtr = add('generic-router', 'r1');

// Every line lands through a fresh session, so one answer cannot be shaped by the mode an earlier line left.
function say(dev, line) {
  const s = new CliSession(dev, t, sim);
  const res = s.run(line);
  return (res && res.output ? res.output : []).map(String);
}
function configure(dev, lines) {
  const s = new CliSession(dev, t, sim);
  for (const l of lines) s.run(l);
}
// A shortening has to reach the *same* answer, line for line - not merely a table with the right heading.
function same(dev, short, whole) {
  const a = say(dev, short), b = say(dev, whole);
  return { equal: JSON.stringify(a) === JSON.stringify(b), a: a, b: b };
}

configure(sw, ['enable', 'conf t', 'interface Fa0/1', 'channel-group 1 mode active', 'end']);
configure(rtr, ['enable', 'conf t', 'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'end']);

console.log('');
console.log('`show vlan br` is `show vlan brief`:');
{
  for (const short of ['show vlan br', 'show vlan b', 'show vlan bri', 'show   vlan   br']) {
    const r = same(sw, short, 'show vlan brief');
    ok(r.equal, '`' + short + '` prints the brief table, byte for byte', r.a.slice(0, 1).join(' | '));
    ok(!r.a.some(function (l) { return /^%/.test(l); }), 'with no refusal in it', r.a.join(' | '));
  }
  const brief = say(sw, 'show vlan br');
  ok(/^VLAN/.test(brief[0]), 'the header is the vendor table\'s, not a paraphrase', brief[0]);
  ok(brief.some(function (l) { return /Fa0\/2/.test(l); }), 'and the access ports are in its Ports column', brief.join(' | '));
}

console.log('');
console.log('`show lldp nei` is `show lldp neighbors`:');
{
  for (const short of ['show lldp nei', 'show lldp n', 'show lldp neighbo']) {
    const r = same(sw, short, 'show lldp neighbors');
    ok(r.equal, '`' + short + '` prints the neighbour view', r.a.slice(0, 1).join(' | '));
  }
  const brit = same(sw, 'show lldp neighbou', 'show lldp neighbours');
  ok(brit.equal, '`show lldp neighbou` reaches `neighbours`, not `neighbors`', brit.a.slice(0, 2).join(' | '));
  ok(brit.a.some(function (l) { return /Capability codes/.test(l); }), 'and prints the neighbour table', brit.a.join(' | '));
  const status = say(sw, 'show lldp');
  ok(status.some(function (l) { return /Global LLDP Information/.test(l); }),
    '`show lldp` on its own is still the status view', status.slice(0, 1).join(' | '));
}

console.log('');
console.log('`show ether sum` is `show etherchannel summary`:');
{
  for (const short of ['show ether sum', 'show ether summ', 'show ether s', 'show etherc summ']) {
    const r = same(sw, short, 'show etherchannel summary');
    ok(r.equal, '`' + short + '` prints the summary', r.a.slice(0, 1).join(' | '));
  }
  const grouped = same(sw, 'show etherchannel 1 s', 'show etherchannel 1 summary');
  ok(grouped.equal, 'the group-numbered form shortens too (`show etherchannel 1 s`)', grouped.a.slice(0, 2).join(' | '));
  const row = say(sw, 'show ether s');
  ok(row.some(function (l) { return /Number of channel-groups in use/.test(l); }), 'the counts are there', row.join(' | '));
  ok(row.some(function (l) { return /\bPo1\b/.test(l); }), 'and the bundle the member created', row.join(' | '));
  // `p` could be port, port-channel or protocol: a prefix with rivals is not resolved (see the note).
  const p = say(sw, 'show ether p');
  ok(p.length === 1 && /^% show ether does not take "p"/.test(p[0]), '`show ether p` is still refused, not guessed', p.join(' | '));
  const detail = say(sw, 'show ether detail');
  ok(/is a view this console does not have/.test(detail[0]),
    '`show ether detail` still answers in the unbuilt-view words', detail[0]);
}

console.log('');
console.log('`show ip interface br` is `show ip interface brief`:');
{
  for (const short of ['show ip interface br', 'show ip interface b', 'show ip interface bri']) {
    const r = same(rtr, short, 'show ip interface brief');
    ok(r.equal, '`' + short + '` prints the brief table', r.a.slice(0, 1).join(' | '));
  }
  const brief = say(rtr, 'show ip interface br');
  ok(brief.some(function (l) { return /^GigabitEthernet0\/0\s+10\.0\.0\.1\s+YES\s+manual/.test(l); }),
    'with the address and its Method under the header', brief.join(' | '));
  // The tail position also takes a port, and that must not change: a name is a name.
  const port = say(rtr, 'show ip interface Gi0/0');
  ok(port.length > 1 && /Gi0\/0 \(ethernet/.test(port[0]), '`show ip interface Gi0/0` is still the port block', port.slice(0, 1).join(' | '));
  const nope = say(rtr, 'show ip interface ZZZNOPE');
  ok(nope.length === 1 && /^% No interface ZZZNOPE/.test(nope[0]), 'and an unknown name still gets the no-such-port sentence', nope.join(' | '));
  const junk = say(rtr, 'show ip interface brief ZZZNOPE');
  ok(/^% show ip interface brief does not take "ZZZNOPE"/.test(junk[0]), 'a word after `brief` is still refused', junk[0]);
}

console.log('');
console.log('the positions where an image may hold a rival keep their refusal:');
{
  // `show mac add` is accepted on a 3750/6509 and `% Ambiguous command` on an image that also has `show mac
  // address` (HSM Press CCNA lab, answer C of its CLI-errors quiz). Neither answer is the console's to claim.
  for (const line of ['show mac a', 'show mac ad', 'show mac add']) {
    const r = say(sw, line);
    ok(r.length === 1 && /^% Invalid show command: mac/.test(r[0]),
      '`' + line + '` is still refused rather than guessed', r.join(' | '));
  }
  // `show ip i` is `interface` on a LAN switch and `interface | inspect` on a router image.
  for (const line of ['show ip i', 'show ip in', 'show ip int', 'show ip int br', 'show ip ro']) {
    const r = say(rtr, line);
    ok(r.length === 1 && /^% Invalid show command: ip/.test(r[0]),
      '`' + line + '` is still refused', r.join(' | '));
  }
  // `show vlan i` would be `id` here and `id | ifindex` elsewhere, so only `brief` gets a completion.
  const vid = say(sw, 'show vlan i');
  ok(vid.length === 1 && /^% show vlan does not take "i"/.test(vid[0]), '`show vlan i` is not resolved to `id`', vid.join(' | '));
  const vidFull = say(sw, 'show vlan id 1');
  ok(vidFull.length === 1 && /^% show vlan does not take "id 1"/.test(vidFull[0]),
    'while the whole word `id` behaves exactly as it did', vidFull.slice(0, 1).join(' | '));
  // A tail that is no prefix of anything is unchanged, at every position this run touched.
  const none = [['show vlan zzz', /does not take "zzz"/], ['show lldp zzz', /does not take "zzz"/],
    ['show ether zzz', /does not take "zzz"/]];
  for (const pair of none) {
    const r = say(sw, pair[0]);
    ok(r.length >= 1 && pair[1].test(r[0]), '`' + pair[0] + '` still refuses the word it cannot use', r[0]);
  }
}

console.log('');
console.log('the same lines work from config mode behind `do`:');
{
  const s = new CliSession(sw, t, sim);
  s.run('enable'); s.run('conf t');
  const res = s.run('do show vlan br');
  const lines = (res && res.output ? res.output : []).map(String);
  ok(lines.some(function (l) { return /^VLAN/.test(l); }), '`do show vlan br` prints the brief table', lines.slice(0, 1).join(' | '));
  ok(s.mode === 'config', 'and the mode is left alone', String(s.mode));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
