'use strict';
// validation.test.js -- unit tests for the cabling-feasibility rules engine.
// Plain assert, no framework. Fixture devices are hand-built plain objects so
// the tests exercise engine/validation.js in isolation (no server, no device
// registry, no topology).

const assert = require('assert');
const media = require('../engine/media');
const validation = require('../engine/validation');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  \u2713 ' + name);
  } catch (err) {
    failed++;
    console.error('  \u2717 ' + name);
    const detail = (err && err.message) ? err.message : String(err);
    console.error('      ' + detail.split('\n').join('\n      '));
  }
}

function codes(list) {
  return (list || []).map(function (e) { return e.code; });
}

function hasCode(list, code) {
  return codes(list).indexOf(code) !== -1;
}

function messages(list) {
  return (list || []).map(function (e) { return e.message; }).join(' | ');
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function mkIface(spec) {
  return Object.assign({
    name: 'eth0',
    type: 'ethernet',
    speed: '1G',
    enabled: true,
    peer: null,
    ip: null,
    mask: null
  }, spec);
}

function mkDevice(id, label, ifaceSpecs, extra) {
  const dev = {
    id: id,
    name: label,
    label: label,
    model: 'test-' + id,
    category: 'switch',
    capabilities: [],
    interfaces: new Map(),
    poeBudget: 0
  };
  Object.assign(dev, extra || {});
  (ifaceSpecs || []).forEach(function (spec) {
    dev.interfaces.set(spec.name, mkIface(spec));
  });
  return dev;
}

// Cable two named ports and validate. Ports are passed as raw interface specs
// (the normaliser derives the hardware), which is how the UI calls it.
function cable(devA, nameA, devB, nameB, extra) {
  const a = devA.interfaces.get(nameA);
  const b = devB.interfaces.get(nameB);
  assert.ok(a, 'fixture is missing ' + nameA + ' on ' + devA.id);
  assert.ok(b, 'fixture is missing ' + nameB + ' on ' + devB.id);
  return validation.validateConnection(Object.assign({
    devA: devA, devB: devB,
    ifaceA: a, ifaceB: b,
    portA: a, portB: b
  }, extra || {}));
}

// ---------------------------------------------------------------------------
// 1. happy path
// ---------------------------------------------------------------------------

test('accepts a plain 1G copper RJ45 link', function () {
  const sw = mkDevice('d1', 'SW1', [{ name: 'Fa0/1', speed: '1G' }]);
  const pc = mkDevice('d2', 'PC1', [{ name: 'eth0', speed: '1G' }], { category: 'host' });
  const r = cable(sw, 'Fa0/1', pc, 'eth0');

  assert.strictEqual(r.ok, true, 'expected ok, errors: ' + messages(r.errors));
  assert.deepStrictEqual(r.errors, [], 'errors must be an empty array');
  assert.deepStrictEqual(r.warnings, [], 'warnings must be an empty array');
  assert.strictEqual(r.speedMbps, 1000, 'expected 1G negotiated');
  assert.strictEqual(r.mediaId, '1000base-t', 'expected 1000BASE-T');
  assert.ok(r.media.indexOf('1000base-t') !== -1, 'common media must include 1000base-t');
});

test('accepts pre-derived port hardware objects', function () {
  const specA = { name: 'Fa0/2', type: 'ethernet', speed: '1G' };
  const specB = { name: 'eth1', type: 'ethernet', speed: '1G' };
  const devA = mkDevice('d1', 'SW1', [specA], { category: 'host' });
  const devB = mkDevice('d2', 'PC1', [specB], { category: 'host' });

  const portA = media.derivePortHardware(specA, { model: 'test-d1' });
  const portB = media.derivePortHardware(specB, { model: 'test-d2' });
  const r = validation.validateConnection({
    devA: devA, devB: devB,
    ifaceA: devA.interfaces.get('Fa0/2'),
    ifaceB: devB.interfaces.get('eth1'),
    portA: portA, portB: portB
  });

  assert.strictEqual(r.ok, true, 'expected ok, errors: ' + messages(r.errors));
  assert.strictEqual(r.speedMbps, 1000);
  assert.strictEqual(r.mediaId, '1000base-t');
});

test('resolves ports by name when only devices are supplied', function () {
  const devA = mkDevice('d1', 'SW1', [{ name: 'Fa0/1', speed: '1G' }], { category: 'host' });
  const devB = mkDevice('d2', 'SW2', [{ name: 'Fa0/1', speed: '1G' }], { category: 'host' });
  const r = validation.validateConnection({
    devA: devA, devB: devB, portA: 'Fa0/1', portB: 'Fa0/1'
  });
  assert.strictEqual(r.ok, true, 'expected ok, errors: ' + messages(r.errors));
  assert.strictEqual(r.speedMbps, 1000);
});

// ---------------------------------------------------------------------------
// 2. connector / media / speed rejections
// ---------------------------------------------------------------------------

test('rejects an RJ45 port cabled to an SFP cage', function () {
  const sw = mkDevice('d1', 'SW1', [{ name: 'Fa0/1', speed: '1G' }]);
  const srv = mkDevice('d2', 'SRV1', [{ name: 'eth-sfp1', speed: '1G' }], { category: 'host' });
  const r = cable(sw, 'Fa0/1', srv, 'eth-sfp1');

  assert.strictEqual(r.ok, false, 'RJ45 to SFP must be blocked');
  assert.ok(hasCode(r.errors, 'E_CONNECTOR_MISMATCH'),
    'expected E_CONNECTOR_MISMATCH, got: ' + codes(r.errors).join(','));
  assert.ok(/SW1\/Fa0\/1/.test(messages(r.errors)), 'message must name port A');
  assert.ok(/SRV1\/eth-sfp1/.test(messages(r.errors)), 'message must name port B');
});

test('rejects ports that share a medium but no line rate', function () {
  // A 1G SFP cage and a 25G-only SFP28 cage that has been pinned to a copper
  // SFP module: they share the medium, but not a speed.
  const a = mkDevice('d1', 'SW1', [{ name: 'eth-sfp1', speed: '1G' }]);
  const b = mkDevice('d2', 'SW2', [{
    name: 'eth-sfp2', cage: 'sfp28', speed: '25G', media: ['1000base-t-sfp']
  }]);
  const r = cable(a, 'eth-sfp1', b, 'eth-sfp2');

  assert.strictEqual(r.ok, false, 'no common speed must be blocked');
  assert.ok(hasCode(r.errors, 'E_NO_COMMON_SPEED'),
    'expected E_NO_COMMON_SPEED, got: ' + codes(r.errors).join(','));
});

test('rejects a wireless radio cabled to a wired port', function () {
  const ap = mkDevice('d1', 'AP1', [{ name: 'wlan0', type: 'radio', speed: '1G' }],
    { category: 'wireless' });
  const sw = mkDevice('d2', 'SW1', [{ name: 'Fa0/1', speed: '1G' }]);
  const r = cable(ap, 'wlan0', sw, 'Fa0/1');

  assert.strictEqual(r.ok, false, 'wireless to wired must be blocked');
  assert.ok(hasCode(r.errors, 'E_WIRELESS_TO_WIRED'),
    'expected E_WIRELESS_TO_WIRED, got: ' + codes(r.errors).join(','));
});

test('rejects a console port cabled to a data port', function () {
  const rtr = mkDevice('d1', 'R1', [
    { name: 'Gi0/0', speed: '1G' },
    { name: 'console0', type: 'console', speed: '1G' }
  ], { category: 'router' });
  const sw = mkDevice('d2', 'SW1', [{ name: 'Fa0/1', speed: '1G' }]);
  const r = cable(rtr, 'console0', sw, 'Fa0/1');

  assert.strictEqual(r.ok, false, 'console to data must be blocked');
  assert.ok(hasCode(r.errors, 'E_CONSOLE_TO_DATA'),
    'expected E_CONSOLE_TO_DATA, got: ' + codes(r.errors).join(','));
  assert.ok(!hasCode(r.errors, 'E_CONNECTOR_MISMATCH'),
    'the generic connector error must not double-report the console problem');
  assert.ok(/console0/.test(messages(r.errors)), 'message must name the console port');
});

test('rejects a link onto a port that is already used', function () {
  const sw = mkDevice('d1', 'SW1', [{ name: 'Fa0/1', speed: '1G' }]);
  const pc = mkDevice('d2', 'PC1', [{ name: 'eth0', speed: '1G' }], { category: 'host' });
  sw.interfaces.get('Fa0/1').peer = { deviceId: 'd9', iface: 'Fa0/9' };

  const r = cable(sw, 'Fa0/1', pc, 'eth0');

  assert.strictEqual(r.ok, false, 'a used port must be blocked');
  assert.ok(hasCode(r.errors, 'E_PORT_IN_USE'),
    'expected E_PORT_IN_USE, got: ' + codes(r.errors).join(','));
  const msg = messages(r.errors);
  assert.ok(/SW1\/Fa0\/1/.test(msg), 'message must name the busy port, got: ' + msg);
  assert.ok(/d9\/Fa0\/9/.test(msg), 'message must name the existing peer, got: ' + msg);
});

test('rejects cabling a device to itself', function () {
  const sw = mkDevice('d1', 'SW1', [
    { name: 'Fa0/1', speed: '1G' },
    { name: 'Fa0/2', speed: '1G' }
  ]);
  const r = cable(sw, 'Fa0/1', sw, 'Fa0/2');

  assert.strictEqual(r.ok, false, 'self link must be blocked');
  assert.ok(hasCode(r.errors, 'E_SELF_LINK'),
    'expected E_SELF_LINK, got: ' + codes(r.errors).join(','));
});

test('rejects a port that does not exist', function () {
  const sw = mkDevice('d1', 'SW1', [{ name: 'Fa0/1', speed: '1G' }]);
  const pc = mkDevice('d2', 'PC1', [{ name: 'eth0', speed: '1G' }], { category: 'host' });
  const r = validation.validateConnection({
    devA: sw, devB: pc, ifaceB: pc.interfaces.get('eth0'), portB: 'eth0'
  });

  assert.strictEqual(r.ok, false, 'a missing port must be blocked');
  assert.ok(hasCode(r.errors, 'E_NO_PORT'),
    'expected E_NO_PORT, got: ' + codes(r.errors).join(','));
});

// ---------------------------------------------------------------------------
// 3. explicit media selection
// ---------------------------------------------------------------------------

test('rejects an explicit mediaId the ports cannot carry', function () {
  const sw = mkDevice('d1', 'SW1', [{ name: 'Fa0/1', speed: '1G' }]);
  const pc = mkDevice('d2', 'PC1', [{ name: 'eth0', speed: '1G' }], { category: 'host' });
  const r = cable(sw, 'Fa0/1', pc, 'eth0', { mediaId: '1000base-sx' });

  assert.strictEqual(r.ok, false, 'unsupported medium must be blocked');
  assert.ok(hasCode(r.errors, 'E_MEDIA_NOT_SUPPORTED'),
    'expected E_MEDIA_NOT_SUPPORTED, got: ' + codes(r.errors).join(','));
  assert.strictEqual(r.mediaId, null, 'no medium is selected when the choice is invalid');
  assert.ok(r.media.indexOf('1000base-t') !== -1, 'the common set is still reported');
});

test('honours an explicit supported mediaId', function () {
  const sw = mkDevice('d1', 'SW1', [{ name: 'Fa0/1', speed: '1G' }]);
  const pc = mkDevice('d2', 'PC1', [{ name: 'eth0', speed: '1G' }], { category: 'host' });
  const r = cable(sw, 'Fa0/1', pc, 'eth0', { mediaId: '100base-tx' });

  assert.strictEqual(r.ok, true, 'expected ok, errors: ' + messages(r.errors));
  assert.strictEqual(r.mediaId, '100base-tx');
  assert.strictEqual(r.speedMbps, 100, 'a 100BASE-TX module caps the link at 100M');
  assert.ok(hasCode(r.warnings, 'W_SPEED_DOWNGRADE'),
    'forcing 100M onto two 1G ports must warn, got: ' + codes(r.warnings).join(','));
});

// ---------------------------------------------------------------------------
// 4. PoE
// ---------------------------------------------------------------------------

test('rejects a link that exhausts the PSE power budget', function () {
  const sw = mkDevice('d1', 'SW-PoE', [
    { name: 'Gi0/1', speed: '1G', poeOut: 15.4 },
    { name: 'Gi0/2', speed: '1G', poeOut: 15.4 }
  ], { capabilities: ['poe-pse'], poeBudget: 30 });
  const ap = mkDevice('d2', 'AP1', [{ name: 'eth0', speed: '1G', poeIn: 12.95 }],
    { category: 'wireless', capabilities: ['poe-pd'] });

  // Port 1 already powers an access point; port 2 would push the switch over.
  sw.interfaces.get('Gi0/1').peer = { deviceId: 'd3', iface: 'eth0' };

  const r = cable(sw, 'Gi0/2', ap, 'eth0');

  assert.strictEqual(r.ok, false, 'budget exhaustion must be blocked');
  assert.ok(hasCode(r.errors, 'E_POE_BUDGET'),
    'expected E_POE_BUDGET, got: ' + codes(r.errors).join(','));
  assert.ok(/30\.8/.test(messages(r.errors)),
    'message should report the actual draw, got: ' + messages(r.errors));
});

test('warns when a PoE-powered device meets a port without power', function () {
  const sw = mkDevice('d1', 'SW1', [{ name: 'Fa0/1', speed: '1G' }]);
  const ap = mkDevice('d2', 'AP1', [{ name: 'eth0', speed: '1G' }],
    { category: 'wireless', capabilities: ['poe-pd'] });

  const r = cable(sw, 'Fa0/1', ap, 'eth0');

  assert.strictEqual(r.ok, true, 'a powerless port still links, errors: ' + messages(r.errors));
  assert.ok(hasCode(r.warnings, 'W_POE_DRAW'),
    'expected W_POE_DRAW, got: ' + codes(r.warnings).join(','));
});

// ---------------------------------------------------------------------------
// 5. warnings
// ---------------------------------------------------------------------------

test('warns when the copper run exceeds the media reach', function () {
  const sw = mkDevice('d1', 'SW1', [{ name: 'Fa0/1', speed: '1G' }]);
  const pc = mkDevice('d2', 'PC1', [{ name: 'eth0', speed: '1G' }], { category: 'host' });
  const r = cable(sw, 'Fa0/1', pc, 'eth0', { lengthM: 150 });

  assert.strictEqual(r.ok, true, 'an over-long run is still a legal link');
  assert.deepStrictEqual(r.errors, []);
  assert.ok(hasCode(r.warnings, 'W_DISTANCE'),
    'expected W_DISTANCE, got: ' + codes(r.warnings).join(','));
  assert.ok(hasCode(r.warnings, 'W_COPPER_LONGRUN'),
    'expected W_COPPER_LONGRUN, got: ' + codes(r.warnings).join(','));
});

test('warns on a duplex mismatch', function () {
  const sw = mkDevice('d1', 'SW1', [{ name: 'Fa0/1', speed: '1G' }]);
  const pc = mkDevice('d2', 'PC1', [{ name: 'eth0', speed: '1G' }], { category: 'host' });
  const r = cable(sw, 'Fa0/1', pc, 'eth0', { duplexA: 'full', duplexB: 'half' });

  assert.strictEqual(r.ok, true, 'a duplex mismatch is allowed');
  assert.ok(hasCode(r.warnings, 'W_DUPLEX_MISMATCH'),
    'expected W_DUPLEX_MISMATCH, got: ' + codes(r.warnings).join(','));
  assert.ok(/full/.test(messages(r.warnings)) && /half/.test(messages(r.warnings)),
    'message should report both ends, got: ' + messages(r.warnings));
});

test('warns when the link downgrades both ports', function () {
  // Two 10G SFP+ cages with only a 1G copper module in common.
  const a = mkDevice('d1', 'SW1', [{ name: 'sfp-sfpplus1', speed: '10G' }]);
  const b = mkDevice('d2', 'SW2', [{
    name: 'sfp-sfpplus2', speed: '10G', media: ['1000base-t-sfp']
  }]);
  const r = cable(a, 'sfp-sfpplus1', b, 'sfp-sfpplus2');

  assert.strictEqual(r.ok, true, 'expected ok, errors: ' + messages(r.errors));
  assert.strictEqual(r.mediaId, '1000base-t-sfp');
  assert.strictEqual(r.speedMbps, 1000, 'the copper module caps the link at 1G');
  assert.ok(hasCode(r.warnings, 'W_SPEED_DOWNGRADE'),
    'expected W_SPEED_DOWNGRADE, got: ' + codes(r.warnings).join(','));
});

test('a matching 10G fiber link produces no warnings', function () {
  const a = mkDevice('d1', 'SW1', [{ name: 'sfp-sfpplus1', speed: '10G' }]);
  const b = mkDevice('d2', 'SW2', [{ name: 'sfp-sfpplus2', speed: '10G' }]);
  const r = cable(a, 'sfp-sfpplus1', b, 'sfp-sfpplus2', { lengthM: 30 });

  assert.strictEqual(r.ok, true, 'expected ok, errors: ' + messages(r.errors));
  assert.strictEqual(r.speedMbps, 10000);
  assert.strictEqual(r.mediaId, '10gbase-sr', 'prefer the highest-speed fiber');
  assert.deepStrictEqual(r.warnings, [], 'no warnings expected');
});

// ---------------------------------------------------------------------------
// 6. LAG members
// ---------------------------------------------------------------------------

test('rejects LAG members that run at different rates', function () {
  const a = mkDevice('d1', 'SW1', [{ name: 'Fa0/1', speed: '1G', lagId: 'po1' }]);
  const b = mkDevice('d2', 'SW2', [{ name: 'Fa0/1', speed: '10G', lagId: 'po1' }]);
  const r = cable(a, 'Fa0/1', b, 'Fa0/1');

  assert.strictEqual(r.ok, false, 'imbalanced LAG members must be blocked');
  assert.ok(hasCode(r.errors, 'E_LAG_SPEED_MISMATCH'),
    'expected E_LAG_SPEED_MISMATCH, got: ' + codes(r.errors).join(','));
});

// ---------------------------------------------------------------------------
// 7. catalogue + topology aggregation
// ---------------------------------------------------------------------------

test('RULES documents every code the engine can emit', function () {
  assert.ok(Array.isArray(validation.RULES) && validation.RULES.length >= 16,
    'RULES must be a non-trivial array');
  const seen = {};
  validation.RULES.forEach(function (r) {
    assert.ok(typeof r.code === 'string' && r.code.length > 0, 'rule needs a code');
    assert.ok(r.severity === 'error' || r.severity === 'warning', 'bad severity: ' + r.severity);
    assert.ok(typeof r.description === 'string' && r.description.length > 10,
      'rule ' + r.code + ' needs a description');
    assert.ok(!seen[r.code], 'duplicate rule code ' + r.code);
    seen[r.code] = true;
  });
  ['E_NO_PORT', 'E_SELF_LINK', 'E_PORT_IN_USE', 'E_CONNECTOR_MISMATCH',
    'E_NO_COMMON_MEDIA', 'E_NO_COMMON_SPEED', 'E_WIRELESS_TO_WIRED',
    'E_CONSOLE_TO_DATA', 'E_MEDIA_NOT_SUPPORTED', 'E_POE_BUDGET',
    'E_LAG_SPEED_MISMATCH', 'W_DISTANCE', 'W_DUPLEX_MISMATCH',
    'W_SPEED_DOWNGRADE', 'W_POE_DRAW', 'W_COPPER_LONGRUN'
  ].forEach(function (code) {
    assert.ok(seen[code], 'RULES is missing ' + code);
  });
});

test('validateTopology aggregates verdicts and bare issues', function () {
  const sw = mkDevice('d1', 'SW1', [{ name: 'Fa0/1', speed: '1G' }]);
  const pc = mkDevice('d2', 'PC1', [{ name: 'eth0', speed: '1G' }], { category: 'host' });
  const good = cable(sw, 'Fa0/1', pc, 'eth0', { lengthM: 150 });
  const bad = cable(sw, 'Fa0/1', pc, 'eth0', { mediaId: '1000base-sx' });

  const summary = validation.validateTopology([
    Object.assign({ linkId: 'l1' }, good),
    Object.assign({ linkId: 'l2' }, bad),
    { code: 'W_POE_DRAW', message: 'extra note' }
  ]);

  assert.strictEqual(summary.ok, false, 'a blocking error means the topology fails');
  assert.strictEqual(summary.errorCount, 1, 'one error expected');
  assert.strictEqual(summary.warningCount, 3, 'two distance warnings plus the bare one');
  assert.strictEqual(summary.issues.length, 4);
  assert.strictEqual(summary.issues[0].linkId, 'l1', 'extra fields survive aggregation');
  assert.strictEqual(summary.issues[0].severity, 'warning');
});

test('validateTopology reports a clean topology as ok', function () {
  const sw = mkDevice('d1', 'SW1', [{ name: 'Fa0/1', speed: '1G' }]);
  const pc = mkDevice('d2', 'PC1', [{ name: 'eth0', speed: '1G' }], { category: 'host' });
  const good = cable(sw, 'Fa0/1', pc, 'eth0');

  const summary = validation.validateTopology([good]);
  assert.strictEqual(summary.ok, true);
  assert.strictEqual(summary.errorCount, 0);
  assert.strictEqual(summary.warningCount, 0);
  assert.deepStrictEqual(summary.issues, []);

  const empty = validation.validateTopology([]);
  assert.strictEqual(empty.ok, true, 'an empty issue list is a healthy topology');
  assert.strictEqual(empty.errorCount, 0);
  assert.strictEqual(empty.warningCount, 0);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
