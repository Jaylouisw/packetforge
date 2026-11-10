'use strict';
// instant-vs-argument.test.js - a number that names something is not a time.
//
// This console can answer a control-plane question *at an instant*: `show vrrp at 500`, and as a
// convenience a bare trailing number (`show mac address-table 500`). Two views take a number as an
// argument - `show vrrp <group>` and `show ip ospf <pid>` - and there the convenience won:
//
//   R2#show vrrp 1
//   VRRP at t=1 ms (control planes rebuilt for this answer)
//   Gi0/0  1  100  Backup  -  10.0.0.254  -            <- the group R2 was MASTER of
//   (no router holds the virtual address yet - the group has not converged)
//
//   R2#show vrrp
//   Gi0/0  1  100  Master  R2  10.0.0.254  00:00:5e:00:01:01
//
// The 1 was read as one millisecond, the group id was dropped, and the answer was a different
// question - about the state before the election - with nothing saying the argument was ignored.
// The same shape in `show ip ospf 99`: a process id that does not exist answered as "at t=99 ms"
// about the process that does.
//
// The rule: a trailing number is an instant only where the view has no other use for a number;
// every `at <ms>` and every `converged` is still an instant everywhere.
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
function saw(re, out, msg) { ok(re.test(text(out)), msg + (re.test(text(out)) ? '' : ' (in ' + JSON.stringify(text(out).slice(0, 400)) + ')')); }
function absent(re, out, msg) { ok(!re.test(text(out)), msg + (re.test(text(out)) ? ' (unexpectedly matched)' : '')); }
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const find = function (m) { return catalog.filter(function (x) { return x.model === m; })[0]; };

// Two routers on one link, both speaking group 1; R1 also speaks group 2 alone.
function pair() {
  const t = new Topology();
  const r1 = t.addDevice(find('generic-router')); r1.name = 'R1';
  const r2 = t.addDevice(find('generic-router')); r2.name = 'R2';
  const sim = new Simulator(t);
  const s1 = new CliSession(r1, t, sim), s2 = new CliSession(r2, t, sim);
  s1.run('enable'); s2.run('enable');
  t.connect(r1.id, 'Gi0/0', r2.id, 'Gi0/0');
  for (const [s, ip] of [[s1, '10.0.0.1'], [s2, '10.0.0.2']]) {
    s.run('configure terminal'); s.run('interface Gi0/0');
    s.run('ip address ' + ip + ' 255.255.255.0'); s.run('no shutdown');
    s.run('vrrp 1 ip 10.0.0.254'); s.run('exit'); s.run('end');
  }
  s1.run('configure terminal'); s1.run('interface Gi0/0');
  s1.run('vrrp 2 ip 10.0.0.253'); s1.run('exit'); s1.run('end');
  return { t: t, sim: sim, r1: r1, r2: r2, s1: s1, s2: s2 };
}
function routerOspf(pid) {
  const t = new Topology();
  const d = t.addDevice(find('generic-router')); d.name = 'R1';
  const s = new CliSession(d, t, new Simulator(t));
  s.run('enable'); s.run('configure terminal');
  s.run('interface Gi0/0'); s.run('ip address 10.0.0.1 255.255.255.0'); s.run('exit');
  s.run('router ospf ' + pid); s.run('network 10.0.0.0 0.0.0.255 area 0'); s.run('exit');
  s.run('end');
  return { t: t, d: d, s: s };
}

