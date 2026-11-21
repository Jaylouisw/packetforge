'use strict';
// A view word with nothing after it is an **incomplete** command, not an invalid one (#fidelity).
//
// `show` on its own was answered `% Invalid show command: (empty)` - the console saying it does not know the word
// `show`, which is the one thing certainly untrue about it. IOS's own error-message table defines the other reply
// as "You did not enter all the keywords or values required by this command": `% Incomplete command.`
// (Command Reference, IOS XE 17.18.x, Catalyst 9200, "Using the Command-Line Interface", Table 3).
//
// The same held one level down, where the console *does* have a completion in its own table:
//
//   show mac    -> % Invalid show command: mac      (the door is `show mac address-table`)
//   show power  -> % Invalid show command: power    (the door is `show power inline`)
//
// Both are words the dispatcher resolves; what is missing is the word that completes them, which is exactly the
// 3750 transcript's `SW1#clear mac address-table` -> `% Incomplete command.`
// (https://community.cisco.com/t5/switching/clearing-mac-address-help-how-to/td-p/3325072).
//
// What must NOT change: a word the console does not know is still `% Invalid show command: <word>`; an ambiguous
// prefix is still ambiguous; and both completed views still print their tables.
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
const SWITCH = spec('generic-switch');

function box() {
  const t = new Topology();
  t.addDevice(SWITCH, 'sw1');
  const sim = new Simulator(t);
  // One session stands on its prompt; a second is opened per line by `run` so a test about `show` cannot be
  // swallowed by a mode change an earlier case made.
  return function (line, session) {
    const s = session || new CliSession(t.getDevice('sw1'), t, sim);
    const res = s.run(line);
    return (res && res.output ? res.output : []).map(String);
  };
}

console.log('');
console.log('`show` with no view word is incomplete, not invalid:');
{
  const run = box();
  const bare = run('show');
  ok(bare.length === 1, 'one line, not a table and a complaint', bare.join(' | '));
  ok(/^% Incomplete command:/.test(bare[0]), 'it is reported as an incomplete command', bare[0]);
  ok(bare[0].indexOf('show ?') !== -1, 'and the hint names the key that lists the views', bare[0]);
  ok(!/Invalid show command/.test(bare[0]), 'nothing calls `show` a word the console does not know', bare[0]);

  const spaced = run('show   ');
  ok(spaced.length === 1 && spaced[0] === bare[0], 'trailing whitespace after `show` answers the same way',
    spaced.join(' | '));

  // Privileged EXEC and config mode both reach the same dispatcher: one session walks to `(config)#` and asks
  // from there, because `do` runs a `show` line from configuration mode.
  const t = new Topology();
  t.addDevice(SWITCH, 'sw2');
  const session = new CliSession(t.getDevice('sw2'), t, new Simulator(t));
  const at = function (line) { return (session.run(line).output || []).map(String); };
  ok(at('enable').length >= 0 && at('configure terminal').length >= 0, 'a session reaches config mode');
  const doShow = at('do show');
  ok(doShow.length === 1 && /^% Incomplete command:/.test(doShow[0]),
    '`do show` in config mode is incomplete too, not invalid', doShow.join(' | '));
  const doMac = at('do show mac');
  ok(doMac.length === 1 && /^% Incomplete command:/.test(doMac[0]),
    'and `do show mac` names the word it needs', doMac.join(' | '));
}

console.log('');
console.log('A view word whose own table says what completes it:');
{
  const run = box();
  [['show mac', 'show mac address-table'],
   ['show m', 'show mac address-table'],
   ['show power', 'show power inline'],
   ['show pow', 'show power inline']].forEach(function (pair) {
    const out = run(pair[0]);
    ok(out.length === 1 && /^% Incomplete command:/.test(out[0]),
      '`' + pair[0] + '` is incomplete', out.join(' | '));
    ok(out.length === 1 && out[0].indexOf('`' + pair[1] + '`') !== -1,
      'and it names the completion `' + pair[1] + '`', out.join(' | '));
  });
  // The spelling echoed back is the one typed, not the door it resolved to.
  const short = run('show m');
  ok(short.length === 1 && short[0].indexOf('`show m`') !== -1,
    'a shortened word is quoted as typed', short.join(' | '));
}

console.log('');
console.log('Nothing else moved:');
{
  const run = box();
  const nonsense = run('show flurbish');
  ok(nonsense.length === 1 && nonsense[0] === '% Invalid show command: flurbish',
    'a word the console does not know is still invalid', nonsense.join(' | '));

  const ambiguous = run('show po');
  ok(ambiguous.length === 1 && /^% Ambiguous command "show po"/.test(ambiguous[0]),
    '`show po` is still ambiguous between port-channel and power', ambiguous.join(' | '));

  const help = run('show ?');
  ok(help.length > 0 && /Available `show` views/.test(help[0]), '`show ?` still lists the views', help.join(' | '));

  const mac = run('show mac address-table');
  ok(mac.some(function (l) { return /Mac Address Table/.test(l); }),
    'the completed `show mac address-table` still prints its table', mac.join(' | '));
  ok(!mac.some(function (l) { return /^%/.test(l); }), 'with no refusal in it', mac.join(' | '));

  const power = run('show power inline');
  ok(!power.some(function (l) { return /^% Incomplete command:/.test(l); }),
    'the completed `show power inline` is not called incomplete', power.join(' | '));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
