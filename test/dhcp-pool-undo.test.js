'use strict';
// A DHCP pool's leaves are removable one at a time, and say so (#1279).
//
// The parent level was fixed in #1278 (`no ip dhcp pool`). One level down, inside the pool, `no` was a
// branch with no words in it:
//
//   no network     missing entirely              -> "% Unrecognized DHCP pool command"
//   no host <addr> missing entirely              -> "% Unrecognized DHCP pool command"
//   no range       deleted, then reported as an *error* by the exit-time validation, so a deletion the
//                  operator asked for read like one the device refused
//   everything else  deleted silently - no message whether or not anything was there, which makes
//                    "it worked" and "there was nothing to do" the same output
//   no excluded-address 10.5.0.5   cleared the whole list, including 10.5.0.6 - how a box starts handing
//                  out an address that was reserved for a printer
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.filter(function (s) { return /ASR 1001-X/.test(s.model); })[0];

function fresh() {
  const t = new Topology();
  const d = t.addDevice(ROUTER, 'r1');
  return { t: t, d: d, sim: new Simulator(t) };
}

function config(env) {
  return (((new CliSession(env.d, env.t, env.sim).run('show running-config').output) || [])
    .map(String)).join('\n');
}

function apply(env, cmds) {
  const out = runCommands(env.d, env.t, env.sim, ['configure terminal'].concat(cmds).concat(['end']));
  // Each line arrives with the console prompt in front of it ("r1(config-dhcp)#Network cleared..."). Strip
  // the prompt rather than slicing from the first interesting word, which used to cut the message in half
  // and make every assertion read as a mismatch.
  return ((out && out.lines) || []).map(String).map(function (l) {
    const cut = Math.max(l.lastIndexOf('#'), l.lastIndexOf('>'));
    return cut >= 0 ? l.slice(cut + 1).trim() : l.trim();
  }).filter(function (l) {
    return l && /%|cleared|removed|Reservation|incomplete/.test(l) && !/config\)#/.test(l);
  });
}

const FULL_POOL = [
  'ip dhcp pool P1',
  'network 10.5.0.0 255.255.255.0',
  'range 10.5.0.10 10.5.0.200',
  'default-router 10.5.0.1',
  'dns-server 10.5.0.2',
  'lease 2',
  'excluded-address 10.5.0.5',
  'excluded-address 10.5.0.6',
  'host 10.5.0.50 02:00:00:00:00:50'
];

function withPool() {
  // One session: `ip dhcp pool P1` and its leaves have to be typed in the same sub-mode, so they cannot be
  // split across two calls that each end with `end`.
  const env = fresh();
  const errors = apply(env, FULL_POOL);
  ok(errors.filter(function (m) { return /^%/.test(m); }).length === 0, 'the full pool is accepted',
    JSON.stringify(errors));
  return env;
}

console.log('');
console.log('Each leaf can be removed on its own:');
{
  const leaves = [
    ['network', ['no network'], 'network 10.5.0.0', 'Network cleared'],
    ['default-router', ['no default-router'], 'default-router 10.5.0.1', 'Default router cleared'],
    ['dns-server', ['no dns-server'], 'dns-server 10.5.0.2', 'DNS servers cleared'],
    ['range', ['no range'], 'range 10.5.0.10', 'Range cleared'],
    ['lease', ['no lease'], 'lease', 'Lease cleared']
  ];
  for (const [name, neg, lineFragment, expectMsg] of leaves) {
    const env = withPool();
    const before = config(env);
    ok(before.indexOf(lineFragment) !== -1, name + ': printed before the deletion');
    const msgs = apply(env, ['ip dhcp pool P1'].concat(neg));
    ok(msgs.some(function (m) { return m.indexOf(expectMsg) === 0; }),
      name + ': says what it removed', JSON.stringify(msgs));
    const after = config(env);
    ok(after.indexOf(lineFragment) === -1, name + ': and the line is gone',
      after.split('\n').filter(function (l) { return l.indexOf('  ') === 0; }).join(' | '));
    // Everything else still there.
    const others = leaves.filter(function (x) { return x[0] !== name; });
    ok(others.every(function (x) { return after.indexOf(x[2]) !== -1; }), name + ': nothing else is removed');
  }
}

