'use strict';

// A `no` that names one thing must not remove a different one.
//
// `no spanning-tree portfast` used to clear the bridge priority. The `no` branch never read the
// word after `spanning-tree`: it answered every `no spanning-tree <anything>` by clearing
// `config.stpPriority`, so a port-level command with no priority in it wiped a setting the
// operator had made, and `no spanning-tree flurbish` - a word that appears nowhere - did the
// same. The message said "Bridge priority cleared (was 4096)", so the operator was told what
// happened but not that it was the wrong thing: they asked to remove portfast.
//
// The set form was fixed in #1493 by reading the verb before its value. This is the same defect
// pointing the other way, and it is destructive, because a `no` is the only undo a technician
// has - an undo that removes something else is worse than one that refuses.
//
// Two smaller untruths are pinned here for the same reason, both found by typing the commands
// rather than reading them:
//
//   - `help` promised `speed auto|forced <mbps>`. `_speed()` has never had a `forced` keyword;
//     it parses `auto` or a rate, and its own usage line says `speed auto | <mbps>`. A
//     documented spelling the parser refuses is worse than a missing one.
//   - `no ip access-group` with nothing applied answered `% No an access list applied in or out
//     on Gi0/0` - no grammar, no subject, and it read as if something had been removed.

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

function lab(model) {
  const t = new Topology();
  const dev = t.addDevice(spec(model), 'd1');
  const sim = new Simulator(t);
  const cli = new CliSession(dev, t, sim);
  const run = function (cmd) { return cli.run(cmd).output.join('\n'); };
  run('enable');
  run('configure terminal');
  return { t: t, dev: dev, cli: cli, run: run };
}

test('no spanning-tree <other thing> leaves the bridge priority alone', () => {
  const words = ['portfast', 'cost', 'bpduguard', 'flurbish'];
  for (const word of words) {
    const { run, dev } = lab('generic-switch');
    run('spanning-tree priority 4096');
    assert.strictEqual(dev.config.stpPriority, 4096, 'setup: the priority must be set');

    const answer = run('no spanning-tree ' + word);
    assert.strictEqual(dev.config.stpPriority, 4096,
      '`no spanning-tree ' + word + '` must not touch the bridge priority');
    assert.match(answer, new RegExp(word), 'the refusal has to name the word that was asked: ' + answer);
    assert.doesNotMatch(answer, /cleared/i, 'nothing was cleared, so nothing may say cleared: ' + answer);
    assert.match(answer, /spanning-tree priority/, 'and it has to name the tunable that does exist: ' + answer);

    // The second door agrees with the first: a view, not the state object.
    const stp = run('show spanning-tree');
    assert.match(stp, /[(]priority 4096 sys-id-ext 1[)]/, 'the priority must survive in `show spanning-tree`');
    const cfg = run('show running-config');
    assert.match(cfg, /spanning-tree priority 4096/, 'and in the config a backup would capture');
  }
});

test('no spanning-tree portfast is refused as unmodelled, not as unknown', () => {
  const { run } = lab('generic-switch');
  const modelled = run('no spanning-tree portfast');
  assert.match(modelled, /not modelled/, 'portfast is a real IOS command this device does not model');
  assert.match(modelled, /nothing to remove/, 'and the answer has to say why there is nothing to undo');
});

test('the forms that really clear the priority still do', () => {
  for (const form of ['no spanning-tree', 'no spanning-tree priority']) {
    const { run, dev } = lab('generic-switch');
    run('spanning-tree priority 8192');
    const answer = run(form);
    assert.strictEqual(dev.config.stpPriority, null, '`' + form + '` must clear the priority');
    assert.match(answer, /cleared \(was 8192\)/, 'and say what it removed: ' + answer);
  }
});

test('nothing set is answered as nothing set, not as a removal', () => {
  const { run } = lab('generic-switch');
  const answer = run('no spanning-tree');
  assert.match(answer, /No bridge priority set/, answer);
  assert.doesNotMatch(answer, /cleared/i, answer);
});

test('help does not promise a speed form the parser refuses', () => {
  const { run } = lab('generic-router');
  run('end'); // `help` is an exec-mode index; config mode does not have it
  const help = run('help');
  assert.doesNotMatch(help, /speed auto\|forced/, 'the `forced` spelling has never been accepted');
  assert.match(help, /speed auto\|<mbps>/, 'help has to show the form `_speed()` implements');
});

test('the documented speed spellings are the accepted ones', () => {
  const { run } = lab('generic-router');
  run('interface Gi0/0');
  assert.match(run('speed 100'), /^Speed 100M on/, 'a rate is a rate');
  assert.match(run('speed auto'), /^Speed auto-negotiation/, 'and `auto` clears it');
  const forced = run('speed forced 100');
  assert.match(forced, /^%/, '`forced` is not a keyword here');
  assert.match(forced, /a number of Mbps or auto/, 'the refusal has to name what it does take: ' + forced);
});

test('no ip access-group says which list, or that none is applied', () => {
  const { run, dev } = lab('generic-router');
  run('interface Gi0/0');

  const bare = run('no ip access-group');
  assert.doesNotMatch(bare, /No an /, 'the old wording was ungrammatical: ' + bare);
  assert.match(bare, /No access list applied in or out on Gi0\/0/, bare);

  const numbered = run('no ip access-group 101 in');
  assert.match(numbered, /No access list 101 applied in on Gi0\/0/, numbered);

  // And the case that does remove something still names the direction it removed.
  run('exit');
  run('access-list 101 permit ip any any');
  run('interface Gi0/0');
  assert.match(run('ip access-group 101 in'), /applied/i, 'setup: the list must bind');
  const removed = run('no ip access-group');
  assert.match(removed, /unapplied in$/, 'the removal names the direction it took off: ' + removed);
  assert.ok(!dev.aclBindings || !dev.aclBindings['Gi0/0'] || !dev.aclBindings['Gi0/0'].in,
    'and the binding is actually gone');
});

