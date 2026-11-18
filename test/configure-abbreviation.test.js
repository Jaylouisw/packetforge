'use strict';
// `config t` is `configure terminal` (#fidelity).
//
// IOS accepts an abbreviation down to "the number of characters that allow a unique abbreviation", and the
// vendor's own CLI chapter uses this command as the example: "you can abbreviate the configure terminal
// command to config t". The MDS 9000 guide prints `switch# config t` accepted and `config ?` -> `terminal`.
//
//   https://cisco.com/c/en/us/td/docs/ios-xml/ios/fundamentals/configuration/xe-16/fundamentals-xe-16-book/cf-cli-basics.html
//   https://www.cisco.com/en/US/docs/storage/san_switches/mds9000/sw/rel_1_x/1_1_1a/san-os/configuration/guide/BforBgin.html
//
// This console recognised two literal spellings, `configure` and `conf`, and refused the rest:
//
//   sw1#config t          -> % Unrecognized command: config t
//   sw1#config term       -> % Unrecognized command: config term
//   sw1#conf term         -> % Invalid input: conf term
//
// All three open config mode on a real box. The rule is a prefix match against the words this console has,
// which is also why `con` is refused here: `configure` and `converge` share it, exactly as `configure`,
// `connect` and `copy` share it on a box.
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
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];

function session() {
  const t = new Topology();
  t.addDevice(SWITCH, 'sw1');
  const s = new CliSession(t.getDevice('sw1'), t, new Simulator(t));
  s.run('enable');
  return s;
}
// One line at a time, so the mode the answer left behind is the one asserted.
function typed(cmd) {
  const s = session();
  const res = s.run(cmd);
  return { mode: s.mode, out: res.output, said: res.output.join('\n'), prompt: s.prompt() };
}

// Every abbreviation of both words that a box accepts opens config mode, with no complaint on the way. The
// one line a box does print here is the greeting that opens the mode - `Enter configuration commands, one per
// line.  End with CNTL/Z.` - and it is the answer to holding the mode open, not a refusal
// (research/config-mode-greeting.md).
const GREETING = 'Enter configuration commands, one per line.  End with CNTL/Z.';
['configure terminal', 'configure term', 'conf t', 'conf term', 'config t', 'config term',
  'confi t', 'confi termi', 'CONFIG T'].forEach(function (cmd) {
  const r = typed(cmd);
  ok(r.mode === 'config' && r.said === GREETING, '"' + cmd + '" opens config mode and greets',
    'mode=' + r.mode + ' said=' + JSON.stringify(r.out));
  ok(r.out.filter(function (l) { return /^%/.test(String(l)); }).length === 0,
    '"' + cmd + '" says nothing in the console\'s refusal voice', JSON.stringify(r.out));
  ok(/(config\)#)$/.test(r.prompt), '"' + cmd + '" leaves the config prompt', r.prompt);
});

// The full spelling still works, and the first word may be shortened on its own even when the second is not.
ok(typed('configure terminal').mode === 'config', 'the spelled-out form is unchanged');

// A prefix two commands share is refused rather than guessed, and the refusal names both.
['c', 'co', 'con'].forEach(function (cmd) {
  const r = typed(cmd);
  ok(r.mode === 'enable', '"' + cmd + '" does not enter a mode', 'mode=' + r.mode);
  ok(/^% Ambiguous command "/.test(r.said), '"' + cmd + '" is refused as ambiguous', r.said);
  ok(/configure/.test(r.said) && /converge/.test(r.said), '"' + cmd + '" names both candidates', r.said);
});

// `converge` is the rival, so it must still be itself and must not be read as `configure`.
(function () {
  const r = typed('converge');
  ok(r.mode === 'enable', 'converge still converges rather than opening config mode', 'mode=' + r.mode);
  ok(!/Invalid input|Unrecognized|Ambiguous/.test(r.said), 'converge is not refused', r.said);
})();

// A line that stops after the verb is incomplete, not invalid - IOS's own answer, in this console's words.
(function () {
  const r = typed('configure');
  ok(r.mode === 'enable', 'bare `configure` leaves the mode alone', 'mode=' + r.mode);
  ok(/^% Incomplete command: configure terminal/.test(r.said), 'bare `configure` is incomplete', r.said);
})();

// A word that is not a keyword of this command is still a wrong value, not a command.
['configure flurbish', 'config n', 'conf network'].forEach(function (cmd) {
  const r = typed(cmd);
  ok(r.mode === 'enable', '"' + cmd + '" does not enter a mode', 'mode=' + r.mode);
  ok(/^% Invalid input: /.test(r.said), '"' + cmd + '" is refused as invalid input', r.said);
});

// The prompt is what an operator reads the mode off, so the three-mode walk is walked once end to end.
(function () {
  const s = session();
  ok(/(config\)#)$/.test((s.run('config t'), s.prompt())), 'prompt reads (config)# after `config t`', s.prompt());
  s.run('interface ' + s.device.interfaces.values().next().value.name);
  ok(/(config-if\)#)$/.test(s.prompt()), 'and an interface can be entered from there', s.prompt());
  s.run('end');
  ok(/sw1#$/.test(s.prompt()), '`end` returns to enable mode', s.prompt());
})();

console.log('\nconfigure-abbreviation: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
