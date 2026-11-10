'use strict';
// The `Age (min)` column is a number, and an old neighbour is not a neighbour (#1397).
//
// `show arp` printed `Age (min)` as a header over a hard-coded '-' on every row, on the grounds - stated in the
// code and in docs/CLI.md - that "the simulator has steps, not minutes". That stopped being true when convergence
// gave the model an instant in milliseconds, and the same instant already ages the MAC table (#1395).
//
//   4 h is the age (ARP_AGE_MS, the IOS default `arp timeout 14400`)
//   learned at t=10 min   present at 30 min, aged 20      gone at 5 h
//   heard again           the age is silence, not a lifetime
//
// An entry nothing dated - a fixture's, an imported lab's - is never aged and prints '-' in that column.
const path = require('path');
const { CliSession } = require('../engine/cli');
const { Topology } = require('../engine/topology');
const { Simulator } = require('../engine/simulator');
const { loadCatalog } = require('../devices/registry');
const deviceModule = require('../engine/device');
const ARP_AGE_MS = deviceModule.ARP_AGE_MS;

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.filter(function (s) { return s.model === 'ISR 4331'; })[0];
const HOST = catalog.filter(function (s) { return s.model === 'Raspberry Pi 5'; })[0];

// The column the age sits in: Protocol, Address, Age (min), Hardware Addr, Interface.
const COL = { proto: 0, ip: 1, age: 2, mac: 3, iface: 4 };

function cli(dev, topo, cmds) {
  const s = new CliSession(dev, topo, new Simulator(topo));
  s.run('enable'); s.run('configure terminal');
  for (const c of (cmds || [])) s.run(c);
  s.run('end');
}

// r1 - h1 on 10.0.0.0/24, so one ping is one neighbour each way.
function lab() {
  const t = new Topology();
  t.addDevice(ROUTER, 'r1'); t.addDevice(HOST, 'h1');
  t.connect('h1', 'eth0', 'r1', 'Gi0/0/0', { mediaId: '1000base-t', speedMbps: 1000 });
  cli(t.getDevice('r1'), t, ['interface Gi0/0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown']);
  cli(t.getDevice('h1'), t, ['interface eth0', 'ip address 10.0.0.2 255.255.255.0']);
  return { t: t, r: t.getDevice('r1'), sim: new Simulator(t) };
}

function rows(env) {
  const lines = ((new CliSession(env.r, env.t, env.sim).run('show arp').output) || []).map(String);
  const head = lines[0] || '';
  return {
    head: head,
    body: lines.slice(1),
    fields: lines.slice(1).map(function (l) { return l.trim().split(/\s+/); })
  };
}
function rowFor(env, ip) {
  const out = rows(env);
  return { out: out, row: out.fields.filter(function (f) { return f[COL.ip] === ip; })[0] || null };
}

console.log('The age is four hours, named once');
{
  ok(ARP_AGE_MS === 14400000, 'ARP_AGE_MS is 14,400 s - the IOS default arp timeout', String(ARP_AGE_MS));
  ok(typeof deviceModule.Device.prototype.arpLookup === 'function' &&
    typeof deviceModule.Device.prototype.ageArps === 'function',
    'the neighbour table has an aged reader and a sweep');
  const proto = Object.getOwnPropertyNames(deviceModule.Device.prototype);
  ok(proto.indexOf('learnArp') >= 0, 'and one writer, learnArp');
}

console.log('');
console.log('The column is a number, and it is the silence');
{
  const env = lab();
  env.sim.setRunTime(600000);                    // 10 min in: the ping learns the neighbour now
  env.sim.ping('r1', '10.0.0.2', { count: 1 });
  const at0 = rowFor(env, '10.0.0.2');
  ok(!!at0.row, 'the neighbour is in the table', JSON.stringify(at0.out.body));
  ok(at0.row[COL.age] === '0', 'aged 0 min at the instant it was heard', at0.row[COL.age]);
  ok(/Age \(min\)/.test(at0.out.head), 'the column is still called Age (min)', at0.out.head);

  env.sim.setRunTime(1800000);                   // 30 min in: 20 min of silence
  const at20 = rowFor(env, '10.0.0.2');
  ok(!!at20.row && at20.row[COL.age] === '20', 'at 30 min it says 20, in minutes', at20.row && at20.row[COL.age]);
  ok(at20.row[COL.iface] === 'Gi0/0/0', 'and still names the port it was heard on', at20.row[COL.iface]);
}

console.log('');
console.log('Past four hours it is gone');
{
  const env = lab();
  env.sim.setRunTime(600000);
  env.sim.ping('r1', '10.0.0.2', { count: 1 });
  env.sim.setRunTime(6 * 3600 * 1000);           // 6 h in: nearly 6 h of silence
  const out = rowFor(env, '10.0.0.2');
  ok(out.row === null, 'the row is gone from show arp', JSON.stringify(out.out.body));
  ok(env.r.arp.has('10.0.0.2') === false, 'and the table no longer holds the address',
    JSON.stringify(Array.from(env.r.arp.entries())));
  ok(env.r.arpPorts.has('10.0.0.2') === false, 'nor the port it was heard on',
    JSON.stringify(Array.from(env.r.arpPorts.entries())));
  ok(env.r.arpLookup('10.0.0.2', 6 * 3600 * 1000) === null, 'the lookup answers nothing',
    String(env.r.arpLookup('10.0.0.2', 6 * 3600 * 1000)));
}

