'use strict';
// refusal-pointers.test.js — a refusal that names a command is a promise, and this file keeps it.
//
// `% BGP is not enabled` used to be the whole answer from `show ip bgp`, while `bgp neighbor …`
// answered `% BGP is not enabled (use "router bgp <as>")`. So the one place an operator is most
// likely to learn a feature is off — the show — was the one place that did not say how to turn it
// on. Worse, the same fact had four spellings across six call sites.
//
// The rule enforced here is stronger than "the message mentions a command": the quoted command is
// *typed back at the console* and has to work, and then the original command has to stop refusing.
// A hint that drifts off the real spelling (or off the real mode) fails this file.
const path = require('path');
const { Topology, Simulator, CliSession } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const ROUTER = catalog.find(function (s) { return s.model === 'generic-router'; });

// Placeholders a hint may use, and a value the console accepts for each.
const VALUES = {
  '<as>': '65001', '<ip>': '1.1.1.1', '<addr>': '10.0.0.254', '<id>': '10',
  '<isd-as>': '1-ff00:0:1', '<name>': 'lab.test', '<n>': '10'
};

function fill(cmd) {
  let text = String(cmd), unknown = null;
  text.split(/\s+/).forEach(function (tok) {
    if (/^<.*>$/.test(tok) && !VALUES[tok]) unknown = tok;
  });
  for (const k of Object.keys(VALUES)) text = text.split(k).join(VALUES[k]);
  return { text: text, unknown: unknown };
}

// Each case: how to reach the refusing state, the command that refuses, and where the hint's command
// has to be typed (a config verb, a per-port verb, or `enable` itself).
const CASES = [
  { name: 'show ip bgp', pre: ['enable'], cmd: 'show ip bgp', fixMode: 'config' },
  { name: 'show ip ospf', pre: ['enable'], cmd: 'show ip ospf', fixMode: 'config' },
  { name: 'show ip ospf neighbor', pre: ['enable'], cmd: 'show ip ospf neighbor', fixMode: 'config' },
  { name: 'show vrrp', pre: ['enable'], cmd: 'show vrrp', fixMode: 'iface' },
  { name: 'show scion', pre: ['enable'], cmd: 'show scion', fixMode: 'config' },
  { name: 'bgp neighbor … remote-as', pre: ['enable', 'configure terminal'], cmd: 'bgp neighbor 10.0.12.2 remote-as 65002', fixMode: 'config' },
  { name: 'ip ospf area', pre: ['enable', 'configure terminal', 'interface Gi0/0'], cmd: 'ip ospf area 0', fixMode: 'config' },
  { name: 'vrrp priority without a group', pre: ['enable', 'configure terminal', 'interface Gi0/0'], cmd: 'vrrp 10 priority 120', fixMode: 'iface' },
  { name: 'dns add before a zone exists', pre: ['enable', 'configure terminal'], cmd: 'dns add www.lab.test A 10.0.0.1', fixMode: 'config' },
  { name: 'clear counters at the user prompt', pre: [], cmd: 'clear counters', fixMode: 'enable' },
  { name: 'clear logging at the user prompt', pre: [], cmd: 'clear logging', fixMode: 'enable' },
  { name: 'write memory at the user prompt', pre: [], cmd: 'write memory', fixMode: 'enable' }
];

for (const c of CASES) {
  const t = new Topology();
  const r = t.addDevice(ROUTER);
  r.name = 'R1';
  const sim = new Simulator(t);
  const s = new CliSession(r, t, sim);
  c.pre.forEach(function (p) { s.run(p); });
  const refused = s.run(c.cmd).output.join('\n');
  ok(/^%/.test(refused.trim()), c.name + ' refuses when the prerequisite is missing');
  const quoted = (refused.match(/"([^"]+)"/) || [])[1];
  ok(!!quoted, c.name + ' names a command to fix it: ' + JSON.stringify(quoted || ''));
  if (!quoted) continue;
  const filled = fill(quoted);
  ok(!filled.unknown, c.name + ' hint uses a placeholder the test can fill' +
    (filled.unknown ? ' (' + filled.unknown + ')' : ''));

  // Type the hint back, in the mode it claims to need.
  if (c.fixMode === 'config' && !/^enable$/.test(filled.text)) {
    s.run('configure terminal');
  } else if (c.fixMode === 'iface') {
    s.run('configure terminal');
    s.run('interface Gi0/0');
  }
  const fixOut = s.run(filled.text).output.join('\n');
  ok(!/^%/.test(fixOut.trim()), c.name + ' hint "' + filled.text + '" works as written' +
    (/^%/.test(fixOut.trim()) ? ' (answered ' + fixOut.trim() + ')' : ''));
  ok(!/^%/.test(fixOut.trim()) || !/needs enable mode/.test(fixOut),
    c.name + ' hint does not land in the same refusal');

  // And the original command must stop refusing. `end` first, because a config or interface block is
  // not where a show belongs; then `enable`, because leaving configuration never grants privilege.
  s.run('end');
  if (c.pre.indexOf('enable') === 0 || c.fixMode === 'enable') s.run('enable');
  // Back into the mode the command belongs to: a config verb is not an exec command, and an
  // interface-mode verb needs the interface block again. Leaving configuration never grants privilege,
  // which is why `enable` is replayed before the mode is.
  c.pre.forEach(function (p) { if (p !== 'enable') s.run(p); });
  const after = s.run(c.cmd).output.join('\n');
  ok(!/^%/.test(after.trim()), c.name + ' answers after its hint is followed' +
    (/^%/.test(after.trim()) ? ' (still ' + after.trim() + ')' : ''));
}

// The wording is one string per feature, so two doors cannot disagree about the same fact.
{
  const t = new Topology();
  const r = t.addDevice(ROUTER);
  r.name = 'R1';
  const sim = new Simulator(t);
  const s = new CliSession(r, t, sim);
  s.run('enable');
  const show = s.run('show ip bgp').output.join('\n');
  s.run('configure terminal');
  const verb = s.run('bgp router-id 1.1.1.1').output.join('\n');
  ok(show === verb, 'the show and the verb answer a missing prerequisite identically');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
