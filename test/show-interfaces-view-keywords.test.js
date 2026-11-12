'use strict';
// `show interfaces switchport` is a view this console does not have - say that, not "no such port" (#1443).
//
// Twelve words that are views under `show interfaces` in IOS answered `% No interface <word> on <box>`, which is the
// sentence a mistyped port name gets. An operator typing a command they know from IOS was told a socket did not
// exist, and the natural next step is to hunt for a typo in a port name that was never wrong. `show interfaces ?`,
// which is how a reader asks what may go in that position, answered `% No interface ? on <box>`.
//
// The refusal now names the view, and points at the command that does answer the question - and every command it
// points at is run here, because advice that does not run is another way of wasting the reader's time.
const fs = require('fs');
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const ROOT = path.join(__dirname, '..');
const catalog = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
function spec(model) { return catalog.filter(function (s) { return s.model === model; })[0]; }
const SWITCH = spec('generic-switch'), ROUTER = spec('ISR 4331'), PC = spec('generic-pc');

function session(model) {
  const t = new Topology();
  t.addDevice(model, 'd1');
  const sim = new Simulator(t);
  return { t: t, sim: sim, cli: new CliSession(t.getDevice('d1'), t, sim) };
}
// The device's own port table, not the catalogue template: a model declares its ports as a pattern
// (`Fa0/{n}` x 8), so the spec's first entry is a template, not a name.
function firstPort(model) {
  return (model.ports || model.interfaces || []).length ? undefined : undefined;
}

const KEYWORDS = ['switchport', 'trunk', 'status', 'description', 'counters', 'summary',
  'capabilities', 'transceiver', 'errdisable', 'flowcontrol', 'history', 'stats'];

const S = session(SWITCH);
const SWPORT = [...S.t.getDevice('d1').interfaces.keys()][0];
const out = function (cmd) { return S.cli.run(cmd).output.join('\n'); };

console.log('');
console.log('A view this console does not have is reported as a view, not as a missing port:');
KEYWORDS.forEach(function (word) {
  const text = out('show interfaces ' + word);
  ok(text.indexOf('No interface') === -1,
    '`show interfaces ' + word + '` does not claim a port is missing', text);
  ok(/is a view, not a port/.test(text) && text.indexOf('`' + word + '`') !== -1,
    'and says `' + word + '` is a view', text);
  ok(/this console has no `show interfaces /.test(text), 'naming the command it cannot answer', text);
});

console.log('');
console.log('Every command the refusal points at actually runs:');
const advice = out('show interfaces switchport') + ' ' + out('show interfaces trunk') +
  ' ' + out('show interfaces counters') + ' ' + out('show interfaces description') + ' ' +
  out('show interfaces capabilities') + ' ' + out('show interfaces errdisable') + ' ' +
  out('show interfaces ?');
const named = ['show vlan brief', 'show version', 'show lldp neighbors'];
named.forEach(function (cmd) {
  const text = out(cmd);
  ok(!/% (Unrecognized|Invalid)/.test(text), '`' + cmd + '` is named in the advice and is a real command', text.slice(0, 80));
  ok(advice.indexOf(cmd) !== -1, 'and it is actually one of the commands offered', cmd);
});
const onePort = out('show interfaces ' + SWPORT);
ok(/packets input/.test(onePort),
  '`show interfaces <port>` - offered for counters - really does print the counters', onePort.slice(0, 120));

console.log('');
console.log('The questions that were answered are still answered the same way:');
const bogus = out('show interfaces Fa0/99');
ok(/^% No interface Fa0\/99 on /.test(bogus),
  'a port that really does not exist still gets the port sentence', bogus);
ok(bogus.indexOf('is a view') === -1, 'and is not confused with a keyword', bogus);
ok(out('show interfaces ' + SWPORT).indexOf('% ') !== 0,
  'a real port still prints its block', out('show interfaces ' + SWPORT).slice(0, 60));
ok(/status:/.test(onePort) && /peer:/.test(onePort), 'with the facts it always printed', onePort.slice(0, 120));

console.log('');
console.log('`?` is answered with the usage, not with "no interface ?":');
const q = out('show interfaces ?');
ok(/^% Usage:/.test(q), '`show interfaces ?` prints a usage line', q);
ok(!/No interface \?/.test(q), 'and never claims a port called "?" is missing', q);
ok(q.indexOf('show interfaces <port>') !== -1, 'the usage says how to ask about one port', q);
const h = out('show interfaces help');
ok(/^% Usage:/.test(h), '`show interfaces help` answers the same way', h);

console.log('');
console.log('Case and the near-misses behave:');
ok(/is a view, not a port/.test(out('show interfaces SWITCHPORT')),
  'the keyword is recognised whatever its case', out('show interfaces SWITCHPORT'));
ok(/is a view, not a port/.test(out('show interfaces Counters')),
  'and so is a mixed-case spelling', out('show interfaces Counters'));
ok(/No interface Fa0\/9x/.test(out('show interfaces Fa0/9x')),
  'a near-miss on a real port name is still a missing port, not a keyword',
  out('show interfaces Fa0/9x'));

console.log('');
console.log('A porter on a router can still ask about its ports:');
const R = session(ROUTER);
const rport = [...R.t.getDevice('d1').interfaces.keys()][0];
const routerOut = R.cli.run('show interfaces ' + rport).output.join('\n');
ok(routerOut.indexOf('% ') !== 0, 'a router still prints the port block', routerOut.slice(0, 60));
ok(/is a view, not a port/.test(R.cli.run('show interfaces switchport').output.join('\n')),
  'and the keyword answer is not switch-only', R.cli.run('show interfaces switchport').output.join('\n'));

console.log('');
console.log('The table of keywords is a table, not a pile of ifs:');
const src = fs.readFileSync(path.join(ROOT, 'engine', 'cli.js'), 'utf8');
ok(/const INTERFACES_VIEW_KEYWORDS = \{/.test(src), 'the keywords live in one named table');
const listed = (src.match(/const INTERFACES_VIEW_KEYWORDS = \{([\s\S]*?)\n\};/) || [])[1] || '';
KEYWORDS.forEach(function (word) {
  ok(new RegExp('\\n  ' + word + ':').test(listed), '`' + word + '` is in that table');
});
ok(/const keyword = INTERFACES_VIEW_KEYWORDS\[/.test(src),
  'and the console asks the table rather than listing words again');
ok(src.indexOf('INTERFACES_VIEW_KEYWORDS[') < src.indexOf('const ambiguous = portKey(wanted)'),
  'the keyword answer is checked after the port table, so a port named like a keyword still wins');

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