console.log('\nshow vrrp <group> answers about that group, not about a time:');
{
  const env = pair();
  const all = text(env.s2.run('show vrrp'));
  const one = env.s2.run('show vrrp 1');
  absent(/t=1 ms|VRRP at t=/, one, 'the group id is not read as milliseconds');
  saw(/Master/, one, 'R2 is Master of group 1, as "show vrrp" says');
  saw(/R2\s+10\.0\.0\.254\s+00:00:5e:00:01:01/, one, 'with the master name, VIP and virtual MAC');
  absent(/no router holds the virtual address/, one, 'and no "has not converged" note about a converged group');
  // The two views must agree row for row.
  const rowAll = all.split('\n').filter(function (l) { return /^\s*Gi0\/0\s+1\s/.test(l); })[0] || '';
  const rowOne = text(one).split('\n').filter(function (l) { return /^\s*Gi0\/0\s+1\s/.test(l); })[0] || '';
  ok(rowAll.trim() === rowOne.trim(), 'the group row is identical in both views' +
    (rowAll.trim() === rowOne.trim() ? '' : ' (' + JSON.stringify(rowAll) + ' vs ' + JSON.stringify(rowOne) + ')'));

  // A second group on the same device: the filter narrows, it does not pick the first row.
  const g2 = env.s1.run('show vrrp 2');
  saw(/Master/, g2, 'group 2 on R1 is Master of its own group');
  absent(/\b10\.0\.0\.254\b/, g2, 'and group 1 is not in the answer for group 2');
  const g1 = env.s1.run('show vrrp 1');
  saw(/Backup/, g1, 'group 1 on R1 is Backup, because R2 holds it');
  saw(/R2/, g1, 'and the master is named');
  saw(/10\.0\.0\.254/, g1, 'group 1 answers about group 1');
}

console.log('\nA group that is not there is named as missing, with the ones that are:');
{
  const env = pair();
  const out = env.s1.run('show vrrp 9');
  saw(/No VRRP group 9 on R1/, out, 'the group is reported missing');
  saw(/The groups here are: 1 on Gi0\/0, 2 on Gi0\/0/, out, 'and the groups it has are listed');
  absent(/% Unrecognized/, out, 'it is not a typo complaint');
}

console.log('\nThe instant forms still work, and still say they are instants:');
{
  const env = pair();
  const at = env.s2.run('show vrrp at 500');
  saw(/VRRP at t=500 ms/, at, '"at 500" is still an instant, and labelled as one');
  saw(/Backup/, at, 'and at 500 ms the election has not happened yet: Backup');
  const conv = env.s2.run('show vrrp converged');
  saw(/VRRP at converged/, conv, '"converged" is still an instant');
  saw(/Master/, conv, 'and there the master is elected');
  // Reset the run for the rest of this lab: `at` sticks, by design.
  env.s2.run('show vrrp converged');
}

console.log('\nshow ip ospf <process-id> answers about the process, not about a time:');
{
  const env = routerOspf(7);
  const out = env.s.run('show ip ospf 7');
  absent(/t=7 ms|OSPF at t=/, out, 'the process id is not read as milliseconds');
  saw(/Routing Process "ospf 7"/, out, 'it answers about the process that is running');
  saw(/Gi0\/0/, out, 'with its interface');
  const wrong = env.s.run('show ip ospf 1');
  saw(/No OSPF process 1 on R1/, wrong, 'a process that is not running is refused');
  saw(/The process here is "ospf 7"/, wrong, 'naming the one that is');
  absent(/t=1 ms/, wrong, 'and it is not silently answered about t=1 ms');
  const at = env.s.run('show ip ospf at 500');
  saw(/OSPF at t=500 ms/, at, '"show ip ospf at 500" is still an instant');
  const conv = env.s.run('show ip ospf converged');
  saw(/OSPF at converged/, conv, 'and so is "converged"');
  // The plain form is unchanged.
  saw(/Routing Process "ospf 7"/, env.s.run('show ip ospf'), 'the bare form is still the process view');
}

console.log('\nThe page offers both argument forms:');
{
  const env = pair();
  const page = text(env.s1.run('?'));
  saw(/show vrrp \[<group>\]/, page, 'show vrrp [<group>] is on the page');
  saw(/show ip ospf \[<process-id>\]/, page, 'and show ip ospf [<process-id>]');
  // ...and a bare `show vrrp` still shows what it always showed.
  saw(/Interface\s+Group\s+Pri\s+State/, env.s1.run('show vrrp'), 'the bare form prints the table');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
