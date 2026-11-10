'use strict';
// vlan-lifecycle.test.js - a VLAN is created, named and removed by four commands, and none of them
// used to agree about whether the VLAN existed.
//
// Measured before this pass, on a `generic-switch`:
//   vlan abc        -> "VLAN NaN created (name: VLAN0NaN)"      (and config.vlans[NaN] written)
//   vlan 9999       -> "% accessVlan 9999 is outside 1-4094"    (the data-model field name, not a VLAN)
//   vlan 30  (again)-> "VLAN 30 created (name: VLAN0030)"       (nothing was created)
//   no vlan 99      -> "VLAN 99 removed"                        (it never existed)
//   no vlan         -> "VLAN NaN removed"
//   no vlan 30      -> "VLAN 30 removed"  while Fa0/1 and Fa0/2 were access ports in it, so
//                      `show vlan` kept printing the VLAN the command said it had deleted
//   show vlan on a router -> VLAN 1 with every router port in it, a bridge domain invented whole
//
// The suite below pins the life cycle: what a create says, what a delete refuses, who a delete would
// strand, and one membership walk shared by the table and the refusal.
const path = require('path');
const { Topology, Simulator, CliSession } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + (actual === expected ? '' : ' (got ' + JSON.stringify(actual) + ')'));
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const SWITCH = catalog.find(function (s) { return s.model === 'generic-switch'; });
const ROUTER = catalog.find(function (s) { return s.model === 'generic-router'; });
const PC = catalog.find(function (s) { return s.model === 'generic-pc'; });

function switchLab() {
  const t = new Topology();
  const sw = t.addDevice(SWITCH); sw.name = 'SW1';
  const pc1 = t.addDevice(PC); pc1.name = 'PC1';
  const pc2 = t.addDevice(PC); pc2.name = 'PC2';
  t.connect(pc1.id, 'eth0', sw.id, 'Fa0/1');
  t.connect(pc2.id, 'eth0', sw.id, 'Fa0/2');
  const sim = new Simulator(t);
  const c = new CliSession(sw, t, sim); c.run('enable');
  for (const [pc, addr] of [[pc1, '10.0.30.1'], [pc2, '10.0.30.2']]) {
    const ps = new CliSession(pc, t, sim);
    ps.run('enable'); ps.run('configure terminal'); ps.run('interface eth0');
    ps.run('ip address ' + addr + ' 255.255.255.0'); ps.run('end');
  }
  const host = function (pc) { const h = new CliSession(pc, t, sim); h.run('enable'); return h; };
  return { t: t, sw: sw, pc1: p1(pc1), pc2: p1(pc2), sim: sim, c: c, host: host };
  function p1(x) { return x; }
}

// Two access ports in VLAN 30, which is the case a delete has to reason about.
function twoPortsIn30() {
  const l = switchLab();
  l.c.run('configure terminal');
  l.c.run('vlan 30');
  for (const port of ['Fa0/1', 'Fa0/2']) {
    l.c.run('interface ' + port);
    l.c.run('switchport mode access');
    l.c.run('switchport access vlan 30');
    l.c.run('exit');
  }
  l.c.run('end');
  return l;
}

console.log('\nvlan <id> says what it did, and refuses what it cannot do:');
{
  const l = switchLab();
  l.c.run('configure terminal');
  eq(l.c.run('vlan').output[0], '% Incomplete command: vlan <id> [name]', 'vlan with no id is incomplete');
  // The usage line quotes the help row's spelling, not a second one of its own.
  ok(l.c.run('help').output.some(function (r) { return /^\s+vlan <id> \[name\]/.test(r); }),
    'and help advertises the same synopsis');
  eq(l.c.run('vlan abc').output[0], '% VLAN id must be a number, not "abc"', 'a word is refused as a word');
  ok(!Object.keys(l.sw.config.vlans || {}).some(function (k) { return k === 'NaN'; }),
    'and no NaN key is written to the config');
  eq(l.c.run('vlan 0').output[0], '% VLAN 0 is outside 1-4094', '0 is out of range, by that name');
  eq(l.c.run('vlan 4095').output[0], '% VLAN 4095 is outside 1-4094', '4095 is out of range');
  eq(l.c.run('vlan 9999').output[0], '% VLAN 9999 is outside 1-4094', '9999 is out of range');
  ok(!/accessVlan/.test(l.c.run('vlan 9999').output.join(' ')),
    'and the refusal does not leak the data-model field name');
  eq(l.c.run('vlan 30').output[0], 'VLAN 30 created (name: VLAN0030)', 'a new VLAN is created');
  eq(l.c.run('vlan 30').output[0], 'VLAN 30 already configured (name: VLAN0030)',
    'typing it again does not claim to create it');
  eq(l.c.run('vlan 30 SALES').output[0], 'VLAN 30 name changed to SALES', 'a second word renames it');
  eq(l.c.run('vlan 30 SALES NET FLOOR2').output[0], 'VLAN 30 name changed to SALES NET FLOOR2',
    'and a name may be several words');
  l.c.run('end');
  ok(l.c.run('show vlan 30').output.some(function (r) { return /SALES NET FLOOR2/.test(r); }),
    'show vlan prints the name as one field');
  l.c.run('configure terminal');
  l.c.run('vlan 31');
  l.c.run('end');
  ok(/SALES NET FLOOR2/.test(l.c.run('show running-config').output.find(function (x) {
    return /^vlan 30 /.test(x);
  }) || ''), 'and running-config round-trips it on one line');
}

