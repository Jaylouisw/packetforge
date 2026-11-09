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
const fs = require('fs');
const { Topology } = require('../engine');
const { loadCatalog, effectiveInterfaces } = require('../devices/registry');

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

console.log('\nSave, load, save is byte-identical - including when a caller supplies ids:');
{
  // The counter is normally one past the highest id, because ids come from `'d' + _seq++`. That
  // stops being true the moment a caller passes its own id: a topology built as `d0` and `d2` kept
  // `_seq = 1`, so serialize() wrote `seq: 1` beside a `d2`, and loading that document pushed the
  // counter to 3. Save, load and save again then produced a *different* file - one integer of churn
  // per open/save cycle in a lab file that exists to be diffed in git.
  const sw = spec('mikrotik', 'CRS326-24G');
  const pc = spec('generic', 'generic-pc');

  const explicit = new Topology();
  explicit.addDevice(sw, 'd0');
  explicit.addDevice(pc, 'd2');
  explicit.connect('d0', 'ether1', 'd2', 'eth0', { mediaId: '1000base-t' });
  const doc = explicit.serialize();
  ok(doc.seq > 2, 'an explicit id moves the counter past itself (' + doc.seq + ')');
  const reloaded = JSON.stringify(Topology.fromJSON(JSON.parse(JSON.stringify(doc))).serialize());
  ok(reloaded === JSON.stringify(doc), 'so save -> load -> save is byte-identical');

  const explicitLink = new Topology();
  explicitLink.addDevice(sw, 'd1');
  explicitLink.addDevice(pc, 'd2');
  explicitLink.connect('d1', 'ether1', 'd2', 'eth0', { id: 'l40', mediaId: '1000base-t' });
  ok(explicitLink.serialize().seq > 40, 'an explicit cable id does the same (' + explicitLink.serialize().seq + ')');
  ok(JSON.stringify(Topology.fromJSON(JSON.parse(JSON.stringify(explicitLink.serialize()))).serialize()) ===
     JSON.stringify(explicitLink.serialize()), 'and that document round-trips too');

  // The same property over the shipped labs and over seeded random topologies, half of which use
  // explicit ids - because the bug only appeared in the explicit case, and a test that only builds
  // topologies the easy way would have missed it.
  const catalogAll = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
  function mulberry32(a) {
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const failures = [];
  const exampleDir = path.join(__dirname, '..', 'examples');
  for (const f of fs.readdirSync(exampleDir).filter(function (n) { return n.endsWith('.json'); })) {
    const lab = JSON.parse(fs.readFileSync(path.join(exampleDir, f), 'utf8'));
    const once = JSON.stringify(Topology.fromJSON(lab).serialize());
    const twice = JSON.stringify(Topology.fromJSON(JSON.parse(once)).serialize());
    if (once !== twice) failures.push(f);
  }
  const rand = mulberry32(20261109);
  let built = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const t = new Topology();
    const n = 1 + Math.floor(rand() * 4);
    for (let i = 0; i < n; i++) {
      const s = catalogAll[Math.floor(rand() * catalogAll.length)];
      if (rand() < 0.5) {
        const id = 'd' + Math.floor(rand() * 30);
        if (t.devices.has(id)) continue;
        t.addDevice(s, id);
      } else {
        t.addDevice(s);
      }
    }
    if (!t.devices.size) continue;
    built++;
    const one = JSON.stringify(t.serialize());
    const two = JSON.stringify(Topology.fromJSON(JSON.parse(one)).serialize());
    if (one !== two) failures.push('seed ' + seed);
  }
  ok(built >= 20, 'the generator built topologies (' + built + ')');
  ok(failures.length === 0, 'every one of them round-trips byte for byte', failures.slice(0, 4).join(', '));
}

