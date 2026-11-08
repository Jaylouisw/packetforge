'use strict';
// A radio is an antenna, not an RJ45 socket (issue #77).
//
// derivePortHardware() fell back to copper whenever it did not recognise a connector, so
// every radio in the catalogue described itself as an RJ45 cage carrying
// 10base-t/100base-tx/1000base-t at up to a gigabit. Nothing was actually connectable -
// validateLink answered E_WIRELESS_TO_WIRED and that refusal was correct - but the *model*
// lied: the link inspector drew a Wi-Fi radio as a copper socket, anything enumerating
// "ports you can plug into" by cage offered a radio, and the sub-100 Mbps audit had to be
// rescoped to skip wireless interfaces by type because otherwise an honest 25 Mbit/s
// satellite WAN looked like a defect.
//
// What is locked here:
//   1. every spelling of a radio - type, connector or name - derives the antenna cage,
//      and an antenna cage carries radio bands only: no copper, no optic, ever;
//   2. a radio's rate ladder is its own declared rate, not an RJ45 10/100/1000 ladder;
//   3. none of that loosens a refusal: a radio still refuses a patch lead, with exactly
//      the code it refused with before, and still associates with another radio.
const path = require('path');
const media = require('../engine/media');
const { Topology } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function hw(spec, dev) { return media.derivePortHardware(spec, dev || {}); }

// Media ids that belong to a cable. A radio must never carry one of these.
const WIRED_IDS = Object.keys(media.MEDIA).filter(function (id) {
  return media.MEDIA[id].family !== 'wireless';
});

function onlyWireless(port) {
  return Array.isArray(port.media) && port.media.length > 0 &&
    port.media.every(function (id) { return media.MEDIA[id] && media.MEDIA[id].family === 'wireless'; });
}

console.log('Every way a spec can spell a radio derives the antenna cage:');
{
  const SPELLINGS = [
    // the type
    { name: 'wlan0', type: 'wireless', speed: '867M' },
    { name: 'radio0', type: 'radio', speed: '1G' },
    { name: 'wifi0', type: 'wifi', speed: '574M' },
    { name: 'wifi0', type: 'wi-fi', speed: '574M' },
    { name: 'wlan0', type: 'wlan', speed: '867M' },
    { name: 'wwan0', type: 'wwan', speed: '25M' },
    { name: 'lte0', type: 'cellular', speed: '150M' },
    { name: 'lte0', type: 'lte', speed: '150M' },
    { name: 'mmw0', type: '5g-nr', speed: '1200M' },
    // the connector, on a spec that calls itself ethernet
    { name: 'ant1', type: 'ethernet', speed: '1G', connector: 'antenna' },
    { name: 'ant1', type: 'ethernet', speed: '1G', connector: 'sma' },
    { name: 'ant1', type: 'ethernet', speed: '1G', connector: 'rp-sma' },
    { name: 'ant1', type: 'ethernet', speed: '1G', connector: 'n-type' },
    { name: 'ant1', type: 'ethernet', speed: '1G', connector: 'wireless' },
    { name: 'ant1', type: 'ethernet', speed: '1G', connector: 'radio' },
    { name: 'ant1', type: 'ethernet', speed: '1G', connector: 'wifi' },
    // nothing but the name
    { name: 'wlan0', speed: '300M' },
    { name: 'radio1', speed: '867M' },
    { name: 'wwan0', speed: '25M' }
  ];
  const wrong = [];
  for (const s of SPELLINGS) {
    const p = hw(s);
    const label = JSON.stringify(s);
    if (p.cage !== 'antenna') wrong.push(label + ' -> cage ' + p.cage);
    else if (p.family !== 'wireless') wrong.push(label + ' -> family ' + p.family);
  }
  ok(wrong.length === 0, SPELLINGS.length + ' radio spellings all resolve to the antenna cage' +
    (wrong.length ? ': ' + wrong.join('; ') : ''));
  const one = hw({ name: 'wlan0', type: 'wireless', speed: '867M' });
  ok(one.cageName === 'Antenna', 'and the cage is named Antenna (' + one.cageName + '), not RJ45');
  ok(media.CAGE_ALIAS && media.CAGE_ALIAS.sma === 'antenna' && media.CAGE_ALIAS['rp-sma'] === 'antenna',
    'the connector aliases file SMA and RP-SMA under the one radio cage');
  ok(media.CAGES.antenna && media.CAGES.antenna.family === 'wireless',
    'the antenna cage is a first-class cage with its own family');
}

