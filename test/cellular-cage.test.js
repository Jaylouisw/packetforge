'use strict';

// A cellular radio is not copper, and it is not Wi-Fi either (issue #129).
//
// Before this, the catalogue had no cage for a 3GPP air interface, so 88 cellular uplinks
// had to pretend to be something they are not:
//
//   {type:'ethernet', speed:'2.5G'}  invented an RJ45 socket that validateLink would cable
//   {type:'wireless', speed:'150M'}  joined the Wi-Fi population and could be offered as an AP
//
// The second is what most of the catalogue does, and it is why `antenna` was doing two jobs.
// Now a modem presents a `wwan` cage: same wireless family (no power, no cable), different
// cage, so "this box has a 5G radio" and "this box has a Wi-Fi radio" stop being the same
// fact. The interesting cases are the ones where a radio and a socket would behave the same
// and only the description differs, so most of this file is about refusing things.

const path = require('path');
const { Topology } = require('../engine');
const { loadCatalog } = require('../devices/registry');
const media = require('../engine/media');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const catalogue = loadCatalog(path.join(__dirname, '..', 'devices'));
const all = [];
for (const spec of catalogue) {
  let dev;
  try { dev = new Topology().addDevice(spec); } catch (e) { continue; }
  const ifaces = dev.interfaces instanceof Map ? [...dev.interfaces.values()] : [];
  all.push({ spec, ifaces });
}

const hw = (iface, dev) => media.derivePortHardware(iface, dev || { model: 'x', category: 'modem' });

console.log('The cage exists and is a radio:');
{
  ok(!!media.CAGES.wwan, 'wwan is a first-class cage');
  ok(media.CAGES.wwan.family === 'wireless', 'in the wireless family, so it carries no power');
  ok(media.CAGES.wwan.label.toLowerCase().includes('cellular'), 'and says what it is: ' + media.CAGES.wwan.label);
}

console.log('\nThe spellings that mean "modem" resolve to it:');
{
  const SPELLINGS = [
    { name: 'wwan0', type: 'wireless', speed: '150M' },
    { name: 'wwan1', type: 'ethernet', speed: '2.5G' },
    { name: 'wan5g', type: 'ethernet', speed: '2.5G' },
    { name: 'lte0', type: 'cellular', speed: '150M' },
    { name: 'modem0', type: 'wireless', speed: '100M' },
    { name: 'nr5g', type: 'wireless', speed: '2.5G' }
  ];
  const wrong = [];
  for (const s of SPELLINGS) {
    const p = hw(s);
    if (p.cage !== 'wwan') wrong.push(JSON.stringify(s) + ' -> ' + p.cage);
  }
  ok(wrong.length === 0, SPELLINGS.length + ' modem spellings resolve to the cellular cage' +
    (wrong.length ? ': ' + wrong.join('; ') : ''));

  // And a Wi-Fi radio must not be dragged along with them.
  const wifi = ['wlan0', 'wifi0', 'radio1'];
  const wrongWifi = wifi.filter((n) => hw({ name: n, type: 'wireless', speed: '867M' }).cage !== 'antenna');
  ok(wrongWifi.length === 0, 'Wi-Fi spellings still resolve to the antenna' +
    (wrongWifi.length ? ': ' + wrongWifi.join(', ') : ''));
}

console.log('\nThe medium names the generation, and the rate is the modem\'s own:');
{
  const cat4 = hw({ name: 'wwan0', type: 'wireless', speed: '150M' });
  ok(cat4.media.indexOf('lte') !== -1, 'a 150 Mbps modem offers LTE: ' + JSON.stringify(cat4.media));
  ok(cat4.media.indexOf('5g-sub6') === -1, 'and does not claim 5G it cannot do');

  const fiveG = hw({ name: 'wwan0', type: 'wireless', speed: '2.5G' });
  ok(fiveG.media.indexOf('5g-sub6') !== -1, 'a 2.5 Gbps modem offers 5G sub-6: ' + JSON.stringify(fiveG.media));

  // A slow modem must still have a medium. Two in the catalogue are declared at 100 Mbps,
  // and filtering media by the port's rate left them with an empty list - a port that cannot
  // form any link at all, which is worse than a slow one.
  const slow = hw({ name: 'wwan0', type: 'wireless', speed: '100M' });
  ok(Array.isArray(slow.media) && slow.media.length > 0,
    'a 100 Mbps modem still has a medium: ' + JSON.stringify(slow.media));

  // The ladder is the modem's own rate, not copper's. Falling back to rj45 speeds made every
  // modem "claim a line rate its cage cannot carry".
  ok(JSON.stringify(cat4.speedCaps) === '[150]', 'the rate ladder is the modem rate: ' + JSON.stringify(cat4.speedCaps));
}

