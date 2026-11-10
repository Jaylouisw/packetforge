'use strict';
// dhcp-relay.test.js — making a DISCOVER cross a router.
//
// A DHCPDISCOVER is a broadcast, so it dies at the first router. That is why `ip helper-address`
// exists: the router on the wire re-sends the request as a unicast to a server elsewhere, stamping
// its own port address into `giaddr` so the server knows which subnet to allocate from. This model
// had none of it, and `docs/SIMULATION.md` listed DHCP relay as absent — a lab with a central server
// and a remote subnet simply never worked, and answered `no-server`.
//
// The parts worth testing are the ones that make a relay a relay rather than a wider broadcast:
//   * nothing happens without the helper (the client stays unaddressed, honestly);
//   * the server picks its pool from *giaddr*, not from its own interface — a server with pools for
//     two subnets must hand out an address for the far one;
//   * the lease says where it came from, on both ends;
//   * the data path then works, which is the only reason any of it matters;
//   * `show running-config` emits the helper, or a pasted dump silently loses the relay.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
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

// PC1 --- R1 --- SRV. The server is one hop away with no interface on the client's subnet, which is
// the whole point: its pool is 10.0.1.0/24 and it lives on 10.0.2.0/24.
function lab(opts) {
  const o = opts || {};
  const t = new Topology();
  const r1 = t.addDevice(model('generic-router'));
  const pc1 = t.addDevice(model('generic-pc'));
  const srv = t.addDevice(model('generic-router'));
  r1.name = 'R1'; pc1.name = 'PC1'; srv.name = 'SRV';
  t.connect(pc1.id, 'eth0', r1.id, 'Gi0/0');
  t.connect(r1.id, 'Gi0/1', srv.id, 'Gi0/0');
  const sim = new Simulator(t);

  const r1cfg = ['enable', 'configure terminal',
    'interface Gi0/0', 'ip address 10.0.1.1 255.255.255.0'];
  if (o.helper) r1cfg.push('ip helper-address ' + o.helper);
  r1cfg.push('exit', 'interface Gi0/1', 'ip address 10.0.2.1 255.255.255.0', 'exit', 'exit');
  const refusals = [];
  for (const l of runCommands(r1, t, sim, r1cfg).lines) if (/^%/.test(l)) refusals.push(l);

  const srvCfg = ['enable', 'configure terminal',
    'interface Gi0/0', 'ip address 10.0.2.2 255.255.255.0', 'exit',
    'ip dhcp pool remote', 'network 10.0.1.0 255.255.255.0',
    'range 10.0.1.100 10.0.1.110', 'default-router 10.0.1.1', 'lease 0 0 10', 'exit'];
  if (o.secondPool) {
    srvCfg.push('ip dhcp pool local', 'network 10.0.2.0 255.255.255.0',
      'range 10.0.2.100 10.0.2.110', 'default-router 10.0.2.2', 'exit');
  }
  srvCfg.push('ip route 10.0.1.0 255.255.255.0 10.0.2.1', 'exit');
  for (const l of runCommands(srv, t, sim, srvCfg).lines) if (/^%/.test(l)) refusals.push(l);

  for (const l of runCommands(pc1, t, sim, ['enable', 'configure terminal', 'interface eth0',
    'ip address dhcp', 'exit', 'exit']).lines) if (/^%/.test(l)) refusals.push(l);

  sim.refreshControlPlanes({ ra: true, lldp: true });
  function show(dev, cmd) {
    return runCommands(dev, t, sim, ['enable', cmd]).lines
      .filter((l) => !/^[A-Za-z0-9_.() -]+[>#]/.test(l)).join('\n');
  }
  return { t, r1, pc1, srv, sim, show, refusals, ip: () => pc1.interfaces.get('eth0').ip };
}

console.log('Without a helper, nothing crosses the router:');
{
  const l = lab({});
  eq(l.refusals.length, 0, 'the lab config is accepted');
  eq(l.ip(), null, 'the client has no address: there is no server on its wire');
  match(/no-server/, JSON.stringify(l.sim.events.filter((e) => e.type === 'dhcp')),
    'and the exchange failed for the honest reason');
}

console.log('\nWith one, the client gets an address from the far pool:');
{
  const l = lab({ helper: '10.0.2.2' });
  eq(l.ip(), '10.0.1.100', 'the client is addressed from the remote pool');
  const ack = l.sim.events.filter((e) => e.type === 'dhcp' && e.phase === 'ack')[0];
  ok(ack !== undefined, 'an ACK was recorded');
  eq(ack.relayed, true, 'and it is marked as relayed');
  eq(ack.giaddr, '10.0.1.1', 'with giaddr set to the relay port, not the client address');
  eq(ack.relayName, 'R1', 'and the relay named');
  const out = l.show(l.srv, 'show ip dhcp binding');
  match(/10\.0\.1\.100/, out, 'the server holds the binding');
  match(/1 binding arrived through a relay: 10\.0\.1\.100 via giaddr 10\.0\.1\.1/, out,
    'and says it arrived through a relay, from which subnet');
}

console.log('\nThe pool is chosen by giaddr, not by the server\'s own interface:');
{
  // The server has pools for both subnets. Without giaddr it would hand out 10.0.2.x - an address on
  // the wrong side of the router, which the client could never use.
  const l = lab({ helper: '10.0.2.2', secondPool: true });
  eq(l.ip(), '10.0.1.100', 'the address comes from the pool covering giaddr');
  ok(/^10\.0\.1\./.test(l.ip()), 'and is in the client\'s subnet, not the server\'s');
  const out = l.show(l.srv, 'show ip dhcp binding');
  match(/remote/, out, 'the binding names the pool that matched giaddr');
  ok(!/local/.test(out), 'not the pool for the server\'s own wire');
}

console.log('\nBoth ends say how the lease was obtained:');
{
  const l = lab({ helper: '10.0.2.2' });
  const client = l.show(l.pc1, 'show ip dhcp binding');
  match(/Server +: 10\.0\.2\.2/, client, 'the client names the server');
  match(/Relayed via +: Gi0\/0 on R1 +\(giaddr 10\.0\.1\.1\)/, client,
    'and the port that relayed it, with the giaddr it wrote');
  // The relay itself is neither a server nor a client; it has its own answer.
  const relay = l.show(l.r1, 'show ip dhcp binding');
  match(/^DHCP relay on R1:$/m, relay, 'the relay names itself as a relay');
  match(/^ {2}Gi0\/0 +-> +10\.0\.2\.2$/m, relay, 'and shows which port forwards where');
  ok(!/not a DHCP server/.test(relay),
    'instead of the old "not a DHCP server (no pools)", which was true and useless');
}

console.log('\nThe data path works afterwards, which is the point:');
{
  const l = lab({ helper: '10.0.2.2' });
  const res = l.sim.ping(l.pc1.id, '10.0.2.2', { count: 2 });
  const good = res.replies.filter((r) => r.success).length;
  eq(good, 2, 'the client can ping the server that leased it an address');
  ok(res.replies.every((r) => r.success), 'every reply arrived, not just some');
}

console.log('\nThe relay is configured, refused and removed like a real one:');
{
  const t = new Topology();
  const r1 = t.addDevice(model('generic-router'));
  r1.name = 'R1';
  const sim = new Simulator(t);
  const out = runCommands(r1, t, sim, ['enable', 'configure terminal', 'interface Gi0/0',
    'ip helper-address',
    'ip helper-address 300.1.1.1',
    'ip helper-address junk',
    'ip helper-address 10.0.2.2',
    'ip helper-address 10.0.2.2',
    'no ip helper-address 10.9.9.9',
    'no ip helper-address junk',
    'no ip helper-address 10.0.2.2',
    'no ip helper-address']).lines.join('\n');
  match(/% Incomplete command: ip helper-address <addr>/, out, 'a missing address is incomplete');
  match(/% Invalid helper address "300\.1\.1\.1"/, out, 'an octet above 255 is refused');
  match(/% Invalid helper address "junk"/, out, 'a word is refused');
  match(/Helper address 10\.0\.2\.2 on Gi0\/0/, out, 'a good address is accepted and confirmed');
  match(/Helper address 10\.0\.2\.2 is already set on Gi0\/0/, out,
    'setting it twice says so instead of silently doubling it');
  match(/% No helper address 10\.9\.9\.9 on Gi0\/0 \(set: 10\.0\.2\.2\)/, out,
    'removing one that is not there is refused, and names what is');
  match(/Helper address 10\.0\.2\.2 removed from Gi0\/0/, out, 'the right one is removed');
  eq(r1.interfaces.get('Gi0/0').helperAddresses.length, 0, 'and the port is left with none');
  match(/% No helper address on Gi0\/0/, out,
    'clearing a port that has none is a refusal, not a cheerful no-op');
}

console.log('\nThe dump carries the relay:');
{
  const l = lab({ helper: '10.0.2.2' });
  const dump = l.show(l.r1, 'show running-config');
  match(/^ {2}ip helper-address 10\.0\.2\.2$/m, dump,
    'show running-config emits the helper under the port');
  // Paste it into a fresh device: the relay must survive the round trip.
  const t2 = new Topology();
  const clone = t2.addDevice(model('generic-router'));
  clone.name = 'R2';
  const sim2 = new Simulator(t2);
  const lines = dump.split('\n').map((s) => s.trim()).filter(Boolean);
  const replay = runCommands(clone, t2, sim2, ['enable', 'configure terminal'].concat(lines)).lines;
  eq(replay.filter((x) => /^%/.test(x)).length, 0, 'the pasted dump produces no refusals');
  ok((clone.interfaces.get('Gi0/0').helperAddresses || []).indexOf('10.0.2.2') !== -1,
    'and the helper is configured on the clone');
}

console.log('\nA relay with nothing to relay to stays honest:');
{
  // The helper names an address no device owns: the request is not relayable, so the client keeps
  // its `no-server` answer rather than being handed an address out of nowhere.
  const l = lab({ helper: '10.9.9.9' });
  eq(l.ip(), null, 'no address, because no server owns the helper address');
  match(/no-server/, JSON.stringify(l.sim.events.filter((e) => e.type === 'dhcp')),
    'and the failure is still reported as no-server');
}

console.log('\nThe command is discoverable:');
{
  const t = new Topology();
  const r1 = t.addDevice(model('generic-router'));
  r1.name = 'R1';
  const sim = new Simulator(t);
  const help = runCommands(r1, t, sim, ['enable', 'configure terminal', 'interface Gi0/0', '?'])
    .lines.join('\n');
  match(/ip helper-address <addr> \| no ip helper-address \[<addr>\]/, help,
    'interface-mode help lists both forms');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
