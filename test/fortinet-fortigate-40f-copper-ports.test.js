'use strict';
// The FortiGate 40F was modelled with a portTemplate of `internal1-4` plus a bare `wan1` - the
// 60E/60F naming, not this box's. The hardware calls its five 10/100/1000BASE-T RJ45 ports
// wan, lan1, lan2, lan3 and a, so three of the five interfaces did not exist under their real
// names (lan1-lan3 are the default 'lan' hardware switch, a is the default FortiLink port) and
// the one uplink port that did was named wan1. The template was RJ-45 but the explicit wan1
// declared no connector and no ladder at all.
//
// Fortinet's own fast path page gives both the count and the names:
//   "Five 10/100/1000BASE-T Copper (WAN, A, and 1-3) connected to the SOC4. A is a FortiLink
//    interface."
//   diagnose npu np6xlite port-list -> wan, lan1, lan2, lan3, a at 1000M
// The 40F series data sheet agrees on the front panel (1x GE RJ45 WAN, 1x GE RJ45 FortiLink,
// 3x GE RJ45 Ethernet; order code "5x GE RJ45 ports (including 4x Internal Ports, 1x WAN
// Ports)") and lists 0 PoE ports and no SFP slots.
//
// research/fortinet-fortigate-40f-copper-ports.md carries the sources.
const path = require('path');
const { Topology } = require('../engine');
const media = require('../engine/media');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  OK ' + msg); }
  else { failed++; console.error('  FAIL ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
function section(name) { console.log('\n' + name); }

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
function spec(model) {
  const s = catalog.filter(function (x) { return x.vendor === 'fortinet' && x.model === model; })[0];
  if (!s) throw new Error('missing spec ' + model);
  return s;
}
function dev(model) {
  const t = new Topology();
  return t.addDevice(spec(model), 'FW');
}

// Front panel, in the order Fortinet's port-list prints them.
const PORTS = ['wan', 'lan1', 'lan2', 'lan3', 'a'];
const LADDER = [10, 100, 1000];

section('Five copper ports, under the names the box actually uses');
{
  const s = spec('FortiGate 40F');
  const names = s.interfaces.map(function (p) { return p.name; });
  ok(names.length === 5, 'five physical interfaces declared', names.join(','));
  ok(JSON.stringify(names) === JSON.stringify(PORTS),
    'they are named wan, lan1, lan2, lan3, a (the names np6xlite port-list prints)', names.join(','));
  ok(!s.portTemplate, 'no portTemplate: internal1-4 are gone, the five rows are not interchangeable', JSON.stringify(s.portTemplate));
  ok(JSON.stringify(s.capabilities).indexOf('"firewall"') !== -1, 'still a firewall');
}

section('Every one is an RJ-45 cage on a 10/100/1000 ladder');
for (const name of PORTS) {
  const p = dev('FortiGate 40F').interfaces.get(name);
  ok(!!p, 'FortiGate 40F: ' + name + ' exists');
  ok(p && p.cage === 'rj45', 'FortiGate 40F: ' + name + ' is an RJ-45 cage', p && p.cage);
  ok(p && JSON.stringify(p.hardware.speedCaps) === JSON.stringify(LADDER),
    'FortiGate 40F: ' + name + ' trains at 10/100/1000',
    p && JSON.stringify(p.hardware.speedCaps));
}

section('There is no fibre cage, no MGMT and no HA port on a 40F');
{
  const fw = dev('FortiGate 40F');
  const cages = [];
  fw.interfaces.forEach(function (p) { cages.push(p.cage); });
  ok(cages.length === 5 && cages.every(function (c) { return c === 'rj45'; }),
    'all five cages are copper', cages.join(','));
  for (const absent of ['mgmt', 'ha', 'ha1', 'sfp1', 'wan2', 'dmz']) {
    ok(!fw.interfaces.get(absent), 'no ' + absent + ' port on a 40F', 'unexpected interface');
  }
  ok(fw.interfaces.get('wan') && !fw.interfaces.get('wan1'),
    'the WAN port is named wan, not wan1 (the 60F/80F naming), so a 40F config pastes as-is');
  ok(!fw.interfaces.get('internal1') && !fw.interfaces.get('internal4'),
    'internal1-4 are gone: a 40F has no internal* ports');
}

section('Behaviour: the ports cable like copper');
{
  const fw = dev('FortiGate 40F');
  // a is the FortiLink port and still a plain 1G copper jack: a FortiSwitch uplink is cablable.
  const fs = spec('FortiSwitch 124F');
  const t = new Topology();
  const sw = t.addDevice(fs, 'SW');
  const uplink = sw.interfaces.get('port1');
  const r = media.canMate(fw.interfaces.get('a').hardware, uplink.hardware);
  ok(r.ok === true && r.speedMbps === 1000, 'the FortiLink port (a) cables to a FortiSwitch uplink at 1G',
    r.code + ' ' + String(r.speedMbps));

  const wanToLan = media.canMate(fw.interfaces.get('wan').hardware, fw.interfaces.get('lan1').hardware);
  ok(wanToLan.ok === true && wanToLan.speedMbps === 1000, 'wan to lan1 meets at 1G',
    wanToLan.code + ' ' + String(wanToLan.speedMbps));

  // An SFP transceiver must not seat in any 40F port: the box has no cage to put it in.
  const fibrePeer = dev('FortiGate 60F').interfaces.get('sfp1') ||
    dev('FortiSwitch 148F').interfaces.get('port49');
  const bad = media.canMate(fibrePeer.hardware, fw.interfaces.get('lan3').hardware);
  ok(bad.ok === false && bad.code === 'E_CONNECTOR_MISMATCH',
    'an SFP uplink will not cable into lan3', bad.code + ': ' + bad.message);

  const slow = media.canMate(fw.interfaces.get('lan2').hardware, fw.interfaces.get('lan2').hardware);
  ok(slow.ok === true && slow.speedMbps === 1000, 'two 40F ports meet at 1G',
    slow.code + ' ' + String(slow.speedMbps));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
