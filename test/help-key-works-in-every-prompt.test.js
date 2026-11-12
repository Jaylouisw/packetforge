'use strict';

// `?` is the key a technician presses when they are not sure, and the console answered it in
// two of the five prompts.
//
//   Router>?                        -> the whole index
//   Router#?                        -> the whole index
//   Router(config)#?                -> % Unrecognized config command: ?
//   Router(config-if)#?             -> % Unrecognized interface command: ?
//   Router(config-dhcp)#?           -> (fell through to the interface error path)
//
// So the one key that means "I do not know what I can type here" was reported as though the
// key itself were a mistake. The index already labels every row with the mode it belongs to
// (`(config mode)`, `(interface mode)`), so the same list is the right answer in all of them.
//
// The second half of this file is the ladder of `exit`. At `#` it did nothing at all: the
// prompt kept its `#`, and typing it again did not help, because exec and enable share one
// dispatcher and only `exit` at `>` was handled (as a no-op, since there is no login to
// leave). One level up from privileged EXEC is user EXEC, which this console always has
// underneath.

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
  return { cli: cli, run: function (cmd) { return cli.run(cmd).output.join('\n'); } };
}

function isIndex(text) {
  return /^Available commands:/.test(text) && /ping <address\|name>/.test(text);
}

const PROMPTS = [
  { label: 'user EXEC', setup: [], prompt: '>' },
  { label: 'privileged EXEC', setup: ['enable'], prompt: '#' },
  { label: 'config', setup: ['enable', 'configure terminal'], prompt: '(config)#' },
  { label: 'interface', setup: ['enable', 'configure terminal', 'interface Gi0/0'], prompt: '(config-if)#' },
  {
    label: 'dhcp pool',
    setup: ['enable', 'configure terminal', 'ip dhcp pool P1'],
    prompt: '(config-dhcp)#'
  }
];

for (const mode of PROMPTS) {
  test('`?` answers with the index at ' + mode.label, () => {
    const { cli, run } = session();
    for (const cmd of mode.setup) run(cmd);
    const prompt = cli.prompt();
    assert.ok(prompt.endsWith(mode.prompt), mode.label + ': expected a prompt ending ' + mode.prompt + ', got ' + prompt);

    const fromQuestion = run('?');
    assert.ok(isIndex(fromQuestion), mode.label + ': `?` must print the index, got: ' + fromQuestion.split('\n')[0]);
    assert.doesNotMatch(fromQuestion, /Unrecognized/, mode.label + ': `?` is a keypress, not a typo');

    const fromWord = run('help');
    assert.ok(isIndex(fromWord), mode.label + ': `help` must print the index too');

    assert.strictEqual(cli.prompt(), prompt, mode.label + ': asking for help must not change the prompt');
  });
}

test('help in a mode does not swallow the next command', () => {
  const { cli, run } = session();
  run('enable');
  run('configure terminal');
  run('?');
  run('hostname edge-1');
  assert.match(cli.prompt(), /^edge-1\(config\)#$/, 'the session is still in config mode, on the same device');
  assert.match(run('show running-config'), /hostname edge-1/);
});

test('a verb the console does not know is still reported in every mode', () => {
  const { run } = session();
  assert.match(run('flurbish'), /Unrecognized command: flurbish/);
  run('enable');
  run('configure terminal');
  assert.match(run('flurbish'), /Unrecognized config command: flurbish/);
  run('interface Gi0/0');
  assert.match(run('flurbish'), /Unrecognized/);
});

test('exit walks up the ladder, including out of privileged EXEC', () => {
  const { cli, run } = session();
  assert.match(cli.prompt(), />$/, 'setup: user EXEC');
  assert.match(cli.prompt(), />$/, '`exit` at `>` leaves you at `>`: there is no login to leave');
  run('enable');
  assert.match(cli.prompt(), /[^>]#$/, 'setup: privileged EXEC');

  run('exit');
  assert.match(cli.prompt(), />$/, '`exit` at `#` must drop to `>`');
  assert.doesNotMatch(cli.prompt(), /#$/, 'and not stay at `#`');

  run('enter-the-void');
  // still at `>`, and the unknown word is reported rather than the session moving
  assert.match(cli.prompt(), />$/);
});

test('the rest of the ladder still climbs down one level at a time', () => {
  const { cli, run } = session();
  run('enable');
  run('configure terminal');
  run('interface Gi0/0');
  assert.match(cli.prompt(), /\(config-if\)#$/);
  run('exit');
  assert.match(cli.prompt(), /\(config\)#$/, 'interface -> config');
  run('exit');
  assert.match(cli.prompt(), /[^>]#$/, 'config -> privileged EXEC, not user EXEC');
  run('exit');
  assert.match(cli.prompt(), />$/, 'privileged EXEC -> user EXEC');
});
