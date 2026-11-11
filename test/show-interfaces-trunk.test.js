'use strict';
// show-interfaces-trunk.test.js - the first view an operator opens on a trunk that is not passing.
//
//   SW1#show interfaces trunk
//   % No interface named trunk on SW1
//
// `show interfaces trunk` is the trunk table on every Cisco switch, and this console read "trunk" as
// a port name and refused it as a typo. Every fact the table carries - mode, native VLAN, allowed
// list, which of those VLANs exist, which the spanning tree forwards - was already in the model, so
// the operator had to reassemble it from `show running-config`, `show vlan` and
// `show interfaces <port> switchport`, three views and no cross-check.
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
  const sw = t.addDevice(find('generic-switch')); sw.name = 'SW1';
  const sw2 = t.addDevice(find('generic-switch')); sw2.name = 'SW2';
  const ports = Array.from(sw.interfaces.values()).filter(function (i) { return !i.svi; }).map(function (i) { return i.name; });
  const far = Array.from(sw2.interfaces.values()).filter(function (i) { return !i.svi; })[0].name;
  t.connect(sw.id, ports[1], sw2.id, far);
  const sim = new Simulator(t);
  const s = new CliSession(sw, t, sim); s.run('enable');
  const r = t.addDevice(find('generic-router')); r.name = 'R1';
  const sr = new CliSession(r, t, sim); sr.run('enable');
  s.run('configure terminal', 'vlan 10', 'vlan 20',
    'interface ' + ports[0], 'switchport access vlan 10', 'no shutdown', 'exit',
    'interface ' + ports[1], 'switchport mode trunk', 'switchport trunk allowed vlan 10,20', 'no shutdown', 'exit',
    'interface ' + ports[2], 'switchport mode trunk', 'switchport trunk allowed vlan 99', 'no shutdown', 'exit', 'end');
  return { t: t, sim: sim, sw: sw, s: s, r: r, sr: sr, ports: ports };
}

console.log('The trunk table is the trunk table:');
{
  const env = lab();
  const out = text(env.s.run('show interfaces trunk'));
  ok(!/No interface named trunk/.test(out), 'the command is not read as a port name');
  ok(/Port\s+Mode\s+Encapsulation\s+Status\s+Native vlan/.test(out), 'it prints the IOS header');
  ok(new RegExp(env.ports[1] + '\\s+on\\s+802\\.1q\\s+trunking\\s+1').test(out),
    'the live trunk is on, 802.1q, trunking, native 1');
  ok(/Vlans allowed on trunk/.test(out), 'it lists what is allowed on the trunk');
  ok(new RegExp(env.ports[1] + '\\s+10,20').test(out), 'the allowed list is the one that was configured');
  ok(/Vlans allowed and active in management domain/.test(out), 'and what of that is active');
  ok(/Vlans in spanning tree forwarding state and not pruned/.test(out), 'and what the tree forwards');
}

console.log('\nAn allowed VLAN that does not exist is not active:');
{
  const env = lab();
  const out = text(env.s.run('show interfaces trunk'));
  const rows = out.split('\n').filter(function (l) { return l.indexOf(env.ports[2]) !== -1; });
  ok(rows.length >= 3, 'the second trunk appears in every section (got ' + rows.length + ')');
  ok(rows.some(function (l) { return /99/.test(l); }), 'its allowed list names 99');
  ok(rows.filter(function (l) { return /none/.test(l); }).length >= 1,
    'but 99 is not active, because no VLAN 99 exists');
  ok(/carries no VLAN the spanning tree forwards|carry no VLAN the spanning tree forwards/.test(out),
    'and the table says that in words');
  ok(/not-trunking/.test(out), 'a trunk with no link is marked not-trunking');
  ok(/configured as a trunk but has no link/.test(out), 'and the reason is spelled out');
}

console.log('\nOne port narrows it, a bad port is refused, and a router says it does not switch:');
{
  const env = lab();
  const one = text(env.s.run('show interfaces trunk ' + env.ports[1]));
  ok(one.indexOf(env.ports[2]) === -1, 'naming a port leaves the other trunks out');
  ok(one.indexOf(env.ports[1]) !== -1, 'and keeps the one asked about');
  const missing = text(env.s.run('show interfaces trunk zzzz'));
  ok(/No interface named zzzz/.test(missing), 'a port that does not exist is refused by name');
  ok(/show ip interface brief/.test(missing), 'and the refusal points at the view that lists the ports');
  const notTrunk = text(env.s.run('show interfaces trunk ' + env.ports[0]));
  ok(/is not a trunk port/.test(notTrunk), 'an access port is named as not being a trunk');
  const router = text(env.sr.run('show interfaces trunk'));
  ok(/does not switch/.test(router), 'a router says it has no trunks at all');
  ok(/subinterface/.test(router), 'and points at the thing that carries a tag on a routed port');
}

console.log('\nThe table agrees with the other views:');
{
  const env = lab();
  const trunk = text(env.s.run('show interfaces trunk'));
  const run = text(env.s.run('show running-config'));
  ok(/switchport trunk allowed vlan 10,20/.test(run), 'the running-config carries the allowed list');
  ok(new RegExp(env.ports[1] + '\\s+10,20').test(trunk), 'and the trunk table shows the same list');
  const vlan = text(env.s.run('show vlan'));
  ok(/^10\s/m.test(vlan), 'VLAN 10 exists in the VLAN table');
  ok(/active in management domain[\s\S]*10,20/.test(trunk), 'and the active list agrees it is there');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
