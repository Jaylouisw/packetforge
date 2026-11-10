'use strict';
// refused-where-typed.test.js - a value that is already wrong should be refused at the keystroke,
// not two commands later in the validator's vocabulary.
//
// Measured before this pass, on a `generic-router` named R1:
//   dns add www A abc              -> "Added www A abc to example.test"   (validateZone() in
//                                     engine/dns.js calls the same record "not a dotted-quad IPv4
//                                     address"), and then `ping www.example.test` printed
//                                     "Sending 4, 100-byte ICMP Echos to abc" - the resolver handed a
//                                     non-address to the data path.
//   dns add note TXT hello world   -> stored "hello"; "world" was dropped in silence.
//   dns add lab MX mail.lab.test   -> stored a host with no preference, which the library rejects,
//                                     and running-config emitted the same unusable line.
//   network abc / default-router abc / dns-server abc   (in a DHCP pool) -> stored in silence
//   range 10.6.0.50 10.6.0.10                           -> stored in silence
//   exit                                                -> "% E_DHCP_RANGE_ORDER: DHCP pool BAD:
//                                                           rangeStart 10.6.0.50 is above rangeEnd ..."
//   hostname                                            -> nothing at all, and it cleared
//                                                          config.hostname while device.name kept the
//                                                          old label, so the two disagreed.
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

function router(name) {
  const t = new Topology();
  const d = t.addDevice(ROUTER); d.name = name || 'R1';
  const sim = new Simulator(t);
  const s = new CliSession(d, t, sim); s.run('enable'); s.run('configure terminal');
  return { t: t, d: d, sim: sim, s: s };
}

console.log('\nA DNS record is judged by the library that will answer for it:');
{
  const env = router();
  const s = env.s;
  eq(s.run('dns zone example.test').output[0], 'DNS zone example.test ready', 'a zone exists');
  const bad = s.run('dns add www A abc').output;
  eq(bad[0], '% www.example.test A: "abc" is not a dotted-quad IPv4 address.',
    'an A record whose value is a word is refused by name, with the record named');
  eq(bad[1], '% www A abc was not added to example.test', 'and the record is not added');
  ok(!/Added/.test(bad.join('\n')), 'and nothing claims it was added');
  eq(env.d.config.dnsZones[0].records.length, 0, 'the zone is unchanged');

  eq(s.run('dns add www A 10.0.0.999').output[0],
    '% www.example.test A: "10.0.0.999" is not a dotted-quad IPv4 address.',
    'an address-shaped word is refused too, because the parser has the final word');
  eq(s.run('dns add www A 10.0.0.5').output[0], 'Added www A 10.0.0.5 to example.test',
    'a real address is accepted');

  eq(s.run('dns add note TXT hello world').output[0], 'Added note TXT hello world to example.test',
    'a TXT value keeps its spaces');
  eq(env.d.config.dnsZones[0].records.filter(function (r) { return r.type === 'TXT'; })[0].value,
    'hello world', 'and the stored value is the whole line, not the first word');

  const noPref = s.run('dns add lab MX mail.lab.test').output;
  eq(noPref[0], '% An MX record needs a preference before the host', 'an MX without a preference is refused');
  eq(s.run('dns add lab MX 10 mail.lab.test').output[0], 'Added lab MX 10 mail.lab.test to example.test',
    'and one with a preference is accepted');
  const mx = env.d.config.dnsZones[0].records.filter(function (r) { return r.type === 'MX'; })[0];
  eq(mx.priority, 10, 'the preference is stored as a number');
  eq(mx.value, 'mail.lab.test', 'and the host as the value');

  eq(s.run('dns add dup A 10.0.0.5').output[0], 'Added dup A 10.0.0.5 to example.test', 'a second name is added');
  const dup = s.run('dns add dup A 10.0.0.5').output;
  ok(/duplicate record/.test(dup[0]), 'adding it twice is refused as a duplicate');
  const conflict = s.run('dns add www CNAME other.test').output;
  ok(/CNAME must be the only record at its owner name/.test(conflict[0]),
    'and a CNAME that would coexist with an A record is refused');

  s.run('exit');
  const shown = s.run('show dns').output.join('\n');
  ok(/lab\s+MX\s+10 mail\.lab\.test/.test(shown), 'show dns prints the MX preference with the host');
  ok(/note\s+TXT\s+hello world/.test(shown), 'and the whole TXT value');
  const dump = s.run('show running-config').output.filter(function (l) { return /^dns add/.test(l); });
  ok(dump.indexOf('dns add lab MX 10 mail.lab.test') !== -1,
    'running-config emits the preference, so the dump can be pasted back into itself');
  ok(dump.indexOf('dns add note TXT hello world') !== -1, 'and the whole TXT value');
}

console.log('\nA record that cannot be replayed is a record the console invented:');
{
  // Paste the dump into a fresh router: every line must be accepted, and the zone must come out
  // identical. This is what makes the running-config assertions above worth anything.
  const first = router('R1');
  first.s.run('dns zone example.test');
  first.s.run('dns add www A 10.0.0.5');
  first.s.run('dns add note TXT hello world');
  first.s.run('dns add lab MX 10 mail.lab.test');
  first.s.run('end');
  const dump = first.s.run('show running-config').output
    .filter(function (l) { return /^dns /.test(l); });

  const second = router('R2');
  const answers = [];
  for (const line of dump) answers.push(second.s.run(line).output.join(' | '));
  second.s.run('end');
  const refused = answers.filter(function (a) { return /^%/.test(a); });
  eq(refused.length, 0, 'every dumped line is accepted by a fresh device');
  eq(JSON.stringify(second.d.config.dnsZones), JSON.stringify(first.d.config.dnsZones),
    'and the zone is identical');
}

