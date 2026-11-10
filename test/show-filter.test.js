'use strict';
// show-filter.test.js - a filtered view that answers everything looks like a filter and is worse
// than none: the operator reads the output as "yes, that list is here".
//
// `show access-lists [<name>]` was in the help and on the page, and the name was never read:
//
//   R1#show access-lists TEST
//   Extended IP access list 101          <- not the list that was asked for
//   ...
//   R1#show access-lists NOSUCH
//   Extended IP access list 101          <- the same table, for a name that does not exist
//
// The suite also pins the ordering fix that came with it (a named list used to be sorted by
// parseInt, so every name was NaN) and the pool rule the same probe surfaced: leaving `ip dhcp pool`
// without an address range discards the pool instead of leaving a half-configured one behind.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function saw(re, haystack, msg) {
  const text = (haystack && haystack.output) ? haystack.output.join('\n') : String(haystack);
  ok(re.test(text), msg + (re.test(text) ? '' : ' (in ' + JSON.stringify(text.slice(0, 500)) + ')'));
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));

function lab(prep) {
  const t = new Topology();
  const d = t.addDevice(catalog.filter(function (x) { return x.model === 'generic-router'; })[0]);
  d.name = 'R1';
  const s = new CliSession(d, t, new Simulator(t));
  s.run('enable'); s.run('configure terminal');
  (prep || []).forEach(function (line) { s.run(line); });
  s.run('end');
  return { t: t, d: d, s: s };
}

const TWO_LISTS = [
  'access-list 101 permit ip 192.168.1.0 0.0.0.255 any',
  'ip access-list extended VOICE',
  'permit udp any any eq 5060',
  'exit'
];

console.log('\nThe name in "show access-lists <name>" narrows the table:');
{
  const env = lab(TWO_LISTS);
  const all = env.s.run('show access-lists').output.join('\n');
  ok(/101/.test(all) && /VOICE/.test(all), 'unfiltered: both lists are there');
  const one = env.s.run('show access-lists 101');
  const text = one.output.join('\n');
  ok(/101/.test(text), 'filtered by number: list 101 is shown');
  ok(!/VOICE/.test(text), 'and the named list is not');
  const named = env.s.run('show access-lists VOICE');
  const ntext = named.output.join('\n');
  ok(/VOICE/.test(ntext), 'filtered by name: the named list is shown');
  ok(!/101/.test(ntext), 'and the numbered list is not');
  const lower = env.s.run('show access-lists voice');
  ok(/VOICE/.test(lower.output.join('\n')), 'the name is matched case-insensitively');
}

console.log('\nA name that is not there is refused, and says what is:');
{
  const env = lab(TWO_LISTS);
  const out = env.s.run('show access-lists NOSUCH');
  saw(/No access list NOSUCH on R1/, out, 'the refusal names the list that was asked for');
  saw(/101|VOICE/, out, 'and lists the ones that exist');
  const empty = lab([]).s.run('show access-lists GHOST');
  saw(/No access list GHOST/, empty, 'on a device with no lists at all');
  saw(/access-list <number> permit/, empty, 'the answer says how to make one');
}

console.log('\nOrdering is by number, then by name:');
{
  const env = lab(TWO_LISTS.concat(['access-list 120 permit ip any any']));
  const lines = env.s.run('show access-lists').output;
  const idx = function (re) {
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return i;
    return -1;
  };
  const i101 = idx(/access list 101/);
  const i120 = idx(/access list 120/);
  const iVoice = idx(/access list VOICE/);
  ok(i101 !== -1 && i120 !== -1 && iVoice !== -1, 'all three lists are listed');
  ok(i101 < i120, 'numeric lists are in numeric order (101 before 120)');
  ok(i120 < iVoice, 'and named lists come after the numbered ones');
}

console.log('\nA port filter finds a pinned address by the subnet it sits in:');
{
  const env = lab([]);
  env.s.run('configure terminal');
  env.s.run('interface Gi0/0'); env.s.run('ip address 10.10.0.1 255.255.255.0'); env.s.run('exit');
  env.s.run('interface Gi0/1'); env.s.run('ip address 10.20.0.1 255.255.255.0'); env.s.run('exit');
  env.s.run('arp 10.10.0.5 00:11:22:33:44:55');
  env.s.run('arp 10.20.0.5 00:11:22:33:44:66');
  env.s.run('arp 172.16.0.9 00:11:22:33:44:77');
  env.s.run('end');
  // A hand-written entry has no owner in the topology, so its port used to be "-" and this view
  // answered "(none)" for a port the address plainly belongs to.
  const p0 = env.s.run('show arp Gi0/0');
  saw(/10\.10\.0\.5/, p0, 'the pinned address in Gi0/0\'s subnet is listed under Gi0/0');
  ok(!/10\.20\.0\.5/.test(p0.output.join('\n')), 'and the other port\'s entry is not');
  saw(/STATIC/, p0, 'with the marker that makes it a pinned entry');
  const p1 = env.s.run('show arp Gi0/1');
  saw(/10\.20\.0\.5/, p1, 'the other port filters its own entry');
  const all = env.s.run('show arp');
  saw(/Gi0\/0\s+STATIC/, all, 'the unfiltered table names the port too');
  // An address outside every local subnet stays `-`: guessing a port for it would invent a fact.
  saw(/172\.16\.0\.9/, all, 'an off-subnet pinned address is still in the table');
  const off = env.s.run('show arp Gi0/0');
  ok(!/172\.16\.0\.9/.test(off.output.join('\n')), 'and is not attributed to a port it is not in');
}

console.log('\nA pool is only a pool once it can hand out an address:');
{
  const env = lab([]);
  env.s.run('configure terminal');
  env.s.run('ip dhcp pool HALF');
  env.s.run('network 192.168.60.0 255.255.255.0');
  const exit = env.s.run('exit');
  saw(/no address range/, exit, 'leaving without a range says why the pool will not exist');
  const pools = env.d.config.dhcpPools || [];
  ok(!pools.some(function (p) { return p.name === 'HALF'; }), 'and the half-built pool is not left behind');
  saw(/no DHCP pools/, env.s.run('show ip dhcp pool'),
    'so the view agrees with the console - no pool is listed');
  // With a range it is kept, and the view shows it.
  env.s.run('ip dhcp pool FULL');
  env.s.run('network 192.168.60.0 255.255.255.0');
  env.s.run('range 192.168.60.100 192.168.60.120');
  env.s.run('exit');
  const shown = env.s.run('show ip dhcp pool');
  saw(/FULL/, shown, 'a complete pool is listed');
  saw(/192\.168\.60\.100 - 192\.168\.60\.120/, shown, 'with the range it will hand out');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
