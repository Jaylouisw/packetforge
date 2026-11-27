'use strict';
// The two EX access switches in the catalogue - EX3400-48T and EX4300-48T - get their 48 access ports
// from a portTemplate that said only `type: ethernet, speed: 1G`. No connector, no ladder: the engine
// inferred an RJ-45 socket from the rate, which was right by luck and could never be contradicted
// (issue #1398). Both boxes also had their uplinks on the wrong PIC, and the EX4300 declared its four
// built-in 40GbE QSFP+ ports as 10G SFP+.
//
// Juniper states both facts plainly:
//
//   EX3400 System Overview (TechLibrary):
//     "Either 24 or 48 RJ-45 ports (labeled 0 through 23 or 0 through 47) that support
//      10/100/1000BASE-T Gigabit Ethernet connectors."
//   EX3400 Switch Default Configuration:
//     "The four uplink ports on the front panel of EX3400 switches are listed as ge-0/2/0 through
//      ge-0/2/3 and xe-0/2/0 through xe-0/2/3."
//   EX3400 System Overview, CLI mapping table: "4x GE SFP+ / PIC 2 / SFP+ uplink ports on the front
//     panel"; "2x XE QSFP+ / PIC 1 / QSFP+ uplink ports on the rear panel."
//
//   EX4300 System Overview (TechLibrary):
//     "The 48-port EX4300 switches EX4300-48T and EX4300-48P provide 48 built-in 10/100/1000BASE-T
//      Ethernet network ports ... and four built-in quad small form-factor pluggable plus (QSFP+)
//      ports that can house 40-Gigabit QSFP+ transceivers."
//     "Each switch provides a slot for installing an optional 4-port 10-Gigabit Ethernet SFP+ uplink
//      module (model number: EX-UM-4X4SFP)."
//   Understanding Interfaces (Junos OS): "On EX4300 switches, the PIC number is 0 for built-in network
//     ports, 1 for built-in QSFP+ ports (located on the rear panel of the switch), and 2 for uplink
//     module ports."
//
// research/juniper-ex-copper-ports.md carries the sources and what is left open.
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
  const s = catalog.filter(function (x) { return x.vendor === 'juniper' && x.model === model; })[0];
  if (!s) throw new Error('missing spec ' + model);
  return s;
}
function dev(model) {
  const t = new Topology();
  return t.addDevice(spec(model), 'SW');
}
const MODELS = ['EX3400-48T', 'EX4300-48T'];
// A port the change may not have created yet still has to produce a FAIL, not a TypeError.
function hw(sw, name) { const p = sw.interfaces.get(name); return (p && p.hardware) || {}; }

section('The template declares the jack and the ladder, not just a rate');
for (const model of MODELS) {
  const tpl = spec(model).portTemplate || {};
  ok(tpl.connector === 'rj45', model + ': portTemplate declares connector rj45', 'connector=' + String(tpl.connector));
  ok(JSON.stringify(tpl.speedCaps) === JSON.stringify([10, 100, 1000]),
    model + ': portTemplate declares speedCaps [10,100,1000]', JSON.stringify(tpl.speedCaps));
  ok(tpl.count === 48 && tpl.prefix === 'ge-0/0/' && tpl.start === 0,
    model + ': the template still generates ge-0/0/0-47', tpl.prefix + String(tpl.start) + ' x' + tpl.count);
}

section('And the ports it expands to carry that declaration');
for (const model of MODELS) {
  const sw = dev(model);
  const bad = [];
  for (let n = 0; n < 48; n++) {
    const p = sw.interfaces.get('ge-0/0/' + n);
    if (!p) { bad.push(n + '=missing'); continue; }
    const caps = (p.hardware && p.hardware.speedCaps) || [];
    const offered = (p.hardware && p.hardware.media) || [];
    const wrong = p.cage !== 'rj45' || caps.indexOf(10) === -1 || caps.indexOf(100) === -1 ||
      caps.indexOf(1000) === -1 || caps.indexOf(2500) !== -1 ||
      offered.indexOf('10base-t') === -1 || offered.indexOf('100base-tx') === -1 ||
      offered.indexOf('1000base-t') === -1;
    if (wrong) bad.push('ge-0/0/' + n + '=' + p.cage + JSON.stringify(caps));
  }
  ok(bad.length === 0, model + ': all 48 access ports are RJ-45 at 10/100/1000' +
    (bad.length ? ' (' + bad.slice(0, 4).join(', ') + ')' : ''));
}

section('Cabling: a cable meets an access port, an optic does not');
for (const model of MODELS) {
  const sw = dev(model);
  const a = sw.interfaces.get('ge-0/0/0'), b = sw.interfaces.get('ge-0/0/47');
  const g = media.canMate(a.hardware, b.hardware, { mediaId: '1000base-t' });
  ok(g.ok === true && g.speedMbps === 1000, model + ': two access ports meet over 1000BASE-T at 1G',
    g.code + ': ' + g.message);
  const h = media.canMate(a.hardware, b.hardware, { mediaId: '100base-tx' });
  ok(h.ok === true, model + ': 100BASE-TX is not refused', h.code + ': ' + h.message);
  const c = media.canMate(a.hardware, b.hardware, { mediaId: '10base-t' });
  ok(c.ok === true, model + ': nor is 10BASE-T', c.code + ': ' + c.message);
  const fibre = media.canMate(a.hardware, hw(sw, 'xe-0/2/0'), { mediaId: '1000base-sx' });
  ok(fibre.ok === false && fibre.code === 'E_CONNECTOR_MISMATCH',
    model + ': a 1000BASE-SX optic into an access port is a connector mismatch',
    fibre.code + ': ' + fibre.message);
}

