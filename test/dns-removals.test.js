'use strict';
// dns-removals.test.js - what a DNS server can be told to forget.
//
//   SRV1(config)#dns zone 0.0.10.in-addr.arpa
//   DNS zone 0.0.10.in-addr.arpa ready
//   SRV1(config)#no dns zone 0.0.10.in-addr.arpa
//   % Unrecognized config command: no dns zone 0.0.10.in-addr.arpa
//
// A zone and its records could be created and never removed, so the line `show running-config`
// printed had no `no` form and a saved copy could only grow. And the one removal that did exist for
// this family - `no ip name-server <address>` - emptied **every** server whatever was named, the
// same defect `no ipv6 gateway <addr>` had.
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
  const srv = t.addDevice(find('generic-server')); srv.name = 'SRV1';
  const r = t.addDevice(find('generic-router')); r.name = 'R1';
  t.connect(r.id, 'Gi0/0', srv.id, Array.from(srv.interfaces.values())[0].name);
  const sim = new Simulator(t);
  const S = new CliSession(srv, t, sim); S.run('enable');
  S.run('configure terminal', 'interface eth0', 'ip address 10.0.0.53 255.255.255.0', 'no shutdown', 'exit', 'end');
  const R = new CliSession(r, t, sim); R.run('enable');
  R.run('configure terminal', 'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit', 'end');
  return { t: t, sim: sim, srv: srv, r: r, S: S, R: R };
}
const zoneNames = function (dev) { return (dev.config.dnsZones || []).map(function (z) { return z.name; }); };

console.log('A zone can be removed by the syntax that created it:');
{
  const env = lab();
  env.S.run('configure terminal', 'dns zone lab.example', 'dns add host1.lab.example A 10.0.0.53', 'exit');
  ok(zoneNames(env.srv).length === 1, 'the zone exists');
  const out = text(env.S.run('configure terminal', 'no dns zone lab.example', 'exit'));
  ok(/Zone lab\.example removed with its 1 record/.test(out), 'it is removed and the loss is counted');
  ok(zoneNames(env.srv).length === 0, 'and it is gone from the configuration');
  const dump = text(env.S.run('show running-config'));
  ok(!/dns zone lab\.example/.test(dump), 'the dump no longer carries it');
  const resolve = text(new (require('../engine/cli').CliSession)(env.r, env.t, env.sim).run('nslookup host1.lab.example'));
  ok(/server failure|can't find/.test(resolve), 'and a resolver that used it no longer gets an answer');
}

console.log('\nA zone that is not there is refused by name, with the ones that are:');
{
  const env = lab();
  env.S.run('configure terminal', 'dns zone lab.example', 'exit', 'end');
  const out = text(env.S.run('configure terminal', 'no dns zone typo.example', 'exit'));
  ok(/No zone named typo\.example on SRV1/.test(out), 'the missing zone is named');
  ok(/Zones here: lab\.example/.test(out), 'and the zones that do exist are listed');
  ok(zoneNames(env.srv).length === 1, 'nothing was removed');
}

console.log('\nOne name\'s records can be removed without the zone:');
{
  const env = lab();
  env.S.run('configure terminal', 'dns zone lab.example',
    'dns add host1.lab.example A 10.0.0.53',
    'dns add host1.lab.example AAAA 2001:db8::53',
    'dns add host2.lab.example A 10.0.0.54', 'exit');
  const out = text(env.S.run('configure terminal', 'no dns add host1.lab.example A', 'exit'));
  ok(/Removed 1 record for host1\.lab\.example \(A\)/.test(out), 'the removal counts what it removed');
  ok(/lab\.example: host1\.lab\.example A 10\.0\.0\.53/.test(out), 'and says which record went');
  const zone = env.srv.config.dnsZones[0];
  ok(zone.records.length === 2, 'the other records are untouched (AAAA and host2)');
  ok(zone.records.some(function (r) { return r.type === 'AAAA'; }), 'including the same name with another type');
}

console.log('\nRemoving a name that is not there names what is:');
{
  const env = lab();
  env.S.run('configure terminal', 'dns zone lab.example', 'dns add host1.lab.example A 10.0.0.53', 'exit');
  const out = text(env.S.run('configure terminal', 'no dns add host9.lab.example', 'exit'));
  ok(/host9\.lab\.example has no record here/.test(out), 'the name is named');
  ok(/No zone on this device holds a record for host9/.test(out), 'and the absence is stated precisely');
  const one = text(env.S.run('configure terminal', 'no dns add host1.lab.example MX', 'exit'));
  ok(/host1\.lab\.example has no MX here/.test(one), 'a type that is not there is refused by type');
  ok(/That name holds: lab\.example: host1\.lab\.example A 10\.0\.0\.53/.test(one),
    'and the types it does hold are listed');
}

console.log('\n`no ip name-server <address>` removes that address only:');
{
  const env = lab();
  env.R.run('configure terminal', 'ip name-server 10.0.0.53 8.8.8.8', 'exit');
  ok((env.r.config.dnsServers || []).length === 2, 'two servers are configured');
  const out = text(env.R.run('configure terminal', 'no ip name-server 8.8.8.8', 'exit'));
  ok(/8\.8\.8\.8 removed/.test(out), 'the named one is removed');
  ok(JSON.stringify(env.r.config.dnsServers) === JSON.stringify(['10.0.0.53']),
    'and the other is still configured (was cleared before)');
  const all = text(env.R.run('configure terminal', 'no ip name-server', 'exit'));
  ok(/Name servers cleared \(1\)/.test(all), 'a bare removal clears all and says how many');
  ok((env.r.config.dnsServers || []).length === 0, 'leaving none');
}

console.log('\nA name server that was never configured is refused:');
{
  const env = lab();
  env.R.run('configure terminal', 'ip name-server 10.0.0.53', 'exit');
  const out = text(env.R.run('configure terminal', 'no ip name-server 9.9.9.9', 'exit'));
  ok(/Not a configured name server: 9\.9\.9\.9/.test(out), 'the address is named');
  ok(/Configured: 10\.0\.0\.53/.test(out), 'and the configured ones are listed');
  ok(JSON.stringify(env.r.config.dnsServers) === JSON.stringify(['10.0.0.53']), 'nothing was removed');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
