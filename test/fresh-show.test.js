'use strict';
// fresh-show.test.js — the answer must not depend on whether something else ran first.
//
// Found by asking a switch two questions in two orders:
//
//   SW1#show spanning-tree                     <- first command after power-on
//   No bridged ports: this device is not part of any L2 loop.
//
//   SW1#ping 10.0.0.1 count 1
//   SW1#show spanning-tree
//   Port   Role        State
//   1/1/1  designated  forwarding
//
// One command, two answers, and the false one drew a *conclusion* - "not part of any L2 loop" - from an
// empty table. The console answered from whatever state a previous command happened to leave behind, so
// the table described the history of the session rather than the lab. The same was true of
// `show lldp neighbors` (nothing had *delivered* an announcement yet) and of `show ip dhcp binding`
// (no client had asked, because asking only happened inside a ping).
//
// The rule these tests pin: a reader derives the control planes it displays, once, from the lab as it
// is now. The second half of the rule matters as much as the first - deriving is not free, because the
// DHCP exchange and the LLDP announcement are *events*, so a show that re-derived them on every
// keystroke would inflate the counters and the log with traffic nobody sent.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + (actual === expected ? '' : '\n      got: ' + JSON.stringify(actual) +
    '\n      want: ' + JSON.stringify(expected)));
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const model = (m) => {
  const s = catalog.find((x) => x.model === m);
  if (!s) throw new Error('missing model ' + m);
  return s;
};
const strip = (lines) => lines.filter((l) => !/^[^\s#>]+[#>]\s?/.test(l));

// A switch with three cabled ports, a router and a host, and nothing run yet.
function switchLab() {
  const t = new Topology();
  const sw = t.addDevice(model('CX 6000 24G CL4 PoE 4SFP 370W'));
  sw.name = 'SW1';
  const r1 = t.addDevice(model('generic-router'));
  r1.name = 'R1';
  const r2 = t.addDevice(model('generic-router'));
  r2.name = 'R2';
  const pc = t.addDevice(model('generic-pc'));
  pc.name = 'PC1';
  t.connect(r1.id, 'Gi0/0', sw.id, '1/1/1');
  t.connect(r2.id, 'Gi0/0', sw.id, '1/1/2');
  t.connect(pc.id, 'eth0', sw.id, '1/1/3');
  const sim = new Simulator(t);
  const s = new CliSession(sw, t, sim);
  s.run('enable');
  return { t, sim, s, sw, r1, r2, pc };
}

console.log('Spanning tree answers on a fresh lab, and says what it sees:');
{
  const env = switchLab();
  const fresh = strip(env.s.run('show spanning-tree').output).join('\n');
  ok(/1\/1\/1\s+designated\s+forwarding/.test(fresh), 'the first command lists the cabled ports');
  ok(/1\/1\/2\s+designated\s+forwarding/.test(fresh), 'every one of them, not just the first');
  ok(/1\/1\/3\s+designated\s+forwarding/.test(fresh), 'including the host port');
  ok(!/No bridged ports/.test(fresh), 'and no longer claims the switch is not bridging anything');
  ok(!/not part of any L2 loop/.test(fresh), 'nor concludes anything about loops from an empty table');
  // The port question has to agree with the table it names.
  const one = strip(env.s.run('show spanning-tree 1/1/1').output).join('\n');
  ok(/designated/.test(one) && /forwarding/.test(one), 'asking about one port answers with its role and state');
  ok(!/%/.test(one), 'and does not refuse a port the tree is running on');
  // Asking again changes nothing: the same question gets the same answer.
  eq(strip(env.s.run('show spanning-tree').output).join('\n'), fresh,
    'asking twice gives the identical answer');
}

console.log('\nA port that is not in the tree is still refused, and the refusal says why:');
{
  const env = switchLab();
  // 1/1/9 is a real port with no cable: the tree has nothing to say about it, and that is a refusal
  // about the port, not an empty table.
  const out = strip(env.s.run('show spanning-tree 1/1/9').output).join('\n');
  ok(/%/.test(out), 'a cabled-less port is refused');
  ok(/show spanning-tree/.test(out), 'and the refusal names the command that lists the ports in the tree');
}

console.log('\nLLDP is heard without a ping first, and is not announced twice:');
{
  const env = switchLab();
  const heard = strip(env.s.run('show lldp neighbors').output).join('\n');
  ok(/R1/.test(heard), 'the router is a neighbour on a fresh lab');
  ok(/R2/.test(heard), 'and so is the second router');
  ok(!/no LLDP has been heard/.test(heard), 'so the empty-table message is not printed');
  // Announcing is an event: a frame on the wire, counted. It must happen once, not once per keystroke.
  const counters1 = strip(env.s.run('show interfaces counters 1/1/1').output).join('\n');
  const again = strip(env.s.run('show lldp neighbors').output).join('\n');
  eq(again, heard, 'the second LLDP question gives the same answer');
  eq(strip(env.s.run('show interfaces counters 1/1/1').output).join('\n'), counters1,
    'and asking again sends no second announcement (the counters did not move)');
  // The counters are not zero either - the announcement really did happen exactly once.
  ok(/1\s+64/.test(counters1), 'the one announcement is counted: ' + (counters1.split('\n').filter((l) => /1\/1\/1/.test(l))[0] || ''));
}

console.log('\nThe DHCP binding exists because the client asked, not because a ping ran:');
{
  const t = new Topology();
  const srv = t.addDevice(model('generic-router'));
  srv.name = 'SRV';
  const pc = t.addDevice(model('generic-pc'));
  pc.name = 'PC1';
  t.connect(pc.id, 'eth0', srv.id, 'Gi0/0');
  const sim = new Simulator(t);
  const cfg = (dev, lines) => runCommands(dev, t, sim, ['configure terminal'].concat(lines));
  cfg(srv, ['interface Gi0/0', 'ip address 192.168.30.1 255.255.255.0', 'exit',
    'ip dhcp pool p', 'network 192.168.30.0 255.255.255.0', 'default-router 192.168.30.1',
    'range 192.168.30.100 192.168.30.110', 'exit']);
  cfg(pc, ['interface eth0', 'ip address dhcp']);
  const s = new CliSession(srv, t, sim);
  const out = strip(s.run('show ip dhcp binding').output).join('\n');
  ok(/192\.168\.30\.100/.test(out), 'the table lists the lease on the first ask');
  ok(!/\(none\)/.test(out), 'and is not empty');
}

console.log('\nThe console derives once per change, not once per question:');
{
  const env = switchLab();
  const first = strip(env.s.run('show spanning-tree').output).join('\n');
  ok(env.sim._planesDone === env.sim._planesRev, 'the planes are marked as derived for this revision');
  const rev = env.sim._planesRev;
  env.s.run('show spanning-tree');
  env.s.run('show ip interface brief');
  eq(env.sim._planesRev, rev, 'readers do not bump the revision');
  // A change makes them stale again, and the next reader derives them afresh.
  runCommands(env.sw, env.t, env.sim, ['configure terminal', 'interface 1/1/9', 'switchport access vlan 20', 'exit', 'exit']);
  ok(env.sim._planesRev > rev, 'a configuration command bumps the revision');
  const after = strip(env.s.run('show spanning-tree').output).join('\n');
  ok(/designated/.test(after), 'and the next show still answers from a derived tree');
  // A cable change is a change too - the tree is a function of the links.
  const upRev = env.sim._planesRev;
  const link = Array.from(env.t.links.values())[0];
  env.sim.setLinkState(link.id, 'down', { force: true });
  ok(env.sim._planesRev > upRev, 'so does a link state change');
  const down = strip(env.s.run('show spanning-tree').output).join('\n');
  ok(down.split('\n').length < after.split('\n').length, 'and the down link drops out of the table');
}

console.log('\nOSPF routes and adjacencies are there on the first question:');
{
  const t = new Topology();
  const a = t.addDevice(model('generic-router'));
  a.name = 'R1';
  const b = t.addDevice(model('generic-router'));
  b.name = 'R2';
  t.connect(a.id, 'Gi0/0', b.id, 'Gi0/0');
  const sim = new Simulator(t);
  const cfg = (dev, lines) => runCommands(dev, t, sim, ['configure terminal'].concat(lines));
  cfg(a, ['interface Gi0/0', 'ip address 10.0.5.1 255.255.255.0', 'no shutdown', 'ip ospf area 0',
    'exit', 'ospf router-id 1.1.1.1', 'exit']);
  cfg(b, ['interface Gi0/0', 'ip address 10.0.5.2 255.255.255.0', 'no shutdown', 'ip ospf area 0',
    'exit', 'interface Gi0/1', 'ip address 10.0.6.1 255.255.255.0', 'exit', 'ospf router-id 2.2.2.2', 'exit']);
  const s = new CliSession(a, t, sim);
  const neigh = strip(s.run('show ip ospf neighbor').output).join('\n');
  ok(/2\.2\.2\.2/.test(neigh), 'the neighbour is FULL on the first ask: ' +
    (neigh.split('\n').filter((l) => /2\.2\.2\.2/.test(l))[0] || ''));
  const routes = strip(s.run('show ip route').output).join('\n');
  ok(/10\.0\.6\.0\/24/.test(routes), 'and the route the neighbour advertised is already installed');
  ok(/^\s*\*\s+O\s+10\.0\.6\.0\/24/m.test(routes), 'marked as installed and as an OSPF route');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
