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

console.log('\nA PoE-powered access point and a router whose ports have two roles (#678, #680):');
{
  const ap = find('VigorAP 962C');
  const apPorts = effectiveInterfaces(ap);
  eq(apPorts.length, 3, 'VigorAP 962C: one wired uplink and two radios');
  const uplink = apPorts.filter(function (p) { return p.type === 'ethernet'; })[0];
  eq(uplink.speed, '2.5G', 'VigorAP 962C: the wired port is 2.5G');
  ok((uplink.speedCaps || []).indexOf(2500) !== -1 && (uplink.speedCaps || []).indexOf(10) !== -1,
    'VigorAP 962C: it accepts 2.5G down to 10M, as the port does');
  eq(uplink.poeIn, 12, 'VigorAP 962C: it is a powered device drawing 12 W');
  ok((ap.capabilities || []).includes('wireless') && (ap.capabilities || []).includes('cli'),
    'VigorAP 962C: wireless, and its Telnet/SSH console is a real capability');

  // Powered from a PoE+ port and running at 2.5G: the two facts a lab needs from this AP.
  const t3 = new Topology();
  const apDev = t3.addDevice(ap);
  const pse = t3.addDevice(find('PLS-24-H2G-410W'));
  // port17 is the first 2.5G copper port on that switch; ports 1-16 are 1G, so cabling there would
  // prove only that the AP downshifts.
  const cab = t3.validateLink(apDev.id, 'eth0', pse.id, 'port17', {});
  ok(cab.ok && cab.speedMbps === 2500, 'VigorAP 962C: on a 2.5G PoE+ port it links at 2.5G (' +
    (cab.mediaName || cab.mediaId) + ')');
  t3.connect(apDev.id, 'eth0', pse.id, 'port17', {});
  const sim3 = new Simulator(t3);
  sim3.computePoe();
  ok(apDev.poeUnpowered !== true, 'VigorAP 962C: the PoE+ switch powers it');
  const apLink = t3.links.get(cab.linkId) || Array.from(t3.links.values())[0];
  ok(!!apLink, 'VigorAP 962C: the cable exists, so the power decision was made on a real link');

  const rt = find('Vigor 3912');
  const rtPorts = effectiveInterfaces(rt);
  eq(rtPorts.length, 12, 'Vigor 3912: twelve data ports');
  eq(rtPorts.filter(function (p) { return (p.connector || '') === 'sfp+'; }).length, 2,
    'Vigor 3912: two 10G SFP+ cages');
  eq(rtPorts.filter(function (p) { return Array.isArray(p.dualRole); }).length, 8,
    'Vigor 3912: eight ports are WAN or LAN by configuration');
  eq(rtPorts.filter(function (p) { return !Array.isArray(p.dualRole) && p.role === 'lan'; }).length, 4,
    'Vigor 3912: and four are fixed LAN');
  ok(rtPorts.filter(function (p) { return Array.isArray(p.dualRole); })
    .every(function (p) { return p.dualRole.indexOf('wan') !== -1 && p.dualRole.indexOf('lan') !== -1; }),
    'Vigor 3912: a switchable port offers both roles, not one');
  ok(rtPorts.filter(function (p) { return p.role === 'lan' && p.bridgeGroup; }).length === 4,
    'Vigor 3912: the fixed LAN ports share one bridge group, as a consumer router\'s LAN sockets do');
}

