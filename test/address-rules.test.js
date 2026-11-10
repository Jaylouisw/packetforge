'use strict';
// address-rules.test.js - `ip address` accepted addresses no interface can hold.
//
// Measured before this pass, on a `generic-router` named R1:
//   R1(config-if)#ip address 0.0.0.0 0.0.0.0          -> IP address set on Gi0/0: 0.0.0.0/0
//   R1(config-if)#ip address 10.0.0.255 255.255.255.0 -> IP address set on Gi0/0: 10.0.0.255/24
//   R1(config-if)#ip address 10.0.0.1 255.0.255.0     -> IP address set on Gi0/0: 10.0.0.1/8
//   R1(config-if)#ip address 10.0.0.1 255.255.255.0     (Gi0/1, already on Gi0/0)
//                                                     -> IP address set on Gi0/1: 10.0.0.1/24
//   R1(config-if)#ip address 10.0.0.2 255.255.255.0     (Gi0/1, same subnet as Gi0/0)
//                                                     -> IP address set on Gi0/1: 10.0.0.2/24
//   R1(config-if)#ip address 10.0.0.1/24 secondary     -> IP address set on Gi0/0: 10.0.0.1/24
//
// Five lies in one command, and the last one is a dropped word:
//   * 0.0.0.0/0 is a default route worn as a port.
//   * 10.0.0.255 is the broadcast address of its own subnet - no host can answer for it.
//   * 255.0.255.0 is not a mask; `prefixOf()` counted its leading ones and printed /8.
//   * the same address on two interfaces makes "who owns this address" unanswerable - and after the
//     local-delivery fix, a router answers for *every* address it holds, so the ambiguity is real.
//   * two interfaces in one subnet makes "which port does this leave by" unanswerable, which is the
//     question every ping in this lab asks.
//   * `secondary` is an IOS keyword for a second address; it was dropped while the answer said
//     "IP address set", so an operator believed they had configured something.
const path = require('path');
const { Topology, Simulator, CliSession } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + (actual === expected ? '' : ' (got ' + JSON.stringify(actual) + ')'));
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const ROUTER = catalog.find(function (s) { return s.model === 'generic-router'; });

function router() {
  const t = new Topology();
  const d = t.addDevice(ROUTER); d.name = 'R1';
  const sim = new Simulator(t);
  const s = new CliSession(d, t, sim); s.run('enable'); s.run('configure terminal');
  return { t: t, d: d, s: s };
}
function iface(env, name) {
  env.s.run('interface ' + name);
  return env.s;
}

console.log('\nAn interface address must be a host address in its own subnet:');
{
  const env = router();
  const s = iface(env, 'Gi0/0');
  eq(s.run('ip address 0.0.0.0 0.0.0.0').output[0],
    '% 0.0.0.0 is not a host address, so no interface can hold it',
    '0.0.0.0 is refused - it was stored as an interface address of /0');
  eq(s.run('ip address 255.255.255.255 255.255.255.0').output[0],
    '% 255.255.255.255 is not a host address, so no interface can hold it',
    'and so is the all-ones address');
  const bcast = s.run('ip address 10.0.0.255 255.255.255.0').output;
  eq(bcast[0], '% 10.0.0.255 is the broadcast address of 10.0.0.0/24 - a router address must be a host in its own subnet',
    'the subnet broadcast address is named as such');
  eq(bcast[1], '% Try 10.0.0.254, or a wider mask', 'and the nearest host address is offered');
  const netAddr = s.run('ip address 10.0.0.0 255.255.255.0').output;
  eq(netAddr[0], '% 10.0.0.0 is the network address of 10.0.0.0/24 - a router address must be a host in its own subnet',
    'the network address too');
  eq(netAddr[1], '% Try 10.0.0.1, or a wider mask', 'with a suggestion');
  eq(env.d.interfaces.get('Gi0/0').ip, null, 'and none of those refusals stored anything');
}

