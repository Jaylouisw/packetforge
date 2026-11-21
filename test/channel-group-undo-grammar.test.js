'use strict';
// `no channel-group <id> mode on` is not a command: the undo takes the group number and stops.
//
// The vendor's syntax line is
//
//   channel-group channel-group-number mode { active | auto [non-silent] | desirable [non-silent] | on | passive }
//   no channel-group
//
// (Catalyst 2960-X Layer 2 Commands, 15.2(4)E - the `no` form carries no `mode` keyword), and a switch
// answers every word after the number with the parser's refusal. A 2022 CCNA transcript of the exact
// mistake is in the Cisco Community thread linked from the research note:
//
//   Switch(config-if)#no channel-group 1 mode on
//   % Invalid input detected at '^' marker.
//
// This console read the id and dropped the rest, so the line that a box refuses *removed the port from the
// bundle* and reported success - the same silent-accept defect `shutdown <word>` and `switchport mode <a>
// <b>` were fixed for (#1495, #2315). A refused line must leave the bundle exactly as it found it.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];

function say(env, cmd) {
  return ((env.cli.run(cmd).output) || []).map(String);
}

function members(env, id) {
  const l = env.dev.config.lags[id];
  return l && Array.isArray(l.members) ? l.members.slice() : [];
}

// Two switches, two cables, one bundle each: a member list that is genuinely carrying, so a refused line
// is judged against a live bundle rather than two ports with no cable in them.
function lab() {
  const t = new Topology();
  const a = t.addDevice(SWITCH, 'sw1');
  const b = t.addDevice(SWITCH, 'sw2');
  t.connect('sw1', 'Fa0/1', 'sw2', 'Fa0/1');
  t.connect('sw1', 'Fa0/2', 'sw2', 'Fa0/2');
  const sim = new Simulator(t);
  const cli = new CliSession(a, t, sim);
  const peer = new CliSession(b, t, sim);
  for (const s of [cli, peer]) {
    s.run('enable');
    s.run('configure terminal');
    for (const port of ['Fa0/1', 'Fa0/2']) {
      s.run('interface ' + port);
      s.run('channel-group 1 mode active');
    }
    s.run('end');
  }
  cli.run('configure terminal');
  cli.run('interface Fa0/1');
  return { t: t, dev: a, peer: b, cli: cli, peerCli: peer };
}

const EXTRA = /^% no channel-group takes the group number and nothing after it: the word "(.+)" was not used, and nothing was changed$/;

console.log('\nThe setting form\'s words are not part of the undo form:');
{
  const env = lab();
  const said = say(env, 'no channel-group 1 mode on');
  ok(said.length === 1 && EXTRA.test(said[0]), '`no channel-group 1 mode on` is refused in one line',
    JSON.stringify(said));
  ok((said[0].match(EXTRA) || [])[1] === 'mode on', 'and the line quotes the words it did not use', said[0]);
  ok(members(env, '1').length === 2 && members(env, '1').indexOf('Fa0/1') !== -1,
    'the port is still in the bundle', JSON.stringify(members(env, '1')));

  for (const tail of ['mode active', 'mode passive', 'flurbish']) {
    const out = say(env, 'no channel-group 1 ' + tail);
    ok(EXTRA.test(out[0] || '') && out[0].indexOf('"' + tail + '"') !== -1,
      '`no channel-group 1 ' + tail + '` is refused and names "' + tail + '"', JSON.stringify(out));
    ok(members(env, '1').length === 2, 'and leaves both members in place', JSON.stringify(members(env, '1')));
  }
}

console.log('\nThe refusal is a parse error, so it comes before any question about membership:');
{
  const env = lab();
  env.cli.run('interface Fa0/3');
  const out = say(env, 'no channel-group 1 mode on');
  ok(EXTRA.test(out[0] || ''), 'a port in no group gets the grammar sentence, not "is not in a channel group"',
    JSON.stringify(out));
  env.cli.run('interface Fa0/4');
  say(env, 'channel-group 2 mode active');
  const out2 = say(env, 'no channel-group 1 mode on');
  ok(EXTRA.test(out2[0] || ''), 'a port in another group gets the same sentence', JSON.stringify(out2));
  ok(members(env, '2').length === 1, 'and the group it is really in is untouched', JSON.stringify(members(env, '2')));
}

console.log('\nWhat is still accepted:');
{
  const env = lab();
  const removed = say(env, 'no channel-group 1');
  ok(/^Fa0\/1 removed from channel group 1/.test(removed[0] || ''), 'the numbered undo still removes the port',
    JSON.stringify(removed));
  ok(members(env, '1').indexOf('Fa0/1') === -1 && members(env, '1').indexOf('Fa0/2') !== -1,
    'and only that port', JSON.stringify(members(env, '1')));

  const bareEnv = lab();
  const bare = say(bareEnv, 'no channel-group');
  ok(/^Fa0\/1 removed from channel group 1/.test(bare[0] || ''), 'the bare form still removes the group the port is in',
    JSON.stringify(bare));
  ok(members(bareEnv, '1').indexOf('Fa0/1') === -1, 'and only that port', JSON.stringify(members(bareEnv, '1')));

  const notNumber = say(env, 'no channel-group mode on');
  ok(/^% Invalid channel group id "mode"/.test(notNumber[0] || ''),
    'a word where the id belongs is still refused as an id', JSON.stringify(notNumber));
}

console.log('\nAfter a refusal the session and the views still agree:');
{
  const env = lab();
  say(env, 'no channel-group 1 mode on');
  env.cli.run('end');
  const summary = say(env, 'show etherchannel summary').join('\n');
  const row = summary.split('\n').filter(function (l) { return /^1\s+Po1/.test(l); })[0] || '';
  ok(/Po1\(SU\)/.test(row) && /Fa0\/1\(P\)/.test(row) && /Fa0\/2\(P\)/.test(row),
    'the summary still shows both members bundled', row);
  const brief = say(env, 'show ip interface brief').filter(function (l) { return /^Port-channel1/.test(l); })[0] || '';
  ok(/up\s+up\s*$/.test(brief), 'and the brief still shows the bundle up', brief);
  env.cli.run('configure terminal');
  env.cli.run('interface Fa0/1');
  const again = say(env, 'no channel-group 1');
  ok(/^Fa0\/1 removed from channel group 1/.test(again[0] || ''),
    'the real undo still works in the same session', JSON.stringify(again));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