console.log('\nAn antenna cage carries radio bands and nothing else:');
{
  const RATES = ['25M', '150M', '300M', '574M', '867M', '1G', '2.5G', '6G'];
  const dirty = [];
  for (const speed of RATES) {
    const p = hw({ name: 'wlan0', type: 'wireless', speed: speed });
    if (!onlyWireless(p)) dirty.push(speed + ' -> [' + p.media.join(',') + ']');
    const wired = (p.media || []).filter(function (id) { return WIRED_IDS.indexOf(id) !== -1; });
    if (wired.length) dirty.push(speed + ' carries ' + wired.join(','));
  }
  ok(dirty.length === 0, 'no copper or optical medium survives on a radio (' + RATES.length + ' rates)' +
    (dirty.length ? ': ' + dirty.join('; ') : ''));
  const p = hw({ name: 'wlan0', type: 'wireless', speed: '867M' });
  ok(p.media.indexOf('10base-t') === -1 && p.media.indexOf('100base-tx') === -1 &&
     p.media.indexOf('1000base-t') === -1, 'in particular it offers no 10/100/1000BASE-T rung');

  // The cage table itself must not describe a radio as a cable either: that table is what
  // anything enumerating a cage reads, and an id invented here would be a medium no other
  // code knows how to carry.
  const tableBad = [];
  for (const mbps of [25, 300, 867, 1000, 2400, 5760, 11500]) {
    const ids = media.CAGE_MEDIA.antenna(mbps);
    if (!ids.length) tableBad.push(mbps + ' offers nothing');
    for (const id of ids) {
      if (!media.MEDIA[id]) tableBad.push(mbps + ' invents ' + id);
      else if (media.MEDIA[id].family !== 'wireless') tableBad.push(mbps + ' offers ' + id);
    }
  }
  ok(tableBad.length === 0, 'CAGE_MEDIA.antenna offers only real wireless media ids' +
    (tableBad.length ? ': ' + tableBad.slice(0, 4).join('; ') : ''));
  ok(media.CAGE_MEDIA.antenna(867).indexOf('wireless-5') !== -1 &&
     media.CAGE_MEDIA.antenna(300).indexOf('wireless-5') === -1,
    'and it is rate-aware: 867 Mbps covers 5 GHz, 300 Mbps does not');

  // A spec cannot hand a radio a patch lead by overriding its media list.
  const forced = hw({ name: 'wlan0', type: 'wireless', speed: '1G', media: ['1000base-t', 'wireless-5'] });
  ok(forced.media.length === 1 && forced.media[0] === 'wireless-5',
    'a spec that lists 1000BASE-T on a radio gets the band and not the cable (' + forced.media.join(',') + ')');
  const forced2 = hw({ name: 'ant1', type: 'ethernet', speed: '1G', cage: 'antenna', media: ['10base-t'] });
  ok(forced2.cage === 'antenna' && forced2.media.length === 0,
    'and a radio left with only wired media is left with none, not with copper');

  // The band set still follows the generation, which is what a radio actually carries.
  const bands = function (speed) { return hw({ name: 'wlan0', type: 'wireless', speed: speed }).media.join(','); };
  ok(bands('300M') === 'wireless-2.4', 'a 300 Mbps radio is 2.4 GHz only (' + bands('300M') + ')');
  ok(bands('867M') === 'wireless-2.4,wireless-5', 'an 867 Mbps radio is dual-band (' + bands('867M') + ')');
  ok(bands('2400M') === 'wireless-2.4,wireless-5,wireless-6', 'a 2.4 Gbps radio adds 6 GHz (' + bands('2400M') + ')');
  ok(bands('5760M').split(',').length === 4, 'a Wi-Fi 7 radio carries all four bands (' + bands('5760M') + ')');
  const explicit = hw({ name: 'wlan0', type: 'wireless', speed: '867M', bands: ['5', '6'] });
  ok(explicit.media.join(',') === 'wireless-5,wireless-6', 'an explicit band list still wins (' + explicit.media.join(',') + ')');
  const wigig = hw({ name: 'wlan0', type: 'wireless', speed: '5000M' }, { model: 'WiGig bridge 802.11ad' });
  ok(wigig.media.join(',') === 'wireless-60', '60 GHz gear is 60 GHz, not a fast 5 GHz (' + wigig.media.join(',') + ')');
}

