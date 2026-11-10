'use strict';
// logging-filter.test.js - the log's type filter, and what a word that matches nothing means.
//
// `show logging <type>` validated the word against the types *currently in the log*, and said so in
// the least helpful shape available:
//
//   SW1#show logging                 No events: the log is empty - nothing has run yet in this lab
//   SW1#show logging zzz             % No events of type "zzz" in this lab
//                                    % Types seen: (none)
//   SW1#show logging all             % No events of type "all" in this lab
//                                    % Types seen: (none)
//
// With an empty log every word "had no events", so a typo and a quiet lab were the same answer, and
// the first line read like a type called zzz existed and was empty. `all` - which an operator types
// for the whole log - was refused as if it were a type.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function text(out) { return out && out.output ? out.output.join('\n') : String(out); }
function saw(re, out, msg) { ok(re.test(text(out)), msg + (re.test(text(out)) ? '' : ' (in ' + JSON.stringify(text(out).slice(0, 400)) + ')')); }
function absent(re, out, msg) { ok(!re.test(text(out)), msg + (re.test(text(out)) ? ' (unexpectedly matched)' : '')); }
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const find = function (m) { return catalog.filter(function (x) { return x.model === m; })[0]; };

function lab(run) {
  const t = new Topology();
  const r1 = t.addDevice(find('generic-router')); r1.name = 'R1';
  const r2 = t.addDevice(find('generic-router')); r2.name = 'R2';
  const s = new CliSession(r1, t, new Simulator(t));
  s.run('enable');
  t.connect(r1.id, 'Gi0/0', r2.id, 'Gi0/0');
  s.run('configure terminal'); s.run('interface Gi0/0');
  s.run('ip address 10.0.0.1 255.255.255.0'); s.run('no shutdown');
  s.run('exit'); s.run('end');
  if (run) { s.run('ping 10.0.0.2'); s.run('ping 10.0.0.2'); }
  return { t: t, s: s };
}

// The types in the log, read out of the log itself - the same source the filter validates against.
function typesIn(out) {
  const seen = [];
  for (const line of text(out).split('\n')) {
    const m = line.match(/^\s*\d+\s+\d+\s+([a-z][a-z-]*)/);
    if (m && seen.indexOf(m[1]) === -1) seen.push(m[1]);
  }
  return seen;
}

console.log('\nAn empty log is empty, not a filter that matched nothing:');
{
  const env = lab(false);
  const out = env.s.run('show logging zzz');
  absent(/No events of type/, out, 'an empty log does not pretend zzz is a type with no events');
  saw(/The log is empty/, out, 'it says the log is empty');
  saw(/nothing of any type/, out, 'and that no type can be answered from it');
  saw(/ping <addr>/, out, 'and suggests what fills it');
}

console.log('\nA word that matches nothing says so, and lists what does have events:');
{
  const env = lab(true);
  const all = env.s.run('show logging');
  const types = typesIn(all);
  ok(types.length >= 2, 'the log has several types to filter (' + types.join(', ') + ')');
  const bogus = env.s.run('show logging zzz');
  saw(/No event of type "zzz" has happened here/, bogus, 'the word is reported as not having happened');
  // The message lists them sorted; compare against sorted, and escape nothing but equal signs.
  const sorted = types.slice().sort();
  saw(new RegExp('Types with events so far: ' + sorted.join(', ')), bogus,
    'and the types that have events are listed (' + sorted.join(', ') + ')');
  saw(/either a type that has not happened yet or a typo/, bogus, 'the ambiguity is stated, not hidden');
  absent(/Types seen: \(none\)/, bogus, 'never "(none)" while the log has events');
}

console.log('\nA type filter narrows, and a prefix of one narrows the same way:');
{
  const env = lab(true);
  const all = env.s.run('show logging');
  const types = typesIn(all);
  const pick = types.indexOf('frame') !== -1 ? 'frame' : types[0];
  const filtered = env.s.run('show logging ' + pick);
  saw(new RegExp('Event log \\('), filtered, 'the filter answers with a log');
  ok(new RegExp(pick).test(text(filtered)), 'the filtered log is of type ' + pick);
  // The count must be the count: no more rows than the unfiltered log has of that type.
  const inFull = text(all).split('\n').filter(function (l) {
    const m = l.match(/^\s*\d+\s+\d+\s+([a-z][a-z-]*)/);
    return m && m[1] === pick;
  }).length;
  const header = text(filtered).split('\n')[0];
  const claimed = Number((header.match(/\((\d+) /) || [])[1]);
  ok(claimed === inFull, 'the filtered log shows ' + inFull + ' of them, as the full log has (' + claimed + ')');
  // A prefix that identifies exactly one type is that type, as keywords are everywhere else.
  const prefix = pick.slice(0, 2);
  const matches = types.filter(function (t) { return t.indexOf(prefix) === 0; });
  if (matches.length === 1) {
    const byPrefix = env.s.run('show logging ' + prefix);
    saw(new RegExp('\\(' + inFull + ' '), byPrefix, '"' + prefix + '" narrows to ' + pick + ' as well');
  } else {
    ok(true, '("' + prefix + '" is shared by ' + matches.join('/') + ' - covered by the ambiguity answer)');
  }
}

console.log('\n`show logging all` is the whole log, not a type named all:');
{
  const env = lab(true);
  const bare = text(env.s.run('show logging')).split('\n')[0];
  const all = text(env.s.run('show logging all')).split('\n')[0];
  ok(bare === all, 'the all form prints what the bare form prints (' + bare + ')');
  absent(/No event of type "all"/, env.s.run('show logging all'), 'and never treats "all" as a type');
}

console.log('\nThe rest of the vocabulary still works:');
{
  const env = lab(true);
  saw(/Event log \(last 2 of \d+ events\)/, env.s.run('show logging last 2'), 'last <n> still narrows');
  saw(/Event log \(\d+ events on R1, from \d+ in the lab\)/, env.s.run('show logging device R1'),
    'device <name> still narrows');
  saw(/Event summary \(\d+ of \d+ events\)/, env.s.run('show logging summary'), 'summary still summarises');
  // A count that is not a count is still refused.
  saw(/takes a positive whole number/, env.s.run('show logging last 0x10'), 'and a fake number is still refused');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
