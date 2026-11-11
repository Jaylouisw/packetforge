'use strict';
// peer-addresses.test.js - the address a command points at has to be one that can answer.
//
//   R1(config)#ip route 10.9.0.0 255.255.255.0 127.0.0.1
//   Route added: 10.9.0.0/24 via 127.0.0.1
//   R1#show ip route
//   *  S 10.9.0.0/24  1  127.0.0.1  -          <- marked as the row that forwards
//   R1#ping 10.9.0.9
//   Success rate is 0 percent (0/4)
//
// A next hop is one neighbour's address. The zero address, the limited broadcast, a multicast group,
// a loopback and a reserved address are not addresses a wire can hand to one host, so each of these
// routes was a row marked "this is what forwards" with nothing that could ever answer its ARP. The
// same four classes were accepted by `ip helper-address` and `ip default-gateway`; one classifier now
// answers for all three, in the same words.
//
// And a route that cannot resolve is said out loud: `*` means installed by distance, which an operator
// reads as "the way out".
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function text(out) { return out && out.output ? out.output.join('\n') : String(out); }
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const find = function (m) { return catalog.filter(function (x) { return x.model === m; })[0]; };

function lab() {
  const t = new Topology();
  const r1 = t.addDevice(find('generic-router')); r1.name = 'R1';
  const r2 = t.addDevice(find('generic-router')); r2.name = 'R2';
  t.connect(r1.id, 'Gi0/0', r2.id, 'Gi0/0');
  const sim = new Simulator(t);
  const R1 = new CliSession(r1, t, sim); R1.run('enable');
  R1.run('configure terminal', 'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit', 'end');
  const R2 = new CliSession(r2, t, sim); R2.run('enable');
  R2.run('configure terminal', 'interface Gi0/0', 'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'exit', 'end');
  return { t: t, sim: sim, r1: r1, r2: r2, R1: R1, R2: R2 };
}
const cfg = function (env, line) { return text(env.R1.run('configure terminal', line, 'exit')); };
const routes = function (env) { return (env.r1.config.routes || []).length; };

console.log('A static route refuses a next hop that cannot answer:');
{
  const cases = [
    ['ip route 10.9.0.0 255.255.255.0 0.0.0.0', /zero address/],
    ['ip route 10.9.0.0 255.255.255.0 255.255.255.255', /limited broadcast/],
    ['ip route 10.9.0.0 255.255.255.0 224.0.0.1', /multicast group address/],
    ['ip route 10.9.0.0 255.255.255.0 239.1.1.1', /multicast group address/],
    ['ip route 10.9.0.0 255.255.255.0 127.0.0.1', /loopback address/],
    ['ip route 10.9.0.0 255.255.255.0 240.0.0.1', /reserved address/],
  ];
  for (const [line, want] of cases) {
    const env = lab();
    const out = cfg(env, line);
    ok(want.test(out), line.split(' ').pop() + ' is refused for what it is');
    ok(/one next-hop address/.test(out), 'and the refusal says what a next hop is');
    ok(routes(env) === 0, 'and no route was installed');
  }
}

console.log('\nA real neighbour address still installs the route, and it forwards:');
{
  const env = lab();
  const out = cfg(env, 'ip route 10.9.0.0 255.255.255.0 10.0.0.2');
  ok(/Route added: 10\.9\.0\.0\/24 via 10\.0\.0\.2/.test(out), 'the route is added');
  ok(routes(env) === 1, 'and stored');
  ok(/10\.0\.0\.2/.test(text(env.R1.run('show ip route'))), 'and the table names the gateway');
  ok(!/cannot reach/.test(text(env.R1.run('show ip route'))), 'with no caveat');
}

console.log('\nA default gateway is one host, not a class:');
{
  const cases = [['ip default-gateway 0.0.0.0', /zero address/],
    ['ip default-gateway 224.0.0.1', /multicast group address/],
    ['ip default-gateway 127.0.0.1', /loopback address/]];
  for (const [line, want] of cases) {
    const env = lab();
    const out = cfg(env, line);
    ok(want.test(out), line + ' is refused for what it is');
    ok(env.r1.config.defaultGateway === undefined || env.r1.config.defaultGateway === null,
      'and nothing was stored');
  }
  const env = lab();
  ok(/Default gateway: 10\.0\.0\.2/.test(cfg(env, 'ip default-gateway 10.0.0.2')), 'a host address is taken');
}

console.log('\nA link-local IPv6 next hop names a wire that was not named:');
{
  const env = lab();
  const out = cfg(env, 'ipv6 route 2001:db8:9::/64 fe80::1');
  ok(/fe80::1 is a link-local address/.test(out), 'the address is refused for what it is');
  ok(/egress interface/.test(out), 'and the missing piece is named');
  ok(/<port>/.test(out), 'with the form that supplies it');
  ok(((env.r1.config.routes6 || []).length) === 0, 'and no route was installed');
  ok(/IPv6 route 2001:db8:9::\/64 via 2001:db8::1/.test(cfg(env, 'ipv6 route 2001:db8:9::/64 2001:db8::1')),
    'a global next hop is still accepted');
}

console.log('\nA route the router cannot resolve says so, under the table:');
{
  const env = lab();
  cfg(env, 'ip route 10.7.0.0 255.255.255.0 10.0.0.2');
  cfg(env, 'ip route 10.8.0.0 255.255.255.0 192.168.99.1');
  const out = text(env.R1.run('show ip route'));
  ok(/1 installed route has a next hop this router cannot reach/.test(out), 'the stranding is counted');
  ok(/10\.8\.0\.0\/24 via 192\.168\.99\.1 - not on a connected subnet, and no route covers it/.test(out),
    'and named with the reason');
  ok(!/10\.7\.0\.0\/24 via 10\.0\.0\.2 - not on/.test(out), 'a reachable neighbour is not named');
  const tableAt = out.indexOf('Prefix');
  const noteAt = out.indexOf('cannot reach');
  ok(tableAt !== -1 && noteAt > tableAt, 'the caveat comes after the rows it qualifies');
}

console.log('\nA recursive next hop that another route covers is not stranded:');
{
  const env = lab();
  cfg(env, 'ip route 10.8.0.0 255.255.255.0 10.0.0.2');
  cfg(env, 'ip route 10.6.0.0 255.255.255.0 10.8.0.5');
  const out = text(env.R1.run('show ip route'));
  ok(!/cannot reach/.test(out), 'a next hop inside the 10.8.0.0/24 route is resolvable, so nothing is said');
}

console.log('\nVLAN 1 is not "created":');
{
  const t = new Topology();
  const sw = t.addDevice(find('generic-switch')); sw.name = 'SW1';
  const S = new CliSession(sw, t, new Simulator(t)); S.run('enable');
  const out = text(S.run('configure terminal', 'vlan 1', 'exit'));
  ok(/VLAN 1 is the default VLAN/.test(out), 'the command answers what VLAN 1 is');
  // The message itself says a VLAN *cannot be created or removed* here, so the assertion is about the
  // claim, not the word: "VLAN 1 created" was the old answer.
  ok(!/VLAN 1 created/.test(out), 'and does not claim an act the configuration never records');
  ok((sw.config.vlans || {})[1] === undefined, 'no stanza is written for it');
  const v10 = text(S.run('configure terminal', 'vlan 10 name users', 'exit'));
  ok(/VLAN 10 created/.test(v10), 'a real VLAN still reports its creation');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
