'use strict';
// svi-lifecycle.test.js - a switch's own address on a VLAN: created, used, and removed.
//
// `interface vlan 20` + `ip address` works, addresses the switch, installs a connected route, and
// answers a ping from that address. Removing it did not work, in either spelling:
//
//   SW1(config)#no interface vlan 20
//   % Interface not found: vlan          <- the two-token spelling read "vlan" as a port name
//
//   SW1(config)#no interface Vlan20
//   % Vlan20 is a physical interface and cannot be removed   <- not true of anything
//
// So an SVI could be created and never removed, and the refusal named the wrong object. The suite
// pins the whole lifecycle, including the two things that are NOT the same object: the interface (its
// address) and the VLAN (a bridge domain other ports may still carry).
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
function absent(re, haystack, msg) {
  const text = (haystack && haystack.output) ? haystack.output.join('\n') : String(haystack);
  ok(!re.test(text), msg + (re.test(text) ? ' (unexpectedly matched ' + JSON.stringify(text.slice(0, 300)) + ')' : ''));
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function model(m) { return catalog.filter(function (x) { return x.model === m; })[0]; }

function lab() {
  const t = new Topology();
  const sw = t.addDevice(model('generic-switch')); sw.name = 'SW1';
  const pc = t.addDevice(model('generic-pc')); pc.name = 'PC1';
  const ports = Array.from(sw.interfaces.values());
  t.connect(pc.id, 'eth0', sw.id, ports[0].name);
  const sim = new Simulator(t);
  const s = new CliSession(sw, t, sim); s.run('enable');
  const p = new CliSession(pc, t, sim); p.run('enable');
  return { t: t, sw: sw, pc: pc, s: s, p: p, port: ports[0].name };
}

// A switch with its own address in VLAN 20, and a port in that VLAN so the line protocol comes up.
function sviLab() {
  const env = lab();
  env.s.run('configure terminal');
  ['vlan 20', 'interface ' + env.port, 'switchport mode access', 'switchport access vlan 20',
    'exit', 'interface vlan 20', 'ip address 10.0.20.1 255.255.255.0', 'exit', 'end'].forEach(function (l) { env.s.run(l); });
  env.p.run('configure terminal'); env.p.run('interface eth0');
  env.p.run('ip address 10.0.20.2 255.255.255.0'); env.p.run('end');
  return env;
}

console.log('\nAn SVI is an interface: address, connected route, and a ping from it:');
{
  const env = sviLab();
  const brief = env.s.run('show ip interface brief').output.join('\n');
  ok(/Vlan20\s+10\.0\.20\.1\/24\s+YES\s+manual\s+up\s+up/.test(brief),
    'the brief lists Vlan20 as up/up with its address');
  const route = env.s.run('show ip route').output.join('\n');
  ok(/C\s+10\.0\.20\.0\/24\s+0\s+-\s+Vlan20/.test(route),
    'the routing table has the connected route on Vlan20');
  const ping = env.s.run('ping 10.0.20.2');
  saw(/Success rate is (75|100) percent/, ping, 'the switch answers its own VLAN');
  // The dump carries it, so a paste rebuilds the same device.
  const dump = env.s.run('show running-config').output.join('\n');
  ok(/interface Vlan20/.test(dump) && /ip address 10\.0\.20\.1 255\.255\.255\.0/.test(dump),
    'the running-config dumps the interface and its address');
}

console.log('\nWithout a port carrying the VLAN, the SVI is honestly down:');
{
  const env = lab();
  env.s.run('configure terminal');
  ['vlan 20', 'interface vlan 20', 'ip address 10.0.20.1 255.255.255.0', 'exit', 'end']
    .forEach(function (l) { env.s.run(l); });
  const brief = env.s.run('show ip interface brief').output.join('\n');
  ok(/Vlan20\s+10\.0\.20\.1\/24\s+YES\s+manual\s+up\s+down/.test(brief),
    'no member port means line protocol down');
  absent(/10\.0\.20\.0\/24/, env.s.run('show ip route').output.join('\n'),
    'and no connected route - the table and the line protocol agree');
}

console.log('\nIt can be removed, both ways it can be typed:');
{
  for (const spelled of ['no interface vlan 20', 'no interface Vlan20']) {
    const env = sviLab();
    const out = env.s.run('configure terminal');
    const removed = env.s.run(spelled);
    saw(/Interface Vlan20 removed/, removed, '"' + spelled + '" removes the SVI');
    saw(/10\.0\.20\.1/, removed, 'and says the address went with it');
    saw(/VLAN 20 stays/, removed, 'while the VLAN is a separate object and stays');
    const brief = env.s.run('show ip interface brief').output.join('\n');
    absent(/Vlan20/, brief, 'the interface is gone from the brief');
    absent(/10\.0\.20\.0\/24/, env.s.run('show ip route').output.join('\n'),
      'and its connected route is gone from the table');
    const vlans = env.s.run('show vlan').output.join('\n');
    saw(/\b20\b/, vlans, 'the VLAN is still there');
    saw(new RegExp(env.port.replace('/', '\\/')), vlans, 'with its member port');
  }
}

console.log('\nA removal that cannot work says why, accurately:');
{
  const env = sviLab();
  env.s.run('configure terminal');
  saw(/No interface Vlan99/, env.s.run('no interface vlan 99'),
    'an SVI that was never made is named as missing, not as an unknown word');
  const phys = env.s.run('no interface ' + env.port);
  saw(/is a physical interface and cannot be removed/, phys,
    'a physical port is still refused');
  saw(/hardware/, phys, 'with the reason');
  // And the SVI that IS there is not described as physical.
  const going = env.s.run('no interface vlan 20');
  absent(/physical interface/, going, 'an SVI is never called a physical interface');
}

console.log('\nAn empty VLAN left behind says so, and names the command that removes it:');
{
  const env = lab();
  env.s.run('configure terminal');
  ['vlan 20', 'interface vlan 20', 'ip address 10.0.20.1 255.255.255.0', 'exit', 'end']
    .forEach(function (l) { env.s.run(l); });
  env.s.run('configure terminal');
  const out = env.s.run('no interface vlan 20');
  saw(/VLAN 20 stays, empty/, out, 'with no member port the VLAN is described as empty');
  saw(/no vlan 20/, out, 'and the command that removes it is named');
}

console.log('\nThe VLAN table names the SVI as an SVI, not as a port:');
{
  const env = sviLab();
  const table = env.s.run('show vlan').output.join('\n');
  ok(/Vlan20 \(SVI\)/.test(table), 'the Ports column marks it "(SVI)"');
  ok(new RegExp(env.port.replace('/', '\\/')).test(table), 'and the real port is listed beside it');
}

console.log('\nRemoving a VLAN names the dependency that actually blocks it:');
{
  const env = sviLab();
  env.s.run('configure terminal');
  // A port is in VLAN 20 as well, so both dependencies exist and both are named.
  const both = env.s.run('no vlan 20');
  saw(/carried by/.test(both.output.join('\n')) ? new RegExp(env.port.replace('/', '\\/')) : /$^/, both,
    'the port that carries it is named');
  saw(/no interface vlan 20/, both, 'and so is the SVI, with the command that removes it');

  // Now only the SVI is left: the port moves out, and the port advice must stop.
  env.s.run('interface ' + env.port);
  env.s.run('switchport access vlan 1');
  env.s.run('exit');
  const sviOnly = env.s.run('no vlan 20');
  saw(/is this device's own address: Vlan20/, sviOnly, 'an SVI-only VLAN says exactly that');
  absent(/switchport access vlan/, sviOnly,
    'and does NOT tell the operator to move an SVI with a switchport command');

  // The instruction it does give works, and then the VLAN can go.
  const gone = env.s.run('no interface vlan 20');
  saw(/Interface Vlan20 removed/, gone, 'the SVI is removed by the command it named');
  const vlan = env.s.run('no vlan 20');
  saw(/VLAN 20 removed/, vlan, 'and then the VLAN itself comes out');
  absent(/Vlan20/, env.s.run('show vlan').output.join('\n'), 'the VLAN is gone from the table');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
