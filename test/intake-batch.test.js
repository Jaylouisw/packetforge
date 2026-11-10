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

console.log('\nThe switch family agrees with its own names (#524, #525, #526):');
{
  // Four models from one vendor, whose model strings carry three numbers each: port count, uplink
  // rate and PoE budget. A spec that drifts from its own name is the kind of error nobody notices
  // until a lab refuses to cable or a budget is short, so every number in the name is checked
  // against the ports the spec actually declares.
  const family = catalog.filter(function (s) {
    return String(s.vendor).toLowerCase() === 'peplink' && /^PLS-/i.test(String(s.model));
  });
  ok(family.length >= 4, 'four PoE switches from this vendor are modelled (' + family.length + ')');

  for (const s of family) {
    const ports = effectiveInterfaces(s);
    const copper = ports.filter(function (p) { return (p.connector || '') === 'rj45'; });
    const cages = ports.filter(function (p) { return (p.connector || '') === 'sfp+'; });
    const namePorts = /^PLS-(?:R-)?(\d+)-/.exec(String(s.model));
    const nameWatts = /(\d+)W$/.exec(String(s.model));

    eq(copper.length, Number(namePorts[1]), s.model + ': the name counts the copper ports it has');
    eq(Number(s.poeBudget), Number(nameWatts[1]), s.model + ': the watts in the name are the PoE budget');
    eq(cages.length, 4, s.model + ': four SFP+ uplinks');

    // 802.3bt Type 4 on the 10G model, 802.3at Type 2 on the 2.5G family - the class, not a nickname.
    const want = /0G-\d+W$/.test(String(s.model)) ? 90 : 30;
    ok(copper.every(function (p) { return p.poeOut === want; }),
      s.model + ': every copper port sources ' + want + ' W');
    ok(cages.every(function (p) { return p.poeOut === undefined; }),
      s.model + ': the uplink cages source no power');

    // "H2G" means mixed rates: a 2.5G access port and a 1G one must be different ports, not one
    // port described twice.
    if (/H2G/i.test(String(s.model))) {
      const fast = copper.filter(function (p) { return p.speed === '2.5G'; });
      const slow = copper.filter(function (p) { return p.speed === '1G'; });
      ok(fast.length > 0 && slow.length > 0,
        s.model + ': both copper rates are modelled (' + slow.length + ' at 1G, ' + fast.length + ' at 2.5G)');
      ok(fast.every(function (p) { return (p.speedCaps || []).indexOf(2500) !== -1; }),
        s.model + ': and a 2.5G port negotiates 2.5G');
      ok(fast.every(function (p) { return (p.speedCaps || []).indexOf(100) !== -1; }),
        s.model + ': and negotiates down to 100M, which is what the PHY does on a long lead');
    }
  }

  // The rugged sibling differs from the plain one only in power and enclosure; if a later edit gives
  // them the same budget, the model has lost the reason both exist.
  const plain = find('PLS-24-H2G-410W');
  const rugged = find('PLS-R-24-H2G-250W');
  eq(effectiveInterfaces(plain).length, effectiveInterfaces(rugged).length,
    'the rugged and plain 24-port models have the same ports');
  ok(plain.poeBudget === 410 && rugged.poeBudget === 250,
    'and different PoE budgets, which is why they are two models (410 W vs 250 W)');
}

console.log('\nA managed PoE switch and an unmanaged one, from the same batch (#672, #674):');
{
  const eng = find('EWS1200-28TFP');
  const ports = effectiveInterfaces(eng);
  eq(ports.filter(function (p) { return (p.connector || '') === 'rj45'; }).length, 24, 'EWS1200-28TFP: 24 copper ports');
  eq(ports.filter(function (p) { return (p.connector || '') === 'sfp'; }).length, 4, 'EWS1200-28TFP: 4 SFP uplinks');
  eq(eng.poeBudget, 410, 'EWS1200-28TFP: the 410 W budget is the spec');
  ok(ports.filter(function (p) { return (p.connector || '') === 'rj45'; })
    .every(function (p) { return p.poeOut === 30; }), 'EWS1200-28TFP: 802.3at PoE+ is 30 W at the PSE');
  ok(!(eng.capabilities || []).includes('l3-forward'),
    'EWS1200-28TFP: modelled as L2 - the page says full-featured layer 2, the request said L3');

  // The uplinks are SFP (1G), not SFP+. The engine's own verdict is the check: a 10G SFP+ port at
  // the far end still resolves at 1000base-sx, i.e. this cage runs a 1G module, not 10G.
  const t2 = new Topology();
  const engDev = t2.addDevice(eng);
  const ten = t2.addDevice(find('PLS-8-10G-720W'));
  const uplink = t2.validateLink(engDev.id, 'sfp1', ten.id, 'uplink1', {});
  ok(uplink.ok && uplink.speedMbps === 1000,
    'EWS1200-28TFP: its SFP uplink to a 10G SFP+ port negotiates 1G (' +
    (uplink.mediaName || uplink.mediaId) + ')');

  const ed = find('ES-3308P');
  const edPorts = effectiveInterfaces(ed);
  eq(edPorts.length, 8, 'ES-3308P: eight ports');
  ok(edPorts.every(function (p) { return p.speed === '100M'; }), 'ES-3308P: all of them 10/100');
  const edDev = t2.addDevice(ed);
  eq(edDev.poeBudget, 0, 'ES-3308P: no PoE, and the budget says so rather than being guessed from a name');
  ok(!(ed.capabilities || []).includes('cli') && !(ed.capabilities || []).includes('http-server'),
    'ES-3308P: unmanaged - no console and no web interface is claimed');

  // The switch's ceiling wins, which is what a real 10/100 PHY does with a gigabit partner.
  const pc2 = t2.addDevice(catalog.find(function (s) { return s.model === 'generic-pc'; }));
  const down = t2.validateLink(edDev.id, 'port1', pc2.id, 'eth0', {});
  ok(down.ok && down.speedMbps === 100,
    'ES-3308P: a gigabit host on one of its ports runs at 100M (' + (down.mediaName || down.mediaId) + ')');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