console.log('\nA pre-existing complaint in the zone does not block a good record:');
{
  // Hand-written configuration (a topology file, an API call) can contain a record the console
  // would refuse. The edit gate compares the zone before and after, so it can still be repaired.
  const env = router();
  env.d.config.dnsZones.push({ name: 'broken.test', defaultTtl: 3600,
    records: [{ name: 'bad', type: 'A', ttl: 3600, value: 'not-an-address' }] });
  const s = env.s;
  s.run('dns zone broken.test');
  eq(s.run('dns add good A 10.0.0.7').output[0], 'Added good A 10.0.0.7 to broken.test',
    'a good record is accepted into a zone that already has a bad one');
  eq(env.d.config.dnsZones[0].records.length, 2, 'and both records are stored');
}

console.log('\nThe resolver refuses to hand a non-address to the data path:');
{
  const env = router();
  env.d.config.dnsZones.push({ name: 'broken.test', defaultTtl: 3600,
    records: [{ name: 'www', type: 'A', ttl: 3600, value: 'abc' }] });
  const s = new CliSession(env.d, env.t, env.sim); s.run('enable');
  const out = s.run('ping www.broken.test count 1').output.join('\n');
  ok(/which is not an address/.test(out), 'ping refuses with the record named');
  ok(!/Echos to abc/.test(out), 'and never prints "Echos to abc"');
}

console.log('\nA DHCP pool refuses a wrong value while it is being typed:');
{
  const env = router();
  const s = env.s;
  s.run('ip dhcp pool P1');
  const bad = s.run('network abc').output;
  eq(bad[0], '% "abc" is not an IPv4 address, so it cannot be the pool\'s network',
    'network with a word is refused by name');
  const pool = env.d.config.dhcpPools[0];
  eq(pool.network, undefined, 'and nothing is stored');
  eq(s.run('network 10.5.0.0 abc').output[0],
    '% "abc" is not a subnet mask (e.g. 255.255.255.0 or /24)', 'a bad mask is refused');
  eq(s.run('network 10.5.0.0 255.255.255.0').output.length, 0,
    'a real network is accepted in silence, like the rest of the sub-mode');
  eq(pool.network, '10.5.0.0', 'and stored');

  eq(s.run('default-router abc').output[0],
    '% "abc" is not an IPv4 address, so it cannot be the default router', 'a bad default router is refused');
  eq(pool.gateway, undefined, 'and not stored');
  eq(s.run('dns-server abc').output[0], '% "abc" is not an IPv4 address, so it cannot be a DNS server',
    'a bad DNS server is refused');
  eq(s.run('dns-server 1.1.1.1 2.2.2.2').output.length, 0, 'two real ones are accepted');
  eq(pool.dns, '1.1.1.1 2.2.2.2', 'and stored as written');

  const reversed = s.run('range 10.5.0.50 10.5.0.10').output;
  eq(reversed[0], '% The range starts at 10.5.0.50 and ends at 10.5.0.10 - the start must not be above the end',
    'a reversed range is refused while both values are still on the line');
  ok(!/E_DHCP/.test(reversed.join('\n')), 'without a validator code in the answer');
  eq(s.run('range 10.5.0.10 abc').output[0], '% "abc" is not an IPv4 address, so it cannot be the end of the range',
    'a bad end of range is named');
  eq(s.run('excluded-address abc').output[0], '% "abc" is not an IPv4 address, so it cannot be an excluded address',
    'a bad excluded address is named');
  eq(s.run('range 10.5.0.10 10.5.0.20').output.length, 0, 'a real range is accepted');
  eq(s.run('excluded-address 10.5.0.1-10.5.0.9').output.length, 0, 'and a real excluded range');
  eq(s.run('exit').output.length, 0, 'the pool is valid, so leaving it says nothing');
  eq(env.d.config.dhcpPools.length, 1, 'and it is kept');
}

console.log('\nAn incomplete pool is still allowed, and its complaints are sentences:');
{
  const env = router();
  const s = env.s;
  s.run('ip dhcp pool HALF');
  eq(s.run('network 10.6.0.0 255.255.255.0').output.length, 0,
    'network before range is a partial pool, not an error');
  const exitOut = s.run('exit').output;
  ok(/no address range was given/.test(exitOut[0]),
    'leaving an incomplete pool says which piece is missing, in the console\'s words');
  ok(!/E_DHCP/.test(exitOut.join('\n')), 'with no validator code');
  ok(!/rangeStart|rangeEnd/.test(exitOut.join('\n')), 'and no data-model field names');
  eq(env.d.config.dhcpPools.length, 0, 'the invalid pool does not survive');
}

console.log('\nhostname with no name is not a rename:');
{
  const env = router('R1');
  const s = env.s;
  const out = s.run('hostname').output;
  eq(out[0], '% Incomplete command: hostname <name>', 'a bare hostname is incomplete');
  eq(env.d.name, 'R1', 'the label is unchanged');
  eq(env.d.config.hostname === undefined ? null : env.d.config.hostname, null,
    'and config.hostname was not cleared or set - the two still agree');
  eq(s.run('hostname core switch 1').output.length, 0, 'a name with spaces is accepted');
  eq(env.d.name, 'core switch 1', 'and kept whole');
  eq(env.d.config.hostname, env.d.name, 'with config.hostname and the label equal');
  s.run('end');
  eq(s.run('show running-config').output[1], 'hostname core switch 1',
    'and it is the first line of running-config');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
