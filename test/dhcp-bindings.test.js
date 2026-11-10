'use strict';
// `show ip dhcp binding` / `show ip dhcp pool` - and the lease that never came back (#1373).
//
// DHCP was modelled end to end: pools, ranges, exclusions, reservations, lease times, renewals, expiry. The server
// keeps an allocation table (mac -> address, expiry) and nothing could read it - there was no `show ip dhcp` at
// all. So an operator could configure a pool and could not find out which addresses had been handed out, to whom,
// or when they come back.
//
// The same audit found the table never aged: nothing called expireLeases(), so a lapsed binding held its address
// for the life of the run and a small pool could be exhausted by clients that had long gone. Both are checked here.
const { loadCatalog } = require('../devices/registry');
const { Topology } = require('../engine/topology');
const { Simulator } = require('../engine/simulator');
const dhcp = require('../engine/dhcp');
const cliModule = require('../engine/cli');
const CliSession = cliModule.CliSession || cliModule;

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const ROOT = require('path').join(__dirname, '..');
const specs = loadCatalog(ROOT + '/devices').filter(function (s) { return !s.error; });
const ROUTER = specs.find(function (s) { return /^ISR 4331$/.test(s.model); }) ||
  specs.find(function (s) { return /ISR 4331/.test(s.model); });
const HOST = specs.find(function (s) {
  return /^(pc|host|endpoint|workstation)/i.test(s.category || '') && s.model;
}) || specs.find(function (s) { return /endpoint|host|PC/i.test((s.category || '') + s.model); });

const MAC_A = '02:00:00:00:00:0a';
const MAC_B = '02:00:00:00:00:0b';

function lab(poolCmds, opts) {
  opts = opts || {};
  const t = new Topology();
  t.addDevice(ROUTER, 'r1');
  t.addDevice(HOST, 'h1');
  t.addDevice(HOST, 'h2');
  const firstFree = function (id) {
    return Array.from(t.getDevice(id).interfaces.keys()).filter(function (n) {
      return !/^(mgmt|console|aux)/i.test(n);
    })[0];
  };
  t.connect('r1', 'Gi0/0/1', 'h1', firstFree('h1'), { mediaId: '1000base-t', speedMbps: 1000 });
  t.connect('r1', 'Gi0/0/2', 'h2', firstFree('h2'), { mediaId: '1000base-t', speedMbps: 1000 });
  const uplink = t.getDevice('r1').interfaces.get('Gi0/0/1');
  uplink.ip = '192.168.10.1'; uplink.mask = '255.255.255.0';
  const uplink2 = t.getDevice('r1').interfaces.get('Gi0/0/2');
  uplink2.ip = '192.168.10.1'; uplink2.mask = '255.255.255.0';

  const s = new CliSession(t.getDevice('r1'), t, null);
  ['enable', 'configure terminal'].concat(poolCmds || []).forEach(function (c) { s.run(c); });

  // The hosts ask; their MACs are pinned so the binding table is legible in a failure.
  t.getDevice('h1').interfaces.get(firstFree('h1')).mac = MAC_A;
  t.getDevice('h2').interfaces.get(firstFree('h2')).mac = MAC_B;
  if (!opts.onlyH2) t.getDevice('h1').interfaces.get(firstFree('h1')).dhcp = true;
  t.getDevice('h2').interfaces.get(firstFree('h2')).dhcp = true;
  return t;
}
function show(t, sim, cmd) {
  return ((new CliSession(t.getDevice('r1'), t, sim).run(cmd) || {}).output || []).join('\n');
}
const POOL = ['ip dhcp pool lan', 'network 192.168.10.0 255.255.255.0', 'default-router 192.168.10.1',
  'dns-server 1.1.1.1', 'range 192.168.10.100 192.168.10.110', 'lease 0 0 1', 'exit'];

console.log('');
console.log('A device that is not a server says so:');
{
  const t = lab([]);
  const none = show(t, null, 'show ip dhcp binding');
  ok(/not a DHCP server/.test(none), 'no pool means no binding table, and it says why', none);
  ok(/ip dhcp pool/.test(none), 'and names the command that would make it one');
  const pool = show(t, null, 'show ip dhcp pool');
  ok(/No DHCP pools configured/.test(pool), 'and the pool view agrees');
}

