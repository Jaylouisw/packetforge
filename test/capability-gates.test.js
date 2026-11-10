'use strict';
// A capability is a promise about what a box can do with a packet (#1387).
//
// The catalogue declares them, the engine honours them in the data plane, and exactly one command refused
// configuration on a device that could not keep the promise (`ipv6 nd ra`). Everything else was accepted and then
// silently inert: a Raspberry Pi took `ip dhcp pool`, `ip route` and `ospf router-id`; a media converter took a
// static route; an L2-only switch took OSPF. Each command created an object nothing on that box could use, and the
// console said "created" / "added" / "enabled" while doing it.
//
// The gates are the five commands that make the same kind of promise: `ip route`, `ospf`, `ip nat`, `ip dhcp pool`
// and `vrrp`. Each refusal names the device, what it cannot do, and the capability it lacks - the words the RA gate
// already used.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { loadCatalog } = require('../devices/registry');
const cliModule = require('../engine/cli');
const CliSession = cliModule.CliSession || cliModule;

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const ROOT = path.join(__dirname, '..');
const catalog = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
const withCap = function (cap, without) {
  return catalog.filter(function (s) {
    const caps = s.capabilities || [];
    if (caps.indexOf(cap) === -1) return false;
    for (const c of (without || [])) if (caps.indexOf(c) !== -1) return false;
    return true;
  });
};

const HOST = catalog.find(function (s) { return /Raspberry Pi 5/.test(s.model); }) ||
  withCap('host', ['l3-forward', 'dhcp-server'])[0];
const SWITCH = (withCap('l2-forward', ['l3-forward']).filter(function (s) { return /CX 6000/.test(s.model); })[0]) ||
  withCap('l2-forward', ['l3-forward'])[0];
const L3SWITCH = withCap('l3-forward', []).filter(function (s) {
  return (s.capabilities || []).indexOf('l2-forward') !== -1;
})[0];
const ROUTER = catalog.find(function (s) { return /^ISR 4331$/.test(s.model); }) ||
  withCap('l3-forward', ['l2-forward']).filter(function (s) {
    return (s.capabilities || []).indexOf('nat') !== -1 && (s.capabilities || []).indexOf('dhcp-server') !== -1;
  })[0];

function session(spec) {
  const t = new Topology();
  t.addDevice(spec, 'd1');
  const sim = new Simulator(t);
  const dev = t.getDevice('d1');
  const cli = new CliSession(dev, t, sim);
  const firstPort = Array.from(dev.interfaces.keys()).filter(function (n) {
    return !/^(mgmt|console|aux)/i.test(n);
  })[0];
  return { t: t, sim: sim, dev: dev, cli: cli, port: firstPort };
}
// Run one command in global config mode and return its output as text.
function inConfig(s, cmd) {
  s.cli.run('enable');
  s.cli.run('configure terminal');
  const out = ((s.cli.run(cmd) || {}).output || []).join('\n');
  s.cli.run('end');
  return out;
}
function inIface(s, cmd) {
  s.cli.run('enable');
  s.cli.run('configure terminal');
  s.cli.run('interface ' + s.port);
  const out = ((s.cli.run(cmd) || {}).output || []).join('\n');
  s.cli.run('end');
  return out;
}
const REFUSAL = /% .+ cannot .+: it has no [a-z0-9-]+ capability/;

console.log('');
console.log('The catalogue has the boxes this test needs');
{
  ok(!!HOST && !(HOST.capabilities || []).includes('l3-forward'), 'a host that does not forward (' + (HOST && HOST.model) + ')');
  ok(!!SWITCH && !(SWITCH.capabilities || []).includes('l3-forward'), 'an L2-only switch (' + (SWITCH && SWITCH.model) + ')');
  ok(!!L3SWITCH, 'a switch that forwards too (' + (L3SWITCH && L3SWITCH.model) + ')');
  ok(!!ROUTER && (ROUTER.capabilities || []).includes('nat'), 'a router with nat (' + (ROUTER && ROUTER.model) + ')');
}

