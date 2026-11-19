'use strict';
// The MAX HD4 MBX rows carried no PoE census, and the GLTE row was a copy of the wrong chassis.
//
// Filed under #130's fallback list (a router/gateway node for a routed lab: NAT, DHCP, VPN,
// cellular WAN - which is what an HD4 MBX is):
//   * `max-hd4-mbx-glte` declared eight `poeOut` ports and no `poe` block, so `computePoe()`
//     opened with `if (!dev.poeBudget) continue;` and skipped the box - eight 802.3at outlets
//     that powered nothing, silently;
//   * the same row had copied the NON-MBX MAX HD4 datasheet, so it claimed 400 Mbps, ten copper
//     ports (2 WAN + 8 LAN) and no budget. The MBX is a different chassis: 2.5 Gbps, eleven GE
//     ports (3 WAN + 8 LAN), 55 W max consumption, a 54V/3.34A ACW-630 adapter;
//   * its siblings MAX-HD4-MBX-LTEA and MAX-HD4-MBX-5G had the same printed PoE output row and
//     no PoE ports at all; LTEA also cited a source that now answers 403.
//
// Every figure below is the vendor's, read 2026-11-19:
//   https://www.peplink.com/compare/tech-specs/hd4-mbx.pdf (200, application/pdf, 226,176 B, 6 pp)
//     page 1: "Number of Ethernet WAN port 3 / 2 (GE)", "Number of Ethernet LAN port 8 / 9 (GE)",
//     "Maximum Ethernet WAN / LAN port configuration 3 WAN with 8 LAN, 2 WAN with 9 LAN",
//     "Router Throughput 2.5Gbps";
//     page 6: "PoE Input No", "PoE Output Up to 8x 802.3at PoE+", "Nominal Power Consumption 35",
//     "Maximum Power Consumption 55W (w/o PoE)", "AC Adapter ... DC Output 54V 3.34A [13]
//     Compatible with ACW-630", and the footnote "2x 54V DC input is needed for all 8x LAN ports
//     to have 802.3at PoE. Plugging in 1x 54V DC input will result in 4x LAN ports having 802.3at PoE."
//   https://www.peplink.com/compare/tech-specs/hd4-mbx-5g.pdf (200, application/pdf, 226,055 B, 6 pp)
//     the same WAN/LAN/throughput rows on page 1, adapter on page 5, PoE rows on page 6.
//   https://www.peplink.com/products/enterprise-mobility/mbx/ (200, 187,714 B) names the SKUs
//     MAX-HD4-MBX-GLTE-G-T and MAX-HD4-MBX-GLTE-S-T - GLTE is the CAT-20 option of this chassis.
// Two 54 V inputs: 2 x (54 V x 3.34 A) = 360.72 W, less 55 W = 305.72 W for eight 30 W ports.
// One input: 180.36 - 55 = 125.36 W, which funds four ports and not five - exactly the four the
// vendor's footnote promises, which is why 305.7 is the figure this spec records.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
function spec(model) {
  return catalog.find(function (s) { return s.vendor === 'peplink' && s.model === model; });
}

const glte = spec('MAX-HD4-MBX-GLTE');
const ltea = spec('MAX-HD4-MBX-LTEA');
const fiveG = spec('MAX-HD4-MBX-5G');
const ap = spec('AP One Flex');

console.log('The MBX family is in the catalogue:');
ok(!!glte, 'MAX-HD4-MBX-GLTE is in the catalogue');
ok(!!ltea && !!fiveG, 'MAX-HD4-MBX-LTEA and MAX-HD4-MBX-5G are in the catalogue');
ok(!!ap, 'AP One Flex (a 12.95 W PoE access point) is in the catalogue');

