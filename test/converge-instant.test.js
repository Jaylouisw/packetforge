'use strict';
// `converge at <ms>` — the form the console itself printed, and refused to honour.
//
// `help` has advertised `converge [at <ms>]` for as long as the command has existed, and `_converge()` read
// `Number(tokens[0])` and nothing else. So the advertised spelling was not refused - it was answered as if no
// instant had been named. `Number('at')` is `NaN`, `NaN` failed the `e.readyAtMs > atMs` comparison, and every
// row lost its `(pending)` mark: an operator who typed the spelling the console printed was told the lab was
// converged when it was not. Silently answering a different question than the one asked is worse than a
// refusal, because there is nothing to notice.
//
// `link <up|down> <id> at <ms>` has parsed `at` since #1049, so `converge` takes the same grammar and the same
// message for the same mistake. What is left over after the instant is refused by name rather than ignored -
// `converge 1000 wibble` used to answer `converge 1000` and drop the word, which is how the `at` form survived
// unnoticed for so long.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { loadCatalog } = require('../devices/registry');
const cliModule = require('../engine/cli');
const CliSession = cliModule.CliSession || cliModule;

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const ROOT = path.join(__dirname, '..');
const specs = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
const R = specs.find(function (s) { return /ISR 4331/.test(s.model); });

// Two routers with OSPF over the link between them: the hello/exchange/SPF run puts `ospf` ready at 16000 ms,
// so there is a real window (before 16 s) in which the answer must say `(pending)`.
function lab() {
  const t = new Topology();
  t.addDevice(R, 'r1'); t.addDevice(R, 'r2');
  t.connect('r1', 'Gi0/0/0', 'r2', 'Gi0/0/0', { mediaId: '1000base-t', speedMbps: 1000 });
  const r1 = t.getDevice('r1'), r2 = t.getDevice('r2');
  r1.interfaces.get('Gi0/0/0').ip = '10.0.0.1'; r1.interfaces.get('Gi0/0/0').mask = '255.255.255.0';
  r2.interfaces.get('Gi0/0/0').ip = '10.0.0.2'; r2.interfaces.get('Gi0/0/0').mask = '255.255.255.0';
  const sim = new Simulator(t);
  const s = new CliSession(r1, t, sim);
  s.run('enable'); s.run('configure terminal');
  s.run('ospf router-id 1.1.1.1');
  s.run('interface Gi0/0/0'); s.run('ip ospf area 0'); s.run('exit'); s.run('end');
  return { topo: t, sim: sim, s: s };
}
function say(s, cmd) {
  return (s.run(cmd).output || []).map(String);
}
function body(lines) {
  return lines.filter(function (l) { return /^(ospf|stp|bgp|vrrp|change)\s/.test(l); });
}

console.log('');
console.log('The advertised `at` spelling asks the question it appears to ask:');
{
  const a = lab();
  const bare = say(a.s, 'converge 1000');
  const withAt = say(a.s, 'converge at 1000');
  ok(bare.some(function (l) { return /\(pending\)/.test(l); }),
    'converge 1000 marks the process that is not ready yet', JSON.stringify(body(bare)));
  ok(withAt.some(function (l) { return /\(pending\)/.test(l); }),
    'and converge at 1000 prints the same row, not the converged answer', JSON.stringify(body(withAt)));
  ok(JSON.stringify(body(withAt)) === JSON.stringify(body(bare)),
    'the two spellings are one command with one answer',
    JSON.stringify({ at: body(withAt), bare: body(bare) }));
  const later = say(a.s, 'converge at 20000');
  ok(later.length && !later.some(function (l) { return /\(pending\)/.test(l); }),
    'past the last process, the same spelling prints no pending row', JSON.stringify(body(later)));

  // A trailing word used to be dropped. It is named now, the way `ping` names one (#1379).
  const stray = say(a.s, 'converge 1000 wibble');
  ok(stray.length === 1 && /^% Unrecognized "wibble"/.test(stray[0]),
    'a word after the instant is refused, by name', JSON.stringify(stray));
  ok(/converge/.test(stray[0]) && /at/.test(stray[0]),
    'and the refusal prints the syntax that works', stray[0]);

  // Every malformed instant is refused, and none of them is answered as "no instant".
  const bad = [
    ['converge at', /Invalid instant: "at" needs a time/],
    ['converge at wibble', /Invalid instant: wibble/],
    ['converge wibble', /Invalid instant: wibble/],
    ['converge -5', /Invalid instant: -5/],
    ['converge at -5', /Invalid instant: -5/]
  ];
  for (const [cmd, want] of bad) {
    const out = say(a.s, cmd);
    ok(out.length === 1 && /^% /.test(out[0]) && want.test(out[0]),
      '`' + cmd + '` is refused with a message that names the mistake', JSON.stringify(out));
  }

  // A refusal changes nothing, and the plain command still answers.
  ok(!say(a.s, 'converge').some(function (l) { return /\(pending\)/.test(l); }),
    'a bare converge still means "fully converged"', JSON.stringify(body(say(a.s, 'converge'))));
  ok(say(a.s, 'converge 0').some(function (l) { return /\(pending\)/.test(l); }),
    'and t=0 is an instant, not an absence of one', JSON.stringify(body(say(a.s, 'converge 0'))));
}

console.log('');
console.log('The console does not print a form it cannot read back:');
{
  const a = lab();
  const help = say(a.s, 'help');
  const line = help.filter(function (l) { return /^\s+converge\b/.test(l); })[0] || '';
  ok(line.length > 0, 'help lists converge', JSON.stringify(help.filter(function (l) { return /converge/.test(l); })));
  // Whatever the index advertises has to be typeable: turn the advert into the command a reader would type.
  const adverts = [];
  const m = line.match(/converge\s+(.*?)\s{2,}/);
  if (m) {
    const spec = m[1];
    if (/at/.test(spec)) adverts.push('converge at 1000');
    if (/<ms>/.test(spec)) adverts.push('converge 1000');
    if (!adverts.length) adverts.push('converge');
  }
  ok(adverts.length > 0, 'the converge line names a syntax', line);
  for (const cmd of adverts) {
    const out = say(a.s, cmd);
    ok(out.length > 0 && !/^% (Unrecognized|Invalid|Incomplete)/.test(out[0]),
      'and `' + cmd + '`, typed straight back into the session that printed it, is accepted', JSON.stringify(out[0]));
  }
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
