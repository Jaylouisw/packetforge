'use strict';
// dhcp-client.test.js - a lease could be watched, never renewed, never given back.
//
// Measured before this pass, on a PC with `ip address dhcp` against a router pool:
//   PC1#renew dhcp
//   % Unrecognized command: renew dhcp
//   PC1#release dhcp
//   % Unrecognized command: release dhcp
//
// `ip address dhcp` and `show ip dhcp binding` existed, so the client half of the exchange was
// readable and untouchable: the one thing an operator does with a lease - take one and give it back -
// had no command. And the lease itself was answered two ways, depending on what had been typed first:
//
//   PC1#show ip interface brief          <- nothing has run yet
//   Interface  IP-Address  OK?  Method  Status  Protocol
//   eth0       unassigned  YES  DHCP    up      up
//   PC1#show ip dhcp binding
//   DHCP lease on PC1/eth0:  IP address : 192.168.5.10/24      <- the lease, all along
//   PC1#ping 192.168.5.1
//   PC1#show ip interface brief
//   eth0       192.168.5.10/24  YES  DHCP  up  up              <- now it agrees
//
// The address arrives when the DHCP ACK is delivered, and delivering it is part of deriving the
// planes - which `show ip interface brief` did not do.
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
function rate(out) {
  const m = /Success rate is (\d+) percent/.exec((Array.isArray(out) ? out : [out]).join(' '));
  return m ? Number(m[1]) : null;
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const ROUTER = catalog.find(function (s) { return s.model === 'generic-router'; });
const PC = catalog.find(function (s) { return s.model === 'generic-pc'; });

// R1 is the server (192.168.5.0/24, range .10-.20); PC1 asks for an address.
function lab() {
  const t = new Topology();
  const r1 = t.addDevice(ROUTER); r1.name = 'R1';
  const pc = t.addDevice(PC); pc.name = 'PC1';
  const link = t.connect(r1.id, 'Gi0/0', pc.id, 'eth0');
  const sim = new Simulator(t);
  const cfg = function (d, cmds) {
    const s = new CliSession(d, t, sim);
    s.run('enable'); s.run('configure terminal');
    for (const c of cmds) s.run(c);
    s.run('end');
    return s;
  };
  const sr = cfg(r1, ['interface Gi0/0', 'ip address 192.168.5.1 255.255.255.0', 'exit',
    'ip dhcp pool LAN', 'network 192.168.5.0 255.255.255.0',
    'range 192.168.5.10 192.168.5.20', 'default-router 192.168.5.1', 'dns-server 192.168.5.1', 'exit']);
  const sp = cfg(pc, ['interface eth0', 'ip address dhcp', 'exit']);
  return { t: t, r1: r1, pc: pc, sim: sim, sr: sr, sp: sp, link: link };
}
function brief(s) {
  const line = s.run('show ip interface brief').output.filter(function (l) { return /^eth0\s/.test(l); })[0];
  const cols = (line || '').trim().split(/\s{2,}/);
  return { address: cols[1], method: cols[3], status: cols[4], protocol: cols[5] };
}

console.log('\nThe first question already knows about the lease:');
{
  const env = lab();
  eq(brief(env.sp).address, '192.168.5.10/24',
    'show ip interface brief reports the leased address before anything else has run');
  eq(brief(env.sp).method, 'DHCP', 'with Method DHCP');
  const held = env.sp.run('show ip dhcp binding').output.join('\n');
  ok(/IP address\s+: 192.168.5.10\/24/.test(held), 'and show ip dhcp binding agrees about the same address');
  ok(/Server\s+: 192.168.5.1/.test(held), 'naming the server that handed it out');
  eq(rate(env.sp.run('ping 192.168.5.1 count 2').output), 100, 'the address works');
}

console.log('\nrenew dhcp asks now:');
{
  const env = lab();
  const out = env.sp.run('renew dhcp').output;
  eq(out[0], 'Renewed DHCP lease on eth0: 192.168.5.10 (lease 86400s)',
    'it reports the address and the lease length');
  ok(!/different address/.test(out.join(' ')), 'the same server hands back the same address');
  // A renewal is an instruction, not a question: it must reach the server even inside T1.
  const before = env.sim.events.length;
  env.sp.run('renew dhcp');
  const dhcpEvents = env.sim.events.slice(before).filter(function (e) { return e.type === 'dhcp'; });
  ok(dhcpEvents.length > 0, 'and it really ran an exchange with the server');
  eq(env.sp.run('renew dhcp eth0').output[0], 'Renewed DHCP lease on eth0: 192.168.5.10 (lease 86400s)',
    'naming the port works too');
}

console.log('\nrelease dhcp gives the lease back to both tables:');
{
  const env = lab();
  const out = env.sp.run('release dhcp').output;
  eq(out[0], 'Released DHCP lease on eth0 (was 192.168.5.10)', 'the release names the address given up');
  ok(/the server forgot the binding/.test(out.join('\n')), 'and says the server forgot it');
  eq(brief(env.sp).address, 'unassigned', 'the client now holds no address');
  eq(brief(env.sp).method, 'DHCP', 'while still being a DHCP client');
  const server = env.sr.run('show ip dhcp binding').output.join('\n');
  ok(/none/.test(server), 'the server table is empty');
  ok(/In use\s+: 0 of 11/.test(env.sr.run('show ip dhcp pool').output.join('\n')),
    'and the pool counts the address as free again');
  eq(rate(env.sp.run('ping 192.168.5.1 count 1').output), 0, 'a ping from an unaddressed client fails');
  // The distinction that makes it a release rather than a mystery: the next show must not re-acquire.
  eq(brief(env.sp).address, 'unassigned', 'and it stays released across later questions');
  eq(env.sp.run('renew dhcp').output[0], 'Renewed DHCP lease on eth0: 192.168.5.10 (lease 86400s)',
    'until renew dhcp asks again');
  eq(brief(env.sp).address, '192.168.5.10/24', 'which puts the address back');
  ok(/In use\s+: 1 of 11/.test(env.sr.run('show ip dhcp pool').output.join('\n')),
    'and the pool counts it again');
}

console.log('\nReleasing twice, and releasing what is not leased:');
{
  const env = lab();
  env.sp.run('release dhcp');
  eq(env.sp.run('release dhcp').output[0],
    'DHCP lease on eth0 was already released - the port holds no address',
    'a second release says there was nothing to give back');
  // Configuration is the third way back from a released lease.
  env.sp.run('configure terminal', 'interface eth0', 'ip address dhcp', 'exit', 'end');
  ok(/192\.168\.5\.10/.test(brief(env.sp).address), 're-issuing "ip address dhcp" re-acquires');
}

console.log('\nThe verbs refuse what they do not apply to:');
{
  const env = lab();
  const r1 = env.sr.run('renew dhcp');
  eq(r1.output[0], '% R1 has no DHCP client interfaces', 'a router with no client port says so');
  ok(/"ip address dhcp"/.test(r1.output.join('\n')), 'and names the command that would make one');
  // A port that exists but is not a client is a different answer from one that does not exist.
  const notClient = env.sr.run('renew dhcp Gi0/0');
  ok(/% Gi0\/0 is not a DHCP client/.test(notClient.output[0]), 'a manual port is named as not a client');
  ok(/% No interface named Fa9\/9/.test(env.sr.run('renew dhcp Fa9/9').output[0]),
    'and a port that does not exist is named');
  ok(/% Unexpected argument/.test(env.sp.run('renew dhcp eth0 extra').output[0]),
    'a trailing word is refused');
}

console.log('\nA lease that expires is honestly gone:');
{
  // `lease 0 0 1` is one minute: IOS spells it days/hours/minutes, so `lease 2` is two *days* - the
  // first version of this test asserted a two-day lease would expire in a minute, and was wrong
  // about the command rather than about the code.
  const env = lab();
  env.sr.run('configure terminal', 'ip dhcp pool LAN', 'lease 0 0 1', 'exit', 'end');
  ok(/Lease\s+: 60s/.test(env.sr.run('show ip dhcp pool').output.join('\n')), 'the pool holds a 60s lease');
  env.sp.run('renew dhcp');
  eq(brief(env.sp).address, '192.168.5.10/24', 'the client holds it');
  // Present the instant after the lease ran out with the cable pulled, so the client cannot renew
  // and the question is about the lease rather than about the renewal.
  ok(/is now down/.test(env.sr.run('link down ' + env.link.id).output[0]), 'the cable is pulled');
  const later = env.sr.run('show ip dhcp binding at 90000').output.join('\n');
  ok(/\(none\)/.test(later), 'the server holds no binding at t=90s');
  ok(/lease expired at this instant/.test(later), 'and says the lease expired rather than showing nothing');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
