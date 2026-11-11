'use strict';
// pipe-help.test.js - the filter's own help, and its names abbreviating like keywords.
//
//   SW1#show running-config | include ?
//   (nothing in this answer matches "| include ?" - the command printed 10 lines)
//   SW1#show running-config | c
//   % There is no "| c" here - this console filters with include, exclude, begin, section and count
//   SW1#show running-config ?
//   "show running-config" is as far as this command goes - nothing follows it
//
// Three shapes of one gap: the pipe is the filter an operator types on every third command, and the
// `?` page answered for none of it. `?` was read as the text to look for, so the console filtered on
// the help character and reported that nothing matched; the five filter names were matched with === ,
// so a legitimate abbreviation was refused by a sentence that then listed the five full words; and
// the command's own page said nothing follows a view whose output is filterable.
//
// The rule: a keyword abbreviates in every position (the filter names are keywords), `?` is always
// the help character and never data, and a page that says what may follow includes the pipe.
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
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const find = function (m) { return catalog.filter(function (x) { return x.model === m; })[0]; };

function switchSession() {
  const t = new Topology();
  const sw = t.addDevice(find('generic-switch')); sw.name = 'SW1';
  const sim = new Simulator(t);
  const s = new CliSession(sw, t, sim); s.run('enable');
  s.run('configure terminal'); s.run('vlan 10'); s.run('vlan 20'); s.run('end');
  return s;
}

console.log('? is the help character inside a filter, never the text to look for:');
{
  const s = switchSession();
  const out = text(s.run('show running-config | include ?'));
  ok(/^Filters for "show running-config":/.test(out), 'the page names the command being filtered');
  ok(!/nothing in this answer matches/.test(out), 'and does not filter on the ?');
  for (const word of ['| include <text>', '| exclude <text>', '| begin <text>', '| section <text>', '| count']) {
    ok(out.indexOf(word) !== -1, 'it lists ' + word);
  }
  ok(/plain text, case-insensitively/.test(out), 'and says the text is plain, not a regular expression');
  ok(/takes the text to look for, e\.g\. show running-config \| include vlan/.test(out),
    'and answers the question that was asked - what include takes');
  const countAsk = text(s.run('show running-config | count ?'));
  ok(/count takes no text/.test(countAsk), 'asking after | count says it takes no text');
  // The other two entry points are the same page.
  ok(/Filters for/.test(text(s.run('show running-config |?'))), '|? answers the same page');
  ok(/Filters for/.test(text(s.run('show running-config | ?'))), 'as does "| ?"');
}

console.log('\nA filter name abbreviates like every other keyword:');
{
  const s = switchSession();
  const full = text(s.run('show running-config | include vlan'));
  ok(/\bvlan 10\b/.test(full), 'the full spelling filters (control)');
  for (const abbr of ['i', 'in', 'inc']) {
    ok(text(s.run('show running-config | ' + abbr + ' vlan')) === full, '| ' + abbr + ' vlan is | include vlan');
  }
  const counted = text(s.run('show running-config | count'));
  ok(/^\d+ lines?$/.test(counted), '| count answers a count (control)');
  ok(text(s.run('show running-config | c')) === counted, '| c is | count');
  ok(text(s.run('show running-config | cou')) === counted, '| cou is | count');
  ok(text(s.run('show running-config | s interface')) === text(s.run('show running-config | section interface')),
    '| s is | section');
  ok(text(s.run('show running-config | b interface')) === text(s.run('show running-config | begin interface')),
    '| b is | begin');
  ok(text(s.run('show running-config | e vlan')) === text(s.run('show running-config | exclude vlan')),
    '| e is | exclude');
  // Chained, and the abbreviation keeps working after the chain.
  ok(text(s.run('show running-config | i vlan | c')) === '2 lines', 'filters chain and abbreviate together');
  // A word that is not a filter is still refused, by name.
  const bad = text(s.run('show running-config | x vlan'));
  ok(/^%/.test(bad), 'a word that is not a filter is refused');
  ok(/filters with include, exclude, begin, section and count/.test(bad), 'and the five names are listed');
}

console.log('\nA page that says what may follow includes the pipe:');
{
  const s = switchSession();
  const out = text(s.run('show running-config ?'));
  ok(/nothing follows it/.test(out), 'the command itself ends there - that fact is kept');
  ok(/The answer can be filtered - a pipe follows it:/.test(out), 'and the pipe is named as what does follow');
  ok(out.indexOf('| include <text>') !== -1, 'with the filters listed');
  const version = text(s.run('show version ?'));
  ok(/\| count/.test(version), 'the same on any view');
  // A command whose output is not filterable must not claim a pipe.
  const block = text(s.run('show'));
  ok(!/The answer can be filtered/.test(block), 'show with nothing typed is still an incomplete command');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
