'use strict';
// ospf-router.test.js - the two commands every OSPF lab starts with, and this console did not have.
//
// Found by writing a dump-and-paste round trip over a broad configuration. While applying the
// reference config, this was in the list of refusals:
//   R1(config)#router ospf 1
//   % Unrecognized config command: router ospf 1
//   R1(config)#network 10.10.0.0 0.0.0.255 area 0
//   % Unrecognized config command: network 10.10.0.0 0.0.0.255 area 0
//
// `router bgp <as>` was implemented, so this was not a deliberate simplification - it was an
// asymmetry, and the OSPF half is the one every lab guide types. The model keeps the area on the
// *interface* (`ip ospf area`), which is why `network` had no home: it is the shorthand that writes
// that per-interface property, and it now says which interfaces it wrote.
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
  ok(re.test(text), msg + (re.test(text) ? '' : ' (no match in ' + JSON.stringify(text.slice(0, 900)) + ')'));
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const ROUTER = catalog.find(function (s) { return s.model === 'generic-router'; });

// Two routers joined by one cable, both named, both addressed.
function lab() {
  const t = new Topology();
  const r1 = t.addDevice(ROUTER); r1.name = 'R1';
  const r2 = t.addDevice(ROUTER); r2.name = 'R2';
  const portsOf = function (d) {
    return Array.from(d.interfaces.keys()).filter(function (n) {
      const i = d.interfaces.get(n);
      return !i.svi && !i.parent;
    });
  };
  const p1 = portsOf(r1), p2 = portsOf(r2);
  t.connect(r1.id, p1[0], r2.id, p2[0]);
  const sim = new Simulator(t);
  const mk = function (d) { const s = new CliSession(d, t, sim); s.run('enable'); return s; };
  const a = mk(r1), b = mk(r2);
  // A stable hostname: the prompt is part of what this suite asserts.
  r1.config.hostname = 'R1';
  r2.config.hostname = 'R2';
  const cfg = function (s, cmds) {
    s.run('configure terminal');
    const out = [];
    for (const c of cmds) out.push.apply(out, s.run(c).output);
    s.run('end');
    return out;
  };
  const address = function (s, dev, name, ip) {
    return cfg(s, ['interface ' + name, 'ip address ' + ip + ' 255.255.255.0', 'exit']);
  };
  return { t: t, sim: sim, r1: r1, r2: r2, a: a, b: b, cfg: cfg, address: address,
    p1: p1[0], p2: p2[0] };
}

console.log('\n`router ospf <pid>` starts the process and enters router mode:');
{
  const env = lab();
  env.address(env.a, env.r1, env.p1, '10.0.0.1');
  env.a.run('configure terminal');
  const out = env.a.run('router ospf 1');
  match(/OSPF process 1 enabled, entering router configuration mode/, out, 'the process is created');
  eq(env.a.prompt(), 'R1(config-router)#', 'and the prompt says where you are');
  match(/"network <net> <wildcard> area <id>" sets the area on every interface it matches/, out,
    'with the one thing an operator needs to know about the mode');
  eq(env.r1.config.ospf.pid, 1, 'the process id is stored');
  // Idempotence, typed from inside the mode - the case that used to be rewritten into
  // `router-id ospf 1` by the abbreviation pass and refused in the wrong vocabulary.
  match(/was already there/, env.a.run('router ospf 1'), 'entering the same process again says so');
  // A different id replaces it, because this model has one process per device.
  match(/OSPF process 7 enabled/, env.a.run('router ospf 7'), 'a different id is a different process');
  eq(env.r1.config.ospf.pid, 7, 'and it is the one stored');
  env.a.run('end');
  match(/"ospf 7"/, env.a.run('show ip ospf'), 'show ip ospf names the real process id');
}