if (glte) {
  const ge = glte.interfaces.filter(function (i) { return i.connector === 'rj45'; });
  const pse = glte.interfaces.filter(function (i) { return i.poeOut; });
  console.log('\nGLTE is the 2.5 Gbps MBX chassis, not the 400 Mbps HD4 it had been copied from:');
  ok(ge.length === 11, 'eleven GE ports, not the ten of the plain HD4 (' + ge.length + ')');
  ok(glte.interfaces.filter(function (i) { return i.name.indexOf('wan') === 0; }).length === 3,
    'three WAN ports (WAN 3 convertible to LAN)');
  ok(!/400\s*Mbps/.test(String(glte.description)), 'the description no longer claims 400 Mbps');
  ok(/2\.5\s*Gbps/i.test(String(glte.notes)) || /2\.5\s*Gbps/i.test(String(glte.description)),
    'and the 2.5 Gbps ceiling the sheet prints is recorded');

  console.log('\nEight LAN ports source 802.3at PoE+ and nothing else claims to:');
  ok(pse.length === 8, 'eight PSE ports (' + pse.length + ')');
  ok(pse.every(function (i) { return /^lan\d+$/.test(i.name); }), 'and all eight are LAN ports');
  ok(pse.every(function (i) { return i.poeOutClass === 'PoE+'; }),
    'each labelled PoE+ (802.3at), which is what the sheet prints');
  ok(!(glte.capabilities || []).some(function (c) { return /poe-pd/.test(c); }),
    'no poe-pd: the sheet says "PoE Input No"');

  console.log('\nThe budget is the supply headroom, marked derived:');
  const dev = new Topology().addDevice(glte, 'mbx1');
  ok(dev.poeBudget === 305.7, 'the budget is 305.7 W (2 x 54 V x 3.34 A less 55 W): ' + dev.poeBudget);
  ok(dev.poeBudgetSource === 'research', 'and it comes from the spec, not the model name (' + dev.poeBudgetSource + ')');
  ok(glte.poe && /hd4-mbx\.pdf$/.test(String(glte.poe.sourceUrl)), 'the budget cites the MBX tech-spec sheet');
  ok(/derived/i.test(String(glte.poe && glte.poe.note)), 'and says in the note that it is derived, not quoted');
  const oneSupply = 54 * 3.34 - 55;
  ok(Math.round(oneSupply * 100) === 12536, 'one 54 V input leaves 125.36 W (' + oneSupply.toFixed(2) + ')');
  ok(oneSupply >= 4 * 30 && oneSupply < 5 * 30,
    'which funds four 30 W ports and not five - the vendor footnote says exactly four');
  ok(305.7 >= 8 * 30, 'both inputs fund all eight 30 W ports');

  console.log('\nAn AP cabled to it is powered instead of silently skipped:');
  const t = new Topology();
  t.addDevice(glte, 'mbx1');
  t.addDevice(ap, 'ap1');
  t.connect('mbx1', 'lan1', 'ap1', 'eth0');
  const entry = new Simulator(t).computePoe().find(function (e) { return e.dev === 'mbx1'; });
  ok(!!entry, 'computePoe() has an entry for the box at all');
  if (entry) {
    ok(entry.budget === 305.7, 'against the 305.7 W budget');
    ok(entry.used === 12.95, 'and 12.95 W used by the AP (' + entry.used + ')');
    const p = (entry.ports || []).find(function (x) { return x.iface === 'lan1'; });
    ok(!!p && p.powered === true, 'lan1 powers the AP (' + JSON.stringify(p) + ')');
  }
}

console.log('\nThe two siblings carry the same printed PoE census:');
for (const pair of [['MAX-HD4-MBX-LTEA', ltea], ['MAX-HD4-MBX-5G', fiveG]]) {
  const s = pair[1], name = pair[0];
  if (!s) { ok(false, name + ' is missing'); continue; }
  const pse = s.interfaces.filter(function (i) { return i.poeOut; });
  ok(pse.length === 8, name + ' has eight PSE ports (' + pse.length + ')');
  ok(s.poe && s.poe.budgetW === 305.7, name + ' carries the 305.7 W derived budget');
  ok(new Topology().addDevice(s, 'x1').poeBudget === 305.7, name + ' builds with that budget');
  ok(/peplink\.com\/compare\/tech-specs\/hd4-mbx/.test(String(s.sourceUrl)),
    name + ' cites an MBX tech-spec sheet, not the plain HD4 (' + s.sourceUrl + ')');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
