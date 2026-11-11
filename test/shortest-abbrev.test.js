'use strict';
// shortest-abbrev.test.js - the `?` page offers a word, so its shortest spelling has to be taken.
//
// The console abbreviates keywords by prefix, and the tree comes from the help rows. Ten passes have
// fixed that rule one position at a time. This one asks the question the other way round: take every
// documented row in every mode, abbreviate each keyword to its *shortest* unique prefix, type it, and
// require the answer not to be a typo.
//
//   SW1(config-if)#switchport p?      -> port-security      (the console says p is enough)
//   SW1(config-if)#sw p
//   % Unrecognized interface command: sw p                  (and then refuses it)
//
//   R1#li
//   % Unrecognized command: li       (li is a prefix of link *and* links: ambiguous, not a typo)
//
// The veto that stops a block command being read as a global one ("router ospf 1" inside router mode
// must not become "router-id ospf 1") returned null when *neither* page could spell the line back -
// which is exactly the case of a correct abbreviation, so the block refused a spelling its own `?`
// had just offered.
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

const ROUTER_PREP = ['interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
  'vlan 10 name lab', 'router ospf 1', 'network 10.0.0.0 0.0.0.255 area 0', 'exit',
  'router bgp 65001', 'neighbor 10.0.0.2 remote-as 65002', 'exit',
  'ip access-list extended TEST', 'permit ip any any', 'exit',
  'ip dhcp pool LAN', 'network 10.9.0.0 255.255.255.0', 'exit'];

function session(model, enter) {
  const t = new Topology();
  const d = t.addDevice(find(model)); d.name = 'D1';
  const s = new CliSession(d, t, new Simulator(t));
  s.run('enable');
  // Enough state that a command's positive path is reachable, not only its "nothing configured" arm.
  if (model === 'generic-router') ROUTER_PREP.forEach(function (l) { s.run(l); });
  (enter || []).forEach(function (l) { s.run(l); });
  return s;
}

const MODES = [
  ['exec', 'generic-router', []],
  ['config', 'generic-router', ['configure terminal']],
  ['interface', 'generic-switch', ['configure terminal', 'interface Fa0/1']],
  ['ospf', 'generic-router', ['configure terminal', 'router ospf 1']],
  ['bgp', 'generic-router', ['configure terminal', 'router bgp 65001']],
  ['acl', 'generic-router', ['configure terminal', 'ip access-list extended TEST']],
  ['dhcp', 'generic-router', ['configure terminal', 'ip dhcp pool LAN']],
];

console.log('A word the `?` page offers is accepted at its shortest spelling:');
{
  const s = session('generic-switch', ['configure terminal', 'interface Fa0/1']);
  ok(/port-security/.test(text(s.run('switchport p?'))), 'the page offers `p` for port-security');
  const short = text(session('generic-switch', ['configure terminal', 'interface Fa0/1']).run('sw p'));
  ok(/Port security enabled/.test(short), 'and `sw p` is taken (' + short.split('\n')[0] + ')');
  ok(!/Unrecognized/.test(short), 'not refused as a typo');
  const lldp = text(session('generic-switch', ['configure terminal', 'interface Fa0/1']).run('l r'));
  ok(/LLDP receive/.test(lldp), '`l r` is lldp receive (' + lldp.split('\n')[0] + ')');
}

console.log('\nAn ambiguity is an ambiguity, not a typo:');
{
  const s = session('generic-router', []);
  const li = text(s.run('li'));
  ok(/Ambiguous command/.test(li), '`li` says ambiguous');
  ok(/link/.test(li) && /links/.test(li), 'and names both words it could be');
  ok(!/Unrecognized/.test(li), 'nothing calls it unrecognized');
  const sh = text(session('generic-switch', ['configure terminal', 'interface Fa0/1']).run('sh'));
  ok(/Ambiguous command/.test(sh), '`sh` inside a block is ambiguous too');
  ok(/shutdown/.test(sh) && /show/.test(sh), 'naming this block\'s word and the exec verb');
  ok(!/Invalid show command/.test(sh), 'not "invalid show command"');
  // The shorter spellings still work when they are unambiguous.
  ok(/administratively/.test(text(session('generic-switch', ['configure terminal', 'interface Fa0/1']).run('shu'))),
    '`shu` is shutdown and still works');
  ok(/Link/.test(text(session('generic-router', []).run('links'))), '`links` still works');
}

console.log('\nA truncated command is called truncated:');
{
  const out = text(session('generic-router', []).run('show'));
  ok(/Incomplete command/.test(out), '`show` alone is incomplete, not invalid');
  ok(!/\(empty\)/.test(out), 'and prints no empty-string artifact');
  ok(/show \?/.test(out), 'it points at the list of what can follow');
}

console.log('\nA command the handler answers but this device cannot use still abbreviates:');
{
  // `no ip nat inside` on a switch is answered by a capability refusal; the word `nat` is not on the
  // switch's filtered page, so the abbreviation stopped mid-line and the handler saw `no ip n i`.
  const s = session('generic-switch', ['configure terminal', 'interface Fa0/1']);
  const out = text(s.run('n ip n i'));
  ok(!/Unrecognized/.test(out), 'the abbreviated form is not a typo (' + out.split('\n')[0] + ')');
  ok(/NAT/i.test(out), 'and reaches the handler that explains what NAT needs');
}

