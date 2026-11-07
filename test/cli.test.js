'use strict';
// cli.test.js — exercises the vendor-agnostic CLI parser.
const path = require('path');
const { Topology, Simulator, CliSession } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const spec = catalog.find(function (s) { return s.vendor === 'generic' && s.model === 'generic-router'; });

const t = new Topology();
const r = t.addDevice(spec);
const sim = new Simulator(t);
const cli = new CliSession(r, t, sim);

cli.run('configure terminal');
cli.run('hostname R1');
ok(r.config.hostname === 'R1', 'hostname command sets hostname');
ok(cli.prompt() === 'R1(config)#', 'prompt reflects hostname + mode');

cli.run('interface Gi0/0');
cli.run('ip address 10.0.0.1 255.255.255.0');
ok(r.interfaces.get('Gi0/0').ip === '10.0.0.1', 'ip address applied to interface');
ok(r.interfaces.get('Gi0/0').mask === '255.255.255.0', 'subnet mask applied');

cli.run('exit'); // iface -> config
cli.run('ip route 172.16.0.0 255.255.0.0 10.0.0.254');
ok(r.config.routes.length === 1, 'static route added');

const show = new CliSession(r, t, sim);
const routeOut = show.run('show ip route').output.join('\n');
ok(routeOut.indexOf('172.16.0.0') !== -1, 'show ip route lists static route');
ok(routeOut.indexOf('C') !== -1, 'show ip route lists connected route');

const verOut = show.run('show version').output.join('\n');
ok(verOut.indexOf('generic-router') !== -1, 'show version reports model');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
