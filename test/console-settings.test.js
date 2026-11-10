'use strict';
// console-settings.test.js - terminal length/width are words, and the console says what they do.
//
//   R1#terminal length 0
//   % Unrecognized command: terminal length 0
//   R1#show terminal
//   % Invalid show command: terminal
//
// `terminal length 0` is the first line of half the pasted transcripts on the internet, and `show
// terminal` is the question "what is this session set to". Neither existed. There is no pager here -
// every line a view prints is printed - so the honest thing is to take the setting, keep it, report it,
// and say plainly that it changes nothing anybody can see.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function text(out) { return out && out.output ? out.output.join('\n') : String(out); }
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const find = function (m) { return catalog.filter(function (x) { return x.model === m; })[0]; };
function box(model, name) {
  const t = new Topology();
  const d = t.addDevice(find(model)); d.name = name;
  const s = new CliSession(d, t, new Simulator(t));
  s.run('enable');
  return { t: t, d: d, s: s };
}

console.log('A console setting is a word, not a typo:');
{
  const env = box('generic-router', 'R1');
  const len = text(env.s.run('terminal length 0'));
  ok(/Console length set to 0/.test(len), 'terminal length 0 is taken');
  ok(/no pager, every line is printed/.test(len), 'and says what 0 means here');
  const width = text(env.s.run('terminal width 132'));
  ok(/Console width set to 132 columns/.test(width), 'terminal width 132 is taken');
  ok(!/Unrecognized/.test(len + width), 'nothing calls either one unrecognized');
}

console.log('\nThe setting is kept and reported:');
{
  const env = box('generic-router', 'R1');
  ok(/Terminal length\s+0 \(default\)/.test(text(env.s.run('show terminal'))),
    'a fresh session reports the default length');
  env.s.run('terminal length 24');
  env.s.run('terminal width 100');
  const body = text(env.s.run('show terminal'));
  ok(/Terminal length\s+24/.test(body), 'show terminal reports the length that was set');
  ok(/Terminal width\s+100/.test(body), 'and the width');
  ok(/Pager\s+none/.test(body), 'and that there is no pager');
  ok(/privileged exec/.test(body), 'and which exec level this session is at');
}

console.log('\nA number outside the range is refused with the range:');
{
  const env = box('generic-router', 'R1');
  const hi = text(env.s.run('terminal length 9999'));
  ok(/outside 0-512/.test(hi), 'length 9999 is outside its range');
  ok(/Usage: terminal length/.test(hi), 'and the usage line names the range');
  const lo = text(env.s.run('terminal width 10'));
  ok(/outside 40-512/.test(lo), 'width 10 is outside its range');
  const word = text(env.s.run('terminal length many'));
  ok(/takes a number/.test(word), 'a word where the number goes is named');
  const none = text(env.s.run('terminal'));
  ok(/Incomplete command/.test(none), 'terminal on its own asks for the rest');
  const bad = text(env.s.run('terminal colour blue'));
  ok(/no "terminal colour"/.test(bad), 'a setting this console does not have is refused by name');
  ok(/length and width/.test(bad), 'and the two it does have are named');
  const extra = text(env.s.run('terminal length 24 zzzz'));
  ok(/zzzz|takes no more|Unexpected/i.test(extra), 'a word after the number is refused, not dropped');
}

console.log('\nThe command belongs to exec, and says so from a block:');
{
  const env = box('generic-router', 'R1');
  env.s.run('configure terminal');
  const body = text(env.s.run('terminal length 0'));
  ok(/exec command, not a configuration command/.test(body), 'in config mode it is named as an exec command');
  ok(/"end"/.test(body), 'and the way back to exec is named');
  env.s.run('end');
  ok(/\(config\)#/.test(env.s.prompt()) === false, 'the prompt is back at exec');
}

console.log('\nA "#" line is a comment in a different language:');
{
  const env = box('generic-router', 'R1');
  const body = text(env.s.run('# just a note'));
  ok(/Unrecognized command/.test(body), 'it is still a command to this console');
  ok(/comment line starts with "!"/.test(body), 'and the refusal says which mark a comment uses');
  ok(!/^%/.test(text(env.s.run('! just a note'))), 'while "!" is silent, as a comment should be');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
