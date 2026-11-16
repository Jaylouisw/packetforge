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

// `?` works at a prompt, and the note over `EXEC_WORDS` in engine/cli.js names the other place a complete table
// exists: the view word after `show`. At that position the key was answered as a typo -
//   Router# show ?
//   % Invalid show command: ?
// - while one word deeper the same question was already answered in full:
//   Router# show ip ?
//   % `show ip` needs a view. This console has: route, interface brief, ospf, ...
// So the operator unsure of the *first* word of a `show` line was told the key was invalid, and the one unsure of
// the second was handed the list. Both positions hold a complete table here (`SHOW_VIEW_WORDS`, and the `show ip`
// maps), which is the whole condition this console applies before it agrees to answer a question about what may
// stand somewhere - it is why `interface ?` and `speed ?` are still left alone.
//
// The list is derived from the table the dispatcher resolves against, so it cannot advertise a view `show` then
// refuses. Every row is a *completion of `show `* - `mac` and `power` are printed with the word they need, because
// a row of bare words would be advertising two commands this console refuses - so the whole list is pasteable, the
// same rule the views themselves are held to. `ip` and `ipv6` are words that take a view of their own and are on
// their own line rather than among the one-word views.
test('`?` after `show` answers with the views, not with an invalid command', () => {
  const { cli, run } = session();
  run('enable');
  const text = run('show ?');

  assert.doesNotMatch(text, /Invalid show command/, '`?` is the index key, not an invalid view');
  assert.match(text, /^Available `show` views/, 'it must answer with the views, got: ' + text.split('\n')[0]);

  // Every row the list prints, typed back exactly as printed.
  const FORMS = ['version', 'interfaces', 'running-config', 'vlan', 'spanning-tree', 'etherchannel',
    'lldp', 'access-lists', 'vrrp', 'arp', 'mac address-table', 'power inline'];
  for (const form of FORMS) {
    assert.ok(text.indexOf(form) !== -1, 'the listing must name `show ' + form + '`');
    assert.doesNotMatch(run('show ' + form), /Invalid show command/,
      '`show ' + form + '` is printed by the list and must be a view this console answers');
  }

  // The other spellings are named, and they are views too.
  const ALIASES = [['ver', 'version'], ['interface', 'interfaces'], ['run', 'running-config'],
    ['port-channel', 'etherchannel'], ['access-list', 'access-lists']];
  for (const pair of ALIASES) {
    assert.ok(text.indexOf(pair[0] + ' = ' + pair[1]) !== -1,
      'the listing must say `' + pair[0] + ' = ' + pair[1] + '`');
    assert.doesNotMatch(run('show ' + pair[0]), /Invalid show command/, '`show ' + pair[0] + '` is a view');
  }

  // The two words that take a view of their own are named, and both `?` doors answer.
  for (const holder of ['ip', 'ipv6']) {
    assert.ok(text.indexOf('`show ' + holder + ' ?`') !== -1, 'the listing points at `show ' + holder + ' ?`');
    assert.doesNotMatch(run('show ' + holder + ' ?'), /Invalid show command/,
      '`show ' + holder + ' ?` must answer with what may follow it');
  }
  assert.match(run('show ipv6 ?'), /\bnd\b/, 'and `show ipv6 ?` names its one view');

  assert.strictEqual(run('sh ?'), text, 'the shortened `show` asks the same question and gets the same answer');
  assert.strictEqual(run('show ?'), text, 'and the answer does not depend on what ran before it');
  assert.match(cli.prompt(), /#$/, 'asking for the list must not change the mode');

  // An unknown word is still an unknown word: the key is not a wildcard.
  assert.match(run('show flurbish'), /Invalid show command: flurbish/);
});
