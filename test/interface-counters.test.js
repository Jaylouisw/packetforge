'use strict';
// `show interfaces` has to answer "is anything crossing this port" (#1251).
//
// The simulator has counted traffic per device for a long time, and the command printed none of it - so the
// one table an operator opens to find out whether a link is carrying traffic answered with the topology and
// the link state and nothing about traffic. There were two defects stacked:
//
//   1. the counts were per device, so no per-port answer existed to print;
//   2. both counting sites were guarded by `if (frame.l4)`, and an ICMP echo or an ARP frame carries
//      `icmp` / `arp` instead of `l4`. Ping - the traffic a packet simulator is used for - was therefore
//      never counted at all.
//
// So a port could answer twenty pings and be reported as having carried nothing.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');
const flow = require('../engine/flow');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.filter(function (s) { return /ASR 1001-X/.test(s.model); })[0];
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];
const PC = catalog.filter(function (s) { return s.model === 'generic-pc'; })[0];
const eth = function (d) {
  return [...d.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
};

// pc -- sw -- r1, with a second pc on another switch port that is never talked to.
function lab() {
  const t = new Topology();
  const r = t.addDevice(ROUTER, 'r1');
  const sw = t.addDevice(SWITCH, 'sw');
  const pc = t.addDevice(PC, 'pc');
  const quiet = t.addDevice(PC, 'quiet');
  t.connect('r1', eth(r)[0].name, 'sw', 'Fa0/1');
  t.connect('pc', 'eth0', 'sw', 'Fa0/2');
  t.connect('quiet', 'eth0', 'sw', 'Fa0/4');
  const sim = new Simulator(t);
  runCommands(r, t, sim, ['configure terminal', 'interface ' + eth(r)[0].name,
    'ip address 10.0.0.1 255.255.255.0', 'end']);
  runCommands(pc, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.0.9 255.255.255.0', 'ip default-gateway 10.0.0.1', 'end']);
  runCommands(quiet, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.0.10 255.255.255.0', 'end']);
  return { t: t, sim: sim, r: r, sw: sw, pc: pc, quiet: quiet };
}

function show(env, dev) {
  return ((new CliSession(dev, env.t, env.sim).run('show interfaces').output) || []).map(String);
}

// The two counter lines for one port, or null if the block does not carry them.
function countersFor(lines, portName) {
  const at = lines.findIndex(function (l) { return l.indexOf(portName + ' (') === 0; });
  if (at < 0) return null;
  const block = [];
  for (let i = at + 1; i < lines.length; i++) {
    if (/^[^ ]/.test(lines[i])) break;
    block.push(lines[i]);
  }
  const pin = block.filter(function (l) { return /packets input/.test(l); })[0] || '';
  const pout = block.filter(function (l) { return /packets output/.test(l); })[0] || '';
  const num = function (s) { const m = /(\d+)/.exec(s || ''); return m ? Number(m[1]) : null; };
  return { input: num(pin), output: num(pout), lines: block };
}

console.log('');
console.log('A ping is counted, on the ports it crossed:');
{
  const env = lab();
  const before = env.sim.portCounters('r1', eth(env.r)[0].name);
  ok(before && before.packetsIn === 0 && before.packetsOut === 0,
    'a port with no traffic reads zero, not "unknown"', JSON.stringify(before));

  const res = env.sim.ping('pc', '10.0.0.1', { count: 3 });
  ok(res.replies.every(function (x) { return x.success; }), 'three pings are answered');

  const port = eth(env.r)[0].name;
  const tally = env.sim.portCounters('r1', port);
  ok(tally && tally.packetsIn >= 3, 'the router\'s port counted the requests it received',
    JSON.stringify(tally));
  ok(tally && tally.packetsOut >= 3, 'and the replies it sent', JSON.stringify(tally));
  ok(tally && tally.bytesIn > 0, 'with bytes, not just packets', JSON.stringify(tally));

  const shown = countersFor(show(env, env.r), port);
  ok(shown && shown.input >= 3, 'and show interfaces prints them', shown && JSON.stringify(shown.lines));
  ok(shown && shown.output >= 3, 'on both directions', shown && JSON.stringify(shown.lines));

  // Two accountings, and they have to reconcile: the per-port *transport* tallies are the device's flow
  // totals, while the per-port totals also include the control frames (ARP, LLDP) that cross a socket -
  // which is why a flow's byte count must not move when a switch sends an LLDP frame.
  const total = env.sim.counters['r1'];
  const ports = Object.keys(total.ports || {});
  const sumTransportIn = ports.reduce(function (a, p) { return a + total.ports[p].transportPacketsIn; }, 0);
  const sumAllIn = ports.reduce(function (a, p) { return a + total.ports[p].packetsIn; }, 0);
  ok(sumTransportIn === total.packetsIn, 'the per-port transport tallies are the device flow totals',
    JSON.stringify({ ports: sumTransportIn, device: total.packetsIn }));
  ok(sumAllIn > sumTransportIn, 'and the interface totals also count the control frames (' +
    sumAllIn + ' vs ' + sumTransportIn + ')', JSON.stringify({ all: sumAllIn, transport: sumTransportIn }));
}

console.log('');
console.log('A port that carried nothing says zero, and the one beside it does not:');
{
  const env = lab();
  env.sim.ping('pc', '10.0.0.1', { count: 2 });

  const busy = countersFor(show(env, env.r), eth(env.r)[0].name);
  const idle = countersFor(show(env, env.r), eth(env.r)[1].name);
  ok(busy && busy.input > 0, 'the port on the path counted traffic', busy && String(busy.input));
  ok(idle && idle.input === 0 && idle.output === 0,
    'the uncabled port beside it counted none', idle && JSON.stringify(idle.lines));

  // The quiet host is never addressed, but broadcast traffic is flooded to it - ARP for the gateway and
  // the switches' LLDP - so its port is NOT at zero. That is the honest answer, and it is the reason the
  // per-port tally matters: the point is not "nothing" but "nothing of yours".
  const quiet = countersFor(show(env, env.quiet), 'eth0');
  ok(quiet && quiet.input > 0, 'a host nobody addressed still counts the broadcasts it received',
    quiet && JSON.stringify(quiet.lines));

  // What it did not receive: a single echo. Counted from the frame log, not from the byte total.
  const echoesToQuiet = env.sim.events.filter(function (e) {
    return e.type === 'frame' && e.to === 'quiet';
  }).filter(function (e) {
    return e.frame && e.frame.icmp;
  }).length;
  ok(echoesToQuiet === 0, 'and carried no echo payload at all', String(echoesToQuiet));
  ok(!/0 bytes/.test((quiet && quiet.lines || []).join(' ')),
    'no counted packet reports zero bytes', quiet && JSON.stringify(quiet.lines));

  // Volume, not just presence: the addressed host carried strictly more than the quiet one.
  const busyHost = countersFor(show(env, env.pc), 'eth0');
  ok(busyHost && busyHost.input > quiet.input, 'while the host being pinged carried more (' +
    (busyHost && busyHost.input) + ' vs ' + (quiet && quiet.input) + ')');

  const uplink = countersFor(show(env, env.sw), 'Fa0/1');
  ok(uplink && uplink.input > 0, 'and the switch port facing the router counted', uplink && String(uplink.input));
}

console.log('');
console.log('A frame that was dropped after arrival still counts as received:');
{
  const env = lab();
  // An ACL that throws the ping away: the frame arrives, is denied, and never leaves.
  runCommands(env.r, env.t, env.sim, ['configure terminal',
    'access-list 101 deny icmp any any', 'access-list 101 permit ip any any',
    'interface ' + eth(env.r)[0].name, 'ip access-group 101 in', 'end']);
  const res = env.sim.ping('pc', '10.0.0.1', { count: 2 });
  ok(res.replies.every(function (x) { return !x.success; }), 'the ping gets no reply');

  const tally = env.sim.portCounters('r1', eth(env.r)[0].name);
  ok(tally && tally.packetsIn > 0, 'but the ingress counter moved, as a real one does',
    JSON.stringify(tally));
  ok(tally && tally.bytesIn >= 2 * 56, 'counting the echoes it received before denying them',
    JSON.stringify(tally));
  // What left the port was ARP and LLDP, not a reply - counted from the frame log, because the byte
  // total alone cannot tell an echo from a discovery frame.
  const echoesOut = env.sim.events.filter(function (e) {
    return e.type === 'frame' && e.from === 'r1' && e.frame && e.frame.icmp &&
      e.frame.icmp.type === 0;                                  // ICMP echo reply
  }).length;
  ok(echoesOut === 0, 'and no echo reply was sent back', String(echoesOut));
}

console.log('');
console.log('Frame sizes are counted for every builder, not just transport:');
{
  // The unit the counters use, stated once: transport payload, echo payload, or ARP's 28 bytes.
  ok(flow.frameBytes({ l4: { bytes: 100 } }) === 100, 'a transport frame counts its payload');
  ok(flow.frameBytes({ icmp: { type: 8, code: 0, id: 1, seq: 1 } }) === 56,
    'an echo counts the echo payload', String(flow.frameBytes({ icmp: {} })));
  ok(flow.frameBytes({ arp: { op: 'request' } }) === 28, 'an ARP frame counts 28 bytes');
  ok(flow.frameBytes({}) === 0, 'and a frame that carries nothing counts nothing');
  ok(flow.frameBytes(null) === 0, 'as does no frame at all');

  // The property: a ping on a quiet lab moves bytes equal to its payload, not zero.
  const env = lab();
  const port = eth(env.r)[0].name;
  env.sim.ping('pc', '10.0.0.1', { count: 1 });
  const tally = env.sim.portCounters('r1', port);
  ok(tally && tally.bytesIn >= 56, 'one ping moved at least one echo payload', JSON.stringify(tally));
}

console.log('');
console.log('Counters accumulate over runs, like real interface counters:');
{
  const env = lab();
  const port = eth(env.r)[0].name;
  env.sim.ping('pc', '10.0.0.1', { count: 1 });
  const first = env.sim.portCounters('r1', port).packetsIn;
  env.sim.ping('pc', '10.0.0.1', { count: 1 });
  const second = env.sim.portCounters('r1', port).packetsIn;
  ok(second > first, 'a second run adds to the first (' + first + ' -> ' + second + ')',
    JSON.stringify({ first: first, second: second }));
}

console.log('');
console.log('With no simulation run, the command says so instead of printing zeros:');
{
  const env = lab();
  const lines = ((new CliSession(env.r, env.t, null).run('show interfaces ' + eth(env.r)[0].name).output) || [])
    .map(String);
  ok(lines.some(function (l) { return /counters: not measured/.test(l); }),
    'the block says counters were not measured', lines.join(' | '));
  ok(!lines.some(function (l) { return /^  0 packets input/.test(l); }),
    'and does not claim the port carried nothing', lines.join(' | '));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
