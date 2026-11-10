'use strict';
// number-slots.test.js - a slot that takes a number takes a number, and a mask is a mask.
//
// Swept every numeric placeholder on the config pages with junk ("abc", "-1", "1e3"), an
// out-of-range value and a boundary value. Two slots answered in the affirmative anyway:
//
//   R1(config)#router bgp 1e3       BGP enabled, local AS 1          <- parseInt
//   R1(config)#router bgp 65001abc  BGP enabled, local AS 65001      <- parseInt
//   R1(config)#ip route 10.0.0.0 255.0.255.0 10.0.0.9
//                                   Route added: 10.0.0.0/8 via 10.0.0.9   <- a mask with a hole in it
//
// The AS one made a process nobody asked for (and a second `router bgp 1.10` would have joined it by
// accident); the route one silently widened the route to a /8, claiming reachability for addresses
// the operator never named. `router ospf` had the strict check already, and `ip address` refused a
// non-contiguous mask already - so both defects were one verb each being the odd one out.
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

function lab(model, name, prep) {
  const t = new Topology();
  const d = t.addDevice(find(model)); d.name = name;
  const s = new CliSession(d, t, new Simulator(t));
  s.run('enable');
  s.run('configure terminal');
  (prep || []).forEach(function (l) { s.run(l); });
  return { t: t, d: d, s: s };
}
function run(env, line) { return text(env.s.run(line)); }
function dump(env) { env.s.run('end'); const o = text(env.s.run('show running-config')); env.s.run('configure terminal'); return o; }

console.log('\nAn AS number is a number:');
{
  for (const bad of ['1e3', '65001abc', '0x14', '  ', '1.70000', '0', '4294967296']) {
    const env = lab('generic-router', 'R1');
    const out = run(env, 'router bgp ' + (bad.trim() ? bad : ''));
    ok(/^%/.test(out.trim()), '"' + bad + '" is refused' + (bad.trim() ? '' : ' (an empty AS)'));
  }
  const range = lab('generic-router', 'R1');
  const msg = run(range, 'router bgp 1e3');
  ok(/whole number 1-4294967295/.test(msg), 'the refusal names the range');
  ok(/asdot/.test(msg), 'and the one other spelling that is a number');
  ok(/65546/.test(msg), 'with the example worked out, not left as a puzzle');
  ok(!/local AS/.test(msg), 'and nothing was enabled on the way past');
  ok(!/router bgp/.test(dump(range)), 'so the running-config has no BGP process');
}

console.log('\nThe second spelling IOS accepts is read as what it means, not truncated:');
{
  const env = lab('generic-router', 'R1');
  const out = run(env, 'router bgp 1.10');
  ok(/local AS 65546/.test(out), 'asdot 1.10 is AS 65546 (1*65536+10)');
  ok(/asdot for 65546/.test(out), 'and the answer says so, because the words did not spell it out');
  ok(/router bgp 65546/.test(dump(env)), 'the running-config holds the plain number, which pastes back');
  const plain = lab('generic-router', 'R1');
  const pOut = run(plain, 'router bgp 65001');
  ok(!/asdot/.test(pOut), 'a plain AS is answered plainly');
  const peer = lab('generic-router', 'R1', []);
  peer.s.run('end');
  peer.s.run('configure terminal');
  run(peer, 'router bgp 65001');
  peer.s.run('end'); peer.s.run('configure terminal');
  ok(/remote-as 65546/.test(text(peer.s.run('bgp neighbor 10.0.0.2 remote-as 1.10'))),
    'a peer takes asdot too, and stores the plain number');
  const bad = text(peer.s.run('bgp neighbor 10.0.0.3 remote-as nay'));
  ok(/Invalid remote AS/.test(bad) && /whole number/.test(bad), 'and a word is refused as a remote AS');
}

console.log('\nA mask with a hole in it is not a mask:');
{
  const env = lab('generic-router', 'R1', ['interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0',
    'no shutdown', 'exit']);
  const out = run(env, 'ip route 10.0.0.0 255.0.255.0 10.0.0.9');
  ok(/% "255.0.255.0" is not a contiguous mask/.test(out), 'the route is refused, naming the mask');
  ok(/ones must all be on the left/.test(out), 'and the rule');
  ok(/Read as \/8/.test(out), 'and what reading it loosely would have meant');
  ok(!/Route added/.test(out), 'nothing was installed');
  ok(!/10\.0\.0\.0\/8/.test(dump(env)), 'and the running-config has no widened route');
  for (const [mask, prefix] of [['255.255.255.0', 24], ['255.255.0.0', 16], ['0.0.0.0', 0],
    ['255.255.255.252', 30], ['255.255.255.255', 32]]) {
    const e = lab('generic-router', 'R1', ['interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0',
      'no shutdown', 'exit']);
    const o = run(e, 'ip route 10.9.0.0 ' + mask + ' 10.0.0.9');
    ok(new RegExp('Route added: 10\\.9\\.0\\.0/' + prefix + ' ').test(o), mask + ' still installs a /' + prefix);
  }
  // The same rule on the other verb that takes a mask, so the two cannot drift apart.
  const iface = lab('generic-router', 'R1', ['interface Gi0/0']);
  const addr = run(iface, 'ip address 10.0.0.1 255.0.255.0');
  ok(/not a contiguous mask/.test(addr), 'ip address refuses it too (the rule is shared, not per-verb)');
}

console.log('\nThe slots the sweep walked: a word where a number goes is refused:');
{
  // Every row with exactly one numeric placeholder and no alternation, typed with "abc" in that
  // slot, in config mode and in an interface block.
  const NUM = /^<(n|id|mtu|speed|priority|cost|seconds|s|value|count|size|seq|time|vlan|vlan-id|vrid|group|process-id|as|ms|number)>$/;
  const cases = [
    ['generic-router', ['configure terminal']],
    ['generic-router', ['configure terminal', 'interface Gi0/0']],
    ['generic-switch', ['configure terminal']],
    ['generic-switch', ['configure terminal', 'interface Fa0/1']]
  ];
  let checked = 0;
  for (const [model, setup] of cases) {
    const env = lab(model, 'X1');
    setup.forEach(function (l) { env.s.run(l); });
    const rows = text(env.s.run('?')).split('\n').map(function (l) { return l.trim(); })
      .filter(function (l) { return l && !l.startsWith('%'); })
      .map(function (l) { return l.split(/\s{2,}/)[0]; })
      .filter(function (s) {
        // Ordinary control flow, not an exemption: an alternation or a verb that is not a
        // configuration row is simply not a row this sweep can build a line from.
        if (/\|/.test(s) || /^(no |do |show |ping |traceroute |clear |write |copy |exit|end)/.test(s)) return false;
        const words = s.split(/\s+/);
        const nums = words.filter(function (w) { return NUM.test(w); });
        return nums.length === 1;
      });
    for (const syn of rows) {
      const words = syn.split(/\s+/);
      const idx = words.findIndex(function (w) { return NUM.test(w); });
      const line = words.map(function (w, i) { return i === idx ? 'abc' : w; }).join(' ');
      const e = lab(model, 'X1');
      setup.forEach(function (l) { e.s.run(l); });
      const out = text(e.s.run(line));
      ok(/^\s*%/.test(out), model + ' / ' + setup[setup.length - 1] + ': "' + line + '" is refused');
      checked++;
    }
  }
  ok(checked >= 6, 'the sweep walked ' + checked + ' numeric slots');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