console.log('\nA radio runs at the rate it declares, and at no other:');
{
  const CASES = [
    ['25M', 25], ['150M', 150], ['300M', 300], ['574M', 574],
    ['867M', 867], ['1G', 1000], ['2.5G', 2500], ['6G', 6000]
  ];
  const wrong = [];
  for (const [speed, mbps] of CASES) {
    const p = hw({ name: 'wlan0', type: 'wireless', speed: speed });
    if (p.maxSpeedMbps !== mbps) wrong.push(speed + ' -> max ' + p.maxSpeedMbps);
    if (JSON.stringify(p.speedCaps) !== JSON.stringify([mbps])) wrong.push(speed + ' -> caps ' + JSON.stringify(p.speedCaps));
  }
  ok(wrong.length === 0, 'the ladder is the interface\'s own rate for all ' + CASES.length + ' rates' +
    (wrong.length ? ': ' + wrong.join('; ') : ''));

  const slow = hw({ name: 'wwan0', type: 'wireless', speed: '25M' });
  ok(slow.speedCaps.join(',') === '25', 'a 25 Mbit/s satellite WAN advertises 25, not 10/100/1000 (' +
    slow.speedCaps.join(',') + ')');
  ok(slow.speedCaps.indexOf(100) === -1 && slow.speedCaps.indexOf(1000) === -1,
    'it does not inherit the copper rungs it cannot run');

  const declared = hw({ name: 'wlan0', type: 'wireless', speed: '300M', speedCaps: [300, 867] });
  ok(declared.speedCaps.join(',') === '300,867',
    'a spec that declares its own rate ladder keeps it (' + declared.speedCaps.join(',') + ')');
  const hwCaps = hw({ name: 'wlan0', type: 'wireless', speed: '1G', hardware: { speedCaps: [1000, 2500] } });
  ok(hwCaps.speedCaps.join(',') === '1000,2500', 'and a hardware block override is honoured too (' +
    hwCaps.speedCaps.join(',') + ')');

  ok(JSON.stringify(media.CAGE_SPEEDS.antenna(867)) === JSON.stringify([867]),
    'CAGE_SPEEDS.antenna is the radio\'s own rung, not a copper ladder');

  // The device from the issue, port for port.
  const ht2000w = {
    vendor: 'hughesnet', model: 'HT2000W', category: 'router',
    interfaces: [
      { name: 'lan1', type: 'ethernet', speed: '1G' },
      { name: 'wlan0', type: 'wireless', speed: '300M', connector: 'antenna' },
      { name: 'wlan1', type: 'wireless', speed: '867M', connector: 'antenna' },
      { name: 'wwan0', type: 'wireless', speed: '25M', connector: 'antenna' }
    ]
  };
  const t = new Topology();
  const dev = t.addDevice(ht2000w);
  const wlan0 = dev.interfaces.get('wlan0'), wlan1 = dev.interfaces.get('wlan1'), wwan0 = dev.interfaces.get('wwan0');
  ok([wlan0, wlan1, wwan0].every(function (i) { return i.hardware.cage === 'antenna' && onlyWireless(i.hardware); }),
    'HT2000W wlan0/wlan1/wwan0 are antenna cages carrying radio bands only');
  ok(wwan0.hardware.maxSpeedMbps === 25 && wwan0.hardware.speedCaps.join(',') === '25',
    'and the 25 Mbit/s satellite leg says 25 Mbps instead of a gigabit');
  ok(dev.interfaces.get('lan1').hardware.cage === 'rj45' &&
     dev.interfaces.get('lan1').hardware.media.indexOf('1000base-t') !== -1,
    'while its four LAN sockets stay RJ45 copper with 1000BASE-T');
}

console.log('\nA wired port is untouched by all of this:');
{
  const gi = hw({ name: 'gi1/0/1', type: 'ethernet', speed: '1G' });
  ok(gi.cage === 'rj45' && gi.family === 'copper', 'an ethernet port is still an RJ45 cage');
  ok(gi.media.indexOf('1000base-t') !== -1 && gi.speedCaps.join(',') === '10,100,1000',
    'with the copper media and the 10/100/1000 ladder it really has');
  const ten = hw({ name: 'te1/1/1', type: 'ethernet', speed: '10G', cage: 'sfp+' });
  ok(ten.cage === 'sfp+' && ten.media.indexOf('10gbase-lr') !== -1, 'an SFP+ port is still optical');
  // A name that merely CONTAINS a radio word is not a radio: the rule is anchored.
  const wired = hw({ name: 'swlan-uplink', type: 'ethernet', speed: '1G' });
  ok(wired.cage !== 'antenna', 'a wired port whose name merely contains "wlan" stays wired (' + wired.cage + ')');
}