console.log('');
console.log('Removing one excluded address leaves the others:');
{
  const env = withPool();
  const msgs = apply(env, ['ip dhcp pool P1', 'no excluded-address 10.5.0.5']);
  const after = config(env);
  ok(/10\.5\.0\.5/.test(msgs.join(' ')), 'the address removed is named', JSON.stringify(msgs));
  // Checked as an excluded-address line, not as a substring: the pool also holds the reservation
  // `host 10.5.0.50`, and "10.5.0.5" is inside it.
  const exclusions = after.split(String.fromCharCode(10)).filter(function (l) {
    return /excluded-address/.test(l);
  });
  ok(!exclusions.some(function (l) { return / 10\.5\.0\.5$/.test(l.trim()); }),
    'and it is gone from the config', exclusions.join(' | '));
  ok(exclusions.some(function (l) { return / 10\.5\.0\.6$/.test(l.trim()); }),
    'while the other exclusion is untouched',
    after.split('\n').filter(function (l) { return /excluded/.test(l); }).join(' | '));

  const msgs2 = apply(env, ['ip dhcp pool P1', 'no excluded-address']);
  ok(msgs2.some(function (m) { return /\(1\)/.test(m); }), 'the unqualified form clears the rest and counts',
    JSON.stringify(msgs2));
  ok(config(env).indexOf('excluded-address') === -1, 'and no exclusion is left');
}

console.log('');
console.log('A reservation can be removed by address or by MAC:');
{
  for (const form of ['no host 10.5.0.50', 'no host 02:00:00:00:00:50']) {
    const env = withPool();
    const msgs = apply(env, ['ip dhcp pool P1', form]);
    ok(msgs.some(function (m) { return /Reservation removed/.test(m); }), form + ': is accepted',
      JSON.stringify(msgs));
    ok(config(env).indexOf('host 10.5.0.50') === -1, form + ': and the reservation is gone');
  }
  const env = withPool();
  const msgs = apply(env, ['ip dhcp pool P1', 'no host 10.5.0.99']);
  ok(msgs.some(function (m) { return /^% No reservation/.test(m); }), 'an address with no reservation refuses',
    JSON.stringify(msgs));
  ok(config(env).indexOf('host 10.5.0.50') !== -1, 'and the real one survives');
}

console.log('');
console.log('Removing what is not there refuses and names the pool and the leaf:');
{
  const env = fresh();
  apply(env, ['ip dhcp pool P2', 'network 10.6.0.0 255.255.255.0', 'range 10.6.0.10 10.6.0.20']);
  for (const [neg, expect] of [
    ['no default-router', /No default-router in pool P2/],
    ['no dns-server', /No dns-server in pool P2/],
    ['no lease', /No lease in pool P2/],
    ['no excluded-address', /No excluded addresses in pool P2/]
  ]) {
    const msgs = apply(env, ['ip dhcp pool P2', neg]);
    ok(msgs.some(function (m) { return expect.test(m); }), neg + ': refuses, naming the pool',
      JSON.stringify(msgs));
  }
  ok(config(env).indexOf('network 10.6.0.0') !== -1, 'and the pool itself is untouched');
}

console.log('');
console.log('Deleting the range leaves the pool incomplete, and says that - not that it failed:');
{
  const env = withPool();
  const msgs = apply(env, ['ip dhcp pool P1', 'no range']);
  const verdict = msgs.filter(function (m) { return /incomplete/.test(m); })[0] || '';
  ok(/Pool P1 is incomplete/.test(verdict), 'the message is about the pool', JSON.stringify(msgs));
  ok(!/E_DHCP_BAD_RANGE: DHCP pool/.test(verdict), 'not a bare error code that reads like a rejection',
    verdict);
  ok(config(env).indexOf('range 10.5.0.10') === -1, 'the range really is gone');
}

console.log('');
console.log('Taken apart one leaf at a time, the pool comes back to a bare pool:');
{
  const full = withPool();
  const fullText = config(full);

  const bare = fresh();
  apply(bare, ['ip dhcp pool P1', 'network 10.5.0.0 255.255.255.0', 'range 10.5.0.10 10.5.0.200']);
  const bareText = config(bare);

  // Strip the leaves from the full pool, one command each.
  const stripped = fresh();
  apply(stripped, FULL_POOL);
  for (const neg of ['no default-router', 'no dns-server', 'no lease', 'no excluded-address',
    'no host 10.5.0.50']) {
    apply(stripped, ['ip dhcp pool P1', neg]);
  }
  ok(config(stripped) === bareText, 'and the result is byte-identical to a pool built without them',
    config(stripped) === bareText ? '' : JSON.stringify({
      full: fullText.split('\n').filter(function (l) { return /^ /.test(l); }),
      got: config(stripped).split('\n').filter(function (l) { return /^ /.test(l); })
    }));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
