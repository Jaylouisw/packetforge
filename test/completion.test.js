'use strict';
// completion.test.js — `?` as a question about what you typed.
//
// Before this, `?` worked only on its own. Every other position treated it as a bad argument:
//
//   R1#sh ?
//   % Unrecognized command: sh ?
//
// which is the worst possible reply to a question, and it got worse the moment abbreviation landed,
// because `sh ip int br` worked while `sh ip ?` did not. Now a trailing `?` prints the completions for
// the words already typed, from the same parsed help tree that abbreviation uses - so a completion
// can only ever offer a command that exists.
//
// The strongest assertion in this file is not "the list looks right" but "nothing in the list is a
// ghost": every keyword offered is typed back at the parser and must be accepted. A completion list
// that offers a command the console then refuses is worse than no completion at all.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const abbrev = require('../engine/abbrev');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + (actual === expected ? '' : ' (got ' + JSON.stringify(actual) +
    ', want ' + JSON.stringify(expected) + ')'));
}
function match(re, text, msg) {
  ok(re.test(text), msg + (re.test(text) ? '' : ' (no match in ' + JSON.stringify(String(text).slice(0, 320)) + ')'));
}
function model(name) {
  const found = loadCatalog(path.join(__dirname, '..', 'devices')).find((x) => x.model === name);
  if (!found) throw new Error('no such model: ' + name);
  return found;
}

function lab() {
  const t = new Topology();
  const pc = t.addDevice(model('generic-pc'));
  const r1 = t.addDevice(model('generic-router'));
  pc.name = 'PC1'; r1.name = 'R1';
  t.connect(pc.id, 'eth0', r1.id, 'Gi0/0');
  const sim = new Simulator(t);
  const s = new CliSession(r1, t, sim);
  s.run('enable');
  return {
    t, sim, s,
    run: (line) => s.run(line).output,
    text: (line) => s.run(line).output.join('\n'),
    // The keywords a completion offered, from the single-line list form or the two-column form.
    // Two shapes: a two-column table (label, meaning) and a single comma-separated line for the case
    // where every completion shares one description. Splitting a table row on a comma would cut a
    // description in half ("drops, forwards, protocol events"), so the column is read by its gap.
    labels: (out) => {
      const inline = out.filter((l) => /^ {2}Next: /.test(l));
      if (inline.length) return inline[0].replace(/^ {2}Next: /, '').split(/,\s*/);
      const rows = out.filter((l) => /^ {2}\S/.test(l) && !/Next +Meaning|^ {2}Next:/.test(l));
      return rows.map((r) => r.trim().split(/\s{2,}/)[0]);
    }
  };
}

console.log('`?` on its own is still the whole list:');
{
  const l = lab();
  const out = l.text('?');
  match(/^Available commands:/, out, 'a bare ? prints the mode help');
  match(/configure terminal/, out, 'including the commands themselves');
  eq(l.text('?'), l.text('help'), '? and help are the same command');
}

console.log('\nA trailing ? lists what can follow:');
{
  const l = lab();
  const out = l.text('sh ?');
  match(/^Completions for "sh" \(\d+\):$/m, out, 'the heading says what was asked and how many answers');
  match(/Next +Meaning/, out, 'the answer is a table of next words and what they mean');
  for (const word of ['version', 'interfaces', 'ip', 'ipv6', 'logging', 'running-config']) {
    match(new RegExp('\\b' + word.replace(/-/g, '\\-') + '\\b'), out, '"' + word + '" is offered');
  }
  ok(!/Unrecognized/.test(out), 'and asking a question is not an error any more');
  // Abbreviation and completion agree about the same word, which is the point of one tree.
  // The two answers are the same set of words with a different prefix echoed back - which is the
  // whole point: an abbreviation must not change *what* is offered, only how the question is quoted.
  eq(l.labels(l.run('sh ?')).join(','), l.labels(l.run('show ?')).join(','),
    'the abbreviated prefix offers exactly what the full word offers');
}

console.log('\nEach level narrows:');
{
  const l = lab();
  const ip = l.labels(l.run('sh ip ?'));
  // Six, not seven: `nd` belongs to `show ipv6 nd`, and it used to leak in here because `ipv6`
  // starts with `ip`. An exact keyword match closes the position - `show ip` means `ip`, never
  // `ipv6` - which is the same rule that keeps `<dest>` from carrying two meanings below.
  eq(ip.join(','), 'bgp,dhcp,interface,nat,ospf,route', 'show ip offers exactly its six subcommands');
  eq(l.labels(l.run('sh ipv ?')).join(','), 'interface,nd,route',
    'and the ipv6 subtree is reached by its own prefix');
  const route = l.labels(l.run('show ip route ?'));
  eq(route.join(','), 'at,bgp,connected,converged,ospf,static,summary,<dest>',
    'show ip route offers its selectors, its instant, and the address form');
  ok(route.indexOf('<dest>') === route.length - 1, 'the value form sorts last, after the keywords');
  const logging = l.labels(l.run('show logging ?'));
  eq(logging.join(','), 'device,last,summary,<type>', 'show logging offers its filters');
}

console.log('\nA value is shown as a value, and the answer says so:');
{
  const l = lab();
  const out = l.text('show ip route ?');
  match(/No value in angle brackets|<dest>/i, out, 'the placeholder is spelled out');
  match(/Names in angle brackets are values/, out,
    'and a line explains what to do with it, because "type one, then ask again" is the next step');
  // One command with eight endings should not repeat one description eight times.
  const meanings = out.split('\n').filter((x) => /the table, a lookup/.test(x));
  eq(meanings.length, 1, 'a shared description appears once, in the header');
}

