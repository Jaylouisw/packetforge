'use strict';
// A declared connector that the engine does not recognise must not become copper.
//
// `derivePortHardware()` in engine/media.js does `CAGES[cage] || CAGES.rj45`. Six FS optical
// parts declared `connector: "lc"` - the medium's connector, not the cage's polish-specific
// key (`lc-upc` / `lc-apc`) - and all 38 of their ports silently became dead copper sockets
// that refused every cable, including another identical port, with "Cannot mate RJ45 to
// RJ45". `npm test` was green the whole time.
//
// The rule this pins is about the RESULT, not the spelling: a port that declares a non-copper
// connector must not resolve to an RJ45 cage. Some tokens are legitimately aliased by the
// engine (`f` for F-type coax resolves to the coax cage), so this compares the declared token
// against the cage the runtime actually built - which is what a user experiences.
const path = require('path');
const { Topology } = require('../engine');
const { CAGES } = require('../engine/media');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const DEVICES = path.join(__dirname, '..', 'devices');
const COPPER_TOKENS = ['rj45', 'rj11', 'rj12'];

const catalog = loadCatalog(DEVICES);
ok(catalog.length > 900, 'the catalogue loads (' + catalog.length + ' models)');

const t = new Topology();
const fallbacks = [];
let declared = 0;
const distinct = {};

for (const spec of catalog) {
  const wants = (spec.interfaces || []).filter(function (i) { return i.connector; });
  if (!wants.length) continue;
  let dev;
  try { dev = t.addDevice(spec); } catch (e) { continue; }
  const ifaces = dev.interfaces instanceof Map ? dev.interfaces : new Map();
  for (const want of wants) {
    const token = String(want.connector);
    if (COPPER_TOKENS.indexOf(token) !== -1) continue;
    declared++;
    distinct[token] = (distinct[token] || 0) + 1;
    const got = ifaces.get(want.name);
    const cage = got && got.hardware && got.hardware.cage;
    if (!cage || cage === 'rj45') {
      fallbacks.push({ spec: spec.vendor + '/' + spec.model, port: want.name, declared: token, resolved: cage || 'no port' });
    }
  }
}

console.log('');
console.log('A non-copper connector never lands in a copper cage:');
ok(declared > 500, 'the catalogue declares non-copper connectors to check (' + declared +
  ' ports, ' + Object.keys(distinct).length + ' distinct tokens)');
ok(fallbacks.length === 0, 'every one of them resolves to a cage of its own kind' +
  (fallbacks.length ? ' - ' + fallbacks.length + ' fell through to copper: ' +
    fallbacks.slice(0, 4).map(function (f) {
      return f.declared + ' on ' + f.spec + '/' + f.port;
    }).join(', ') : ''));

console.log('');
console.log('The tokens that caused this are now cages:');
ok(Object.keys(CAGES).indexOf('lc-upc') !== -1, 'lc-upc is a cage key');
ok(Object.keys(CAGES).indexOf('lc-apc') !== -1, 'lc-apc is a cage key');
ok(Object.keys(CAGES).indexOf('lc') === -1,
  'bare "lc" is not - it names a connector, not a ferrule polish, and guessing the polish is what this test forbids');

console.log('');
console.log('An optical part declared this way is usable again:');
{
  const mux = catalog.find(function (s) { return /^FMU-D402160M3$/.test(s.model); });
  ok(!!mux, 'the CWDM mux that had two dead ports is in the catalogue');
  if (mux) {
    const a = t.addDevice(mux);
    const b = t.addDevice(mux);
    const declaredPorts = mux.interfaces.filter(function (i) { return i.connector === 'lc-upc'; });
    ok(declaredPorts.length > 0, 'and declares lc-upc connectors (' + declaredPorts.length + ')');
    const port = declaredPorts[0];
    if (port) {
      const hw = a.interfaces.get(port.name);
      ok(hw.hardware.cage === 'lc-upc', 'which resolves to an lc-upc cage (' + hw.hardware.cage + ')');
      // A passive mux port is allowed to fail the optical BUDGET - that is a real answer
      // about launch power, not a refusal to mate. What must not happen is the pair being
      // refused for the physical layer: wrong cage, wrong media, wrong polish.
      const verdict = t.validateLink(a.id, port.name, b.id, port.name, {});
      const codes = (verdict.errors || []).map(function (e) { return e.code; });
      const physical = codes.filter(function (c) {
        return c === 'E_MEDIA_NOT_SUPPORTED' || c === 'E_CAGE_MISMATCH' || c === 'E_POLISH_MISMATCH' ||
          c === 'E_NO_COMMON_MEDIA' || c === 'E_WIRELESS_TO_WIRED';
      });
      ok(physical.length === 0, 'and two of them mate at the physical layer' +
        (physical.length ? ': refused with ' + physical.join(', ') : codes.length ? ' (only ' + codes.join(', ') + ', which is a budget answer)' : ''));
      const copper = t.validateLink(a.id, port.name, b.id, port.name, { mediaId: '1000base-t' });
      ok(copper.ok === false, 'while a copper patch lead into it is refused (' +
        (((copper.errors || [])[0] || {}).code || 'accepted') + ')');
    }
  }
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