console.log('\nA mask is a mask:');
{
  const env = router();
  const s = iface(env, 'Gi0/0');
  const bad = s.run('ip address 10.0.0.1 255.0.255.0').output;
  eq(bad[0], '% 255.0.255.0 is not a contiguous mask - the ones must all be on the left',
    'a non-contiguous mask is refused instead of printing /8 for it');
  ok(/ip address 10\.0\.0\.1\/24/.test(bad[1]), 'and the prefix spelling is offered');
  eq(s.run('ip address 10.0.0.1 255.255.255.0').output[0], 'IP address set on Gi0/0: 10.0.0.1/24',
    'the contiguous mask is still accepted');
  // /31 and /32 have no network or broadcast host, so they are not judged by that rule.
  eq(s.run('ip address 10.0.0.1 255.255.255.255').output[0], 'IP address set on Gi0/0: 10.0.0.1/32',
    'a /32 is accepted, because it has no broadcast address');
  eq(s.run('ip address 10.0.1.0 255.255.255.254').output[0], 'IP address set on Gi0/0: 10.0.1.0/31',
    'and a /31 point-to-point pair is accepted too');
}

console.log('\nOne address, one interface - and one subnet, one interface:');
{
  const env = router();
  const s = env.s;
  s.run('interface Gi0/0');
  s.run('ip address 10.0.0.1 255.255.255.0');
  // Re-setting the same address on the same interface is a re-set, not a duplicate.
  eq(s.run('ip address 10.0.0.1 255.255.255.0').output[0], 'IP address set on Gi0/0: 10.0.0.1/24',
    'setting the same address again on the same interface is allowed');
  s.run('interface Gi0/1');
  eq(s.run('ip address 10.0.0.1 255.255.255.0').output[0],
    '% 10.0.0.1 is already on Gi0/0 - one address cannot be on two interfaces',
    'the same address on another interface names the interface that has it');
  const overlap = s.run('ip address 10.0.0.2 255.255.255.0').output;
  eq(overlap[0], '% 10.0.0.0/24 overlaps Gi0/0 (10.0.0.1/24) - two interfaces in one subnet is ambiguous',
    'a second address in the same subnet is refused, naming the subnet and the port');
  eq(overlap[1], '% A router routes between subnets: give this interface a different one',
    'and says what a router is for');
  // A wider or narrower mask that still covers it is the same overlap.
  eq(s.run('ip address 10.0.0.9 255.255.255.252').output[0],
    '% 10.0.0.8/30 overlaps Gi0/0 (10.0.0.1/24) - two interfaces in one subnet is ambiguous',
    'a narrower subnet inside it overlaps too, and the overlap is quoted as a subnet');
  // 10.9.0.0/16 does NOT contain 10.0.0.0/24, so it is a different subnet - an earlier draft of
  // this test asserted otherwise and the console was right to refuse the assertion, not the address.
  eq(s.run('ip address 10.9.0.9 255.255.0.0').output[0], 'IP address set on Gi0/1: 10.9.0.9/16',
    'a /16 that does not contain the other subnet is a different subnet');
  eq(s.run('ip address 10.0.9.9 255.255.0.0').output[0],
    '% 10.0.0.0/16 overlaps Gi0/0 (10.0.0.1/24) - two interfaces in one subnet is ambiguous',
    'and a /16 that does contain it overlaps');
  // The comparison must be unsigned: 192.168.0.0/24 and 10.0.0.0/24 do not overlap, and a signed
  // 32-bit comparison makes one of them negative and reports a false overlap.
  eq(s.run('ip address 192.168.0.1 255.255.255.0').output[0], 'IP address set on Gi0/1: 192.168.0.1/24',
    'an unrelated subnet whose network address has the top bit set is accepted');
  eq(s.run('ip address 10.0.1.5 255.255.255.0').output[0], 'IP address set on Gi0/1: 10.0.1.5/24',
    'and a neighbouring subnet is a different subnet');
  const brief = env.s.run('end').output;
  ok(/Gi0\/0\s+10\.0\.0\.1\/24/.test(env.s.run('show ip interface brief').output.join('\n')),
    'show ip interface brief still shows the accepted address');
}

