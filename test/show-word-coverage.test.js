'use strict';
// show-word-coverage.test.js - a view that answers is a view the page names.
//
//   R1#show inventory
//   % There is no inventory: this model has no serial numbers, no FRUs and no modules
//   R1#show inv
//   % Invalid show command: inv
//   R1#show inventory ?
//   % No completions for "show inventory"
//
// The console answered the question and could not be found asking it: `show inventory` had no help row,
// so it could not be abbreviated (abbreviation resolves against the page) and `?` said it was a typo.
// Twenty-five words were in that state - the hardware questions an operator asks to orient on a box
// they have never seen: inventory, chassis, module, stack, cpu, processes, memory, buffers,
// controllers, environment, diagnostic(s), selftest, flash, filesystems, boot, license, ntp, line,
// sessions, dhcp.
//
// The rules:
//   1. A word the parser answers is a word the page names - otherwise the only spellings that work are
//      the ones nobody types in full.
//   2. The shortest unique abbreviation of it therefore works too.
//   3. A word that answers only with a capability refusal is not one of these: it is hidden on purpose,
//      and the capability sweep already owns that case.
const fs = require('fs');
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

function session(model) {
  const t = new Topology();
  const d = t.addDevice(find(model)); d.name = 'D1';
  return { t: t, d: d, s: new CliSession(d, t, new Simulator(t)) };
}

console.log('The hardware views answer, and now they are on the page:');
{
  const env = session('generic-router');
  env.s.run('enable');
  const page = text(env.s.run('show ?'));
  const WORDS = ['inventory', 'chassis', 'module', 'stack', 'cpu', 'processes', 'memory', 'buffers',
    'controllers', 'environment', 'diagnostic', 'diagnostics', 'selftest', 'flash', 'filesystems',
    'boot', 'license', 'ntp', 'line', 'sessions', 'dhcp'];
  const missing = WORDS.filter(function (w) {
    // The page's row may list several spellings separated by ` | `.
    return page.indexOf('show ' + w) === -1 && !new RegExp('\\b' + w + '\\b').test(page);
  });
  ok(missing.length === 0, 'every answering word is on the page' + (missing.length ? ' - missing ' + missing.join(', ') : ''));
  for (const w of WORDS) {
    const direct = text(env.s.run('show ' + w));
    // The answer is either the view or an honest explanation of what this model keeps - never the
    // vocabulary of an unknown command.
    ok(!/^% (Invalid|Unrecognized|No completions)/.test(direct),
      'show ' + w + ' answers with what this model keeps');
  }
}

console.log('\n...so its abbreviation reaches the same view:');
{
  const env = session('generic-router');
  env.s.run('enable');
  const PAIRS = [
    ['inv', 'inventory'], ['proc', 'processes'], ['mem', 'memory'], ['env', 'environment'],
    ['flash', 'flash'], ['ntp', 'ntp'], ['line', 'line'], ['sess', 'sessions'], ['boot', 'boot'],
    ['lic', 'license'], ['chassis', 'chassis'], ['mod', 'module'], ['stac', 'stack']
  ];
  for (const [short, full] of PAIRS) {
    const a = String(text(env.s.run('show ' + short))).split('\n')[0];
    const b = String(text(env.s.run('show ' + full))).split('\n')[0];
    ok(!/Invalid show command|Unrecognized/.test(a), 'show ' + short + ' is recognised');
    ok(a === b, '  and answers what show ' + full + ' answers');
  }
  // Two real spellings of one word are an ambiguity, not a typo: `show diag` could be either.
  const amb = text(env.s.run('show diag'));
  ok(/Ambiguous|diagnostic/i.test(amb), 'show diag names the two spellings it could be');
}

console.log('\nThe sweep behind it: a word the parser answers is a word the page names:');
{
  // Every quoted lowercase literal in the console is a candidate word - that is where the dispatch
  // compares against `'inventory'`, `'processes'` and the rest. Type them all at three device kinds,
  // and check the answer against the *unfiltered* page: a word that is documented nowhere is a view an
  // operator can only reach by spelling it out correctly. A word documented but hidden on this device
  // is the capability gate's case, not this one - that suite asserts hidden rows are refused.
  const src = fs.readFileSync(path.join(__dirname, '..', 'engine', 'cli.js'), 'utf8');
  const words = new Set();
  for (const m of src.matchAll(/'([a-z][a-z0-9-]{2,13})'/g)) words.add(m[1]);
  const documented = function (rows) {
    // Rows are parsed objects: `tokens` is the word list after the page's own grammar has split the
    // alias unions (`show chassis | show module` is two rows), so the second token is the word.
    const out = new Set();
    for (const row of rows) {
      const toks = row && row.tokens ? row.tokens : String(row).trim().split(/\s+/);
      if (String(toks[0] || '').toLowerCase() !== 'show') continue;
      const w = toks[1];
      if (typeof w === 'string') out.add(w.toLowerCase());
    }
    return out;
  };
  let typed = 0;
  const orphans = [];
  for (const model of ['generic-router', 'generic-switch', 'generic-pc']) {
    const env = session(model);
    env.s.run('enable');
    const all = documented(env.s._helpFormRowsAll(3));
    for (const w of words) {
      typed++;
      const first = String(text(env.s.run('show ' + w))).split('\n')[0];
      // Not an exemption, ordinary control flow: a word the console refuses outright is not a view,
      // and this loop is asking which words are views.
      if (/^% Invalid show command|^% Unrecognized|^% No completions/.test(first)) continue;
      if (all.has(w)) continue;
      const isAbbrev = Array.from(all).some(function (sw) { return sw.indexOf(w) === 0 || w.indexOf(sw) === 0; });
      if (isAbbrev) continue;
      orphans.push(model + ': show ' + w);
    }
  }
  ok(typed > 1000, 'the sweep typed the candidate vocabulary (' + typed + ' commands)');
  ok(orphans.length === 0, 'and every answered word is documented somewhere'
    + (orphans.length ? ' - ' + orphans.slice(0, 5).join(', ') : ''));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
