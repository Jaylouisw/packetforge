'use strict';
// removal-granularity.test.js - a removal that names one thing removes that thing.
//
//   R1(config-if)#vrrp 1 ip 10.0.0.1
//   R1(config-if)#no vrrp 1 ip 10.0.0.99
//   VRRP group 1 removed from Gi0/0          <- the group was working, the address was not its
//
// Two failures of the same rule, found by attacking every removal that names a value: a command that
// ignores the value it was given (and so deletes more than it said), and a command that accepts no
// value at all (and so can only delete everything). Both leave an operator with a lab that no longer
// matches what they believe they configured.
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
  const sim = new Simulator(t);
  const R = new CliSession(r, t, sim); R.run('enable');
  R.run('configure terminal', 'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0',
    'vrrp 1 ip 10.0.0.1', 'vrrp 1 ip 10.0.0.2', 'exit', 'end');
  return { t: t, sim: sim, r: r, R: R };
}
const groups = function (env) { return (env.r.config.vrrp || []); };

console.log('A VRRP removal checks the address it names:');
{
  const env = lab();
  ok(groups(env).length === 1 && groups(env)[0].ips.length === 2, 'the group owns two virtual addresses');
  const out = text(env.R.run('configure terminal', 'interface Gi0/0', 'no vrrp 1 ip 10.0.0.99', 'exit'));
  ok(/does not own 10\.0\.0\.99/.test(out), 'an address it does not own is refused by name');
  ok(/It owns: 10\.0\.0\.1, 10\.0\.0\.2/.test(out), 'and the ones it does own are listed');
  ok(groups(env).length === 1 && groups(env)[0].ips.length === 2, 'the group is untouched (was deleted)');
}

console.log('\nOne address can be removed without the group:');
{
  const env = lab();
  const out = text(env.R.run('configure terminal', 'interface Gi0/0', 'no vrrp 1 ip 10.0.0.2', 'exit'));
  ok(/no longer owns 10\.0\.0\.2/.test(out), 'the named address is dropped');
  ok(groups(env).length === 1, 'the group remains');
  ok(JSON.stringify(groups(env)[0].ips) === JSON.stringify(['10.0.0.1']), 'the other address is unaffected');
}

console.log('\nThe bare form removes the group, and says what went with it:');
{
  const env = lab();
  const out = text(env.R.run('configure terminal', 'interface Gi0/0', 'no vrrp 1', 'exit'));
  ok(/VRRP group 1 removed from Gi0\/0 \(it owned 10\.0\.0\.1, 10\.0\.0\.2\)/.test(out),
    'the removal reports the virtual addresses it took');
  ok(groups(env).length === 0, 'and the group is gone');
}

console.log('\nPriority and preempt go back to their defaults, not to nothing:');
{
  const env = lab();
  env.R.run('configure terminal', 'interface Gi0/0', 'vrrp 1 priority 150', 'no vrrp 1 preempt', 'exit', 'end');
  ok(groups(env)[0].priority === 150, 'the priority is set');
  const p = text(env.R.run('configure terminal', 'interface Gi0/0', 'no vrrp 1 priority', 'exit'));
  ok(/priority back to the default 100 \(was 150\)/.test(p), 'and the removal says the default it returns to');
  ok(groups(env)[0].priority === 100, 'the value is the default');
  const pre = text(env.R.run('configure terminal', 'interface Gi0/0', 'no vrrp 1 preempt', 'exit'));
  ok(/preempt back to the default \(on\)/.test(pre), 'preempt returns to on');
  ok(groups(env)[0].preempt === true, 'and the group says so');
}

console.log('\nA word the removal does not take is refused with the forms it has:');
{
  const env = lab();
  const out = text(env.R.run('configure terminal', 'interface Gi0/0', 'no vrrp 1 bogus', 'exit'));
  ok(/Unexpected argument "bogus" for no vrrp 1/.test(out), 'the word is refused by name');
  ok(/no vrrp <vrid> \[ip \[<address>\] \| priority \| preempt\]/.test(out), 'the usage lists the real forms');
}

console.log('\nAn excluded range can be removed on its own:');
{
  const env = lab();
  env.R.run('configure terminal', 'ip dhcp pool LAN', 'network 10.9.0.0 255.255.255.0',
    'excluded-address 10.9.0.1 10.9.0.5', 'excluded-address 10.9.0.30', 'exit', 'end');
  const pool = function () { return (env.r.config.dhcpPools || [])[0]; };
  ok(pool().excluded.length === 2, 'two exclusions are configured');
  const out = text(env.R.run('configure terminal', 'ip dhcp pool LAN', 'no excluded-address 10.9.0.30', 'exit', 'end'));
  ok(/Excluded address 10\.9\.0\.30 removed/.test(out), 'the named one is removed');
  ok(JSON.stringify(pool().excluded) === JSON.stringify(['10.9.0.1-10.9.0.5']),
    'and the range is still reserved (the whole list used to be cleared)');
}

console.log('\nA range is removed by naming either end, and the bare form empties the list:');
{
  const env = lab();
  env.R.run('configure terminal', 'ip dhcp pool LAN', 'network 10.9.0.0 255.255.255.0',
    'excluded-address 10.9.0.1 10.9.0.5', 'exit', 'end');
  const out = text(env.R.run('configure terminal', 'ip dhcp pool LAN', 'no excluded-address 10.9.0.5 10.9.0.1',
    'exit', 'end'));
  ok(/Excluded address 10\.9\.0\.1-10\.9\.0\.5 removed/.test(out), 'the range is removed whichever end is named');
  ok(((env.r.config.dhcpPools || [])[0].excluded || []).length === 0, 'and the list is empty');
}

console.log('\nAn exclusion that is not there is refused by name:');
{
  const env = lab();
  env.R.run('configure terminal', 'ip dhcp pool LAN', 'network 10.9.0.0 255.255.255.0',
    'excluded-address 10.9.0.30', 'exit', 'end');
  const out = text(env.R.run('configure terminal', 'ip dhcp pool LAN', 'no excluded-address 10.9.0.40', 'exit', 'end'));
  ok(/Not an exclusion here: 10\.9\.0\.40/.test(out), 'the missing address is named');
  ok(/Excluded: 10\.9\.0\.30/.test(out), 'and what is excluded is listed');
  ok(JSON.stringify((env.r.config.dhcpPools || [])[0].excluded) === JSON.stringify(['10.9.0.30']),
    'nothing was removed');
}

console.log('\nAn ip ospf refusal lists the forms the device takes:');
{
  const env = lab();
  // OSPF has to be on for the interface family to be answered at all; with it off the refusal is
  // about the capability, which is a different (and correct) sentence.
  env.R.run('configure terminal', 'ospf router-id 1.1.1.1', 'exit', 'end');
  const out = text(env.R.run('configure terminal', 'interface Gi0/0', 'ip ospf bogus', 'exit'));
  ok(/ip ospf network <type>/.test(out), 'the usage line names the network form (it was accepted but unlisted)');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