console.log('\nTwo data-centre leaf switches whose uplink block is the same (#762, #763):');
{
  // Both are 1U ToR leaves from one vendor: 48 access ports and 8x 100G QSFP28 uplinks. The pair is
  // worth pinning together because the only difference is the access rate, and a spec that drifted
  // on one of them would hand a lab 10G ports where the hardware has 25G.
  const b48 = find('N8560-48BC');
  const s48 = find('N5860-48SC');
  const pb = effectiveInterfaces(b48), ps = effectiveInterfaces(s48);

  eq(pb.length, 57, 'N8560-48BC: 48 access ports, 8 uplinks and a management port');
  eq(ps.length, 57, 'N5860-48SC: the same count');
  eq(pb.filter(function (p) { return (p.connector || '') === 'qsfp28'; }).length, 8,
    'N8560-48BC: eight QSFP28 uplinks');
  eq(ps.filter(function (p) { return (p.connector || '') === 'qsfp28'; }).length, 8,
    'N5860-48SC: eight QSFP28 uplinks');

  eq(b48.portTemplate.speed, '25G', 'N8560-48BC: the access ports are 25G');
  eq(s48.portTemplate.speed, '10G', 'N5860-48SC: and on the other model they are 10G');
  ok((b48.portTemplate.speedCaps || []).indexOf(10000) !== -1,
    'N8560-48BC: a 25G port still takes a 10G SFP+ module');
  ok((s48.portTemplate.speedCaps || []).indexOf(1000) !== -1,
    'N5860-48SC: and a 10G port takes a 1G SFP');

  // The uplink block accepts 40G optics in a 100G cage on both, which is what the datasheet says.
  ok(pb.concat(ps).filter(function (p) { return (p.connector || '') === 'qsfp28'; })
    .every(function (p) { return (p.speedCaps || []).indexOf(40000) !== -1; }),
    'both: the 100G cages accept 40G QSFP+ optics');
  // ...but neither claims a 4x25G breakout, because the datasheet states only 40/100G.
  ok(pb.concat(ps).filter(function (p) { return (p.connector || '') === 'qsfp28'; })
    .every(function (p) { return (p.speedCaps || []).indexOf(25000) === -1; }),
    'both: and neither invents a 25G breakout the datasheet does not list');

  // The consequence of not claiming a breakout: a 10G SFP+ optic cannot go into a 40/100G QSFP28
  // cage, and the engine says so rather than quietly running the link at 10G.
  const t4 = new Topology();
  const leaf = t4.addDevice(b48);
  const host = t4.addDevice(find('PLS-8-10G-720W'));
  const up = t4.validateLink(leaf.id, 'qsfp28-1', host.id, 'uplink1', {});
  ok(!up.ok, 'N8560-48BC: a 10G SFP+ optic in a 40/100G cage is refused (' +
    ((up.errors[0] || {}).code || 'no code') + ')');
}

console.log('\nA VDSL router whose WAN is not a LAN port (#691):');
{
  const rt = find('Vigor 2767ax');
  const ports = effectiveInterfaces(rt);
  eq(ports.length, 7, 'Vigor 2767ax: DSL, Ethernet WAN, three LAN ports and two radios');
  const dsl = ports.filter(function (p) { return p.type === 'dsl'; })[0];
  ok(!!dsl, 'Vigor 2767ax: the VDSL2 modem is its own port, modelled as the dsl medium');
  eq(dsl.role, 'wan', 'Vigor 2767ax: and it is a WAN');
  const wan = ports.filter(function (p) { return p.name === 'wan'; })[0];
  eq(wan.speed, '2.5G', 'Vigor 2767ax: the Ethernet WAN is the 2.5GbE port');
  eq(wan.role, 'wan', 'Vigor 2767ax: as a WAN, not as one of the LAN ports');
  eq(ports.filter(function (p) { return p.role === 'lan'; }).length, 3,
    'Vigor 2767ax: three LAN ports, which is what the page states');

  // The physical consequence, both ways: a phone line cannot be plugged into Ethernet, and the
  // 2.5G port accepts a host at its own negotiated rate.
  const t5 = new Topology();
  const rtDev = t5.addDevice(rt);
  const host = t5.addDevice(find('generic-pc'));
  const phone = t5.validateLink(rtDev.id, 'dsl0', host.id, 'eth0', {});
  ok(!phone.ok, 'Vigor 2767ax: the DSL port refuses an RJ45 lead (' +
    ((phone.errors[0] || {}).code || 'no code') + ')');
  const copper = t5.validateLink(rtDev.id, 'lan1', host.id, 'eth0', {});
  ok(copper.ok && copper.speedMbps === 1000, 'Vigor 2767ax: a LAN port links to a 1G host at 1G');
}

