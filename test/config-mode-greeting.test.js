'use strict';
// What a box says as it opens configuration mode.
//
// Every captured IOS session begins its config block with one sentence - `Enter configuration commands, one
// per line.  End with CNTL/Z.` - and this console opened the mode in silence. A reader comparing their own
// console against a Cisco transcript therefore found the first line missing, and the only sign of the mode
// change was the prompt, which is exactly what a paste of a saved config does not show.
//
// The sentence is one line and carries TWO spaces after "line.". That is the half no HTML page can settle -
// browsers collapse the run of spaces, and two of the vendor's own pages wrap the sentence across two lines
// in the rendered block. The text layer of the vendor's PDF (Catalyst 3560 Switch Command Reference
// 12.2(25)SEA, "Using the Command-Line Interface", set in Courier) keeps both: one baseline, two spaces.
// research/config-mode-greeting.md records the pages that disagree and why they are the rendering.
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
const ROUTER = catalog.filter(function (s) { return s.model === 'generic-router'; })[0];
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];

const GREETING = 'Enter configuration commands, one per line.  End with CNTL/Z.';

function lab(spec) {
  const t = new Topology();
  const d = t.addDevice(spec || ROUTER, 'r1');
  const s = new CliSession(d, t, new Simulator(t));
  s.run('enable');
  return {
    t: t, d: d, s: s,
    say: function (c) { return ((s.run(c).output) || []).map(String); }
  };
}

console.log('');
console.log('The sentence is the vendor\'s, character for character:');
{
  const env = lab();
  const out = env.say('configure terminal');
  ok(out.length === 1, 'one line, not two and not none', JSON.stringify(out));
  ok(out[0] === GREETING, 'the vendor sentence, exactly', JSON.stringify(out[0]));
  ok(out[0].indexOf('line.  End') !== -1, 'with the two spaces after "line." the PDF text layer preserves');
  ok(out[0].indexOf('\n') === -1, 'and no line break inside it');
  ok(env.s.prompt() === env.d.name + '(config)#', 'and the prompt that follows is config mode', env.s.prompt());
}

console.log('\nIt is the answer to the command that opens the mode, however that is spelled:');
{
  for (const spelling of ['conf t', 'config t', 'configure term', 'configure terminal']) {
    const env = lab();
    const out = env.say(spelling);
    ok(out.length === 1 && out[0] === GREETING, '`' + spelling + '` prints it once', JSON.stringify(out));
  }
}

console.log('\nIt is printed once per entry, not once per config command:');
{
  const env = lab();
  env.say('configure terminal');
  const inside = env.say('hostname core1');
  ok(inside.length === 0, 'a config-mode command prints no greeting of its own', JSON.stringify(inside));
  const sub = env.say('interface Gi0/0');
  ok(sub.length === 0, 'and neither does the submode it opens', JSON.stringify(sub));
  env.say('exit');
  const back = env.say('vlan 10');
  ok(back.indexOf(GREETING) === -1, 'nor `vlan <id>`, which prints only its own receipt', JSON.stringify(back));
  ok(back.length === 1 && /^VLAN 10 created/.test(back[0]), 'the receipt, and nothing before it', JSON.stringify(back));
}

console.log('\nA second entry prints it again, and `end` prints nothing:');
{
  const env = lab();
  env.say('configure terminal');
  const ended = env.say('end');
  ok(ended.length === 0, '`end` is silent', JSON.stringify(ended));
  ok(env.s.prompt() === env.d.name + '#', 'and returns to privileged EXEC', env.s.prompt());
  const again = env.say('configure terminal');
  ok(again.length === 1 && again[0] === GREETING, 're-entering prints the sentence again', JSON.stringify(again));
}

console.log('\nEntering no mode prints no greeting:');
{
  const env = lab();
  const incomplete = env.say('configure');
  ok(incomplete.length === 1 && /^% Incomplete command/.test(incomplete[0]),
    'a bare `configure` is still refused, with no greeting', JSON.stringify(incomplete));
  ok(env.s.prompt() === env.d.name + '#', 'and leaves the session in EXEC', env.s.prompt());
  const bad = env.say('configure memory');
  ok(bad.length === 1 && /^% /.test(bad[0]), '`configure memory` is refused, with no greeting', JSON.stringify(bad));
  ok(env.s.prompt() === env.d.name + '#', 'and still leaves the session in EXEC', env.s.prompt());
}

console.log('\nIt is the first line of a scripted transcript, under the echoed command:');
{
  const t = new Topology();
  const d = t.addDevice(SWITCH, 'sw1');
  const s = new CliSession(d, t, new Simulator(t));
  const host = d.name;
  const lines = [];
  for (const c of ['enable', 'configure terminal', 'hostname sw1']) {
    lines.push(s.prompt() + c);
    for (const l of (s.run(c).output || [])) lines.push(String(l));
  }
  const at = lines.indexOf(host + '#configure terminal');
  ok(at >= 0, 'the echoed command is in the transcript', JSON.stringify(lines));
  ok(lines[at + 1] === GREETING, 'the greeting sits directly under it', JSON.stringify(lines[at + 1]));
  ok(lines[at + 2] === host + '(config)#hostname sw1', 'and the next prompt is config mode', JSON.stringify(lines[at + 2]));
}

console.log('\n' + String(passed) + ' passed, ' + String(failed) + ' failed');
if (failed) process.exit(1);