console.log('\nNothing cables to it:');
{
  const t = new Topology();
  const modem = t.addDevice({ vendor: 't', model: 'm', category: 'modem',
    interfaces: [{ name: 'wwan0', type: 'wireless', speed: '2.5G' }] });
  const sw = t.addDevice({ vendor: 't', model: 's', category: 'switch',
    interfaces: [{ name: 'p1', type: 'ethernet', speed: '1G' }, { name: 'sfp1', type: 'ethernet', speed: '10G', connector: 'sfp+' }] });
  const other = t.addDevice({ vendor: 't', model: 'm2', category: 'modem',
    interfaces: [{ name: 'wwan0', type: 'wireless', speed: '2.5G' }] });

  const toCopper = t.validateLink(modem.id, 'wwan0', sw.id, 'p1', {});
  ok(toCopper.ok === false, 'a modem refuses copper (' + ((toCopper.errors || [])[0] || {}).code + ')');

  const toFibre = t.validateLink(modem.id, 'wwan0', sw.id, 'sfp1', {});
  ok(toFibre.ok === false, 'a modem refuses a fibre cage (' + ((toFibre.errors || [])[0] || {}).code + ')');

  // Two modems in a lab are not cabled to each other: they are both subscribed to a network
  // neither of them contains. This is the case a naive "same cage mates" rule gets wrong.
  const toModem = t.validateLink(modem.id, 'wwan0', other.id, 'wwan0', {});
  ok(toModem.ok === false, 'and it refuses another modem (' + ((toModem.errors || [])[0] || {}).code + ')');
}

console.log('\nThe whole catalogue agrees:');
{
  const cellular = [];
  const wifi = [];
  for (const x of all) {
    for (const p of x.ifaces) {
      if (p.hardware.cage === 'wwan') cellular.push({ spec: x.spec, port: p });
      if (p.hardware.cage === 'antenna') wifi.push({ spec: x.spec, port: p });
    }
  }
  ok(cellular.length > 0, cellular.length + ' ports across the catalogue are cellular');
  ok(wifi.length > 0, wifi.length + ' are Wi-Fi radios, which stayed on the antenna cage');

  const noMedia = cellular.filter((c) => !(c.port.hardware.media || []).length);
  ok(noMedia.length === 0, 'every cellular port has a medium' +
    (noMedia.length ? ' (' + noMedia.slice(0, 3).map((c) => c.spec.model).join(', ') + ')' : ''));

  const withCopper = cellular.filter((c) => /base-t/.test((c.port.hardware.media || []).join(',')));
  ok(withCopper.length === 0, 'no cellular port offers a copper medium' +
    (withCopper.length ? ' (' + withCopper.slice(0, 3).map((c) => c.spec.model).join(', ') + ')' : ''));

  // A modem must never be able to source power - it is in the wireless family, and the PoE
  // inference gates on the cage before it ever looks at the device (issue #105).
  const powered = cellular.filter((c) => c.port.hardware.poeOut !== null && c.port.hardware.poeOut !== undefined);
  ok(powered.length === 0, 'no cellular port sources power' +
    (powered.length ? ' (' + powered.slice(0, 3).map((c) => c.spec.model).join(', ') + ')' : ''));
}

console.log('');
if (failed) { console.log(failed + ' failed, ' + passed + ' passed'); process.exit(1); }
console.log(passed + ' passed, 0 failed');
