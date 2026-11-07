'use strict';
// A topology that has been saved and reloaded must be safe to keep editing.
//
// Issue #13: serialize() did not carry the id sequence, so fromJSON() started a fresh
// Topology at d1 and the next addDevice() was handed an id that was already in use.
// The Map.set() overwrote the existing device without a word - silent data loss in
// the documented import/export workflow.
//
// Two separate defects, and both are tested here: the sequence was not restored, and
// a colliding id was accepted silently instead of being refused.
const path = require('path');
const { Topology } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(v, m) {
  const s = catalog.find(function (x) { return x.vendor === v && x.model === m; });
  if (!s) throw new Error('missing spec ' + v + '/' + m);
  return s;
}
function roundTrip(t) {
  return Topology.fromJSON(JSON.parse(JSON.stringify(t.serialize())));
}

console.log('The issue\'s reproduction, exactly:');
{
  const t = new Topology();
  t.addDevice(spec('adtran', 'SDX611'));
  t.addDevice(spec('adtran', 'SDX 6320'));
  const t2 = roundTrip(t);
  const before = [...t2.devices.keys()];
  const cloud = t2.addDevice(spec('generic', 'generic-cloud'));

  ok(before.length === 2, 'two devices survive the round trip');
  ok(before.indexOf(cloud.id) === -1, 'the new device is given a free id (' + cloud.id + ')');
  ok(t2.devices.size === 3, 'and the topology now holds three devices, not two');
  const models = [...t2.devices.values()].map(function (d) { return d.model; });
  ok(models.indexOf('SDX611') !== -1, 'the first device was NOT overwritten');
  ok(models.indexOf('SDX 6320') !== -1, 'the second is still there too');
  ok(models.indexOf('generic-cloud') !== -1, 'and the new one was added alongside them');
}

console.log('\nLink ids are safe after a reload as well:');
{
  const t = new Topology();
  const a = t.addDevice(spec('generic', 'generic-pc'));
  const b = t.addDevice(spec('generic', 'generic-switch'));
  const bPort = [...b.interfaces.keys()][0];
  const first = t.connect(a.id, 'eth0', b.id, bPort);

  const t2 = roundTrip(t);
  ok(t2.links.size === 1, 'the cabled link survives the round trip');
  const pc2 = t2.addDevice(spec('generic', 'generic-pc'));
  const sw = [...t2.devices.values()].find(function (d) { return d.model === 'generic-switch'; });
  const free = [...sw.interfaces.keys()].find(function (n) { return !sw.interfaces.get(n).peer; });
  const second = t2.connect(pc2.id, 'eth0', sw.id, free);

  ok(first.id !== second.id, 'a link added after reload does not reuse the earlier id (' +
    first.id + ' vs ' + second.id + ')');
  ok(t2.links.size === 2, 'both links exist');
}

console.log('\nA file written before this fix is still safe to load:');
{
  // Files saved before #13 have no seq field at all. The high-water mark is derived
  // from the ids actually present, so an old lab cannot silently lose a device.
  const t = new Topology();
  t.addDevice(spec('generic', 'generic-pc'));
  t.addDevice(spec('generic', 'generic-switch'));
  t.addDevice(spec('generic', 'generic-pc'));
  const raw = JSON.parse(JSON.stringify(t.serialize()));
  delete raw.seq;
  const t2 = Topology.fromJSON(raw);
  ok(t2.devices.size === 3, 'the legacy file loads all three devices');
  const fresh = t2.addDevice(spec('generic', 'generic-cloud'));
  ok([...t2.devices.keys()].indexOf(fresh.id) !== -1, 'the new device has an id');
  ok(t2.devices.size === 4, 'all four devices are present (none overwritten)');
  const ids = [...t2.devices.keys()];
  ok(new Set(ids).size === ids.length, 'and every id is unique');
}

console.log('\nA colliding id is refused instead of silently replacing:');
{
  const t = new Topology();
  const d = t.addDevice(spec('generic', 'generic-pc'));
  let threw = null;
  try { t.addDevice(spec('generic', 'generic-cloud'), d.id); } catch (e) { threw = e; }
  ok(!!threw, 'adding a device under a taken id throws');
  ok(/already in use/.test(String(threw && threw.message)), 'and the message says so');
  ok(t.devices.get(d.id).model === 'generic-pc', 'the original device is untouched');
  ok(t.devices.size === 1, 'and nothing was added behind your back');
}

console.log('\nMAC addresses stay unique across a reload:');
{
  const t = new Topology();
  t.addDevice(spec('generic', 'generic-pc'));
  t.addDevice(spec('generic', 'generic-pc'));
  const t2 = roundTrip(t);
  const macs = [];
  for (const d of t2.devices.values()) {
    for (const i of d.interfaces.values()) if (i.mac) macs.push(i.mac);
  }
  ok(macs.length > 0, 'interfaces have MACs assigned');
  ok(new Set(macs).size === macs.length, 'and no two share one after a round trip');
}

console.log('\nThe sequence continues from the highest id, not from wherever it drifted:');
{
  // Restoring the sequence before the link loop made it count the links twice, so it
  // drifted ahead of the highest id. Ids stayed unique, so nothing failed - but the
  // counter stopped meaning anything, and that is the sort of quiet wrongness that
  // turns into a bug later.
  const fs = require('fs');
  const lab = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'lab1-two-pcs-switch.json'), 'utf8'));
  const t = Topology.fromJSON(lab);
  const nums = [...t.devices.keys(), ...t.links.keys()]
    .map(function (id) { return Number(String(id).slice(1)); })
    .filter(function (n) { return !isNaN(n); });
  const max = Math.max.apply(null, nums);
  ok(t._seq === max + 1, '_seq is exactly one past the highest id (' + t._seq + ' vs ' + (max + 1) + ')');
  const fresh = t.addDevice(spec('generic', 'generic-cloud'));
  ok(fresh.id === 'd' + (max + 1), 'so the next device takes the next id (' + fresh.id + ')');

  // Before this fix, restoring a topology created the links again with fresh ids, so
  // l4/l5 became l1/l2 on every save/load cycle. A cable id you cannot quote is not
  // an id.
  const again = Topology.fromJSON(JSON.parse(JSON.stringify(t.serialize())));
  ok([...again.links.keys()].join(',') === [...t.links.keys()].join(','),
    'cable ids survive a further round trip (' + [...again.links.keys()].join(',') + ')');
  ok([...again.devices.keys()].join(',') === [...t.devices.keys()].join(','),
    'and so do device ids');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
