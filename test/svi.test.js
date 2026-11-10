'use strict';
// svi.test.js — `interface vlan <id>`, the switch's own address.
//
// A switch had no management address at all: `show ip interface brief` on a 28-port switch was 28
// rows of `unassigned`, and there was no command that could change that. The symptom was smaller
// than the cause. `ownsIpOn()` in engine/device.js already carried the rule — "a switch's management
// address belongs to a VLAN, not to a socket, so any port in that same access VLAN can reach it" —
// and nothing could create the object the rule was written for. Two labs I built in earlier wakes hit
// it and I worked around it without noticing what I was working around.
//
// What this suite pins is the behaviour a management address has to have, not the existence of a
// field: it answers ARP, it answers echo, it answers with *one* MAC from every port in its VLAN, it
// stops answering when shut, it does not turn the switch into a router, and it survives a dump.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + (actual === expected ? '' : '\n      got: ' + JSON.stringify(actual) +
    '\n      want: ' + JSON.stringify(expected)));
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(v, m) {
  const s = catalog.find(function (x) { return x.vendor === v && x.model === m; });
  if (!s) throw new Error('missing spec ' + v + '/' + m);
  return s;
}
function model(m) {
  const s = catalog.find(function (x) { return x.model === m; });
  if (!s) throw new Error('missing model ' + m);
  return s;
}
const SWITCH = ['aruba', 'CX 6000 24G CL4 PoE 4SFP 370W'];