console.log('\nTwo Ubiquiti devices that are 100M, not gigabit (#43, #322):');
{
  // The trap both of these share: the names suggest modern UniFi gear and the hardware is Fast
  // Ethernet. A spec that guessed "1G" would let a lab cable them at a rate the port cannot carry.
  const uap = find('UniFi AP (UAP)');
  const apPorts = effectiveInterfaces(uap);
  eq(apPorts.length, 2, 'UniFi AP (UAP): one Ethernet port and one radio');
  eq(apPorts[0].speed, '100M', 'UniFi AP (UAP): the wired port is 10/100');
  eq(apPorts[0].poeIn, 4, 'UniFi AP (UAP): it is a powered device drawing 4 W');
  eq(apPorts[1].speed, '300M', 'UniFi AP (UAP): 2.4 GHz 802.11n, 300 Mbps');
  ok(!(uap.capabilities || []).includes('cli'),
    'UniFi AP (UAP): no console - the UniFi Controller is the management surface');

  const cube = find('airCube ACB-ISP');
  const cubePorts = effectiveInterfaces(cube);
  eq(cubePorts.filter(function (p) { return p.type === 'ethernet'; }).length, 4,
    'airCube: four Fast Ethernet ports');
  ok(cubePorts.filter(function (p) { return p.type === 'ethernet'; })
    .every(function (p) { return p.speed === '100M'; }), 'airCube: every one of them 10/100');
  eq(cubePorts.filter(function (p) { return p.role === 'wan'; }).length, 1,
    'airCube: exactly one WAN port, which is where the PoE passthrough lives');
  eq(cubePorts.filter(function (p) { return p.poeIn === 5; }).length, 1,
    'airCube: power comes in on one port only, and the spec says which');

  // The physical consequence: a 100M port runs a gigabit partner at 100M, not at 1G.
  const t6 = new Topology();
  const uapDev = t6.addDevice(uap);
  const host = t6.addDevice(find('generic-pc'));
  const link = t6.validateLink(uapDev.id, 'eth0', host.id, 'eth0', {});
  ok(link.ok && link.speedMbps === 100,
    'UniFi AP (UAP): a gigabit host on its port runs at 100M (' + (link.mediaName || link.mediaId) + ')');
}

console.log('\nThe one plug-in-the-wall device and the one that is powered over its cable (#138, #213):');
{
  // The engine infers PoE-in for anything called "UniFi" (engine/media.js isPoePd). Most of that family
  // earns it; the Dream Machine does not, and the difference is a spec that says so out loud.
  const udm = find('UDM');
  eq(effectiveInterfaces(udm).filter(function (p) { return p.type === 'ethernet'; }).length, 5,
    'UDM: five RJ45 ports, one WAN and four LAN, as the page states twice');
  ok(effectiveInterfaces(udm).filter(function (p) { return p.type === 'ethernet'; })
    .every(function (p) { return p.poeIn === 0; }),
    'UDM: every port declares poeIn 0 - it runs from an internal AC adapter and cannot be fed over copper');

  const t7 = new Topology();
  const udmDev = t7.addDevice(udm);
  const pc = t7.addDevice(find('generic-pc'));
  const v = t7.validateLink(udmDev.id, 'lan1', pc.id, 'eth0', {});
  ok(v.ok && !(v.warnings || []).some(function (w) { return w.code === 'W_POE_DRAW'; }),
    'UDM: a PC on a LAN port draws no phantom PoE warning');

  // The other half of the same coin: a radio base really is a powered device, and a PC cannot feed it.
  const ps = find('PS-5AC');
  const psPorts = effectiveInterfaces(ps);
  eq(psPorts.filter(function (p) { return p.type === 'ethernet'; }).length, 1,
    'PS-5AC: a single Ethernet port, which is both data and power');
  eq(psPorts[0].poeIn, 10, 'PS-5AC: passive PoE in, 10 W');
  const t8 = new Topology();
  const psDev = t8.addDevice(ps);
  const pc2 = t8.addDevice(find('generic-pc'));
  const v2 = t8.validateLink(psDev.id, 'eth0', pc2.id, 'eth0', {});
  ok((v2.warnings || []).some(function (w) { return w.code === 'W_POE_DRAW'; }),
    'PS-5AC: a PC on that port is flagged as unable to power it');

  const cube = find('airCube ACB-ISP');
  const cubePoe = effectiveInterfaces(cube).filter(function (p) { return p.type === 'ethernet'; });
  eq(cubePoe.filter(function (p) { return p.poeIn > 0; }).length, 1,
    'airCube: only LAN port 1 accepts power; the other three declare poeIn 0 rather than being inferred');
}

