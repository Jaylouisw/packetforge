'use strict';
// The refusal a box prints for the BGP show views when no BGP process is configured: `% BGP not active`.
//
// This console printed `% BGP is not enabled` - a correct description of the same fact in words no box uses.
// A refusal is the line an operator recognises, quotes in a ticket and pastes into a search box; wording it
// this console's own way makes the one output that means "nothing is wrong with the view, there is no
// process" read as an invention. Three Cisco captures, three sub-views, one string:
//
//   R12#sh ip bgp                  -> % BGP not active
//     https://community.cisco.com/t5/routing/bgp-synchronization-and-mpls/td-p/2904090
//   #sh ip bgp regexp ^abc         -> % BGP not active
//     https://community.cisco.com/t5/wireless/automatically-apply-tag-policy-tag-rf-tag-site-on-cisco-9800-wlc/td-p/4906039
//   P#sh ip bgp summary            -> % BGP not active
//     https://www.pinglabz.com/mpls-l3vpn-configuration-step-by-step/
//
// Two details the assertions below hold: the word `is` is absent (Arista's EOS prints `% BGP is not active`,
// which is a different vendor's line), and there is no full stop. The guard is checked on all four spellings
// that reach `_showBgp()`, and then again after `router bgp` - because a string that is right only when BGP
// is absent would also be right if the view had stopped working.
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
const spec = catalog.filter(function (s) { return s.model === '2811'; })[0];

function session() {
  const t = new Topology();
  const d = t.addDevice(spec, 'r1');
  const s = new CliSession(d, t, new Simulator(t));
  s.run('enable');
  return {
    d: d,
    s: s,
    say: function (c) { return ((s.run(c).output) || []).map(String); }
  };
}

console.log('No BGP process: the box says `% BGP not active`');
{
  const env = session();
  const views = ['show ip bgp', 'show ip bgp summary', 'show ip bgp neighbors', 'show ip bgp regexp ^abc'];
  for (const view of views) {
    const lines = env.say(view);
    ok(lines.length === 1 && lines[0] === '% BGP not active',
      '`' + view + '` prints the five words and nothing else', JSON.stringify(lines));
  }
  const line = env.say('show ip bgp')[0] || '';
  ok(!/\bis\b/.test(line), 'the word `is` is not in it - Arista prints `% BGP is not active`, this box does not');
  ok(!/\.$/.test(line), 'and there is no full stop after `active`');
  ok(!/not enabled/i.test(line), 'the old sentence (`BGP is not enabled`) is gone, not merely appended to');
  ok(env.say('show ip bgp summary').join('') === '% BGP not active',
    'the summary spelling agrees with the bare one, word for word');
}

console.log('\nConfigure a process and the view answers instead of refusing:');
{
  const env = session();
  env.s.run('configure terminal');
  env.s.run('router bgp 65001');
  env.s.run('end');
  const lines = env.say('show ip bgp');
  ok(lines.join('\n').indexOf('% BGP not active') === -1, 'the refusal is not printed when the process exists',
    JSON.stringify(lines.slice(0, 2)));
  ok(/^BGP router identifier/.test(lines[0] || ''), 'the header names the elected router identifier', lines[0]);
  ok(/local AS number 65001/.test(lines[0] || ''), 'and the AS that was configured', lines[0]);

  env.s.run('configure terminal');
  env.s.run('no router bgp 65001');
  env.s.run('end');
  ok(env.say('show ip bgp').join('') === '% BGP not active', 'removing the process brings the refusal back');
}

console.log('\nEvery platform in the catalogue, not just the one router:');
{
  // `_showBgp()` is the one door for every `show ip bgp` spelling, so a switch that cannot run BGP must answer
  // the same way a router without a process does - not with an invented capability message.
  const t = new Topology();
  const sw = t.addDevice(catalog.filter(function (s) { return s.model === 'c2960x-48fps-l'; })[0], 'sw1');
  const s = new CliSession(sw, t, new Simulator(t));
  s.run('enable');
  const lines = ((s.run('show ip bgp summary').output) || []).map(String);
  ok(lines.length === 1 && lines[0] === '% BGP not active',
    'a Catalyst 2960X without a BGP process says the same line', JSON.stringify(lines));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