console.log('\nA radio still refuses a patch lead, with the same code as before:');
{
  // The refusal is the one thing that must not move: a radio has no socket to plug a
  // copper or optical lead into, and the code the caller sees is E_WIRELESS_TO_WIRED.
  const radioSpec = {
    vendor: 'test', model: 'Radio', category: 'wireless',
    interfaces: [{ name: 'wlan0', type: 'wireless', speed: '867M', connector: 'antenna' }]
  };
  const wiredSpec = {
    vendor: 'test', model: 'Switch', category: 'switch',
    interfaces: [
      { name: 'gi1', type: 'ethernet', speed: '1G' },
      { name: 'te1', type: 'ethernet', speed: '10G', cage: 'sfp+' }
    ]
  };
  const t = new Topology();
  const r = t.addDevice(radioSpec);
  const w = t.addDevice(wiredSpec);

  for (const [port, label] of [['gi1', 'RJ45 copper'], ['te1', 'SFP+ optical']]) {
    const v = t.validateLink(r.id, 'wlan0', w.id, port, {});
    const codes = (v.errors || []).map(function (e) { return e.code; });
    ok(v.ok === false && codes.indexOf('E_WIRELESS_TO_WIRED') !== -1,
      'radio -> ' + label + ' is refused with E_WIRELESS_TO_WIRED (' + codes.join(',') + ')');
    let threw = null;
    try { t.connect(r.id, 'wlan0', w.id, port); } catch (e) { threw = e; }
    ok(threw && threw.code === 'E_WIRELESS_TO_WIRED',
      'and the cable cannot be drawn: connect() throws E_WIRELESS_TO_WIRED');
  }

  // The same verdict from canMate, without a topology in the way.
  const radioHw = r.interfaces.get('wlan0').hardware;
  for (const port of ['gi1', 'te1']) {
    const v = media.canMate(radioHw, w.interfaces.get(port).hardware);
    ok(v.ok === false && v.code === 'E_WIRELESS_TO_WIRED',
      'canMate(antenna, ' + w.interfaces.get(port).hardware.cage + ') = E_WIRELESS_TO_WIRED');
  }
  ok(media.cagesMate('antenna', 'rj45') === false && media.cagesMate('antenna', 'sfp+') === false &&
     media.cagesMate('antenna', 'combo') === false,
    'and no wired cage claims to mate with an antenna');
  ok(JSON.stringify(media.CAGE_MATE.antenna) === JSON.stringify(['antenna']),
    'an antenna mates with an antenna and nothing else');

  // A radio association is not a cable, and it must keep working - the fix narrows what a
  // radio *is*, it must not take wireless links away.
  const phone = t.addDevice({ vendor: 'test', model: 'Phone', category: 'host',
    interfaces: [{ name: 'wlan0', type: 'wireless', speed: '2400M' }] });
  const ap = t.addDevice({ vendor: 'test', model: 'AP', category: 'wireless',
    interfaces: [{ name: 'radio0', type: 'wireless', speed: '574M' }] });
  const assoc = t.validateLink(phone.id, 'wlan0', ap.id, 'radio0', {});
  ok(assoc.ok && assoc.mediaId === 'wireless-2.4',
    'two radios still associate (' + (assoc.mediaId || '') + ' at ' + (assoc.speedMbps || '') + ' Mbps)');
}

console.log('\nThe catalogue agrees:');
{
  const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
  const radios = [];
  const notRadios = [];
  const dirty = [];
  const rateWrong = [];
  for (const spec of catalog) {
    const d = new Topology().addDevice(spec);
    for (const i of d.interfaces.values()) {
      const h = i.hardware;
      if (h.cage === 'antenna') {
        radios.push(spec.vendor + '/' + spec.model + '/' + i.name);
        if (!onlyWireless(h)) dirty.push(spec.vendor + '/' + spec.model + '/' + i.name + ' [' + h.media.join(',') + ']');
        // "Every radio declares the rate it runs at": one honest number, echoed by the
        // ladder, instead of a copper default the radio could never reach.
        const caps = h.speedCaps || [];
        if (!caps.length || !(h.maxSpeedMbps > 0) ||
            caps.some(function (c) { return c !== h.maxSpeedMbps; })) {
          rateWrong.push(spec.vendor + '/' + spec.model + '/' + i.name + ' caps ' +
            JSON.stringify(caps) + ' max ' + h.maxSpeedMbps);
        }
      } else if (/^(wireless|radio|wifi|wi-fi|wlan|wwan|cellular|lte|nr5g|5g-nr)$/.test(String(i.type || '').toLowerCase())) {
        notRadios.push(spec.vendor + '/' + spec.model + '/' + i.name + ' (type ' + i.type + ' -> ' + h.cage + ')');
      }
    }
  }
  ok(notRadios.length === 0, 'no wireless interface in ' + catalog.length + ' devices resolves to a wired cage' +
    (notRadios.length ? ': ' + notRadios.slice(0, 4).join('; ') : ''));
  ok(radios.length > 400, 'the check covers the catalogue\'s radios (' + radios.length + ' antenna ports)');
  ok(dirty.length === 0, 'every one of them carries radio bands only' +
    (dirty.length ? ': ' + dirty.slice(0, 3).join('; ') : ''));
  ok(rateWrong.length === 0, 'and every one of them declares the rate it runs at' +
    (rateWrong.length ? ': ' + rateWrong.slice(0, 3).join('; ') : ''));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