console.log('\nA cellular WAN is not a cable and an IPMI port is not a LAN port (#12, #22):');
{
  const ubr = find('UBR-LTE');
  const ubrPorts = effectiveInterfaces(ubr);
  eq(ubrPorts.filter(function (p) { return p.type === 'ethernet'; }).length, 5,
    'UBR-LTE: one Gigabit WAN and four Gigabit LAN - five copper sockets');
  eq(ubrPorts.filter(function (p) { return p.name.indexOf('wwan') === 0; }).length, 2,
    'UBR-LTE: two embedded LTE modems, kept as wwan ports rather than dropped');
  eq(effectiveInterfaces(ubr).filter(function (p) { return p.role === 'wan'; }).length, 3,
    'UBR-LTE: three WAN paths - one copper and two cellular, which is the whole point of the box');
  ok(!(ubr.capabilities || []).includes('wireless'),
    'UBR-LTE: no Wi-Fi, so no wireless capability despite two radio-bearer interfaces');

  // A cellular bearer has no connector: a lab must not be able to patch a PC into it.
  const t9 = new Topology();
  const ubrDev = t9.addDevice(ubr);
  const pc3 = t9.addDevice(find('generic-pc'));
  const cell = t9.validateLink(ubrDev.id, 'wwan0', pc3.id, 'eth0', {});
  ok(!cell.ok, 'UBR-LTE: an LTE modem cannot be patched to a copper port (' +
    ((cell.errors[0] || {}).code || 'no code') + ')');

  const uas = find('UAS-XG');
  const uasPorts = effectiveInterfaces(uas);
  eq(uasPorts.length, 3, 'UAS-XG: two data ports and one out-of-band management port');
  eq(uasPorts[0].speedCaps.indexOf(1000) !== -1, true,
    'UAS-XG: 10GBase-T falls back to 1G - the ladder is stated, not assumed');
  const ipmi = uasPorts.filter(function (p) { return p.name === 'ipmi'; })[0];
  ok(!!ipmi && ipmi.bridgeGroup === undefined,
    'UAS-XG: IPMI is out-of-band and not in the LAN bridge group');
  ok(uasPorts.every(function (p) { return !p.poeIn; }),
    'UAS-XG: mains-powered, no PoE in on any port');

  const t10 = new Topology();
  const srv = t10.addDevice(uas);
  const sw = t10.addDevice(find('PLS-24-H2G-410W'));
  const v3 = t10.validateLink(srv.id, 'eth0', sw.id, 'port1', {});
  ok(v3.ok && v3.speedMbps === 1000, 'UAS-XG: a 10GBase-T port links to a 1G switch port at 1G');
}

console.log('\nA mesh router with one LAN socket (#281):');
{
  const ins = find('AFI-INS-R');
  const ports = effectiveInterfaces(ins);
  eq(ports.filter(function (p) { return p.type === 'ethernet'; }).length, 2,
    'AFI-INS-R: two copper sockets - one WAN and one LAN, not a four-port switch');
  eq(ports.filter(function (p) { return p.role === 'lan'; }).length, 1,
    'AFI-INS-R: exactly one LAN port, so a second wired device needs a switch');
  eq(ports.filter(function (p) { return p.type === 'wireless'; }).map(function (p) { return p.speed; })
    .join(','), '300M,867M', 'AFI-INS-R: the quoted 802.11n and 802.11ac rates, not an inferred class');
  ok(!(ins.capabilities || []).includes('cli'),
    'AFI-INS-R: managed from the app and its touchscreen - no console');
  ok(ports.filter(function (p) { return p.type === 'ethernet'; })
    .every(function (p) { return p.poeIn === 0; }),
    'AFI-INS-R: mains powered, and it says so instead of letting the AP heuristic guess');
}

console.log('\nTwo TAPs, one of which has no monitor port on the wire (#661, #665):');
{
  const agg = find('P10GSFPA');
  eq(agg.passive, true, 'P10GSFPA: a passive TAP, not an aggregating appliance');
  eq((agg.capabilities || []).length, 0, 'P10GSFPA: nothing inside it to have capabilities with');
  const aggPorts = effectiveInterfaces(agg);
  eq(aggPorts.length, 4, 'P10GSFPA: four SFP+ cages');
  eq(aggPorts.filter(function (p) { return p.connector === 'sfp+'; }).length, 4,
    'P10GSFPA: all four are SFP+ - there is no copper on this box');
  ok(aggPorts.every(function (p) { return p.speedCaps.indexOf(1000) !== -1 && p.speedCaps.indexOf(10000) !== -1; }),
    'P10GSFPA: each cage is 1G/10G, the ladder the datasheet states');

  // A copper host cannot be patched into an SFP+ cage, so the refusal is the correct answer.
  const t11 = new Topology();
  const aggDev = t11.addDevice(agg);
  const pcA = t11.addDevice(find('generic-pc'));
  const noCage = t11.validateLink(aggDev.id, 'netA', pcA.id, 'eth0', {});
  ok(!noCage.ok, 'P10GSFPA: an RJ45 host needs a module in the cage (' +
    ((noCage.errors[0] || {}).code || 'no code') + ')');

  const field = find('P1GCUA_mini');
  const fieldPorts = effectiveInterfaces(field);
  eq(fieldPorts.length, 2, 'P1GCUA_mini: two network ports and no in-band monitor port');
  ok(fieldPorts.every(function (p) { return p.name.indexOf('mon') !== 0; }),
    'P1GCUA_mini: the copies leave through USB 3.0, which is not a network medium, so no mon port is declared');
  eq(field.passive, true, 'P1GCUA_mini: passive, DIP-switch configured');

  const t12 = new Topology();
  const fieldDev = t12.addDevice(field);
  const hostA = t12.addDevice(find('generic-pc'));
  const copper = t12.validateLink(fieldDev.id, 'netA', hostA.id, 'eth0', {});
  ok(copper.ok && copper.speedMbps === 1000, 'P1GCUA_mini: a copper host links to its network port at 1G');
}

