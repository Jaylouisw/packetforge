'use strict';
// What an IOS-like box does with the one hostname breach whose outcome a vendor document shows:
// an all-numeric name.
//
// Every IOS and IOS XE `hostname` reference publishes the ARPANET host-label rule - "They must start
// with a letter, end with a letter or digit, and have as interior characters only letters, digits,
// and hyphens. Names must be 63 characters or fewer." - and then states the outcome of exactly one
// breach: "Creating an all numeric hostname is not recommended but the name will be accepted after
// an error is returned", with a transcript
//
//   Device(config)#hostname 123
//   % Hostname contains one or more illegal characters.
//   123(config)#
//
// This console renamed in total silence: no line, and every surface - canvas label, inspector
// header, prompt, `show running-config` - carrying a name a real box would have complained about.
//
// The second half of this file pins the *boundary* rather than the rule: every other breach shape
// (leading digit, underscore, trailing dot, interior space, a vendor model string, a name past 63
// characters) stays silent, because the documents show no outcome for any of them - the `\99`
// sample prints the message but never shows the prompt that follows - and because half the
// catalogue's default names are vendor model strings. Guessing would put a warning on every
// replayed running-config. research/hostname-illegal-characters.md carries the open questions and
// the evidence that would close each one.
const path = require('path');
const { Topology, Simulator, CliSession } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  + ' + msg); }
  else { failed++; console.error('  x ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.filter(function (s) { return /ASR 1001-X/.test(s.model); })[0]
  || catalog.filter(function (s) { return s.vendor === 'generic' && s.model === 'generic-router'; })[0];
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];

const WARNING = '% Hostname contains one or more illegal characters.';

function lab() {
  const t = new Topology();
  const dev = t.addDevice(ROUTER);
  const sim = new Simulator(t);
  return { t: t, dev: dev, sim: sim, cli: new CliSession(dev, t, sim) };
}

function rename(env, name) {
  env.cli.run('configure terminal');
  const res = env.cli.run('hostname ' + name);
  return ((res && res.output) || []).map(String);
}

function configText(env) {
  env.cli.run('end');
  const res = env.cli.run('show running-config');
  return ((res && res.output) || []).join('\n');
}

console.log('An all-numeric hostname is warned about and then taken (the vendor transcript):');
{
  const e = lab();
  const out = rename(e, '123');
  ok(out.length === 1, 'one line comes back', String(out.length));
  ok(out[0] === WARNING, 'and it is the vendor sentence, verbatim', out[0]);
  ok(/^123\(config\)#$/.test(e.cli.prompt()),
    'the prompt carries 123 - the rename landed, as the vendor transcript shows', e.cli.prompt());
  ok(e.dev.config.hostname === '123', 'config.hostname holds the name', String(e.dev.config.hostname));
  ok(e.dev.name === '123', 'device.name agrees - no surface disagrees with another', String(e.dev.name));
  ok(/^hostname 123$/m.test(configText(e)), 'and `show running-config` prints it');
  const two = lab();
  ok(rename(two, '12')[0] === WARNING, 'two digits warn like three do');
  ok(two.cli.prompt().indexOf('12(config)#') === 0, 'and the prompt is 12(config)#', two.cli.prompt());
}

console.log('\nThe warning comes before the name is taken, and is not a refusal:');
{
  const e = lab();
  e.cli.run('configure terminal');
  const out = ((e.cli.run('hostname 123').output) || []).map(String);
  ok(out[0] === WARNING, 'the line is the first thing printed', JSON.stringify(out));
  ok(out.filter(function (l) { return l === WARNING; }).length === 1, 'and it is printed exactly once');
  ok(e.dev.config.hostname === '123',
    'the name was stored anyway - a refusal would have left the old name', String(e.dev.config.hostname));
  ok(((e.cli.run('hostname 123').output) || [])[0] === WARNING,
    're-typing it warns again - the check is on the name, not on a transition');
  ok(e.dev.config.hostname === '123', 'and it is still stored');
}

console.log('\nEvery other breach shape stays silent - no document shows the outcome:');
{
  // Not a claim about real hardware: a claim about what is written down. The reference prints the
  // same message for `hostname \99` and then stops, and says nothing at all about these. Widening
  // the check to the whole rule is a separate increment with its own evidence to gather.
  [['9r1', 'starts with a digit'],
   ['r1_r2', 'an underscore is not a letter, digit or hyphen'],
   ['r1.', 'ends with a character that is not a letter or digit'],
   ['-edge', 'a leading hyphen breaks "must start with a letter"']].forEach(function (c) {
    const e = lab();
    const out = rename(e, c[0]);
    ok(out.length === 0, '`hostname ' + c[0] + '` (' + c[1] + ') prints nothing', JSON.stringify(out));
    ok(e.dev.config.hostname === c[0], 'and the name is taken as before', String(e.dev.config.hostname));
  });
}

console.log('\nCatalogue model names do not warn - the config replay guard depends on it:');
{
  // Half the catalogue's default names are vendor model strings, which breach the published rule
  // (spaces, "!", a leading digit). A warning on those would fire on every `show running-config`
  // replayed back into the box, which is a warning storm and not what a device's own config looks
  // like. test/config-roundtrip.test.js replays all 2198 models and asserts silence.
  [['ZenWiFi ET8', 'a vendor model string with a space'],
   ['FRITZ!Box 7590', 'a model string with "!" and a space'],
   ['C100G', 'a model string that happens to be legal'],
   ['edge router 2', 'the multi-word name this console supports since #19/#21']].forEach(function (c) {
    const e = lab();
    const out = rename(e, c[0]);
    ok(out.length === 0, '`hostname ' + c[0] + '` (' + c[1] + ') prints nothing', JSON.stringify(out));
    ok(e.dev.config.hostname === c[0], 'and the name survives whole', String(e.dev.config.hostname));
  });
}

console.log('\nA legal name still renames in silence - the warning is not a receipt:');
{
  [['r1', 'a letter and a digit'],
   ['R1', 'upper case'],
   ['edge-router-1', 'hyphens interior, ends on a digit'],
   ['r1-2-x', 'hyphens anywhere as long as the last character is a letter'],
   ['a', 'a single letter is the shortest legal name'],
   ['z9', 'two characters']].forEach(function (c) {
    const e = lab();
    const out = rename(e, c[0]);
    ok(out.length === 0, '`hostname ' + c[0] + '` (' + c[1] + ') prints nothing', JSON.stringify(out));
    ok(e.dev.config.hostname === c[0], 'and sets it', String(e.dev.config.hostname));
  });
}

console.log('\n`no hostname` still restores the default name without a warning:');
{
  const e = lab();
  const out = rename(e, '123');
  ok(out[0] === WARNING, 'the flagged name went in with its line');
  const back = ((e.cli.run('no hostname').output) || []).map(String);
  ok(e.dev.config.hostname === null, '`no hostname` clears it', String(e.dev.config.hostname));
  ok(back.every(function (l) { return l !== WARNING; }),
    'and restoring the default name is not a rule breach', JSON.stringify(back));
  ok(e.dev.name !== '123', 'the flagged name is gone from the device', String(e.dev.name));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