function answer(dev, t, sim, cmds) {
  return runCommands(dev, t, sim, ['enable'].concat(cmds)).lines.filter(function (l) {
    return !/^[^\s#>]+[#>]\s?/.test(l);
  });
}
const text = (dev, t, sim, cmds) => answer(dev, t, sim, cmds).join('\n');
function refusals(dev, t, sim, cmds) {
  return answer(dev, t, sim, cmds).filter(function (l) { return /^%/.test(l); });
}

// One switch, two hosts, both in VLAN 10, plus a second VLAN with its own host - so isolation is
// testable rather than assumed.
function lab() {
  const t = new Topology();
  const sw = t.addDevice(spec(SWITCH[0], SWITCH[1]));
  const h1 = t.addDevice(model('generic-pc'));
  const h2 = t.addDevice(model('generic-pc'));
  const h3 = t.addDevice(model('generic-pc'));
  sw.name = 'SW1'; h1.name = 'H1'; h2.name = 'H2'; h3.name = 'H3';
  t.connect(h1.id, 'eth0', sw.id, '1/1/3');
  t.connect(h2.id, 'eth0', sw.id, '1/1/4');
  t.connect(h3.id, 'eth0', sw.id, '1/1/5');
  const sim = new Simulator(t);
  const cfg = ['configure terminal', 'hostname SW1',
    'vlan 10 mgmt',
    'vlan 20 users',
    'interface vlan 10', 'ip address 10.10.0.1 255.255.255.0', 'exit',
    'interface 1/1/3', 'switchport mode access', 'switchport access vlan 10', 'exit',
    'interface 1/1/4', 'switchport mode access', 'switchport access vlan 10', 'exit',
    'interface 1/1/5', 'switchport mode access', 'switchport access vlan 20', 'exit',
    'exit'];
  const refused = refusals(sw, t, sim, cfg);
  if (refused.length) throw new Error('lab config refused: ' + refused.join(' / '));
  runCommands(h1, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.10.0.10 255.255.255.0', 'exit', 'exit']);
  runCommands(h2, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.10.0.11 255.255.255.0', 'exit', 'exit']);
  runCommands(h3, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.20.0.10 255.255.255.0', 'exit', 'exit']);
  return { t: t, sim: sim, sw: sw, h1: h1, h2: h2, h3: h3 };
}

console.log('The command creates the object, and the object is visible:');
{
  const la = lab();
  const svi = la.sw.interfaces.get('Vlan10');
  ok(!!svi, 'interface vlan 10 created Vlan10');
  eq(svi && svi.ip, '10.10.0.1', 'with the address it was given');
  eq(svi && svi.vlan && svi.vlan.accessVlan, 10, 'and it belongs to VLAN 10, which is the rule ownsIpOn() uses');
  const created = answer(la.sw, la.t, la.sim, ['configure terminal', 'interface vlan 20', 'exit', 'exit']);
  ok(/Vlan20 created/.test(created.join('\n')), 'the console says what it created: "' +
    (created[0] || '') + '"');
  const brief = text(la.sw, la.t, la.sim, ['show ip interface brief']);
  ok(/Vlan10\s+10\.10\.0\.1\/24/.test(brief), 'show ip interface brief lists it with its address');
  ok(/Vlan20\s+unassigned/.test(brief),
    'a second SVI with no address is listed as unassigned rather than hidden');
  ok(/Vlan10 \(svi, virtual\), MAC [0-9a-f:]{17}/.test(text(la.sw, la.t, la.sim, ['show interfaces Vlan10'])),
    'show interfaces names its type and MAC');
  // Entering it again must not create a second object or lose the address.
  const again = answer(la.sw, la.t, la.sim, ['configure terminal', 'interface vlan 10', 'exit', 'exit']);
  eq(again.filter(function (l) { return /created/.test(l); }).length, 0, 'entering it again is not a new object');
  eq(la.sw.interfaces.get('Vlan10').ip, '10.10.0.1', 'and does not disturb what is configured on it');
}

console.log('\nIt answers, from every port in its VLAN:');
{
  const la = lab();
  const p1 = text(la.h1, la.t, la.sim, ['ping 10.10.0.1 count 2']);
  ok(/Success rate is 100 percent/.test(p1), 'H1 reaches the switch address (2/2)');
  const p2 = text(la.h2, la.t, la.sim, ['ping 10.10.0.1 count 1']);
  ok(/Success rate is 100 percent/.test(p2), 'so does H2, on a different port of the same VLAN');
  const fromSwitch = text(la.sw, la.t, la.sim, ['ping 10.10.0.10 count 1']);
  ok(/Success rate is 100 percent/.test(fromSwitch), 'and the switch can originate a ping of its own');
  const arp = text(la.sw, la.t, la.sim, ['show arp']);
  ok(/10\.10\.0\.10/.test(arp), 'the switch\'s ARP cache holds the host it reached');
}

console.log('\nOne address, one MAC - whichever port asks:');
{
  const la = lab();
  // H1 and H2 are on separate ports. A reply that borrowed the ingress port's MAC would give the
  // same address two identities, and a host moving between ports would have to re-ARP.
  text(la.h1, la.t, la.sim, ['ping 10.10.0.1 count 1']);
  text(la.h2, la.t, la.sim, ['ping 10.10.0.1 count 1']);
  const m1 = la.h1.arp.get('10.10.0.1');
  const m2 = la.h2.arp.get('10.10.0.1');
  ok(!!m1, 'H1 cached a MAC for the switch address');
  eq(m2, m1, 'H2 cached the same one');
  const sviMac = la.sw.interfaces.get('Vlan10').mac;
  eq(m1, sviMac, 'and it is the SVI\'s MAC, not the ingress port\'s');
  const portMacs = Array.from(la.sw.interfaces.values())
    .filter(function (i) { return !i.svi && i.mac; }).map(function (i) { return i.mac; });
  ok(portMacs.indexOf(m1) === -1, 'which is not any physical port\'s MAC');
}

console.log('\nThe VLAN boundary still holds:');
{
  const la = lab();
  const isolated = text(la.h3, la.t, la.sim, ['ping 10.10.0.1 count 1']);
  ok(/Success rate is 0 percent/.test(isolated),
    'a host in VLAN 20 cannot reach an address in VLAN 10 (1/1/5 is an access port in 20)');
  const other = text(la.h1, la.t, la.sim, ['ping 10.20.0.10 count 1']);
  ok(/Success rate is 0 percent/.test(other), 'nor the other way round');
  // And the switch is not a router: two SVIs do not make it forward between VLANs.
  const two = answer(la.sw, la.t, la.sim, ['configure terminal', 'interface vlan 20',
    'ip address 10.20.0.1 255.255.255.0', 'exit', 'exit']);
  eq(two.filter(function (l) { return /^%/.test(l); }).length, 0, 'a second SVI is accepted');
  const crossed = text(la.h1, la.t, la.sim, ['ping 10.20.0.10 count 1']);
  ok(/Success rate is 0 percent/.test(crossed),
    'and the switch still does not route between them - an SVI is a host address, not a routing one');
}

console.log('\nShutting it takes it out of service, and bringing it back restores it:');
{
  const la = lab();
  const down = answer(la.sw, la.t, la.sim, ['configure terminal', 'interface vlan 10', 'shutdown', 'exit', 'exit']);
  ok(/administratively down/.test(down.join('\n')), 'the console says the SVI went down');
  ok(/Success rate is 0 percent/.test(text(la.h1, la.t, la.sim, ['ping 10.10.0.1 count 1'])),
    'and it no longer answers');
  ok(/Vlan10\s+10\.10\.0\.1\/24\s+\S+\s+\S+\s+administratively down/.test(
    text(la.sw, la.t, la.sim, ['show ip interface brief'])),
    'show ip interface brief reports the state');
  answer(la.sw, la.t, la.sim, ['configure terminal', 'interface vlan 10', 'no shutdown', 'exit', 'exit']);
  ok(/Success rate is 100 percent/.test(text(la.h1, la.t, la.sim, ['ping 10.10.0.1 count 1'])),
    'no shutdown brings it back');
}

console.log('\nA logical port is never an egress:');
{
  const la = lab();
  text(la.h1, la.t, la.sim, ['ping 10.10.0.1 count 1']);
  text(la.h1, la.t, la.sim, ['ping 10.10.0.11 count 1']);
  const egressed = la.sim.events.filter(function (e) {
    return e.type === 'switch' && e.iface === 'Vlan10';
  });
  eq(egressed.length, 0, 'no frame was bridged "out of" Vlan10');
  ok(!/Vlan10/.test(text(la.sw, la.t, la.sim, ['show spanning-tree'])),
    'and spanning tree does not treat it as a bridged port');
  ok(!/Vlan10/.test(text(la.sw, la.t, la.sim, ['show interfaces transceiver'])),
    'nor is it a module bay');
  ok(!/Vlan10/.test(text(la.sw, la.t, la.sim, ['show power inline'])),
    'nor a PoE port');
  // show vlan does list it, because that is where it belongs: it is a member of its own VLAN.
  ok(/Vlan10/.test(text(la.sw, la.t, la.sim, ['show vlan'])), 'show vlan lists it as a member of VLAN 10');
}

console.log('\nThe dump round-trips, and reloading does not need hand edits:');
{
  const la = lab();
  const dump = answer(la.sw, la.t, la.sim, ['show running-config']);
  const joined = dump.join('\n');
  ok(/^interface Vlan10$/m.test(joined), 'the dump names the SVI by its interface name');
  ok(/^\s+ip address 10\.10\.0\.1 255\.255\.255\.0$/m.test(joined), 'with its address');
  ok(!/interface Vlan10[\s\S]{0,80}switchport/.test(joined),
    'and no `switchport` line, because a logical port has no switchport to configure');

  // Paste it into a device that has never heard of this VLAN or this SVI.
  const fresh = la.t.addDevice(spec(SWITCH[0], SWITCH[1]));
  fresh.name = 'SW2';
  const res = runCommands(fresh, la.t, la.sim, ['enable', 'configure terminal'].concat(
    dump.filter(function (l) { return l && !/^!/.test(l); })).concat(['exit']));
  const bad = res.lines.filter(function (l) { return /^%/.test(l); });
  eq(bad.join(' | '), '', 'pasting the dump into a fresh switch produces no refusals');
  const svi2 = fresh.interfaces.get('Vlan10');
  ok(!!svi2, 'the SVI exists on the fresh switch');
  eq(svi2 && svi2.ip, '10.10.0.1', 'with the same address');
  // And the interface name alone is enough - that is what makes the paste work.
  const direct = answer(fresh, la.t, la.sim, ['configure terminal', 'interface Vlan20', 'exit', 'exit']);
  ok(!!fresh.interfaces.get('Vlan20'), '`interface Vlan20` creates the SVI without the `vlan <id>` spelling');
  eq(direct.filter(function (l) { return /^%/.test(l); }).length, 0, 'and it is not a refusal');
}

console.log('\nRefusals name the problem, and a router declines the command:');
{
  const la = lab();
  const out = answer(la.sw, la.t, la.sim, ['configure terminal',
    'interface vlan abc', 'interface vlan', 'interface vlan 0', 'interface vlan 9999', 'interface vlan 4095']);
  const all = out.join('\n');
  ok(/VLAN id must be a number, not "abc"/.test(all), 'a non-number is refused by name');
  ok(/Incomplete command: interface vlan <id>/.test(all), 'a missing id says what is missing');
  ok(/VLAN out of range: 0/.test(all), '0 is out of range');
  ok(/VLAN out of range: 9999/.test(all), '9999 is out of range');
  ok(/VLAN out of range: 4095/.test(all), 'and so is 4095 - the top of the range is 4094');

  const t2 = new Topology();
  const r1 = t2.addDevice(model('generic-router'));
  r1.name = 'R1';
  const sim2 = new Simulator(t2);
  const routerOut = answer(r1, t2, sim2, ['configure terminal', 'interface vlan 10']).join('\n');
  ok(/does not switch - it has no VLANs/.test(routerOut), 'a router refuses the SVI by name');
  ok(/interface Gi0\/0/.test(routerOut), 'and points at the port that *is* a socket');
}

console.log('\nDistinct MACs, and the address is where the tables say it is:');
{
  const la = lab();
  answer(la.sw, la.t, la.sim, ['configure terminal', 'interface vlan 20',
    'ip address 10.20.0.1 255.255.255.0', 'exit', 'exit']);
  const a = la.sw.interfaces.get('Vlan10').mac;
  const b = la.sw.interfaces.get('Vlan20').mac;
  ok(!!a && !!b && a !== b, 'two SVIs get two MACs (' + a + ' / ' + b + ')');
  ok(/^02:/.test(a), 'and they live in the lab\'s own OUI range (' + a + ')');
  const users = Array.from(la.sw.interfaces.values()).filter(function (i) { return i.mac; })
    .map(function (i) { return i.mac; });
  eq(new Set(users).size, users.length, 'no two interfaces on the device share a MAC');
  // The route table: an SVI's address is a connected route, so the switch can originate traffic,
  // but only an L3 device forwards - checked above.
  const routes = text(la.sw, la.t, la.sim, ['show ip route']);
  ok(/10\.10\.0\.0\/24/.test(routes), 'show ip route shows the SVI\'s subnet as connected');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
