'use strict';
// One expansion rule, and a port count it can actually honour (#1319).
//
// `devices/registry.js` and `engine/topology.js` each had their own `expandInterfaces`. The test that was supposed
// to keep them in step compared **port names over the catalogue** - so a divergence in any other field, on any spec
// outside the catalogue, or in any edge case, was invisible by construction. Measured before this change: the two
// copies agreed on the whole catalogue (2,015 specs, every field), so the drift had not happened *yet*. What had
// happened is that they disagreed about a template they could not honour:
//
//   devices/registry.js  refused count: 1000000 (as a broken spec)
//   engine/topology.js   started building a million ports
//
// and `count: Infinity` passed both, because `Math.floor(Infinity) === Infinity && Infinity > 0`. Expanding it
// never returns: `docs/DEVICE_SCHEMA.md` says `count` is 1..512, and nothing enforced the upper bound.
//
// There is one implementation now, and the count is checked by the one rule both callers share.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadCatalog, effectiveInterfaces, portCountProblem, MAX_TEMPLATE_PORTS } = require('../devices/registry');
const { expandInterfaces, Topology } = require('../engine/topology');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const ROOT = path.join(__dirname, '..');
const specs = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });

console.log('');
console.log('The engine and the registry are one rule:');
{
  const engineSrc = fs.readFileSync(path.join(ROOT, 'engine', 'topology.js'), 'utf8');
  ok(/require\('\.\.\/devices\/registry'\)/.test(engineSrc), 'the engine requires the registry');
  ok(!/for \(let i = 0; i < count; i\+\+\)/.test(engineSrc), 'and no longer loops over a count of its own');
  ok(expandInterfaces({ portTemplate: { prefix: 'Gi', count: 3 } }).map(function (p) { return p.name; }).join(',') === 'Gi1,Gi2,Gi3',
    'the engine still expands a template the way it always did');

  // Whole port objects, every field, over the whole catalogue - not just the names.
  const drift = [];
  for (const s of specs) {
    const a = JSON.stringify(effectiveInterfaces(s));
    const b = JSON.stringify(expandInterfaces(s));
    if (a !== b) drift.push(s.vendor + ' ' + s.model);
  }
  ok(drift.length === 0, 'and agrees with the registry on every field of every port of ' + specs.length + ' specs',
    JSON.stringify(drift.slice(0, 3)));
}

console.log('');
console.log('A port count is a number from 1 to ' + MAX_TEMPLATE_PORTS + ', and nothing else:');
{
  const bad = [0, -1, 1.5, '8', Infinity, -Infinity, NaN, MAX_TEMPLATE_PORTS + 1, 1000000];
  const refused = [];
  for (const count of bad) {
    let threw = null;
    try { expandInterfaces({ portTemplate: { prefix: 'p', count: count } }); } catch (e) { threw = e.message; }
    if (!threw) refused.push('count ' + String(count) + ' expanded anyway');
    else if (!/1 to 512/.test(threw)) refused.push('count ' + String(count) + ' -> ' + threw);
  }
  ok(refused.length === 0, bad.length + ' impossible counts are refused, and the message names the range',
    JSON.stringify(refused.slice(0, 3)));

  ok(expandInterfaces({ portTemplate: { prefix: 'p', count: MAX_TEMPLATE_PORTS } }).length === MAX_TEMPLATE_PORTS,
    '512 is still allowed', String(MAX_TEMPLATE_PORTS));
  ok(expandInterfaces({ portTemplate: { prefix: 'p' } }).length === 1, 'and an absent count still means one port');

  // The message uses the value the author wrote, not "null" (which is what JSON.stringify(Infinity) gives).
  const inf = portCountProblem(Infinity);
  ok(/Infinity/.test(inf), 'Infinity is reported as Infinity', inf);
  ok(portCountProblem(undefined) === '' && portCountProblem(null) === '', 'and an absent count is not a problem');
}

console.log('');
console.log('A spec that cannot be honoured is refused where it enters:');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-count-'));
  fs.writeFileSync(path.join(dir, 'million.json'), JSON.stringify({
    vendor: 'Testco', model: 'Million', category: 'switch', portTemplate: { prefix: 'Gi', count: 1000000 } }));
  fs.writeFileSync(path.join(dir, 'infinity.json'), '{"vendor":"Testco","model":"Inf","category":"switch","portTemplate":{"prefix":"Gi","count":1e999}}');
  fs.writeFileSync(path.join(dir, 'fine.json'), JSON.stringify({
    vendor: 'Testco', model: 'Fine', category: 'switch', portTemplate: { prefix: 'Gi', count: 24 } }));
  const loaded = loadCatalog(dir);
  const broken = loaded.filter(function (s) { return s.error; });
  const good = loaded.filter(function (s) { return !s.error; });
  ok(good.length === 1 && good[0].model === 'Fine', 'the sane one loads', JSON.stringify(good.map(function (g) { return g.model; })));
  ok(broken.length === 2, 'and the two impossible ones are reported, not expanded', String(broken.length));
  ok(broken.every(function (b) { return /1 to 512/.test(b.error); }), 'each naming the range',
    JSON.stringify(broken.map(function (b) { return b.error; })));
  ok(broken.some(function (b) { return /Infinity/.test(b.error); }), 'and the infinite one as Infinity');
  fs.rmSync(dir, { recursive: true, force: true });

  // The other door: a device built from a hand-edited saved board never passes through the loader.
  const t = new Topology();
  let threw = null;
  try {
    t.addDevice({ vendor: 'Testco', model: 'Million', category: 'switch', portTemplate: { prefix: 'Gi', count: 1000000 } }, 'd1');
  } catch (e) { threw = e.message; }
  ok(!!threw && /1 to 512/.test(threw), 'and a device built straight from a spec is refused the same way', threw);
  ok(t.devices.size === 0, 'leaving no half-built device behind', String(t.devices.size));
}
console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