// ---------------------------------------------------------------------------
// The same defect, in the bundle handler: `no channel-group <id>` threw the id
// away, so it removed the port from whatever group the port was really in.
// ---------------------------------------------------------------------------

function lagLab() {
  const L = lab('generic-switch');
  L.run('interface Fa0/1');
  return L;
}

test('no channel-group <id> does not remove the port from a different group', () => {
  const { run, dev } = lagLab();
  assert.match(run('channel-group 2 mode active'), /added to channel group 2/, 'setup: the port must join');
  assert.ok((dev.config.lags['2'].members || []).indexOf('Fa0/1') !== -1, 'setup: membership is recorded');

  // An id outside the range the console itself states is refused as an id, not acted on.
  const outOfRange = run('no channel-group 9999');
  assert.match(outOfRange, /^% /, 'a refused id is a refusal: ' + outOfRange);
  assert.match(outOfRange, /1-4096/, 'and it states the range it applied: ' + outOfRange);
  assert.ok(dev.config.lags['2'] && dev.config.lags['2'].members.indexOf('Fa0/1') !== -1,
    'the out-of-range id must not touch group 2: ' + JSON.stringify(dev.config.lags));

  // An id in range but not this port's group is refused, and the answer names the group the port is in.
  const wrongGroup = run('no channel-group 5');
  assert.match(wrongGroup, /not in channel group 5/, 'the refusal names the id that was asked for: ' + wrongGroup);
  assert.match(wrongGroup, /in group 2/, 'and the group the port is actually in: ' + wrongGroup);
  assert.ok(dev.config.lags['2'] && dev.config.lags['2'].members.indexOf('Fa0/1') !== -1,
    'the wrong-group `no` must leave group 2 alone: ' + JSON.stringify(dev.config.lags));

  // The id that is really the port's group still works, and says which group it left.
  const right = run('no channel-group 2');
  assert.match(right, /removed from channel group 2/, 'the named group is the one removed: ' + right);
  assert.ok(!dev.config.lags['2'], 'and the emptied group is gone: ' + JSON.stringify(dev.config.lags));
});

test('a bare no channel-group still means "whatever it is in"', () => {
  const { run, dev } = lagLab();
  run('channel-group 7 mode active');
  const answer = run('no channel-group');
  assert.match(answer, /removed from channel group 7/, 'the bare form removes the group the port is in: ' + answer);
  assert.ok(!dev.config.lags['7'], 'and the group is gone: ' + JSON.stringify(dev.config.lags));
});

test('a second channel-group moves the port instead of adding it to another group', () => {
  const { run, dev } = lagLab();
  run('channel-group 2 mode active');
  const moved = run('channel-group 10 mode on');
  assert.match(moved, /moved from channel group 2 to 10/, 'the move is announced: ' + moved);
  assert.match(moved, /\(mode on\)/, 'with the mode the port now runs: ' + moved);
  assert.deepStrictEqual(Object.keys(dev.config.lags), ['10'], 'the port is in exactly one bundle: ' +
    JSON.stringify(dev.config.lags));
  assert.deepStrictEqual(dev.config.lags['10'].members, ['Fa0/1'], 'and it is a member of the new one');
});

test('the bundle table is ordered by number, not as strings', () => {
  const { run } = lagLab();
  for (const [port, id] of [['Fa0/1', 10], ['Fa0/2', 100], ['Fa0/3', 2]]) {
    if (port !== 'Fa0/1') run('interface ' + port);
    run('channel-group ' + id + ' mode active');
  }
  run('end');
  const summary = run('show etherchannel summary');
  const order = summary.split('\n')
    .map(function (l) { return /^(\d+)\s+Po\d+\(S[UD]\)\s+(LACP|-)/.exec(l); })
    .filter(Boolean)
    .map(function (m) { return Number(m[1]); });
  assert.deepStrictEqual(order, [2, 10, 100], 'the groups read 2, 10, 100: ' + summary);
});

// ---------------------------------------------------------------------------
// The same word, asked in both directions, has to get the same answer.
//
// `spanning-tree vlan 10` explains that this device runs one tree and names the command that does exist.
// `no spanning-tree vlan 10` called `vlan` an *unknown* sub-command, which tells an operator the console has
// never heard of per-VLAN spanning tree - not what the other door says, and not true: per-VLAN STP is a real
// IOS concept this model deliberately does not have (#1509). #1501 taught the `no` branch the unmodelled
// *verbs*; `vlan` is the one sub-command that is not a verb, and it stayed in the set branch only.
// ---------------------------------------------------------------------------

test('the set and no directions agree about per-VLAN spanning tree', () => {
  const { run, dev } = lab('generic-switch');
  run('spanning-tree priority 4096');
  assert.strictEqual(dev.config.stpPriority, 4096, 'setup: the priority must be set');

  for (const form of ['spanning-tree vlan 10', 'no spanning-tree vlan 10']) {
    const answer = run(form);
    assert.match(answer, /one spanning tree, not one per VLAN/,
      '`' + form + '` has to say why the concept is not here: ' + answer);
    assert.doesNotMatch(answer, /unknown/i,
      'vlan is a real IOS word, so neither direction may call it unknown - `' + form + '` said: ' + answer);
    assert.match(answer, /spanning-tree priority/,
      'and each direction has to name the command that does exist - `' + form + '` said: ' + answer);
    assert.strictEqual(dev.config.stpPriority, 4096,
      '`' + form + '` asks about a tree this device does not have, so it must not remove the priority');
  }
});