console.log('');
console.log('A box that cannot keep the promise is refused, and told why');
{
  const cases = [
    ['ip route 0.0.0.0 0.0.0.0 10.9.8.1', 'l3-forward', 'install a route'],
    ['ospf router-id 1.1.1.1', 'l3-forward', 'run OSPF'],
    ['ip nat pool np 203.0.113.1 203.0.113.5 netmask 255.255.255.0', 'nat', 'translate addresses'],
    ['ip dhcp pool p1', 'dhcp-server', 'serve DHCP']
  ];
  for (const [cmd, cap, consequence] of cases) {
    const s = session(HOST);
    const out = inConfig(s, cmd);
    ok(REFUSAL.test(out), 'a host is refused `' + cmd.split(' ').slice(0, 3).join(' ') + '`', out);
    ok(out.indexOf('it has no ' + cap + ' capability') !== -1, '  naming ' + cap, out);
    ok(out.indexOf('cannot ' + consequence) !== -1, '  and what it cannot do (' + consequence + ')', out);
    ok(out.indexOf(HOST.model) !== -1 || out.indexOf('d1') !== -1, '  and which device it is');
  }

  // VRRP is configured on an interface, so the refusal has to reach there too.
  const v = session(SWITCH);
  const vOut = inIface(v, 'vrrp 1 ip 10.9.8.254');
  ok(REFUSAL.test(vOut), 'a switch is refused a VRRP group', vOut);
  ok(/l3-forward/.test(vOut), 'naming l3-forward', vOut);

  // An L2-only switch is refused the same four.
  for (const [cmd] of cases) {
    const s = session(SWITCH);
    ok(REFUSAL.test(inConfig(s, cmd)), 'an L2-only switch is refused `' + cmd.split(' ').slice(0, 3).join(' ') + '`');
  }
}

console.log('');
console.log('A refused command changes nothing');
{
  const s = session(HOST);
  inConfig(s, 'ip dhcp pool p1');
  ok(!s.dev.config.dhcpPools || s.dev.config.dhcpPools.length === 0, 'no pool was created',
    JSON.stringify(s.dev.config.dhcpPools));
  inConfig(s, 'ip route 0.0.0.0 0.0.0.0 10.9.8.1');
  ok(!s.dev.config.routes || s.dev.config.routes.length === 0, 'no route was added',
    JSON.stringify(s.dev.config.routes));
  inConfig(s, 'ospf router-id 1.1.1.1');
  ok(!s.dev.config.ospf || !s.dev.config.ospf.routerId, 'OSPF stayed off', JSON.stringify(s.dev.config.ospf));
  inConfig(s, 'ip nat pool np 203.0.113.1 203.0.113.5 netmask 255.255.255.0');
  ok(!s.dev.config.nat || !(s.dev.config.nat.pools || []).length, 'no NAT pool was made',
    JSON.stringify(s.dev.config.nat));
  const sw = session(SWITCH);
  inIface(sw, 'vrrp 1 ip 10.9.8.254');
  ok(!(sw.dev.config.vrrp || []).length, 'no VRRP group was made', JSON.stringify(sw.dev.config.vrrp));
}

console.log('');
console.log('A box that can keep the promise is not refused');
{
  const r = session(ROUTER);
  const route = inConfig(r, 'ip route 0.0.0.0 0.0.0.0 10.9.8.1');
  ok(/Route added/.test(route), 'a router takes a route', route);
  ok(r.dev.config.routes.length === 1, 'and holds it');
  const ospf = inConfig(r, 'ospf router-id 1.1.1.1');
  ok(/OSPF enabled/.test(ospf), 'and takes OSPF', ospf);
  const pool = inConfig(r, 'ip dhcp pool p1');
  ok(/Created DHCP pool p1/.test(pool), 'and takes a DHCP pool', pool);
  const nat = inConfig(r, 'ip nat pool np 203.0.113.1 203.0.113.5 netmask 255.255.255.0');
  ok(/Pool np/.test(nat) || /created|Pool/i.test(nat) && !REFUSAL.test(nat), 'and takes a NAT pool', nat);

  const l3 = session(L3SWITCH);
  const l3route = inConfig(l3, 'ip route 10.9.9.0 255.255.255.0 10.9.8.1');
  ok(/Route added/.test(l3route), 'an L3 switch takes a route too', l3route);
}

