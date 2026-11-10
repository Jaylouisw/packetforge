'use strict';
// keyword-abbrev.test.js - the help row is the abbreviation source, so a keyword written as a
// placeholder is a keyword nobody can abbreviate.
//
//   SW1(config-if)#switchport mode acc                      -> Switchport mode access on Fa0/1
//   SW1(config-if)#switchport port-security violation rest  -> % "rest" is not a violation mode
//
// Both rows are keyword sets; only the first was spelled out, so only the first joined the tree the
// abbreviator expands against. The fix was one row, and the guard is the rule behind it: every
// alternative a page prints for a keyword argument must be a word the parser accepts.
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

function switchLab() {
  const t = new Topology();
  const sw = t.addDevice(find('generic-switch')); sw.name = 'SW1';
  const s = new CliSession(sw, t, new Simulator(t));
  s.run('enable');
  return { t: t, sw: sw, s: s };
}

console.log('\nEvery violation mode is accepted, and so is any prefix that identifies one:');
{
  const env = switchLab();
  env.s.run('configure terminal'); env.s.run('interface Fa0/1');
  for (const [typed, expected] of [['protect', 'protect'], ['restrict', 'restrict'], ['shutdown', 'shutdown'],
    ['prot', 'protect'], ['rest', 'restrict'], ['shut', 'shutdown'], ['shu', 'shutdown'], ['res', 'restrict']]) {
    const out = text(env.s.run('switchport port-security violation ' + typed));
    // "already shutdown" is the same acceptance: the mode the word names is the mode in force.
    const hit = new RegExp('set to ' + expected).test(out) || new RegExp('already ' + expected).test(out);
    ok(hit, '"' + typed + '" sets ' + expected + (hit ? '' : ' (got ' + JSON.stringify(out.slice(0, 120)) + ')'));
  }
  const bogus = text(env.s.run('switchport port-security violation zz'));
  ok(/is not a violation mode/.test(bogus), 'a word that identifies nothing is still refused');
  ok(/protect/.test(bogus) && /restrict/.test(bogus) && /shutdown/.test(bogus),
    'and the refusal names the three modes');
}

console.log('\nThe alternatives a page prints for a keyword argument are words the parser takes:');
{
  // Sweep every config/interface row whose synopsis offers `a|b|c` with no placeholder in the
  // alternation, and type each alternative at the device. A row that prints a keyword the parser
  // refuses is a wider version of the same defect.
  const modes = [
    { enter: 'configure terminal', rows: null, label: 'config' },
    { enter: ['configure terminal', 'interface Fa0/1'], rows: null, label: 'interface' }
  ];
  for (const m of modes) {
    const env = switchLab();
    (Array.isArray(m.enter) ? m.enter : [m.enter]).forEach(function (l) { env.s.run(l); });
    const page = env.s.run('?');
    const rows = text(page).split('\n')
      .map(function (l) { return l.trim(); })
      .filter(function (l) { return l && l.indexOf('?') === -1; });
    // The synopsis is the first column; take it up to two or more spaces.
    const synopses = rows.map(function (l) { return l.split(/\s{2,}/)[0]; })
      .filter(function (s) {
        // Ordinary control flow, not an exemption: a synopsis with no alternation, or with a
        // placeholder, is simply not one of the rows this sweep can type.
        if (!/\|/.test(s) || s.indexOf('<') !== -1) return false;
        // A row whose first column swallowed part of its description (no double space in the source
        // list) is not a synopsis: a real one never repeats a word.
        const w = s.split(/\s+/);
        return new Set(w).size === w.length;
      });
    let checked = 0;
    for (const syn of synopses) {
      const words = syn.split(/\s+/);
      const groups = words.filter(function (w) { return w.indexOf('|') !== -1; });
      for (const g of groups) {
        // Build the line with this group set to each alternative, and the other groups at their
        // first alternative, so the line is one the device can actually parse.
        const line = words.map(function (w) {
          if (w.indexOf('|') === -1) return w;
          return w.split('|')[0];
        });
        for (const alt of g.split('|')) {
          const candidate = words.map(function (w, i) { return w === g ? alt : line[i]; }).join(' ');
          const out = text(env.s.run(candidate));
          const refused = /% (Unrecognized|Invalid|Usage|is not|Unknown|no such)/i.test(out.split('\n')[0] || '')
            || /^\s*%\s/.test(out);
          // Some alternatives legitimately refuse by capability on this device (a switch has no
          // OSPF); those are not abbreviation failures, so only a *syntax* complaint counts.
          const syntax = /% Unrecognized|% Invalid|% Usage/.test(out);
          ok(!syntax, m.label + ': "' + candidate + '" is a line the page\'s own words produce' +
            (syntax ? ' (' + JSON.stringify(out.split('\n')[0]) + ')' : ''));
          checked++;
          env.s.run('end');
          (Array.isArray(m.enter) ? m.enter : [m.enter]).forEach(function (l) { env.s.run(l); });
        }
      }
    }
    ok(checked >= 1, m.label + ': the sweep found keyword groups to check (' + checked + ')');
    env.s.run('end');
  }
}

console.log('\nThe guard on the source of truth:');
{
  const env = switchLab();
  env.s.run('configure terminal'); env.s.run('interface Fa0/1');
  const page = text(env.s.run('?'));
  ok(!/violation <mode>/.test(page), 'the violation row no longer hides its modes behind a placeholder');
  ok(/violation protect\|restrict\|shutdown/.test(page), 'it names them, so they join the abbreviation tree');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
