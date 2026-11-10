'use strict';
// subinterface.test.js - a subinterface is a tag on a wire, and three commands around it disagreed
// with that.
//
//   1. `interface Vlan20.10` was *accepted*: the parent SVI was rewritten as a trunk with an empty
//      allowed list, so VLAN 20 vanished from `show vlan`, and the child was listed as a port of
//      VLAN 1. An SVI is the address its VLAN answers on - there is nothing to tag.
//   2. `show vlan` listed a subinterface in a column headed Ports, under VLAN 1, whatever its tag.
//   3. `swap: switchport trunk allowed vlan add 30` - the command the console's own notice tells the
//      operator to type - did not exist: the tokens were joined into "add30" and refused with the
//      parser's vocabulary (`cannot parse VLAN token "add30"`).
//
// and the child's line followed its parent only when the parent had a peer, so an uncabled port's
// subinterface reported `up up`.
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

function switchLab(cable) {
  const t = new Topology();
  const sw = t.addDevice(find('generic-switch')); sw.name = 'SW1';
  if (cable) {
    const pc = t.addDevice(find('generic-pc')); pc.name = 'PC1';
    const swPort = Array.from(sw.interfaces.values()).filter(function (i) { return !i.svi; })[0].name;
    const pcPort = Array.from(pc.interfaces.values())[0].name;
    t.connect(sw.id, swPort, pc.id, pcPort);
  }
  const s = new CliSession(sw, t, new Simulator(t));
  s.run('enable'); s.run('configure terminal');
  return { t: t, d: sw, s: s };
}
function brief(env) {
  const saved = env.s.mode;
  env.s.run('end');
  const rows = text(env.s.run('show ip interface brief')).split('\n');
  env.s.run('configure terminal');
  void saved;
  return rows;
}
function rowFor(rows, name) {
  return rows.filter(function (l) { return l.indexOf(name) === 0; })[0] || '';
}

console.log('An SVI has no wire to tag:');
{
  const env = switchLab(false);
  env.s.run('interface vlan 20'); env.s.run('ip address 10.0.20.1 255.255.255.0'); env.s.run('exit');
  const before = text(env.s.run('show vlan'));
  const out = text(env.s.run('interface Vlan20.10'));
  ok(/logical interface - there is no wire to tag/.test(out), 'the subinterface is refused');
  ok(/An SVI is the address its VLAN answers on/.test(out), 'and says what an SVI is');
  ok(/physical port/.test(out), 'and where a subinterface does belong');
  ok(!env.d.interfaces.has('Vlan20.10'), 'nothing was created');
  ok(text(env.s.run('show vlan')) === before, 'and the VLAN table is exactly what it was');
  ok(/20\s+VLAN0020\s+active\s+Vlan20 \(SVI\)/.test(before), 'VLAN 20 still lists its SVI');
}

