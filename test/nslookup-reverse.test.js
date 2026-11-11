'use strict';
// nslookup-reverse.test.js - `nslookup <address>` is a reverse lookup.
//
//   R1#nslookup 10.0.0.53
//   Server: SRV1
//     ** server failure: no DNS server in this lab hosts a zone for 10.0.0.53
//
// A PTR record could be configured in a reverse zone and never reachable: the address was asked as
// if it were a hostname spelled with dots, so the zone that held the answer was never consulted. A
// reverse lookup is a different *name* (RFC 1035), not a different kind of question - `10.0.0.53` is
// asked as `53.0.0.10.in-addr.arpa`, an IPv6 address as its 32 nibbles under `ip6.arpa`.
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

// SRV1 serves two zones: the forward one, and the reverse space for 10.0.0.0/24.
function lab(records) {
  const t = new Topology();
  const r = t.addDevice(find('generic-router')); r.name = 'R1';
  const srv = t.addDevice(find('generic-server')); srv.name = 'SRV1';
  t.connect(r.id, 'Gi0/0', srv.id, Array.from(srv.interfaces.values())[0].name);
  const sim = new Simulator(t);
  const R = new CliSession(r, t, sim); R.run('enable');
  R.run('configure terminal', 'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit', 'end');
  const S = new CliSession(srv, t, sim); S.run('enable');
  S.run('configure terminal', 'interface eth0', 'ip address 10.0.0.53 255.255.255.0', 'no shutdown', 'exit', 'end');
  S.run('configure terminal', 'dns zone lab.example', 'dns add host1.lab.example A 10.0.0.53',
    'dns zone 0.0.10.in-addr.arpa');
  for (const rec of (records || [])) S.run('dns add ' + rec);
  S.run('end');
  R.run('configure terminal', 'ip domain-name lab.example', 'ip name-server 10.0.0.53', 'exit', 'end');
  return { t: t, sim: sim, r: r, srv: srv, R: R, S: S };
}

console.log('An address is asked as a reverse name, and says so:');
{
  const env = lab(['53.0.0.10.in-addr.arpa PTR host1.lab.example']);
  const out = text(env.R.run('nslookup 10.0.0.53'));
  ok(/as 53\.0\.0\.10\.in-addr\.arpa - a reverse lookup of 10\.0\.0\.53/.test(out),
    'the console shows the name it actually asked');
  ok(/Server: SRV1/.test(out), 'the answering server is named');
  ok(/10\.0\.0\.53 -> host1\.lab\.example \(PTR\)/.test(out),
    'and the answer says what it is: a name, tagged PTR');
  ok(!/no DNS server .* hosts a zone/.test(out), 'the misleading "no zone" answer is gone');
}

console.log('\nAn address the reverse zone knows without a PTR is NODATA:');
{
  const env = lab(['54.0.0.10.in-addr.arpa A 10.0.0.54']);
  const out = text(env.R.run('nslookup 10.0.0.54'));
  ok(/is known in that zone but has no PTR record \(NODATA\)/.test(out),
    'a name that exists with another type is distinguished from a missing one');
}

console.log('\nAn address the reverse zone does not hold is NXDOMAIN:');
{
  const env = lab(['53.0.0.10.in-addr.arpa PTR host1.lab.example']);
  const out = text(env.R.run('nslookup 10.0.0.99'));
  ok(/99\.0\.0\.10\.in-addr\.arpa: NXDOMAIN/.test(out), 'the reverse name is what is not found');
}

console.log('\nWith no reverse zone at all, the answer names the zone to create:');
{
  const env = lab([]);
  env.S.run('configure terminal', 'no dns zone 0.0.10.in-addr.arpa', 'exit');
  const out = text(env.R.run('nslookup 10.0.0.53'));
  ok(/no zone for the reverse space 0\.0\.10\.in-addr\.arpa/.test(out),
    'the missing reverse space is named');
  ok(/dns zone 0\.0\.10\.in-addr\.arpa/.test(out), 'with the command that creates it');
  ok(/PTR record for each address/.test(out), 'and the record it needs');
}

console.log('\nA forward lookup is unchanged, and a type can still be asked for:');
{
  const env = lab(['53.0.0.10.in-addr.arpa PTR host1.lab.example']);
  const fwd = text(env.R.run('nslookup host1.lab.example'));
  ok(/host1\.lab\.example -> 10\.0\.0\.53/.test(fwd), 'the address comes back as before');
  ok(!/PTR\)/.test(fwd), 'and an A answer is not tagged with a type');
  const ptr = text(env.R.run('nslookup host1.lab.example PTR'));
  ok(/has no PTR record \(NODATA\)/.test(ptr), 'asking for the wrong type says so plainly');
}

console.log('\nIPv6 addresses are asked under ip6.arpa, nibble-reversed:');
{
  const env = lab([]);
  const out = text(env.R.run('nslookup 2001:db8::1'));
  ok(/1\.0\.0\.0\.0\.0\.0\.0\.0\.0\.0\.0\.0\.0\.0\.0\.0\.0\.0\.0\.0\.0\.0\.0\.8\.b\.d\.0\.1\.0\.0\.2\.ip6\.arpa/.test(out),
    'the 32 nibbles are reversed under ip6.arpa');
  ok(/no zone for the reverse space under ip6\.arpa/.test(out), 'and the refusal names that space');
}

console.log('\nA reverse lookup is recorded like any other:');
{
  const env = lab(['53.0.0.10.in-addr.arpa PTR host1.lab.example']);
  env.R.run('nslookup 10.0.0.53');
  const log = text(env.R.run('show logging'));
  ok(/53\.0\.0\.10\.in-addr\.arpa -> host1\.lab\.example/.test(log),
    'the log line carries the reverse name and its answer');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
