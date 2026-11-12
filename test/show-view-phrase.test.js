'use strict';
// Two ways the console answered a question near the one asked (#1449).
//
// 1. `show interfaces counters errors` - the word a reader adds after a view word - fell through the view-keyword table
//    (which held `counters` but not `counters errors`) into the port lookup, and came back
//    `% No interface counters errors on <box>`: a sentence that claims a *port* is missing, about a phrase that starts
//    with a view. The same held for `status detail`, `switchport brief`, `summary detail` and every other view word
//    with anything after it.
//
// 2. `show port-channel summary` - how most of the world spells the table this console keeps under
//    `show etherchannel summary` - was `% Invalid show command`. Same view, other name, and the console had both
//    halves of the fact: it prints the table, and it knew the word `port-channel` from the `channel-group` line.
const path = require('path');
const fs = require('fs');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const eq = function (a, b) { return JSON.stringify(a) === JSON.stringify(b); };

const ROOT = path.join(__dirname, '..');
const catalog = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
function spec(model) { return catalog.filter(function (s) { return s.model === model; })[0]; }
const SWITCH = spec('generic-switch'), PC = spec('generic-pc'), ROUTER = spec('ISR 4331');

function session(model) {
  const t = new Topology();
  t.addDevice(model, 'd1');
  const sim = new Simulator(t);
  return { t: t, sim: sim, cli: new CliSession(t.getDevice('d1'), t, sim) };
}

// A switch with two members bundled into group 1, so the etherchannel table has a row and "the same table" is a
// statement about content rather than about two empty headers.
function lagLab() {
  const t = new Topology();
  t.addDevice(SWITCH, 's1');
  t.addDevice(SWITCH, 's2');
  t.addDevice(PC, 'a'); t.addDevice(PC, 'b');
  t.connect('s1', 'Fa0/1', 's2', 'Fa0/1');
  t.connect('s1', 'Fa0/2', 's2', 'Fa0/2');
  t.connect('a', 'eth0', 's1', 'Fa0/3');
  t.connect('b', 'eth0', 's2', 'Fa0/3');
  const sim = new Simulator(t);
  const S = {};
  const c = function (id) { if (!S[id]) S[id] = new CliSession(t.getDevice(id), t, sim); return S[id]; };
  [['s1', 'Fa0/1'], ['s1', 'Fa0/2']].forEach(function (pair) {
    c(pair[0]).run('configure terminal'); c(pair[0]).run('interface ' + pair[1]);
    c(pair[0]).run('channel-group 1 mode active'); c(pair[0]).run('end');
  });
  [['a', '10.9.0.1'], ['b', '10.9.0.2']].forEach(function (pair) {
    c(pair[0]).run('configure terminal'); c(pair[0]).run('interface eth0');
    c(pair[0]).run('ip address ' + pair[1] + ' 255.255.255.0'); c(pair[0]).run('end');
  });
  return { t: t, sim: sim, c: c };
}

console.log('');
console.log('A phrase that starts with a view word is a question about that view:');
{
  const s = session(SWITCH);
  const run = function (cmd) { return s.cli.run(cmd).output; };
  [['show interfaces counters errors', 'counters'],
    ['show interfaces status detail', 'status'],
    ['show interfaces switchport brief', 'switchport'],
    ['show interfaces summary detail', 'summary'],
    ['show interfaces capabilities detail', 'capabilities'],
    ['show interfaces description all', 'description']].forEach(function (pair) {
    const out = run(pair[0]);
    ok(/is a view, not a port/.test(out[0]), '`' + pair[0] + '` is reported as a view', out[0]);
    ok(/No interface/.test(out[0]) === false, 'and not as a missing port', out[0]);
    ok(out[0].indexOf('`' + pair[0].slice('show interfaces '.length) + '`') !== -1,
      'the phrase the reader typed is quoted back verbatim', out[0]);
  });
  // The pointer that the bare keyword gave is still the pointer: the phrase is not a new table entry.
  const bare = run('show interfaces counters')[0];
  const withTail = run('show interfaces counters errors')[0];
  const pointerOf = function (line) { return line.slice(line.indexOf('`. ')); };
  ok(pointerOf(withTail) !== '' && bare.indexOf('packet and byte counters') !== -1, 'the bare word still points', bare);
  ok(/packet and byte counters/.test(withTail), 'and the phrase points at the same place', withTail);
}

