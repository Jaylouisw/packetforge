'use strict';
// Hardware invariants that every device spec must satisfy.
//
// PacketForge's contribution model is "add a JSON file", which means the quality
// of the catalogue depends entirely on rules that are mechanically checkable.
// This suite is that rulebook: it runs over the whole catalogue rather than a
// fixture, so a new device that lies about its own hardware fails CI.
//
// Each check below exists because the catalogue actually got it wrong once:
//   - 68 devices advertised optics their ports could not deliver
//   - a switch was credited 500 W of PoE from its power-supply rating
//   - CX 6100 12G was modelled with 14 ports where the datasheet has 16
const path = require('path');
const { Topology } = require('../engine');
const { loadCatalog } = require('../devices/registry');
const mediaLib = require('../engine/media');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));

// Build one device per spec, so we check what the engine really exposes rather
// than what the JSON claims.
function materialise() {
  const out = [];
  for (const spec of catalog) {
    const t = new Topology();
    const d = t.addDevice(spec);
    out.push({ spec: spec, dev: d, ifaces: [...d.interfaces.values()] });
  }
  return out;
}
const all = materialise();

// A description may legitimately say "no SFP cages"; that is documentation, not
// a promise. Strip the denials before looking for an optics claim.
function claimsOptics(desc) {
  return /\b(sfp|qsfp|xfp)\b/i.test(
    String(desc || '')
      .replace(/\b(no|without|zero|none|not)\b[^.;,]{0,24}\b(sfp|qsfp|xfp)\b/gi, ' ')
      .replace(/\b(sfp|qsfp|xfp)\b[^.;,]{0,16}\b(none|n\/a|-)\b/gi, ' ')
  );
}

const OPTICAL = ['sfp', 'sfp+', 'sfp28', 'sfp56', 'qsfp+', 'qsfp28', 'qsfp56', 'xfp', 'cfp'];

console.log('Every device exposes ports it can actually cable:');
{
  const bare = all.filter(function (x) {
    return x.ifaces.length === 0;
  });
  ok(bare.length === 0, 'no device has zero interfaces' +
    (bare.length ? ' (' + bare.map(function (b) { return b.spec.model; }).join(', ') + ')' : ''));

  const uncablable = [];
  for (const x of all) {
    for (const i of x.ifaces) {
      if (i.type !== 'ethernet') continue;
      if (!i.hardware.media || !i.hardware.media.length) {
        uncablable.push(x.spec.model + '/' + i.name);
      }
    }
  }
  ok(uncablable.length === 0, 'every ethernet port has at least one usable medium' +
    (uncablable.length ? ' (' + uncablable.slice(0, 3).join(', ') + ')' : ''));
}

console.log('\nPort names are unambiguous:');
{
  const duff = [];
  for (const x of all) {
    const seen = new Set();
    for (const i of x.ifaces) {
      if (seen.has(i.name)) duff.push(x.spec.model + '/' + i.name);
      seen.add(i.name);
    }
  }
  ok(duff.length === 0, 'no duplicate port names within a device' +
    (duff.length ? ' (' + duff.slice(0, 3).join(', ') + ')' : ''));
}

console.log('\nThe description does not promise hardware the ports lack:');
{
  const liars = [];
  for (const x of all) {
    if (!claimsOptics(x.spec.description)) continue;
    const optical = x.ifaces.filter(function (i) {
      return OPTICAL.indexOf(i.hardware.cage) !== -1;
    });
    if (!optical.length) liars.push(x.spec.vendor + '/' + x.spec.model);
  }
  ok(liars.length === 0, 'devices advertising optics have an optical cage' +
    (liars.length ? ' (' + liars.length + ': ' + liars.slice(0, 5).join(', ') + ')' : ''));
}

