'use strict';
// A hostname past 63 characters is refused by the box, and the console took it.
//
// Every IOS and IOS XE `hostname` reference states the ceiling as a rule of the command - "Names must be
// 63 characters or fewer" - and a recorded session on the boundary (Cisco Learning Network, "Hostname
// length") shows the 63-character name taken, the 64-character name refused, and the prompt still reading
// the old name afterwards:
//
//     % Hostname must have more than 1 character and must not exceed the maximum 63 character length.
//
// The console had no length rule at all, so `hostname <64 characters>` renamed the device: the config line,
// `device.name`, every prompt and every canvas label took a name no box will hold. This pins the ceiling at
// both sides of the boundary, the sentence, the state a refusal leaves behind, and the one interaction with
// the older all-numeric warning (a 64-digit name breaches both rules, and the box answers the one that stops
// the command).
//
// What is NOT pinned is the lower bound the same sentence names ("more than 1 character"): no capture shows a
// one-character name refused, so the console still takes one - research/hostname-length-limit.md.
const path = require('path');
const { Topology, Simulator, CliSession } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const spec = catalog.find(function (s) { return s.vendor === 'generic' && s.model === 'generic-router'; });

const REFUSAL = '% Hostname must have more than 1 character and must not exceed the maximum 63 character length.';

function lab() {
  const t = new Topology();
  const dev = t.addDevice(spec);
  const cli = new CliSession(dev, t, new Simulator(t));
  cli.run('configure terminal');
  return { t: t, dev: dev, cli: cli };
}

function lines(cli, cmd) {
  return ((cli.run(cmd).output) || []).map(String);
}

const name63 = 'a'.repeat(63);
const name64 = 'a'.repeat(64);

console.log('The ceiling itself is taken: 63 characters rename the box');
{
  const env = lab();
  const out = lines(env.cli, 'hostname ' + name63);
  ok(out.length === 0, 'a legal name prints nothing', JSON.stringify(out));
  ok(env.dev.config.hostname === name63, 'config.hostname is the 63-character name');
  ok(env.dev.name === name63, 'device.name is the same 63 characters');
  ok(env.cli.prompt() === name63 + '(config)#', 'the prompt carries the whole name', env.cli.prompt());
  const cfg = lines(env.cli, 'show running-config').join('\n');
  ok(cfg.indexOf('hostname ' + name63) !== -1, 'show running-config prints the line');
}

console.log('\n64 characters are refused, in the box\'s own sentence');
{
  const env = lab();
  const before = env.dev.name;
  lines(env.cli, 'hostname keep-me');
  const out = lines(env.cli, 'hostname ' + name64);
  ok(out[0] === REFUSAL, 'first line is the vendor sentence verbatim', out[0]);
  ok(out.length === 2, 'the refusal is two lines: the sentence and what was kept', String(out.length));
  ok(/^  64 characters, so the name is still "keep-me"$/.test(out[1] || ''), 'the second line counts and names the kept name', out[1]);
  ok(env.dev.config.hostname === 'keep-me', 'config.hostname still holds the previous name');
  ok(env.dev.name === 'keep-me', 'device.name is unchanged');
  ok(env.cli.prompt() === 'keep-me(config)#', 'the prompt still reads the old name', env.cli.prompt());
  ok(lines(env.cli, 'show running-config').join('\n').indexOf('hostname keep-me') !== -1,
    'show running-config still prints the old name');
  ok(before !== env.dev.name, 'the refusal did not restore the model name either');
}

console.log('\nA far longer name answers the same way, once');
{
  const env = lab();
  const out = lines(env.cli, 'hostname ' + 'z'.repeat(200));
  ok(out.length === 2 && out[0] === REFUSAL, 'a 200-character name gets the same sentence', JSON.stringify(out));
  ok(/^  200 characters, so the name is still "/.test(out[1] || ''), 'the count is the name\'s own', out[1]);
}

console.log('\nA 64-digit name stops at the length rule, not the numeric warning');
{
  const env = lab();
  const out = lines(env.cli, 'hostname ' + '1'.repeat(64));
  ok(out[0] === REFUSAL, 'the length sentence is the answer', JSON.stringify(out));
  ok(out.join('\n').indexOf('illegal characters') === -1,
    'the "illegal characters" warning is not also printed: the command stopped');
}

console.log('\nSpaces count as characters, because they are part of the name');
{
  const env = lab();
  // 63 characters including three spaces; 64 with one more word character.
  const fits = 'core switch one ' + 'x'.repeat(47);
  const over = fits + 'y';
  ok(fits.length === 63, 'the fixture name is 63 characters', String(fits.length));
  ok(lines(env.cli, 'hostname ' + fits).length === 0, 'a 63-character multi-word name is taken');
  ok(env.dev.config.hostname === fits, 'it is stored whole');
  const out = lines(env.cli, 'hostname ' + over);
  ok(out[0] === REFUSAL, 'one character more is refused');
  ok(env.dev.config.hostname === fits, 'and the previous multi-word name is what remains');
}

console.log('\nA refused rename leaves the `no hostname` path intact');
{
  const env = lab();
  const defaultName = env.dev.name;
  lines(env.cli, 'hostname ' + name64);
  ok(env.dev.name === defaultName, 'the refusal left the factory name in place');
  const out = lines(env.cli, 'no hostname');
  ok(out.length === 1 && out[0].indexOf('% No hostname set') === 0, 'no hostname answers as before', JSON.stringify(out));
  ok(env.dev.name === defaultName, 'the name is the factory one');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
