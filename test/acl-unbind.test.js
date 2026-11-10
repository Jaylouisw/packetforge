'use strict';
// acl-unbind.test.js — `no ip access-group` must unbind a list from an interface.
// Before it existed, a bound ACL could never be removed from the CLI, so
// "turn the ACL off and watch the flow succeed" was impossible to demonstrate.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function allUp(replies) { return replies.every(function (x) { return x.success; }); }
function allDown(replies) { return replies.every(function (x) { return !x.success; }); }

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(v, m) {
  const s = catalog.find(function (x) { return x.vendor === v && x.model === m; });
  if (!s) throw new Error('spec not found: ' + v + '/' + m);
  return s;
}

function build() {
  const t = new Topology();
  const pc1 = t.addDevice(spec('generic', 'generic-pc'));
  const pc2 = t.addDevice(spec('generic', 'generic-pc'));
  const r1 = t.addDevice(spec('generic', 'generic-router'));
  t.connect(pc1.id, 'eth0', r1.id, 'Gi0/0');
  t.connect(pc2.id, 'eth0', r1.id, 'Gi0/1');
  const sim = new Simulator(t);
  runCommands(pc1, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.1.10 255.255.255.0', 'exit', 'ip default-gateway 10.0.1.1']);
  runCommands(pc2, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.2.20 255.255.255.0', 'exit', 'ip default-gateway 10.0.2.1']);
  runCommands(r1, t, sim, ['configure terminal',
    'interface Gi0/0', 'ip address 10.0.1.1 255.255.255.0', 'exit',
    'interface Gi0/1', 'ip address 10.0.2.1 255.255.255.0']);
  return { t: t, sim: sim, pc1: pc1, pc2: pc2, r1: r1 };
}

const L = build();
const cli = function (cmds) { return runCommands(L.r1, L.t, L.sim, ['configure terminal'].concat(cmds)).lines.join('\n'); };
const show = function (cmd) { return runCommands(L.r1, L.t, L.sim, ['enable', cmd]).lines.join('\n'); };

cli(['access-list 10 deny host 10.0.1.10',
  'access-list 10 permit any',
  'interface Gi0/0', 'ip access-group 10 in']);

ok(allDown(L.sim.ping(L.pc1.id, '10.0.2.20', { count: 1 }).replies), 'the bound ACL blocks the flow');
ok(/applied IN on Gi0\/0/.test(show('show access-lists')), 'show access-lists reports the binding');
ok(/ip access-group 10 in/.test(show('show running-config')), 'running-config carries the binding');

const removed = cli(['interface Gi0/0', 'no ip access-group 10 in']);
ok(/removed access list binding \(in\)/.test(removed), 'no ip access-group removes the binding');
ok(!/applied IN on Gi0\/0/.test(show('show access-lists')), 'show access-lists no longer reports it');
ok(!/ip access-group 10 in/.test(show('show running-config')), 'running-config no longer carries it');
ok(allUp(L.sim.ping(L.pc1.id, '10.0.2.20', { count: 1 }).replies), 'traffic flows again once unbound');

// A number that is not bound is refused rather than silently clearing the other side.
cli(['interface Gi0/0', 'ip access-group 10 in', 'ip access-group 10 out']);
const wrong = cli(['interface Gi0/0', 'no ip access-group 999 in']);
ok(/is not bound/.test(wrong), 'a number that is not bound is refused');
ok(/ip access-group 10 in/.test(show('show running-config')), 'and the real binding survives');

// No arguments clears both directions.
const both = cli(['interface Gi0/0', 'no ip access-group']);
ok(/removed access list binding \(in, out\)/.test(both), 'no ip access-group with no arguments clears both directions');
ok(!/ip access-group 10/.test(show('show running-config')), 'neither direction remains');

const none = cli(['interface Gi0/0', 'no ip access-group']);
ok(/% No access list is bound/.test(none), 'clearing an unbound interface says so');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
