'use strict';
// The UDM-Beast's vendor Port Layout table prints five rows and the spec modelled four.
//
// Ubiquiti's product page https://techspecs.ui.com/unifi/cloud-gateways/udm-beast prints, verbatim:
//
//   "1 GbE RJ45 = 2 (1G/100M/10M)"
//   "10 GbE RJ45 = 8 (10G/5G/2.5G/1G/100M)"
//   "10G SFP+ = 2 (10G/1G)"
//   "25G SFP28 = 2 (25G/10G/1G)"
//   "Console = 1"
//
// The spec carried the 8, the two SFP+ cages and the two SFP28 cages, and stopped there: 14 jacks
// on a box with 15, and the missing one was the only way into its serial console. The two 1 GbE
// rows were also missing the 10M rung the same table prints, so a 10BASE-T peer had nothing to
// negotiate and `negotiateSpeed()` returned null - the port refused a cable a real 1 GbE RJ45 takes.
//
// Neither was caught, because no test looked at this model at all: the catalogue-wide sweeps check
// that sockets agree with ports, not that the ports agree with the datasheet. This is that check.
const path = require('path');
const { Topology } = require('../engine');
const media = require('../engine/media');
const { loadCatalog, effectiveInterfaces } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
function section(name) { console.log('\n' + name); }

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const spec = catalog.filter(function (s) { return s.vendor === 'ubiquiti' && s.model === 'UDM-Beast'; })[0];
ok(!!spec, 'the catalogue has the Ubiquiti UDM-Beast');
if (!spec) { console.error('\n0 passed, 1 failed'); process.exit(1); }

const ifaces = effectiveInterfaces(spec);
const byName = {};
for (const i of ifaces) byName[i.name] = i;

section('The five port rows the vendor table prints are the five rows modelled:');
ok(ifaces.length === 15, '15 sockets: 2 + 8 + 2 + 2 copper/optic jacks and 1 console', 'found ' + ifaces.length);
ok(!!byName.console, 'the console jack is modelled');
const consoles = ifaces.filter(function (i) { return i.type === 'console'; });
ok(consoles.length === 1, 'and it is the only console on the box', 'found ' + consoles.length);
ok(/console/.test(spec.description || ''), 'the description counts it, so the faceplate caption is not short');

section('The 1 GbE RJ45 pair advertises the 10M rung the vendor prints:');
for (const name of ['eth0', 'eth1']) {
  const caps = (byName[name] && byName[name].speedCaps) || [];
  ok(caps.indexOf('10M') !== -1, name + ' can train at 10M', 'caps ' + JSON.stringify(caps));
  ok(caps.indexOf('1G') !== -1 && caps.indexOf('100M') !== -1,
    name + ' still carries 1G and 100M', 'caps ' + JSON.stringify(caps));
  // The vendor row is "1G/100M/10M": no 2.5G or 5G on the copper Gigabit pair.
  ok(caps.indexOf('2.5G') === -1 && caps.indexOf('5G') === -1,
    name + ' does not claim a rung the vendor row leaves out', 'caps ' + JSON.stringify(caps));
}

section('The 10 GbE RJ45 bank keeps its five rungs, and gains no 10M one:');
for (let n = 2; n <= 9; n++) {
  const caps = (byName['eth' + n] && byName['eth' + n].speedCaps) || [];
  const wanted = ['10G', '5G', '2.5G', '1G', '100M'];
  const missing = wanted.filter(function (c) { return caps.indexOf(c) === -1; });
  ok(missing.length === 0, 'eth' + n + ' carries 10G/5G/2.5G/1G/100M', 'missing ' + missing.join(','));
  ok(caps.indexOf('10M') === -1, 'eth' + n + ' does not advertise 10M (the vendor row omits it)');
}

section('The cages are what the vendor says they are:');
for (const name of ['sfp1', 'sfp2']) {
  const caps = (byName[name] && byName[name].speedCaps) || [];
  ok(caps.join('/') === '10G/1G', name + ' is a 10G SFP+ cage running 10G/1G', 'caps ' + JSON.stringify(caps));
}
for (const name of ['sfp3', 'sfp4']) {
  const caps = (byName[name] && byName[name].speedCaps) || [];
  ok(caps.join('/') === '25G/10G/1G', name + ' is a 25G SFP28 cage running 25G/10G/1G', 'caps ' + JSON.stringify(caps));
}

section('Nothing here sources power - the box is fed from an AC brick:');
for (const i of ifaces.filter(function (x) { return x.type === 'ethernet'; })) {
  ok(i.poeIn !== true, i.name + ' does not draw PoE', 'poeIn ' + i.poeIn);
  ok(i.poeOut !== true, i.name + ' does not supply PoE', 'poeOut ' + i.poeOut);
}

section('The engine materialises all 15 as ports, with a console that is not a data jack:');
const topology = new Topology();
topology.addDevice(spec, 'beast');
const dev = topology.devices.get('beast');
ok(dev.interfaces.size === 15, 'the device exposes 15 interfaces', 'found ' + dev.interfaces.size);
const port = dev.interfaces.get('console');
ok(!!port, 'the console is addressable by name');
ok(!!port && port.type === 'console', 'and its type is console, not ethernet', port ? port.type : 'absent');
ok(!!port && port.type !== 'ethernet',
  'so the faceplate does not draw a fifteenth RJ45 that no cable fits');
// A console cage is clocked in baud, not negotiated in megabits: 9600 baud to 115200 is under 1 Mbps.
ok(!!port && Array.isArray(port.speedCaps) && port.speedCaps.length > 0 &&
  Math.max.apply(null, port.speedCaps) < 1,
  'it carries a baud ladder under 1 Mbps rather than a gigabit',
  port && JSON.stringify(port.speedCaps));
ok(!!port && media.negotiateSpeed(port, { speedCaps: [1000], media: ['1000base-t'] }) === null,
  'and it refuses to autonegotiate a gigabit Ethernet peer');

section('A 10BASE-T peer can now actually link to the 1 GbE pair:');
const eth0 = dev.interfaces.get('eth0');
ok(media.negotiateSpeed(eth0, { speedCaps: [10], media: ['10base-t'] }) === 10,
  'eth0 negotiates 10 Mbps with a 10BASE-T peer',
  'got ' + media.negotiateSpeed(eth0, { speedCaps: [10], media: ['10base-t'] }));
ok(media.negotiateSpeed(eth0, { speedCaps: [100], media: ['100base-tx'] }) === 100,
  'eth0 still negotiates 100 Mbps with a 100BASE-TX peer');
ok(media.negotiateSpeed(eth0, { speedCaps: [2500], media: ['2.5gbase-t'] }) === null,
  'and refuses 2.5G, which this pair cannot train at');
// 10 Mbps is the half-duplex ceiling in this model, so the rung is usable only full duplex.
ok(media.negotiateSpeed(dev.interfaces.get('eth2'), { speedCaps: [10], media: ['10base-t'] }) === null,
  'the 10 GbE copper bank still cannot link a 10BASE-T peer');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
