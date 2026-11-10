'use strict';
// dhcp-show.test.js — `show ip dhcp binding` and `show ip dhcp pool`. The DORA
// exchange already ran during the first packet; until now its result was only
// visible by reading the flow event log or guessing from the host's address.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(v, m) {
  const s = catalog.find(function (x) { return x.vendor === v && x.model === m; });
  if (!s) throw new Error('spec not found: ' + v + '/' + m);
  return s;
}

const t = new Topology();
const pc = t.addDevice(spec('generic', 'generic-pc'));
const srv = t.addDevice(spec('generic', 'generic-router'));
pc.name = 'PC1'; srv.name = 'SRV';
t.connect(pc.id, 'eth0', srv.id, 'Gi0/0');
const sim = new Simulator(t);
const cfg = function (dev, cmds) {
  return runCommands(dev, t, sim, ['configure terminal'].concat(cmds));
};

cfg(srv, ['interface Gi0/0', 'ip address 192.168.10.1 255.255.255.0', 'exit',
  'ip dhcp pool lan',
  'network 192.168.10.0 255.255.255.0',
  'default-router 192.168.10.1',
  'dns-server 192.168.10.1 1.1.1.1',
  'range 192.168.10.100 192.168.10.110',
  'lease 0 0 10',
  'exit']);
cfg(pc, ['interface eth0', 'ip address dhcp']);

// Nothing has asked yet: the pool exists, the table is empty.
const before = runCommands(srv, t, sim, ['enable', 'show ip dhcp binding']).lines.join('\n');
ok(/DHCP bindings on SRV/.test(before), 'the server names itself');
// The reason matters: "nothing has asked yet" and "the lease ran out" are different situations, so
// the empty table names which one it is instead of printing one message for both.
ok(/DHCP bindings on SRV: \(none\)/.test(before), 'and says the table is empty before the first run');
ok(/no client has completed an exchange/.test(before), 'with the reason, not just the absence');

// One packet makes the DORA exchange happen.
sim.ping(pc.id, '192.168.10.1', { count: 1 });
const lease = pc.interfaces.get('eth0').dhcpLease;
ok(!!lease, 'the client holds a lease after the exchange');

const srvView = runCommands(srv, t, sim, ['enable', 'show ip dhcp binding']).lines.join('\n');
ok(/MAC\s+IP\s+Pool\s+Expires in/.test(srvView), 'the binding table has a header');
ok(new RegExp(lease.mac).test(srvView), 'the client MAC appears');
ok(new RegExp(lease.ip.replace(/\./g, '\\.')).test(srvView), 'the address handed out appears');
ok(/\blan\b/.test(srvView), 'the row names the pool the address came from');
ok(/\d+s\s*$/.test(srvView.trim()), 'and how long the lease has left');

const pcView = runCommands(pc, t, sim, ['enable', 'show ip dhcp binding']).lines.join('\n');
ok(/DHCP lease on PC1\/eth0/.test(pcView), 'a client shows its own lease');
ok(new RegExp('IP address   : ' + lease.ip.replace(/\./g, '\\.') + '/24').test(pcView), 'with address and prefix');
ok(/Server\s+: 192\.168\.10\.1\s+\(pool lan\)/.test(pcView), 'the server and pool');
ok(/Gateway\s+: 192\.168\.10\.1/.test(pcView), 'the gateway the server advertised');
ok(/DNS\s+: 192\.168\.10\.1, 1\.1\.1\.1/.test(pcView), 'and both DNS servers');
ok(/Lease\s+: 600s/.test(pcView), 'the lease time from the pool');

const pool = runCommands(srv, t, sim, ['enable', 'show ip dhcp pool']).lines.join('\n');
ok(/DHCP pools on SRV/.test(pool), 'the pool summary names the server');
ok(/Network\s+: 192\.168\.10\.0 \/ 255\.255\.255\.0/.test(pool), 'network and mask');
ok(/Range\s+: 192\.168\.10\.100 - 192\.168\.10\.110/.test(pool), 'the allocatable range');
ok(/Router\s+: 192\.168\.10\.1/.test(pool), 'the default router');
ok(/DNS\s+: 192\.168\.10\.1, 1\.1\.1\.1/.test(pool), 'the DNS list');
ok(/Lease\s+: 600s/.test(pool), 'the lease time');
ok(/In use\s+: 1 of 11/.test(pool), 'one of eleven addresses is in use');

// A device that is neither a server nor a client says so instead of printing an
// empty table that looks like a bug.
const lone = t.addDevice(spec('generic', 'generic-router'));
const none = runCommands(lone, t, sim, ['enable', 'show ip dhcp binding']).lines.join('\n');
ok(/is not a DHCP server \(no pools\) and holds no DHCP lease/.test(none), 'a plain router explains itself');

const bad = runCommands(srv, t, sim, ['enable', 'show ip dhcp nope']).lines.join('\n');
ok(/% Usage: show ip dhcp binding \| show ip dhcp pool/.test(bad), 'an unknown sub-command prints the usage');

const alias = runCommands(srv, t, sim, ['enable', 'show dhcp binding']).lines.join('\n');
ok(/DHCP bindings on SRV/.test(alias), 'show dhcp binding is an accepted alias');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
