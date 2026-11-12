'use strict';
// Two commands answered a question the user had not asked (#1493).
//
// `spanning-tree` read its *value* before its *verb*: tokens[2] was taken as a bridge priority whatever tokens[1]
// said, so `spanning-tree portfast` - the most-typed command in a switching lab - came back
// "Usage: spanning-tree priority <0-61440 in 4096 steps>", and `spanning-tree cost 19` came back
// "19 is not a valid bridge priority". The console was not lying about anything it had been asked; it was
// answering a neighbouring question, which a reader has no way to notice while the answer looks plausible.
//
// `vlan` read IOS's `name` keyword as part of the name. `vlan 20 name lab` - the universally used spelling -
// stored a VLAN called "name lab", so every screen that lists names showed the keyword as data. Silently wrong
// data is worse than a refusal, because nothing about it looks like an error.
//
// What is locked here:
//   1. every spanning-tree sub-command is answered about itself, and the ones this device does not model say so
//      rather than offering a priority usage;
//   2. the word that was typed comes back in the refusal, so a typo and an unmodelled feature read differently;
//   3. `priority` still works, still refuses non-multiples of 4096, and still refuses per-VLAN selection;
//   4. `vlan <id> name <text>` stores <text>, `vlan <id> <text>` still stores <text>, and a bare `vlan <id>`
//      still invents VLAN00NN;
//   5. `vlan <id> name` with no text is refused and changes nothing;
//   6. a bare `name <text>` at global config points at the line the word belongs on, since there is no sub-mode.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
function section(name) { console.log('\n' + name); }

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(model) { return catalog.find(function (x) { return x.model === model; }); }

