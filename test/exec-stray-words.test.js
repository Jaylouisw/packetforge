'use strict';
// exec-stray-words.test.js - the exec verbs that change something and take no word.
//
//   R1#write memory zzzz   -> saved the startup-config, the word dropped
//   R1#enable zzzz         -> accepted in silence
//   R1#logout zzzz         -> logged out anyway
//   R1#clear arp zzzz      -> "% No interface named zzzz", a port that never existed
//
// The config blocks got this rule (a form of exactly this shape must be on the page) and the `show`
// family got an empirical one; the exec verbs are the third half of the console and had neither.
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

function lab(model, name) {
  const t = new Topology();
  const r = t.addDevice(find('generic-router')); r.name = 'R1';
  const sw = t.addDevice(find('generic-switch')); sw.name = 'SW1';
  const pc = t.addDevice(find('generic-pc')); pc.name = 'PC1';
  const ports = Array.from(sw.interfaces.values()).filter(function (i) { return !i.svi; }).map(function (i) { return i.name; });
  t.connect(r.id, 'Gi0/0', sw.id, ports[0]);
  t.connect(sw.id, ports[1], pc.id, Array.from(pc.interfaces.values())[0].name);
  const sim = new Simulator(t);
  const sr = new CliSession(r, t, sim); sr.run('enable'); sr.run('configure terminal');
  sr.run('interface Gi0/0'); sr.run('ip address 10.0.0.1 255.255.255.0'); sr.run('exit'); sr.run('end');
  const ss = new CliSession(sw, t, sim); ss.run('enable');
  const sp = new CliSession(pc, t, sim); sp.run('enable');
  sp.run('configure terminal'); sp.run('interface eth0');
  sp.run('ip address 10.0.0.10 255.255.255.0'); sp.run('exit'); sp.run('ip default-gateway 10.0.0.1'); sp.run('end');
  sp.run('ping 10.0.0.1 count 1');
  return { t: t, sim: sim, r: r, sw: sw, pc: pc, sr: sr, ss: ss, sp: sp };
}

console.log('A write with a word after it does not write:');
{
  const env = lab();
  const refused = text(env.sr.run('write memory zzzz'));
  ok(/% Unexpected argument "zzzz"/.test(refused), 'write memory zzzz is refused');
  ok(!/Saved startup-config/.test(refused), 'and it does not claim to have saved anything');
  ok(/No startup-config/.test(text(env.sr.run('show startup-config'))), 'nothing was written');
  ok(/Saved startup-config/.test(text(env.sr.run('write memory'))), 'write memory alone still saves');
}

console.log('\nThe verbs that take no word refuse one, and nothing happens:');
{
  const env = lab();
  ok(/% Unexpected argument "zzzz"/.test(text(env.sr.run('enable zzzz'))), 'enable zzzz is refused');
  ok(/% Unexpected argument "zzzz"/.test(text(env.sr.run('logout zzzz'))), 'logout zzzz is refused');
  ok(/% Unexpected argument "zzzz"/.test(text(env.sr.run('quit zzzz'))), 'quit zzzz is refused');
  ok(/% Unexpected argument "zzzz"/.test(text(env.sr.run('configure terminal zzzz'))),
    'configure terminal zzzz is refused');
  ok(/#$/.test(env.sr.prompt()), 'and the prompt did not move into config mode');
  // Either sentence is a refusal; what matters is that the word does not vanish and the table stays.
  ok(/^\s*%/m.test(text(env.sr.run('clear mac address-table zzzz'))),
    'clear mac address-table zzzz is refused');
}

console.log('\nA bare word after clear arp is not a port:');
{
  const env = lab();
  const bare = text(env.sr.run('clear arp zzzz'));
  ok(/No interface named zzzz/.test(bare), 'the word is refused as a port that is not there');
  ok(/is an address \("clear arp 10\.0\.0\.9"\) or a port/.test(bare),
    'and the answer names both spellings the word could have been');
  const port = text(env.sr.run('clear arp interface zzzz'));
  ok(/No interface named zzzz/.test(port), 'while a word after the literal "interface" is still a port');
  // An address is cleared, and the table says so.
  const cleared = text(env.sr.run('clear arp 10.0.0.10'));
  ok(!/is not an address/.test(cleared), 'an address after clear arp is read as one');
}

console.log('\nEvery argument-less exec row on every device refuses a stray word:');
{
  const env = lab();
  const bad = [];
  let checked = 0;
  for (const cli of [env.sr, env.ss, env.sp]) {
    const forms = cli._helpFormRowsAll(cli.mode) || [];
    const literal = forms.filter(function (f) {
      return f.tokens && f.tokens.every(function (t) { return typeof t === 'string'; });
    }).map(function (f) { return f.tokens.join(' '); });
    for (const line of literal) {
      // Ordinary control flow: leaving a mode is covered by its own suite, and `do` is the block
      // reader that wraps another command.
      if (/^(exit|end|disable|do)\b/.test(line)) continue;
      const answer = text(cli.run(line + ' zzzz'));
      checked += 1;
      const same = answer === text(cli.run(line));
      if (!/^\s*%/.test(answer) && same) bad.push(cli.device.name + ': "' + line + '"');
    }
  }
  ok(bad.length === 0, 'no exec command ignores a word after it' + (bad.length ? ': ' + bad.slice(0, 5).join('; ') : ''));
  ok(checked > 200, 'the sweep ran (' + checked + ' rows across three devices)');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
