'use strict';
// intake-batch.test.js - two hardware requests closed by modelling, and what each spec must keep true.
//
// Both specs came from open `[Device]` requests, and both have a claim inside them that a later
// edit could quietly break, so each claim is pinned here rather than left in a description:
//
//   asus/RT-AX89U     the model string this board reports *is* the RT-AX89X hardware, so the two
//                     specs must describe the same set of sockets. If one is edited and the other
//                     is not, the catalogue is claiming two products where there is one board.
//   peplink/PLS-8-10G-720W
//                     the 720 W is a PoE budget (the PSU is 900 W), every copper port is
//                     802.3bt Type 4 (90 W), and the four uplinks are SFP+ cages rather than
//                     copper - the three facts a cable verdict depends on.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { loadCatalog, effectiveInterfaces } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + (actual === expected ? '' : ' (got ' + JSON.stringify(actual) +
    ', want ' + JSON.stringify(expected) + ')'));
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function find(model) {
  return catalog.find(function (s) { return String(s.model).toUpperCase() === model.toUpperCase(); });
}

console.log('Two model strings, one board (request #8):');
{
  const u = find('RT-AX89U');
  const x = find('RT-AX89X');
  ok(!!u, 'RT-AX89U is in the catalogue - the model string the hardware actually reports');
  ok(!!x, 'and RT-AX89X is still there, because that is what is printed on the box');
  ok(!!(u && u.sourceUrl), 'the new spec carries the datasheet it was taken from');
  ok(!!(u && u.notes && /RT-AX89X/.test(u.notes)), 'and its notes say which board it is, so the next reader is not guessing');

  const su = effectiveInterfaces(u).map(function (i) {
    return [i.name, i.type, i.speed, i.connector || null, JSON.stringify(i.speedCaps || null)].join('|');
  }).sort();
  const sx = effectiveInterfaces(x).map(function (i) {
    return [i.name, i.type, i.speed, i.connector || null, JSON.stringify(i.speedCaps || null)].join('|');
  }).sort();
  eq(su.join(','), sx.join(','), 'the two specs describe exactly the same sockets');
  ok(su.length === 13, 'thirteen ports: 1 WAN, 8 LAN, 10G copper, 10G cage, two radios (' + su.length + ')');
  ok(su.some(function (p) { return /10g-sfp/.test(p) && /sfp\+/.test(p); }),
    'the 10G cage is a cage, not a copper port with a 10G label');
}

console.log('\nThe PoE budget is a PoE budget (request #523):');
{
  const sw = find('PLS-8-10G-720W');
  ok(!!sw, 'the switch is in the catalogue');
  const ports = effectiveInterfaces(sw);
  eq(ports.length, 12, 'twelve ports: eight copper and four cages');
  const copper = ports.filter(function (p) { return (p.connector || '') === 'rj45'; });
  const cages = ports.filter(function (p) { return (p.connector || '') === 'sfp+'; });
  eq(copper.length, 8, 'eight RJ45 ports');
  eq(cages.length, 4, 'four SFP+ uplinks');
  ok(copper.every(function (p) { return p.poeOut === 90; }),
    'every copper port sources 90 W - 802.3bt Type 4, not Type 3');
  ok(cages.every(function (p) { return p.poeOut === undefined; }), 'the cages source no power');

  // Budget from the spec, not from the number in the model name: the two agree here, and the test
  // says which source answered so a future rename cannot silently change the budget.
  const t = new Topology();
  const dev = t.addDevice(sw);
  eq(dev.poeBudget, 720, 'the budget is 720 W');
  eq(dev.poeBudgetSource, 'spec', 'and it comes from the spec, not from parsing "720W" out of the model');

  // What the hardware decides: copper-to-copper takes a copper lead, and a cage is not a copper port.
  const pc = t.addDevice(catalog.find(function (s) { return s.model === 'generic-pc'; }));
  const copperLink = t.linkOptions(dev.id, pc.id, {});
  const pairs = (copperLink && copperLink.options || []).reduce(function (n, o) {
    return n + (o.pairs ? o.pairs.length : 0);
  }, 0);
  ok(copperLink && copperLink.ok && pairs >= 8,
    'a copper link from this switch to a host is offered on every copper port (' + pairs + ' pairs)');
  const into = t.validateLink(dev.id, 'uplink1', pc.id, 'eth0', {});
  ok(!into.ok, 'and a copper lead into an SFP+ uplink is refused (' + (into.errors[0] || {}).code + ')');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
