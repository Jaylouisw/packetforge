'use strict';
// A backup has to carry the routing configuration (#1279).
//
// `show running-config` was complete for the features it had been taught about - VLANs, DHCP pools, DNS
// zones, ACLs, static routes, VRRP, switchport, speed/duplex - and blind to eight others that were
// configurable, stored, and printed nowhere:
//
//   ip name-server <ip>              config.dnsServers
//   scion <isd-as>                   config.scionAs
//   ospf router-id / ospf area       config.ospf
//   ip ospf cost|area|passive        config.ospf.interfaces[]
//   router bgp / bgp router-id /     config.bgp
//     neighbor <ip> remote-as <as>
//   ipv6 nd ra|suppress-ra|prefix    config.ra
//   ipv6 address <p>/<len>           config.ip6[iface]
//   ipv6 route / ipv6 gateway        config.routes6 / config.gateway6
//
// Measured: a router with BGP, OSPF, SCION, a name server and IPv6 RA policy printed a config containing
// none of it. Restoring that backup gives a different device - one that looks configured and is not.
//
// The existing "nothing configurable is left out" sweep could not catch this: it prints each device's
// config and reads it back, and a feature nobody configured in the sweep has nothing to be left out of.
// So this suite asserts the two things that do catch it:
//
//   1. every key in `device.config` is declared here, with how it is expected to print - a new piece of
//      state that nobody taught the printer fails the suite;
//   2. configuring a feature changes the printed text, and replaying that text into a fresh device
//      produces a byte-identical config.
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
const ROUTER = catalog.filter(function (s) { return /ASR 1001-X/.test(s.model); })[0];

function build(spec) {
  const t = new Topology();
  const d = t.addDevice(spec || ROUTER, 'r1');
  return { t: t, d: d, sim: new Simulator(t) };
}

function config(env) {
  return (((new CliSession(env.d, env.t, env.sim).run('show running-config').output) || [])
    .map(String)).join('\n');
}

function firstEthernet(dev) {
  return [...dev.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; })[0];
}

function apply(env, cmds) {
  const port = firstEthernet(env.d).name;
  const out = runCommands(env.d, env.t, env.sim, ['configure terminal'].concat(cmds.map(function (c) {
    return c.replace(/%P%/g, port);
  })).concat(['end']));
  return ((out && out.lines) || []).map(String).filter(function (l) { return /%/.test(l); });
}

// Replaying is the only real test of a printed line: the same text has to come back.
function replayInto(printed, spec) {
  const fresh = build(spec);
  const out = runCommands(fresh.d, fresh.t, fresh.sim,
    ['enable', 'configure terminal'].concat(printed.split('\n')).concat(['end']));
  return {
    env: fresh,
    errors: ((out && out.lines) || []).map(String).filter(function (l) { return /%/.test(l); })
  };
}

// Every key `device.config` can hold, and where it is expected to appear in the printed text. A key that is
// deliberately not printed must say so and why, so "forgot to print it" cannot hide behind "it is internal".
const KEY_PRINTS = {
  hostname: { re: /^hostname /m, why: 'the device name' },
  vlans: { re: /^vlan \d+/m, why: 'the VLAN table' },
  dhcpPools: { re: /^ip dhcp pool /m, why: 'DHCP pools' },
  dnsZones: { re: /^dns zone /m, why: 'DNS zones' },
  stpPriority: { re: /^spanning-tree priority \d+/m, why: 'the bridge priority that decides the STP root' },
  nat: { re: /^ip nat inside source /m, why: 'NAT rules and the pools they translate to' },
  dnsServers: { re: /^ip name-server /m, why: 'name servers' },
  acls: { re: /^access-list \d+/m, why: 'access lists' },
  routes: { re: /^ip route /m, why: 'static routes' },
  defaultGateway: { re: /^ip default-gateway /m, why: 'the default gateway' },
  scionAs: { re: /^scion /m, why: 'SCION membership' },
  ospf: { re: /^ospf router-id |^ospf area |^\s+ip ospf /m, why: 'OSPF' },
  bgp: { re: /^router bgp /m, why: 'BGP' },
  ra: { re: /^ipv6 nd /m, why: 'IPv6 router advertisements' },
  ip6: { re: /^\s+ipv6 address /m, why: 'IPv6 addresses' },
  routes6: { re: /^ipv6 route /m, why: 'IPv6 static routes' },
  gateway6: { re: /^ipv6 gateway /m, why: 'the IPv6 default gateway' },
  gateway6Iface: { not: true, why: 'derived at run time from the address the gateway was reached on' },
  lags: { re: /channel-group /m, why: 'link aggregation' },
  vrrp: { re: /vrrp \d+/m, why: 'VRRP groups' },
  motd: { not: true, why: 'no command sets it on this platform' }
};

console.log('');
console.log('Every piece of config state is declared as printable or deliberately not:');
{
  // Harvest the key set from a spread of device roles, so a key only a switch or only a host can hold is
  // included too.
  const keys = new Set();
  for (const model of ['generic-router', 'generic-switch', 'generic-pc']) {
    const spec = catalog.filter(function (s) { return s.model === model; })[0];
    if (!spec) continue;
    const env = build(spec);
    Object.keys(env.d.config).forEach(function (k) { keys.add(k); });
  }
  const undeclared = [...keys].filter(function (k) { return !KEY_PRINTS[k]; });
  ok(undeclared.length === 0,
    'no config key exists without a declared way to print it',
    undeclared.length ? 'undeclared: ' + undeclared.join(', ') + ' - add it to KEY_PRINTS' : JSON.stringify([...keys].sort()));
  ok(keys.size >= 15, 'and the harvest is big enough to mean something', String(keys.size) + ' keys');
}

