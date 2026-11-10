'use strict';
// ignored-arguments.test.js - a word after a command that takes no words was dropped on the floor.
//
//   R1#show version zzzz              -> the version, as if nothing had been typed
//   R1#show interfaces Gi0/0 zzzz     -> the interface, the word dropped
//   R1#show ip nat translations zzzz  -> the table
//
// The console answered as though it had understood. The test is empirical: the answer is composed,
// then composed again without the trailing words; if they are identical *and* the position is not
// read at all (a nonsense word in that slot changes nothing either), the words were ignored.
//
// The other half of the rule is the help page: an argument the console does read must be listed, or
// the guard refuses a command the console supports (`show access-lists <name>` and
// `show etherchannel summary` were both supported and both undocumented).
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

function lab() {
  const t = new Topology();
  const r = t.addDevice(find('generic-router')); r.name = 'R1';
  const sw = t.addDevice(find('generic-switch')); sw.name = 'SW1';
  const pc = t.addDevice(find('generic-pc')); pc.name = 'PC1';
  const ports = Array.from(sw.interfaces.values()).filter(function (i) { return !i.svi; }).map(function (i) { return i.name; });
  t.connect(r.id, 'Gi0/0', sw.id, ports[0]);
  t.connect(sw.id, ports[1], pc.id, Array.from(pc.interfaces.values())[0].name);
  const sim = new Simulator(t);
  const sr = new CliSession(r, t, sim); sr.run('enable'); sr.run('configure terminal');
  sr.run('interface Gi0/0'); sr.run('ip address 10.0.0.1 255.255.255.0'); sr.run('exit');
  sr.run('ip nat inside source static 10.0.0.10 203.0.113.10'); sr.run('end');
  const ss = new CliSession(sw, t, sim); ss.run('enable');
  const sp = new CliSession(pc, t, sim); sp.run('enable');
  return { t: t, sim: sim, r: r, sw: sw, pc: pc, sr: sr, ss: ss, sp: sp };
}

console.log('A word the command does not take is refused, naming the command:');
{
  const env = lab();
  for (const line of ['show version zzzz', 'show clock zzzz', 'show ip nat translations zzzz',
    'show ip nat statistics zzzz', 'show startup-config zzzz']) {
    const body = text(env.sr.run(line));
    ok(/^% "zzzz" is not an argument to "/.test(body), line + ' is refused');
  }
  for (const line of ['show version', 'show clock', 'show ip nat translations']) {
    ok(/takes no argument here/.test(text(env.sr.run(line + ' zzzz'))),
      '"' + line + '" is told it takes none');
  }
  // The startup copy is the one that takes an argument - a port - so it is told the shape instead.
  ok(/written `show startup-config interface <port>`/.test(text(env.sr.run('show startup-config zzzz'))),
    'and "show startup-config" is told the shape of the port it does take');
  const body = text(env.sr.run('show version zzzz'));
  const named = (body.split('\n')[0].match(/to "([^"]+)"/) || [])[1];
  ok(named === 'show version', 'the refusal names the command it belongs to, not a section: ' + named);
  ok(!/\[object Object\]/.test(body), 'and no placeholder is rendered as a JavaScript object');
}

console.log('\nThe quoted command in that refusal works on the device that printed it:');
{
  const env = lab();
  const body = text(env.sr.run('show version zzzz'));
  const named = (body.split('\n')[0].match(/to "([^"]+)"/) || [])[1];
  const answer = text(env.sr.run(named));
  ok(!/^\s*%/.test(answer), 'typing it back answers, rather than refusing again: ' + answer.split('\n')[0]);
}

console.log('\nAn argument that narrows to everything is still an argument:');
{
  const env = lab();
  // One access list, so the name narrows to the whole table.
  env.sr.run('configure terminal'); env.sr.run('ip access-list extended TEST');
  env.sr.run('permit ip any any'); env.sr.run('exit'); env.sr.run('end');
  const named = text(env.sr.run('show access-lists TEST'));
  ok(!/^\s*%/.test(named), 'show access-lists TEST is answered, not refused');
  ok(/permit ip any any/.test(named), 'and it lists the entry');
  const missing = text(env.sr.run('show access-lists NOPE'));
  ok(/^\s*%/.test(missing), 'while a name that is not there is still refused');
  const vlan = text(env.ss.run('show vlan brief'));
  ok(!/^\s*%/.test(vlan), 'show vlan brief is answered');
  // This one answers with a `%` notice ("No link aggregation groups configured"), so the test is
  // that the word was read, not that the answer is free of refusal marks.
  const summary = text(env.ss.run('show etherchannel summary'));
  ok(!/is not an argument/.test(summary), 'show etherchannel summary is read as the summary view');
}

console.log('\nEvery argument the console reads is on the page:');
{
  const env = lab();
  for (const row of ['show access-lists [<name>]', 'show etherchannel [summary]']) {
    const page = env.sr.run('?').output.join('\n') + env.ss.run('?').output.join('\n');
    ok(page.indexOf(row) !== -1, 'the page lists "' + row + '"');
  }
}

console.log('\nEvery argument-less show row on every device refuses a stray word:');
{
  // The rows come from the page itself, so a view added later is covered without editing this list.
  const env = lab();
  const bad = [];
  let checked = 0;
  for (const cli of [env.sr, env.ss, env.sp]) {
    const forms = cli._helpFormRowsAll(2);
    const literal = forms.filter(function (f) {
      return f.tokens && f.tokens.every(function (t) { return typeof t === 'string'; });
    }).map(function (f) { return f.tokens.join(' '); })
      .filter(function (line) { return /^show\s/.test(line); });
    for (const line of literal) {
      // `show ip route zzzz` is the handler's own refusal (a destination that is not an address),
      // which is fine: the requirement is that the word does not vanish.
      const answer = text(cli.run(line + ' zzzz'));
      checked += 1;
      if (!/^\s*%/.test(answer) && answer === text(cli.run(line))) {
        bad.push(cli.device.name + ' "' + line + '"');
      }
    }
  }
  ok(bad.length === 0, 'no argument-less command ignores a trailing word'
    + (bad.length ? ': ' + bad.join('; ') : ''));
  ok(checked > 120, 'the sweep ran (' + checked + ' rows across three devices)');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
