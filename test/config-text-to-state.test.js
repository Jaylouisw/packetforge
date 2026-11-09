'use strict';
// What the parser accepts has to be what the engine stores (#1281).
//
// The completeness census in `config-completeness.test.js` closes state -> text. This is the other direction:
// a command that is accepted and then stores something other than what was typed, or nothing at all.
//
// Measured before this suite:
//
//   ip route 10.9.0.0 255.255.0.0 Gi0        stored { gw: "Gi0", iface: null } - a port name in the
//                                            next-hop field, so the route ARPed for an address called "Gi0".
//                                            Listed, installed, printed, and unable to carry a packet, with
//                                            nothing anywhere saying why.
//   ip route 10.9.0.0 255.255.0.0 nonsense   stored the same way: any word was taken as a gateway.
//   ip address 10.0.0.1/24                   "% Incomplete command" - no address, and no hint that the form
//                                            is address-and-mask here.
//   ip dhcp pool / network 10.5.0.0/24       stored the string "10.5.0.0/24" as the network, which the
//                                            pool validator then rejects - so a spelling the usage line
//                                            itself advertises produced a pool that could not serve.
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
const ROUTER = catalog.filter(function (s) { return s.model === 'generic-router'; })[0];
const PC = catalog.filter(function (s) { return s.model === 'generic-pc'; })[0];

