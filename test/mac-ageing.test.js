'use strict';
// A learned MAC is not "here" for ever (#1395).
//
// The switch table had no timestamps at all: an entry stayed until its port changed VLAN or the lab was reloaded,
// which is why `show mac address-table` had to append a note saying the row might be stale. The simulator has had
// an instant in milliseconds since convergence was modelled, so an entry can be stamped with when it was heard and
// aged against the question being asked.
//
//   learned at t=60 s    present at 200 s (140 s silent)      gone at 400 s (340 s silent)
//   heard again at 250 s  present at 500 s                     (the age is silence, not a lifetime)
//
// A MAC the engine did not stamp - written by a fixture, an imported lab - is never aged and reports no age. That
// is the honest reading: nothing recorded when it was seen.
const path = require('path');
const { CliSession } = require('../engine/cli');
const { Topology } = require('../engine/topology');
const { Simulator } = require('../engine/simulator');
const { loadCatalog } = require('../devices/registry');
const deviceModule = require('../engine/device');
const MAC_AGE_MS = deviceModule.MAC_AGE_MS;

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.filter(function (s) { return /CX 6000 24G CL4/.test(s.model); })[0];
const HOST = catalog.filter(function (s) { return /Raspberry Pi 5/.test(s.model); })[0];

function cli(dev, topo, cmds) {
  const s = new CliSession(dev, topo, new Simulator(topo));
  s.run('enable'); s.run('configure terminal');
  for (const c of (cmds || [])) s.run(c);
  s.run('end');
}

// h1 - sw1 - h2   (10.0.0.0/24, so one ping is one learned pair)
function lab() {
  const t = new Topology();
  t.addDevice(SWITCH, 'sw1'); t.addDevice(HOST, 'h1'); t.addDevice(HOST, 'h2');
  t.connect('h1', 'eth0', 'sw1', '1/1/1', { mediaId: '1000base-t', speedMbps: 1000 });
  t.connect('h2', 'eth0', 'sw1', '1/1/2', { mediaId: '1000base-t', speedMbps: 1000 });
  cli(t.getDevice('h1'), t, ['interface eth0', 'ip address 10.0.0.1 255.255.255.0']);
  cli(t.getDevice('h2'), t, ['interface eth0', 'ip address 10.0.0.2 255.255.255.0']);
  return { t: t, sw: t.getDevice('sw1'), sim: new Simulator(t) };
}

function table(env, nowMs) {
  const out = [];
  const lines = ((new CliSession(env.sw, env.t, env.sim).run('show mac address-table').output) || []).map(String);
  for (const l of lines.slice(1)) {
    const f = l.trim().split(/\s+/);
    out.push({ vlan: f[0], mac: f[1], type: f[2], age: f[3], port: f[4] });
  }
  return out;
}

console.log('The default age is named once, and it is a silence, not a lifetime');
{
  ok(MAC_AGE_MS === 300000, 'MAC_AGE_MS is 300 s, the usual switch default', String(MAC_AGE_MS));
  ok(typeof deviceModule.Device.prototype.learnMac === 'function' &&
    typeof deviceModule.Device.prototype.macLookup === 'function' &&
    typeof deviceModule.Device.prototype.ageMacs === 'function',
    'the table has one writer, one aged reader and one sweep');
}

console.log('');
console.log('An entry ages out of the table');
{
  const env = lab();
  env.sim.setRunTime(60000);
  env.sim.ping('h1', '10.0.0.2', { count: 1 });
  env.sim.setRunTime(60000);            // ask at the instant the traffic was
  const at60 = table(env);
  ok(at60.some(function (r) { return r.port === '1/1/1' && r.age === '0s'; }),
    'the entry is there, aged 0 s, at the instant it was heard', JSON.stringify(at60));

  env.sim.setRunTime(200000);           // 140 s of silence: inside the 300 s age
  const at200 = table(env);
  ok(at200.some(function (r) { return r.port === '1/1/1' && r.age === '140s'; }),
    'at 200 s it is still there, and says 140 s', JSON.stringify(at200));

  env.sim.setRunTime(400000);           // 340 s of silence: past the age
  const at400 = table(env);
  ok(!at400.some(function (r) { return r.port === '1/1/1'; }),
    'at 400 s the row is gone: the switch has not heard from it in 340 s', JSON.stringify(at400));
  ok(env.sw.macTable.size === 0 || !env.sw.macTable.has('02:00:00:00:01:00'),
    'and the table itself no longer holds it', String(env.sw.macTable.size));
}

