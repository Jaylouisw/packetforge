'use strict';
// show-hosts.test.js - the resolver's own view.
//
//   R1(config)#ip domain-name lab.example
//   R1(config)#ip name-server 10.0.0.53
//   R1#show hosts
//   % Invalid show command: hosts
//
// A router that resolves names had no command to show what it would ask, what suffix it would add,
// or which names it had already answered for - the one place an operator checks "did that name
// resolve, and to what". The lookups themselves are now recorded against the device that asked, so
// the view reads the lab's own timeline rather than a second copy of the same facts.
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
  const r = t.addDevice(find('generic-router')); r.name = 'R1';
  const srv = t.addDevice(find('generic-server')); srv.name = 'SRV1';
  t.connect(r.id, 'Gi0/0', srv.id, Array.from(srv.interfaces.values())[0].name);
  const sim = new Simulator(t);
  const R = new CliSession(r, t, sim); R.run('enable');
  R.run('configure terminal', 'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit', 'end');
  const S = new CliSession(srv, t, sim); S.run('enable');
  S.run('configure terminal', 'interface eth0', 'ip address 10.0.0.53 255.255.255.0', 'no shutdown', 'exit', 'end');
  S.run('configure terminal', 'dns zone lab.example', 'dns add host1.lab.example A 10.0.0.53', 'end');
  return { t: t, sim: sim, r: r, srv: srv, R: R, S: S };
}

console.log('Before anything is resolved the view says what it would ask:');
{
  const env = lab();
  env.R.run('configure terminal', 'ip domain-name lab.example', 'ip name-server 10.0.0.53', 'exit');
  const out = text(env.R.run('show hosts'));
  ok(!/Invalid show command/.test(out), 'the command exists');
  ok(/Default domain is lab\.example/.test(out), 'it names the default domain');
  ok(/Name lookup is enabled/.test(out), 'and says lookup is on');
  ok(/Name servers are 10\.0\.0\.53/.test(out), 'and lists the servers it will ask');
  ok(/No name has been resolved here since this lab started/.test(out),
    'and admits it has resolved nothing yet');
  ok(/ping <name>/.test(out), 'and names the command that would produce an entry');
}

console.log('\nA name that resolves is recorded with its address:');
{
  const env = lab();
  env.R.run('configure terminal', 'ip domain-name lab.example', 'ip name-server 10.0.0.53', 'exit', 'end');
  const ping = text(env.R.run('ping host1.lab.example'));
  ok(/10\.0\.0\.53/.test(ping), 'the ping resolves and echoes the address');
  const out = text(env.R.run('show hosts'));
  ok(/Host\s+Address\s+Type\s+Age/.test(out), 'the table has the IOS columns');
  ok(/host1\.lab\.example\s+10\.0\.0\.53\s+dynamic/.test(out), 'the name, its address and that it was learned');
  ok(!/No name has been resolved/.test(out), 'and the empty-state sentence is gone');
}

console.log('\nAn unqualified name shows the name that was actually asked:');
{
  const env = lab();
  env.R.run('configure terminal', 'ip domain-name lab.example', 'ip name-server 10.0.0.53', 'exit', 'end');
  env.R.run('ping host1');
  const out = text(env.R.run('show hosts'));
  ok(/host1\.lab\.example/.test(out), 'the suffixed name is what the table records');
  ok(/ip domain-name/.test(text(env.R.run('ping host1')).split('\n')[1] || ''),
    'and the ping says the suffix came from ip domain-name');
}

console.log('\nA failure is recorded as a failure, with where to look next:');
{
  const env = lab();
  env.R.run('configure terminal', 'ip domain-name lab.example', 'ip name-server 10.0.0.53', 'exit', 'end');
  env.R.run('ping nosuch.lab.example');
  const out = text(env.R.run('show hosts'));
  ok(/nosuch\.lab\.example\s+unresolved\s+failed/.test(out), 'the name is listed as unresolved');
  ok(/did not resolve/.test(out), 'and the table says how many did not');
  ok(/show logging/.test(out), 'and points at the log for the reason');
}

console.log('\nA disabled lookup is visible, and a refused lookup is recorded:');
{
  const env = lab();
  env.R.run('configure terminal', 'no ip domain-lookup', 'exit');
  const before = text(env.R.run('show hosts'));
  ok(/Name lookup is disabled/.test(before), 'the view says lookup is off');
  ok(/ip domain-lookup/.test(before), 'and names the command that turns it back on');
  env.R.run('ping host2');
  const after = text(env.R.run('show hosts'));
  ok(/host2\s+unresolved\s+failed/.test(after), 'the refused lookup is still recorded as a fact');
}

console.log('\nThe view is per device, not per lab:');
{
  const env = lab();
  env.R.run('configure terminal', 'ip domain-name lab.example', 'ip name-server 10.0.0.53', 'exit', 'end');
  env.R.run('ping host1.lab.example');
  const server = text(env.S.run('show hosts'));
  ok(!/host1\.lab\.example/.test(server), 'the server does not see the router\'s lookups');
  ok(/No name has been resolved here/.test(server) || /Name servers are/.test(server),
    'it reports its own state');
}


console.log('\nA failed lookup names its reason, and the log line is a sentence:');
{
  const env = lab();
  env.R.run('configure terminal', 'ip domain-name lab.example', 'ip name-server 10.0.0.53', 'exit', 'end');
  env.R.run('ping nosuch.lab.example');
  const hosts = text(env.R.run('show hosts'));
  ok(/nosuch\.lab\.example did not resolve - NXDOMAIN from SRV1/.test(hosts),
    'the reason is on the failed name (NXDOMAIN, and which server said so)');
  ok(/show logging/.test(hosts), 'and the log is named for the full record');
  const log = text(env.R.run('show logging'));
  ok(/nosuch\.lab\.example -> NXDOMAIN from SRV1/.test(log), 'the log line reads as one fact');
  ok(!/clientName /.test(log), "the model's own field names are not printed");
  ok(!/ok false/.test(log), 'and neither is a bare false');
}

console.log('\nA resolved name logs its answer and who gave it:');
{
  const env = lab();
  env.R.run('configure terminal', 'ip domain-name lab.example', 'ip name-server 10.0.0.53', 'exit', 'end');
  env.R.run('ping host1.lab.example');
  const log = text(env.R.run('show logging'));
  ok(/host1\.lab\.example -> 10\.0\.0\.53 \(answered by SRV1\)/.test(log),
    'the address and the answering server are on the line');
}

console.log('\nA name the zone holds without an address says so:');
{
  const env = lab();
  env.S.run('configure terminal', 'dns add host2.lab.example AAAA ::1', 'end');
  env.R.run('configure terminal', 'ip domain-name lab.example', 'ip name-server 10.0.0.53', 'exit', 'end');
  env.R.run('ping host2.lab.example');
  const hosts = text(env.R.run('show hosts'));
  ok(/host2\.lab\.example did not resolve - NODATA/.test(hosts),
    'NODATA is distinguished from NXDOMAIN (a different fix)');
}

console.log('\nA typo is not a lookup:');
{
  const env = lab();
  env.R.run('ping 999.1.1.1');
  ok(!/999\.1\.1\.1/.test(text(env.R.run('show hosts'))),
    'a malformed address never enters the resolver history');
  env.R.run('ping host1.lab.example');
  ok(!/999\.1\.1\.1/.test(text(env.R.run('show logging'))), 'and it is not in the log either');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
