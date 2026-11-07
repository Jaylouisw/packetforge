'use strict';
// Proves DNS is wired into the forwarding path: a ping to a HOSTNAME resolves
// through a device that hosts the zone before any ICMP is sent.
const path = require('path');
const { Topology, Simulator, runCommands, dns } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('  \u2713 ' + msg); } else { failed++; console.error('  \u2717 ' + msg); } }

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(vendor, model) {
  const s = catalog.find(function (x) { return x.vendor === vendor && x.model === model; });
  if (!s) throw new Error('missing spec ' + vendor + '/' + model);
  return s;
}

const t = new Topology();
function cli(dev, cmds, exec) {
  const pre = exec ? ['enable'] : ['enable', 'configure terminal'];
  return runCommands(dev, t, null, pre.concat(cmds)).lines;
}

const sw = t.addDevice(spec('generic', 'generic-switch'));
const pc1 = t.addDevice(spec('generic', 'generic-pc'));
const srv = t.addDevice(spec('generic', 'generic-server'));
pc1.name = 'PC1'; srv.name = 'SRV1'; sw.name = 'SW1';

t.connect(pc1.id, 'eth0', sw.id, 'Fa0/1');
t.connect(srv.id, 'eth0', sw.id, 'Fa0/2');

cli(pc1, ['interface eth0', 'ip address 10.0.0.10 255.255.255.0']);
// The server gets the conventional .53 address so it is recognisable as a resolver.
cli(srv, ['interface eth0', 'ip address 10.0.0.53 255.255.255.0']);

console.log('Authoritative zone built through the CLI:');
const z1 = cli(srv, ['dns zone lab.test']);
ok(/DNS zone lab\.test ready/.test(z1.join(' ')), 'CLI accepts "dns zone lab.test"');
const z2 = cli(srv, ['dns zone lab.test', 'dns add srv1 A 10.0.0.53']);
ok(/Added srv1 A 10\.0\.0\.53/.test(z2.join(' ')), 'CLI adds an A record');
const z3 = cli(srv, ['dns zone lab.test', 'dns add www CNAME srv1.lab.test']);
ok(/Added www CNAME/.test(z3.join(' ')), 'CLI adds a CNAME record');
ok(srv.config.dnsZones.length === 1, 'exactly one zone stored (' + srv.config.dnsZones.length + ')');
ok(srv.config.dnsZones[0].records.length === 2, 'two records stored');

console.log('\nResolving a hostname end to end:');
let sim = new Simulator(t);
let res = sim.ping(pc1.id, 'srv1.lab.test', { count: 1 });
ok(res.resolved === '10.0.0.53', 'hostname resolved to 10.0.0.53 (got ' + res.resolved + ')');
ok(res.replies[0].success === true, 'ping to the NAME succeeds, so real packets were sent');
const dnsEv = res.events.filter(function (e) { return e.type === 'dns'; })[0];
ok(!!dnsEv, 'a dns event was emitted');
ok(dnsEv && dnsEv.ok === true, 'the dns event reports success');
ok(dnsEv && dnsEv.server === 'SRV1', 'the event names the answering server (' + (dnsEv && dnsEv.server) + ')');
ok(dnsEv && dnsEv.qname === 'srv1.lab.test', 'the event records the queried name');

console.log('\nCNAME is followed:');
res = sim.ping(pc1.id, 'www.lab.test', { count: 1 });
ok(res.resolved === '10.0.0.53', 'www.lab.test resolves through its CNAME to 10.0.0.53');
ok(res.replies[0].success === true, 'ping through the CNAME succeeds');

console.log('\nUnknown names fail cleanly and send no packets:');
res = sim.ping(pc1.id, 'nope.lab.test', { count: 1 });
ok(res.success === false, 'ping to an unknown name fails');
ok(res.replies[0].reason === 'dns-nxdomain', 'the failure reason is dns-nxdomain');
ok(res.resolved === null, 'nothing was resolved');
const pingEvents = res.events.filter(function (e) { return e.type === 'ping'; });
ok(pingEvents.length === 0, 'no ICMP packets were sent for an unresolvable name');

console.log('\nA client with a configured resolver only asks that resolver:');
pc1.config.dnsServers = ['10.9.9.9'];
sim = new Simulator(t);
res = sim.ping(pc1.id, 'srv1.lab.test', { count: 1 });
ok(res.success === false, 'resolution fails when the only configured resolver hosts no zone');
pc1.config.dnsServers = [];
sim = new Simulator(t);
res = sim.ping(pc1.id, 'srv1.lab.test', { count: 1 });
ok(res.success === true, 'clearing the resolver list restores resolution');

console.log('\nDirect API:');
const r = sim.resolveName(pc1, 'srv1.lab.test');
ok(r.ok === true && r.address === '10.0.0.53', 'resolveName() returns the address');
ok(Array.isArray(r.answers) && r.answers.length > 0, 'resolveName() returns the answer records');
const nx = sim.resolveName(pc1, 'missing.lab.test');
ok(nx.ok === false, 'resolveName() reports failure for an unknown name');
ok(nx.rcode === dns.RCODE.NXDOMAIN, 'failure carries rcode NXDOMAIN');

console.log('\nCase and trailing dot are tolerated:');
res = sim.ping(pc1.id, 'SRV1.LAB.TEST.', { count: 1 });
ok(res.resolved === '10.0.0.53', 'uppercase with a trailing dot still resolves');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
