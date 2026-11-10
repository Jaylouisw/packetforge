'use strict';
// block-stray-words.test.js - a word after a block command that takes no words was dropped, and the
// command ran anyway.
//
//   SW1(config-if)#shutdown zzzz        -> "Fa0/1 administratively down"
//   SW1(config-if)#no ip address zzzz   -> "IP address removed from Fa0/1"
//   R1(config-dhcp)#no lease zzzz       -> accepted, nothing said
//
// These lines change state, so the `show` trick (compose the answer twice) is not available: the
// second run would be a second change. The block's page is the contract instead - if a form of
// exactly this shape is listed, the handler answers it; if the only thing that matched was an
// argument-less form, the words after it are refused by the name of the command they follow.
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

function session(model, pre) {
  const t = new Topology();
  const d = t.addDevice(find(model)); d.name = 'D1';
  const sim = new Simulator(t);
  const s = new CliSession(d, t, sim);
  s.run('enable'); s.run('configure terminal');
  for (const line of (pre || [])) s.run(line);
  return { t: t, d: d, sim: sim, s: s };
}

console.log('An interface command that takes no words refuses a word after it:');
{
  const env = session('generic-switch', ['interface Fa0/1']);
  ok(/% Unexpected argument "zzzz" - shutdown takes no more/.test(text(env.s.run('shutdown zzzz'))),
    'shutdown zzzz is refused');
  ok(/% Unexpected argument "zzzz" - no ip address takes no more/.test(text(env.s.run('no ip address zzzz'))),
    'no ip address zzzz is refused');
  ok(/% Unexpected argument "zzzz" - no description takes no more/.test(text(env.s.run('no description zzzz'))),
    'no description zzzz is refused');
  // and the state is untouched by the refused lines
  const state = text(env.s.run('do show interfaces Fa0/1'));
  ok(!/administratively down/.test(state), 'the port was not taken down by the refused line');
}

console.log('\nThe same commands without the word still work:');
{
  const env = session('generic-switch', ['interface Fa0/1']);
  ok(/administratively down/.test(text(env.s.run('shutdown'))), 'shutdown alone still takes the port down');
  ok(/up/.test(text(env.s.run('no shutdown'))), 'no shutdown alone still brings it back');
  const addr = session('generic-router', ['interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0']);
  ok(/removed/.test(text(addr.s.run('no ip address'))), 'no ip address alone still clears the address');
}

console.log('\nA DHCP pool refuses a word after an argument-less removal, and keeps the setting:');
{
  const env = session('generic-router', ['ip dhcp pool P1', 'network 10.0.0.0 255.255.255.0', 'lease 1 0 0']);
  const refused = text(env.s.run('no lease zzzz'));
  ok(/% Unexpected argument "zzzz" - no lease takes no more/.test(refused), 'no lease zzzz is refused');
  const view = text(env.s.run('do show ip dhcp pool'));
  ok(/lease/i.test(view), 'the lease is still configured after the refused line');
  env.s.run('no lease');
  const after = text(env.s.run('do show ip dhcp pool'));
  ok(/P1/.test(after) && !/^\s*%/m.test(after), 'no lease alone is accepted and the pool is still there');
}

console.log('\nTwo arguments that were never read are now read:');
{
  const env = session('generic-router', ['interface Gi0/0']);
  ok(/% Unexpected argument "zzzz" - ip address dhcp takes no more/.test(text(env.s.run('ip address dhcp zzzz'))),
    'ip address dhcp zzzz is refused');
  const iface = env.d.interfaces.get('Gi0/0');
  ok(!iface.dhcp, 'and the port was not turned into a DHCP client');
  env.s.run('ipv6 address 2001:db8:1::1/64');
  ok(/is not an address or a prefix length/.test(text(env.s.run('no ipv6 address zzzz'))),
    'no ipv6 address zzzz is refused as neither an address nor a length');
  ok(/2001:db8:1::1/.test(text(env.s.run('do show ipv6 interface Gi0/0'))),
    'and the address is still there');
  ok(/removed/.test(text(env.s.run('no ipv6 address'))), 'no ipv6 address alone still clears it');
}

console.log('\nFree text is still free text:');
{
  const env = session('generic-switch', ['interface Fa0/1']);
  ok(/uplink zzzz/.test(text(env.s.run('description uplink zzzz'))),
    'a description keeps every word - it is a sentence, not an argument');
  const named = session('generic-router', []);
  named.s.run('hostname core switch 1');
  ok(named.d.config.hostname === 'core switch 1',
    'a hostname keeps its words too (issue #19) - the name is the whole remainder');
}

console.log('\nEvery argument-less row in every block refuses a word after it:');
{
  const blocks = [
    ['config', 'generic-router', []],
    ['interface (router)', 'generic-router', ['interface Gi0/0']],
    ['interface (switch)', 'generic-switch', ['interface Fa0/1']],
    ['ospf process', 'generic-router', ['router ospf 1']],
    ['bgp process', 'generic-router', ['router bgp 65001']],
    ['dhcp pool', 'generic-router', ['ip dhcp pool P1']],
    ['access list', 'generic-router', ['ip access-list extended T']]
  ];
  const bad = [];
  let checked = 0;
  for (const [label, model, pre] of blocks) {
    const probe = session(model, pre);
    const mode = probe.s.mode;
    const rows = (probe.s._helpFormRowsAll(mode) || []).filter(function (f) {
      return f.tokens && f.tokens.every(function (t) { return typeof t === 'string'; });
    }).map(function (f) { return f.tokens.join(' '); });
    for (const line of rows) {
      // Ordinary control flow, not an exemption: `end`, `exit` and `do` leave or read a block, so a
      // word after them has no setting to change and nothing to observe.
      if (/^(end|exit|do)\b/.test(line)) continue;
      const env = session(model, pre);
      const answer = text(env.s.run(line + ' zzzz'));
      checked += 1;
      if (!/^\s*%/.test(answer)) bad.push(label + ': "' + line + '" -> ' + answer.split('\n')[0]);
    }
  }
  ok(bad.length === 0, 'no block command ignores a word after it' + (bad.length ? ': ' + bad.slice(0, 4).join('; ') : ''));
  ok(checked > 150, 'the sweep ran (' + checked + ' rows across seven blocks)');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
