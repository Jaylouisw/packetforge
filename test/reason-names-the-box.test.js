'use strict';
// A reason read on one console must say which box recorded it (#1451).
//
// A host with a default gateway sends to that gateway. When the gateway has no route for the destination it drops the
// frame and records the drop, and the host's `ping` reported the drop's own words - `no route to 10.9.9.9` - verbatim.
// That is a statement about whichever box the reader is standing at, and the reader is standing at a host whose
// `show ip route` prints `S* 0.0.0.0/0 via 10.1.1.1` three lines above the failure. The event knew the box all along
// (`dev: 'r1'`); the sentence did not.
//
// The rule: a reason names the dropping box when that box is not the one the reader is at, and stays silent when the
// drop is local - because "no route to X" said at a box that really has no route IS a statement about that box.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const ROOT = path.join(__dirname, '..');
const catalog = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.find(function (s) { return s.model === 'ISR 4331' && s.vendor === 'cisco'; });
const SWITCH = catalog.find(function (s) { return s.model === 'generic-switch'; });
const PC = catalog.find(function (s) { return s.model === 'generic-pc'; });
function ports(t, id) { return [...t.getDevice(id).interfaces.keys()]; }

// A host behind a router that is its gateway. The router has one interface, so there is a whole internet it has no
// route to - which is the ordinary case that exposed this.
function gatewayLab(gateway) {
  const t = new Topology();
  t.addDevice(ROUTER, 'r1'); t.addDevice(SWITCH, 's1'); t.addDevice(PC, 'a');
  t.connect('r1', ports(t, 'r1')[1], 's1', 'Fa0/1');
  t.connect('a', 'eth0', 's1', 'Fa0/2');
  const sim = new Simulator(t);
  const S = {};
  const c = function (id) { if (!S[id]) S[id] = new CliSession(t.getDevice(id), t, sim); return S[id]; };
  const cfg = function (id, lines) {
    c(id).run('configure terminal'); lines.forEach(function (l) { c(id).run(l); }); c(id).run('end');
  };
  cfg('r1', ['interface ' + ports(t, 'r1')[1], 'ip address 10.1.1.1 255.255.255.0', 'no shutdown']);
  cfg('a', ['interface eth0', 'ip address 10.1.1.5 255.255.255.0', 'exit',
    'ip default-gateway ' + (gateway || '10.1.1.1')]);
  return { t: t, sim: sim, c: c, cfg: cfg };
}

console.log('');
console.log('The host had a route; the gateway did not:');
{
  const L = gatewayLab();
  const route = L.c('a').run('show ip route').output;
  ok(route.some(function (l) { return /S\*\s+0\.0\.0\.0/.test(l); }),
    'the host prints a default route, so `no route to` is false about the host', route.join(' | '));
  const p = L.sim.ping('a', '10.9.9.9', { count: 1 });
  const why = String(p.replies[0].reason);
  ok(/^no route to 10\.9\.9\.9/.test(why), 'the reason is the drop the gateway recorded', why);
  ok(/\(dropped by r1\)$/.test(why), 'and it names the box that recorded it', why);
  ok(why.indexOf('dropped by a') === -1, 'the host is not blamed for a drop it did not make', why);
}

console.log('');
console.log('The gateway\u2019s own view of the same drop stays local:');
{
  const L = gatewayLab();
  L.sim.ping('a', '10.9.9.9', { count: 1 });
  const counters = L.c('r1').run('show interfaces ' + ports(L.t, 'r1')[1]).output.join('\n');
  ok(/device-wide 1 drop \(no route to 10\.9\.9\.9\)/.test(counters),
    'the dropping box counts it in its own words', counters.split('\n').filter(function (l) { return /drop/.test(l); })[0]);
  ok(counters.indexOf('dropped by') === -1, 'and does not name itself: on this console it *is* the box', counters);
}

