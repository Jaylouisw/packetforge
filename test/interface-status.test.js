'use strict';
// The interface status has to mean something (#1237).
//
// `show ip interface brief` used to answer one question - "did somebody shut this port" - and print the
// answer as if it were the status. A port with no cable, which is the commonest reason a lab does not
// work, therefore reported up/up in the table people copy into bug reports, and `show interfaces` printed
// `status: up` two lines above `peer: disconnected`.
//
// The load-bearing section is the last one: a port the table calls up must carry a packet, and a port it
// calls down must not. Anything else is a status that cannot be trusted.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
function spec(re) {
  const s = catalog.filter(function (x) { return re.test(x.model); })[0];
  if (!s) throw new Error('spec not found: ' + re);
  return s;
}
const ROUTER = spec(/ASR 1001-X/);

function ethPorts(dev) {
  return [...dev.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
}

// Two routers, cabled port to port, each with an address on the cabled port and on one spare port.
function lab() {
  const t = new Topology();
  const r1 = t.addDevice(ROUTER, 'r1');
  const r2 = t.addDevice(ROUTER, 'r2');
  const a = ethPorts(r1)[0], spare = ethPorts(r1)[1], b = ethPorts(r2)[0];
  const sim = new Simulator(t);
  runCommands(r1, t, sim, [
    'configure terminal',
    'interface ' + a.name, 'ip address 10.0.0.1 255.255.255.0',
    'interface ' + spare.name, 'ip address 10.0.1.1 255.255.255.0',
    'end'
  ]);
  runCommands(r2, t, sim, [
    'configure terminal',
    'interface ' + b.name, 'ip address 10.0.0.2 255.255.255.0',
    'end'
  ]);
  const link = t.connect('r1', a.name, 'r2', b.name);
  return { t: t, sim: sim, r1: r1, r2: r2, a: a, spare: spare, b: b, link: link };
}

function show(env, dev, cmd) {
  const cli = new CliSession(dev, env.t, env.sim);
  return ((cli.run(cmd).output) || []).map(String);
}

function briefRow(lines, portName) {
  return lines.filter(function (l) {
    return l.indexOf(portName) === 0 || new RegExp('^' + portName.replace(/[/]/g, '\\/') + '\\s').test(l);
  })[0] || '';
}

function pingOk(env) {
  const res = env.sim.ping('r1', '10.0.0.2', { count: 2 });
  return res.replies.every(function (r) { return r.success; });
}

console.log('');
console.log('A cabled, running port is up:');
{
  const env = lab();
  const lines = show(env, env.r1, 'show ip interface brief');
  const row = briefRow(lines, env.a.name);
  ok(/\bup\b/.test(row), 'the cabled port reads up', row);
  ok(/up\s*$/.test(row), 'and its protocol is up', row);
  ok(pingOk(env), 'and a ping crosses it - so the word means something');
  const peer = briefRow(show(env, env.r2, 'show ip interface brief'), env.b.name);
  ok(/\bup\b/.test(peer), 'the far end reads up too', peer);
}

console.log('');
console.log('A port with no cable is down, not up:');
{
  const env = lab();
  const lines = show(env, env.r1, 'show ip interface brief');
  const row = briefRow(lines, env.spare.name);
  ok(/down/.test(row), 'the unconnected port reads down', row);
  ok(!/up/.test(row), 'and not up anywhere in the row', row);
  ok(/down\s*$/.test(row), 'its protocol is down as well', row);
  ok(env.spare.peer === null, 'because there is no cable to it', JSON.stringify(env.spare.peer));

  // The address on that port is not reachable, which is the point: the row and the data plane agree.
  const res = env.sim.ping('r2', '10.0.1.1', { count: 2 });
  ok(res.replies.every(function (r) { return !r.success; }),
    'and nothing can reach the address configured on it', JSON.stringify(res.replies.map(function (r) { return r.success; })));
}

console.log('');
console.log('The far end being shut down is reported as that:');
{
  const env = lab();
  runCommands(env.r2, env.t, env.sim, ['configure terminal', 'interface ' + env.b.name, 'shutdown', 'end']);
  const lines = show(env, env.r1, 'show ip interface brief');
  const row = briefRow(lines, env.a.name);
  ok(/down/.test(row), 'the near port goes down when the far port is shut', row);
  ok(!/administratively down/.test(row), 'it is not administratively down - nobody shut it here', row);
  ok(!pingOk(env), 'and a ping across the link fails');

  const detail = show(env, env.r1, 'show interfaces').join('\n');
  ok(/peer shut down/.test(detail), 'show interfaces names the reason', detail.split('\n').slice(0, 6).join(' | '));

  const far = briefRow(show(env, env.r2, 'show ip interface brief'), env.b.name);
  ok(/administratively down/.test(far), 'while the port that was shut says so', far);
}

console.log('');
console.log('A port shut down here is administratively down:');
{
  const env = lab();
  runCommands(env.r1, env.t, env.sim, ['configure terminal', 'interface ' + env.a.name, 'shutdown', 'end']);
  const row = briefRow(show(env, env.r1, 'show ip interface brief'), env.a.name);
  ok(/administratively down/.test(row), 'the row says administratively down', row);
  ok(!pingOk(env), 'and the link carries nothing');
}

console.log('');
console.log('show interfaces no longer contradicts itself:');
{
  const env = lab();
  const lines = show(env, env.r1, 'show interfaces');
  const start = lines.findIndex(function (l) { return l.indexOf(env.spare.name + ' (') === 0; });
  ok(start !== -1, 'the unconnected port has a block');
  const block = lines.slice(start, start + 4);
  ok(/status: down \(no cable\)/.test(block[1] || ''), 'its status names the reason', block[1]);
  ok(/protocol: down/.test(block[1] || ''), 'and the protocol', block[1]);
  ok(!/status: up/.test(block.join('\n')), 'it does not claim to be up anywhere in the block', block.join(' | '));
  ok(/peer: disconnected/.test(block.join('\n')), 'while the peer line still says disconnected - agreeably');
}

console.log('');
console.log('A device outside a topology keeps its old answer:');
{
  // A bare device has no cables to know about, so inventing "down" for every port would be a different
  // lie. This is the documented limit of the command, and it is asserted so it stays a decision.
  const t = new Topology();
  const lone = t.addDevice(ROUTER, 'solo');
  const cli = new CliSession(lone, null, null);
  const lines = ((cli.run('show ip interface brief').output) || []).map(String);
  const row = briefRow(lines, ethPorts(lone)[0].name);
  ok(/\bup\b/.test(row), 'without a topology the port still reads up', row);
  const withTopo = new CliSession(lone, t, null);
  const downRow = briefRow(((withTopo.run('show ip interface brief').output) || []).map(String), ethPorts(lone)[0].name);
  ok(/down/.test(downRow), 'but with one, and no cable, it reads down', downRow);
}

console.log('');
console.log('Status and data plane agree across the whole lab:');
{
  // The property, stated once: for every port on both routers, a port the table calls up is one whose
  // own side is enabled and whose peer is enabled, and a port it calls down fails at least one of those.
  const env = lab();
  runCommands(env.r2, env.t, env.sim, ['configure terminal', 'interface ' + ethPorts(env.r2)[1].name, 'shutdown', 'end']);
  const problems = [];
  for (const dev of [env.r1, env.r2]) {
    const lines = show(env, dev, 'show ip interface brief');
    for (const port of ethPorts(dev)) {
      const row = briefRow(lines, port.name);
      const saysUp = / up\s+up\s*$/.test(row);
      const canCarry = port.enabled && port.peer &&
        (function () {
          const pd = env.t.getDevice(port.peer.deviceId);
          const pp = pd && pd.interfaces.get(port.peer.iface);
          return !!(pp && pp.enabled);
        })();
      if (saysUp !== !!canCarry) {
        problems.push(dev.id + '/' + port.name + ': table says ' + (saysUp ? 'up' : 'down') +
          ', can carry = ' + !!canCarry);
      }
      // A wireless radio is exempt: its link is the radio, not a cable.
      if (port.type === 'wireless' && !canCarry && saysUp) problems.pop();
    }
  }
  ok(problems.length === 0, 'every port row matches whether that port can carry a frame',
    problems.slice(0, 4).join(' | '));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