console.log('');
console.log('Each of the eight was stored and printed nowhere - now each changes the text:');
{
  const cases = [
    ['name servers', ['ip name-server 10.0.0.9'], /^ip name-server 10\.0\.0\.9$/m],
    ['SCION membership', ['scion 1-ff00:0:110'], /^scion 1-ff00:0:110$/m],
    ['OSPF router-id and area', ['ospf router-id 1.1.1.1', 'ospf area 5'], /^ospf router-id 1\.1\.1\.1$/m],
    // The interface overrides need the OSPF process to exist first - which is why the printer emits
    // `ospf router-id` before the interface blocks, not after them.
    ['per-interface OSPF', ['ospf router-id 1.1.1.1', 'interface %P%', 'ip ospf cost 20', 'ip ospf area 5',
      'ip ospf passive'], /^\s+ip ospf cost 20$/m],
    ['BGP', ['router bgp 65001', 'bgp router-id 1.1.1.1', 'neighbor 10.0.0.2 remote-as 65002'],
      /^neighbor 10\.0\.0\.2 remote-as 65002$/m],
    ['IPv6 router advertisements', ['ipv6 nd ra enable', 'ipv6 nd prefix 2001:db8:1::/64'], /^ipv6 nd ra enable$/m],
    ['IPv6 addresses', ['interface %P%', 'ipv6 address 2001:db8:1::1/64'], /^\s+ipv6 address 2001:db8:1::1\/64$/m],
    ['IPv6 routes and gateway', ['ipv6 route 2001:db8:2::/64 2001:db8:1::2', 'ipv6 gateway 2001:db8:1::2'],
      /^ipv6 route 2001:db8:2::\/64 2001:db8:1::2$/m]
  ];
  for (const [name, cmds, re] of cases) {
    const env = build();
    const before = config(env);
    const errors = apply(env, cmds);
    const after = config(env);
    ok(errors.length === 0, name + ': the commands are accepted', JSON.stringify(errors));
    ok(after !== before, name + ': the config text changes');
    ok(re.test(after), name + ': and the printer prints it',
      after.split('\n').filter(function (l) { return /ospf|bgp|ipv6|scion|name-server/.test(l); }).join(' | '));
  }
}

console.log('');
console.log('A device that never touched these features prints none of them:');
{
  const env = build();
  const text = config(env);
  const noise = ['ip name-server', 'scion ', 'ospf ', 'router bgp', 'neighbor ', 'ipv6 nd', 'ipv6 route',
    'ipv6 gateway', 'ipv6 address'];
  for (const line of noise) {
    ok(text.indexOf(line) === -1, 'a default config has no "' + line.trim() + '" line');
  }
}

console.log('');
console.log('Everything at once: the printed config replays into an identical device:');
{
  const models = [
    ROUTER,
    catalog.filter(function (s) { return /ISR 4331/.test(s.model); })[0],
    catalog.filter(function (s) { return s.model === 'generic-router'; })[0]
  ].filter(Boolean);

  for (const spec of models) {
    const env = build(spec);
    const errors = apply(env, [
      'ip name-server 10.0.0.9',
      'scion 1-ff00:0:110',
      'ospf router-id 1.1.1.1', 'ospf area 5',
      'router bgp 65001', 'bgp router-id 1.1.1.1', 'neighbor 10.0.0.2 remote-as 65002',
      'ipv6 route 2001:db8:2::/64 2001:db8:1::2', 'ipv6 gateway 2001:db8:1::2',
      'interface %P%', 'ip address 10.0.0.1 255.255.255.0',
      'ipv6 address 2001:db8:1::1/64', 'ip ospf cost 20', 'ip ospf passive',
      'ipv6 nd ra enable', 'ipv6 nd prefix 2001:db8:1::/64'
    ]);
    ok(errors.length === 0, spec.model + ': every command is accepted', JSON.stringify(errors));
    const printed = config(env);
    const back = replayInto(printed, spec);
    ok(back.errors.length === 0, spec.model + ': the printed config replays with nothing rejected',
      JSON.stringify(back.errors.slice(0, 3)));
    ok(config(back.env) === printed, spec.model + ': and produces a byte-identical config',
      config(back.env) === printed ? '' : 'differs');
  }
}

console.log('');
console.log('Each feature is removable again, and the text returns:');
{
  const cases = [
    ['name servers', ['ip name-server 10.0.0.9'], ['no ip name-server 10.0.0.9']],
    ['SCION', ['scion 1-ff00:0:110'], ['no scion']],
    ['BGP', ['router bgp 65001', 'neighbor 10.0.0.2 remote-as 65002'],
      ['no neighbor 10.0.0.2', 'no router bgp 65001']],
    ['IPv6 route', ['ipv6 route 2001:db8:2::/64 2001:db8:1::2'],
      ['no ipv6 route 2001:db8:2::/64 2001:db8:1::2']]
  ];
  for (const [name, on, off] of cases) {
    const env = build();
    const base = config(env);
    apply(env, on);
    ok(config(env) !== base, name + ': setting it changes the text');
    const errors = apply(env, off);
    ok(errors.length === 0, name + ': the no form is accepted', JSON.stringify(errors));
    ok(config(env) === base, name + ': and the text comes back', config(env) === base ? '' : 'differs');
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