console.log('');
console.log('The age is silence: traffic refreshes it');
{
  const env = lab();
  env.sim.setRunTime(60000);
  env.sim.ping('h1', '10.0.0.2', { count: 1 });
  env.sim.setRunTime(250000);           // 190 s later, still alive
  env.sim.ping('h1', '10.0.0.2', { count: 1 });
  env.sim.setRunTime(500000);           // 250 s after the second ping: inside the age
  const rows = table(env);
  ok(rows.some(function (r) { return r.port === '1/1/1'; }),
    'an address heard 250 s ago is still in the table, 440 s after it was first learned', JSON.stringify(rows));
}

console.log('');
console.log('The data plane reads the same age as the report');
{
  const env = lab();
  env.sim.setRunTime(60000);
  env.sim.ping('h1', '10.0.0.2', { count: 1 });
  const mac = '02:00:00:00:01:00';
  ok(env.sw.macLookup(1, mac, 60000) === '1/1/1', 'the table answers with the port while it is fresh',
    String(env.sw.macLookup(1, mac, 60000)));
  ok(env.sw.macLookup(1, mac, 400000) === null,
    'and answers nothing once the entry has aged - a frame must not go to a port the table only remembers',
    String(env.sw.macLookup(1, mac, 400000)));

  // Behaviourally, and on the same board: h2 already has h1's address in its ARP cache, so the first frame after
  // the age is a unicast to a MAC the switch has just forgotten. It must flood - sending it only to the port the
  // table remembers is how a host that moved becomes unreachable.
  const h2 = env.t.getDevice('h2');
  h2.arp.set('10.0.0.1', '02:00:00:00:01:00');
  if (h2.arpPorts) h2.arpPorts.set('10.0.0.1', 'eth0');

  env.sim.setRunTime(200000);   // entry still fresh: the frame is forwarded to the port the table knows
  const fresh = env.sim.ping('h2', '10.0.0.1', { count: 1 });
  const freshHops = fresh.events.filter(function (e) { return e.type === 'switch'; });
  ok(fresh.replies[0].success && freshHops.length > 0, 'the ping crosses the switch while the entry is fresh',
    String(freshHops.length));
  ok(freshHops[0].action === 'forward',
    'and the first hop is a forward, because the switch knows where h1 is', freshHops[0].action);

  // The forwarding decision is the aged lookup: with the lookup answering nothing - which is what an aged entry
  // is - the same frame floods instead of being sent to the port the table remembers. Stubbing the one method
  // proves the decision reads it, rather than reading the raw map beside it.
  env.sim.setRunTime(550000);
  const realLookup = env.sw.macLookup.bind(env.sw);
  env.sw.macLookup = function () { return null; };
  const aged = env.sim.ping('h2', '10.0.0.1', { count: 1 });
  env.sw.macLookup = realLookup;
  const agedHops = aged.events.filter(function (e) { return e.type === 'switch'; });
  ok(aged.replies[0].success, 'the ping still gets there when nothing is remembered', aged.replies[0].reason);
  ok(agedHops.some(function (e) { return e.action === 'flood'; }),
    'and the switch floods rather than using a port it only remembers',
    agedHops.map(function (e) { return e.action; }).join(','));
}

console.log('');
console.log('An entry nothing dated is not aged, and says so');
{
  const env = lab();
  env.sw.macTable.set('02:00:00:00:aa:00', '1/1/1');   // the shape a fixture writes
  env.sw.macTables.set(20, new Map([['02:00:00:00:bb:00', '1/1/2']]));
  env.sim.setRunTime(900000);
  const rows = table(env);
  const manually = rows.filter(function (r) { return r.mac === '02:00:00:00:aa:00'; })[0];
  ok(!!manually, 'a hand-written entry survives any amount of time', JSON.stringify(rows));
  ok(manually.age === '-', 'and reports no age rather than inventing one', manually.age);
  ok(env.sw.macLookup(1, '02:00:00:00:aa:00', 900000) === '1/1/1',
    'the data plane treats it as reachable: nothing said when it was seen');
  ok(env.sw.macTables.get(20).get('02:00:00:00:bb:00') === '1/1/2',
    'and a per-VLAN entry of that shape is untouched too');
}

console.log('');
console.log('Ages are per VLAN, and the flat table is not listed twice');
{
  const env = lab();
  env.sim.setRunTime(60000);
  env.sim.ping('h1', '10.0.0.2', { count: 1 });
  const rows = table(env);
  const vlans = rows.map(function (r) { return r.vlan; });
  ok(vlans.every(function (v) { return v === '1'; }), 'everything learned in VLAN 1 is listed once',
    vlans.join(','));
  ok(new Set(rows.map(function (r) { return r.mac; })).size === rows.length,
    'no address appears twice', JSON.stringify(rows.map(function (r) { return r.mac; })));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
