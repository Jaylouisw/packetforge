'use strict';
// route-lookup.test.js — `show ip route <dest>`: the lookup, not the table.
//
// The table answers "what is installed". The question an operator actually asks when something is
// unreachable is "what would this box do with *this* address, and why" — which needs the longest
// match, the covering prefix, the next hop, and the reason the winner won. Nothing in the console
// answered that: you could read the table and infer it, or ping and guess.
//
// The answer comes from `routeTo()`, the same call the data path makes, and the candidates come
// from `routesTable()` with the administrative distances attached. So this file checks the lookup
// against the data path rather than against a transcript: a lookup that disagrees with `routeTo()`
// would be worse than no lookup at all, because it would be confidently wrong about forwarding.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { Device } = require('../engine/device');
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
function field(text, name) {
  const m = new RegExp('^  ' + name + ' +(.*)$', 'm').exec(text);
  return m ? m[1] : null;
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const model = (n) => catalog.find((x) => x.model === n);

// R1 -- R2. R2 owns 10.0.99.0/24 and 10.0.77.0/24; R1 has a static route for 10.0.99.0/24 as well,
// so one prefix has two candidates and the other has one.
const t = new Topology();
const r1 = t.addDevice(model('generic-router'));
const r2 = t.addDevice(model('generic-router'));
r1.name = 'R1'; r2.name = 'R2';
t.connect(r1.id, 'Gi0/0', r2.id, 'Gi0/0');
const sim = new Simulator(t);
function cli(cmds) {
  return runCommands(r1, t, sim, ['enable'].concat(cmds)).lines.filter(function (l) {
    return !/^[A-Za-z0-9_.() -]+[>#]/.test(l);
  }).join('\n');
}
const cfg1 = ['enable', 'configure terminal', 'ospf router-id 1.1.1.1', 'ospf area 0',
  'interface Gi0/0', 'ip address 10.0.12.1 255.255.255.0', 'ip ospf area 0', 'exit',
  'ip route 10.0.99.0 255.255.255.0 10.0.12.2', 'exit'];
const cfg2 = ['enable', 'configure terminal', 'ospf router-id 2.2.2.2', 'ospf area 0',
  'interface Gi0/0', 'ip address 10.0.12.2 255.255.255.0', 'ip ospf area 0', 'exit',
  'interface Gi0/1', 'ip address 10.0.99.1 255.255.255.0', 'ip ospf area 0', 'exit',
  'interface Gi0/2', 'ip address 10.0.77.1 255.255.255.0', 'ip ospf area 0', 'exit', 'exit'];
ok(!runCommands(r1, t, sim, cfg1).lines.some(function (l) { return /^%/.test(l); }),
  'the R1 half of the lab is accepted');
ok(!runCommands(r2, t, sim, cfg2).lines.some(function (l) { return /^%/.test(l); }),
  'and the R2 half');
cli(['show ip route at converged']);   // converge once, so the table has OSPF rows

console.log('A lookup names the covering prefix, the next hop, and the reason:');
{
  const out = cli(['show ip route 10.0.99.5']);
  eq(field(out, 'Destination'), '10.0.99.5', 'the address that was asked about is quoted back');
  eq(field(out, 'Matched'), '10.0.99.0/24  (static, AD ' + Device.ADMIN_DISTANCE.static + ')',
    'the longest match is named, with its source and distance');
  eq(field(out, 'Next hop'), '10.0.12.2', 'the next hop is named');
  eq(field(out, 'Interface'), '-', 'and the egress interface (none, for a gateway-only static route)');
  match(/^ {2}Shadowed +O 10\.0\.99\.0\/24 {2}\(OSPF, AD 110\)$/m, out,
    'the OSPF candidate is listed as shadowed, so the reader knows it exists and does not forward');
}

console.log('\nAn OSPF-only prefix matches the OSPF route:');
{
  const out = cli(['show ip route 10.0.77.9']);
  eq(field(out, 'Matched'), '10.0.77.0/24  (OSPF, AD 110)', 'the match is the OSPF route');
  eq(field(out, 'Next hop'), '10.0.12.2', 'with its next hop');
  eq(field(out, 'Interface'), 'Gi0/0', 'and the interface it uses');
  ok(field(out, 'Shadowed') === null, 'and nothing shadows it, so no Shadowed line appears');
}

console.log('\nA directly connected address says so:');
{
  const out = cli(['show ip route 10.0.12.7']);
  eq(field(out, 'Matched'), '10.0.12.0/24  (connected, AD 0)', 'the connected route matches at distance 0');
  eq(field(out, 'Next hop'), '- (directly connected)', 'and there is no next hop to name');
  eq(field(out, 'Interface'), 'Gi0/0', 'only the interface');
}

console.log('\nThe lookup agrees with the data path:');
{
  for (const addr of ['10.0.12.7', '10.0.99.5', '10.0.77.9']) {
    const route = r1.routeTo(addr);
    ok(!!route, 'routeTo() answers for ' + addr);
    const out = cli(['show ip route ' + addr]);
    const matched = field(out, 'Matched') || '';
    ok(matched.indexOf('/' + route.prefix) !== -1,
      addr + ': the lookup matches a /' + route.prefix + ' (' + matched + ')');
    eq(field(out, 'Interface'), route.iface || '-', addr + ': and the same interface routeTo() returns');
    if (route.type !== 'connected') {
      eq(field(out, 'Next hop'), route.via, addr + ': and the same next hop');
    }
    ok(matched.indexOf('AD ' + route.ad + ')') !== -1,
      addr + ': the distance printed is the one routeTo() decided with (' + route.ad + ')');
  }
}

console.log('\nThe prefix forms answer "what is in the table for this prefix":');
{
  const slash = cli(['show ip route 10.0.99.0/24']);
  match(/^ {2}\* {2}Prefix +AD +Gateway +Interface$/m, slash, 'address/length prints the candidate table');
  match(/^ {2}\* {2}S 10\.0\.99\.0\/24 {2}1 /m, slash, 'with the static route marked installed');
  match(/^ {5}O 10\.0\.99\.0\/24 {2}110 /m, slash, 'and the OSPF candidate unmarked');

  const dotted = cli(['show ip route 10.0.99.0 255.255.255.0']);
  eq(dotted, slash, 'a dotted mask prints exactly the same answer');

  const hostBits = cli(['show ip route 10.0.99.5/24']);
  eq(hostBits, slash, 'host bits in the prefix are canonicalised, not refused');

  const one = cli(['show ip route 10.0.77.0/24']);
  match(/^ {2}\* {2}O 10\.0\.77\.0\/24 {2}110 /m, one, 'a prefix with one candidate prints one row');
}

console.log('\nNo route is a refusal, not an empty table:');
{
  const out = cli(['show ip route 172.16.0.1']);
  eq(out, '% No route to 172.16.0.1\n% No default route is configured on this device',
    'an unreachable address is refused and the missing default route is named');
  const none = cli(['show ip route 192.0.2.0/24']);
  eq(none, '% No route for 192.0.2.0/24 in the table', 'an absent prefix says so and quotes the prefix');
}

console.log('\nA default route changes the answer:');
{
  cli(['configure terminal', 'ip route 0.0.0.0 0.0.0.0 10.0.12.2', 'exit']);
  const out = cli(['show ip route 172.16.0.1']);
  eq(field(out, 'Matched'), '0.0.0.0/0  (static, AD 1)', 'the default route matches, with its distance');
  eq(field(out, 'Next hop'), '10.0.12.2', 'and names the next hop');
  const table = cli(['show ip route 0.0.0.0/0']);
  match(/^ {2}\* {2}S 0\.0\.0\.0\/0 {2}1 /m, table, 'and the prefix form finds it in the table');
  cli(['configure terminal', 'no ip route 0.0.0.0 0.0.0.0', 'exit']);
}

console.log('\nMalformed input is refused in this command\u2019s own words:');
{
  eq(cli(['show ip route 10.0.0.999']).split('\n')[0], '% Invalid destination: 10.0.0.999',
    'an address with an octet out of range is a malformed address, not an unknown host');
  match(/^% Invalid destination: nonsense$/m, cli(['show ip route nonsense']),
    'so is a word');
  eq(cli(['show ip route 10.0.99.5/33']), '% Invalid prefix length: 33', 'a /33 is refused');
  eq(cli(['show ip route 10.0.99.0 255.0.255.0']),
    '% Invalid mask: 255.0.255.0 (not a contiguous netmask)', 'a holey mask is refused');
  eq(cli(['show ip route 10.0.99.5/24 junk']).split('\n')[0],
    '% Usage: show ip route [<dest> | <dest>/<len> | <dest> <mask>] [at <ms>|converged]',
    'a third word is a usage error');
}

console.log('\nThe lookup respects the instant:');
{
  const early = cli(['show ip route 10.0.77.9 at 0']);
  match(/^Routes at t=0 ms \(control planes rebuilt for this answer\)$/m, early,
    'the instant label still leads the answer');
  match(/^% No route to 10\.0\.77\.9$/m, early,
    'and before OSPF converges the OSPF-only network has no route at all');
  const later = cli(['show ip route 10.0.77.9 at converged']);
  eq(field(later, 'Matched'), '10.0.77.0/24  (OSPF, AD 110)', 'while at convergence it matches the OSPF route');
}

console.log('\nThe table itself never gained an argument it ignores:');
{
  const plain = cli(['show ip route']);
  match(/^ {2}\* {2}Prefix +AD/m, plain, 'the bare form still prints the whole table');
  ok(!/Destination/.test(plain), 'and not a lookup header');
}

console.log('\nThe command is discoverable:');
{
  match(/show ip route \[<dest>\|connected/, cli(['?']),
    'help lists the destination and the protocol selectors');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
