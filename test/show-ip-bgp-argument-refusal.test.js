'use strict';
// `show ip bgp` refuses a word it cannot use instead of answering with the whole table (#fidelity).
//
// `_showBgp(args)` was handed the tail and never read it, so seven different spellings printed the same bytes:
// `show ip bgp summary`, `show ip bgp neighbors`, `show ip bgp 10.0.0.0/24`, `show ip bgp regexp ^65002` and a
// typo (`show ip bgp bogus`) all came back identical to the bare command. A reader who asked whether *one*
// prefix was in the BGP table got a table full of prefixes - the same wrong answer `show ip route <prefix>` gave
// before #1403, and the same reason it is wrong: the table came back looking like a yes.
//
// A box refuses the word. `sh ip bgp neighbors br` on an IOS XE switch draws `% Invalid input detected at '^'
// marker.` (https://community.cisco.com/t5/routing/bgp-using-layer-3-switches/td-p/5075192), and neither
// spelling has a free positional word - `show ip bgp`'s keyword list ends at `route-map <name>` and
// `show ip bgp summary`'s at `[slow]` (Cisco IOS IP Routing: BGP Command Reference, "show ip bgp" and "show ip
// bgp summary", https://cisco.com/c/en/us/td/docs/ios/iproute_bgp/command/reference/irg_book/irg_bgp5.html).
//
// This console answers in its own sentence, the one every other `show` door uses (`showNoTail()`): the words it
// cannot use, quoted, and what the command does print. `show ip bgp` *does* take an ip-address on a box, as a
// filter, so "does not take" is this console's claim about itself - the trade `show ip route <prefix>` already
// makes - and the sentence says where the answer actually is (the Network column) rather than stopping at no.
//
// The refusal sits *below* the `% BGP not active` check, because with no process a box answers every one of
// these spellings with those five words whatever was typed, and `test/bgp-not-active.test.js` pins that. The
// ordering question that is still open is recorded in research/show-ip-bgp-argument-refusal.md.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.filter(function (s) { return /ASR 1001-X/.test(s.model); })[0];
const eth = function (d) {
  return [...d.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
};

// r1 (AS65001) -- r2 (AS65002), one eBGP session over one cable, so the view has a neighbour and a prefix row
// to print. A refusal is only meaningful where the full answer would have had content.
function lab() {
  const t = new Topology();
  const r1 = t.addDevice(ROUTER, 'r1');
  const r2 = t.addDevice(ROUTER, 'r2');
  t.connect('r1', eth(r1)[0].name, 'r2', eth(r2)[0].name);
  const sim = new Simulator(t);
  runCommands(r1, t, sim, ['configure terminal', 'interface ' + eth(r1)[0].name,
    'ip address 10.0.0.1 255.255.255.0', 'end', 'configure terminal',
    'router bgp 65001', 'neighbor 10.0.0.2 remote-as 65002', 'end']);
  runCommands(r2, t, sim, ['configure terminal', 'interface ' + eth(r2)[0].name,
    'ip address 10.0.0.2 255.255.255.0', 'end', 'configure terminal',
    'router bgp 65002', 'neighbor 10.0.0.1 remote-as 65001', 'end']);
  sim.ping('r1', '10.0.0.2', { count: 1 });
  return { t: t, sim: sim, r1: r1, r2: r2 };
}

const env = lab();
function say(cmd, dev) {
  return ((new CliSession(dev || env.r1, env.t, env.sim).run(cmd).output) || []).map(String);
}
const text = function (cmd) { return say(cmd).join('\n'); };
const isRefusal = function (out) { return /^% /.test(out) && out.indexOf('\n') === -1; };

console.log('');
console.log('The view has content, so a dropped word is visible:');
{
  const bgp = text('show ip bgp');
  ok(/10\.0\.0\.2/.test(bgp), 'show ip bgp lists the neighbour it formed a session with', bgp.split('\n')[0]);
  ok(/1 of 1 neighbour\(s\) established/.test(bgp), 'and counts the session it established');
  ok(/BGP router identifier/.test(bgp), 'and opens with the identifier it elected');
}

console.log('');
console.log('A word that is not a view is refused, one line, and the table is not printed:');
{
  const bare = text('show ip bgp');
  const TAILS = ['ZZZNOPE', '10.0.0.0/24', '10.0.0.0 255.255.255.0', 'regexp ^65001', 'summaryx'];
  for (const tail of TAILS) {
    const out = text('show ip bgp ' + tail);
    ok(isRefusal(out), 'refused: show ip bgp ' + tail, out.split('\n')[0]);
    ok(out.indexOf('"' + tail + '"') !== -1, 'quoting the words typed: "' + tail + '"', out);
    ok(/show ip bgp does not take/.test(out), 'naming the command: show ip bgp', out);
    ok(/Network column/.test(out), 'and saying where the narrower answer is', out);
    ok(out !== bare, 'the answer is not the bare command\'s bytes, word for word');
    ok(!/Neighbor\s+V\s+AS/.test(out) && !/BGP router identifier/.test(out),
      'no neighbour table is printed under the refusal', out);
    ok(out.split('\n').length === 1, 'one line, not a table', String(out.split('\n').length));
  }
}

console.log('');
console.log('`show ip bgp summary` refuses a word too, and still answers without one:');
{
  const out = text('show ip bgp summary ZZZNOPE');
  ok(isRefusal(out), 'refused: show ip bgp summary ZZZNOPE', out.split('\n')[0]);
  ok(/show ip bgp summary does not take/.test(out), 'naming the view that was typed, not the bare door', out);
  ok(out.indexOf('"ZZZNOPE"') !== -1, 'quoting the word', out);
  const plain = text('show ip bgp summary');
  ok(/10\.0\.0\.2/.test(plain) && !isRefusal(plain), 'the documented form still prints the neighbour row',
    plain.split('\n')[0]);
}

console.log('');
console.log('`show ip bgp neighbors` is a view this console keeps no form of, and it says so:');
{
  // Not "does not take": a box has this view, and telling an operator the command does not exist is a different
  // wrong answer from telling them this console has no detail block. The nat console answers the same gap the
  // same way (`show ip nat translations has no verbose form`).
  for (const typed of ['show ip bgp neighbors', 'show ip bgp neighbors 10.0.0.2', 'show ip bgp neighbours']) {
    const out = text(typed);
    ok(isRefusal(out), 'refused: ' + typed, out.split('\n')[0]);
    ok(/has no detail view here/.test(out), 'as a gap in this console, not as a word a box rejects: ' + typed, out);
    ok(/`show ip bgp`/.test(out), 'and naming the command that does print the neighbour facts', out);
    ok(!/does not take/.test(out), 'it does not deny a command a box has', out);
    ok(!/Neighbor\s+V\s+AS/.test(out), 'no table under it', out);
  }
}

console.log('');
console.log('With no BGP process the refusal is unchanged, so the guard order still holds:');
{
  // A box with nothing configured answers all of these with `% BGP not active` - captured behaviour, pinned by
  // test/bgp-not-active.test.js - and there is no table for a word to be dropped from. The new refusal is
  // reachable only where an answer used to be fabricated.
  const t = new Topology();
  const r = t.addDevice(ROUTER, 'r9');
  const sim = new Simulator(t);
  for (const view of ['show ip bgp', 'show ip bgp summary', 'show ip bgp neighbors',
    'show ip bgp ZZZNOPE', 'show ip bgp summary ZZZNOPE']) {
    const s = new CliSession(r, t, sim);
    s.run('enable');
    const lines = (s.run(view).output || []).map(String);
    ok(lines.length === 1 && lines[0] === '% BGP not active',
      '`' + view + '` still prints the five words and nothing else', JSON.stringify(lines));
  }
}

console.log('');
console.log('One answer, still - this suite refuses words, it does not split the views:');
{
  // `show ip bgp` and `show ip bgp summary` are the same bytes today, and docs/plans/bgp-show-views.md step 3 is
  // the change that splits them. This suite must not smuggle that change in: what it pins is only that a word the
  // view cannot use is refused rather than dropped.
  ok(text('show ip bgp') === text('show ip bgp summary'),
    'the two views are still one answer - the split is a later step, not this one');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