function ports(dev) {
  return [...dev.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
}

function build(spec) {
  const t = new Topology();
  const d = t.addDevice(spec || ROUTER, 'r1');
  return { t: t, d: d, sim: new Simulator(t), p: ports(d)[0].name };
}

function config(env) {
  return (((new CliSession(env.d, env.t, env.sim).run('show running-config').output) || [])
    .map(String)).join('\n');
}

// Drive the session directly rather than through runCommands: runCommands interleaves `prompt + command`
// echoes, and deciding which lines are echoes means guessing at prompt syntax - which failed on a refusal
// that contains angle brackets (`<network> <mask>`), because a '>' in the message looked like a prompt.
// CliSession.run() returns only what the device said.
function apply(env, cmds) {
  const s = new CliSession(env.d, env.t, env.sim);
  s.run('enable');
  s.run('configure terminal');
  const lines = [];
  for (const c of cmds.map(function (x) { return x.replace(/%P%/g, env.p); })) {
    for (const l of s.run(c).output) lines.push(String(l));
  }
  return lines.filter(function (l) { return l && l !== 'end'; });
}

function show(env, cmd) {
  return (((new CliSession(env.d, env.t, env.sim).run(cmd).output) || []).map(String)).join('\n');
}

console.log('');
console.log('A route out an interface is stored as an interface, not as a gateway:');
{
  const env = build();
  apply(env, ['interface %P%', 'ip address 10.0.0.1 255.255.255.0']);
  const msgs = apply(env, ['ip route 10.9.0.0 255.255.0.0 %P%']);
  const r = env.d.config.routes[0];
  ok(!!r, 'the route is stored', JSON.stringify(env.d.config.routes));
  ok(r && r.iface === env.p, 'the port is in the egress field', JSON.stringify(r));
  ok(r && r.gw === null, 'and the next-hop field is empty, not filled with a port name', JSON.stringify(r));

  // The consequence is stated where it is typed, and again where the route is read.
  ok(msgs.some(function (m) { return /no next hop/.test(m); }),
    'the console says the route has no next hop', JSON.stringify(msgs));
  ok(msgs.some(function (m) { return /proxy ARP/.test(m); }),
    'and what that requires on the far side', JSON.stringify(msgs));

  const table = show(env, 'show ip route');
  const row = table.split('\n').filter(function (l) { return /^S\s+10\.9\.0\.0/.test(l); })[0] || '';
  ok(!!row, 'the route appears in the table', table.split('\n').slice(0, 6).join(' | '));
  ok(/ARP for the destination/.test(row), 'and the row says why it may carry nothing', row);
}

console.log('');
console.log('A route that cannot work is refused rather than stored:');
{
  const cases = [
    ['ip route 10.9.0.0 255.255.0.0 nonsense', /neither a next-hop address nor an interface/,
      'a word that is neither an address nor a port'],
    ['ip route 10.9.0.0 255.255.0.0 %P% %P%', /is an interface, so it cannot also be followed by/,
      'a port and then something after it'],
    ['ip route 10.9.0.0 255.255.0.0 10.0.0.1 NoSuchPort', /no interface called "NoSuchPort"/,
      'a next hop followed by a port that does not exist'],
    ['ip route not-an-address 255.255.0.0 10.0.0.1', /Invalid destination/,
      'a destination that is not an address']
  ];
  for (const [cmd, expect, name] of cases) {
    const env = build();
    const msgs = apply(env, [cmd]);
    const said = msgs.filter(function (m) { return /^%/.test(m); })[0] || '';
    ok(expect.test(said), name + ': refused', said);
    ok((env.d.config.routes || []).length === 0, name + ': and nothing is stored',
      JSON.stringify(env.d.config.routes));
  }
}

console.log('');
console.log('All three route shapes survive a save and a restore:');
{
  const env = build();
  apply(env, ['interface %P%', 'ip address 10.0.0.1 255.255.255.0']);
  apply(env, ['ip route 10.9.0.0 255.255.0.0 %P%',
    'ip route 10.8.0.0 255.255.0.0 10.0.0.1 %P%',
    'ip route 10.7.0.0 255.255.0.0 10.0.0.1']);
  const printed = config(env);
  const lines = printed.split('\n').filter(function (l) { return /^ip route /.test(l); });
  ok(lines.length === 3, 'three routes are printed', JSON.stringify(lines));
  ok(lines.some(function (l) { return / 10\.9\.0\.0 255\.255\.0\.0 \S+$/.test(l); }),
    'including the interface-only form, with no empty field', JSON.stringify(lines));

  const fresh = build();
  const sess = new CliSession(fresh.d, fresh.t, fresh.sim);
  sess.run('enable');
  sess.run('configure terminal');
  const errs = [];
  for (const line of printed.split('\n')) {
    for (const l of sess.run(line).output) {
      if (/^%/.test(String(l))) errs.push(String(l));
    }
  }
  ok(errs.length === 0, 'and the printed config replays with nothing rejected', JSON.stringify(errs));
  ok(config(fresh) === printed, 'byte for byte', config(fresh) === printed ? '' : 'differs');
}

console.log('');
console.log('An address with a prefix length is answered, not brushed off:');
{
  const env = build();
  apply(env, ['interface %P%', 'ip address 10.0.0.1 255.255.255.0']);
  const msgs = apply(env, ['interface %P%', 'ip address 10.0.0.77/24']);
  const said = msgs.filter(function (m) { return /^%/.test(m); })[0] || '';
  ok(/10\.0\.0\.77\/24/.test(said), 'the refusal quotes what was typed', said);
  ok(/255\.255\.255\.0/.test(said), 'and shows the address-and-mask form', said);
  ok(/"ip address 10\.0\.0\.77 24"/.test(said), 'and the address-and-bits form', said);
  const iface = env.d.interfaces.get(env.p);
  ok(iface.ip === '10.0.0.1' && iface.mask === '255.255.255.0',
    'the previous address is left alone', JSON.stringify([iface.ip, iface.mask]));
}

console.log('');
console.log('A pool network has two spellings and one state:');
{
  const dotted = build();
  apply(dotted, ['ip dhcp pool P', 'network 10.5.0.0 255.255.255.0', 'range 10.5.0.10 10.5.0.20']);
  const slash = build();
  const msgs = apply(slash, ['ip dhcp pool P', 'network 10.5.0.0/24', 'range 10.5.0.10 10.5.0.20']);

  const a = dotted.d.config.dhcpPools[0];
  const b = slash.d.config.dhcpPools[0];
  ok(!msgs.some(function (m) { return /^%/.test(m); }), 'the /prefix spelling is accepted outright',
    JSON.stringify(msgs));
  ok(b.network === '10.5.0.0', 'the network is stored without the prefix on it', JSON.stringify(b.network));
  ok(b.mask === '255.255.255.0', 'and the prefix becomes a mask', JSON.stringify(b.mask));
  ok(JSON.stringify(a) === JSON.stringify(b), 'the two spellings produce identical state',
    JSON.stringify({ dotted: a, slash: b }));
  ok(config(dotted) === config(slash), 'and identical printed config');

  const bad = build();
  const badMsgs = apply(bad, ['ip dhcp pool P', 'network 10.5.0.0/33', 'range 10.5.0.10 10.5.0.20']);
  const said = badMsgs.filter(function (m) { return /^%/.test(m); })[0] || '';
  ok(/10\.5\.0\.0\/33/.test(said), 'an impossible prefix is refused, quoting it', said);
  ok(bad.d.config.dhcpPools[0].network == null, 'and no half-network is stored',
    JSON.stringify(bad.d.config.dhcpPools[0]));
}

console.log('');
console.log('The two forms behave the way the table says they do:');
{
  // A lab where the answer is unambiguous: r1 - r2 - pc, and a static route on r1 for the pc's LAN.
  function lab(routeCmd) {
    const t = new Topology();
    const r1 = t.addDevice(ROUTER, 'r1');
    const r2 = t.addDevice(ROUTER, 'r2');
    const pc = t.addDevice(PC, 'pc');
    const one = ports(r1)[0];
    const two = ports(r2);
    t.connect('r1', one.name, 'r2', two[0].name);
    t.connect('r2', two[1].name, 'pc', 'eth0');
    const sim = new Simulator(t);
    runCommands(r1, t, sim, ['configure terminal', 'interface ' + one.name,
      'ip address 10.0.0.1 255.255.255.0', 'end']);
    runCommands(r2, t, sim, ['configure terminal', 'interface ' + two[0].name,
      'ip address 10.0.0.2 255.255.255.0', 'interface ' + two[1].name,
      'ip address 192.168.9.1 255.255.255.0', 'end']);
    runCommands(pc, t, sim, ['configure terminal', 'interface eth0',
      'ip address 192.168.9.9 255.255.255.0', 'ip default-gateway 192.168.9.1', 'end']);
    runCommands(r1, t, sim, ['configure terminal'].concat(routeCmd.replace(/%P%/g, one.name).split(' && '))
      .concat(['end']));
    const ping = sim.ping('r1', '192.168.9.9', { count: 2 });
    return { env: { t: t, d: r1, sim: sim }, ping: ping, table: ((new CliSession(r1, t, sim)
      .run('show ip route').output) || []).map(String).join('\n') };
  }

  const viaHop = lab('ip route 192.168.9.0 255.255.255.0 10.0.0.2');
  ok(viaHop.ping.replies.every(function (x) { return x.success; }),
    'a route with a next hop carries the packet',
    viaHop.ping.replies.map(function (x) { return x.success; }).join(','));

  const viaPort = lab('ip route 192.168.9.0 255.255.255.0 %P%');
  ok(viaPort.ping.replies.every(function (x) { return !x.success; }),
    'a route out an interface alone does not: the box ARPs for the destination on its own wire',
    viaPort.ping.replies.map(function (x) { return x.success; }).join(','));
  ok(/no ARP reply from 192\.168\.9\.9/.test(String(viaPort.ping.replies[0] && viaPort.ping.replies[0].reason)),
    'and the failure names the address it could not resolve',
    String(viaPort.ping.replies[0] && viaPort.ping.replies[0].reason));
  ok(/ARP for the destination/.test(viaPort.table),
    'while the route table says so before the packet is even sent',
    viaPort.table.split('\n').filter(function (l) { return /^S\s/.test(l); }).join(' | '));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