console.log('');
console.log('What the console prints, the console reads back');
{
  // The round trip is what stops the gate becoming a lie in the other direction: a box that can hold a route still
  // prints it, and still accepts it back.
  const r = session(ROUTER);
  inConfig(r, 'ip route 0.0.0.0 0.0.0.0 10.9.8.1');
  r.cli.run('end');
  r.cli.run('enable');
  const printed = ((r.cli.run('show running-config') || {}).output || []).join('\n');
  ok(/ip route 0\.0\.0\.0 0\.0\.0\.0 10\.9\.8\.1/.test(printed), 'the route is printed', printed.split('\n').filter(function (l) { return /route/.test(l); }).join(' | '));

  const fresh = session(ROUTER);
  fresh.cli.run('enable'); fresh.cli.run('configure terminal');
  let replayed = '';
  for (const line of printed.split('\n')) {
    // Ordinary control flow, not an exemption: a blank line and a `!` comment are not commands to replay.
    if (!line.trim() || /^!/.test(line)) continue;
    replayed += ((fresh.cli.run(line) || {}).output || []).join('\n') + '\n';
  }
  fresh.cli.run('end');
  ok(!REFUSAL.test(replayed), 'and the box accepts it back without a refusal',
    replayed.split('\n').filter(function (l) { return /%/.test(l); }).join(' | '));
}

console.log('');
console.log('The other direction: switching commands on a box that does not switch');
{
  // The printer already knew this - `_switchportLine()` refuses to describe switchport state on a device without
  // l2-forward, because "the capability is what makes a port a switchport". The console did not, so a router
  // answered "Switchport mode trunk on Gi0" and then `show interfaces` printed nothing about it.
  for (const [label, spec] of [['a router', ROUTER], ['a host', HOST]]) {
    const s = session(spec);
    // The port starts with the engine's default `vlan` object; nothing below may change it.
    const before = JSON.stringify(s.dev.interfaces.get(s.port).vlan);
    for (const cmd of ['switchport mode trunk', 'switchport access vlan 10',
      'switchport trunk allowed vlan 10,20', 'no switchport', 'channel-group 1 mode active']) {
      const out = inIface(s, cmd);
      ok(REFUSAL.test(out), label + ' is refused `' + cmd + '`', out);
      ok(/l2-forward/.test(out), '  naming l2-forward', out);
    }
    const after = JSON.stringify(s.dev.interfaces.get(s.port).vlan);
    ok(after === before, 'and the port is exactly as it was', before + ' -> ' + after);
  }

  // A router is told what to do instead. A host is not: "this port routes" would be a second wrong statement.
  const r = session(ROUTER);
  ok(/this port routes: use `ip address/.test(inIface(r, 'switchport mode trunk')),
    'a router is pointed at `ip address`');
  const h = session(HOST);
  ok(!/this port routes/.test(inIface(h, 'switchport mode trunk')),
    'a host is given no routing advice it cannot use');

  // A switch keeps all of it, and so does a switch that also routes: l2-forward is the whole test.
  for (const [label, spec] of [['a switch', SWITCH], ['an L3 switch', L3SWITCH]]) {
    const s = session(spec);
    ok(/Switchport mode trunk/.test(inIface(s, 'switchport mode trunk')), label + ' still takes a trunk');
    ok(/allows VLANs/.test(inIface(s, 'switchport trunk allowed vlan 10,20')),
      label + ' still takes an allowed list');
    const vlan = s.dev.interfaces.get(s.port).vlan || {};
    ok(vlan.mode === 'trunk' && (vlan.allowedVlans || []).join(',') === '10,20',
      'and the configuration is stored', JSON.stringify(vlan));
  }

  // The command and the printer now say the same thing about the same port.
  const rr = session(ROUTER);
  inIface(rr, 'switchport mode trunk');
  rr.cli.run('end'); rr.cli.run('enable');
  const shown = ((rr.cli.run('show interfaces ' + rr.port) || {}).output || []).join('\n');
  ok(!/switchport:/.test(shown), 'a router prints no switchport line, as it never did', shown.slice(0, 120));
}

console.log('');
console.log('Every capability the gates name is a capability the catalogue actually declares');
{
  const declared = new Set();
  for (const s of catalog) for (const c of (s.capabilities || [])) declared.add(c);
  for (const cap of ['l3-forward', 'nat', 'dhcp-server']) {
    ok(declared.has(cap), 'the catalogue declares ' + cap);
    ok(withCap(cap, []).length > 0, 'and something has it (' + withCap(cap, []).length + ' models)');
  }
  ok(withCap('l3-forward', []).length < catalog.length,
    'and something does not, so the gate can fire at all',
    withCap('l3-forward', []).length + ' of ' + catalog.length);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