console.log('\nno vlan <id> can no longer report a removal that did not happen:');
{
  const l = switchLab();
  l.c.run('configure terminal');
  eq(l.c.run('no vlan').output[0], '% Incomplete command: no vlan <id>', 'no vlan with no id is incomplete');
  eq(l.c.run('no vlan abc').output[0], '% VLAN id must be a number, not "abc"', 'a word is refused');
  eq(l.c.run('no vlan 99').output[0],
    '% No VLAN 99 on SW1 - nothing is configured for it and no port carries it',
    'a VLAN that never existed is refused, not "removed"');
  eq(l.c.run('no vlan 4095').output[0], '% VLAN 4095 is outside 1-4094', 'out of range is refused too');
  l.c.run('vlan 30');
  for (const port of ['Fa0/1', 'Fa0/2']) {
    l.c.run('interface ' + port);
    l.c.run('switchport mode access');
    l.c.run('switchport access vlan 30');
    l.c.run('exit');
  }
  const refused = l.c.run('no vlan 30').output;
  eq(refused[0], '% VLAN 30 is carried by Fa0/1, Fa0/2 - it cannot be removed while those ports are in it',
    'a VLAN that two access ports carry is refused, naming the ports');
  ok(/switchport access vlan <other>/.test(refused[1]), 'and the refusal names the command that frees it');
  ok(/^30\s/.test(l.c.run('show vlan 30').output[1] || ''), 'so the VLAN is still in the table - nothing lied');
}

console.log('\n...and when the ports are freed, the removal is real and says so:');
{
  const l = twoPortsIn30();
  l.c.run('configure terminal');
  for (const port of ['Fa0/1', 'Fa0/2']) {
    l.c.run('interface ' + port);
    l.c.run('switchport access vlan 1');
    l.c.run('exit');
  }
  const out = l.c.run('no vlan 30').output;
  eq(out[0], 'VLAN 30 removed (was named VLAN0030)', 'the removal names what was removed');
  l.c.run('end');
  ok(!l.c.run('show vlan').output.some(function (r) { return /^30\s/.test(r); }),
    'and show vlan no longer lists VLAN 30');
  ok(!l.c.run('show running-config').output.some(function (r) { return /^vlan 30 /.test(r); }),
    'nor does running-config');
  l.c.run('configure terminal');
  eq(l.c.run('no vlan 30').output[0],
    '% No VLAN 30 on SW1 - nothing is configured for it and no port carries it',
    'removing it twice is refused the second time');
}

console.log('\nA trunk is a different dependency from an access port, and is treated as one:');
{
  // Native VLAN: the trunk classifies untagged frames into it, so it cannot vanish underneath.
  const l = switchLab();
  l.c.run('configure terminal');
  l.c.run('vlan 30');
  l.c.run('interface Fa0/8');
  l.c.run('switchport mode trunk');
  l.c.run('switchport trunk native vlan 30');
  l.c.run('exit');
  const nativeRefusal = l.c.run('no vlan 30').output;
  eq(nativeRefusal[0], '% VLAN 30 is carried by Fa0/8 (native) - it cannot be removed while those ports are in it',
    'a trunk native VLAN blocks the removal, and the port is marked (native)');

  // Allowed list: the trunk merely passes it, so the removal prunes the list and says so.
  const m = switchLab();
  m.c.run('configure terminal');
  m.c.run('vlan 30');
  m.c.run('interface Fa0/8');
  m.c.run('switchport mode trunk');
  m.c.run('switchport trunk allowed vlan 10,30');
  m.c.run('exit');
  const pruned = m.c.run('no vlan 30').output;
  eq(pruned[0], 'VLAN 30 removed (was named VLAN0030)', 'a trunk that only lists the VLAN does not block it');
  ok(pruned.some(function (x) { return /Fa0\/8: VLAN 30 removed from the allowed list/.test(x); }),
    'and the trunk says its allowed list shrank');
  m.c.run('end');
  const trunkRow = m.c.run('show vlan 10').output.filter(function (r) { return /Fa0\/8/.test(r); })[0] || '';
  ok(/Fa0\/8\(t\)/.test(trunkRow), 'show vlan still shows the trunk in VLAN 10');
  ok(!m.c.run('show vlan').output.some(function (r) { return /^30\s/.test(r); }),
    'and VLAN 30 is gone from the table, so the two views agree');
}

