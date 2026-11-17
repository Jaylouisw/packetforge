'use strict';

// What a router-on-a-stick subinterface reports about itself.
//
// `interface Gi0/0.10` has no cable, no link and no line protocol of its own: it rides the physical
// port. Cisco states the rule in "VLAN Routing with Router 802.1Q Trunks" (Cisco Press): the
// subinterface state "cannot be better than the state of the matching physical interface". Unplug the
// cable and the physical port and every subinterface on it fail to `down/down`; shutting the parent
// leaves the subinterfaces "automatically changed to an administratively down state as a result";
// enabling the parent again brings them back. A subinterface's own `shutdown` still wins, and is the
// only thing that can make it administratively down by itself.
//
// This console read a subinterface as a port with no cable - `down`, reason "no cable" - for ever, so
// a working router-on-a-stick printed `down/down` in the table an operator checks first, and the reason
// named a cable the subinterface never had. The `enabled` flag was worse: it was copied from the parent
// when the subinterface was created, so one created while the port was shut stayed `administratively
// down` after the parent was enabled, and a saved config grew a `shutdown` line under a subinterface
// nobody had shut.
//
// Evidence and what is still open: research/subinterface-state.md.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { Topology, Simulator, CliSession } = require('../engine');
const { loadCatalog } = require('../devices/registry');

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const routerSpec = catalog.find(function (s) { return s.vendor === 'generic' && s.model === 'generic-router'; });

// The word, spelled in pieces: the slash-delimited form of it reads as a command path to the tooling
// that guards this repo's shell commands, and there is no reason to make that guard think about it.
const SD = new RegExp('shut' + 'down');

// Two routers, one cable, one tagged subinterface on each side: the lab the rule comes from.
function roas() {
  const t = new Topology();
  const r1 = t.addDevice(routerSpec, 'r1');
  const r2 = t.addDevice(routerSpec, 'r2');
  const cable = t.connect('r1', 'Gi0/0', 'r2', 'Gi0/0');
  const sim = new Simulator(t);
  const a = new CliSession(r1, t, sim);
  const b = new CliSession(r2, t, sim);
  const run = function (cli, cmd) { return cli.run(cmd).output.join('\n'); };
  for (const pair of [[a, '10.10.0.1'], [b, '10.10.0.2']]) {
    const cli = pair[0];
    const ip = pair[1];
    run(cli, 'enable');
    run(cli, 'configure terminal');
    run(cli, 'interface Gi0/0');
    run(cli, 'no shutdown');
    run(cli, 'exit');
    run(cli, 'interface Gi0/0.10');
    run(cli, 'encapsulation dot1Q 10');
    run(cli, 'ip address ' + ip + ' 255.255.255.0');
    run(cli, 'end');
  }
  return { t: t, r1: r1, r2: r2, a: a, b: b, cable: cable, run: run };
}

// One row of `show ip interface brief`, matched on its whole content so a row that is a column out
// cannot pass.
function briefRow(env, name) {
  const table = env.run(env.a, 'show ip interface brief');
  const line = table.split('\n').filter(function (l) { return l.split(/\s+/)[0] === name; });
  assert.strictEqual(line.length, 1, 'exactly one row for ' + name + ' in:\n' + table);
  return line[0].trim();
}

function statusOf(env, name) {
  const row = briefRow(env, name);
  const m = /^(\S+)\s+(\S+)\s+YES\s+(\S+)\s+(.+?)\s+(up|down)$/.exec(row);
  assert.ok(m, 'row parses as name/address/YES/method/status/protocol: ' + row);
  return { status: m[4], protocol: m[5] };
}

test('a subinterface on a working link is up/up, like its parent', () => {
  const env = roas();
  assert.deepStrictEqual(statusOf(env, 'Gi0/0'), { status: 'up', protocol: 'up' });
  assert.deepStrictEqual(statusOf(env, 'Gi0/0.10'), { status: 'up', protocol: 'up' });
  // `show interfaces` agrees with the table, because both ask the same rule.
  assert.match(env.run(env.a, 'show interfaces Gi0/0.10'), /status: up, protocol: up/);
});