console.log('\nNo row offers a word that is not a word:');
{
  // A help row is typable or it is not a row. One line read
  //   `no switchport mode | no switchport access vlan | no switchport trunk ... | no switchport voice vlan`
  // - whole commands separated by `|`, and a literal `...` in the position where the trunk forms go.
  // The console then offered `...` as a keyword, and the abbreviation of that row was refused for
  // being the row it is.
  const offenders = [];
  let rowCount = 0;
  for (const [label, model, enter] of MODES) {
    const probe = session(model, enter);
    for (const f of (probe._helpFormRowsAll(probe.mode) || [])) {
      const toks = (f.tokens || f).filter(function (t) { return typeof t === 'string'; });
      rowCount += 1;
      if (toks.some(function (t) { return /^\.\.\.$/.test(t); })) {
        offenders.push(label + ': ' + toks.join(' '));
      }
    }
  }
  ok(rowCount > 200, 'the row count was read (' + rowCount + ' rows)');
  ok(offenders.length === 0, 'no row contains a literal "..." in a keyword position'
    + (offenders.length ? ': ' + offenders.slice(0, 3).join('; ') : ''));
}

console.log('\nSweep: every documented row at its shortest spelling, in every mode:');
{
  const trieOf = function (rows) {
    const root = { ch: new Map() };
    for (const r of rows) {
      let n = root;
      for (const w of r) {
        const k = String(w).toLowerCase();
        if (!n.ch.has(k)) n.ch.set(k, { ch: new Map() });
        n = n.ch.get(k);
      }
    }
    return root;
  };
  const shorten = function (tokens, trie) {
    const out = [];
    let n = trie;
    for (const w of tokens) {
      const k = String(w).toLowerCase();
      if (!n.ch.has(k)) { out.push(w); continue; }
      const sibs = Array.from(n.ch.keys());
      let p = 1;
      while (p < k.length && sibs.filter(function (s) { return s.indexOf(k.slice(0, p)) === 0; }).length > 1) p++;
      out.push(k.slice(0, p));
      n = n.ch.get(k);
    }
    return out.join(' ');
  };
  const bad = [];
  let checked = 0;
  for (const [label, model, enter] of MODES) {
    const probe = session(model, enter);
    const rows = (probe._helpFormRowsAll(probe.mode) || [])
      .filter(function (f) { return f.tokens && f.tokens.every(function (t) { return typeof t === 'string'; }); })
      .map(function (f) { return f.tokens; });
    // Every keyword the page holds, placeholders included: a candidate named by an ambiguity refusal
    // has to be a word that exists in that position, and a row with a value slot still holds its
    // keywords.
    const keywords = new Set();
    for (const f of (probe._helpFormRowsAll(probe.mode) || [])) {
      for (const t of (f.tokens || f)) {
        if (typeof t === 'string') keywords.add(t.toLowerCase());
      }
    }
    const page = rows.map(function (r) { return r.map(function (w) { return String(w).toLowerCase(); }); });
    const trie = trieOf(page);
    for (const toks of rows) {
      const full = toks.join(' ');
      // Not an exemption, ordinary control flow: navigation verbs leave the mode the row was read in,
      // and `do` wraps another command whose arguments are judged where they belong.
      if (/^(exit|end|do|help|\?)\b/.test(full)) continue;
      const short = shorten(toks, trie);
      if (short === full) continue;
      const answer = text(session(model, enter).run(short));
      checked += 1;
      if (/%\s*(Unrecognized|Invalid|Incomplete)/.test(answer)) {
        bad.push(label + ": '" + short + "' (" + full + ') -> ' + answer.split('\n')[0]);
        continue;
      }
      // An ambiguity is only acceptable when it is real: it has to name two or more words, and every
      // word it names has to exist on that page. One candidate is a command the console simply
      // refused to place, wearing the wrong sentence.
      const m = /% Ambiguous command: "([^"]+)"/.exec(answer);
      if (m) {
        const named = /% Candidates: (.+)$/m.exec(answer);
        const cands = named ? named[1].split(',').map(function (x) { return x.trim(); }).filter(Boolean) : [];
        if (cands.length < 2) {
          bad.push(label + ": '" + short + "' called ambiguous but names " + cands.length + ' candidate(s)');
        } else if (cands.some(function (c) { return !keywords.has(c.toLowerCase()); })) {
          bad.push(label + ": '" + short + "' names a candidate that is not on the page: " + cands.join(','));
        }
      }
    }
  }
  ok(checked > 200, 'the sweep ran (' + checked + ' abbreviations across ' + MODES.length + ' modes)');
  ok(bad.length === 0, 'no documented row is refused at the shortest spelling its own `?` offers'
    + (bad.length ? ': ' + bad.slice(0, 4).join('; ') : ''));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
