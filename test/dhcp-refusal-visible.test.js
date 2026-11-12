'use strict';
// The DHCP request that was answered with nothing, and the three views that all said nothing (#1453).
//
// The engine has recorded every failed exchange since the exchange was written - `phase: 'failed'` with a reason
// (`no-server`, `no-pool`, `pool-exhausted`, `nak`) and a sentence saying what went wrong - and nothing could read it.
// So an operator whose host had no address had three views that were each individually true and collectively useless:
//
//   * `show ip dhcp binding` listed only the successes, so the table looked complete;
//   * `show ip dhcp pool` said `In use: 2 of 2 address(es)`, which is what a pool nobody has asked also says;
//   * the host's own `show interfaces eth0` said `ip: unassigned`, which is what a host with DHCP switched off says.
//
// A pool at capacity and a pool nobody asked are the same line. A request answered with silence is a different fact,
// and the reason for it was in the event log the whole time.
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
const ports = function (t, id) { return [...t.getDevice(id).interfaces.keys()]; };

// A LAN with a pool of exactly `cap` addresses and `hosts` clients asking for one.
function lan(cap, hosts, poolRange) {
  const t = new Topology();
  t.addDevice(ROUTER, 'r1'); t.addDevice(SWITCH, 's1');
  hosts.forEach(function (id) { t.addDevice(PC, id); });
  t.connect('r1', ports(t, 'r1')[1], 's1', 'Fa0/1');
  hosts.forEach(function (id, i) { t.connect(id, 'eth0', 's1', 'Fa0/' + (i + 2)); });
  const sim = new Simulator(t);
  const S = {};
  const c = function (id) { if (!S[id]) S[id] = new CliSession(t.getDevice(id), t, sim); return S[id]; };
  const cfg = function (id, lines) {
    c(id).run('configure terminal'); lines.forEach(function (l) { c(id).run(l); }); c(id).run('end');
  };
  const range = poolRange || ('range 10.20.0.10 10.20.0.' + (10 + cap - 1));
  cfg('r1', ['interface ' + ports(t, 'r1')[1], 'ip address 10.20.0.1 255.255.255.0', 'no shutdown',
    'ip dhcp pool LAN', 'network 10.20.0.0 255.255.255.0', 'default-router 10.20.0.1', range, 'exit']);
  hosts.forEach(function (id) { cfg(id, ['interface eth0', 'ip address dhcp']); });
  return { t: t, sim: sim, c: c, cfg: cfg };
}
const ask = function (L, ids) { ids.forEach(function (id) { L.sim.ping(id, '10.20.0.1', { count: 1 }); }); };
const run = function (L, id, cmd) { return L.c(id).run(cmd).output; };
const lineWith = function (lines, re) { return lines.filter(function (l) { return re.test(l); })[0] || ''; };

console.log('');
console.log('A pool of two addresses and three clients:');
const L = lan(2, ['a', 'b', 'c']);
ask(L, ['a', 'b', 'c']);
{
  const bindings = run(L, 'r1', 'show ip dhcp binding');
  ok(bindings.length >= 4, 'the binding table still lists the two leases', bindings.join(' | '));
  const refused = lineWith(bindings, /request\(s\) refused/);
  ok(refused !== '', 'and now says that a request was refused', bindings.join(' | '));
  ok(/^1 request\(s\) refused:/.test(refused), 'the count is one', refused);
  ok(/pool LAN has no address left to offer/.test(refused), 'with the engine\u2019s own sentence for the reason', refused);
  ok(/02:00:00:00:04:00/.test(refused), 'and the client that was turned away', refused);
    // The count is what this check is about, not the wording: this lab sets no clock, so the summary counts
  // bindings rather than lease states (#1465) - the same two leases, described honestly.
  const summary = lineWith(bindings, /binding\(s\)/);
  ok(/^2 (active )?binding\(s\)/.test(summary), 'the count of live leases is unchanged', summary);
}

console.log('');
console.log('The pool it happened in says so too:');
{
  const pools = run(L, 'r1', 'show ip dhcp pool');
  const inUse = lineWith(pools, /In use:/);
  ok(/2 of 2 address\(es\)/.test(inUse), 'the pool is at capacity', inUse);
  const refused = lineWith(pools, /Refused:/);
  ok(refused !== '', 'and carries a Refused line, which capacity alone did not tell a reader', pools.join(' | '));
  ok(/1 request\(s\)/.test(refused) && /pool LAN has no address left to offer/.test(refused),
    'with the same sentence the binding table gave', refused);
  ok(run(L, 'r1', 'show ip dhcp pool LAN').join('\n').indexOf('Refused:') !== -1,
    'the named form of the view says it as well');
}

console.log('');
console.log('The client that got nothing says why, instead of just "unassigned":');
{
  const iface = run(L, 'c', 'show interfaces eth0');
  ok(/ip: unassigned \(dhcp\)/.test(iface.join('\n')), 'the address is still unassigned', iface.join(' | '));
  const dhcp = lineWith(iface, /^\s+dhcp:/);
  ok(dhcp !== '', 'and a dhcp line explains it', iface.join(' | '));
  ok(/no address/.test(dhcp), 'saying no address arrived', dhcp);
  ok(/pool LAN has no address left to offer/.test(dhcp), 'naming the reason the engine recorded', dhcp);
  ok(/from ISR 4331 branch router-r1/.test(dhcp), 'and the server that stayed silent', dhcp);
  ok(/step 0/.test(dhcp), 'and the instant it happened', dhcp);
}

