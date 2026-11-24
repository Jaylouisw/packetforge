'use strict';
// What an IOS-like box does with a `hostname` past the ceiling every reference calls the rule of the
// command: it refuses, in one fixed sentence, and the name it had is the name it keeps (#2532).
//
//   Device(config)#hostname <64 characters>
//   % Hostname must have more than 1 character and must not exceed the maximum 63 character length.
//
// That first line is the vendor's, verbatim (Cisco IOS Configuration Fundamentals Command Reference,
// F-K, `hostname`: "Names must be 63 characters or fewer"; IOS XE 17.12.x Catalyst 9300 System
// Management Commands carries the same words and the same refusal on IOS XE). The second line is this
// console's, shaped like the other refusals that have to say what survived (#1497): the count, so the
// operator can trim without counting by eye, and the name that is still on the box.
//
// The console had no length rule at all: `hostname <64+ characters>` renamed the device everywhere -
// config line, `device.name`, prompt, canvas label - into a name no box will hold. A refusal changes
// nothing, which is what these assertions are mostly about.
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

const REFUSAL = '% Hostname must have more than 1 character and must not exceed the maximum 63 character length.';
function stillLine(count, name) { return '  ' + count + ' characters, so the name is still "' + name + '"'; }

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

console.log('63 characters is the last name a box holds:');
{
  const e = lab();
  const name = 'a'.repeat(63);
  const out = rename(e, name);
  ok(out.length === 0, '`hostname <63 characters>` prints nothing - it is legal', JSON.stringify(out));
  ok(e.dev.config.hostname === name, 'config.hostname holds it whole', String(e.dev.config.hostname).length);
  ok(e.dev.name === name, 'and device.name agrees', String(e.dev.name).length);
  ok(e.cli.prompt().indexOf(name + '(config)#') === 0, 'the prompt carries all 63', e.cli.prompt().slice(0, 20));
  const text = configText(e);
  ok(text.split('\n').indexOf('hostname ' + name) !== -1,
    'and `show running-config` prints the name whole on one line');
}

console.log('\nThe 64th character is refused, and the name the box had is the one it keeps:');
{
  const e = lab();
  e.cli.run('configure terminal');
  const before = e.dev.name;
  const beforePrompt = e.cli.prompt();
  const beforeConfig = configText(e);
  e.cli.run('configure terminal');
  const out = ((e.cli.run('hostname ' + 'a'.repeat(64)).output) || []).map(String);
  ok(out.length === 2, 'two lines come back: the sentence and what survived', JSON.stringify(out.length));
  ok(out[0] === REFUSAL, 'the first is the vendor sentence, verbatim', out[0]);
  ok(out[1] === stillLine(64, before), 'the second counts the name and names the one still on the box', out[1]);
  ok(e.dev.config.hostname === null, 'config.hostname is untouched', String(e.dev.config.hostname));
  ok(e.dev.name === before, 'device.name is untouched - no surface was renamed', String(e.dev.name));
  ok(e.dev.nameBeforeHostname === undefined,
    'and no bookkeeping was written for a rename that never happened', String(e.dev.nameBeforeHostname));
  ok(e.cli.prompt() === beforePrompt, 'the prompt still says the old name', e.cli.prompt());
  ok(configText(e) === beforeConfig, '`show running-config` is unchanged, line for line');
  ok(configText(e).indexOf('a'.repeat(64)) === -1, 'the refused name appears nowhere in the config');
}

console.log('\nThe count is the name itself, however long it is:');
{
  const e = lab();
  const before = e.dev.name;
  const out = rename(e, 'b'.repeat(200));
  ok(out[0] === REFUSAL, 'a 200-character name gets the same sentence', out[0]);
  ok(out[1] === stillLine(200, before), 'and its own count', out[1]);
  const spaced = rename(e, ('x '.repeat(50)).trim());
  ok(spaced[1] === stillLine(99, before), 'interior spaces are characters too - 99 of them here', spaced[1]);
}

console.log('\nSpaces count at the boundary, both sides:');
{
  const e = lab();
  const legal = 'edge router 1 ' + 'y'.repeat(49);   // 14 + 49 = 63
  ok(legal.length === 63, 'the fixture is 63 characters', String(legal.length));
  ok(rename(e, legal).length === 0, 'a 63-character name with spaces is taken', String(e.dev.config.hostname));
  ok(e.dev.config.hostname === legal, 'whole', String(e.dev.config.hostname));
  const illegal = legal + 'z';                        // 64
  const out = rename(e, illegal);
  ok(out[0] === REFUSAL, 'one more character and it is refused', out[0]);
  ok(out[1] === stillLine(64, legal), 'with the count, and the 63-character name still on the box', out[1]);
  ok(e.dev.config.hostname === legal, 'which is still what config.hostname holds', String(e.dev.config.hostname));
}

console.log('\nA name that breaks two rules is answered once, by the one that stops the command:');
{
  // 64 digits breach the length rule and the all-numeric rule at the same time. A box stops at the
  // first answer, so the length refusal is the only line - the `% Hostname contains one or more illegal
  // characters.` warning belongs to a command that is about to be taken, and this one is not.
  const e = lab();
  const before = e.dev.name;
  const out = rename(e, '9'.repeat(64));
  ok(out.length === 2, 'two lines, not three', JSON.stringify(out));
  ok(out[0] === REFUSAL, 'and the first is the length refusal, not the warning', out[0]);
  ok(out[1] === stillLine(64, before), 'the name is still the old one', out[1]);
  ok(e.dev.config.hostname === null, 'and nothing was stored', String(e.dev.config.hostname));
}

console.log('\nA refusal is not a door closing: the next command works:');
{
  const e = lab();
  const out = rename(e, 'c'.repeat(64));
  ok(out[0] === REFUSAL, 'the long name was refused');
  const good = ((e.cli.run('hostname r2').output) || []).map(String);
  ok(good.length === 0, 'a legal name after the refusal is taken in silence', JSON.stringify(good));
  ok(e.dev.config.hostname === 'r2', 'and stored', String(e.dev.config.hostname));
  ok(e.cli.prompt().indexOf('r2(config)#') === 0, 'the prompt follows it', e.cli.prompt());
  const cleared = ((e.cli.run('no hostname').output) || []).map(String);
  ok(cleared.length === 1 && /^Hostname cleared/.test(cleared[0]),
    '`no hostname` still clears, with its own receipt', JSON.stringify(cleared));
  ok(cleared.every(function (l) { return l !== REFUSAL; }), 'and no refusal line in it');
  ok(e.dev.config.hostname === null, 'cleared', String(e.dev.config.hostname));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
