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

console.log('\nA VLAN named is a name, and a VLAN numbered is an id:');
{
  // `show vlan name <name>` takes a VLAN name. `name` was read as a port slot, so the console
  // offered the switch's *ports* as VLAN names - a value list for a different question.
  ss.run('configure terminal');
  ss.run('vlan 30 name sales');
  ss.run('exit');
  const names = text(ss.run('show vlan name ?'));
  ok(/VLAN names on this device: .*sales/.test(names), 'show vlan name ? lists the VLAN names');
  ok(!/Ports on this device/.test(names), 'and not the ports');
  ok(/sales/.test(text(ss.run('show vlan name sal?'))), 'and a name completes from this device');
  // A router has no VLAN 1 - it does not bridge - so the id list must not invent one.
  rs.run('configure terminal'); rs.run('vlan 50 name core'); rs.run('end');
  const rq = text(rs.run('show vlan ?'));
  ok(!/VLANs on this device: 1\b/.test(rq), 'a router is not offered VLAN 1');
  ok(/VLANs on this device: 50/.test(rq), 'but is offered the VLAN it declared');
}

console.log('\nA module bay is not a data port:');
{
  // `show interfaces transceiver <port>` listed the device's ports, and the console refused every
  // one with "No transceiver port named eth0 on D1 (module bays: sfp1, sfp2)" - so the hint offered
  // a value the command does not take, in the one slot where the console already knew the answer.
  // A device with a module bay: cages come from the hardware record, so the test looks for one the
  // same way the console does rather than guessing from the catalogue's media strings.
  let withBay = null;
  let bayProbe = null;
  for (const cand of catalog) {
    const tt = new Topology();
    const dd = tt.addDevice(cand);
    let has = false;
    for (const i of dd.interfaces.values()) { if (bayProbe && bayProbe._isModuleBay(i)) { has = true; break; } }
    if (!bayProbe) {
      bayProbe = new CliSession(dd, tt, new Simulator(tt));
      for (const i of dd.interfaces.values()) { if (bayProbe._isModuleBay(i)) { has = true; break; } }
    }
    if (has) { withBay = cand; break; }
  }
  ok(!!withBay, 'the catalogue has a device with a module bay (' + (withBay && withBay.model) + ')');
  const t2 = new Topology();
  const d2 = t2.addDevice(withBay); d2.name = 'D2';
  const s2 = new CliSession(d2, t2, new Simulator(t2)); s2.run('enable');
  const hint = text(s2.run('show interfaces transceiver ?'));
  const listed = /Module bays on this device: ([^\n]+)/.exec(hint);
  ok(!!listed, 'a transceiver slot lists module bays, not ports');
  if (listed) {
    const firstBay = listed[1].split(',')[0].trim().replace(/ \.\.\..*$/, '');
    ok(!/No transceiver port named/.test(text(s2.run('show interfaces transceiver ' + firstBay))),
      'and the first bay it offers is accepted (' + firstBay + ')');
  }
  // The ports of that device are not offered as bays.
  const baysOnly = listed ? listed[1] : '';
  ok(!/eth0|Gi0\/0/.test(baysOnly), 'a data port is not offered as a bay');
}

console.log('\nThe sweep behind all of this: a hinted value is a value the command takes:');
{
  // One device from each catalogue category. Wherever a value slot can be answered from the device,
  // the first value it offers is typed back, and the answer must not be that the value is the wrong
  // kind of thing. A hint that leads to "No VLAN named eth0" is worse than no hint at all.
  const KINDY = /No VLAN |is not a VLAN|No VLAN named|No interface named|No transceiver port named|is not a port|No such port|is not an interface/;
  const byKind = {};
  for (const cat of catalog) {
    const kind = cat.category || 'other';
    if (!byKind[kind]) byKind[kind] = cat;
  }
  let typed = 0;
  const wrong = [];
  for (const kind of Object.keys(byKind)) {
    const t3 = new Topology();
    const d3 = t3.addDevice(byKind[kind]); d3.name = 'D1';
    const pc3 = t3.addDevice(find('generic-pc')); pc3.name = 'PC9';
    try {
      t3.connect(d3.id, d3.interfaces.keys().next().value, pc3.id, pc3.interfaces.keys().next().value);
    } catch (e) { /* incompatible media: the device stands alone */ }
    const s3 = new CliSession(d3, t3, new Simulator(t3)); s3.run('enable');
    s3.run('configure terminal');
    s3.run('vlan 10'); s3.run('vlan 30 name sales');
    s3.run('interface vlan 10'); s3.run('ip address 10.10.0.254 255.255.255.0'); s3.run('exit');
    s3.run('ip dhcp pool P1'); s3.run('network 10.10.0.0 255.255.255.0'); s3.run('exit');
    s3.run('access-list 10 permit any');
    s3.run('end');
    for (const mode of [2, 3, 4]) {
      let rows = [];
      try { rows = s3._helpFormRows(mode); } catch (e) { continue; }
      for (const row of rows) {
        let at = -1;
        for (let i = 0; i < row.tokens.length; i++) {
          const tk = row.tokens[i];
          if (tk && typeof tk === 'object' && s3._valueKind([row], i)) { at = i; break; }
        }
        if (at < 0) continue;
        const vals = s3._valuesFor(s3._valueKind([row], at), '');
        if (!vals.length) continue;
        const cmd = row.tokens.map(function (x, i) {
          return i === at ? vals[0] : (typeof x === 'object' ? 'X' : String(x));
        }).join(' ').replace(/[\[\]]/g, '');
        typed++;
        const firstLine = String(text(s3.run(cmd))).split('\n')[0];
        if (/^%/.test(firstLine) && firstLine.indexOf(String(vals[0])) !== -1 && KINDY.test(firstLine)) {
          wrong.push(kind + ': ' + cmd);
        }
      }
    }
  }
  ok(typed > 1000, 'the sweep typed every hinted value it could (' + typed + ')');
  ok(wrong.length === 0, 'and none was the wrong kind of value'
    + (wrong.length ? ' - ' + wrong.slice(0, 4).join(' | ') : ''));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
