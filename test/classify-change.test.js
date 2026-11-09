'use strict';

// The classifier decides whether CI spends five runner slots or two on a pull request.
// Getting it wrong in the "data" direction means a code change ships untested, so the
// tests here are about what must NOT count as data.

const { test } = require('node:test');
const assert = require('node:assert');
const { classify, isDataPath } = require('../scripts/classify-change');

test('device specs and docs are data', () => {
  for (const p of [
    'devices/cisco/catalyst-9200.json',
    'devices/ubiquiti/u7-pro.json',
    'docs/CI.md',
    'README.md',
    'research/incoming/devices-batch.json'
  ]) {
    assert.strictEqual(isDataPath(p), true, p + ' should be data');
  }
});

test('scripts, tests, workflows and server code are never data', () => {
  for (const p of [
    'scripts/import-devices.js',
    'test/catalog.test.js',
    '.forgejo/workflows/ci.yml',
    'server/index.js',
    'web/app.js',
    'engine/simulator.js',
    'package.json',
    'devices/registry.js',
    // A JSON file outside devices/ is not a device spec - it may be config the server reads.
    'config/server.json'
  ]) {
    assert.strictEqual(isDataPath(p), false, p + ' should be code');
  }
});

test('a mixed diff is a code change', () => {
  const r = classify(['devices/cisco/x.json', 'scripts/import-devices.js']);
  assert.strictEqual(r.data_only, false);
  assert.strictEqual(r.code, true);
});

test('a data-only diff is data', () => {
  const r = classify(['devices/cisco/x.json', 'docs/DEVICE_REGISTRY.md']);
  assert.strictEqual(r.data_only, true);
  assert.strictEqual(r.code, false);
});

test('an empty diff is not treated as safe', () => {
  const r = classify([]);
  assert.strictEqual(r.data_only, false, 'nothing to inspect must not mean nothing to verify');
  assert.strictEqual(r.code, true);
});

test('a nested file under devices/ that is not a spec is not data', () => {
  assert.strictEqual(isDataPath('devices/cisco/README.md'), false,
    'only <vendor>/<model>.json is a spec');
  assert.strictEqual(isDataPath('devices/registry.js'), false);
});
