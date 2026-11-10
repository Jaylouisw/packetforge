'use strict';
// abbrev-ambiguity: `ip rou` is ambiguous between route and routing - and that is the right answer
// alone, and the wrong answer when the rest of the line can only be one of them.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');
let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; console.log('  \u2713 ' + m); } else { failed++; console.error('  \u2717 ' + m); } }
function match(re, h, m) {
  if (h && Array.isArray(h.output)) h = h.output;
  const t = Array.isArray(h) ? h.join('\n') : String(h);
  ok(re.test(t), m + (re.test(t) ? '' : ' (no match in ' + JSON.stringify(t.slice(0, 300)) + ')'));
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const R = catalog.filter(function (x) { return x.model === 'generic-router'; })[0];
const t = new Topology(); const r = t.addDevice(R); r.name = 'R1';
const s = new CliSession(r, t, new Simulator(t)); s.run('enable'); s.run('configure terminal');
console.log('\nTwo commands share a prefix now, and the console says so:');
match(/Ambiguous command: "ip rou"/, s.run('ip rou'), 'the bare prefix is ambiguous');
match(/Candidates: route, routing/, s.run('ip rou'), 'and the candidates are listed');
console.log('\nBut the rest of the line decides when only one of them can take it:');
match(/Route added: 0\.0\.0\.0\/0 via 10.0.0.254/, s.run('ip rou 0.0.0.0 0.0.0.0 10.0.0.254'),
  'ip rou <net> <mask> <gw> is ip route');
match(/IP routing is already enabled on R1/, s.run('ip routing'), 'ip routing is still its own command');
match(/Ambiguous command: "ip r"/, s.run('ip r'),
  'a shorter prefix is still ambiguous - IOS stops there too, and so does this');
match(/IP routing is already enabled on R1/, s.run('ip routi'),
  'while the shorter of the two spellings resolves once it can only mean one');
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
