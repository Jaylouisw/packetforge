'use strict';
// A `show` command with words it cannot use refuses them; it never answers as if nothing was asked (#1403).
//
// The lens this iteration: last time it was "do two reports of one box agree about how many ports it has", which
// found the MAC filter that was accepted and dropped. So the question here was narrower and blunt - point every
// `show` command that takes a filter at arguments nobody implemented, and see whether the answer changes. Twelve
// of fourteen did not. The worst was not the empty ones:
//
//   r1#show ip route 192.0.2.0/24
//   Codes: C - connected, S - static, O - OSPF, B - BGP
//   C   10.0.0.0       /24  is directly connected, Gi0
//
// The table held one route, 10.0.0.0/24, and the question was whether 192.0.2.0/24 was installed. The answer
// printed a different prefix, and an operator scanning for their prefix sees a table with a route in it. A silent
// drop is a wrong answer; a refusal is the truth.
//
// Nine commands now refuse a tail they cannot use, each naming what it does print. Two keep filtering, because the
// filter exists: `show interfaces` and `show mac address-table interface` (#1401). And an unknown port in the OSPF
// reports is named as unknown rather than described as a port that carries no OSPF, which was a claim about a
// socket the box does not have.
const path = require('path');
const { CliSession } = require('../engine/cli');
const { Topology } = require('../engine/topology');
const { Simulator } = require('../engine/simulator');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const pick = function (m) { return catalog.filter(function (s) { return s.model === m; })[0]; };

// A lab with something in every table: a routed prefix, a neighbour learned in the ARP cache, a MAC in the switch
// table, an OSPF process. A refusal is only meaningful where the full answer would have had content.
const t = new Topology();
t.addDevice(pick('C9300-24T'), 'sw1');
t.addDevice(pick('ISR 4331'), 'r1');
t.addDevice(pick('Raspberry Pi 5'), 'h1');
t.addDevice(pick('Raspberry Pi 5'), 'h2');
const swPorts = Array.from(t.getDevice('sw1').interfaces.keys());
const rPorts = Array.from(t.getDevice('r1').interfaces.keys());
const RP = rPorts[0];
const L = { mediaId: '1000base-t', speedMbps: 1000 };
t.connect('h1', 'eth0', 'sw1', swPorts[0], L);
t.connect('h2', 'eth0', 'sw1', swPorts[1], L);
t.connect('r1', RP, 'sw1', swPorts[2], L);

function configure(devId, cmds) {
  const s = new CliSession(t.getDevice(devId), t, new Simulator(t));
  s.run('enable'); s.run('configure terminal');
  for (const c of cmds) s.run(c);
  s.run('end');
}
configure('r1', ['interface ' + RP, 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
  'ospf router-id 10.0.0.1', 'router ospf 1', 'network 10.0.0.0 0.0.0.255 area 0']);
configure('h1', ['interface eth0', 'ip address 10.0.0.2 255.255.255.0']);
configure('h2', ['interface eth0', 'ip address 10.0.0.3 255.255.255.0']);

const sim = new Simulator(t);
sim.setRunTime(60000);
sim.ping('h1', '10.0.0.3', { count: 1 });
sim.ping('h1', '10.0.0.1', { count: 1 });

function show(devId, cmd) {
  const s = new CliSession(t.getDevice(devId), t, sim);
  s.run('enable');
  return (s.run(cmd).output || []).join('\n');
}
const isRefusal = function (text) { return /^% /.test(text) && text.indexOf('\n') === -1; };

console.log('The tables have content, so a drop is visible');
{
  ok(/\d+\.\d+\.\d+\.\d+/.test(show('r1', 'show ip route')), 'show ip route on r1 lists the connected prefix');
  ok(/10\.0\.0\./.test(show('r1', 'show arp')), 'show arp on r1 lists a neighbour');
  ok(/Gi1\/0\/1|1\/0\/1/.test(show('sw1', 'show ip interface brief')), 'show ip interface brief lists the ports');
  ok(show('sw1', 'show running-config').split('\n').length > 5, 'show running-config prints a configuration');
  ok(show('sw1', 'show vlan').split('\n').length > 1, 'show vlan lists a VLAN');
  ok(show('sw1', 'show spanning-tree').split('\n').length > 1, 'show spanning-tree has a tree to print');
}

console.log('');
console.log('Each of them refuses words it cannot use, and says what it does print');
const REFUSALS = [
  ['r1', 'show ip route 192.0.2.0/24', 'show ip route', '192.0.2.0/24'],
  ['r1', 'show ip route 10.0.0.0 255.255.255.0', 'show ip route', '10.0.0.0 255.255.255.0'],
  ['r1', 'show arp 10.0.0.2', 'show arp', '10.0.0.2'],
  ['r1', 'show ip interface brief ' + RP, 'show ip interface brief', RP],
  ['sw1', 'show running-config interface ' + swPorts[0], 'show running-config', 'interface ' + swPorts[0]],
  ['sw1', 'show vlan 999', 'show vlan', '999'],
  ['sw1', 'show vlan brief extra', 'show vlan brief', 'extra'],
  ['sw1', 'show spanning-tree ' + swPorts[0], 'show spanning-tree', swPorts[0]],
  ['sw1', 'show lldp neighbors ' + swPorts[0], 'show lldp neighbors', swPorts[0]],
  ['sw1', 'show lldp bogus', 'show lldp', 'bogus'],
  ['sw1', 'show access-lists 101', 'show access-lists', '101'],
  ['sw1', 'show version now', 'show version', 'now']
];
for (const c of REFUSALS) {
  const out = show(c[0], c[1]);
  ok(isRefusal(out), 'refused: ' + c[1], out.split('\n').slice(0, 2).join(' | '));
  ok(out.indexOf('"' + c[3] + '"') !== -1, 'quoting the words typed: "' + c[3] + '"', out);
  ok(out.indexOf(c[2]) !== -1, 'naming the command: ' + c[2], out);
}
// The refusal must not be a table with a sentence on top: it is one line, and it does not print the rows.
for (const c of REFUSALS) {
  const out = show(c[0], c[1]);
  ok(out.split('\n').length === 1, 'one line, not a table: ' + c[1], String(out.split('\n').length));
}