console.log('\nThe table and the refusal read one membership walk:');
{
  const l = switchLab();
  l.c.run('configure terminal');
  l.c.run('vlan 30');
  l.c.run('interface Fa0/3'); l.c.run('switchport mode access'); l.c.run('switchport access vlan 30'); l.c.run('exit');
  l.c.run('interface Fa0/8'); l.c.run('switchport mode trunk'); l.c.run('switchport trunk native vlan 30'); l.c.run('exit');
  const tableRow = l.c.run('show vlan 30').output.find(function (r) { return /^30\s/.test(r); }) || '';
  const refusal = l.c.run('no vlan 30').output[0];
  for (const port of ['Fa0/3', 'Fa0/8']) {
    ok(tableRow.indexOf(port) !== -1, 'show vlan 30 lists ' + port);
    ok(refusal.indexOf(port) !== -1, 'and no vlan 30 names it as a blocker');
  }
  l.c.run('end');
  const listing = l.c.run('show vlan 30').output.join('\n');
  ok(!/Fa0\/1\b/.test(listing), 'a port in VLAN 1 is not claimed as a VLAN 30 member by either view');
}

console.log('\nA VLAN is a bridge domain, not a label - the data path proves it:');
{
  // `Success rate is 100 percent` contains the substring `0 percent`, which made an earlier version of
  // this assertion vacuous: it passed whatever the lab did. Match the whole sentence.
  const rate = function (out) {
    const m = /Success rate is (\d+) percent/.exec(out.join(' '));
    return m ? Number(m[1]) : null;
  };
  const l = twoPortsIn30();
  eq(rate(l.host(l.pc1).run('ping 10.0.30.2 count 1').output), 100,
    'two hosts whose ports are both in VLAN 30 reach each other');
  // Same VLAN, both ports: this is the case that must work.
  const m = switchLab();
  m.c.run('configure terminal');
  for (const port of ['Fa0/1', 'Fa0/2']) {
    m.c.run('interface ' + port);
    m.c.run('switchport mode access');
    m.c.run('switchport access vlan 30');
    m.c.run('exit');
  }
  m.c.run('end');
  const up = m.host(m.pc1).run('ping 10.0.30.2 count 1').output;
  eq(rate(up), 100, 'the same lab, built the long way, reaches too');
  m.c.run('configure terminal');
  m.c.run('interface Fa0/2');
  m.c.run('switchport access vlan 40');
  m.c.run('exit');
  m.c.run('end');
  const apart = m.host(m.pc1).run('ping 10.0.30.2 count 1').output;
  eq(rate(apart), 0, 'moving one port to another VLAN separates them - so the VLAN is a real domain');
}

console.log('\nA device that does not bridge declares VLANs but has no members to invent:');
{
  const t = new Topology();
  const r = t.addDevice(ROUTER); r.name = 'R1';
  const c = new CliSession(r, t, new Simulator(t)); c.run('enable');
  c.run('configure terminal');
  eq(c.run('vlan 99 users').output[0], 'VLAN 99 created (name: users)',
    'a router may declare a VLAN (its config round-trips it)');
  c.run('end');
  const out = c.run('show vlan').output;
  const row99 = out.find(function (x) { return /^99\s/.test(x); }) || '';
  ok(/users/.test(row99), 'show vlan shows the declaration');
  ok(/\s-\s*$/.test(row99), 'with no port membership, because a router does not bridge');
  ok(!out.some(function (x) { return /Gi0\/0/.test(x); }),
    'and no router port is claimed to be in VLAN 1');
  // A header plus VLAN 99, and no VLAN 1: the router never declared VLAN 1, and printing it as a
  // row with "-" in the Ports column was inventing the one object a router cannot have. (This used
  // to assert three lines - header, VLAN 1, VLAN 99 - which encoded the invention.)
  ok(out.length === 2, 'the table is a header plus the VLAN the router declared, and nothing else');
  ok(!out.some(function (x) { return /^1\s/.test(x); }), 'with no VLAN 1 that was never declared');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