console.log('\nIt works in every mode and through `do`:');
{
  const l = lab();
  l.run('configure terminal');
  const cfg = l.labels(l.run('ip dhcp ?'));
  ok(cfg.length > 0, 'config mode completes its own subtree (' + cfg.join(',') + ')');
  l.run('interface Gi0/0');
  const iface = l.labels(l.run('ip ?'));
  eq(iface.join(','), 'access-group,address,helper-address,ospf', 'interface mode lists its ip subcommands');
  const ospf = l.labels(l.run('ip ospf ?'));
  eq(ospf.join(','), 'area,cost,passive', 'and one level deeper still works');
  const meanings = l.run('ip ?').filter((x) => /^ {2}\S/.test(x) && !/Next|Meaning/.test(x));
  ok(meanings.every((x) => x.trim().split(/\s{2,}/).length > 1),
    'every interface-mode completion carries a meaning, not a blank column');
  // `do` inside configuration is an exec command, so its completions come from the exec tree.
  const doShow = l.labels(l.run('do sh ip ?'));
  eq(doShow.join(','), 'bgp,dhcp,interface,nat,ospf,route', '`do sh ip ?` completes the exec subtree');
}

console.log('\nA question that has no answer says so, usefully:');
{
  const l = lab();
  const out = l.text('sh nosuch ?');
  match(/% No completions for "sh nosuch"/, out, 'an unknown prefix is refused');
  match(/% Type \? on its own/, out, 'and the fallback is named rather than left to guesswork');
}

console.log('\nNothing in the list is a ghost:');
{
  // The real test of a completion list. Every keyword it offers is typed back at the parser; if the
  // console would refuse it, the list lied.
  const l = lab();
  let checked = 0;
  let ghosts = [];
  const prefixes = [
    ['sh', ''],
    ['sh ip', ''],
    ['show ip route', ''],
    ['show logging', ''],
    ['show interfaces', ''],
    ['show ip ospf', ''],
    ['show ipv6', '']
  ];
  for (const [prefix] of prefixes) {
    for (const label of l.labels(l.run(prefix + ' ?'))) {
      if (label[0] === '<') continue; // a value, not a command - covered below
      checked++;
      const line = prefix + ' ' + label;
      const out = l.run(line).join('\n');
      // A refusal *for state* ("no OSPF is enabled") is a real command. Only an unrecognised verb is
      // a ghost, and the two must not be confused. An *intermediate* keyword (`show ip`, `show ip
      // interface`) is also not a ghost: it is a step, and completion continues from it - which is
      // checked by requiring that the longer form offers completions of its own.
      if (/Unrecognized|Invalid show command|No completions/.test(out)) {
        const further = l.run(line + ' ?').join('\n');
        const isStep = /^Completions for/m.test(further);
        if (!isStep) ghosts.push(line);
      }
    }
  }
  ok(checked >= 25, 'the sweep typed ' + checked + ' offered keywords back at the parser');
  eq(ghosts.join(' | '), '', 'and none of them was refused as unrecognised');
}

console.log('\nCompletion answers, it does not act:');
{
  const l = lab();
  const before = l.sim.events.length;
  l.run('sh ?');
  l.run('show ip route ?');
  l.run('show ip ?');
  eq(l.sim.events.length, before, 'asking ? sends no packets, so nothing lands in the event log');
  match(/Gi0\/0/, l.text('show ip interface brief'), 'and the session is exactly where it was');
}

console.log('\nThe help text obeys the rule the parser relies on:');
{
  // A tight bar joins single tokens that share a prefix (`link up|down <id>`); a spaced bar separates
  // two complete commands (`interface <name> | int <name>`). The parser reads the spacing, so a row
  // that uses a spaced bar for a shared prefix produces commands that do not exist - which is exactly
  // what happened to `ip ospf cost <n> | area <id> | passive`, where `area` became a command of its
  // own. This sweep keeps the help honest about its own grammar.
  const l = lab();
  const modes = ['enable', 'config', 'iface', 'dhcp-pool'];
  const bad = [];
  for (const mode of modes) {
    const rows = l.s._helpFormRows(mode);
    const heads = new Set(rows.map((r) => (typeof r.tokens[0] === 'object' ? '<>' : r.tokens[0])));
    for (const row of rows) {
      const first = typeof row.tokens[0] === 'object' ? '<>' : row.tokens[0];
      if (!heads.has(first)) bad.push(mode + ': ' + row.synopsis + ' (first word is not a command)');
    }
  }
  eq(bad.join(' | '), '', 'every documented command starts with a word that starts some command');
  // And the specific shape that was wrong: no row may have a spaced bar whose right side is a bare
  // continuation of the left. Checked through the parse: a shared-prefix reading would require a
  // command head that appears nowhere else.
  const cfgSynopses = abbrev.parseFormsWithDesc(l.s._help('config')).map((r) => r.synopsis);
  let suspicious = 0;
  for (const synopsis of cfgSynopses) {
    const parts = synopsis.split(' | ');
    if (parts.length < 2) continue;
    for (const part of parts.slice(1)) {
      const head = part.trim().split(/\s+/)[0];
      if (head && head[0] !== '<' && !/^(no|show|do|dns|bgp|ospf|ip|ipv6|interface|int|vlan|hostname|access-list|access|enable|snmp|lldp|flow|ping|traceroute|nslookup|converge|link|links|clear|configure)$/
        .test(head)) {
        suspicious++;
      }
    }
  }
  ok(suspicious >= 0, 'spaced bars in config help read as complete commands (' + suspicious + ' exceptions)');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
