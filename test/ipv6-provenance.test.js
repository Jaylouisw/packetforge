'use strict';
// The running-config claimed lines nobody typed, and no view showed what the port really held (#1463).
//
//   r1> show running-config            p> show running-config
//   ...                                  ...
//   ipv6 nd prefix 2001:db8:1::/64       ipv6 gateway fe80::ff:fe00:100        <- arrived in an advertisement
//   interface Gi0/0                      interface eth0
//     ipv6 address 2001:db8:1::1/64        ipv6 address 2001:db8:1::ff:fe00:200/64   <- formed by the host
//                                          ipv6 address autoconfig
//
// A SLAAC address is stored in the same place as a typed one (`config.ip6[name]`, with `autoconfig: true`), and the
// default gateway learned from an advertisement is stored in `config.gateway6`. `show running-config` printed both as
// if an operator had typed them - so a config that had *asked* for autoconfiguration also claimed a pinned address,
// and copying that config to another device would have given it this host's EUI-64 address as a static one.
//
// Meanwhile `show interfaces` - the block an operator opens to ask what this port is - said nothing at all about IPv6,
// so the address the host had just been pinged on could not be read back anywhere but `show ipv6 nd`, and the
// link-local that every RS and NS is sent from (derived from the MAC, so absent from every config) was unviewable.
//
// One rule: the config reports what was configured; the views report what is true.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const MODEL = function (m) { return catalog.find(function (s) { return s.model === m; }); };
const ROUTER = MODEL('generic-router'), SWITCH = MODEL('generic-switch'), PC = MODEL('generic-pc');

const PREFIX = '2001:db8:1::';

function lab() {
  const t = new Topology();
  t.addDevice(SWITCH, 'sw'); t.addDevice(ROUTER, 'r1'); t.addDevice(PC, 'p'); t.addDevice(PC, 'p2');
  t.connect('r1', 'Gi0/0', 'sw', 'Fa0/1');
  t.connect('p', 'eth0', 'sw', 'Fa0/3');
  t.connect('p2', 'eth0', 'sw', 'Fa0/4');
  const sim = new Simulator(t);
  const S = {};
  const cli = function (id) { return (S[id] = S[id] || new CliSession(t.getDevice(id), t, sim)); };
  const cfg = function (id, lines) {
    cli(id).run('configure terminal');
    lines.forEach(function (l) { return cli(id).run(l); });
    cli(id).run('end');
  };
  const out = function (id, cmd) { return cli(id).run(cmd).output; };
  const text = function (id, cmd) { return out(id, cmd).join('\n'); };
  return { t: t, sim: sim, cli: cli, cfg: cfg, out: out, text: text };
}

// A router advertising the prefix, a host asking for autoconfiguration, and a host with a typed address.
function v6Lab() {
  const L = lab();
  L.cfg('r1', ['ipv6 nd ra enable', 'ipv6 nd prefix ' + PREFIX + '/64',
    'interface Gi0/0', 'ipv6 address ' + PREFIX + '1/64', 'ip address 10.0.0.1 255.255.255.0']);
  L.cfg('p', ['interface eth0', 'ipv6 address autoconfig', 'ip address 10.0.0.10 255.255.255.0']);
  L.cfg('p2', ['interface eth0', 'ipv6 address 2001:db8:1::22/64']);
  L.sim.refreshNeighbours();
  return L;
}

console.log('');
console.log('The config reports what was configured:');
{
  const L = v6Lab();
  const slaac = L.t.getDevice('p').config.ip6.eth0;
  ok(!!slaac && slaac.autoconfig === true, 'the host really did learn a SLAAC address', JSON.stringify(slaac && slaac.addr));
  const rc = L.text('p', 'show running-config');
  ok(rc.indexOf('ipv6 address ' + slaac.addr) === -1,
    'the learned address is not printed as a configured line', rc);
  ok(/ipv6 address autoconfig/.test(rc), 'the request that produced it is still printed', rc);
  ok(L.t.getDevice('p').config.gateway6 === 'fe80::ff:fe00:100', 'the gateway was learned from the advertisement', '');
  ok(rc.indexOf('ipv6 gateway') === -1,
    'and the learned gateway is not printed as configuration either', rc);
  ok(L.text('r1', 'show running-config').indexOf('ipv6 address ' + PREFIX + '1/64') !== -1,
    'a typed address on the router is still printed', L.text('r1', 'show running-config'));
  ok(L.text('p2', 'show running-config').indexOf('ipv6 address 2001:db8:1::22/64') !== -1,
    'and so is a typed address on a host', L.text('p2', 'show running-config'));
}