console.log('');
console.log('A drop at the source is still a statement about the source:');
{
  const L = gatewayLab();
  L.c('a').run('configure terminal'); L.c('a').run('no ip default-gateway 10.1.1.1'); L.c('a').run('end');
  const route = L.c('a').run('show ip route').output.join('\n');
  ok(route.indexOf('S*') === -1, 'the host has no default route any more', route);
  const why = String(L.sim.ping('a', '10.9.9.9', { count: 1 }).replies[0].reason);
  ok(/^no route to 10\.9\.9\.9$/.test(why), 'so the reason carries no box: it is about this one', why);
  ok(why.indexOf('dropped by') === -1, 'nothing appended', why);
}

console.log('');
console.log('A switch that refuses the frame is named too, and named once:');
{
  const t = new Topology();
  t.addDevice(SWITCH, 's1'); t.addDevice(SWITCH, 's2'); t.addDevice(PC, 'a'); t.addDevice(PC, 'b');
  t.connect('s1', 'Fa0/1', 's2', 'Fa0/1');
  t.connect('a', 'eth0', 's1', 'Fa0/2');
  t.connect('b', 'eth0', 's2', 'Fa0/2');
  const sim = new Simulator(t);
  const S = {};
  const c = function (id) { if (!S[id]) S[id] = new CliSession(t.getDevice(id), t, sim); return S[id]; };
  const cfg = function (id, lines) {
    c(id).run('configure terminal'); lines.forEach(function (l) { c(id).run(l); }); c(id).run('end');
  };
  cfg('a', ['interface eth0', 'ip address 10.5.0.1 255.255.255.0']);
  cfg('b', ['interface eth0', 'ip address 10.5.0.2 255.255.255.0']);
  cfg('s2', ['interface Fa0/1', 'switchport mode trunk', 'switchport trunk native vlan 20']);
  const why = String(sim.ping('a', '10.5.0.2', { count: 1 }).replies[0].reason);
  ok(/switchport mismatch/.test(why), 'the frame died on the mismatch', why);
  ok(/\(dropped by s2\)$/.test(why), 'and the far switch, not the near one, is named', why);
  ok(why.split('dropped by').length === 2, 'exactly once', why);
}

console.log('');
console.log('The other door that reports a dead path uses the same words:');
{
  const L = gatewayLab();
  const flow = L.sim.openFlow({
    srcDevice: 'a', srcIp: '10.1.1.5', dstIp: '10.9.9.9', dstPort: 443, proto: 'tcp'
  });
  ok(flow && flow.code === 'E_NO_ROUTE', 'opening a flow to the unreachable address fails as E_NO_ROUTE',
    flow && JSON.stringify({ code: flow.code, reason: flow.reason }));
  ok(/\(dropped by r1\)$/.test(String(flow.reason)), 'and names the gateway that had no route', flow.reason);
}

console.log('');
console.log('A successful run has no reason to explain:');
{
  const L = gatewayLab();
  const p = L.sim.ping('a', '10.1.1.1', { count: 2 });
  ok(p.replies.every(function (r) { return r.success; }), 'the gateway itself answers',
    JSON.stringify(p.replies.map(function (r) { return r.success || r.reason; })));
  ok(p.replies.every(function (r) { return r.reason === null; }), 'and no reason is invented for a reply');
}

console.log('');
console.log('The suffix never changes the ranking of causes:');
{
  // A shut port at the source and an unreachable gateway are both true here; the local shut port is the earlier cause
  // and must still win, because a frame that never left never reached the gateway at all.
  const L = gatewayLab();
  L.c('a').run('configure terminal'); L.c('a').run('interface eth0'); L.c('a').run('shutdown'); L.c('a').run('end');
  const why = String(L.sim.ping('a', '10.9.9.9', { count: 1 }).replies[0].reason);
  ok(/shut|administratively down|no route to/.test(why), 'a cause is named', why);
  ok(/dropped by r1/.test(why) === false, 'and the gateway is not blamed for a frame that never left the host', why);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