console.log('\n`network <net> <wildcard> area <id>` writes the area and says where:');
{
  const env = lab();
  env.address(env.a, env.r1, env.p1, '10.0.0.1');
  env.a.run('configure terminal');
  env.a.run('router ospf 1');
  const out = env.a.run('network 10.0.0.0 0.0.0.255 area 0');
  eq(env.a.prompt(), 'R1(config-router)#', 'the network statement is typed inside the mode');
  match(/Network 10\.0\.0\.0 0\.0\.0\.255 area 0 put 1 interface in area 0/, out, 'matches are counted');
  match(/Gi0\/0 \(10\.0\.0\.1\): area 0/, out, 'and each matching interface is named with its address');
  // The area is the per-interface property the model already had, so the two doors agree.
  env.a.run('end');
  match(/ip ospf area 0/, env.a.run('show running-config'), 'the dump carries the area it wrote');
  env.a.run('configure terminal');
  env.a.run('router ospf 1');
  match(/Gi0\/0\s+.*\s+0/, env.a.run('show ip ospf'), 'and show ip ospf lists the interface in that area');
  env.a.run('configure terminal');
  env.a.run('router ospf 1');
  // A wildcard that matches nothing is the mistake that costs an afternoon: IOS takes it in silence.
  const miss = env.a.run('network 10.9.9.0 0.0.0.255 area 0');
  match(/No interface of R1 matches 10\.9\.9\.0 0\.0\.0\.255 - nothing was changed/, miss,
    'a network statement that matches nothing is refused, not accepted in silence');
  match(/IOS would accept this in silence, and the adjacency would never form/, miss,
    'and the reason it matters is stated');
  // `no network` takes the interface back out.
  match(/Gi0\/0: area removed/, env.a.run('no network 10.0.0.0 0.0.0.255 area 0'),
    'no network removes the area it set');
  const ov = env.r1.config.ospf.interfaces.filter(function (x) { return x.name === 'Gi0/0'; })[0];
  eq(ov.area, undefined, 'and the interface no longer has one');
}

console.log('\nThe areas it writes are the ones the adjacency check reads:');
{
  // Area 1 against area 0: no adjacency, with the reason in the show.
  const env = lab();
  env.address(env.a, env.r1, env.p1, '10.0.0.1');
  env.address(env.b, env.r2, env.p2, '10.0.0.2');
  env.cfg(env.a, ['router ospf 1', 'network 10.0.0.0 0.0.0.255 area 0', 'router-id 1.1.1.1']);
  env.cfg(env.b, ['router ospf 1', 'network 10.0.0.0 0.0.0.255 area 1', 'router-id 2.2.2.2']);
  const nbr = env.a.run('show ip ospf neighbor');
  match(/no adjacencies/, nbr, 'different areas do not form an adjacency');
  match(/R2 on Gi0\/0 is in area 1 and this interface is in area 0/, nbr, 'and the show says why');
  // Now agree, through the same commands, and the adjacency forms.
  env.cfg(env.b, ['router ospf 1', 'network 10.0.0.0 0.0.0.255 area 0']);
  const after = env.a.run('show ip ospf neighbor');
  match(/2\.2\.2\.2\s+1\s+FULL\s+10\.0\.0\.2\s+Gi0\/0/, after,
    'and once the areas agree, the adjacency is FULL');
}

console.log('\nEvery word of the two commands is checked where it is typed:');
{
  const env = lab();
  env.address(env.a, env.r1, env.p1, '10.0.0.1');
  const cfgOut = function (cmds) { return env.cfg(env.a, cmds); };
  for (const [line, why] of [
    ['router ospf', 'the process id is missing'],
    ['router ospf abc', 'a process id is a number'],
    ['router ospf 0', 'IOS process ids start at 1'],
    ['router ospf 65536', 'and stop at 65535'],
    ['router ospf 1 extra', 'a process id is one word']
  ]) {
    match(/%/, cfgOut([line]), '"' + line + '" is refused (' + why + ')');
  }
  match(/outside 1-65535/, cfgOut(['router ospf 0']), 'the range refusal names the range');
  match(/is not a process id/, cfgOut(['router ospf abc']), 'and a word is refused as a word');
  cfgOut(['router ospf 1']);
  for (const [line, why] of [
    ['network', 'the statement needs a network'],
    ['network 10.0.0.0', 'and a wildcard'],
    ['network 10.0.0.0 0.0.0.255', 'and the word area'],
    ['network 10.0.0.0 0.0.0.255 area', 'and an area id'],
    ['network abc 0.0.0.255 area 0', 'a network is an address'],
    ['network 10.0.0.0 abc area 0', 'a wildcard is a mask'],
    ['network 10.0.0.0 0.0.0.255 mask 0', 'the keyword is "area", not "mask"'],
    ['network 10.0.0.0 0.0.0.255 area 0 extra', 'an area id is the last word']
  ]) {
    match(/%/, cfgOut(['router ospf 1', line]), '"' + line + '" is refused (' + why + ')');
  }
  // A word that belongs to neither mode is reported in the vocabulary of the mode you are in.
  const bad = cfgOut(['router ospf 1', 'bogus verb']);
  match(/is not a router ospf command/, bad, 'an unknown verb is refused in router mode');
  match(/In this mode: network <net> <wildcard> area <id>/, bad, 'and the mode lists what it takes');
}