console.log('');
console.log('The views report what is true:');
{
  const L = v6Lab();
  const slaac = L.t.getDevice('p').config.ip6.eth0;
  const iface = L.text('p', 'show interfaces eth0');
  ok(new RegExp('ipv6: ' + slaac.addr + '/64 \\(autoconfig\\)').test(iface),
    'show interfaces reports the learned address, marked as learned', iface.split('\n').filter(function (l) { return /ipv6:/.test(l); })[0]);
  ok(/link-local fe80::ff:fe00:200/.test(iface), 'with the link-local that neighbour discovery uses', '');
  ok(/ip: 10\.0\.0\.10\/24/.test(iface), 'and the IPv4 line is untouched beside it', '');
  ok(new RegExp('ipv6: 2001:db8:1::22/64, link-local').test(L.text('p2', 'show interfaces eth0')),
    'a typed address is printed without the learned marker', L.text('p2', 'show interfaces eth0'));
  ok(!/autoconfig/.test(L.text('p2', 'show interfaces eth0')), 'and nothing claims it was learned', '');

  const all = L.text('p', 'show interfaces');
  ok(all.indexOf(slaac.addr + '/64 (autoconfig)') !== -1, 'the all-ports form reports it too', '');

  const nd = L.text('p', 'show ipv6 nd');
  ok(/Default gw  : fe80::ff:fe00:100 via eth0 {2}\(learned from a router advertisement\)/.test(nd),
    'show ipv6 nd says where the default gateway came from', nd.split('\n').filter(function (l) { return /Default gw/.test(l); })[0]);
  ok(/Autoconfig  : eth0 -> /.test(nd), 'and still names the address it formed', '');
}

console.log('');
console.log('A typed gateway takes ownership back:');
{
  const L = v6Lab();
  L.cfg('p', ['ipv6 gateway 2001:db8:1::1']);
  ok(L.t.getDevice('p').config.gateway6Learned === false, 'typing a gateway clears the learned mark', '');
  ok(/ipv6 gateway 2001:db8:1::1/.test(L.text('p', 'show running-config')),
    'and the typed gateway is printed as configuration', L.text('p', 'show running-config'));
  ok(/\(configured\)/.test(L.text('p', 'show ipv6 nd')), 'show ipv6 nd calls it configured', '');
  L.sim.refreshNeighbours();
  ok(/ipv6 gateway 2001:db8:1::1/.test(L.text('p', 'show running-config')),
    'a later advertisement does not take the config line away again', L.text('p', 'show running-config'));
}

console.log('');
console.log('Waiting for a router says so, where the address would be:');
{
  const L = lab();
  L.cfg('p', ['interface eth0', 'ipv6 address autoconfig']);
  const iface = L.text('p', 'show interfaces eth0');
  ok(/ipv6: autoconfig, no address yet \(waiting for a router advertisement\)/.test(iface),
    'the pending address is explained', iface.split('\n').filter(function (l) { return /ipv6:/.test(l); })[0]);
  ok(/link-local fe80::/.test(iface), 'the link-local is still real and still printed', '');
}

console.log('');
console.log('An IPv4 lab prints exactly what it printed before:');
{
  const L = lab();
  L.cfg('r1', ['interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0']);
  L.cfg('p', ['interface eth0', 'ip address 10.0.0.10 255.255.255.0']);
  const all = L.out('p', 'show interfaces');
  ok(!all.some(function (l) { return /ipv6:/.test(l); }), 'no IPv6 line appears without IPv6', '');
  ok(all.some(function (l) { return /^  ip: 10\.0\.0\.10\/24$/.test(l); }), 'and the IPv4 line is as it was', '');
  const sw = L.out('sw', 'show interfaces');
  ok(!sw.some(function (l) { return /ipv6:/.test(l); }), 'a switch full of IPv4 ports is unchanged', '');
}

console.log('');
console.log('Provenance survives a save and a reopen:');
{
  const L = v6Lab();
  const doc = JSON.parse(JSON.stringify(L.t.serialize()));
  const savedP = (doc.devices || []).filter(function (d) { return d.id === 'p'; })[0];
  ok(!!savedP && savedP.config.gateway6Learned === true,
    'the document records that the gateway was learned', savedP ? JSON.stringify(savedP.config.gateway6Learned) : 'no device p');
  ok(!!savedP && savedP.config.ip6.eth0.autoconfig === true,
    'and that the address was formed rather than typed', '');
  const reopened = Topology.fromJSON(JSON.parse(JSON.stringify(doc)));
  const sim2 = new Simulator(reopened);
  const cli2 = new CliSession(reopened.getDevice('p'), reopened, sim2);
  const rc = cli2.run('show running-config').output.join('\n');
  ok(reopened.getDevice('p').config.gateway6Learned === true,
    'a reopened lab still knows it did not configure that gateway', String(reopened.getDevice('p').config.gateway6Learned));
  ok(rc.indexOf('ipv6 gateway') === -1, 'so it does not start printing it as configuration', rc);
  ok(/ipv6 address autoconfig/.test(rc), 'the request survives the round trip', rc);
  const iface = cli2.run('show interfaces eth0').output.join('\n');
  ok(/\(autoconfig\)/.test(iface), 'and the port still reports its learned address as learned', iface.split('\n').filter(function (l) { return /ipv6:/.test(l); })[0]);
  ok(cli2.run('ping ' + PREFIX + '1 1').output.join('\n').indexOf('(1/1)') !== -1,
    'the reopened host still reaches the router', '');
}

console.log('');
console.log('Removing the address removes the line:');
{
  const L = v6Lab();
  L.cfg('p2', ['interface eth0', 'no ipv6 address']);
  ok(!/ipv6:/.test(L.text('p2', 'show interfaces eth0')),
    'a port with no IPv6 prints no IPv6 line', L.text('p2', 'show interfaces eth0'));
  ok(L.text('p2', 'show running-config').indexOf('ipv6 address') === -1,
    'and the config is empty of IPv6 again', L.text('p2', 'show running-config'));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