console.log('\n`secondary` is a limitation, not a typo:');
{
  const env = router();
  const s = iface(env, 'Gi0/0');
  s.run('ip address 10.0.0.1 255.255.255.0');
  for (const cmd of ['ip address 10.0.1.1 255.255.255.0 secondary', 'ip address 10.0.1.1/24 secondary']) {
    const out = s.run(cmd).output;
    eq(out[0], '% "secondary" is not modelled - one address per interface in this lab',
      'both spellings say the same thing: ' + cmd.split(' ')[1]);
    eq(out[1], '% Use a subinterface ("interface Gi0/0.10") for a second subnet on the same cable',
      'and point at the thing that does a second address');
  }
  eq(s.run('ip address 10.0.1.1 255.255.255.0').output[0], 'IP address set on Gi0/0: 10.0.1.1/24',
    'while the primary address can be replaced, since one address is what an interface has');
}

console.log('\nA trailing word is refused, in both spellings:');
{
  const env = router();
  const s = iface(env, 'Gi0/0');
  eq(s.run('ip address 10.0.0.1 255.255.255.0 extra').output[0],
    '% Unexpected argument "extra" - ip address <ip> <mask> takes no more ("ip address 10.0.0.1 255.255.255.0")',
    'the mask spelling quotes the command it meant');
  eq(s.run('ip address 10.0.0.1/24 extra').output[0],
    '% Unexpected argument "extra" - ip address <ip> <mask> takes no more ("ip address 10.0.0.1 255.255.255.0")',
    'and the prefix spelling suggests the mask form, not "24"');
  eq(env.d.interfaces.get('Gi0/0').ip, null, 'neither stored an address');
}

console.log('\nNeither do the other commands that take an address:');
{
  const env = router();
  const s = env.s;
  eq(s.run('ip name-server 300.0.0.1').output[0], '% Invalid name server "300.0.0.1"',
    'a name server is parsed, not pattern-matched');
  eq(s.run('router bgp 65001').output[0], 'BGP enabled, local AS 65001', 'BGP is up');
  // `_bgp` had its own isIp regex, which is why a 300-octet neighbour was accepted and written to
  // running-config as a line that could never establish.
  const nb = s.run('neighbor 300.0.0.1 remote-as 65002').output;
  ok(!/BGP neighbor/.test(nb.join('\n')), 'a neighbour address with a 300 octet is refused');
  eq(s.run('bgp router-id 1.2.3.999').output[0], '% Invalid router-id "1.2.3.999"', 'and so is a router-id');
  ok(!/300\.0\.0\.1/.test(s.run('end').output.join('\n') + s.run('show running-config').output.join('\n')),
    'nothing invalid reached the running-config');
}

console.log('\nAnd the VRRP verbs take no trailing word:');
{
  const env = router();
  const s = env.s;
  s.run('interface Gi0/0');
  s.run('ip address 10.0.0.1 255.255.255.0');
  s.run('vrrp 1 ip 10.0.0.254');
  eq(s.run('vrrp 1 preempt extra').output[0],
    '% Unexpected argument "extra" - vrrp <vrid> preempt takes no more',
    '`vrrp 1 preempt extra` no longer answers "preempt enabled"');
  eq(s.run('vrrp 1 priority 120 extra').output[0],
    '% Unexpected argument "extra" - vrrp <vrid> priority <p> takes no more', 'nor priority');
  eq(s.run('vrrp 1 advertise 2 extra').output[0],
    '% Unexpected argument "extra" - vrrp <vrid> advertise <s> takes no more', 'nor advertise');
  eq(s.run('vrrp 1 preempt').output[0], 'VRRP group 1 preempt enabled', 'while the bare forms still work');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