console.log('\nA physical parent is the real case:');
{
  const env = switchLab(true);
  env.s.run('interface Fa0/1'); env.s.run('switchport mode trunk');
  // An explicit list, not "allow all": a trunk that allows everything carries the tag already, and
  // the notice is specifically about a tag the port cannot carry.
  env.s.run('switchport trunk allowed vlan 10,20');
  env.s.run('exit');
  const out = text(env.s.run('interface Fa0/1.30'));
  ok(/Created subinterface Fa0\/1\.30/.test(out), 'the subinterface is created');
  ok(/dot1q 30 from the interface number/.test(out), 'the tag is inferred from the name, and said');
  ok(/not in Fa0\/1's allowed list/.test(out), 'and a tag the port cannot carry is reported');
  ok(/switchport trunk allowed vlan add 30/.test(out), 'with the command that would allow it');
  // The pointer must be a command that exists - this is the defect that made the notice a lie.
  env.s.run('exit');
  env.s.run('interface Fa0/1');
  const fixed = text(env.s.run('switchport trunk allowed vlan add 30'));
  ok(/now allows VLANs 10,20,30/.test(fixed), 'the named command runs');
  env.s.run('exit');
  const again = text(env.s.run('interface Fa0/1.40'));
  ok(/Created subinterface Fa0\/1\.40/.test(again), 'a second subinterface is created');
  ok(/not in Fa0\/1's allowed list \(10,20,30\)/.test(again),
    'and the next tag is reported against the list as it now stands');
}

console.log('\nA subinterface is not a port:');
{
  const env = switchLab(true);
  env.s.run('interface Fa0/1'); env.s.run('switchport mode trunk'); env.s.run('exit');
  env.s.run('interface Fa0/1.30'); env.s.run('ip address 10.0.30.1 255.255.255.0'); env.s.run('exit');
  const table = text(env.s.run('show vlan'));
  ok(!/Fa0\/1\.30/.test(table), 'show vlan lists no subinterface (' + table.split('\n').length + ' rows)');
  ok(/Fa0\/1\(n\)|Fa0\/1\(trunk\)/.test(table), 'the parent port is still listed, as a port');
  const env2 = switchLab(false);
  env2.s.run('interface Fa0/2.50'); env2.s.run('exit');
  ok(!/Fa0\/2\.50/.test(text(env2.s.run('show vlan'))),
    'and not on an access port either (where it would have landed in VLAN 1)');
}

console.log('\nThe allowed list can be widened and narrowed:');
{
  const env = switchLab(false);
  env.s.run('interface Fa0/1'); env.s.run('switchport mode trunk');
  env.s.run('switchport trunk allowed vlan 10,20');
  ok(/now allows VLANs 10,20,30/.test(text(env.s.run('switchport trunk allowed vlan add 30'))),
    'add 30 widens the list');
  ok(/already allows 30/.test(text(env.s.run('switchport trunk allowed vlan add 30'))),
    'adding it twice says so instead of duplicating it');
  ok(/no longer allows 20 \(now: 10,30\)/.test(text(env.s.run('switchport trunk allowed vlan remove 20'))),
    'remove 20 narrows it, and the answer says what is left');
  ok(/allows VLANs 10,20/.test(text(env.s.run('switchport trunk allowed vlan 10 20'))),
    'a plain list still replaces the list (space separated)');
  const except = text(env.s.run('switchport trunk allowed vlan except 10'));
  ok(/no "except" form/.test(except), 'except is refused by naming what this console stores');
  ok(/add <list>/.test(except) && /remove <list>/.test(except), 'and offering the two forms it has');
  const bad = text(env.s.run('switchport trunk allowed vlan add abc'));
  ok(/is not a VLAN id, a list \(10,20\) or a range \(10-20\)/.test(bad),
    'a bad value is described in an operator\'s words');
  ok(!/token/.test(bad), 'not the parser\'s ("cannot parse VLAN token")');
}

console.log('\n"No VLAN allowed" is a state that survives a paste:');
{
  const env = switchLab(false);
  env.s.run('interface Fa0/1'); env.s.run('switchport mode trunk');
  env.s.run('switchport trunk allowed vlan 10');
  env.s.run('switchport trunk allowed vlan remove 10');
  ok(/allows no VLAN/.test(text(env.s.run('switchport trunk allowed vlan none'))),
    'none is a legal state and says what it costs');
  env.s.run('exit');
  const dump = text(env.s.run('show running-config')).split('\n')
    .filter(function (l) { return /switchport trunk allowed/.test(l); });
  ok(dump.length === 1 && /allowed vlan none$/.test(dump[0].trim()),
    'and the dump carries it (' + JSON.stringify(dump) + ')');
  // and it pastes back
  env.s.run('configure terminal');
  env.s.run('interface Fa0/1');
  ok(/allows no VLAN/.test(text(env.s.run(dump[0].trim().replace(/^switchport/, 'switchport')))),
    'the dumped line is accepted by the parser');
}

console.log('\nA child borrows its parent\'s line:');
{
  const up = switchLab(true);
  up.s.run('interface Fa0/1.30'); up.s.run('ip address 10.0.30.1 255.255.255.0'); up.s.run('exit');
  ok(/\bup\s+up\b/.test(rowFor(brief(up), 'Fa0/1.30')), 'cabled parent: up/up');
  const unn = switchLab(false);
  unn.s.run('interface Fa0/1.30'); unn.s.run('ip address 10.0.30.1 255.255.255.0'); unn.s.run('exit');
  const r = rowFor(brief(unn), 'Fa0/1.30');
  ok(/\bup\s+down\b/.test(r), 'uncabled parent: the protocol follows it down (' + r.trim() + ')');
  unn.s.run('configure terminal'); unn.s.run('interface Fa0/1'); unn.s.run('shutdown');
  ok(/administratively down\s+down/.test(rowFor(brief(unn), 'Fa0/1.30')),
    'and a shut parent takes the child with it');
  const shown = text(new CliSession(unn.d, unn.t, new Simulator(unn.t)).run('show interfaces Fa0/1.30'));
  ok(/line protocol: down \(parent Fa0\/1/.test(shown), 'the reason names the parent');
}

console.log('\nThe dump restores the child exactly:');
{
  const env = switchLab(true);
  env.s.run('interface Fa0/1'); env.s.run('switchport mode trunk'); env.s.run('exit');
  env.s.run('interface Fa0/1.30'); env.s.run('ip address 10.0.30.1 255.255.255.0');
  env.s.run('description uplink tag'); env.s.run('exit');
  const dump = text(env.s.run('show running-config'));
  const block = dump.split('\n').filter(function (l) { return /Fa0\/1\.30/.test(l); });
  ok(/interface Fa0\/1\.30/.test(block[0] || ''), 'the block is dumped');
  const tail = dump.split('interface Fa0/1.30')[1] || '';
  ok(/encapsulation dot1q 30/.test(tail), 'with the tag');
  ok(/ip address 10\.0\.30\.1 255\.255\.255\.0/.test(tail), 'and the address');
  ok(/description uplink tag/.test(tail), 'and the description');
  // A fresh device takes the same lines back.
  const fresh = switchLab(false);
  fresh.s.run('interface Fa0/1'); fresh.s.run('switchport mode trunk'); fresh.s.run('exit');
  for (const line of ('interface Fa0/1.30\n' + tail).split('\n')) {
    if (!line.trim()) continue;
    fresh.s.run(line.trim().replace(/^interface Fa0\/1\.30$/, 'interface Fa0/1.30'));
  }
  const back = fresh.d.interfaces.get('Fa0/1.30');
  ok(back && back.ip === '10.0.30.1', 'and the pasted block recreates the address');
  ok(back && Number(back.encapVid) === 30, 'and the tag');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
