'use strict';
// Wireless links (issue #28).
//
// Two radios could not be connected at all:
//
//   iPhone 16/wlan0 <-> AP-515/radio0: No shared medium between Antenna and Antenna.
//
// The cages mated; the media did not. `derivePortHardware` assigned each radio exactly ONE
// band from its declared rate - a dual-band phone became ["wireless-5"] only, a 2.4 GHz AP
// radio became ["wireless-2.4"] only - so an AP and a phone shared nothing. Every phone,
// laptop, tablet, camera and IoT sensor in the catalogue was unconnectable: wireless is the
// most common link type there is, and it did not exist.
//
// Two further faults were hiding behind it:
//   - `maxMbps >= 5000 -> wireless-60` modelled a Wi-Fi 7 phone as millimetre-wave 802.11ad
//   - rate negotiation demanded an EXACT common line rate, which is how wired ports work and
//     how radios do not: a client associates at the best rate the AP, client and band allow
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { loadCatalog } = require('../devices/registry');
const media = require('../engine/media');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const apSpec = catalog.find(function (s) { return s.model === 'AP-515'; });
const phoneSpec = catalog.find(function (s) { return s.model === 'iPhone 16'; });

function rf(rate, bands) {
  const i = { name: 'radio0', type: 'wireless', speed: rate };
  if (bands) i.bands = bands;
  return i;
}
function apWith(ifaces) {
  return {
    vendor: 'probe', model: 'probe-ap', label: 'Probe AP', category: 'wireless',
    capabilities: ['l2-forward', 'wireless'], interfaces: ifaces
  };
}

console.log('A radio carries the bands of its generation:');
{
  const t = new Topology();
  const ph = t.addDevice(phoneSpec);
  const w0 = ph.interfaces.get('wlan0');
  ok(w0.hardware.cage === 'antenna', 'a phone radio is an antenna cage');
  ok(w0.hardware.media.length > 1, 'a Wi-Fi 7 radio carries more than one band (' + w0.hardware.media.join(', ') + ')');
  ok(w0.hardware.media.indexOf('wireless-6') !== -1, 'and 6 GHz is among them');
  ok(w0.hardware.media.indexOf('wireless-60') === -1, 'a Wi-Fi 7 phone is not modelled as 60 GHz mmWave');
}

console.log('\nAn AP and a phone associate, which they never could before:');
{
  const t = new Topology();
  const ap = t.addDevice(apSpec), ph = t.addDevice(phoneSpec);
  const v = t.validateLink(ph.id, 'wlan0', ap.id, 'radio0');
  ok(v.ok, 'the association is allowed' + (v.ok ? '' : ': ' + (v.errors[0] || {}).message));
  ok(v.mediaId === 'wireless-2.4', 'it lands on the AP 2.4 GHz radio (' + v.mediaId + ')');
  ok(v.speedMbps > 0 && v.speedMbps <= 600, 'at the rate that band can carry (' + v.speedMbps + ' Mbps)');

  const L = t.connect(ph.id, 'wlan0', ap.id, 'radio0');
  ok(!!L, 'connect() forms the link');
}

console.log('\nThe fastest shared band wins, not the slowest:');
{
  const t = new Topology();
  const ap = t.addDevice(apSpec), ph = t.addDevice(phoneSpec);
  const v = t.validateLink(ph.id, 'wlan0', ap.id, 'radio1');
  ok(v.ok, 'the 5/6 GHz radio also associates');
  ok(v.speedMbps > 600, 'and negotiates well above 2.4 GHz (' + v.speedMbps + ' Mbps on ' + v.mediaId + ')');
}

console.log('\nA client downshifts to the AP rather than refusing:');
{
  // Wi-Fi 5 AP radio against a Wi-Fi 7 phone: no common generation, but a real client
  // associates at the AP's rate instead of refusing to join.
  const t = new Topology();
  const ap = t.addDevice(apWith([{ name: 'eth0', type: 'ethernet', speed: '1G' }, rf('1G')]));
  const ph = t.addDevice(phoneSpec);
  const v = t.validateLink(ph.id, 'wlan0', ap.id, 'radio0');
  ok(v.ok, 'a Wi-Fi 7 phone joins a Wi-Fi 5 radio');
  ok(v.speedMbps === 1000, 'at the AP\'s 1G rate (' + v.speedMbps + ' Mbps)');
  ok(v.mediaId === 'wireless-5', 'on the 5 GHz band (' + v.mediaId + ')');
}

