'use strict';

// What an IOS box prints inside a subinterface.
//
// `interface Gi0/0.10` is not the same mode as `interface Gi0/0`: the box calls a subinterface its own
// configuration mode and prompts `Router(config-subif)#`, while the physical port prompts
// `Router(config-if)#`. This console had one interface mode and printed `(config-if)#` for both, so a
// pasted router-on-a-stick transcript - the place subinterfaces exist - came back wearing a prompt no
// box prints. The evidence, and where the inference stops, is in research/subinterface-prompt.md.
//
// The rule is asked of the interface object the mode was entered on, not of the string that was typed,
// so nothing here depends on a dot in a name: what is held is that a subinterface answers
// `(config-subif)#`, that a physical port still answers `(config-if)#`, and that leaving and re-entering
// changes the prompt with the object under it.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { Topology, Simulator, CliSession } = require('../engine');
const { loadCatalog } = require('../devices/registry');

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const routerSpec = catalog.find(function (s) { return s.vendor === 'generic' && s.model === 'generic-router'; });

function session() {
  const t = new Topology();
  const dev = t.addDevice(routerSpec, 'r1');
  const sim = new Simulator(t);
  const cli = new CliSession(dev, t, sim);
  return {
    cli: cli,
    dev: dev,
    run: function (cmd) { return cli.run(cmd).output.join('\n'); },
    prompt: function () { return cli.prompt(); },
    base: function () { return dev.config.hostname || dev.hostname || dev.name; }
  };
}

// The prompt ladder of the transcript this rule comes from: config, a physical port, a subinterface.
function enter(env) {
  env.run('enable');
  env.run('configure terminal');
  env.run('hostname r1');
}

test('a subinterface prompts `(config-subif)#`, a physical port `(config-if)#`', () => {
  const env = session();
  enter(env);
  env.run('interface Gi0/0');
  assert.strictEqual(env.prompt(), env.base() + '(config-if)#',
    'the physical port is interface configuration mode');
  env.run('interface Gi0/0.10');
  assert.strictEqual(env.prompt(), env.base() + '(config-subif)#',
    'an IOS box prints Router(config-subif)# inside a subinterface');
});

test('the prompt names the hostname the operator set, and carries no space', () => {
  const env = session();
  enter(env);
  env.run('interface Gi0/0.10');
  assert.strictEqual(env.prompt(), 'r1(config-subif)#', 'the hostname, not the catalogue label');
  // A box writes the brace hard against the name; `r1 (config-subif)#` is a different string and makes a
  // pasted transcript unrecognisable.
  assert.match(env.prompt(), /\S\(config-subif\)#$/, 'prompt: ' + env.prompt());
});

test('going from one subinterface to another keeps the subinterface prompt', () => {
  const env = session();
  enter(env);
  env.run('interface Gi0/0.10');
  env.run('encapsulation dot1q 10');
  // The transcript that settles this runs `interface GigabitEthernet0/0.11` straight from the
  // `(config-subif)#` of Gi0/0.10 and lands in another `(config-subif)#`.
  env.run('interface Gi0/0.11');
  assert.strictEqual(env.prompt(), 'r1(config-subif)#', 'Gi0/0.11 is a subinterface too');
});

test('the prompt follows the interface entered, not the mode it was entered from', () => {
  const env = session();
  enter(env);
  env.run('interface Gi0/0.10');
  // Same transcript: `interface GigabitEthernet0/1` from a subinterface lands in `(config-if)#`.
  const out = env.run('interface Gi0/1');
  assert.strictEqual(out, '', 'a plain port needs no announcement: ' + out);
  assert.strictEqual(env.prompt(), 'r1(config-if)#', 'Gi0/1 is a physical port');
});

test('re-entering an existing subinterface by name still prompts `(config-subif)#`', () => {
  const env = session();
  enter(env);
  env.run('interface Gi0/0.10');
  env.run('exit');
  assert.strictEqual(env.prompt(), 'r1(config)#', 'exit leaves the subinterface for config mode');
  const out = env.run('interface Gi0/0.10');
  assert.strictEqual(out, '', 'the subinterface already exists, so nothing is created: ' + out);
  assert.strictEqual(env.prompt(), 'r1(config-subif)#', 'the object is still a subinterface');
  assert.strictEqual(env.dev.subinterfacesOf('Gi0/0').length, 1, 'and there is still exactly one of it');
});

test('the subinterface is still an interface mode: its config lands and `end` leaves', () => {
  const env = session();
  enter(env);
  env.run('interface Gi0/0.10');
  const ip = env.run('ip address 10.0.0.1 255.255.255.0');
  assert.match(ip, /IP address set on Gi0\/0\.10/, 'the address is accepted inside the subinterface: ' + ip);
  const run = env.run('show running-config');
  assert.match(run, /interface GigabitEthernet0\/0\.10/, 'the subinterface is in the config');
  assert.match(run, /ip address 10\.0\.0\.1/, 'with its address');
  env.run('end');
  assert.strictEqual(env.prompt(), 'r1#', 'end reaches enable mode from a subinterface');
});

test('no prompt in the ladder has drifted back to the `(config-<mode>)#` shape', () => {
  const env = session();
  const seen = [];
  seen.push(env.prompt());
  env.run('enable');
  seen.push(env.prompt());
  env.run('configure terminal');
  seen.push(env.prompt());
  env.run('interface Gi0/2');
  seen.push(env.prompt());
  env.run('interface Gi0/2.20');
  seen.push(env.prompt());
  env.run('exit');
  seen.push(env.prompt());
  env.run('ip dhcp pool LAN');
  seen.push(env.prompt());
  assert.deepStrictEqual(seen, [
    env.base() + '>',
    env.base() + '#',
    env.base() + '(config)#',
    env.base() + '(config-if)#',
    env.base() + '(config-subif)#',
    env.base() + '(config)#',
    env.base() + '(dhcp-config)#'
  ], 'the prompt ladder, in the order a session walks it');
});