console.log('');
console.log('The pool view is the pool the server answers from:');
{
  const t = lab(['ip dhcp pool lan', 'network 192.168.10.0 255.255.255.0', 'default-router 192.168.10.1',
    'dns-server 1.1.1.1', 'range 192.168.10.100 192.168.10.110', 'lease 0 0 1',
    'host 192.168.10.105 aa:bb:cc:00:00:99', 'excluded-address 192.168.10.102', 'exit']);
  const text = show(t, null, 'show ip dhcp pool lan');
  ok(/Pool lan:/.test(text), 'the pool is named');
  ok(/192\.168\.10\.100 - 192\.168\.10\.110/.test(text), 'the range is printed as a range', text);
  ok(/192\.168\.10\.1$|192\.168\.10\.1/m.test(text), 'the default router is printed');
  ok(/1\.1\.1\.1/.test(text), 'the DNS server is printed');
  ok(/60s/.test(text), 'the lease time is the configured one, in seconds');
  ok(/192\.168\.10\.102/.test(text), 'the exclusion is printed');
  ok(/192\.168\.10\.105 \(aa:bb:cc:00:00:99\)/.test(text), 'the reservation is printed with its owner',
    text.split('\n').filter(function (l) { return /Reservations/.test(l); })[0]);

  // Capacity is counted the way allocation counts: 11 addresses, one excluded.
  const p = dhcp.normalizePool({ name: 'lan', network: '192.168.10.0', mask: '255.255.255.0',
    rangeStart: '192.168.10.100', rangeEnd: '192.168.10.110', gateway: '192.168.10.1', dns: ['1.1.1.1'],
    reservations: {}, excluded: [{ start: '192.168.10.102', end: '192.168.10.102' }], leaseSec: 60 });
  ok(dhcp.poolCapacity(p) === 10, 'capacity is 10: eleven addresses less the exclusion',
    String(dhcp.poolCapacity(p)));
  ok(/In use:\s+not measured/.test(text),
    'without a simulation it says the usage is not measured rather than 0 of 10',
    text.split('\n').slice(-2)[0]);

  const unknown = show(t, null, 'show ip dhcp pool nosuch');
  ok(/No DHCP pool named nosuch/.test(unknown), 'an unknown pool is named, not silently empty', unknown);
  ok(/lan/.test(unknown), 'and the pools that do exist are listed');
}

console.log('');
console.log('A reservation can be written in either order, and nonsense is refused where it is typed:');
{
  const t = lab(['ip dhcp pool lan', 'network 192.168.10.0 255.255.255.0',
    'default-router 192.168.10.1', 'range 192.168.10.100 192.168.10.110',
    'host 192.168.10.105 aa:bb:cc:00:00:99',
    'host aa:bb:cc:00:00:98 192.168.10.104', 'exit']);
  const res = t.getDevice('r1').config.dhcpPools[0].reservations;
  ok(res['aa:bb:cc:00:00:99'] === '192.168.10.105', 'address first, MAC second', JSON.stringify(res));
  ok(res['aa:bb:cc:00:00:98'] === '192.168.10.104',
    'MAC first, address second stores the same way round - not keyed by the address', JSON.stringify(res));
  ok(!Object.keys(res).some(function (k) { return /^\d/.test(k); }), 'no reservation is keyed by an address',
    JSON.stringify(res));

  const s = new CliSession(t.getDevice('r1'), t, null);
  s.run('enable'); s.run('configure terminal'); s.run('ip dhcp pool lan2');
  const bad = ((s.run('host 192.168.10.9 notamac') || {}).output || []).join(' ');
  ok(/% Not a reservation/.test(bad), 'a pair that is neither an address and a MAC is refused', bad);
  ok(/either order/.test(bad), 'and the refusal says both accepted orders');
  const lan2 = t.getDevice('r1').config.dhcpPools.filter(function (x) { return x.name === 'lan2'; })[0];
  ok(lan2 && !lan2.reservations, 'the refused reservation stored nothing', JSON.stringify(lan2 && lan2.reservations));
}

console.log('');
console.log('Bindings come from the engine, and match the clients:');
let t0, sim0;
{
  t0 = lab(POOL.concat(['exit']));
  sim0 = new Simulator(t0);
  sim0.runAtMs = 5000;
  sim0.computeDhcp();
  const bindings = sim0.dhcpBindings('r1');
  ok(bindings.length === 2, 'two hosts, two bindings', String(bindings.length));
  ok(bindings.every(function (b) { return b.pool === 'lan'; }), 'each names the pool it came from',
    JSON.stringify(bindings.map(function (b) { return b.pool; })));
  ok(bindings.every(function (b) { return b.leaseSec === 60; }), 'each carries the lease length');
  ok(bindings.every(function (b) { return b.state === 'active'; }), 'and is active at the instant asked');

  // Address order, and the same addresses the clients hold.
  ok(bindings[0].ip === '192.168.10.100' || bindings[0].ip === '192.168.10.101',
    'the table is in address order', bindings.map(function (b) { return b.ip; }).join(','));
  const h1 = t0.getDevice('h1');
  const held = Array.from(h1.interfaces.values()).filter(function (i) { return i.dhcpLease; })[0];
  ok(!!held, 'the client holds a lease');
  ok(bindings.some(function (b) { return b.ip === held.ip && b.mac === held.mac; }),
    "and the server's table lists it under the same MAC and address",
    JSON.stringify({ client: { ip: held.ip, mac: held.mac } }));

  const text = show(t0, sim0, 'show ip dhcp binding');
  ok(/IP address/.test(text) && /Pool/.test(text) && /Expires in/.test(text), 'the table has a header', text);
  ok(/192\.168\.10\.100/.test(text), 'the first binding is printed');
  ok(/lan/.test(text), 'with its pool');
  ok(/\b[0-9]{1,2}s\b/.test(text), 'and the time left, counted from the instant the lease was granted', text);
  ok(/2 active binding/.test(text), 'and a summary line');
}