console.log('\nBands that genuinely do not overlap are still refused:');
{
  const t = new Topology();
  // A 60 GHz bridge and a Wi-Fi 7 phone both say "5G" but share no band at all.
  const wigig = t.addDevice(apWith([{ name: 'eth0', type: 'ethernet', speed: '1G' }, rf('5G', ['60'])]));
  const ph = t.addDevice(phoneSpec);
  const v = t.validateLink(ph.id, 'wlan0', wigig.id, 'radio0');
  ok(!v.ok, 'a 60 GHz radio cannot associate with a Wi-Fi 7 client');
  ok((v.errors[0] || {}).code === 'E_NO_COMMON_MEDIA', 'and says why (' + (v.errors[0] || {}).code + ')');

  // ...but two 60 GHz radios still form their link.
  const t2 = new Topology();
  const a = t2.addDevice(apWith([rf('5G', ['60'])]));
  const b = t2.addDevice(apWith([rf('5G', ['60'])]));
  const v2 = t2.validateLink(a.id, 'radio0', b.id, 'radio0');
  ok(v2.ok && v2.mediaId === 'wireless-60', 'two 60 GHz radios do link (' + v2.mediaId + ')');
}

console.log('\nA spec can state its bands explicitly:');
{
  const t = new Topology();
  const five = t.addDevice(apWith([rf('2.5G', ['5'])]));
  const port = five.interfaces.get('radio0');
  ok(port.hardware.media.length === 1 && port.hardware.media[0] === 'wireless-5',
    'bands:["5"] gives exactly one band (' + port.hardware.media.join(',') + ')');
}

console.log('\nA packet actually crosses the radio link:');
{
  const pc = {
    vendor: 'generic', model: 'generic-pc', label: 'PC', category: 'host',
    capabilities: ['host', 'cli'],
    interfaces: [{ name: 'eth0', type: 'ethernet', speed: '1G' }]
  };
  const t = new Topology();
  const ap = t.addDevice(apSpec), ph = t.addDevice(phoneSpec), host = t.addDevice(pc);
  ap.name = 'AP1'; ph.name = 'PHONE'; host.name = 'PC1';
  ph.interfaces.get('wlan0').ip = '10.20.0.10';
  ph.interfaces.get('wlan0').mask = '255.255.255.0';
  host.interfaces.get('eth0').ip = '10.20.0.20';
  host.interfaces.get('eth0').mask = '255.255.255.0';
  t.connect(ph.id, 'wlan0', ap.id, 'radio0');
  t.connect(ap.id, 'eth0', host.id, 'eth0');

  const sim = new Simulator(t);
  const r = sim.ping(ph.id, '10.20.0.20', { count: 2 });
  ok(r.success, 'a phone pings a wired host through the AP');
  ok(r.replies.length === 2, 'both replies arrive (' + r.replies.length + ')');
  ok(r.events.some(function (e) { return e.type === 'arp-request'; }), 'ARP went out over the radio');
  ok(r.events.some(function (e) { return e.type === 'arp-reply'; }), 'and the reply came back');
  ok(r.events.some(function (e) { return e.type === 'icmp-received'; }), 'the echo reached the host');
}

console.log('\nEvery wireless device in the catalogue can associate with its own kind:');
{
  // Pair each radio with a peer of the same band, not with a Wi-Fi AP: a 60 GHz backhaul
  // radio refusing to join a 2.4 GHz access point is correct behaviour, not a defect.
  const BANDS = { 'wireless-2.4': '2.4', 'wireless-5': '5', 'wireless-6': '6', 'wireless-7': '6', 'wireless-60': '60' };
  let checked = 0, orphaned = [];
  for (const spec of catalog) {
    let dev;
    try { dev = new Topology().addDevice(spec); } catch (e) { continue; }
    const radios = [...dev.interfaces.values()].filter(function (i) { return i.hardware.cage === 'antenna'; });
    if (!radios.length) continue;
    checked++;
    const r = radios[0];
    const bands = r.hardware.media.map(function (id) { return BANDS[id]; }).filter(Boolean);
    const peerSpec = apWith([{ name: 'eth0', type: 'ethernet', speed: '1G' }, rf(r.hardware.maxSpeedMbps >= 1000 ? '5G' : '600M', bands)]);
    const t2 = new Topology();
    const a = t2.addDevice(spec), b = t2.addDevice(peerSpec);
    if (a.interfaces.get(r.name)) {
      const v = t2.validateLink(a.id, r.name, b.id, 'radio0');
      if (!v.ok) orphaned.push(spec.model + '/' + r.name + ' (' + (v.errors[0] || {}).code + ')');
    }
  }
  ok(checked > 100, 'the catalogue has a large wireless population (' + checked + ' devices with radios)');
  ok(orphaned.length === 0, 'none of them is unable to associate' +
    (orphaned.length ? ' (' + orphaned.slice(0, 3).join(', ') + ')' : ''));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
