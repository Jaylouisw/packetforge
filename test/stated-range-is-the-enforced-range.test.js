'use strict';

// Every refusal that prints a numeric range has to apply that same range.
//
// `channel-group 4097` was accepted and answered "Interface Fa0/1 added to channel group 4097
// (mode active)" while the refusal for a bad id said the range was `1-4096` — because the
// condition was `!/^\d+$/.test(id) || Number(id) < 1`, a lower bound only (#1505). The port
// and the group then existed in a state the console's own message says cannot exist, and every
// view that lists bundles printed it.
//
// The failure mode is quiet in both directions: a value one past the stated maximum that is
// accepted (state the help forbids), or a value on the stated edge that is refused (a promise
// the parser will not keep). So each case below probes four points — below, low, high, above —
// and requires refusal, acceptance, acceptance, refusal, in that order.
//
// The ranges are the ones this console prints in its own refusals and in `help`; this file is
// the reason they can be trusted rather than remembered.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { Topology, Simulator, CliSession } = require('../engine');
const { loadCatalog } = require('../devices/registry');

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(model) {
  const s = catalog.find(function (x) { return x.vendor === 'generic' && x.model === model; });
  if (!s) throw new Error('missing generic/' + model);
  return s;
}

function session(model) {
  const t = new Topology();
  const dev = t.addDevice(spec(model), 'd1');
  const sim = new Simulator(t);
  const cli = new CliSession(dev, t, sim);
  cli.run('enable');
  cli.run('configure terminal');
  return { dev: dev, cli: cli, run: function (c) { return cli.run(c).output.join('\n'); } };
}

function refused(out) {
  return /^\s*%/.test(String(out));
}

const CASES = [
  {
    label: 'vlan id (1-4094)',
    model: 'generic-switch',
    setup: [],
    cmd: function (v) { return 'vlan ' + v; },
    low: 1,
    high: 4094
  },
  {
    label: 'channel-group id (1-4096)',
    model: 'generic-switch',
    setup: ['interface Fa0/1'],
    cmd: function (v) { return 'channel-group ' + v + ' mode active'; },
    low: 1,
    high: 4096
  },
  {
    label: 'vrrp group id (1-255)',
    model: 'generic-router',
    setup: ['interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0'],
    cmd: function (v) { return 'vrrp ' + v + ' ip 10.0.0.254'; },
    low: 1,
    high: 255
  },
  {
    label: 'vrrp priority (1-255)',
    model: 'generic-router',
    setup: ['interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'vrrp 1 ip 10.0.0.254'],
    cmd: function (v) { return 'vrrp 1 priority ' + v; },
    low: 1,
    high: 255
  },
  {
    label: 'spanning-tree priority (0-61440)',
    model: 'generic-switch',
    setup: [],
    cmd: function (v) { return 'spanning-tree priority ' + v; },
    low: 0,
    high: 61440
  },
  {
    label: 'ipv6 nd ra lifetime (0-65535)',
    model: 'generic-router',
    setup: ['interface Gi0/0'],
    cmd: function (v) { return 'ipv6 nd ra lifetime ' + v; },
    low: 0,
    high: 65535
  },
  {
    label: 'ip ospf cost (1-65535)',
    model: 'generic-router',
    setup: ['ospf router-id 1.1.1.1', 'interface Gi0/0'],
    cmd: function (v) { return 'ip ospf cost ' + v; },
    low: 1,
    high: 65535
  },
  {
    label: 'ping count (1-50)',
    model: 'generic-router',
    setup: [],
    exec: true,
    cmd: function (v) { return 'ping 10.0.0.1 ' + v; },
    low: 1,
    high: 50
  }
];

for (const c of CASES) {
  test('the range in the refusal is the range in the check: ' + c.label, () => {
    const probes = [
      { where: 'below', value: c.low - 1, expect: 'refused' },
      { where: 'low', value: c.low, expect: 'accepted' },
      { where: 'high', value: c.high, expect: 'accepted' },
      { where: 'above', value: c.high + 1, expect: 'refused' }
    ];
    for (const p of probes) {
      if (p.value < 0) continue;
      const env = session(c.model);
      for (const s of c.setup) env.run(s);
      if (c.exec) env.run('end');
      const answer = env.run(c.cmd(p.value));
      const got = refused(answer) ? 'refused' : 'accepted';
      assert.strictEqual(got, p.expect,
        c.label + ': ' + p.where + ' (' + p.value + ') should be ' + p.expect + ', got ' + got +
        (answer ? ' - ' + answer.split('\n')[0] : ''));
    }
  });
}

test('a refused bundle id leaves nothing behind', () => {
  const env = session('generic-switch');
  env.run('interface Fa0/1');
  const answer = env.run('channel-group 4097 mode active');
  assert.ok(refused(answer), 'the id is outside the stated range: ' + answer);
  assert.match(answer, /1-4096/, 'and the refusal names the range it applied');
  assert.doesNotMatch(env.run('show etherchannel summary'), /4097/, 'no group 4097 exists');
  assert.strictEqual(Object.keys(env.dev.config.lags || {}).length, 0, 'and nothing was written to the config');
  assert.strictEqual(env.dev.interfaces.get('Fa0/1').lag, undefined, 'the port was not added to anything');
});

test('the edge itself still works, both ends', () => {
  const lowEdge = session('generic-switch');
  lowEdge.run('interface Fa0/1');
  assert.doesNotMatch(lowEdge.run('channel-group 1 mode active'), /^%/);
  assert.ok(lowEdge.dev.config.lags['1'], 'group 1 exists');

  const highEdge = session('generic-switch');
  highEdge.run('interface Fa0/1');
  assert.doesNotMatch(highEdge.run('channel-group 4096 mode active'), /^%/);
  assert.ok(highEdge.dev.config.lags['4096'], 'group 4096 exists');
});
