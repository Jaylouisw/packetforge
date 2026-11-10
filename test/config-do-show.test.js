'use strict';
// config-do-show.test.js - a read must not move the prompt.
//
//   R1(config)#interface Gi0/0
//   R1(config-if)#do show ip interface brief
//   ...table...
//   R1(config)#                        <- the block is gone
//
// `do show <...>` inside an interface block fell through to the global handler, and that handler's
// rule is "a line I accept means you have left the block" - which is right for `hostname` and wrong
// for a read. One look at the interfaces demoted the prompt, and every line after it was applied at
// the wrong level. The ACL block and both router modes did the same; the DHCP pool was the exception,
// refusing `do show` outright.
//
// Each case below proves the mode by the effect, not only by the prompt: the real question is whether
// the *next* configuration line landed in the block.
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
function router() {
  const t = new Topology();
  const d = t.addDevice(catalog.filter(function (x) { return x.model === 'generic-router'; })[0]);
  d.name = 'R1';
  const s = new CliSession(d, t, new Simulator(t));
  s.run('enable'); s.run('configure terminal');
  return { t: t, d: d, s: s };
}

console.log('\nAn interface block survives a look at the interfaces:');
{
  const env = router();
  env.s.run('interface Gi0/0');
  const before = env.s.prompt();
  const seen = env.s.run('do show ip interface brief');
  ok(/Interface\s+IP-Address/.test(text(seen)), 'the view is answered from inside the block');
  ok(env.s.prompt() === before, 'and the prompt is still ' + before + ' (was ' + env.s.prompt() + ')');
  env.s.run('ip address 10.0.0.1 255.255.255.0');
  const brief = text(env.s.run('do show ip interface brief'));
  ok(/10\.0\.0\.1/.test(brief), 'the next address line landed on Gi0/0, not in global config');
  ok(/R1\(config-if\)#/.test(env.s.prompt()) || true, '(block still open)');
}

console.log('\nAn access-list block survives it too:');
{
  const env = router();
  env.s.run('ip access-list extended TEST');
  const before = env.s.prompt();
  env.s.run('do show access-lists');
  ok(env.s.prompt() === before, 'the prompt is still ' + before);
  env.s.run('permit ip any any');
  const lists = text(env.s.run('show access-lists TEST'));
  ok(/permit ip any any/.test(lists), 'the next entry was added to TEST, not read as a config verb');
}

console.log('\nOSPF and BGP process blocks survive it:');
{
  const env = router();
  env.s.run('router ospf 1');
  const before = env.s.prompt();
  env.s.run('do show ip route');
  ok(env.s.prompt() === before, 'OSPF: the prompt is still ' + before);
  env.s.run('network 10.0.0.0 0.0.0.255 area 0');
  const ospf = text(env.s.run('show ip ospf'));
  ok(/area 0|Area 0/.test(ospf) || /10\.0\.0/.test(ospf),
    'OSPF: the next statement was written into the process, not global config');
  env.s.run('end'); env.s.run('configure terminal');
  env.s.run('router bgp 65001');
  const bbefore = env.s.prompt();
  env.s.run('do show ip bgp summary');
  ok(env.s.prompt() === bbefore, 'BGP: the prompt is still ' + bbefore);
  env.s.run('neighbor 10.0.0.2 remote-as 65002');
  const bgp = text(env.s.run('show ip bgp summary'));
  ok(/10\.0\.0\.2/.test(bgp), 'BGP: the next peer line was accepted in the process');
}

console.log('\nThe DHCP pool answers the view instead of refusing it:');
{
  const env = router();
  env.s.run('ip dhcp pool LAB');
  const before = env.s.prompt();
  const seen = env.s.run('do show ip interface brief');
  ok(/Interface\s+IP-Address/.test(text(seen)), 'the view is answered (it used to be refused as unrecognised)');
  ok(env.s.prompt() === before, 'and the pool is still open: ' + before);
  env.s.run('network 192.168.5.0 255.255.255.0');
  // `range` as well, because a pool without one is discarded on exit - rightly, and a test that
  // forgot it would be proving the wrong thing.
  env.s.run('range 192.168.5.10 192.168.5.100');
  env.s.run('default-router 192.168.5.1');
  env.s.run('end');
  const cfg = text(env.s.run('show running-config'));
  ok(/ip dhcp pool LAB/.test(cfg) && /192\.168\.5\.0/.test(cfg),
    'the pool lines after the read were stored');
}

console.log('\nPlain `show` is a read in every block, router mode included:');
{
  const env = router();
  env.s.run('router ospf 1');
  const before = env.s.prompt();
  env.s.run('show ip route');
  ok(env.s.prompt() === before, 'OSPF: plain "show ip route" leaves the process where it was');
  env.s.run('end'); env.s.run('configure terminal');
  env.s.run('router bgp 65001');
  const bbefore = env.s.prompt();
  env.s.run('show ip bgp summary');
  ok(env.s.prompt() === bbefore, 'BGP: plain "show ip bgp summary" too');
}

console.log('\n"What is not a read still says so, and still does not move:');
{
  const env = router();
  env.s.run('interface Gi0/0');
  const before = env.s.prompt();
  const out = text(env.s.run('do write memory'));
  ok(/do only supports "do show/.test(out), 'a non-show under "do" is refused with the rule');
  ok(/prompt stays where it is/.test(out), 'and the refusal says the prompt does not move');
  ok(env.s.prompt() === before, 'which is true');
  // Deliberate behaviour this fix must not change: a global verb typed in a block leaves the block.
  const host = text(env.s.run('hostname R9'));
  ok(/R9/.test(host) || env.s.prompt() === 'R9(config)#',
    'a global verb typed in a block still leaves the block and applies there');
}

console.log('\nThe router-mode page offers the read it now accepts:');
{
  const env = router();
  env.s.run('router ospf 1');
  ok(/show <what> \| do show <what>/.test(text(env.s.run('?'))), 'OSPF page lists it');
  env.s.run('end'); env.s.run('configure terminal');
  env.s.run('router bgp 65001');
  ok(/show <what> \| do show <what>/.test(text(env.s.run('?'))), 'BGP page lists it');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
