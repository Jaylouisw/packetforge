'use strict';
// bgp-router-mode.test.js - `router bgp 65001` did not enter a mode.
//
// It enabled BGP and stayed in global config. Every real BGP block ends in `exit`, so pasting one -
// the most ordinary thing in a BGP lab - dropped the operator to exec on that line, and every command
// after it was read as exec and lost:
//
//   R1(config)#router bgp 65001
//   BGP enabled, local AS 65001
//   R1(config)#neighbor 10.0.0.2 remote-as 65002
//   BGP neighbor 10.0.0.2 remote-as 65002
//   R1(config)#exit
//   R1#ip access-list extended WEB
//   % Unrecognized command: ip access-list extended WEB      <- and everything after it, too
//
// The mode is the same one `router ospf` already had, and the prompt was already claiming it.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + (actual === expected ? '' : ' (got ' + JSON.stringify(actual) + ')'));
}
function match(re, haystack, msg) {
  if (haystack && Array.isArray(haystack.output)) haystack = haystack.output;
  const text = Array.isArray(haystack) ? haystack.join('\n') : String(haystack);
  ok(re.test(text), msg + (re.test(text) ? '' : ' (no match in ' + JSON.stringify(text.slice(0, 600)) + ')'));
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const ROUTER = catalog.filter(function (x) { return x.model === 'generic-router'; })[0];
const SWITCH = catalog.filter(function (x) { return x.model === 'generic-switch'; })[0];

function lab(model) {
  const t = new Topology();
  const d = t.addDevice(model || ROUTER); d.name = 'R1';
  const sim = new Simulator(t);
  const s = new CliSession(d, t, sim); s.run('enable');
  return { t: t, sim: sim, d: d, s: s };
}

console.log('\n`router bgp <as>` enters the router mode, and the prompt says so:');
{
  const env = lab();
  env.s.run('configure terminal');
  match(/BGP enabled, local AS 65001/, env.s.run('router bgp 65001'), 'the process is enabled');
  match(/\(config-router\)#$/, env.s.prompt(), 'and the mode is (config-router)#');
  match(/BGP router-id 1\.1\.1\.1/, env.s.run('bgp router-id 1.1.1.1'), 'BGP verbs work inside it');
  eq(env.d.config.bgp.routerId, '1.1.1.1', 'and the router-id is stored');
  match(/BGP neighbor 10.0.0.2 remote-as 65002/, env.s.run('neighbor 10.0.0.2 remote-as 65002'),
    'a neighbour is added in the mode IOS adds it in');
  match(/\(config-router\)#$/, env.s.prompt(), 'and the mode is kept between verbs');
}

console.log('\n`exit` leaves for config, not for exec - the defect this exists for:');
{
  const env = lab();
  env.s.run('configure terminal');
  env.s.run('router bgp 65001');
  env.s.run('neighbor 10.0.0.2 remote-as 65002');
  match(/Leaving router configuration mode/, env.s.run('exit'), 'exit says where it went');
  match(/\(config\)#$/, env.s.prompt(), 'and the next prompt is config mode');
  // The line that used to be lost.
  match(/[Cc]reating extended access list WEB/, env.s.run('ip access-list extended WEB'),
    'config keeps working');
  env.s.run('permit tcp any any eq 443');
  env.s.run('exit');
  eq((env.d.config.acls.WEB || []).length, 1, 'and the ACL after the BGP block was really configured');
  const summary = env.s.run('show ip bgp summary').output.join('\n');
  match(/10\.0\.0\.2/, summary, 'the configured neighbour is in the BGP table');
  match(/Idle/, summary, 'with a state, because it is configured and not yet evaluated');
  ok(!/0 of 0 neighbour/.test(summary), 'and the count is not zero with a peer configured');
}

console.log('\nA pasted dump does not need the `exit`, and does not lose the lines after it:');
{
  const env = lab();
  env.s.run('configure terminal');
  env.s.run('router bgp 65001');
  env.s.run('neighbor 10.0.0.2 remote-as 65002');
  env.s.run('exit');
  // A dump never says `exit` between blocks: the next block starts straight away.
  env.s.run('interface Gi0/0');
  match(/\(config-if\)#$/, env.s.prompt(),
    'an interface block after a BGP block is read as configuration');
  match(/10\.0\.0\.1\/24/, env.s.run('ip address 10.0.0.1 255.255.255.0'), 'and takes an address');
  env.s.run('exit');
  eq(env.d.interfaces.get('Gi0/0').ip, '10.0.0.1', 'and the address landed on the port');
  eq(env.d.config.bgp.neighbors.length, 1, 'while the neighbour is still configured');
}

console.log('\nThe mode knows which process it is editing:');
{
  const env = lab();
  env.s.run('configure terminal');
  env.s.run('router ospf 1');
  match(/No interface .* matches 10\.0\.0\.0 0\.0\.0\.255/, env.s.run('network 10.0.0.0 0.0.0.255 area 0'),
    'OSPF verbs still work after entering OSPF (and a statement matching nothing is refused)');
  match(/\(config-router\)#$/, env.s.prompt(), 'the prompt is the same for both processes, as on IOS');
  env.s.run('exit');
  env.s.run('router bgp 65001');
  // The verb that belongs to OSPF is not a BGP verb, and the refusal names the mode it is in.
  match(/BGP "network" is not modelled here|is not a router bgp command/,
    env.s.run('network 10.0.0.0 0.0.0.255 area 0'),
    'and an OSPF statement typed in BGP mode is answered in BGP vocabulary, not OSPF\'s');
  env.s.run('exit');
  eq(env.d.config.ospf.pid, 1, 'the OSPF process is untouched');
  eq(env.d.config.bgp.as, 65001, 'and so is BGP');
}

console.log('\nAn invalid AS keeps the operator where they were:');
{
  const env = lab();
  env.s.run('configure terminal');
  match(/Invalid AS number/, env.s.run('router bgp 99999999999999'), 'the AS is validated');
  match(/\(config\)#$/, env.s.prompt(), 'and a refusal does not change mode');
  // A device that cannot route refuses BGP by naming what it is instead.
  const sw = lab(SWITCH); sw.d.name = 'SW1';
  sw.s.run('configure terminal');
  const out = sw.s.run('router bgp 65001');
  match(/is a layer 2 switch: it cannot run BGP/, out, 'a switch is refused BGP by name');
  match(/BGP needs a device that routes/, out, 'and told what such a device is');
  match(/\(config\)#$/, sw.s.prompt(), 'and is left in config mode, not in a router mode');
  ok(!sw.d.config.bgp, 'with no BGP process created');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
