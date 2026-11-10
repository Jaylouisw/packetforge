'use strict';
// port-names.test.js - a port has the name IOS gives it.
//
//   R1#show interfaces GigabitEthernet0/0
//   % No interface named GigabitEthernet0/0 on R1
//   R1(config)#interface GigabitEthernet 0/0
//   % Interface not found: GigabitEthernet
//
// The panel label is the short spelling (`Gi0/0`), and only that spelling resolved. Every spelling IOS
// accepts - the type in full, any prefix of it from two letters, and the type word separated from its
// index by a space - names the same port now, and the model keeps printing the one spelling it stores.
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
  const pc = t.addDevice(find('generic-pc')); pc.name = 'PC1';
  const ports = Array.from(sw.interfaces.values()).filter(function (i) { return !i.svi; }).map(function (i) { return i.name; });
  t.connect(r.id, 'Gi0/0', sw.id, ports[0]);
  t.connect(sw.id, ports[1], pc.id, Array.from(pc.interfaces.values())[0].name);
  const sim = new Simulator(t);
  const sr = new CliSession(r, t, sim); sr.run('enable');
  const ss = new CliSession(sw, t, sim); ss.run('enable');
  const sp = new CliSession(pc, t, sim); sp.run('enable');
  return { t: t, sim: sim, r: r, sw: sw, pc: pc, sr: sr, ss: ss, sp: sp, swp: ports };
}