console.log('');
console.log('One sentence, three views: they cannot describe the failure differently:');
{
  const detail = 'pool LAN has no address left to offer';
  const binding = lineWith(run(L, 'r1', 'show ip dhcp binding'), /request\(s\) refused/);
  const pool = lineWith(run(L, 'r1', 'show ip dhcp pool'), /Refused:/);
  const client = lineWith(run(L, 'c', 'show interfaces eth0'), /^\s+dhcp:/);
  ok(binding.indexOf(detail) !== -1 && pool.indexOf(detail) !== -1 && client.indexOf(detail) !== -1,
    'all three carry the engine\u2019s own sentence, verbatim',
    JSON.stringify({ binding: binding, pool: pool, client: client }));
  const events = (L.sim.events || []).filter(function (e) { return e.type === 'dhcp' && e.phase === 'failed'; });
  ok(events.length === 1, 'the log holds exactly one failed exchange', String(events.length));
  ok(events[0].detail === detail, 'and it is where all three read it from', events[0].detail);
}

console.log('');
console.log('A client that did get an address has nothing to explain:');
{
  ['a', 'b'].forEach(function (id) {
    const out = run(L, id, 'show interfaces eth0').join('\n');
    ok(/ip: 10\.20\.0\.1[01]\/24 \(dhcp\)/.test(out), id + ' holds a lease', out.split('\n')[1]);
    ok(out.indexOf('dhcp:') === -1, id + ' has no dhcp failure line', out);
  });
}

console.log('');
console.log('A pool that does not cover the subnet: refused, with no lease to hide behind:');
{
  const t = new Topology();
  t.addDevice(ROUTER, 'r9'); t.addDevice(SWITCH, 's9'); t.addDevice(PC, 'z');
  t.connect('r9', ports(t, 'r9')[1], 's9', 'Fa0/1');
  t.connect('z', 'eth0', 's9', 'Fa0/2');
  const sim = new Simulator(t);
  const S = {};
  const c = function (id) { if (!S[id]) S[id] = new CliSession(t.getDevice(id), t, sim); return S[id]; };
  const cfg = function (id, lines) {
    c(id).run('configure terminal'); lines.forEach(function (l) { c(id).run(l); }); c(id).run('end');
  };
  cfg('r9', ['interface ' + ports(t, 'r9')[1], 'ip address 10.30.0.1 255.255.255.0', 'no shutdown',
    'ip dhcp pool OTHER', 'network 10.40.0.0 255.255.255.0', 'default-router 10.40.0.1',
    'range 10.40.0.10 10.40.0.20', 'exit']);
  cfg('z', ['interface eth0', 'ip address dhcp']);
  sim.ping('z', '10.30.0.1', { count: 1 });
  const bindings = c('r9').run('show ip dhcp binding').output;
  const none = lineWith(bindings, /no leases/);
  ok(/request\(s\) were refused, none granted/.test(none),
    '"nothing has asked" is not said when something did ask and was refused', none);
  ok(/in none of the server pools/.test(bindings.join('\n')),
    'and the sentence says which question was unanswerable', bindings.join(' | '));
  const client = lineWith(c('z').run('show interfaces eth0').output, /^\s+dhcp:/);
  ok(/in none of the server pools/.test(client) && /from ISR 4331 branch router-r9/.test(client),
    'the client says the same thing about the same server', client);
}

console.log('');
console.log('A lab where every client got an address keeps the old answers, word for word:');
{
  const clean = lan(4, ['a', 'b']);
  ask(clean, ['a', 'b']);
  const bindings = clean.c('r1').run('show ip dhcp binding').output.join('\n');
  ok(bindings.indexOf('refused') === -1, 'no refusal line in the binding table', bindings);
  const pools = clean.c('r1').run('show ip dhcp pool').output.join('\n');
  ok(pools.indexOf('Refused:') === -1, 'and none in the pool view', pools);
  ok(clean.c('a').run('show interfaces eth0').output.join('\n').indexOf('dhcp:') === -1,
    'and the clients have no line to explain');
  // A server nobody has asked still says exactly what it used to.
  const quiet = lan(4, []);
  ok(/no leases: nothing has asked this server for an address yet/.test(
    quiet.c('r1').run('show ip dhcp binding').output.join('\n')),
  'a server nobody has asked still says so', quiet.c('r1').run('show ip dhcp binding').output.join(' | '));
}

console.log('');
console.log('Nothing else about the DHCP views moved:');
{
  ok(/^% Usage: show ip dhcp/.test(run(L, 'r1', 'show ip dhcp nonsense')[0]),
    'a bad sub-command still prints the usage line', run(L, 'r1', 'show ip dhcp nonsense')[0]);
  ok(/^% This device is not a DHCP server/.test(run(L, 'a', 'show ip dhcp binding')[0]),
    'a client is still told it is not a server', run(L, 'a', 'show ip dhcp binding')[0]);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
