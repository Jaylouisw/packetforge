'use strict';
// show-ip-aliases.test.js - the `show ip ...` spellings an operator types, and what an absent view says.
//
//   R1#show ip access-lists
//   % Invalid show command: ip access-lists
//   SW1#show ip dhcp snooping
//   % Usage: show ip dhcp binding | show ip dhcp pool
//
// Three answers that were not answers. `show ip access-lists` is the spelling IOS documents and every
// lab guide types, refused while the console held the table. A switch asked about DHCP snooping was
// pointed at two views of a DHCP *server* - a device a switch cannot be. And `show ip traffic`, a view
// on every device, was a typo.
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
  const r1 = t.addDevice(find('generic-router')); r1.name = 'R1';
  const r2 = t.addDevice(find('generic-router')); r2.name = 'R2';
  const sw = t.addDevice(find('generic-switch')); sw.name = 'SW1';
  t.connect(r1.id, 'Gi0/0', r2.id, 'Gi0/0');
  const sim = new Simulator(t);
  const s = new CliSession(r1, t, sim); s.run('enable');
  const s2 = new CliSession(r2, t, sim); s2.run('enable');
  s2.run('configure terminal', 'interface Gi0/0', 'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'exit', 'end');
  s.run('configure terminal', 'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
    'access-list 101 deny icmp host 10.0.0.1 host 10.0.0.2', 'access-list 101 permit ip any any',
    'interface Gi0/0', 'ip access-group 101 out', 'exit', 'end');
  const w = new CliSession(sw, t, sim); w.run('enable');
  return { t: t, sim: sim, r1: r1, sw: sw, s: s, s2: s2, w: w };
}

console.log('show ip access-lists is the same table as show access-lists:');
{
  const env = lab();
  env.s.run('ping 10.0.0.2');
  const plain = env.s.run('show access-lists').output;
  const aliased = env.s.run('show ip access-lists').output;
  ok(!/^% Invalid show command/.test(aliased[0] || ''), 'the ip spelling is accepted');
  ok(JSON.stringify(plain) === JSON.stringify(aliased), 'and prints exactly the same table');
  ok(/\d+ matches/.test(aliased.join('\n')), 'with the match counters in it');
}

console.log('\nthe counters follow the traffic and a clear moves them back:');
{
  const env = lab();
  env.s.run('ping 10.0.0.2');
  const first = text(env.s.run('show ip access-lists'));
  const n = Number((/(\d+) matches/.exec(first) || [])[1]);
  ok(n > 0, 'a blocked packet is counted on the line that blocked it (' + n + ')');
  env.s.run('ping 10.0.0.2');
  const second = Number((/(\d+) matches/.exec(text(env.s.run('show access-lists'))) || [])[1]);
  ok(second > n, 'a second ping adds to the same counter');
  env.s.run('clear ip access-list counters');
  ok(!/\d+ matches/.test(text(env.s.run('show ip access-lists'))), 'and the clear empties them');
}

console.log('\nshow ip traffic says the same numbers as the port table:');
{
  const env = lab();
  env.s.run('ping 10.0.0.2');
  const traffic = text(env.s.run('show ip traffic'));
  const counters = text(env.s.run('show interfaces counters'));
  const m = /Gi0\/0\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/.exec(counters);
  ok(/Traffic through R1/.test(traffic), 'the view answers');
  ok(new RegExp('Received\\s+' + m[1] + ' packets, ' + m[2] + ' bytes').test(traffic),
    'the received total is the port table\'s received total');
  ok(new RegExp('Sent\\s+' + m[3] + ' packets, ' + m[4] + ' bytes').test(traffic),
    'and the sent total is its sent total');
  ok(new RegExp('Dropped\\s+' + m[5] + ' packets').test(traffic), 'and the drops are its drops');
  ok(/acl-deny\s+[1-9]/.test(traffic), 'the drop reason is named, not just counted');
  ok(/not counted: a per-protocol breakdown/.test(traffic),
    'and it says which breakdown it does not keep');
  ok(!/ICMP\s+\d+\s+\d+/.test(traffic), 'it prints no protocol rows it cannot back');
}

console.log('\nwith nothing on the wire it says so instead of printing zeros:');
{
  const env = lab();
  const out = text(env.s.run('show ip traffic'));
  ok(/carried no traffic since this lab started/.test(out), 'the idle device says it is idle');
  ok(/show interfaces counters/.test(out), 'and names the view that has the detail');
}

console.log('\na switch asked about DHCP snooping is not pointed at a server view:');
{
  const env = lab();
  const out = text(env.w.run('show ip dhcp snooping'));
  ok(/DHCP snooping is not modelled/.test(out), 'it says snooping is not modelled');
  ok(/ordinary broadcast/.test(out), 'and what the switch does instead');
  ok(!/show ip dhcp pool/.test(out), 'it does not offer a pool view a switch cannot serve');
  ok(/show mac address-table/.test(out), 'it names the view that answers the real question');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
