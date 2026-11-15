'use strict';
// value-hints.test.js - a `?` under a value slot names the values the device has.
//
// The page offered the slot's name and nothing else:
//
//   R1#show logging device ?
//     Next: <name>
//   Names in angle brackets are values: type one, then ask ? again for what follows it.
//
// while the lab held R1, SW1 and PC1 - the answer to `?` is the list, and a console with a view of the
// topology can look it up. The same silence covered VLAN ids (`show spanning-tree vlan ?`, `no vlan ?`,
// `show vlan ?` on a switch carrying 1, 10, 30, 44), ports, DHCP pool names and ACL names.
//
// The rules:
//   1. A value slot whose values this device holds lists them, named by what they are.
//   2. One place decides what kind of value a slot takes, so the attached form (`show vlan 3?`) and the
//      detached form (`show vlan ?`) agree - they are the same question asked two ways. The word
//      before the slot settles the kind: `interface vlan <id>` is answered with the SVIs the device
//      has, every other `… vlan <id>` with the VLAN ids it carries.
//   3. A slot whose values the device does not hold lists nothing - an invented value is worse than
//      the slot's name.
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

console.log('A lab with three devices, a pool, an ACL and three VLANs:');
const t = new Topology();
const r1 = t.addDevice(find('generic-router')); r1.name = 'R1';
const sw1 = t.addDevice(find('generic-switch')); sw1.name = 'SW1';
const pc1 = t.addDevice(find('generic-pc')); pc1.name = 'PC1';
t.connect(r1.id, 'Gi0/0', sw1.id, 'Fa0/1');
t.connect(sw1.id, 'Fa0/2', pc1.id, 'eth0');
const sim = new Simulator(t);
const rs = new CliSession(r1, t, sim); rs.run('enable');
const ss = new CliSession(sw1, t, sim); ss.run('enable');

// A router with a pool and an ACL, a switch with three VLANs and a port in one.
rs.run('configure terminal');
rs.run('ip dhcp pool OFFICE'); rs.run('network 10.5.0.0 255.255.255.0'); rs.run('exit');
rs.run('access-list 10 permit any');
rs.run('end');
ss.run('configure terminal');
for (const v of [10, 30, 44]) ss.run('vlan ' + v);
ss.run('interface Fa0/2'); ss.run('switchport access vlan 10');
ss.run('end');

console.log('\nThe slot that started this: `show logging device ?` names the lab:');
{
  const out = text(rs.run('show logging device ?'));
  ok(/Next: <name>/.test(out), 'the slot is still named');
  ok(/Devices in this lab: .*PC1.*R1.*SW1/.test(out), 'and the devices are listed (PC1, R1, SW1)');
  // It must be the lab's names, not the devices' internal ids.
  ok(!/dev-[0-9a-f]{4,}/.test(out), 'with the names an operator types, not internal ids');
  // A device that was renamed is listed under the new name.
  pc1.name = 'PRINTER1';
  ok(/PRINTER1/.test(text(rs.run('show logging device ?'))), 'and a renamed device appears under its new name');
  pc1.name = 'PC1';
  // The value completes, which is the point of listing it.
  const done = text(rs.run('show logging device SW?'));
  ok(/SW1/.test(done), 'and `show logging device SW?` completes to it');
}

console.log('\nPorts, pools and access lists:');
{
  ok(/Ports on this device: Gi0\/0, Gi0\/1, Gi0\/2/.test(text(rs.run('show interfaces counters ?'))),
    'a port slot lists the ports');
  // `show ip dhcp pool` takes no argument - the pools are the view's rows - so the pool names belong
  // to the `no ip dhcp pool <name>` slot, and there the list appears.
  rs.run('configure terminal');
  const poolQ = text(rs.run('no ip dhcp pool ?'));
  rs.run('end');
  ok(/DHCP pools on this device: OFFICE/.test(poolQ), 'a pool slot lists the pools');
  const acl = text(rs.run('show ip access-lists ?'));
  ok(/Access lists on this device: 10/.test(acl), 'an access-list slot lists the lists');
  // The slot's own name is still there - the list is added to the answer, not instead of it.
  ok(/Next: <name>/.test(acl), 'and the slot keeps its name in the Next line');
}

console.log('\nVLAN ids, and the two kinds of `vlan <id>`:');
{
  const stp = text(ss.run('show spanning-tree vlan ?'));
  ok(/VLANs on this device: 1, 10, 30, 44/.test(stp), 'show spanning-tree vlan ? lists the VLAN ids');
  ss.run('configure terminal');
  const no = text(ss.run('no vlan ?'));
  ok(/VLANs on this device: 1, 10, 30, 44/.test(no), 'no vlan ? lists them too - removal is where it matters');
  ss.run('end');
  const show = text(ss.run('show vlan ?'));
  ok(/VLANs on this device: 1, 10, 30, 44/.test(show), 'and so does show vlan ?');
  // The attached form must agree with the detached one.
  const attached = text(ss.run('show vlan 3?'));
  ok(/30/.test(attached), 'show vlan 3? completes to 30');
  ok(/from this device/.test(attached), 'and says the value came from the device');
  // `interface vlan <id>` is the other kind: an SVI exists or it does not.
  ss.run('configure terminal'); ss.run('interface vlan 30');
  ss.run('ip address 10.30.0.254 255.255.255.0'); ss.run('exit');
  const svi = text(ss.run('interface vlan ?'));
  ok(/SVIs on this device: 30/.test(svi), 'interface vlan ? lists the SVIs, not the VLANs');
  ok(!/SVIs on this device: 1\b/.test(svi), 'and does not offer a VLAN that has no SVI');
}

console.log('\nA slot with no values on this device lists none:');
{
  const pc = new CliSession(pc1, t, sim); pc.run('enable');
  const out = text(pc.run('show ip dhcp pool ?'));
  ok(!/DHCP pools on this device:/.test(out), 'a PC holds no pools, so no pool list is printed');
  ok(/Next: <name>|nothing follows|No completions/.test(out), 'and the answer is still the honest one');
  const pools = text(pc.run('show vlan ?'));
  ok(!/VLANs on this device:/.test(pools) || /VLANs on this device: 1\b/.test(pools),
    'and no VLAN list where the device carries none beyond its default');
}

console.log('\nThe page shows the form the parser takes:');
{
  // `show vlan id <id>` worked and `?` called it a typo.
  const page = text(ss.run('show vlan ?'));
  ok(/^  id\s/m.test(page), 'show vlan id is on the page, as its own row');
  ok(text(ss.run('show vlan id 10')) === text(ss.run('show vlan 10')),
    'and answers exactly what show vlan 10 answers');
  const bad = text(ss.run('show vlan id aa'));
  ok(/is not a VLAN id/.test(bad), 'a word that is not a number is refused as the word it is');
  ok(!/Incomplete command/.test(bad), 'not as an incomplete command');
  ok(/Usage: show vlan id <id>/.test(bad), 'and the usage names the value');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
