'use strict';
// dns-show.test.js — `show dns` prints the zone table, and `nslookup` resolves a
// name against the device's own zones first (authoritatively), then the lab's
// resolvers the same way `ping <name>` does.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(vendor, model) {
  return catalog.find(function (x) { return x.vendor === vendor && x.model === model; });
}

const t = new Topology();
const srv = t.addDevice(spec('generic', 'generic-router'));
const pc = t.addDevice(spec('generic', 'generic-pc'));
srv.name = 'DNS1'; pc.name = 'PC1';
t.connect(pc.id, 'eth0', srv.id, 'Gi0/0');

const sim = new Simulator(t);
function cli(dev, cmds) {
  return runCommands(dev, t, sim, ['enable', 'configure terminal'].concat(cmds)).lines;
}
function show(dev, cmd) {
  return runCommands(dev, t, sim, ['enable', cmd]).lines.join('\n');
}

cli(srv, ['interface Gi0/0', 'ip address 10.0.0.53 255.255.255.0', 'exit',
  'dns zone lab.example',
  'dns add www.lab.example A 10.0.0.10',
  'dns add mail.lab.example A 10.0.0.25']);
cli(pc, ['interface eth0', 'ip address 10.0.0.10 255.255.255.0', 'exit',
  'ip name-server 10.0.0.53']);

const table = show(srv, 'show dns');
ok(/DNS zones on DNS1/.test(table), 'show dns names the device');
ok(/lab\.example/.test(table), 'show dns lists the zone');
ok(/www\.lab\.example/.test(table), 'show dns lists a record name');
ok(/10\.0\.0\.10/.test(table), 'show dns lists a record value');
ok(/Name servers: none/.test(table), 'show dns says the server has no upstream');

const auth = show(srv, 'nslookup www.lab.example');
ok(/authoritative for lab\.example/.test(auth), 'a zone the device hosts answers authoritatively');
ok(/10\.0\.0\.10/.test(auth), 'the answer carries the address');

const nx = show(srv, 'nslookup missing.lab.example');
ok(/NXDOMAIN/.test(nx), 'a missing name inside the zone is an authoritative NXDOMAIN');
ok(/authoritative for lab\.example/.test(nx), 'and the NXDOMAIN is labelled authoritative');

const viaLab = show(pc, 'nslookup www.lab.example');
ok(/DNS1/.test(viaLab), 'a client resolves through the lab server');
ok(/10\.0\.0\.10/.test(viaLab), 'the client gets the address');

const bad = show(srv, 'nslookup www.lab.example BOGUS');
ok(/Unknown record type/.test(bad), 'an unknown type is refused');

const none = show(pc, 'nslookup nope.example');
ok(/NXDOMAIN|server failure/.test(none), 'an unknown name on a client reports a failure');

const empty = show(pc, 'show dns');
ok(/\(none - create one with "dns zone <name>"\)/.test(empty), 'a device with no zones says how to add one');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