console.log('\nA fibre TAP converts media as it copies (#666, #667):');
{
  // Both are the same box with a different fixed optic: multimode on one, single-mode on the other.
  // The network side is LC ferrule, the monitor side is SFP+ cages - it is not symmetric.
  ['P10GMSA-5', 'P10GSSA-5'].forEach(function (model) {
    const t = find(model);
    eq(t.passive, true, model + ': passive - A and B carry traffic with the TAP unpowered');
    const ports = effectiveInterfaces(t);
    eq(ports.filter(function (p) { return p.name.indexOf('net') === 0 && p.connector === 'lc'; }).length, 2,
      model + ': two LC network ports - fibre terminates in the TAP, there is no cage');
    eq(ports.filter(function (p) { return p.name.indexOf('mon') === 0 && p.connector === 'sfp+'; }).length, 2,
      model + ': two SFP+ monitor cages - the monitor side takes optics');
    ok(ports.every(function (p) { return p.speedCaps.indexOf(1000) !== -1 && p.speedCaps.indexOf(10000) !== -1; }),
      model + ': every port is 1G/10G, as the model table states');
  });

  // The consequence: LC fibre talks to LC fibre, and refuses copper outright.
  const t13 = new Topology();
  const smf = t13.addDevice(find('P10GSSA-5'));
  const mmf = t13.addDevice(find('P10GMSA-5'));
  const fibre = t13.validateLink(smf.id, 'netA', mmf.id, 'netA', {});
  ok(fibre.ok && fibre.speedMbps === 10000, 'P10GSSA-5: an LC port links to another LC port at 10G');
  ok((fibre.media || []).indexOf('10gbase-lr') !== -1,
    'P10GSSA-5: and the medium it negotiates is single-mode 10GBASE-LR, not copper');

  const pc4 = t13.addDevice(find('generic-pc'));
  const copper = t13.validateLink(smf.id, 'netB', pc4.id, 'eth0', {});
  ok(!copper.ok, 'P10GSSA-5: an RJ45 host cannot be patched into an LC port (' +
    ((copper.errors[0] || {}).code || 'no code') + ')');
}

console.log('\nThe 25G sibling of a TAP already in the catalogue (#659):');
{
  const om = find('OM4501');
  const ports = effectiveInterfaces(om);
  eq(ports.length, 4, 'OM4501: one tap is four LC ports - two network, two monitor');
  ok(ports.every(function (p) { return p.connector === 'lc'; }),
    'OM4501: all four are LC multimode, not cages and not copper');
  ok(ports.every(function (p) { return p.speedCaps.indexOf(25000) !== -1; }),
    'OM4501: 25G is on the ladder - that is what distinguishes it from the OM3501');
  eq(om.passive, true, 'OM4501: no power source, so nothing to configure and no capabilities');
  // It must sit on the same 25G fibre a 25G NIC uses, and refuse copper.
  const t14 = new Topology();
  const omDev = t14.addDevice(om);
  const pc5 = t14.addDevice(find('generic-pc'));
  const noCopper = t14.validateLink(omDev.id, 'netA', pc5.id, 'eth0', {});
  ok(!noCopper.ok, 'OM4501: an RJ45 host cannot be patched into an optical split (' +
    ((noCopper.errors[0] || {}).code || 'no code') + ')');
  const t15 = new Topology();
  const a = t15.addDevice(om);
  const b = t15.addDevice(find('OM4501'));
  const fibre = t15.validateLink(a.id, 'netA', b.id, 'netB', {});
  ok(fibre.ok, 'OM4501: an LC port links to an LC port, so the tap can be placed inline');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
