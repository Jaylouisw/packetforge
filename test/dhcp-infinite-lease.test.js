'use strict';
// `lease infinite` -- the vendor's second form of a command this console knew only one of (#fidelity: lease
// infinite).
//
// The Cisco IOS IP Addressing Services Command Reference states the command as
// `lease {days [hours [minutes]] | infinite}`, with `infinite` meaning "the duration of the lease is unlimited"
// (https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr/command/ipaddr-cr-book/ipaddr-l1.html). This console
// parsed the three numbers and nothing else, so the word an operator of a printer pool types was refused as
// `Incomplete command: lease <days> [hours] [minutes]` -- a diagnosis of a missing argument for a command that had
// been typed in full. The word is now a value the pool carries, the running-config gives it back as the word, and a
// lease granted under it never lapses: RFC 2131 section 3.3 reserves 0xffffffff to represent "infinity", which is
// what the handshake carries and what the binding table reports.
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
const ROUTER = specs.find(function (s) { return /ISR 4331/.test(s.model); });
const HOST = specs.find(function (s) {
  return /^(pc|host|endpoint|workstation)/i.test(s.category || '') && s.model;
}) || specs.find(function (s) { return /endpoint|host|PC/i.test((s.category || '') + s.model); });

const MAC_A = '02:00:00:00:00:0a';
const MAC_B = '02:00:00:00:00:0b';

function lab(poolCmds) {
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

  t.getDevice('h1').interfaces.get(firstFree('h1')).mac = MAC_A;
  t.getDevice('h2').interfaces.get(firstFree('h2')).mac = MAC_B;
  t.getDevice('h1').interfaces.get(firstFree('h1')).dhcp = true;
  t.getDevice('h2').interfaces.get(firstFree('h2')).dhcp = true;
  return t;
}
function show(t, sim, cmd) {
  return ((new CliSession(t.getDevice('r1'), t, sim).run(cmd) || {}).output || []).join('\n');
}
function apply(poolCmds) {
  const t = new Topology();
  t.addDevice(ROUTER, 'r1');
  const s = new CliSession(t.getDevice('r1'), t, null);
  ['enable', 'configure terminal'].concat(poolCmds).forEach(function (c) { s.run(c); });
  return { t: t, s: s };
}
const POOL = function (leaseLine) {
  return ['ip dhcp pool lan', 'network 192.168.10.0 255.255.255.0', 'default-router 192.168.10.1',
    'range 192.168.10.100 192.168.10.100', leaseLine, 'exit'];
};

console.log('');
console.log('The word is a value, and the config gives it back:');
{
  const env = apply(POOL('lease infinite'));
  env.s.run('end');
  const text = ((env.s.run('show running-config') || {}).output || []).join('\n');
  ok(/^\s+lease infinite$/m.test(text), 'the pool keeps `lease infinite` as the word it was given', text);
  ok(!/^\s+lease \d/m.test(text), 'and does not invent a number for it', text);
  const pool = ((env.s.run('show ip dhcp pool lan') || {}).output || []).join('\n');
  ok(/Lease:\s+Infinite \(never expires\)/.test(pool), 'the pool view says the lease never expires', pool);
  ok(!/Lease:\s+default/.test(pool), 'it no longer reads as an unset lease', pool);
  ok(!/E_DHCP_BAD_LEASE/.test(pool), 'and the pool is not reported as invalid', pool);
}

console.log('');
console.log('`no lease` puts the default back:');
{
  const env = apply(POOL('lease infinite').concat(['ip dhcp pool lan', 'no lease', 'exit']));
  env.s.run('end');
  const cfg = ((env.s.run('show running-config') || {}).output || []).join('\n');
  ok(!/lease infinite/.test(cfg), 'the line is gone from the saved configuration', cfg);
  const pool = ((env.s.run('show ip dhcp pool lan') || {}).output || []).join('\n');
  ok(/Lease:\s+86400s/.test(pool), 'and the pool is back on the 1-day default', pool);
}

