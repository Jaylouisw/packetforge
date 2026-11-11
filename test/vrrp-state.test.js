'use strict';
// vrrp-state.test.js - what a VRRP group is, and what survives a save.
//
//   R1(config-if)#no vrrp 1 ip
//   VRRP group 1 on Gi0/0 no longer owns 10.0.0.254 - the group is still configured
//   R1#show vrrp
//   Gi0/0  1  100  Backup  -  (blank)  -        <- a "Backup" group that cannot elect anything
//
// Two states this console could hold and should not: a group that owns no virtual address (nothing to
// be master of, and no IOS spelling that produces one), and a `preempt off` setting that was read as
// "reset to the default", switched back on, then dumped as nothing - so it was lost on every save.
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
  R.run('configure terminal', 'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown',
    'vrrp 1 ip 10.0.0.254', 'exit', 'end');
  return { t: t, sim: sim, r: r, R: R };
}
const groups = function (env) { return (env.r.config.vrrp || []); };
const dumpVrrp = function (env) {
  return text(env.R.run('show running-config')).split('\n').filter(function (l) { return /vrrp/.test(l); });
};

console.log('Removing the last virtual address removes the group, and says why:');
{
  const env = lab();
  const out = text(env.R.run('configure terminal', 'interface Gi0/0', 'no vrrp 1 ip', 'exit'));
  ok(/removed - it owned 10\.0\.0\.254/.test(out), 'the removal reports the address and the removal');
  ok(/nothing to be master of/.test(out), 'and says why a group without one is not a group');
  ok(groups(env).length === 0, 'the group is gone');
  const show = text(env.R.run('show vrrp'));
  ok(/VRRP is not configured/.test(show), 'and `show vrrp` says so instead of printing an empty row');
  ok(!/Backup/.test(show), 'no election is described for a group that does not exist');
  ok(dumpVrrp(env).length === 0, 'and nothing is left in the configuration');
}

console.log('\nRemoving the address by name does the same when it is the only one:');
{
  const env = lab();
  const out = text(env.R.run('configure terminal', 'interface Gi0/0', 'no vrrp 1 ip 10.0.0.254', 'exit'));
  ok(/removed - 10\.0\.0\.254 was its only virtual address/.test(out), 'the last address takes the group');
  ok(groups(env).length === 0, 'and there is no group left');
}

console.log('\nWith a second address the group survives:');
{
  const env = lab();
  env.R.run('configure terminal', 'interface Gi0/0', 'vrrp 1 ip 10.0.0.253', 'exit', 'end');
  const out = text(env.R.run('configure terminal', 'interface Gi0/0', 'no vrrp 1 ip 10.0.0.254', 'exit'));
  ok(/no longer owns 10\.0\.0\.254/.test(out), 'the address is dropped');
  ok(groups(env).length === 1, 'and the group is still there');
  ok(JSON.stringify(groups(env)[0].ips) === JSON.stringify(['10.0.0.253']), 'owning the other one');
}

console.log('\n`no vrrp <id> preempt` turns preempt off, and the setting survives a save:');
{
  const env = lab();
  env.R.run('configure terminal', 'interface Gi0/0', 'vrrp 1 priority 150', 'no vrrp 1 preempt', 'exit', 'end');
  ok(groups(env)[0].preempt === false, 'preempt is off');
  const lines = dumpVrrp(env);
  ok(lines.length === 3, 'the dump holds exactly the configured lines (' + lines.length + ')');
  ok(lines.some(function (l) { return /no vrrp 1 preempt/.test(l); }), 'including the removal');
  // The assertion has to allow the `no ` prefix: the positive form `vrrp 1 preempt` is the default
  // and must not be dumped, while `no vrrp 1 preempt` is the configuration.
  ok(!lines.some(function (l) { return /^\s*vrrp 1 preempt$/.test(l.trim()); }),
    'and not the default in its positive form (preempt is on by default)');
  env.R.run('write memory');
  env.R.run('copy startup-config running-config');
  ok(groups(env)[0].preempt === false, 'preempt is still off after the saved copy is loaded back');
  ok(groups(env)[0].priority === 150, 'and the priority survived as well');
}

console.log('\nA default priority is not configuration:');
{
  const env = lab();
  env.R.run('configure terminal', 'interface Gi0/0', 'vrrp 1 priority 100', 'exit', 'end');
  const lines = dumpVrrp(env);
  ok(lines.length === 1, 'the dump holds only the address (' + lines.length + ' lines)');
  ok(!lines.some(function (l) { return /priority/.test(l); }), 'a priority of 100 is not written');
}

console.log('\nA group that owns an address still reports its election:');
{
  const env = lab();
  const show = text(env.R.run('show vrrp'));
  ok(/10\.0\.0\.254/.test(show), 'the virtual address is in the table');
  ok(/Backup|Master/.test(show), 'and its state');
  ok(/not converged|holds the virtual address/.test(show), 'with a footer that says which case it is in');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