console.log('');
console.log('The age is silence: a neighbour that keeps talking stays');
{
  const env = lab();
  env.sim.setRunTime(600000);
  env.sim.ping('r1', '10.0.0.2', { count: 1 });
  env.sim.setRunTime(3 * 3600 * 1000);           // 3 h in: 170 min of silence, still inside the age
  const mid = env.sim.ping('r1', '10.0.0.2', { count: 1 });
  ok(mid.replies[0].success, 'a ping at 3 h still resolves', mid.replies[0].reason);
  ok(mid.events.filter(function (e) { return e.via === 'arp-cache'; }).length > 0,
    'and it resolves off the cache: using an entry is not hearing from the neighbour, so the age does not reset');

  // What does reset it is a new reply. At 5 h the entry has aged out, so the ping ARPs, and the reply is heard at
  // 5 h - which is what the age then counts from.
  env.sim.setRunTime(5 * 3600 * 1000);
  const relearn = env.sim.ping('r1', '10.0.0.2', { count: 1 });
  ok(relearn.replies[0].success && env.r.arp.has('10.0.0.2'), 'at 5 h the reply re-learns the neighbour',
    relearn.replies[0].reason);
  env.sim.setRunTime(7 * 3600 * 1000);           // 7 h: two hours after the reply
  const late = rowFor(env, '10.0.0.2');
  ok(!!late.row, 'at 7 h it is still there, because it was heard at 5 h', JSON.stringify(late.out.body));
  ok(late.row && late.row[COL.age] === '120',
    'aged 120 min: minutes since it was heard, not since it was first heard',
    late.row && late.row[COL.age]);
}

console.log('');
console.log('The data plane ARPs again instead of using a stale neighbour');
{
  const env = lab();
  env.sim.setRunTime(600000);
  env.sim.ping('r1', '10.0.0.2', { count: 1 });

  const fresh = env.sim.ping('r1', '10.0.0.2', { count: 1 });
  ok(fresh.events.filter(function (e) { return e.via === 'arp-cache'; }).length > 0,
    'while the entry is fresh the frame goes out on the cache - this is the cache being used');
  ok(fresh.events.filter(function (e) { return e.type === 'frame' && e.frame && e.frame.etherType === 'arp'; }).length === 0,
    'and no ARP is sent');

  env.sim.setRunTime(6 * 3600 * 1000);
  const aged = env.sim.ping('r1', '10.0.0.2', { count: 1 });
  const arps = aged.events.filter(function (e) { return e.type === 'frame' && e.frame && e.frame.etherType === 'arp'; });
  ok(arps.length > 0, 'once it has aged, the router ARPs for the next hop', String(arps.length));
  ok(aged.events.filter(function (e) { return e.via === 'arp-cache'; }).length === 0,
    'and nothing goes out on the cache');
  ok(aged.replies[0].success, 'the ping still gets there, because ARP answers', aged.replies[0].reason);
  ok(env.r.arp.has('10.0.0.2') && Number.isFinite(env.r.arpSeenAt.get('10.0.0.2')),
    'and the neighbour is learned again with a fresh instant',
    JSON.stringify(Array.from(env.r.arpSeenAt.entries())));
}

console.log('');
console.log('An entry nothing dated is not aged, and says so');
{
  const env = lab();
  env.r.arp.set('10.0.0.9', '02:00:00:00:09:00');    // the shape a fixture writes: address only
  env.sim.setRunTime(24 * 3600 * 1000);
  const out = rowFor(env, '10.0.0.9');
  ok(!!out.row, 'a hand-written neighbour survives a day', JSON.stringify(out.out.body));
  ok(out.row[COL.age] === '-', 'and reports no age rather than inventing one', out.row[COL.age]);
  ok(env.r.arpLookup('10.0.0.9', 24 * 3600 * 1000) === '02:00:00:00:09:00',
    'the data plane treats it as reachable: nothing said when it was seen');
  ok(env.r.ageArps(24 * 3600 * 1000) === 0 || env.r.arp.has('10.0.0.9'),
    'and no sweep removes it');
}

console.log('');
console.log('The sweep removes only what has aged');
{
  const env = lab();
  env.sim.setRunTime(600000);
  env.sim.ping('r1', '10.0.0.2', { count: 1 });
  env.r.learnArp('10.0.0.8', '02:00:00:00:08:00', 'Gi0/0/0', 5 * 3600 * 1000);  // heard an hour ago at t=6h
  const dropped = env.r.ageArps(6 * 3600 * 1000);
  ok(dropped === 1, 'exactly one entry was too old', String(dropped));
  ok(env.r.arp.has('10.0.0.8'), 'the recently heard one is untouched', String(env.r.arp.has('10.0.0.8')));
  ok(!env.r.arp.has('10.0.0.2'), 'and the silent one is gone', String(env.r.arp.has('10.0.0.2')));
  ok(env.r.ageArps(6 * 3600 * 1000) === 0, 'a second sweep drops nothing');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
