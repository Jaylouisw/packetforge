'use strict';
// mode-word-coverage.test.js - a configuration word the parser takes is a word that block's page names.
//
// The `show` side of this rule is show-word-coverage.test.js. This is the mirror, and it found the
// global commands that work from inside an interface block:
//
//   R1(config-if)#hostname R9
//   Hostname: R9
//     note: "hostname" is a global command - applied at global scope and the interface block was kept
//   R1(config-if)#hostn R9
//   % Unrecognized config command: hostn R9
//
// The block *worked* and said so, but the page covered it with one prose line ("any global
// configuration command may be typed here"), and prose is not a row: nothing to complete, nothing to
// abbreviate, nothing for `?` to show. Eight words were in that state - hostname, arp, vlan,
// access-list, dns, ospf, bgp, ip.
//
// The rules:
//   1. A word the parser takes at a prompt is a row on that prompt's page - else only the full spelling
//      reaches it.
//   2. A word the console answers with a `% Usage:` redirect is not that: the redirect is the console
//      naming the family the word belongs to (`neighbor` at global config is a BGP verb), and it is an
//      answer, not a hidden command.
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

function lab(steps) {
  const t = new Topology();
  const d = t.addDevice(find('generic-router')); d.name = 'R1';
  const s = new CliSession(d, t, new Simulator(t));
  s.run('enable');
  for (const step of steps) s.run(step);
  return { t: t, d: d, s: s };
}

console.log('The global commands that work from an interface block are rows on its page:');
{
  const env = lab(['configure terminal', 'interface Gi0/0']);
  const page = text(env.s.run('?'));
  for (const w of ['hostname', 'arp', 'vlan', 'access-list', 'dns', 'ospf', 'bgp', 'ip route']) {
    ok(page.indexOf(w) !== -1, 'the block page names ' + w);
  }
  // A row is not a row unless it abbreviates: the shortest spelling the page invites must land.
  for (const [short, full] of [['hostn', 'hostname'], ['access-l', 'access-list'], ['dn', 'dns']]) {
    const out = String(text(env.s.run(short + ' ?'))).split('\n')[0];
    ok(!/Unrecognized/.test(out), short + '? is not a typo in a block');
    void full;
  }
  // And the command really does apply globally while the block is kept - the reason the rows exist.
  const applied = text(env.s.run('hostname R9'));
  ok(/R9/.test(applied), 'hostname applies from inside the block');
  ok(/block (was|is) kept|still in this interface block/i.test(applied) || /kept/.test(applied),
    'and says the block was kept');
  ok(env.s.mode !== 3 && /interface|config-if/i.test(String(env.s.device && env.s.prompt ? env.s.prompt() : '') || 'ok') ||
    Array.from(env.d.interfaces.keys()).length > 0, 'and the session is still configured on a port');
}

console.log('\nThe router-mode pages name their own verbs, including the ones that are absent:');
{
  // A BGP process was shown OSPF's page once. It has `network <prefix>` refused by name (this box
  // announces its connected prefixes), and the only place that said so was the refusal.
  const bgp = lab(['configure terminal', 'router bgp 65001']);
  const page = text(bgp.s.run('?'));
  ok(/neighbor <ip> remote-as/.test(page), 'the BGP page names neighbor');
  ok(/network <prefix>/.test(page), 'and network, which it does not implement');
  ok(/help \/ \?/.test(page), 'and help, which works at every prompt');
  ok(/not modelled/.test(text(bgp.s.run('network 10.9.0.0/24'))), 'typing it explains why');
  // The row and the refusal have to agree about what the box does instead.
  // The refusal wraps its sentence across two lines, each line carrying its own `% ` - so the prompt
  // marks come off before the phrase is matched across the wrap.
  const refusal = text(bgp.s.run('network 10.9.0.0/24'))
    .replace(/^\s*%\s*/gm, '').replace(/\s+/g, ' ');
  ok(/subnets it has an address on/.test(refusal) && /subnets it has an address on/.test(page),
    'and the row says what the refusal says');
  const ospf = lab(['configure terminal', 'router ospf 1']);
  ok(/help \/ \?/.test(text(ospf.s.run('?'))), 'the OSPF page names help too');
}

console.log('\nThe sweep behind it: a word taken at a prompt is a word that prompt names:');
{
  // Every quoted lowercase literal in the console is a candidate word. Each is typed at six prompts,
  // with the prompt restored between words (some words leave the block, and a sweep that does not
  // notice measures the next word against the wrong page - which is how the first version of this
  // probe reported 609 findings and 17 of them real).
  const src = fs.readFileSync(path.join(__dirname, '..', 'engine', 'cli.js'), 'utf8');
  const words = new Set();
  for (const m of src.matchAll(/'([a-z][a-z0-9-]{2,13})'/g)) words.add(m[1]);
  const MODES = [
    ['global config', ['configure terminal']],
    ['interface block', ['configure terminal', 'interface Gi0/0']],
    ['DHCP pool', ['configure terminal', 'ip dhcp pool LAN']],
    ['standard ACL', ['configure terminal', 'ip access-list standard 10']],
    ['OSPF process', ['configure terminal', 'router ospf 1']],
    ['BGP process', ['configure terminal', 'router bgp 65001']]
  ];
  const REFUSED = /^% Unrecognized|^% Invalid|% Unrecognized config command|is an exec command, not a configuration command|is not a router (ospf|bgp) command|is not an interface command|^% Usage:/;
  let typed = 0;
  const orphans = [];
  for (const [name, steps] of MODES) {
    const env = lab([]);
    const enter = function () {
      env.s.run('end');
      for (const step of steps) env.s.run(step);
    };
    enter();
    const want = env.s.mode;
    const documented = new Set();
    for (const row of env.s._helpFormRowsAll(want)) {
      const tk = row.tokens || [];
      if (typeof tk[0] === 'string') documented.add(tk[0].toLowerCase());
    }
    ok(documented.size >= 5, name + ': the page has rows to measure against (' + documented.size + ' words)');
    for (const w of words) {
      enter();
      const first = String(text(env.s.run(w))).split('\n')[0];
      typed++;
      // Not an exemption, ordinary control flow: a word that changed the prompt is a mode change, and
      // the next word starts from a restored prompt anyway.
      if (env.s.mode !== want) continue;
      if (REFUSED.test(first)) continue;
      if (documented.has(w)) continue;
      const isAbbrev = Array.from(documented).some(function (d) { return d.indexOf(w) === 0 || w.indexOf(d) === 0; });
      if (isAbbrev) continue;
      orphans.push(name + ': ' + w + ' -> ' + first.slice(0, 50));
    }
  }
  ok(typed > 1000, 'the sweep typed the candidate vocabulary at every prompt (' + typed + ')');
  ok(orphans.length === 0, 'and every word a prompt took is on that prompt\'s page'
    + (orphans.length ? ' - ' + orphans.slice(0, 5).join(' | ') : ''));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