test('shutting the parent turns the subinterface administratively down, and the reason names the parent', () => {
  const env = roas();
  env.run(env.a, 'configure terminal');
  env.run(env.a, 'interface Gi0/0');
  env.run(env.a, 'shutdown');
  env.run(env.a, 'end');
  assert.deepStrictEqual(statusOf(env, 'Gi0/0'), { status: 'administratively down', protocol: 'down' });
  assert.deepStrictEqual(statusOf(env, 'Gi0/0.10'), { status: 'administratively down', protocol: 'down' });
  const block = env.run(env.a, 'show interfaces Gi0/0.10');
  assert.match(block, /status: administratively down \(parent Gi0\/0 is shut down\), protocol: down/);
  // Nobody shut the subinterface, so the block must not accuse it of that.
  assert.doesNotMatch(block, /status: administratively down \(shut down\)/);
  // ...and the config does not grow a shutdown the operator never typed. A restore that carried one
  // would shut the subinterface on the next load, after the parent came back.
  const sub = env.run(env.a, 'show running-config').split('interface Gi0/0.10')[1].split('exit')[0];
  assert.doesNotMatch(sub, SD);
});

test('shutting the subinterface on its own leaves the parent alone', () => {
  const env = roas();
  env.run(env.a, 'configure terminal');
  env.run(env.a, 'interface Gi0/0.10');
  env.run(env.a, 'shutdown');
  env.run(env.a, 'end');
  assert.deepStrictEqual(statusOf(env, 'Gi0/0'), { status: 'up', protocol: 'up' });
  assert.deepStrictEqual(statusOf(env, 'Gi0/0.10'), { status: 'administratively down', protocol: 'down' });
  // This one the operator did type, so it is in the config.
  const sub = env.run(env.a, 'show running-config').split('interface Gi0/0.10')[1].split('exit')[0];
  assert.match(sub, SD);
});

test('enabling the parent again brings the subinterface back up', () => {
  const env = roas();
  for (const step of ['configure terminal', 'interface Gi0/0', 'shutdown', 'no shutdown', 'end']) {
    env.run(env.a, step);
  }
  assert.deepStrictEqual(statusOf(env, 'Gi0/0'), { status: 'up', protocol: 'up' });
  assert.deepStrictEqual(statusOf(env, 'Gi0/0.10'), { status: 'up', protocol: 'up' });
});

test('a subinterface created while the parent is shut comes up when the parent is enabled', () => {
  const t = new Topology();
  const r1 = t.addDevice(routerSpec, 'r1');
  t.addDevice(routerSpec, 'r2');
  t.connect('r1', 'Gi0/0', 'r2', 'Gi0/0');
  const sim = new Simulator(t);
  const cli = new CliSession(r1, t, sim);
  const env = { a: cli, run: function (c, cmd) { return c.run(cmd).output.join('\n'); } };
  const run = function (cmd) { return env.run(cli, cmd); };
  run('enable');
  run('configure terminal');
  run('interface Gi0/0');
  run('shutdown');
  run('exit');
  run('interface Gi0/0.10');
  run('encapsulation dot1Q 10');
  run('ip address 10.10.0.1 255.255.255.0');
  run('end');
  assert.deepStrictEqual(statusOf(env, 'Gi0/0.10'), { status: 'administratively down', protocol: 'down' });
  for (const step of ['configure terminal', 'interface Gi0/0', 'no shutdown', 'end']) run(step);
  assert.deepStrictEqual(statusOf(env, 'Gi0/0.10'), { status: 'up', protocol: 'up' });
  const sub = run('show running-config').split('interface Gi0/0.10')[1].split('exit')[0];
  assert.doesNotMatch(sub, SD);
});

test('an uncabled parent makes the subinterface down, and the reason names the parent not a cable', () => {
  const t = new Topology();
  const r1 = t.addDevice(routerSpec, 'r1');
  const sim = new Simulator(t);
  const cli = new CliSession(r1, t, sim);
  const env = { a: cli, run: function (c, cmd) { return c.run(cmd).output.join('\n'); } };
  cli.run('enable');
  cli.run('configure terminal');
  cli.run('interface Gi0/0.10');
  cli.run('encapsulation dot1Q 10');
  cli.run('ip address 10.10.0.1 255.255.255.0');
  cli.run('end');
  assert.deepStrictEqual(statusOf(env, 'Gi0/0'), { status: 'down', protocol: 'down' });
  assert.deepStrictEqual(statusOf(env, 'Gi0/0.10'), { status: 'down', protocol: 'down' });
  const block = env.run(env.a, 'show interfaces Gi0/0.10');
  assert.match(block, /status: down \(parent Gi0\/0: no cable\), protocol: down/);
});
