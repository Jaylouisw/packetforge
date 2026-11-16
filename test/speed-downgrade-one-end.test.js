'use strict';
// W_SPEED_DOWNGRADE was blind to one-end downgrades (#1523).
//
// validation.js raised the code only when the negotiated rate was below BOTH ends' maxima. So the case
// that actually happens in a homelab - a 10G RJ45 port meeting a 1G RJ45 port, negotiating 1000 - emitted
// nothing at all, while the rarer two-10G-ports-forced-onto-1000BASE-T case did warn:
//
//   C9300-24UX/Gi1/0/1 (10G rj45) <-> generic-switch/Fa0/1 (1G rj45)   ok, 1000 Mbps, warnings: (none)
//
// That made "a 10G-capable link never negotiates 1G" impossible to build a check on: the predicate a check
// would be written against is silent exactly where an operator cares.
//
// What is locked here:
//   1. one end above the negotiated rate now warns, and names the port whose capability is being lost;
//   2. the message states the ceiling truthfully - the peer's own maximum - and both end labels;
//   3. the answer does not depend on which end was cabled first;
//   4. the existing both-ends case (two 10G cages, a 1G module between them) is unchanged, wording included;
//   5. a 1G optic in a 10G cage is a part somebody chose, so it is NOT reported as a downgrade;
//   6. two equal ports say nothing, and the rule is about capability rather than about 10G;
//   7. the warning survives the path a UI and the cable-check endpoint actually use (Topology.validateLink),
//      and every port it names is a port on that device, spellable back into a console.
const path = require('path');
const assert = require('assert');
const { Topology } = require('../engine');
const validation = require('../engine/validation');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok ' + name);
  } catch (err) {
    failed++;
    console.error('  FAIL ' + name);
    const detail = (err && err.message) ? err.message : String(err);
    console.error('      ' + detail.split('\n').join('\n      '));
  }
}
function codes(list) {
  return (list || []).map(function (e) { return e.code; });
}
function downgrades(verdict) {
  return (verdict.warnings || []).filter(function (w) { return w.code === 'W_SPEED_DOWNGRADE'; });
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
function spec(model) {
  const s = catalog.filter(function (x) { return x.model === model; })[0];
  if (!s) throw new Error('catalogue has no ' + model);
  return s;
}

// Hand-built ports, so a cage and a module list can be stated exactly - the catalogue's ports are derived
// from their names and cannot express "this 10G cage holds a 1G part".
function mkIface(s) {
  return Object.assign({
    name: 'eth0', type: 'ethernet', speed: '1G', enabled: true, peer: null, ip: null, mask: null
  }, s);
}
function mkDevice(id, label, ifaceSpecs, extra) {
  const dev = Object.assign({
    id: id, name: label, label: label, model: 'test-' + id, category: 'switch', capabilities: []
  }, extra || {});
  const m = new Map();
  for (const s of ifaceSpecs) m.set(s.name, mkIface(s));
  dev.interfaces = m;
  return dev;
}
function cable(devA, portA, devB, portB, opts) {
  return validation.validateConnection(Object.assign(
    { devA: devA, portA: portA, devB: devB, portB: portB }, opts || {}));
}

// a -- Gi1/0/1 (10G rj45) ... Fa0/1 (1G rj45) -- b, the lab the issue measured.
function tenToGig() {
  const t = new Topology();
  const a = t.addDevice(spec('C9300-24UX'), 'a');
  const b = t.addDevice(spec('generic-switch'), 'b');
  return { t: t, a: a, b: b };
}

console.log('');
console.log('1. A 10G port meeting a 1G port is a downgrade, and it is no longer silent:');
test('a 10G rj45 port cabled to a 1G rj45 port warns', function () {
  const env = tenToGig();
  const v = env.t.validateLink('a', 'Gi1/0/1', 'b', 'Fa0/1');
  assert.strictEqual(v.ok, true, 'the cable is still legitimate, errors: ' + JSON.stringify(v.errors));
  assert.strictEqual(v.speedMbps, 1000, 'it negotiates 1000 Mbps');
  const w = downgrades(v);
  assert.strictEqual(w.length, 1, 'exactly one W_SPEED_DOWNGRADE, got: ' + codes(v.warnings).join(','));
  const msg = w[0].message;
  assert.ok(/Gi1\/0\/1/.test(msg), 'the message names the port whose capability is lost: ' + msg);
  assert.ok(/10G/.test(msg), 'and says what that port can do: ' + msg);
  assert.ok(/1G/.test(msg), 'and what the link actually runs at: ' + msg);
  assert.ok(/Fa0\/1/.test(msg), 'and names the peer that sets the ceiling: ' + msg);
});

console.log('');
console.log('2. The warning is about the link, not about the order it was cabled in:');
test('the same pair of ends is named either way round', function () {
  const env = tenToGig();
  const forward = env.t.validateLink('a', 'Gi1/0/1', 'b', 'Fa0/1');
  const reverse = env.t.validateLink('b', 'Fa0/1', 'a', 'Gi1/0/1');
  assert.strictEqual(downgrades(forward).length, 1, 'forward: one warning');
  assert.strictEqual(downgrades(reverse).length, 1, 'reverse: one warning');
  // Device labels can contain spaces ("Switch (L2)/Fa0/1"), so the ends are cut at the marker the
  // message itself uses rather than at the first space.
  const labels = function (m) {
    const m2 = String(m).match(/^Link (.+?) <-> (.+?) runs at /);
    return m2 ? [m2[1], m2[2]].sort().join(' | ') : String(m);
  };
  assert.strictEqual(labels(downgrades(forward)[0].message), labels(downgrades(reverse)[0].message),
    'the same pair of ends is named either way');
  // Which end is reported as the capable one follows the hardware, not the argument order.
  assert.ok(/Gi1\/0\/1 is a 10G port/.test(downgrades(reverse)[0].message),
    'the 10G end is the one named as capable: ' + downgrades(reverse)[0].message);
});

console.log('');
console.log('3. The two-ended case keeps its own words, because nothing in that link can go faster:');
test('two 10G cages with a 1G module still read as below both maxima', function () {
  const a = mkDevice('d1', 'SW1', [{ name: 'sfp-sfpplus1', speed: '10G' }]);
  const b = mkDevice('d2', 'SW2', [{ name: 'sfp-sfpplus2', speed: '10G', media: ['1000base-t-sfp'] }]);
  const v = cable(a, 'sfp-sfpplus1', b, 'sfp-sfpplus2');
  assert.strictEqual(v.ok, true, 'expected ok, errors: ' + JSON.stringify(v.errors));
  assert.strictEqual(v.speedMbps, 1000, 'the 1G module caps the link at 1G');
  const w = downgrades(v);
  assert.strictEqual(w.length, 1, 'one warning');
  assert.ok(/below the 10G of sfp-sfpplus1 and the 10G of sfp-sfpplus2/.test(w[0].message),
    'still reported as below both maxima: ' + w[0].message);
  assert.ok(!/tops out at/.test(w[0].message), 'and not as a one-ended downgrade: ' + w[0].message);
});

console.log('');
console.log('4. A deliberately slow part is not a downgrade:');
test('a 1G optic in a 10G cage facing a 1G port says nothing', function () {
  // Somebody chose that part; the link runs at its rate, and replacing the module is the only fix.
  const a = mkDevice('d3', 'SW3', [{ name: 'sfp-sfpplus1', speed: '10G', media: ['1000base-lx'] }]);
  const b = mkDevice('d4', 'SW4', [{ name: 'sfp1', speed: '1G', media: ['1000base-lx'] }]);
  const v = cable(a, 'sfp-sfpplus1', b, 'sfp1');
  assert.strictEqual(v.ok, true, 'expected ok, errors: ' + JSON.stringify(v.errors));
  assert.strictEqual(v.mediaId, '1000base-lx', 'the installed optic decides the medium');
  assert.strictEqual(v.speedMbps, 1000, 'and the rate');
  assert.deepStrictEqual(downgrades(v), [],
    'no warning: the ceiling is the module, got ' + codes(v.warnings).join(','));
});

console.log('');
console.log('5. Equal ports say nothing, and the rule is capability, not a 10G special case:');
test('a plain 1G link is clean, 2.5G into 1G and 1G into 100M are not', function () {
  const one = mkDevice('d5', 'SW5', [{ name: 'Fa0/1', speed: '1G' }]);
  const two = mkDevice('d6', 'SW6', [{ name: 'Fa0/1', speed: '1G' }]);
  assert.deepStrictEqual(downgrades(cable(one, 'Fa0/1', two, 'Fa0/1')), [],
    'a plain 1G link is still clean');

  const multi = mkDevice('d7', 'SW7', [{ name: 'eth1', speed: '2.5G' }]);
  const v = cable(multi, 'eth1', one, 'Fa0/1');
  assert.strictEqual(v.speedMbps, 1000, '2.5G into 1G negotiates 1G');
  assert.strictEqual(downgrades(v).length, 1,
    'and says so - 2.5G ports are the same fact as 10G ones, got ' + codes(v.warnings).join(','));

  const slow = mkDevice('d8', 'SW8', [{ name: 'Fa0/2', speed: '100M' }]);
  const v2 = cable(one, 'Fa0/1', slow, 'Fa0/2');
  assert.strictEqual(downgrades(v2).length, 1,
    'and so is 1G into 100M, got ' + codes(v2.warnings).join(','));
  assert.ok(/100M/.test(downgrades(v2)[0].message), 'naming the ceiling: ' + downgrades(v2)[0].message);
});

console.log('');
console.log('6. Pasteable: every word of the message belongs to a port the session can name:');
test('the message contains no control sequences and no placeholders', function () {
  const env = tenToGig();
  const v = env.t.validateLink('a', 'Gi1/0/1', 'b', 'Fa0/1');
  const msg = downgrades(v)[0].message;
  assert.ok(msg.indexOf('\u001b') === -1, 'no terminal control sequences');
  assert.ok(env.a.interfaces.has('Gi1/0/1'), 'Gi1/0/1 is a port on a');
  assert.ok(env.b.interfaces.has('Fa0/1'), 'Fa0/1 is a port on b');
  assert.ok(!/undefined|null|NaN/.test(msg), 'and nothing leaked a placeholder: ' + msg);
});

test('RULES still documents the code, and the description covers the one-ended case', function () {
  const rule = validation.RULES.filter(function (r) { return r.code === 'W_SPEED_DOWNGRADE'; })[0];
  assert.ok(rule, 'W_SPEED_DOWNGRADE is documented');
  assert.ok(/one end|both ends|a port on it/.test(rule.description),
    'and its description covers the one-ended case: ' + rule.description);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