console.log('\nCages and media agree with each other:');
{
  // An optical cage that accepts copper would let an impossible cable through,
  // which is the exact class of bug the physical layer exists to stop.
  const confused = [];
  for (const x of all) {
    for (const i of x.ifaces) {
      const hw = i.hardware;
      if (OPTICAL.indexOf(hw.cage) === -1) continue;
      // A copper SFP (1000BASE-T SFP) really does live in a fibre cage, so only
      // flag media that are plain copper cabling rather than copper optics.
      const copper = (hw.media || []).filter(function (m) {
        const def = mediaLib.mediaById(m);
        if (!def) return false;
        return def.family === 'copper' && def.connector !== 'sfp';
      });
      if (copper.length) confused.push(x.spec.model + '/' + i.name + ' (' + copper.join(',') + ')');
    }
  }
  ok(confused.length === 0, 'no optical cage accepts a copper medium' +
    (confused.length ? ' (' + confused.slice(0, 3).join('; ') + ')' : ''));

  // The advertised speed must be the fastest the cage is known to support,
  // otherwise the picker offers links the hardware cannot run at.
  //
  // Console ports are exempt: a USB or serial console genuinely runs at 12 Mbps
  // or 115.2 kbps and is not a data path. Anything else under 100 Mbps is a
  // modelling error - and so is a port whose declared line rate outruns the
  // medium under it, which is exactly how 28 tablets ended up advertising a
  // gigabit on a USB 1.1 console port.
  function isConsoleOnly(hw) {
    const list = hw.media || [];
    if (!list.length) return false;
    return list.every(function (id) {
      const def = mediaLib.mediaById(id);
      return def && (def.family === 'console' || def.family === 'management');
    });
  }

  const slow = [], overreach = [];
  for (const x of all) {
    for (const i of x.ifaces) {
      const caps = i.hardware.speedCaps;
      if (!caps || !caps.length) continue;
      if (!i.hardware.media) continue;
      if (isConsoleOnly(i.hardware)) continue;
      const top = Math.max.apply(null, caps);
      if (top < 100) slow.push(x.spec.model + '/' + i.name + ' top ' + top + ' Mbps');
      // NOTE: read hardware.maxSpeedMbps, not i.speedMbps. The latter does not
      // exist on the Interface model, so this assertion silently compared zero
      // and could never fail - it was vacuous from the day it was written.
      const declared = i.hardware.maxSpeedMbps || 0;
      // Line-rate rounding: a "2.5G" PON port is really 2.488 Gbit/s and a "10G"
      // PON port 9.953, so allow a couple of percent before calling it a claim
      // the cage cannot carry.
      if (declared && top && declared > top * 1.02) {
        overreach.push(x.spec.model + '/' + i.name + ' claims ' + declared +
          ' Mbps on a ' + top + ' Mbps ' + i.hardware.cage + ' cage');
      }
    }
  }
  ok(slow.length === 0, 'no data port advertises a sub-100 Mbps-only cage' +
    (slow.length ? ' (' + slow.slice(0, 3).join(', ') + ')' : ''));
  ok(overreach.length === 0, 'no port claims a line rate its cage cannot carry' +
    (overreach.length ? ' (' + overreach.slice(0, 3).join(', ') + ')' : ''));
}

console.log('\nPoE claims are internally consistent:');
{
  const phantom = [], unknownOk = [];
  for (const x of all) {
    const pse = x.ifaces.filter(function (i) { return i.hardware.poeOut; });
    if (x.dev.poeBudget > 0 && pse.length === 0) {
      phantom.push(x.spec.model + ' (' + x.dev.poeBudget + ' W, 0 PSE ports)');
    }
    if (x.spec.poe && x.spec.poe.budgetUnknown) {
      // An explicit "never published" must not be silently replaced by a
      // model-name guess such as ES-24-500W's 500.
      unknownOk.push(x.dev.poeBudget === 0 ? 'ok' : 'LEAKED ' + x.spec.model);
    }
  }
  ok(phantom.length === 0, 'no device claims a power budget with no port to source it' +
    (phantom.length ? ' (' + phantom.slice(0, 3).join(', ') + ')' : ''));
  ok(unknownOk.every(function (s) { return s === 'ok'; }),
    'research-marked-unknown budgets stay unknown instead of falling back to the model name');

  // A budget must be a plausible number: watts, not a description of one.
  const daft = all.filter(function (x) {
    return x.dev.poeBudget < 0 || x.dev.poeBudget > 8000;
  });
  ok(daft.length === 0, 'every PoE budget is a plausible wattage');
}

console.log('\nEvery device can be plugged into a copy of itself:');
{
  // If no two ports on identical hardware can mate, the device is an island -
  // it could never take part in a lab, so the spec is useless even if valid.
  const islands = [];
  for (const x of all) {
    if (x.ifaces.length === 0) { islands.push(x.spec.model + ' (no ports)'); continue; }
    const t = new Topology();
    const a = t.addDevice(x.spec);
    const b = t.addDevice(x.spec);
    let mated = false;
    for (const ia of a.interfaces.values()) {
      for (const ib of b.interfaces.values()) {
        const v = t.validateLink(a.id, ia.name, b.id, ib.name, {});
        if (v && v.ok) { mated = true; break; }
      }
      if (mated) break;
    }
    if (!mated) islands.push(x.spec.vendor + '/' + x.spec.model);
  }
  ok(islands.length === 0, 'all ' + catalog.length + ' devices can be cabled to themselves' +
    (islands.length ? ' (' + islands.slice(0, 5).join(', ') + ')' : ''));
}

console.log('\nVendor and model identity is unique:');
{
  const seen = new Map();
  const dupes = [];
  for (const s of catalog) {
    const key = String(s.vendor).toLowerCase() + '|' + String(s.model).toLowerCase();
    if (seen.has(key)) dupes.push(key);
    seen.set(key, 1);
  }
  ok(dupes.length === 0, 'no two specs share a vendor and model' +
    (dupes.length ? ' (' + dupes.slice(0, 3).join(', ') + ')' : ''));
  ok(catalog.length >= 300, 'the catalogue is still populated (' + catalog.length + ' models)');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
