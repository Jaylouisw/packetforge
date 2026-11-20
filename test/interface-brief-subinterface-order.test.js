'use strict';
// `show ip interface brief` prints a subinterface directly under the port it rides on.
//
// This table iterated the device's interface map and appended every subinterface after every physical port, so
// a router-on-a-stick answered
//
//   GigabitEthernet0/0/0    unassigned  ...
//   GigabitEthernet0/0/1    unassigned  ...
//   GigabitEthernet0/0/2    unassigned  ...
//   GigabitEthernet0/0/0.10 10.10.0.1   ...
//
// while `show interfaces` on the same box already put the child block under its parent. A real IOS router prints
// the child under the parent, before the next socket - a Cisco 1921's own table (community.cisco.com/t5/
// other-network-architecture-subjects/cisco-router-1921-problem/td-p/4716312/page/2) reads `GigabitEthernet0/0/1`,
// `GigabitEthernet0/0/1.1`, `GigabitEthernet0/0/1.2`, `Gi0/0/1.600`, then `GigabitEthernet0/0/2`. The two views
// of one list now share one walk (`orderWithChildren` in engine/cli.js), so they cannot order it two ways.
// research/interface-brief-subinterface-order.md holds the evidence.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
function spec(model) { return catalog.filter(function (s) { return s.model === model; })[0]; }

// A three-port router, so a child that is printed last is unmistakably last: the row after it would be the next
// physical port on a box.
function router() {
  const t = new Topology();
  const r = t.addDevice(spec('ISR4321'), 'r1');
  const sim = new Simulator(t);
  sim.setRunTime(10000);
  const s = new CliSession(r, t, sim);
  s.run('enable');
  return {
    t: t, r: r, s: s,
    say: function (c) { return ((s.run(c).output) || []).map(String); },
    names: function () {
      return this.say('show ip interface brief')
        .filter(function (l) { return /^(GigabitEthernet|Serial|FastEthernet|Loopback|Vlan)/.test(l); })
        .map(function (l) { return l.split(/\s+/)[0]; });
    },
    subif: function (parent, id, addr) {
      this.s.run('configure terminal');
      this.s.run('interface ' + parent + '.' + id);
      this.s.run('encapsulation dot1q ' + id);
      this.s.run('ip address ' + addr + ' 255.255.255.0');
      this.s.run('exit');
      this.s.run('end');
    }
  };
}

console.log('');
console.log('Two subinterfaces ride on the first port: both sit between it and the second port:');
{
  const env = router();
  env.subif('Gi0/0/0', 10, '10.10.0.1');
  env.subif('Gi0/0/0', 20, '10.20.0.1');
  const seen = env.names();
  ok(JSON.stringify(seen) === JSON.stringify([
    'GigabitEthernet0/0/0', 'GigabitEthernet0/0/0.10', 'GigabitEthernet0/0/0.20',
    'GigabitEthernet0/0/1', 'GigabitEthernet0/0/2'
  ]), 'the order is parent, .10, .20, then the other two ports', JSON.stringify(seen));
  ok(seen.indexOf('GigabitEthernet0/0/0.10') === seen.indexOf('GigabitEthernet0/0/0') + 1,
    'the first child is the row directly under its parent');
  ok(seen.indexOf('GigabitEthernet0/0/2') > seen.indexOf('GigabitEthernet0/0/0.20'),
    'and the last child still comes before the next physical port');
  ok(seen.filter(function (n) { return /\./.test(n); }).length === 2,
    'no child was dropped and none was duplicated', JSON.stringify(seen));
}

console.log('');
console.log('Children follow their own parent, not the first parent in the table:');
{
  const env = router();
  env.subif('Gi0/0/1', 30, '10.30.0.1');
  env.subif('Gi0/0/0', 10, '10.10.0.1');
  const seen = env.names();
  ok(JSON.stringify(seen) === JSON.stringify([
    'GigabitEthernet0/0/0', 'GigabitEthernet0/0/0.10',
    'GigabitEthernet0/0/1', 'GigabitEthernet0/0/1.30',
    'GigabitEthernet0/0/2'
  ]), 'each child is under its own parent, in creation order', JSON.stringify(seen));
}

console.log('');
console.log('A shut parent keeps its children under it:');
{
  const env = router();
  env.subif('Gi0/0/0', 10, '10.10.0.1');
  env.s.run('configure terminal');
  env.s.run('interface Gi0/0/0');
  env.s.run('shutdown');
  env.s.run('end');
  const seen = env.names();
  ok(JSON.stringify(seen) === JSON.stringify([
    'GigabitEthernet0/0/0', 'GigabitEthernet0/0/0.10', 'GigabitEthernet0/0/1', 'GigabitEthernet0/0/2'
  ]), 'the parent and its child stay together when the parent goes down', JSON.stringify(seen));
  const row = env.say('show ip interface brief').filter(function (l) {
    return l.split(/\s+/)[0] === 'GigabitEthernet0/0/0.10';
  })[0];
  ok(/administratively down\s+down/.test(row), 'and the child reads the parent\'s state, not a cable it never had', row);
}

console.log('');
console.log('`show interfaces` and `show ip interface brief` order the list the same way:');
{
  const env = router();
  env.subif('Gi0/0/0', 10, '10.10.0.1');
  env.subif('Gi0/0/2', 40, '10.40.0.1');
  const blocks = env.say('show interfaces')
    .filter(function (l) { return /^\S+ \((\w+), /.test(l); })
    .map(function (l) { return require('../engine/iface-name').displayName(l.split(' ')[0]); });
  const brief = env.names();
  ok(JSON.stringify(blocks) === JSON.stringify(brief),
    'the two views print one sequence', JSON.stringify(blocks) + ' vs ' + JSON.stringify(brief));
}

console.log('');
console.log('A box with no subinterfaces is unchanged:');
{
  const t = new Topology();
  const sw = t.addDevice(spec('C2960X-24TS-L'), 'sw1');
  const s = new CliSession(sw, t, new Simulator(t));
  s.run('enable');
  const seen = ((s.run('show ip interface brief').output) || []).map(String)
    .filter(function (l) { return /^GigabitEthernet/.test(l); })
    .map(function (l) { return l.split(/\s+/)[0]; });
  ok(seen.length > 0 && seen[0] === 'GigabitEthernet1/0/1' && seen[1] === 'GigabitEthernet1/0/2',
    'the switch still lists its ports in panel order', JSON.stringify(seen.slice(0, 3)));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