console.log('');
console.log('A lease granted under it never lapses:');
{
  const t = lab(POOL('lease infinite'));
  const sim = new Simulator(t);
  sim.runAtMs = 1000;
  sim.computeDhcp();
  const first = sim.dhcpBindings('r1');
  ok(first.length === 1, 'the only address in the pool went to h1', JSON.stringify(first));
  ok(first[0] && first[0].mac === MAC_A, 'and to the host that asked first', JSON.stringify(first));
  ok(first[0] && first[0].leaseSec === 0xFFFFFFFF,
    'the lease time is the value RFC 2131 reserves for infinity', String(first[0] && first[0].leaseSec));

  // h1 goes quiet (as if it were unplugged); a hundred seconds later h2 asks for an address. Under a one-minute
  // lease the address would be back in the pool - here it cannot be, because the lease has no end.
  t.getDevice('h1').interfaces.forEach(function (i) { i.dhcp = false; });
  sim.runAtMs = 101000;
  sim.computeDhcp();
  const later = sim.dhcpBindings('r1');
  ok(later.some(function (b) { return b.mac === MAC_A; }),
    'the binding is still there a hundred seconds later', JSON.stringify(later));
  ok(!later.some(function (b) { return b.mac === MAC_B; }),
    'and the second host is not given a second address', JSON.stringify(later));

  const text = show(t, sim, 'show ip dhcp binding');
  ok(/Infinite/.test(text), 'the binding table prints the word for the lease that has no end', text);
  ok(!/lapsed/.test(text), 'nothing in the table is lapsed', text);
  ok(/1 active binding/.test(text), 'and the count agrees', text);
}

console.log('');
console.log('The same lab with a one-minute lease gives the address back (the contrast):');
{
  const t = lab(POOL('lease 0 0 1'));
  const sim = new Simulator(t);
  sim.runAtMs = 1000;
  sim.computeDhcp();
  t.getDevice('h1').interfaces.forEach(function (i) { i.dhcp = false; });
  sim.runAtMs = 101000;
  sim.computeDhcp();
  const later = sim.dhcpBindings('r1');
  ok(!later.some(function (b) { return b.mac === MAC_A; }), 'the lapsed lease is gone', JSON.stringify(later));
  ok(later.some(function (b) { return b.mac === MAC_B; }), 'and the address went to the other host',
    JSON.stringify(later));
}

console.log('');
console.log('A saved document restores the unlimited lease as unlimited:');
{
  const t = lab(POOL('lease infinite'));
  const sim = new Simulator(t);
  sim.runAtMs = 1000;
  sim.computeDhcp();
  const state = sim._dhcpStates.get('r1');
  const doc = JSON.parse(JSON.stringify(dhcp.leaseStateToJSON(state)));
  ok(doc.leases.length === 1 && doc.leases[0].expiresStep === 'infinite',
    'the document writes the word, because JSON has no Infinity', JSON.stringify(doc.leases));
  const restored = dhcp.leaseStateFromJSON(doc);
  const rows = dhcp.leaseTable(restored, 1000 + 86400 * 365);
  ok(rows.length === 1 && rows[0].state === 'active',
    'and a year later the restored lease is still active', JSON.stringify(rows));
  ok(dhcp.expireLeases(restored, 1000 + 86400 * 365) === 0, 'expiry collects nothing');
}

console.log('');
console.log('The refusals name both forms, and a zero duration is still refused:');
{
  const env = apply(['ip dhcp pool lan']);
  const out = ((env.s.run('lease infinite 5') || {}).output || []).join('\n');
  ok(/Invalid input/.test(out), 'a word with a number after it is refused', out);
  ok(/infinite/.test(out), 'and the refusal names the form that does take the word', out);
  const out2 = ((env.s.run('lease 0') || {}).output || []).join('\n');
  ok(/longer than zero/.test(out2), '`lease 0` is still a zero-length lease, not a synonym', out2);
  const out3 = ((env.s.run('lease') || {}).output || []).join('\n');
  ok(/infinite/.test(out3), 'and the incomplete-command line advertises the word', out3);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
