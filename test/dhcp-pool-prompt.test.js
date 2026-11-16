'use strict';

// What an IOS box prints inside DHCP pool configuration mode.
//
// The prompt this console printed was `Router(config-dhcp)#` - the same `(config-<thing>)#` shape as
// `(config-if)#`, which is a plausible guess and not what a box says. An IOS router prints
// `Router(dhcp-config)#`: the words in the other order, and no other sub-mode here does that.
//
// The evidence, and why it is a majority rather than a certainty, is in research/dhcp-pool-prompt.md:
// three Cisco configuration guides print the prompt inside session captures, and every operator paste
// found uses the same spelling, while one command-reference sentence and the CBS350 CLI guide (a
// different operating system) spell it `(config-dhcp)#`.
//
// Three things are held here: the prompt itself, that the mode still behaves as a pool after the
// rename, and that no prompt in the ladder has drifted back to the `(config-<mode>)#` shape.

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
    run: function (cmd) { return cli.run(cmd).output.join('\n'); },
    prompt: function () { return cli.prompt(); },
    // The prompt's prefix rule, read off the device rather than assumed: a catalogue device that was
    // never renamed carries `device.hostname` (an allocation name, not the host the reader is at).
    base: function () { return dev.config.hostname || dev.hostname || dev.name; }
  };
}

function enterPool(env) {
  env.run('enable');
  env.run('configure terminal');
  env.run('ip dhcp pool LAN');
}

test('DHCP pool mode prompts `(dhcp-config)#`, in that order', () => {
  const env = session();
  enterPool(env);
  assert.strictEqual(env.prompt(), env.base() + '(dhcp-config)#',
    'an IOS box prints Router(dhcp-config)#, not Router(config-dhcp)#');
});

test('the prompt carries no space between the hostname and the mode', () => {
  const env = session();
  enterPool(env);
  // A box writes `Router(dhcp-config)#` with the brace hard against the name; `Router (dhcp-config)#`
  // is a different string and would make a pasted transcript unrecognisable.
  assert.match(env.prompt(), /\S\(dhcp-config\)#$/, 'prompt: ' + env.prompt());
  assert.doesNotMatch(env.prompt(), / /, 'the prompt has a space in it: ' + env.prompt());
});

test('the prompt follows the hostname, not the model', () => {
  const env = session();
  env.run('enable');
  env.run('configure terminal');
  env.run('hostname edge-1');
  env.run('ip dhcp pool LAN');
  assert.strictEqual(env.prompt(), 'edge-1(dhcp-config)#');
});

test('pool commands still work after the rename, and `exit` walks back to config', () => {
  const env = session();
  enterPool(env);
  const net = env.run('network 10.0.0.0 255.255.255.0');
  assert.doesNotMatch(net, /Unrecognized|Invalid input/, 'network refused inside the pool: ' + net);
  const router = env.run('default-router 10.0.0.1');
  assert.doesNotMatch(router, /Unrecognized|Invalid input/, 'default-router refused: ' + router);
  // The rename is a word in a prompt, not a mode: the mode must still be the pool.
  assert.strictEqual(env.prompt(), env.base() + '(dhcp-config)#', 'a pool command must not leave the sub-mode');
  env.run('exit');
  assert.strictEqual(env.prompt(), env.base() + '(config)#', 'exit from a pool returns to global config');
  const config = env.run('show running-config');
  assert.match(config, /ip dhcp pool LAN/, 'the pool survived the round trip');
});

test('`end` from a pool reaches privileged EXEC', () => {
  const env = session();
  enterPool(env);
  env.run('end');
  assert.strictEqual(env.prompt(), env.base() + '#');
});

test('no prompt in the ladder spells a sub-mode the `(config-<mode>)#` way', () => {
  // The guess that produced `(config-dhcp)#` would produce `(config-ospf)#`, `(config-bgp)#` and so on
  // for any mode added later. Only the interface sub-mode has that shape in IOS, so the ladder is
  // asserted whole rather than one prompt at a time.
  const env = session();
  const seen = [];
  seen.push(env.prompt());
  env.run('enable'); seen.push(env.prompt());
  env.run('configure terminal'); seen.push(env.prompt());
  env.run('interface Gi0/0'); seen.push(env.prompt());
  env.run('exit'); seen.push(env.prompt());
  env.run('ip dhcp pool P2'); seen.push(env.prompt());
  const prefixed = seen.filter(function (p) { return /\(config-[a-z-]+\)#$/.test(p); });
  assert.deepStrictEqual(prefixed, [env.base() + '(config-if)#'],
    'the interface prompt is the only one IOS spells `(config-<mode>)#`: ' + JSON.stringify(prefixed));
  const b = env.base();
  assert.deepStrictEqual(seen, [
    b + '>', b + '#', b + '(config)#', b + '(config-if)#', b + '(config)#', b + '(dhcp-config)#'
  ], JSON.stringify(seen));
});
