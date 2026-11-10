'use strict';
// dhcp-lease-clock.test.js — the only thing in this lab that can run out.
//
// Three defects met here, and they had one cause: DHCP had no clock.
//
//   1. `expireLeases()` was written, unit-tested (`test/protocol-regression.test.js` asserts a lease
//      dies at its expiry step) and **never called by the simulator**. So nothing in a live lab aged.
//   2. The exchange stamped leases with `this.step`, the *frame-hop* counter, which only moves when
//      packets fly. Asked `at 120000`, a 60-second lease still said "Expires in 60s".
//   3. Every refresh re-ran a full DISCOVER for a client that already held a lease, so asking the
//      same question twice could hand the same host a *different* address - measured: 10.0.1.100,
//      then 10.0.1.101 - and re-stamped the timer as if no time had passed.
//
// The model now has a clock (`_nowStep()`: the asked instant, or t=0 at rest), a renewal path (a
// client that holds a live lease sends REQUEST, not DISCOVER, once past T1 = half the lease), and an
// expiry path that releases the address back to the pool and leaves the client honestly unaddressed.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const dhcp = require('../engine/dhcp');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + (actual === expected ? '' : ' (got ' + JSON.stringify(actual) +
    ', want ' + JSON.stringify(expected) + ')'));
}
function match(re, text, msg) {
  ok(re.test(text), msg + (re.test(text) ? '' : ' (no match in ' + JSON.stringify(text) + ')'));
}

function model(name) {
  const found = loadCatalog(path.join(__dirname, '..', 'devices')).find((x) => x.model === name);
  if (!found) throw new Error('no such model: ' + name);
  return found;
}

