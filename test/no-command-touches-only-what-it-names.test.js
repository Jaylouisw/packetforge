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
    assert.match(stp, /Bridge priority 4096/, 'the priority must survive in `show spanning-tree`');
    const cfg = run('show running-config');
    assert.match(cfg, /spanning-tree priority 4096/, 'and in the config a backup would capture');
  }
});

test('no channel-group <id> removes that group, not the one the port is really in', () => {
  // The id was thrown away by the dispatcher: `no channel-group 9999` was answered as `no channel-group`, so a
  // technician who mistyped a bundle id removed the port from the bundle it was actually carrying traffic on
  // (#1510). A `no` that names a thing has to be a statement about that thing.
  const { run, dev } = lab('generic-switch');
  run('interface Fa0/1');
  run('channel-group 2 mode active');
  const before = JSON.stringify(dev.config.lags);

  const wrong = run('no channel-group 9999');
  assert.match(wrong, /Invalid channel group id/i, 'an id outside 1-4096 is refused, not acted on: ' + wrong);
  assert.strictEqual(JSON.stringify(dev.config.lags), before, 'and nothing changed');

  const other = run('no channel-group 5');
  assert.match(other, /not in channel group 5/i, 'a group the port is not in is named back: ' + other);
  assert.match(other, /it is in group 2/i, 'and so is the group it *is* in: ' + other);
  assert.strictEqual(JSON.stringify(dev.config.lags), before, 'still nothing changed');

  const right = run('no channel-group 2');
  assert.match(right, /removed from channel group 2/i, 'the named group is the one that goes: ' + right);
  assert.deepStrictEqual(Object.keys(dev.config.lags), [], 'and it is gone');
  assert.strictEqual(dev.interfaces.get('Fa0/1').lag, undefined, 'the port is out of the bundle');
});

test('the bundle table is ordered like a list of numbers', () => {
  const { run } = lab('generic-switch');
  // One port per bundle: a second `channel-group` on the same port is a move, not a second membership.
  const groups = [[100, 'Fa0/1'], [2, 'Fa0/2'], [10, 'Fa0/3']];
  for (const [id, port] of groups) {
    run('interface ' + port);
    run('channel-group ' + id + ' mode active');
  }
  const table = run('show etherchannel summary');
  const order = (table.match(/^(\d+)\s+LACP/gm) || []).map(function (line) {
    return Number(line.trim().split(/\s+/)[0]);
  });
  assert.deepStrictEqual(order, [2, 10, 100],
    'a technician reads the table as a list of bundle ids, not as sorted strings: ' + order.join(','));
});

test('a port is in exactly one bundle, so a second channel-group moves it', () => {
  // The engine used to add the port to the new group and leave it in the old one, so one cable appeared as a member
  // of every bundle it had ever been put in and `show etherchannel summary` listed it three times (#1510).
  const { run, dev } = lab('generic-switch');
  run('interface Fa0/1');
  run('channel-group 2 mode active');
  const moved = run('channel-group 10 mode active');
  assert.match(moved, /moved from channel group 2 to 10/i, 'the move has to be said out loud: ' + moved);
  assert.deepStrictEqual(Object.keys(dev.config.lags), ['10'], 'only the new bundle holds the port');
  assert.deepStrictEqual(dev.config.lags['10'].members, ['Fa0/1'], 'and it is in it once');

  const table = run('show etherchannel summary');
  const occurrences = (table.match(/Fa0\/1\(/g) || []).length;
  assert.strictEqual(occurrences, 1, 'one port appears in one bundle, not in every bundle it ever joined: ' + table);
});

test('the set form and the no form give the same answer to the same concept', () => {
  // `spanning-tree vlan 10` has its own answer - this model elects once, not per VLAN - and the `no` form called
  // the same concept an unknown word. Two answers to one question is how the split this file exists for starts up
  // again: the operator reads "unknown sub-command" and concludes the console has never heard of per-VLAN STP,
  // which is not what the other door says (#1509).
  const { run, dev } = lab('generic-switch');
  run('spanning-tree priority 4096');

  const set = run('spanning-tree vlan 10');
  assert.match(set, /not one per VLAN|one spanning tree, not one per VLAN/i, 'the set form explains the concept: ' + set);

  const no = run('no spanning-tree vlan 10');
  assert.match(no, /one spanning tree, not one per VLAN/i, 'and so must the `no` form: ' + no);
  assert.doesNotMatch(no, /unknown spanning-tree sub-command/i,
    'a real IOS concept is not an unknown word: ' + no);
  assert.match(no, /no spanning-tree priority/, 'and it has to name the removal that does exist: ' + no);
  assert.strictEqual(dev.config.stpPriority, 4096, 'neither answer may touch the bridge priority');
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