console.log('');
console.log('The documented forms are untouched');
const FORMS = [
  ['r1', 'show ip route', /Codes: C - connected/],
  ['r1', 'show arp', /Protocol/],
  ['r1', 'show ip interface brief', /Interface\s+IP-Address/],
  ['sw1', 'show running-config', /! PacketForge running-config/],
  ['sw1', 'show vlan', /VLAN\s+Name/],
  ['sw1', 'show vlan brief', /VLAN\s+Name/],
  ['sw1', 'show spanning-tree', /Spanning tree/],
  ['sw1', 'show lldp', /LLDP neighbours/],
  ['sw1', 'show lldp neighbors', /LLDP neighbours/],
  ['sw1', 'show access-lists', /access list/i],
  ['sw1', 'show version', /PacketForge|Version/i]
];
for (const f of FORMS) {
  const out = show(f[0], f[1]);
  // `show access-lists` on a box with no lists answers with a device-level sentence that begins with '%'. That is
  // an answer, not a refusal - the distinction this suite exists to make, so it is judged by the sentence.
  const benigned = f[1] === 'show access-lists';
  ok(f[2].test(out) && (benigned || !isRefusal(out)), 'still answers: ' + f[1], out.split('\n')[0]);
}

console.log('');
console.log('The two commands that really do filter still filter (#1401 is not undone)');
{
  const one = show('sw1', 'show interfaces ' + swPorts[0]);
  ok(/^ {2}status: /m.test(one) && one.indexOf(swPorts[1]) === -1, 'show interfaces <port> answers about one port');
  const macs = show('sw1', 'show mac address-table interface ' + swPorts[0]);
  ok(!/Port 2|Gi1\/0\/2$/.test(macs), 'show mac address-table interface <port> filters', macs);
  const bad = show('sw1', 'show interfaces ' + swPorts[0] + 'x');
  ok(/^% No interface /.test(bad), 'and an unknown port is still refused by name', bad);
}

console.log('');
console.log('An unknown port in the OSPF reports is not a port that carries no OSPF');
{
  const nb = show('r1', 'show ip ospf neighbor NOSUCH');
  ok(/^% No interface NOSUCH/.test(nb), 'show ip ospf neighbor refuses an unknown port by name', nb);
  ok(/on /.test(nb), 'and says which box it looked on', nb);
  const ifc = show('r1', 'show ip ospf interface NOSUCH');
  ok(/^% No interface NOSUCH on /.test(ifc), 'show ip ospf interface says the same sentence', ifc);
  const real = show('r1', 'show ip ospf neighbor ' + RP);
  ok(!isRefusal(real) && /no neighbour on|Neighbor ID/.test(real), 'a port that exists is still described', real.split('\n')[0]);
  const converged = show('r1', 'show ip ospf process');
  ok(/Routing Process/.test(converged), 'the process report is unchanged', converged.split('\n')[0]);
}

console.log('');
console.log('No other `show` command in the console silently drops a tail');
{
  // The sweep: every `show` command the console documents, given a word nobody implemented. Each must answer
  // without the word (a command that takes no argument at all), or refuse it. What must not happen is an answer
  // that is identical to the answer with no word, for a command that help says takes none.
  const NO_ARG = ['show version', 'show ip interface brief', 'show ip route', 'show arp', 'show vlan',
    'show vlan brief', 'show spanning-tree', 'show lldp', 'show lldp neighbors', 'show access-lists',
    'show running-config', 'show etherchannel summary', 'show vrrp'];
  const silent = [];
  for (const cmd of NO_ARG) {
    const bare = show('sw1', cmd);
    const tailed = show('sw1', cmd + ' ZZZNOPE');
    if (tailed === bare) silent.push(cmd);
  }
  ok(silent.length === 0, 'every one of them refuses the tail or explains why the word is irrelevant',
    silent.join(', '));

  // `show power inline` is judged on a box that has a PSE: there, a port name is either resolved or refused, and
  // on a box with no PSE at all the device-level sentence ("no port on this device can supply power") is the
  // answer to any question about power, so the name changes nothing and is not a drop.
  const t2 = new Topology();
  t2.addDevice(pick('ES-24-250W'), 'poe1');
  t2.addDevice(pick('Raspberry Pi 5'), 'ph1');
  t2.connect('ph1', 'eth0', 'poe1', 'Port 1', { mediaId: '1000base-t', speedMbps: 1000 });
  const sim2 = new Simulator(t2);
  sim2.setRunTime(60000);
  sim2.computePoe();
  const poe = function (cmd) {
    const s = new CliSession(t2.getDevice('poe1'), t2, sim2);
    s.run('enable');
    return (s.run(cmd).output || []).join('\n');
  };
  ok(poe('show power inline Port 1') !== poe('show power inline ZZZNOPE'),
    'show power inline tells a real port from an unknown one');
  ok(/^% No interface ZZZNOPE/.test(poe('show power inline ZZZNOPE')),
    'and refuses the unknown one by name', poe('show power inline ZZZNOPE'));
  const noPse = show('sw1', 'show power inline ZZZNOPE');
  ok(/no port on this device can supply power/.test(noPse),
    'on a box with no PSE the device-level sentence is the answer, whatever was typed', noPse);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
