'use strict';
// A pipe on a `show` line starts an output modifier; it is not a word of the name on its left.
//
// The vendor grammar is `command | {begin | include | exclude} regular-expression`, and the pipe "follows" the
// show command while the expression is "case sensitive" (Command Reference, IOS XE 17.12.x, Catalyst 9500,
// "Searching and Filtering Output of show and more Commands";
// http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9500/software/release/17-12/command_reference/b_1712_9500_cr/using_the_command_line_interface.html
// - the same section, verbatim, in the 2960-X 15.2(7)E and Catalyst 1000 books). So
// `show interfaces Fa0/1 | include packets` asks about port `Fa0/1` and filters the answer.
//
// This console read the whole rest of the line as a port name, so a command every operator types answered
// `% No interface Fa0/1 | include packets on Catalyst 2960-sw1` - a socket that is *in the answer above it* was
// reported missing, and the pipe, the one part of the line the console had not understood, was never mentioned.
// No output filter is modelled here and printing the unfiltered block as though it had been filtered would be
// worse than saying so, because a reader would trust lines a box had already discarded. What the console owes is
// the parse: name the command on the left, name the pipe as a modifier, and say the whole answer is the whole
// answer. Whether a `|` with no space around it (`show run|inc vlan`) *also* filters is a question of its own and
// is not asserted here.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
function eq(got, want, msg) {
  ok(got === want, msg, got === want ? '' : 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
// A Cambium cnMatrix: its ports are named `Port 1`, `Port 2`, ... So a port name really does contain a space on
// this box, which is why the "the name is the whole rest of the line" rule existed at all (#1401).
const SPACED = catalog.filter(function (s) { return s.model === 'EX2010-P'; })[0];
const ROUTER = catalog.filter(function (s) { return s.model === 'generic-router'; })[0];

function session(spec, id) {
  const topo = new Topology();
  topo.addDevice(spec, id);
  const dev = topo.getDevice(id);
  const cli = new CliSession(dev, topo, new Simulator(topo));
  cli.run('enable');
  return { cli: cli, dev: dev };
}
function lines(cli, cmd) {
  return (cli.run(cmd).output || []).map(String);
}

if (!SPACED || !ROUTER) {
  console.error('  \u2717 the catalogue no longer has an EX2010-P or a generic-router');
  failed++;
}

console.log('');
console.log('A pipe is an output modifier, not part of the port name:');
{
  const s = session(SPACED, 'sw1');
  const answer = lines(s.cli, 'show interfaces Port 1 | include packets');
  eq(answer.length, 1, 'one line, not the port block and not a filter menu');
  ok(answer[0].indexOf('`| include packets`') !== -1,
    'the refusal quotes the pipe and the expression as typed', answer[0]);
  ok(answer[0].indexOf('show interfaces Port 1') !== -1,
    'the command keeps the port name whole - including the space in `Port 1`', answer[0]);
  ok(answer[0].indexOf('output modifier') !== -1, 'it is called what a box calls it');
  ok(answer[0].indexOf('output filter') !== -1, 'and the missing capability is named');
  ok(!/No interface/.test(answer[0]),
    'no claim that `Port 1 | include packets` is a socket - that was the wrong lesson', answer[0]);
}

console.log('');
console.log('The port itself is untouched:');
{
  const s = session(SPACED, 'sw1');
  const block = lines(s.cli, 'show interfaces Port 1');
  ok(block.length > 1, 'the block still prints', String(block.length));
  ok(/^Port 1 \(/.test(block[0]), 'and still opens with the whole name', block[0]);
  ok(!/^%/.test(block[0]), 'no refusal', block[0]);
}

console.log('');
console.log('Every view is parsed the same way, at the door rather than in one of them:');
{
  const s = session(ROUTER, 'r1');
  const views = [
    'show ip route | include 10.',
    'show ip interface brief | exclude down',
    'show access-lists | begin permit',
    'show lldp neighbors | include Fa0'
  ];
  views.forEach(function (cmd) {
    const answer = lines(s.cli, cmd);
    eq(answer.length, 1, cmd + ' answers one line');
    ok(answer[0].indexOf('output modifier') !== -1, cmd + ' names the pipe', answer[0]);
    ok(answer[0].indexOf(cmd.split(' | ')[0]) !== -1, cmd + ' keeps the command on its left intact', answer[0]);
  });
}

console.log('');
console.log('A pipe word a box does not have is not called a filter:');
{
  const s = session(ROUTER, 'r1');
  const answer = lines(s.cli, 'show ip route | flurbish 10.');
  eq(answer.length, 1, 'one line');
  ok(/is not an output modifier/.test(answer[0]), 'the refusal says the word is not one', answer[0]);
  ['begin', 'include', 'exclude'].forEach(function (w) {
    ok(answer[0].indexOf('`' + w + '`') !== -1, 'and lists `' + w + '` as the ones a box does have', answer[0]);
  });
  ok(answer[0].indexOf('show ip route') !== -1, 'the command on the left is still named', answer[0]);
}

console.log('');
console.log('A pipe with nothing after it is incomplete, and `?` asks for the same list:');
{
  const s = session(ROUTER, 'r1');
  ['show ip route |', 'show ip route | ?'].forEach(function (cmd) {
    const answer = lines(s.cli, cmd);
    eq(answer.length, 1, cmd + ' answers one line');
    ok(/^% Incomplete command:/.test(answer[0]), cmd + ' says the line is incomplete, as a box does', answer[0]);
    ['begin', 'include', 'exclude'].forEach(function (w) {
      ok(answer[0].indexOf('`' + w + '`') !== -1, cmd + ' names `' + w + '`', answer[0]);
    });
  });
}

console.log('');
console.log('A pipe with no command before it:');
{
  const s = session(ROUTER, 'r1');
  const answer = lines(s.cli, 'show | include vlan');
  eq(answer.length, 1, 'one line');
  ok(/name a view before the pipe/.test(answer[0]), 'the refusal asks for the view', answer[0]);
  ok(answer[0].indexOf('output modifier') !== -1, 'and still calls the pipe what it is', answer[0]);
}

console.log('');
console.log('The filter word is a keyword, matched in any case:');
{
  const s = session(ROUTER, 'r1');
  ['show ip route | INCLUDE 10.', 'show ip route | Include 10.'].forEach(function (cmd) {
    const answer = lines(s.cli, cmd);
    ok(/output modifier, and this console has no output filter/.test(answer[0] || ''),
      cmd + ' is recognised as a filter', answer[0]);
    ok(!/is not an output modifier/.test(answer[0] || ''), cmd + ' is not called a bad word', answer[0]);
  });
}

console.log('');
console.log('The running-config door, which had its own sentence for this, answers the same way now:');
{
  const s = session(ROUTER, 'r1');
  const answer = lines(s.cli, 'show running-config | include vlan');
  eq(answer.length, 1, 'one line - the config is not printed as if it had been filtered');
  ok(answer[0].indexOf('output modifier') !== -1, 'called an output modifier', answer[0]);
  ok(answer[0].indexOf('show running-config') !== -1, 'the whole-config command is named', answer[0]);
}

console.log('');
console.log('Nothing else about `show` moved:');
{
  const s = session(ROUTER, 'r1');
  const help = lines(s.cli, 'show ip route ?');
  ok(help.length >= 1 && !/output modifier/.test(help.join('\n')), 'a trailing `?` is still the help key');
  const brief = lines(s.cli, 'show ip interface brief');
  ok(brief.length > 1 && !/^%/.test(brief[0]), '`show ip interface brief` still prints its table');
  const port = [...s.dev.interfaces.keys()].filter(function (n) {
    return !/^(mgmt|console|aux)/i.test(n);
  })[0];
  const counters = lines(s.cli, 'show interfaces ' + port + ' counters');
  ok(/^% `show interfaces /.test(counters[0] || '') && /view of /.test(counters[0] || ''),
    'a port followed by a *view* word is still answered as a view', counters[0]);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
