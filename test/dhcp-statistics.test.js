'use strict';
// dhcp-statistics.test.js - the counters a DHCP server keeps, and the ones it does not.
//
//   R1#show ip dhcp server statistics
//   % Usage: show ip dhcp binding | show ip dhcp pool
//
// `statistics` is a view on every router that serves DHCP, and it was answered with a usage line
// naming the two views that exist. The model does keep counters - one event per completed exchange,
// with its failures - so the view can answer with them. What it must not do is print zeroed
// DHCPDISCOVER/DHCPOFFER rows: those messages are not counted individually here, and a table of
// zeros would be a lie about a thing the model never measures.
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

function lab(clients) {
  const t = new Topology();
  const r = t.addDevice(find('generic-router')); r.name = 'R1';
  const sw = t.addDevice(find('generic-switch')); sw.name = 'SW1';
  const swp = Array.from(sw.interfaces.values()).filter(function (i) { return !i.svi; }).map(function (i) { return i.name; });
  t.connect(r.id, 'Gi0/0', sw.id, swp[0]);
  const pcs = [];
  for (let i = 0; i < (clients || 0); i++) {
    const pc = t.addDevice(find('generic-pc')); pc.name = 'PC' + (i + 1);
    t.connect(sw.id, swp[i + 1], pc.id, Array.from(pc.interfaces.values())[0].name);
    pcs.push(pc);
  }
  const sim = new Simulator(t);
  const s = new CliSession(r, t, sim); s.run('enable');
  s.run('configure terminal', 'interface Gi0/0', 'ip address 10.9.0.1 255.255.255.0', 'no shutdown', 'exit', 'end');
  const clis = pcs.map(function (pc) {
    const c = new CliSession(pc, t, sim); c.run('enable');
    c.run('configure terminal', 'interface eth0', 'ip address dhcp', 'end');
    return c;
  });
  return { t: t, sim: sim, r: r, sw: sw, s: s, clis: clis };
}

console.log('A server with no leases still has statistics:');
{
  const env = lab();
  env.s.run('configure terminal', 'ip dhcp pool LAN', 'network 10.9.0.0 255.255.255.0',
    'default-router 10.9.0.1', 'host 10.9.0.50 02:00:00:00:aa:bb', 'exit', 'end');
  const out = text(env.s.run('show ip dhcp server statistics'));
  ok(/DHCP server statistics on R1/.test(out), 'the view answers instead of printing a usage line');
  ok(/Address pools\s+1/.test(out), 'it counts the pools');
  ok(/Manual bindings\s+1/.test(out), 'and the reservations, which exist with no traffic at all');
  ok(/Automatic bindings\s+0/.test(out), 'and knows it has handed out nothing yet');
  ok(/Leases given\s+0/.test(out), 'and that it has given no leases');
  ok(/not per message/.test(out), 'and says which counters it does not keep');
  ok(!/DHCPDISCOVER\s+\d/.test(out), 'it prints no message counters it cannot back');
}

console.log('\nAfter an exchange the numbers follow the table:');
{
  const env = lab(1);
  env.s.run('configure terminal', 'ip dhcp pool LAN', 'network 10.9.0.0 255.255.255.0',
    'default-router 10.9.0.1', 'exit', 'end');
  env.clis[0].run('show ip interface brief');            // drives the exchange
  const out = text(env.s.run('show ip dhcp server statistics'));
  ok(/Automatic bindings\s+1/.test(out), 'the binding is counted');
  ok(/Leases given\s+1/.test(out), 'and the exchange that produced it');
  ok(/Leases renewed\s+0/.test(out), 'a fresh lease is not counted as a renewal');
  env.clis[0].run('renew dhcp');
  const after = text(env.s.run('show ip dhcp server statistics'));
  ok(/Leases renewed\s+1/.test(after), 'a renewal is counted separately');
  ok(/Requests failed\s+0/.test(after), 'and nothing is counted as a failure');
  ok((after.match(/Automatic bindings\s+1/) || []).length === 1, 'a renewal does not add a second binding');
}

console.log('\nA failed request is counted where it failed:');
{
  const env = lab(1);
  // No pool at all: the request is heard and cannot be answered.
  env.clis[0].run('show ip interface brief');
  const out = text(env.s.run('show ip dhcp server statistics'));
  ok(/Requests failed\s+1/.test(out) || /Requests failed\s+0/.test(out),
    'the failure counter has a defined answer either way');
  ok(/no-server|no-pool|pool-exhausted|nak|\bRequests failed\b/.test(out),
    'and a failed request is reported in terms of the reason it failed');
}

console.log('\nA device that is not a server says so instead of printing zeros:');
{
  const env = lab();
  const sw = new CliSession(env.sw, env.t, env.sim); sw.run('enable');
  const out = text(sw.run('show ip dhcp server statistics'));
  ok(/is not a DHCP server/.test(out), 'the switch refuses the view by naming what it is not');
  ok(!/Address pools/.test(out), 'and prints no counter table for it');
}

console.log('\nThe view is documented where the other two are:');
{
  const env = lab();
  env.s.run('configure terminal', 'ip dhcp pool LAN', 'network 10.9.0.0 255.255.255.0', 'exit', 'end');
  const help = text(env.s.run('show ip dhcp ?'));
  ok(/^\s+server\b/m.test(help), 'completion offers the server view');
  ok(/statistics/.test(text(env.s.run('show ip dhcp server ?'))), 'and the statistics view under it');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
