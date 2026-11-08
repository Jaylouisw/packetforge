'use strict';
// A port template must not leave its connector to a guess at 10G.
//
// Templates carry a prefix, a count and a speed. If they omit `connector`, the physical
// layer has to be inferred from the rate - and 10G is the one rate where both copper
// (10GBASE-T) and fibre (SFP+) are common, so the inference has to pick one. It picked
// copper, which turned this catalogue's fibre switches into racks of RJ45:
//
//   Nexus 3064PQ-10GE   48x 10G SFP+ -> 48x RJ45
//   VSP 7254XSQ         48x 10G SFP+ -> 48x RJ45
//   X590-24x-1q-2c      24x 10G SFP+ -> 24x RJ45
//   X690-48x-2q-4c      48x 10G SFP+ -> 48x RJ45
//   S6520X-30QC-EI      24x 10G SFP+ -> 24x RJ45
//   S6730-H24X6C        24x 10G SFP+ -> 24x RJ45
//   PA-5220 / PA-5410    4x / 8x 10G SFP+ -> RJ45
//
// That is 228 fibre ports modelled as copper. Nothing caught it because no port
// contradicted its declared *type* - Ethernet is Ethernet - so the port-type audit stayed
// green while the cage was wrong. What it breaks is cabling: a fibre link into one of those
// switches was refused as a connector mismatch, so a lab could not build the topology the
// device exists for.
//
// What is locked here:
//   1. no portTemplate at 10G may omit its connector;
//   2. the eight switches that were wrong resolve to fibre cages;
//   3. the three that are genuinely 10GBASE-T stay copper, because "declare, don't guess"
//      cuts both ways and blanket-fixing them to fibre would be a new lie;
//   4. a fibre link into a formerly-wrong switch is now accepted at 10G.
const path = require('path');
const { Topology } = require('../engine');
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
function spec(vendor, model) {
  return catalog.find(function (x) { return x.vendor === vendor && x.model === model; });
}
// The ports a template generates. Matched by exact name, because specs routinely put
// explicit ports in a different namespace from the template - the VSP's QSFP+ uplinks are
// 2:1-2:6 while its template emits 1:1-1:48, and the C9300's SFP+ are Gi1/1/x while the
// template emits Gi1/0/x. Slicing by prefix length conflates the two.
function templatePorts(dev, tpl) {
  const start = tpl.start || 1;
  const prefix = String(tpl.prefix || '');
  const want = new Set();
  for (let i = start; i < start + tpl.count; i++) want.add(prefix + i);
  return Array.from(dev.interfaces.values()).filter(function (i) {
    return want.has(i.name);
  });
}

section('1. No 10G template leaves its connector implicit');
{
  const guilty = catalog.filter(function (s) {
    return s.portTemplate && !s.portTemplate.connector &&
      String(s.portTemplate.speed) === '10G';
  });
  eq(guilty.length, 0,
    'every 10G portTemplate declares a connector' +
    (guilty.length ? ' - still guessing: ' +
      guilty.map(function (s) { return s.vendor + '/' + s.model; }).join(', ') : ''));
}

section('2. The fibre switches resolve to fibre');
{
  const FIBRE = [
    ['cisco', 'N3K-C3064PQ-10GE', 48],
    ['extreme', 'VSP 7254XSQ', 48],
    ['extreme', 'X590-24x-1q-2c', 24],
    ['extreme', 'X690-48x-2q-4c', 48],
    ['h3c', 'S6520X-30QC-EI', 24],
    ['huawei', 'S6730-H24X6C', 24],
    ['paloalto', 'PA-5220', 4],
    ['paloalto', 'PA-5410', 8]
  ];
  for (const row of FIBRE) {
    const s = spec(row[0], row[1]);
    ok(!!s, row[0] + '/' + row[1] + ' is in the catalogue');
    if (!s) continue;
    eq(s.portTemplate.connector, 'sfp+', row[0] + '/' + row[1] + ' declares SFP+');
    const dev = new Topology().addDevice(s);
    const ports = templatePorts(dev, s.portTemplate);
    eq(ports.length, row[2], row[0] + '/' + row[1] + ': ' + row[2] + ' template ports');
    ok(ports.every(function (i) { return i.hardware.cage === 'sfp+'; }),
      row[0] + '/' + row[1] + ': every one of them is an SFP+ cage');
    ok(ports.every(function (i) { return i.hardware.speedCaps.indexOf(10000) !== -1; }),
      row[0] + '/' + row[1] + ': and each still offers 10G');
  }
}

section('3. The copper ones stay copper - declaring is not the same as "make it fibre"');
{
  const COPPER = [
    ['aruba', 'CX 8360-48XT4C', 48],
    ['cisco', 'C9300-24UX', 24],
    ['mikrotik', 'CRS312-4C+8XG-RM', 8]
  ];
  for (const row of COPPER) {
    const s = spec(row[0], row[1]);
    ok(!!s, row[0] + '/' + row[1] + ' is in the catalogue');
    if (!s) continue;
    eq(s.portTemplate.connector, 'rj45', row[0] + '/' + row[1] + ' stays 10GBASE-T');
    const dev = new Topology().addDevice(s);
    const ports = templatePorts(dev, s.portTemplate);
    eq(ports.length, row[2], row[0] + '/' + row[1] + ': ' + row[2] + ' copper 10G ports');
    ok(ports.every(function (i) { return i.hardware.cage === 'rj45'; }),
      row[0] + '/' + row[1] + ': modelled as RJ45, because that is what they are');
  }
}

section('4. A fibre link into a formerly-wrong switch is now buildable');
{
  // Before the fix the Nexus's ports were RJ45, so this link was refused as a connector
  // mismatch even though both ends are 10G SFP+ in reality.
  const t = new Topology();
  const nexus = t.addDevice(spec('cisco', 'N3K-C3064PQ-10GE'));
  const peer = t.addDevice(spec('aruba', 'CX 8320 48SFP+ 6QSFP+'));
  const link = t.validateLink(nexus.id, 'Eth1/1', peer.id, '1/1/1');
  eq(link.ok, true, 'Nexus Eth1/1 to Aruba 1/1/1 is a legal cable');
  eq(link.speedMbps, 10000, 'at 10 Gbps');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
