'use strict';
// The line a box prints when `channel-group` *builds* the bundle (#2245).
//
// A Catalyst answers the command that gives a group its first port with one sentence before anything else:
//
//   sw1(config-if)#channel-group 1 mode active
//   Creating a port-channel interface Port-channel 1
//
// and answers the second member with nothing but its own join. This console joined both members silently about
// creation, so the one observable that says "the interface now exists" - the thing `show running-config` and
// every table then name - was missing from the only command that produces it.
//
// Two details are load-bearing and both come from the transcripts rather than from a guess:
//   * Once per group, not once per member: Cisco doc 23408 prints two `channel-group 1 mode active` lines and
//     exactly one receipt, on the first.
//   * A space between the type and the number here, and nowhere else - the same page's syslog line and
//     `show ip interface brief` both spell the interface `Port-channel1`.
// research/channel-group-creating-receipt.md carries the sources, and the variance (a 12.1 2950 prints
// `Port-channel1` without the space) that made the wording a decision instead of a copy.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const lagLib = require('../engine/lag.ts');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
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
  return ((env.cli.run(cmd).output) || []).map(String);
}

// One port, one command: what the console answered, in order.
function join(env, port, args) {
  env.cli.run('interface ' + port);
  return say(env, 'channel-group ' + args);
}

const RECEIPT = /^Creating a port-channel interface Port-channel \d+$/;

console.log('\nOne sentence, built by the library that names the bundle:');
{
  ok(lagLib.createReceipt(1) === 'Creating a port-channel interface Port-channel 1',
    'the receipt is `Creating a port-channel interface Port-channel 1`', lagLib.createReceipt(1));
  ok(lagLib.createReceipt(1).indexOf(lagLib.portChannelIfaceName(1)) === -1,
    'and it is not the interface name with a prefix - the vendor puts a space in this sentence only',
    lagLib.portChannelIfaceName(1));
  ok(lagLib.portChannelIfaceName(1) === 'Port-channel1',
    'while the interface itself is spelled `Port-channel1`, as every table spells it');
}

console.log('\nThe first member builds the interface, and says so first:');
{
  const env = lab();
  const out = join(env, 'Fa0/1', '1 mode active');
  ok(out[0] === 'Creating a port-channel interface Port-channel 1',
    'the creation line comes before the join', JSON.stringify(out));
  ok(out[1] === 'Interface Fa0/1 added to channel group 1 (mode active)',
    'and the console keeps its own confirmation on the next line', JSON.stringify(out[1]));
  ok(out.filter(function (l) { return RECEIPT.test(l); }).length === 1,
    'the receipt is printed once, not twice');
}

console.log('\nThe second member finds the interface already there:');
{
  const env = lab();
  join(env, 'Fa0/1', '1 mode active');
  const out = join(env, 'Fa0/2', '1 mode active');
  ok(out.length === 1 && out[0] === 'Interface Fa0/2 added to channel group 1 (mode active)',
    'no receipt on the second join', JSON.stringify(out));
  ok(!out.some(function (l) { return RECEIPT.test(l); }), 'the same interface cannot be created twice');
}

console.log('\nA group number nobody has used gets its own receipt:');
{
  const env = lab();
  join(env, 'Fa0/1', '1 mode active');
  const out = join(env, 'Fa0/2', '2 mode on');
  ok(out[0] === 'Creating a port-channel interface Port-channel 2',
    'the number on the line is the group that was built', JSON.stringify(out));
}

console.log('\nA mode change on a live group builds nothing:');
{
  const env = lab();
  join(env, 'Fa0/1', '1 mode active');
  join(env, 'Fa0/2', '1 mode active');
  const out = join(env, 'Fa0/3', '1 mode passive');
  ok(!out.some(function (l) { return RECEIPT.test(l); }),
    'the third member joins an existing interface - no creation line', JSON.stringify(out));
  ok(/^Channel group 1 mode changed from active to passive/.test(out[0]),
    'and the mode-change sentence is still the first line', JSON.stringify(out[0]));
}

console.log('\nNothing that is refused prints a receipt:');
{
  const env = lab();
  const badId = join(env, 'Fa0/1', '4097 mode active');
  ok(badId.length === 1 && !RECEIPT.test(badId[0]), 'an id outside 1-4096 creates no bundle',
    JSON.stringify(badId));
  const badWord = join(env, 'Fa0/2', 'flurbish');
  ok(badWord.length === 1 && !RECEIPT.test(badWord[0]), 'a word where a number belongs creates nothing',
    JSON.stringify(badWord));
  const badMode = join(env, 'Fa0/3', '1 mode flurbish');
  ok(badMode.length === 1 && !RECEIPT.test(badMode[0]), 'an unknown mode creates nothing',
    JSON.stringify(badMode));
  ok(Object.keys(env.dev.config.lags || {}).length === 0, 'and the config holds no group at all',
    JSON.stringify(Object.keys(env.dev.config.lags || {})));
}

console.log('\nA full bundle refuses the ninth member without a receipt:');
{
  const env = lab(BIG);
  for (let i = 1; i <= 8; i++) join(env, 'Gi1/0/' + i, '1 mode on');
  const out = join(env, 'Gi1/0/9', '1 mode on');
  ok(out.length === 1 && !RECEIPT.test(out[0]), 'the refusal is one line and no creation', JSON.stringify(out));
}

console.log('\nA move that builds a new group prints the receipt for the new one:');
{
  const env = lab();
  join(env, 'Fa0/1', '2 mode active');
  const out = join(env, 'Fa0/1', '3 mode active');
  ok(out[0] === 'Creating a port-channel interface Port-channel 3',
    'the target group did not exist, so the box builds it', JSON.stringify(out));
  ok(/^Interface Fa0\/1 moved from channel group 2 to 3/.test(out[1]),
    'and the console still says where the port came from', JSON.stringify(out[1]));
}

console.log('\nEmptying a group and refilling it: this model deletes the bundle, so the receipt returns:');
{
  const env = lab();
  join(env, 'Fa0/1', '1 mode active');
  const removed = say(env, 'no channel-group 1');
  ok(/removed from channel group 1/.test(removed[0]), 'the last member takes the group with it',
    JSON.stringify(removed));
  const again = join(env, 'Fa0/1', '1 mode active');
  ok(again[0] === 'Creating a port-channel interface Port-channel 1',
    'and rebuilding it prints the creation line again', JSON.stringify(again));
  // A box keeps `interface Port-channel1` until `no interface port-channel 1`, so it would stay silent here.
  // This model has no bundle object apart from its members (research/port-channel-in-interface-brief.md,
  // item 8), and the removal sentence already says the group went with them.
}

console.log('\nThe line is a receipt, not configuration:');
{
  const env = lab();
  join(env, 'Fa0/1', '1 mode active');
  const cfg = say(env, 'show running-config').join('\n');
  ok(/\n? {2}channel-group 1 mode active/.test(cfg) || /channel-group 1 mode active/.test(cfg),
    'the join is in the running-config', cfg.split('\n').filter(function (l) { return /channel-group/.test(l); }).join(' | '));
  ok(cfg.indexOf('Creating') === -1, 'and the receipt is not');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