console.log('\nA reload does not change what the PoE budget sees:');
{
  // The hardware restore above is not cosmetic bookkeeping. `poeDraw()` adds `iface.poeOut` for every
  // cabled port, and 131 specs say `poeOut: true` - the spec's way of saying "this port sources
  // power" - rather than naming watts. Re-deriving that on load turned `true` into 15.4 W, so the same
  // lab reported a different power draw before and after being saved.
  const pseCandidates = catalog.filter(function (s) {
    return effectiveInterfaces(s).some(function (i) { return i.poeOut === true && i.type === 'ethernet'; });
  });
  const pdCandidates = catalog.filter(function (s) {
    return effectiveInterfaces(s).some(function (i) {
      return i.poeIn !== undefined && i.poeIn !== null && i.poeIn !== false && i.type === 'ethernet';
    });
  });
  ok(pseCandidates.length > 0 && pdCandidates.length > 0,
    'there are PoE sources (' + pseCandidates.length + ') and powered devices (' + pdCandidates.length + ')');

  // Ask the engine which media the pair actually shares, and which ports it would use, rather than
  // assuming gigabit copper: the first powered device in the catalogue is a fast-Ethernet box, and a
  // hardcoded 1000BASE-T was refused. linkOptions() answers with `options[]`, each carrying the media
  // and the port pairs that would work.
  let pair = null;
  for (const pse of pseCandidates.slice(0, 12)) {
    for (const pd of pdCandidates.slice(0, 12)) {
      const t0 = new Topology();
      const a0 = t0.addDevice(pse);
      const b0 = t0.addDevice(pd);
      const opts = t0.linkOptions(a0.id, b0.id, {});
      const copper = (opts.options || []).filter(function (o) { return o.family === 'copper' && o.pairs && o.pairs.length; })[0];
      if (!copper) continue;
      pair = {
        pse: pse, pd: pd, topology: t0, a: a0.id, b: b0.id,
        out: copper.pairs[0].a.iface, inp: copper.pairs[0].b.iface, media: copper.mediaId
      };
      break;
    }
    if (pair) break;
  }
  ok(!!pair, 'a mating pair is found by asking the engine for its shared media');
  if (pair) {
    const t = pair.topology;
    let cabled = null;
    try { cabled = t.connect(pair.a, pair.out, pair.b, pair.inp, { mediaId: pair.media }); } catch (e) { cabled = null; }
    ok(!!cabled, 'the two are cabled together (' + pair.media + ' on ' + pair.out + ' -> ' + pair.inp + ')');
    if (cabled) {
      const reloaded = roundTrip(t);
      const before = t.getDevice(pair.a).poeDraw();
      const after = reloaded.getDevice(pair.a).poeDraw();
      ok(before === after, 'the draw is the same before and after a save/load (' + before + ' W vs ' + after + ' W)');

      // The draw alone can be zero on both sides and prove nothing, so compare the hardware the
      // document carries for every port of both devices - that is where `true` became 15.4 W and
      // where the speed caps came back reordered.
      function hardwareOf(dev) {
        const out = {};
        for (const [name, i] of dev.interfaces) {
          out[name] = {
            cage: i.hardware.cage,
            media: i.hardware.media,
            speedCaps: i.hardware.speedCaps,
            poeOut: i.hardware.poeOut,
            poeIn: i.hardware.poeIn
          };
        }
        return JSON.stringify(out);
      }
      const hardwareBefore = hardwareOf(t.getDevice(pair.a)) + hardwareOf(t.getDevice(pair.b));
      const hardwareAfter = hardwareOf(reloaded.getDevice(pair.a)) + hardwareOf(reloaded.getDevice(pair.b));
      ok(hardwareBefore === hardwareAfter,
        'every port keeps the same cage, media, speed caps and PoE figures across a save/load');
      if (hardwareBefore !== hardwareAfter) {
        let i = 0;
        while (i < Math.min(hardwareBefore.length, hardwareAfter.length) && hardwareBefore[i] === hardwareAfter[i]) i++;
        console.log('         first difference: ...' + hardwareBefore.slice(Math.max(0, i - 60), i + 60) +
                    '  vs  ...' + hardwareAfter.slice(Math.max(0, i - 60), i + 60));
      }

      const caps = [...t.getDevice(pair.a).interfaces.values()].map(function (i) { return (i.hardware.speedCaps || []).join('/'); }).join('|');
      const capsAfter = [...reloaded.getDevice(pair.a).interfaces.values()].map(function (i) { return (i.hardware.speedCaps || []).join('/'); }).join('|');
      ok(caps === capsAfter, 'and the advertised speed caps keep their order and values');
    }
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