section('EX3400-48T: four 1G/10G SFP+ uplinks on PIC 2, two 40G QSFP+ on PIC 1');
{
  const sw = dev('EX3400-48T');
  const bad = [];
  for (let n = 0; n < 4; n++) {
    const p = sw.interfaces.get('xe-0/2/' + n);
    const caps = p ? p.hardware.speedCaps : [];
    if (!p || p.cage !== 'sfp+' || JSON.stringify(caps) !== JSON.stringify([1000, 10000])) {
      bad.push('xe-0/2/' + n + '=' + (p && p.cage) + JSON.stringify(caps));
    }
  }
  ok(bad.length === 0, 'xe-0/2/0-3 are SFP+ cages offering 1G and 10G' + (bad.length ? ' (' + bad.join(', ') + ')' : ''));
  const q = [];
  for (let n = 0; n < 2; n++) {
    const p = sw.interfaces.get('et-0/1/' + n);
    const caps = p ? p.hardware.speedCaps : [];
    if (!p || p.cage !== 'qsfp+' || JSON.stringify(caps) !== JSON.stringify([40000])) {
      q.push('et-0/1/' + n + '=' + (p && p.cage) + JSON.stringify(caps));
    }
  }
  ok(q.length === 0, 'et-0/1/0-1 are QSFP+ cages at 40G' + (q.length ? ' (' + q.join(', ') + ')' : ''));
  const swapped = ['xe-0/1/0', 'xe-0/1/1', 'xe-0/1/2', 'xe-0/1/3', 'et-0/2/0', 'et-0/2/1']
    .filter(function (n) { return sw.interfaces.has(n); });
  ok(swapped.length === 0, 'and the swapped PIC digits (xe-0/1/x, et-0/2/x) are gone', swapped.join(', '));
  const o = media.canMate(hw(sw, 'xe-0/2/0'), hw(sw, 'xe-0/2/1'),
    { mediaId: '10gbase-sr' });
  ok(o.ok === true && o.speedMbps === 10000, 'two uplink ports meet over a 10GBASE-SR optic at 10G',
    o.code + ': ' + o.message);
  const s = media.canMate(sw.interfaces.get('xe-0/2/0').hardware, sw.interfaces.get('xe-0/2/1').hardware,
    { mediaId: '1000base-sx' });
  ok(s.ok === true, 'and over a 1G SFP optic at 1G, which is what dual-mode means',
    s.code + ': ' + s.message);
  const rj = media.canMate(hw(sw, 'ge-0/0/0'), hw(sw, 'et-0/1/0'),
    { mediaId: '1000base-t' });
  ok(rj.ok === false && rj.code === 'E_CONNECTOR_MISMATCH', 'a copper lead into a QSFP+ port is refused',
    rj.code + ': ' + rj.message);
}

section('EX4300-48T: four built-in 40G QSFP+ on PIC 1, the 4x10G module on PIC 2');
{
  const sw = dev('EX4300-48T');
  const q = [];
  for (let n = 0; n < 4; n++) {
    const p = sw.interfaces.get('et-0/1/' + n);
    const caps = p ? p.hardware.speedCaps : [];
    if (!p || p.cage !== 'qsfp+' || JSON.stringify(caps) !== JSON.stringify([40000])) {
      q.push('et-0/1/' + n + '=' + (p && p.cage) + JSON.stringify(caps));
    }
  }
  ok(q.length === 0, 'et-0/1/0-3 are QSFP+ cages at 40G, not 10G ports' + (q.length ? ' (' + q.join(', ') + ')' : ''));
  const m = [];
  for (let n = 0; n < 4; n++) {
    const p = sw.interfaces.get('xe-0/2/' + n);
    const caps = p ? p.hardware.speedCaps : [];
    if (!p || p.cage !== 'sfp+' || JSON.stringify(caps) !== JSON.stringify([1000, 10000])) {
      m.push('xe-0/2/' + n + '=' + (p && p.cage) + JSON.stringify(caps));
    }
  }
  ok(m.length === 0, 'xe-0/2/0-3 are the uplink module: SFP+ at 1G and 10G' + (m.length ? ' (' + m.join(', ') + ')' : ''));
  const o = media.canMate(hw(sw, 'et-0/1/0'), hw(sw, 'et-0/1/1'),
    { mediaId: '40gbase-sr4' });
  ok(o.ok === true && o.speedMbps === 40000, 'two built-in uplinks meet over 40GBASE-SR4 at 40G',
    o.code + ': ' + o.message);
}

section('Across the family: the 10G uplinks of the two models are the same cage');
{
  const a = dev('EX3400-48T'), b = dev('EX4300-48T');
  const g = media.canMate(hw(a, 'xe-0/2/0'), hw(b, 'xe-0/2/0'), { mediaId: '10gbase-sr' });
  ok(g.ok === true && g.speedMbps === 10000, 'EX3400-48T xe-0/2/0 links EX4300-48T xe-0/2/0 at 10G',
    g.code + ': ' + g.message);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
