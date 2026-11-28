'use strict';
// Retyping `channel-group` on a port that is already in that group is not a join (#1675).
//
// The join receipt was unconditional once the line got past the refusals, so every port said "added" - a port
// that had just joined, a port that had been in the group all along, and a port that stayed in it while the
// group's mode changed:
//
//   sw1(config-if)#channel-group 1 mode active
//   Interface Fa0/2 added to channel group 1 (mode active)     <-- joined: true
//   sw1(config-if)#channel-group 1 mode active
//   Interface Fa0/2 added to channel group 1 (mode active)     <-- nothing changed: false
//   sw1(config-if)#channel-group 1 mode on
//   Channel group 1 mode changed from active to on for every member: Fa0/1
//   Interface Fa0/2 added to channel group 1 (mode on)         <-- stayed put: false
//
// Three different outcomes, one sentence, and the sentence named the one that did not happen. It is the line an
// operator repeats after pasting a port's configuration, and the receipt is what they read to confirm which
// bundle the port ended up in - so "added" on a line that changed nothing is the same lie the VLAN door told
// when `vlan 20` announced a creation over a VLAN that existed (test/vlan-rename-is-not-a-create.test.js).
//
// Nothing else moves: a real join still says "added", a port that changes group still says "moved", the mode
// change still names itself first, and `show running-config` / `show etherchannel summary` are untouched.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const lagLib = require('../engine/lag.ts');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  ok   ' + msg); }
  else { failed++; console.error('  FAIL ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];
const BIG = catalog.filter(function (s) { return s.model === 'C2960X-48FPS-L'; })[0];

function lab(spec) {
  const t = new Topology();
  const dev = t.addDevice(spec || SWITCH, 'sw1');
  const cli = new CliSession(dev, t, new Simulator(t));
  cli.run('enable');
  cli.run('configure terminal');
  return { t: t, dev: dev, cli: cli };
}

function say(env, cmd) {
  return ((env.cli.run(cmd).output) || []).map(String)
    .filter(function (l) { return l && !/^sw1/.test(l) && !/^Enter configuration/.test(l); });
}

function join(env, port, args) {
  env.cli.run('interface ' + port);
  return say(env, 'channel-group ' + args);
}

const JOINED = /^Interface \S+ added to channel group \d+ \(mode \w+\)$/;
const ALREADY = /^Interface (\S+) is already in channel group (\d+) \(mode (\w+)\), so nothing was added$/;
const STAYS = /^Interface (\S+) stays in channel group (\d+) \(mode (\w+)\), it was already a member$/;

console.log("\nA real join keeps its sentence:");
{
  const env = lab();
  const out = join(env, 'Fa0/1', '1 mode active');
  ok(out.length === 2 && /^Creating a port-channel interface Port-channel 1$/.test(out[0]),
    'the first member still builds the bundle', JSON.stringify(out));
  ok(out[1] === 'Interface Fa0/1 added to channel group 1 (mode active)',
    'and is still reported as added', JSON.stringify(out[1]));
}

console.log("\nThe same line typed twice adds nothing, and no longer says it did:");
{
  const env = lab();
  join(env, 'Fa0/1', '1 mode active');
  join(env, 'Fa0/2', '1 mode active');
  const before = say(env, 'show running-config').join('\n');
  const out = join(env, 'Fa0/1', '1 mode active');
  ok(out.length === 1, 'one sentence, not two', JSON.stringify(out));
  ok(ALREADY.test(out[0]), 'it says the port is already there', JSON.stringify(out[0]));
  const m = ALREADY.exec(out[0] || '');
  ok(!!m && m[1] === 'Fa0/1' && m[2] === '1' && m[3] === 'active',
    'naming the port, the group and the mode it is in', JSON.stringify(m && m.slice(1)));
  ok(!out.some(function (l) { return /added to channel group/.test(l); }),
    'and it never uses the word "added" for it', JSON.stringify(out));
  ok(say(env, 'show running-config').join('\n') === before,
    'the repeated line writes nothing to the running-config');
  const summary = say(env, 'show etherchannel summary').join('\n');
  ok((summary.match(/Fa0\/1\(/g) || []).length === 1,
    'and the port appears in the bundle once, not twice', summary.split('\n').slice(-4).join(' | '));
  ok(env.dev.config.lags['1'].members.length === 2,
    'the group still holds two members', JSON.stringify(env.dev.config.lags['1'].members));
}

console.log("\nA mode change on a member keeps the port where it is:");
{
  const env = lab();
  join(env, 'Fa0/1', '1 mode active');
  join(env, 'Fa0/2', '1 mode active');
  const out = join(env, 'Fa0/2', '1 mode on');
  ok(/^Channel group 1 mode changed from active to on for every member: Fa0\/1$/.test(out[0]),
    'the mode-change sentence still comes first, naming the other member', JSON.stringify(out));
  ok(STAYS.test(out[1] || ''), 'and the port is said to stay, not to join', JSON.stringify(out[1]));
  const m = STAYS.exec(out[1] || '');
  ok(!!m && m[1] === 'Fa0/2' && m[2] === '1' && m[3] === 'on',
    'naming the port, the group and the mode it now carries', JSON.stringify(m && m.slice(1)));
  ok(!out.some(function (l) { return /added to channel group/.test(l); }),
    'the word "added" is gone from a line that added nothing', JSON.stringify(out));
  ok(env.dev.config.lags['1'].members.length === 2 && env.dev.config.lags['1'].mode === 'static',
    'the group holds the same two members, in the mode that was typed',
    JSON.stringify([env.dev.config.lags['1'].mode, env.dev.config.lags['1'].members]));
}

console.log("\nThe three outcomes are still three sentences:");
{
  const env = lab();
  join(env, 'Fa0/1', '1 mode active');
  join(env, 'Fa0/2', '1 mode active');
  const joinOut = join(env, 'Fa0/3', '1 mode active');
  ok(joinOut.length === 1 && JOINED.test(joinOut[0]) && /Fa0\/3/.test(joinOut[0]),
    'a new member: added', JSON.stringify(joinOut));
  const retypeOut = join(env, 'Fa0/3', '1 mode active');
  ok(ALREADY.test(retypeOut[0] || ''), 'the same member again: already in', JSON.stringify(retypeOut));
  const moveOut = join(env, 'Fa0/3', '2 mode active');
  ok(/^Creating a port-channel interface Port-channel 2$/.test(moveOut[0]) &&
     /^Interface Fa0\/3 moved from channel group 1 to 2 \(mode active\)$/.test(moveOut[1]),
    'the same member into another group: moved, and the new bundle is built', JSON.stringify(moveOut));
  ok(moveOut.every(function (l) { return !ALREADY.test(l) && !JOINED.test(l); }),
    'a move is never spelled as a join or as a no-op', JSON.stringify(moveOut));
}

console.log("\nA no-op on a member of a full group is not a cap refusal:");
{
  const env = lab(BIG);
  for (let i = 1; i <= 8; i++) join(env, 'Gi1/0/' + i, '1 mode on');
  const out = join(env, 'Gi1/0/8', '1 mode on');
  ok(out.length === 1 && ALREADY.test(out[0] || ''),
    'the eighth member retyping its own line gets the no-op sentence, not "already holds 8 members"',
    JSON.stringify(out));
  ok(!out.some(function (l) { return /^%/.test(l); }), 'and no refusal at all', JSON.stringify(out));
}

console.log(String.fromCharCode(10) + 'A no-op on a hot-standby member answers once:');
{
  const env = lab(BIG);
  let joined = [];
  for (let i = 1; i <= 9; i++) joined = join(env, 'Gi1/0/' + i, '1 mode active');
  ok(joined.some(function (l) { return /hot-standby/.test(l); }),
    'setup: the ninth member is told it is hot-standby when it joins', JSON.stringify(joined));
  const out = join(env, 'Gi1/0/9', '1 mode active');
  ok(out.length === 1 && ALREADY.test(out[0] || ''),
    'retyping it repeats no news: the flag belongs to the summary, not to a line that changed nothing',
    JSON.stringify(out));
  const summary = say(env, 'show etherchannel summary').join(String.fromCharCode(10));
  const listed = summary.split('Gi1/0/9(D)').length - 1;
  ok(listed >= 1, 'and the summary still lists it among the nine', String(listed));
}

console.log("\nEmptying and refilling still builds the bundle again:");
{
  const env = lab();
  join(env, 'Fa0/1', '1 mode active');
  const removed = say(env, 'no channel-group 1');
  ok(/removed from channel group 1/.test(removed[0] || ''), 'the last member takes the group',
    JSON.stringify(removed));
  const out = join(env, 'Fa0/1', '1 mode active');
  ok(/^Creating a port-channel interface Port-channel 1$/.test(out[0] || '') && JOINED.test(out[1] || ''),
    'and re-joining builds it and says added', JSON.stringify(out));
  ok(lagLib.maxMembers('static') === 8 && lagLib.MAX_ACTIVE_LINKS === 8,
    'the numbers this test leans on come from the library');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