// A 60-second lease, so an instant two minutes out is well past expiry.
function lab() {
  const t = new Topology();
  const r1 = t.addDevice(model('generic-router'));
  const pc1 = t.addDevice(model('generic-pc'));
  r1.name = 'R1'; pc1.name = 'PC1';
  const link = t.connect(pc1.id, 'eth0', r1.id, 'Gi0/0');
  const sim = new Simulator(t);
  ok(!runCommands(r1, t, sim, ['enable', 'configure terminal',
    'interface Gi0/0', 'ip address 10.0.1.1 255.255.255.0', 'exit',
    'ip dhcp pool lan', 'network 10.0.1.0 255.255.255.0',
    'range 10.0.1.100 10.0.1.120', 'default-router 10.0.1.1', 'lease 0 0 1', 'exit', 'exit'])
    .lines.some((l) => /^%/.test(l)), 'the server is configured with a 60-second lease');
  ok(!runCommands(pc1, t, sim, ['enable', 'configure terminal', 'interface eth0',
    'ip address dhcp', 'exit', 'exit']).lines.some((l) => /^%/.test(l)),
    'and the client asks for an address');
  function show(dev, cmd) {
    return runCommands(dev, t, sim, ['enable', cmd]).lines
      .filter((l) => !/^[A-Za-z0-9_.() -]+[>#]/.test(l)).join('\n');
  }
  function at(ms) {
    sim.setRunTime(ms);
    sim.refreshControlPlanes({ ra: true, lldp: true });
    return ms === undefined ? show(r1, 'show ip dhcp binding')
      : show(r1, 'show ip dhcp binding at ' + ms);
  }
  return { t, r1, pc1, sim, link, show, at };
}

console.log('The lease is a deadline, so the column counts down:');
{
  const l = lab();
  const fresh = l.at();
  match(/Expires in/, fresh, 'the binding table has the column');
  match(/ +60s$/m, fresh, 'a fresh lease shows its full 60 seconds, not a hop-counter artefact');
  // A separate lab, because the first question above already took the lease at t=0. DHCP converges
  // by 1000 ms, so the first question at t=10s takes a lease that runs to t=70s.
  const m = lab();
  const ten = m.at(10000);
  match(/ +60s$/m, ten, 'the lease is taken at t=10s and runs the full 60 seconds');
  const twenty = m.at(20000);
  match(/ +50s$/m, twenty, 'ten seconds later it says 50s, because ten seconds went by');
  const twentyNine = m.at(29000);
  match(/ +41s$/m, twentyNine, 'and the countdown continues second by second');
}

console.log('\nAsking twice does not move the client\'s address:');
{
  const l = lab();
  l.at(10000);   // the exchange has to happen before there is an address to hold
  const first = l.pc1.interfaces.get('eth0').ip;
  eq(first, '10.0.1.100', 'the first lease is the lowest address in the pool');
  // More questions before T1: the lease is simply still valid, so nothing may change.
  l.at(11000); l.at(12000);
  eq(l.pc1.interfaces.get('eth0').ip, first, 'still valid: the address is unchanged');
  l.at(15000);
  eq(l.pc1.interfaces.get('eth0').ip, first, 'and still the same after a third question');
  const rows = l.sim.dhcpBindings(l.r1.id);
  eq(rows.length, 1, 'the server holds one binding, not one per question');
  eq(rows[0].ip, first, 'for the address it actually handed out');
  // The pool's free count must agree with that: 21 addresses, one in use.
  match(/In use +: 1 of 21/, l.show(l.r1, 'show ip dhcp pool'), 'the pool counts one address in use');
}

console.log('\nA reachable server renews the lease instead of letting it run out:');
{
  const l = lab();
  const early = l.at(10000);
  match(/ +60s$/m, early, 'the lease starts at 60s');
  // T1 is half the lease, so a question past t=40s finds the client renewing rather than expiring.
  const renewed = l.at(45000);
  match(/ +60s$/m, renewed, 'a question past T1 renews and the full lease returns');
  eq(l.pc1.interfaces.get('eth0').ip, '10.0.1.100', 'and the address is still the same one');
  // The renewal is a REQUEST for the held address, not a fresh DISCOVER.
  const phases = l.sim.events.filter((e) => e.type === 'dhcp').map((e) => e.phase);
  ok(phases.indexOf('renewed') !== -1, 'the exchange recorded a renewal');
  ok(phases.indexOf('held') !== -1, 'and a held lease for the questions before T1');
  ok(phases.indexOf('failed') === -1, 'with no failures along the way');
}

console.log('\nWith the server gone the lease really does expire:');
{
  const l = lab();
  l.at(10000);
  eq(l.pc1.interfaces.get('eth0').ip, '10.0.1.100', 'the client holds its address');
  eq(l.sim.dhcpBindings(l.r1.id).length, 1, 'and the server holds the binding');
  // Pull the cable after the lease exists: from then on the client cannot renew, so the 60 seconds
  // it holds are all it will ever have. The lease runs to t=70s.
  l.sim.setLinkState(l.link.id || l.link, 'down', { atMs: 15000 });
  const at20 = l.at(20000);
  match(/ +50s$/m, at20, 'the lease is still valid, and the column says how long is left');
  const at69 = l.at(69000);
  match(/ +1s$/m, at69, 'one second before the end, the answer is honest about it');
  const after = l.at(70000);
  match(/DHCP bindings on R1: \(none\)/, after, 'the binding is gone from the server');
  match(/1 lease expired at this instant/, after,
    'and the empty table says a lease ran out, rather than claiming no exchange ever happened');
  // The same instant asked twice must not lose the explanation: the second refresh has nothing left
  // to expire, and the first version of this check went quiet and claimed "no exchange".
  const again = l.at(70000);
  match(/1 lease expired at this instant/, again, 'and asking the same instant again keeps saying so');
  eq(l.pc1.interfaces.get('eth0').ip, null, 'the client is honestly unaddressed');
  eq(l.pc1.interfaces.get('eth0').dhcpLease, null, 'and no longer believes it holds a lease');
  match(/In use +: 0 of 21/, l.show(l.r1, 'show ip dhcp pool'),
    'the address is back in the pool, which is the point of expiry');
  // The event trail names the expiry, so a run can be explained after the fact.
  const expired = l.sim.events.filter((e) => e.type === 'dhcp' && e.phase === 'expired');
  ok(expired.length >= 1, 'the run records the expiry as an event');
  ok(/lease expired at step 70/.test(expired[0].detail || ''),
    'naming the step the lease died at (' + (expired[0] && expired[0].detail) + ')');
}

console.log('\nExpiry is the library\'s rule, and the simulator now calls it:');
{
  // The unit-level contract, checked directly so this file fails if the wiring is removed even
  // though the console output could still look plausible.
  const state = dhcp.createLeaseState();
  const ack = dhcp.handleRequest(
    { name: 'p', network: '10.0.0.0', mask: '255.255.255.0', rangeStart: '10.0.0.10',
      rangeEnd: '10.0.0.20', leaseSec: 600 }, state,
    { mac: '02:00:00:00:00:01', requestedIp: '10.0.0.10', step: 0 });
  eq(ack.expiresStep, 600, 'a 600-second lease taken at step 0 expires at step 600');
  eq(dhcp.leaseTable(state, 0)[0].remainingSec, 600, 'and reports 600 seconds left at step 0');
  eq(dhcp.leaseTable(state, 300)[0].remainingSec, 300, 'and 300 at the halfway point');
  eq(dhcp.expireLeases(state, 599), 0, 'nothing expires one second early');
  eq(dhcp.expireLeases(state, 600), 1, 'and it expires exactly on time');
  eq(dhcp.leaseTable(state, 600).length, 0, 'after which the table is empty');
}

console.log('\nA fresh lab at rest reports its lease, not a hop count:');
{
  // The clock when no instant is asked: t=0. Using the frame-hop counter made a 60-second pool
  // report "Expires in 62s" after a couple of commands and made the answer depend on how many pings
  // had been sent.
  const l = lab();
  l.sim.ping(l.pc1.id, '10.0.1.1', { count: 2 });
  const out = l.show(l.r1, 'show ip dhcp binding');
  match(/ +60s$/m, out, 'still 60s after packets have flown, because no instant was asked for');
  eq(l.sim._nowStep(), 0, 'and the clock itself says t=0 at rest');
  l.sim.setRunTime(30000);
  eq(l.sim._nowStep(), 30, 'while an instant is converted from milliseconds to seconds');
  l.sim.setRunTime(Infinity);
  eq(l.sim._nowStep(), 0, 'and cleared back to the resting clock');
}

console.log('\nThe client view carries the deadline too:');
{
  const l = lab();
  l.at(10000);   // the lease has to exist before the client can report it
  const out = l.show(l.pc1, 'show ip dhcp binding');
  match(/Lease +: 60s/, out, 'the client still reports the configured length');
  match(/Expires in +: 60s/, out, 'and now also how long is left');
  l.at(30000);
  const later = l.show(l.pc1, 'show ip dhcp binding');
  match(/Expires in +: 40s/, later, 'which counts down with the instant');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