function lab() {
  const t = new Topology();
  const sw = t.addDevice(spec('Catalyst2960'), 'sw');
  const ports = Array.from(sw.interfaces.values())
    .filter(function (p) { return p.type === 'ethernet'; }).map(function (p) { return p.name; });
  return { t: t, sw: sw, port: ports[1], ports: ports };
}
function say(ctx, cmds) {
  return runCommands(ctx.sw, ctx.t, new Simulator(ctx.t), ['enable', 'configure terminal'].concat(cmds)).lines;
}
// The console echoes `prompt + command` for every line; the answers are the rest.
// The console echoes `prompt + command` for every line it runs. A prompt *starts* with the hostname and ends in
// `>` or `#`; an answer may end with either character (the priority usage ends in `<0-61440 ...>`), so the test
// for a prompt is anchored at the start rather than the end.
function answers(lines, command) {
  const isPrompt = function (l) { return /^[A-Za-z0-9][A-Za-z0-9 ._\/-]*[>#]/.test(l); };
  const idx = lines.findIndex(function (l) { return isPrompt(l) && l.indexOf(command) !== -1; });
  return lines.slice(idx + 1).filter(function (l) { return !isPrompt(l); });
}
function answer(ctx, cmds) {
  const lines = say(ctx, cmds);
  return answers(lines, cmds[cmds.length - 1]).join('\n');
}

section('1. Every spanning-tree sub-command is answered about itself');
{
  const cases = [
    ['spanning-tree portfast', 'portfast'],
    ['spanning-tree portfast edge', 'portfast'],
    ['spanning-tree edge', 'edge'],
    ['spanning-tree bpduguard enable', 'bpduguard'],
    ['spanning-tree bpdufilter enable', 'bpdufilter'],
    ['spanning-tree cost 19', 'cost'],
    ['spanning-tree link-type point-to-point', 'link-type'],
    ['spanning-tree guard root', 'guard']
  ];
  const blind = [], silent = [];
  for (const [cmd, verb] of cases) {
    const ctx = lab();
    const a = answer(ctx, ['interface ' + ctx.port, cmd]);
    // The old answer: a priority usage line, or the value read as a priority.
    if (/Usage: spanning-tree priority/.test(a) || /is not a valid bridge priority/.test(a)) blind.push(cmd + ' -> ' + a);
    if (a.indexOf(verb) === -1) silent.push(cmd + ' does not name ' + verb + ' in "' + a + '"');
    if (!/not modelled/.test(a)) silent.push(cmd + ' does not say it is unmodelled: "' + a + '"');
  }
  ok(blind.length === 0, 'none of eight sub-commands is answered as if it were `priority`', blind.join('; '));
  ok(silent.length === 0, 'and each one names the word that was typed and says it is not modelled', silent.join('; '));
}

section('2. A typo and an unmodelled feature read differently');
{
  const ctx = lab();
  const typo = answer(ctx, ['interface ' + ctx.port, 'spanning-tree portfst']);
  ok(/Unknown spanning-tree sub-command "portfst"/.test(typo), 'a misspelling is called unknown, and quoted back', typo);
  ok(/only form is/.test(typo), 'and it names the form that does exist', typo);
  const ctx2 = lab();
  const real = answer(ctx2, ['interface ' + ctx2.port, 'spanning-tree portfast']);
  ok(!/Unknown/.test(real), 'while a real IOS sub-command is not called a mistake', real);
}

section('3. `priority` still does what it did');
{
  const ctx = lab();
  const set = answer(ctx, ['interface ' + ctx.port, 'spanning-tree priority 4096']);
  ok(/Bridge priority set to 4096/.test(set), 'a valid priority is applied', set);
  ok(ctx.sw.config.stpPriority === 4096, 'and stored', String(ctx.sw.config.stpPriority));

  const ctx2 = lab();
  const bad = answer(ctx2, ['interface ' + ctx2.port, 'spanning-tree priority 5000']);
  ok(/5000 is not a valid bridge priority/.test(bad), 'a priority off the 4096 ladder is refused with the reason', bad);
  ok(/nearest valid values are 4096 and 8192/.test(bad), 'and names the neighbours a reader can use', bad);
  ok(ctx2.sw.config.stpPriority == null, 'nothing is stored when it is refused', String(ctx2.sw.config.stpPriority));

  const ctx3 = lab();
  const perVlan = answer(ctx3, ['spanning-tree vlan 20']);
  ok(/one spanning tree, not one per VLAN/.test(perVlan), 'per-VLAN selection is still refused, for its own reason', perVlan);

  const ctx4 = lab();
  const word = answer(ctx4, ['interface ' + ctx4.port, 'spanning-tree priority high']);
  ok(/"high" is not a bridge priority/.test(word), 'a word where a number belongs is quoted, not parsed as 0', word);

  const ctx5 = lab();
  const alone = answer(ctx5, ['spanning-tree']);
  ok(/Usage: spanning-tree priority/.test(alone), 'and the bare command still prints the usage', alone);
}

section('4. The VLAN name is the name, not the keyword');
{
  const ctx = lab();
  answer(ctx, ['vlan 20 name lab']);
  ok(ctx.sw.config.vlans && ctx.sw.config.vlans[20] && ctx.sw.config.vlans[20].name === 'lab',
    '`vlan 20 name lab` stores "lab"', JSON.stringify(ctx.sw.config.vlans));

  const ctx2 = lab();
  answer(ctx2, ['vlan 20 lab']);
  ok(ctx2.sw.config.vlans[20].name === 'lab', '`vlan 20 lab` still stores "lab" (the documented form)');

  const ctx3 = lab();
  answer(ctx3, ['vlan 20']);
  ok(ctx3.sw.config.vlans[20].name === 'VLAN0020', 'and a bare `vlan 20` still invents VLAN0020',
    ctx3.sw.config.vlans[20].name);

  // A name with spaces keeps every word after the keyword.
  const ctx4 = lab();
  answer(ctx4, ['vlan 30 name lab users']);
  ok(ctx4.sw.config.vlans[30].name === 'lab users', 'a two-word name survives whole',
    JSON.stringify(ctx4.sw.config.vlans[30]));

  // The word "name" is only a keyword in front. A VLAN actually called "name-lab" is still nameable.
  const ctx5 = lab();
  answer(ctx5, ['vlan 40 name-lab']);
  ok(ctx5.sw.config.vlans[40].name === 'name-lab', 'and a name that merely starts with those letters is not eaten',
    ctx5.sw.config.vlans[40].name);
}

section('5. An incomplete name is refused, and changes nothing');
{
  const ctx = lab();
  const before = JSON.stringify(ctx.sw.config.vlans || {});
  const a = answer(ctx, ['vlan 20 name']);
  ok(/Incomplete command/.test(a), '`vlan 20 name` is refused as incomplete', a);
  ok(new RegExp('vlan 20 name <text>').test(a), 'and shows the form to type', a);
  ok(JSON.stringify(ctx.sw.config.vlans || {}) === before, 'with nothing written');
}

section('6. A bare `name` points at the line it belongs on');
{
  const ctx = lab();
  const a = answer(ctx, ['name lab']);
  ok(/no vlan sub-mode/.test(a), 'the console says why the word did not take', a);
  ok(/vlan 20 name lab/.test(a), 'and shows an example of where it does', a);
  ok(!/Unrecognized config command: name lab/.test(a), 'it is no longer a bare "unrecognized"', a);
}

section('7. `show vlan` prints the name the user meant');
{
  const ctx = lab();
  const lines = say(ctx, ['vlan 20 name lab', 'do show vlan']);
  const row = lines.find(function (l) { return /^20\s/.test(l.trim()); });
  ok(!!row, 'the VLAN appears in the table', lines.slice(-6).join(' / '));
  ok(row && /\blab\b/.test(row), 'under the name the user typed', row);
  ok(row && !/\bname lab\b/.test(row), 'and not under the keyword', row);
}

section('');
if (failed) {
  console.error(passed + ' passed, ' + failed + ' failed');
  process.exit(1);
}
console.log(passed + ' passed, 0 failed');