console.log('');
console.log('Filters, and what they say when nothing matches:');
{
  const byMac = show(t0, sim0, 'show ip dhcp binding ' + MAC_A);
  ok(/192\.168\.10\.100|192\.168\.10\.101/.test(byMac), 'a binding can be asked for by MAC', byMac);
  ok(!/192\.168\.10\.10[0-9]\s+02:00:00:00:00:0b/.test(byMac), 'and it returns only that one client');
  const byIp = show(t0, sim0, 'show ip dhcp binding 192.168.10.101');
  ok(/192\.168\.10\.101/.test(byIp), 'and by address');
  const noMac = show(t0, sim0, 'show ip dhcp binding aa:bb:cc:dd:ee:ff');
  ok(/No binding for aa:bb:cc:dd:ee:ff/.test(noMac), 'an unknown MAC is reported, not an empty table', noMac);
  ok(/no lease is held by that MAC/.test(noMac), 'and the reason is spelled out');
  const noIp = show(t0, sim0, 'show ip dhcp binding 192.168.10.200');
  ok(/no lease holds that address/.test(noIp), 'an address nobody holds says exactly that', noIp);
}

console.log('');
console.log('A lease lapses, and the address comes back:');
{
  // One address in the pool, 60 second leases. h1 takes it and then stops asking; h2 asks much later and must get
  // the same address. Before the fix the binding was never expired, and h2 was refused for the life of the run.
  const t = lab(['ip dhcp pool tiny', 'network 192.168.10.0 255.255.255.0',
    'default-router 192.168.10.1', 'range 192.168.10.100 192.168.10.100', 'lease 0 0 1', 'exit']);
  const sim = new Simulator(t);
  sim.runAtMs = 1000;
  sim.computeDhcp();
  const first = sim.dhcpBindings('r1');
  ok(first.length === 1, 'h1 holds the only address', JSON.stringify(first));
  ok(first[0].leaseSec === 60, 'for a minute', String(first[0].leaseSec));

  // h1 stops asking (its port is shut, as if the machine were unplugged); h2 asks a hundred seconds later.
  t.getDevice('h1').interfaces.forEach(function (i) { i.dhcp = false; });
  sim.runAtMs = 101000;
  sim.computeDhcp();
  const later = sim.dhcpBindings('r1');
  ok(!later.some(function (b) { return b.mac === MAC_A; }),
    'the lapsed binding is gone from the table', JSON.stringify(later));
  ok(later.some(function (b) { return b.mac === MAC_B && b.ip === '192.168.10.100'; }),
    'and the freed address went to the other host', JSON.stringify(later));

  const text = show(t, sim, 'show ip dhcp binding');
  ok(/192\.168\.10\.100/.test(text) && /02:00:00:00:00:0b/.test(text), 'the console shows the new holder', text);
  ok(/active binding/.test(text), 'and counts it');
}

console.log('');
console.log('Nothing has run, and nothing is invented:');
{
  const t = lab(POOL.concat(['exit']));
  const text = show(t, null, 'show ip dhcp binding');
  ok(/no binding state has been evaluated yet/.test(text), 'without a simulation the console says so', text);
  const pool = show(t, null, 'show ip dhcp pool');
  ok(/not measured/.test(pool), 'and the pool view does not claim a usage figure it does not have', pool);
  const usage = show(t, null, 'show ip dhcp nonsense');
  ok(/Usage: show ip dhcp/.test(usage), 'an unknown subcommand gets the usage line', usage);
}

console.log('');
console.log('Reservations are marked, and a lapsed lease is still shown as lapsed:');
{
  const t = lab(['ip dhcp pool lan', 'network 192.168.10.0 255.255.255.0', 'default-router 192.168.10.1',
    'range 192.168.10.100 192.168.10.110', 'lease 0 0 1',
    'host 192.168.10.105 ' + MAC_A, 'exit']);
  const sim = new Simulator(t);
  sim.runAtMs = 1000;
  sim.computeDhcp();
  const text = show(t, sim, 'show ip dhcp binding');
  ok(/02:00:00:00:00:0a \(reserved\)/.test(text), 'a reserved address is marked as reserved', text);
  const reservedRow = text.split('\n').filter(function (l) { return /reserved/.test(l); })[0] || '';
  ok(/192\.168\.10\.105/.test(reservedRow), 'and the row holding it is the reserved address', reservedRow);
  // A lease table read at a later instant than the grant, without a re-run, marks the row lapsed rather than
  // dropping it - a table that forgets a row cannot explain why an address is unavailable.
  const rows = dhcp.leaseTable(sim._dhcpStates.get('r1'), 1000 + 3600);
  ok(rows.every(function (r) { return r.state === 'expired'; }), 'the table marks rows lapsed',
    JSON.stringify(rows));
  ok(rows.length === sim.dhcpBindings('r1').length, 'it does not silently forget them');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
