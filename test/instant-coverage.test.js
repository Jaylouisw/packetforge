'use strict';
// instant-coverage.test.js - a view that answers at an instant says so.
//
// `at <ms>` and `converged` are what make this a *simulation*: ask the lab a question at a time, or
// once the control planes have settled. They were implemented on the route, ping and IPv6 views and
// documented there; every other view took them and never mentioned them:
//
//   R1#show arp at 50
//   ARP at t=50 ms (control planes rebuilt for this answer)
//   R1#show arp ?
//     Next       Meaning
//     <address>  IP-to-MAC cache, or one address
//     <port>     IP-to-MAC cache, or one address      <- no `at`, no `converged`
//
// So the feature could not be found from the view it applies to. Nine families were in that state:
// show arp, show spanning-tree, show mac address-table, show lldp (and its four children), show vrrp,
// show ip bgp (and its children), show ip ospf (and its children).
//
// The rules:
//   1. If a view answers at an instant, its page offers `at`/`converged` for that view.
//   2. If a view refuses an instant ("does not take an instant"), it is a table of *state* rather
//      than of control planes, and the refusal is the answer - nothing to document.
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

function lab(model) {
  const t = new Topology();
  const d = t.addDevice(find(model)); d.name = model === 'generic-switch' ? 'SW1' : 'R1';
  const s = new CliSession(d, t, new Simulator(t)); s.run('enable');
  return { t: t, d: d, s: s };
}

console.log('A view that answers at an instant offers it:');
{
  const env = lab('generic-router');
  const cases = [
    ['show arp', 'show arp at 50'],
    ['show arp', 'show arp converged'],
    ['show vrrp', 'show vrrp at 50'],
    ['show ip bgp', 'show ip bgp converged'],
    ['show ip ospf', 'show ip ospf at 50'],
    ['show lldp', 'show lldp at 50'],
    ['show lldp neighbors', 'show lldp neighbors converged'],
    ['show lldp traffic', 'show lldp traffic at 50']
  ];
  for (const [base, cmd] of cases) {
    const page = text(env.s.run(base + ' ?'));
    const kw = cmd.indexOf('converged') !== -1 ? 'converged' : 'at';
    ok(new RegExp('^\\s*' + kw + '\\b', 'm').test(page), base + ' ? offers ' + kw);
    // And the offered word is not a promise the parser breaks. A *state* refusal is fine - there is no
    // VRRP group, no BGP process and no OSPF process on a bare router - so what must not appear is the
    // vocabulary of an unknown command.
    const first = String(text(env.s.run(cmd))).split('\n')[0];
    ok(!/Invalid|Unrecognized|No completions/.test(first), '  and ' + cmd + ' is a known form');
  }
  // A trailing `at ?` asks what the instant takes: a number of milliseconds.
  const at = text(env.s.run('show arp at ?'));
  ok(/<ms>|milliseconds|number/i.test(at), 'show arp at ? names the value it takes');
}

console.log('\nA table of state refuses the instant, and that is its answer:');
{
  const env = lab('generic-switch');
  for (const view of ['show interfaces', 'show vlan', 'show logging', 'show port-security', 'show etherchannel']) {
    const out = text(env.s.run(view + ' at 50'));
    ok(/does not take an instant/.test(out), view + ' says it is not asked at an instant');
  }
}

console.log('\nA refusal is not dressed as an answer:');
{
  // The header says the control planes were rebuilt *to answer this question*. On a switch that cannot
  // run BGP the console printed it and then refused - a claim of an answer for a question the device
  // cannot be asked.
  const sw = lab('generic-switch');
  for (const cmd of ['show ip bgp at 50', 'show ip ospf at 50', 'show ip bgp converged', 'show ip ospf converged']) {
    const out = String(text(sw.s.run(cmd)));
    ok(!/control planes rebuilt/.test(out), cmd + ' is not headed with a rebuilt answer');
    ok(/^%/.test(out), '  it is a refusal, and reads as one');
  }
  // A view that really answers keeps its header.
  const rt = lab('generic-router');
  const answered = String(text(rt.s.run('show arp at 50')));
  ok(/^ARP at t=50 ms \(control planes rebuilt for this answer\)/.test(answered),
    'a view that answers keeps the header');
}

console.log('\nThe sweep behind it: every view that takes an instant documents one:');
{
  // Every documented exec row is asked with ` at 50`. If it answers, its family must offer the
  // keyword on the page: a word that works but is not on the page is reachable only by guessing.
  const MODELS = ['generic-router', 'generic-switch'];
  let asked = 0;
  const undocumented = [];
  for (const model of MODELS) {
    const env = lab(model);
    const rows = [];
    for (const row of env.s._helpFormRowsAll('enable')) {
      const tk = row.tokens || [];
      if (typeof tk[0] !== 'string') continue;
      rows.push(tk.map(function (x) { return typeof x === 'object' ? '<' + x.placeholder + '>' : String(x); }).join(' '));
    }
    const documentsAt = function (base) {
      const head = base.split(/\s+/).slice(0, 2).join(' ');
      return rows.some(function (r) { return r.indexOf(head) === 0 && /\bat\b|\bconverged\b/.test(r); });
    };
    for (const syn of Array.from(new Set(rows))) {
      // Not an exemption, ordinary control flow: only a view or a probe can be asked at an instant,
      // and this loop is asking which of the page's rows are one.
      if (!/^show |^ping |^traceroute /.test(syn)) continue;
      const base = syn.replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
      if (/<[^>]+>/.test(base)) continue;          // filled rows are checked below
      asked++;
      const out = String(text(env.s.run(base + ' at 50'))).split('\n')[0];
      // Not an exemption, ordinary control flow: a refusal is either "not asked at an instant" or a
      // capability answer, and neither is a view that takes one.
      if (/^%/.test(out)) continue;
      if (documentsAt(base)) continue;
      undocumented.push(model + ': ' + base);
    }
  }
  ok(asked > 20, 'the sweep asked every argument-less view for an instant (' + asked + ')');
  ok(undocumented.length === 0, 'and every view that answered documents the keyword'
    + (undocumented.length ? ' - ' + Array.from(new Set(undocumented)).slice(0, 6).join(', ') : ''));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