console.log('');
console.log('A genuine typo is still a missing port, and a real port still wins:');
{
  const s = session(SWITCH);
  const run = function (cmd) { return s.cli.run(cmd).output; };
  ok(/^% No interface nonsense on/.test(run('show interfaces nonsense')[0]),
    '`show interfaces nonsense` is still a missing port', run('show interfaces nonsense')[0]);
  ok(/is a view, not a port/.test(run('show interfaces counters')[0]), 'and the bare view word is still a view');
  ok(/^Fa0\/1 \(/.test(run('show interfaces Fa0/1')[0]), 'a real port still prints its block', run('show interfaces Fa0/1')[0]);
  ok(/^% No interface Fa0\/99 on/.test(run('show interfaces Fa0/99')[0]),
    'a near-miss port name is still a missing port', run('show interfaces Fa0/99')[0]);
  // Static: the port table is consulted before the keyword table, so a device with a port named like a view word wins.
  const SRC = fs.readFileSync(path.join(ROOT, 'engine', 'cli.js'), 'utf8');
  const at = SRC.indexOf('const keyword = INTERFACES_VIEW_KEYWORDS');
  const resolveAt = SRC.lastIndexOf('resolvePortName(dev, wanted)', at);
  ok(resolveAt !== -1 && resolveAt < at, 'the port lookup comes before the keyword lookup in the source');
}

console.log('');
console.log('`show port-channel …` is the other spelling of the etherchannel view:');
{
  const L = lagLab();
  const s1 = L.c('s1');
  const run = function (cmd) { return s1.run(cmd).output; };
  const real = run('show etherchannel summary');
  ok(real.length > 1 && /Group/.test(real[0]), 'the etherchannel table has a group row', JSON.stringify(real.slice(0, 2)));
  ok(eq(run('show port-channel summary'), real), '`show port-channel summary` prints exactly that table');
  ok(eq(run('show port-channel'), real), '`show port-channel` alone prints it too');
  ok(eq(run('show port-channel brief'), run('show etherchannel brief')), 'and so does every known sub-word',
    JSON.stringify(run('show port-channel brief')));
  ok(run('show port-channel summary').join('\n').indexOf('Invalid show command') === -1,
    'nothing about it is "invalid" any more');
  // The refusal for an argument names the command the reader typed.
  const refused = run('show port-channel 1')[0];
  ok(/show port-channel does not take "1"/.test(refused), 'an argument is refused by the name the reader typed', refused);
  const refusedReal = run('show etherchannel 1')[0];
  ok(/show etherchannel does not take "1"/.test(refusedReal), 'and the real spelling refuses by its own name',
    refusedReal);
  ok(run('show port-channel 1').join('\n').indexOf('show etherchannel') === -1 ||
    /every group is listed/.test(refused), 'the sentence still says where the answer is', refused);
}

console.log('');
console.log('A device with no bundle answers both spellings the same way:');
{
  const s = session(ROUTER);
  ok(eq(s.cli.run('show port-channel summary').output, s.cli.run('show etherchannel summary').output),
    'an empty answer is the same sentence under both names', s.cli.run('show port-channel summary').output.join(' | '));
  ok(/No link aggregation groups configured/.test(s.cli.run('show port-channel summary').output[0]),
    'and it says what it means', s.cli.run('show port-channel summary').output[0]);
}

console.log('');
console.log('Nothing else about the view keyword table changed:');
{
  const s = session(SWITCH);
  ['switchport', 'trunk', 'status', 'description', 'counters', 'summary', 'capabilities', 'transceiver',
    'errdisable', 'flowcontrol', 'history', 'stats', 'brief'].forEach(function (word) {
    const out = s.cli.run('show interfaces ' + word).output;
    ok(/is a view, not a port/.test(out[0]) && out[0].indexOf('`' + word + '`') !== -1,
      '`show interfaces ' + word + '` is still reported as a view', out[0]);
  });
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