console.log('Every spelling IOS accepts names the one port:');
{
  const env = lab();
  for (const typed of ['GigabitEthernet0/0', 'Gig0/0', 'Giga0/0', 'GigabitEthernet 0/0', 'gi0/0', 'GI0/0']) {
    const body = text(env.sr.run('show interfaces ' + typed));
    ok(/^Gi0\/0 /.test(body) || /Gi0\/0 \(/.test(body), 'show interfaces ' + typed + ' finds Gi0/0');
    ok(!/No interface named/.test(body), 'and does not refuse it');
  }
  ok(/^Gi0\/0 /.test(text(env.sr.run('show interfaces GigabitEthernet0/0'))),
    'the answer prints the spelling the model stores, not the one typed');
}

console.log('\nThe config path takes them too, and keeps one spelling:');
{
  const env = lab();
  env.sr.run('configure terminal');
  const out = text(env.sr.run('interface GigabitEthernet 0/0'));
  ok(!/not found/i.test(out), 'interface GigabitEthernet 0/0 enters the block');
  ok(/\(config-if\)#/.test(env.sr.prompt()), 'the prompt says it is an interface block');
  ok(/Gi0\/0/.test(text(env.sr.run('ip address 10.0.0.1 255.255.255.0'))),
    'the address lands on Gi0/0, named as the model names it');
  env.sr.run('exit');
  const dump = text(env.sr.run('show running-config'));
  ok(/^interface Gi0\/0$/m.test(dump), 'and the running-config carries the short spelling');
  ok(!/GigabitEthernet/.test(dump), 'the long spelling never reaches the configuration');
}

console.log('\nA subinterface is reachable through its parent\'s long name:');
{
  const env = lab();
  env.sr.run('configure terminal');
  const made = text(env.sr.run('interface GigabitEthernet0/0.20'));
  ok(/Gi0\/0\.20/.test(made), 'interface GigabitEthernet0/0.20 creates Gi0/0.20');
  env.sr.run('end');
  ok(/Gi0\/0\.20/.test(text(env.sr.run('show interfaces GigabitEthernet0/0.20'))),
    'and the long spelling finds it again');
  ok(/Gi0\/0\.20/.test(text(env.sr.run('show interfaces GigabitEthernet 0/0.20'))),
    'the spaced spelling does too');
}

console.log('\nThe switch and the host use their own type names:');
{
  const env = lab();
  const fa = env.swp[1].replace(/[A-Za-z]+/, '');
  env.ss.run('configure terminal');
  ok(!/not found/i.test(text(env.ss.run('interface FastEthernet ' + fa))),
    'interface FastEthernet ' + fa + ' enters the block');
  ok(/\(config-if\)#/.test(env.ss.prompt()), 'and the switch is in an interface block');
  env.ss.run('switchport mode access');
  env.ss.run('exit');
  ok(new RegExp('Fa' + fa).test(text(env.ss.run('show interfaces FastEthernet' + fa))),
    'show interfaces FastEthernet' + fa + ' finds it');
  env.sp.run('configure terminal');
  ok(!/not found/i.test(text(env.sp.run('interface Ethernet0'))),
    'a host port called eth0 answers to Ethernet0');
  env.sp.run('exit');
  ok(/eth0/.test(text(env.sp.run('show interfaces Ethernet0'))), 'and is still shown as eth0');
}

console.log('\nA name that fits no port is refused, and the refusal lists the ports:');
{
  const env = lab();
  const body = text(env.sr.run('show interfaces GigabitEthernet99/99'));
  ok(/No interface named/.test(body), 'a port that does not exist is refused');
  ok(/show ip interface brief/.test(body), 'and the answer says where the ports are');
  env.sr.run('configure terminal');
  ok(/not found/i.test(text(env.sr.run('interface GigabitEthernet99/99'))),
    'the config side refuses it too');
}

console.log('\nThe keyword `vlan` is not an interface name:');
{
  // Joining a type word to its index is right for ports and wrong for keywords, and `vlan <id>` is
  // both: the first cut turned `spanning-tree vlan 10 priority 4096` into `spanning-tree vlan10 …`
  // and `switchport access vlan 10` into a name nobody could resolve.
  const env = lab();
  env.ss.run('configure terminal');
  ok(!/^\s*%/m.test(text(env.ss.run('vlan 10'))), 'vlan 10 still creates a VLAN');
  ok(!/^\s*%/m.test(text(env.ss.run('spanning-tree vlan 10 priority 4096'))),
    'spanning-tree vlan 10 priority 4096 still names the VLAN');
  env.ss.run('interface Fa0/3');
  ok(!/^\s*%/m.test(text(env.ss.run('switchport access vlan 10'))),
    'switchport access vlan 10 still sets the access VLAN');
  env.ss.run('exit');
  env.ss.run('interface Vlan10');
  ok(/\(config-if\)#/.test(env.ss.prompt()), 'interface Vlan10 enters the SVI block');
  env.ss.run('exit');
  env.ss.run('interface vlan 10');
  ok(/\(config-if\)#/.test(env.ss.prompt()), 'and so does the two-token spelling interface vlan 10');
  env.ss.run('end');
}

console.log('\nEvery port in the catalogue answers to its own long name:');
{
  const { resolvePortName } = require('../engine/cli');
  const bad = [];
  let checked = 0;
  for (const model of catalog) {
    const t = new Topology();
    const d = t.addDevice(model); d.name = 'D';
    for (const name of d.interfaces.keys()) {
      const m = /^([A-Za-z][A-Za-z-]*?)(\d[\d/]*)$/.exec(name);
      if (!m) continue;
      const long = { gi: 'GigabitEthernet', fa: 'FastEthernet', eth: 'Ethernet', e: 'Ethernet',
        te: 'TenGigabitEthernet', twe: 'TwentyFiveGigE', tw: 'TwoGigabitEthernet',
        fi: 'FiveGigabitEthernet', fo: 'FortyGigabitEthernet', hu: 'HundredGigE',
        po: 'Port-channel', vl: 'Vlan', vlan: 'Vlan', lo: 'Loopback', tu: 'Tunnel' }[m[1].toLowerCase()];
      if (!long) continue;
      checked += 1;
      const got = resolvePortName(d, long + m[2]);
      if (got !== name) bad.push(model.model + ' ' + name + ' -> ' + (long + m[2]) + ' gave ' + got);
    }
  }
  ok(bad.length === 0, 'every long spelling resolves' + (bad.length ? ': ' + bad.slice(0, 4).join('; ') : ''));
  ok(checked > 100, 'the sweep ran (' + checked + ' ports across the catalogue)');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
