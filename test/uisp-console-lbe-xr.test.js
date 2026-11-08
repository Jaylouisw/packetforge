'use strict';
// Two hardware requests fulfilled from the vendor's own figures: the UISP Console and the
// LiteBeam 5AC XR.
//
// The UISP Console is worth a test because its port mix is not the usual shape: eight LAN
// copper ports, one WAN copper port, and an SFP+ cage on each side. A spec that quietly put
// all eleven ports in one bridge group would make a lab show LAN-to-WAN traffic passing with
// no gateway - the opposite of what the box does. Its SFP+ cages are also 1/10G, so a 1G
// module in the 10G cage has to be accepted rather than refused as a downgrade.
//
// The LiteBeam 5AC XR is worth one because a radio that can be cabled to copper is the bug
// class #77 exists to prevent: the antenna must refuse an RJ45 and accept only another
// radio.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const media = require('../engine/media');
const validation = require('../engine/validation');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.log('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + ' (expected ' + JSON.stringify(expected) +
    ', got ' + JSON.stringify(actual) + ')');
}
function section(name) { console.log('\n' + name); }

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(model) { return catalog.find(function (x) { return x.model === model; }); }

section('1. UISP Console: eight LAN, one WAN, an SFP+ on each side');
{
  const d = spec('UISP-Console');
  ok(!!d, 'the device is in the catalogue');
  eq(d.vendor, 'ubiquiti', 'from Ubiquiti');
  eq(d.category, 'router', 'and is a gateway, not a controller-only appliance');

  const topo = new Topology();
  const dev = topo.addDevice(d);
  const ifaces = [...dev.interfaces.values()];
  eq(ifaces.length, 11, 'eleven data ports, matching the vendor port list');

  const lanRj45 = ifaces.filter(function (i) { return i.role === 'lan' && i.cage === 'rj45'; });
  const wanRj45 = ifaces.filter(function (i) { return i.role === 'wan' && i.cage === 'rj45'; });
  const sfp = ifaces.filter(function (i) { return i.cage === 'sfp+'; });
  eq(lanRj45.length, 8, 'eight LAN copper ports');
  eq(wanRj45.length, 1, 'one WAN copper port');
  eq(sfp.length, 2, 'two SFP+ cages');
  ok(sfp.some(function (i) { return i.role === 'lan'; }), 'one of them on the LAN side');
  ok(sfp.some(function (i) { return i.role === 'wan'; }), 'and one on the WAN side');
}

section('2. Its SFP+ cages take 1G or 10G, not 10G only');
{
  const topo = new Topology();
  const dev = topo.addDevice(spec('UISP-Console'));
  const sfp = dev.interfaces.get('sfp1');
  eq(sfp.speedCaps.join(','), '1000,10000', 'the cage advertises both rates');
  eq(sfp.cage, 'sfp+', 'and is an SFP+ cage');

  const peer = topo.addDevice(spec('CX 6000 48G 4SFP'));
  const peerSfp = [...peer.interfaces.values()].filter(function (i) { return i.cage === 'sfp'; })[0];
  ok(!!peerSfp, 'a 1G SFP port exists on the peer');
  const v = topo.validateLink(dev.id, 'sfp1', peer.id, peerSfp.name);
  ok(v.ok, 'a 1G SFP into the 10G cage is accepted, not refused as a downgrade');
  eq(v.speedMbps, 1000, 'and runs at 1G');
}

section('3. WAN and LAN are separate surfaces on it');
{
  const topo = new Topology();
  const dev = topo.addDevice(spec('UISP-Console'));
  const sim = new Simulator(topo);
  dev.interfaces.get('lan1').ip = '192.168.1.1';
  dev.interfaces.get('lan1').mask = '255.255.255.0';

  ok(!!dev.ownsIpOn('lan1', '192.168.1.1'), 'the LAN port serves its own address');
  eq(dev.ownsIpOn('wan1', '192.168.1.1'), null,
    'the WAN port does not - LAN to WAN is the gateway\'s job, not a wire');
  ok(!!dev.ownsIpOn('lan8', '192.168.1.1'),
    'while another LAN port in the same bridge group does');
}

section('4. LiteBeam 5AC XR: one copper port and one radio');
{
  const d = spec('LBE-5AC-XR');
  ok(!!d, 'the device is in the catalogue');
  eq(d.category, 'ptp', 'it is a point-to-point radio');
  eq(d.vendor, 'ubiquiti', 'from Ubiquiti');

  const topo = new Topology();
  const dev = topo.addDevice(d);
  const eth = dev.interfaces.get('eth0');
  const radio = dev.interfaces.get('radio0');
  ok(!!eth && eth.cage === 'rj45', 'eth0 is copper');
  ok(!!radio && radio.cage === 'antenna', 'radio0 is an antenna, never an RJ45 socket');
  eq(radio.speedCaps.join(','), '867', 'the radio runs at the 80 MHz 2x2 rate');

  const ethHw = media.derivePortHardware(eth, d);
  const radioHw = media.derivePortHardware(radio, d);
  ok(media.canMate(ethHw, ethHw).ok, 'copper mates with copper');
  const bad = media.canMate(ethHw, radioHw);
  ok(!bad.ok, 'but a radio cannot be cabled to copper');
  eq(bad.code, 'E_WIRELESS_TO_WIRED', 'and the refusal says why');

  // The same refusal has to come out of link validation, not just the cage table.
  const topo2 = new Topology();
  const radio2 = topo2.addDevice(spec('LBE-5AC-XR'));
  const sw = topo2.addDevice(spec('CX 6000 48G 4SFP'));
  const v = topo2.validateLink(radio2.id, 'radio0', sw.id, '1/1/1');
  ok(!v.ok, 'cabling the antenna to a switch port is refused');
  eq(v.errors[0].code, 'E_WIRELESS_TO_WIRED', 'as a wireless-to-wired error');
}

section('5. The two radios associate, which is the point of them');
{
  const topo = new Topology();
  const a = topo.addDevice(spec('LBE-5AC-XR'));
  const b = topo.addDevice(spec('LBE-5AC-XR'));
  const v = topo.validateLink(a.id, 'radio0', b.id, 'radio0');
  ok(v.ok, 'two LiteBeam XRs can form a link');
  ok(v.speedMbps > 0, 'at a positive rate (' + v.speedMbps + ' Mbps)');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