console.log('\nA line that belongs to global config leaves the mode instead of being lost:');
{
  // A pasted config never says `exit` before `interface Gi0/1`, and losing that line would leave a
  // configuration that is subtly wrong - the worst kind of paste.
  const env = lab();
  env.address(env.a, env.r1, env.p1, '10.0.0.1');
  env.cfg(env.a, ['router ospf 1', 'network 10.0.0.0 0.0.0.255 area 0']);
  env.a.run('configure terminal');
  env.a.run('router ospf 1');
  const out = env.a.run('hostname R1-core');
  match(/R1-core/, out.length ? out : env.a.run('show running-config'),
    'a global line is applied, not refused');
  eq(env.r1.config.hostname, 'R1-core', 'the hostname really changed');
  eq(env.a.prompt(), 'R1-core(config)#', 'and the mode is back to global config');
  // `exit` and `end` from the mode behave as they do everywhere.
  env.a.run('router ospf 1');
  match(/Leaving router configuration mode/, env.a.run('exit'), 'exit leaves the mode');
  eq(env.a.prompt(), 'R1-core(config)#', 'to global config');
  env.a.run('router ospf 1');
  env.a.run('end');
  eq(env.a.prompt(), 'R1-core#', 'end leaves configuration altogether');
}

console.log('\nThe process id and the areas survive a dump and a paste:');
{
  const env = lab();
  env.address(env.a, env.r1, env.p1, '10.0.0.1');
  env.address(env.a, env.r1, env.p1.replace(/\d+$/, '2'), '10.20.0.1');
  env.cfg(env.a, ['router ospf 1', 'network 10.0.0.0 0.0.0.255 area 0',
    'network 10.20.0.0 0.0.0.255 area 5', 'router-id 1.1.1.1']);
  const dump = env.a.run('show running-config').output;
  match(/^router ospf 1$/m, dump, 'the process block is dumped');
  match(/^ network 10\.0\.0\.1 0\.0\.0\.0 area 0$/m, dump,
    'with a host-wildcard statement per interface, so the paste lands exactly these areas');
  match(/^ network 10\.20\.0\.1 0\.0\.0\.0 area 5$/m, dump, 'one per interface, each with its own area');
  // Paste into a fresh router and compare.
  const t2 = new Topology();
  const twin = t2.addDevice(ROUTER); twin.name = 'R1';
  const clone = new CliSession(twin, t2, new Simulator(t2));
  clone.run('enable'); clone.run('configure terminal');
  for (const line of dump) {
    if (/^!/.test(line) || /^end$/.test(line) || /^Building configuration/.test(line) ||
      /^Current configuration/.test(line)) continue;
    clone.run(line);
  }
  clone.run('end');
  const again = clone.run('show running-config').output;
  eq(again.join('\n'), dump.join('\n'), 'the pasted router dumps identically to the original');
  eq(twin.config.ospf.pid, 1, 'including the process id');
  const areas = (twin.config.ospf.interfaces || []).map(function (x) { return x.name + '=' + x.area; }).sort();
  eq(areas.join(','), 'Gi0/0=0,Gi0/2=5', 'and both per-interface areas');
}

console.log('\nOSPF can still be turned off, and the model names what it does not run:');
{
  const env = lab();
  env.address(env.a, env.r1, env.p1, '10.0.0.1');
  env.cfg(env.a, ['router ospf 1', 'network 10.0.0.0 0.0.0.255 area 0']);
  match(/OSPF disabled/, env.cfg(env.a, ['no router ospf']), 'no router ospf removes the process');
  ok(!env.r1.config.ospf, 'and the configuration is gone');
  match(/% OSPF is not enabled/, env.a.run('show ip ospf'), 'the show says so afterwards');
  // EIGRP and RIP are not modelled, and the refusal says what is.
  for (const cmd of ['show ip eigrp neighbors', 'show ip rip database']) {
    match(/EIGRP and RIP are not modelled/, env.a.run(cmd), '"' + cmd + '" names the protocols here');
    match(/router ospf <pid>/, env.a.run(cmd), 'and points at the one to use');
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
