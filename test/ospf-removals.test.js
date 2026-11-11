'use strict';
// ospf-removals.test.js - `no ospf` takes three shapes, and each removes one thing.
//
// The handler ignored everything after `no ospf`:
//
//   R1(config)#no ospf area -1
//   OSPF disabled                      <- an area id that cannot exist, and the process is gone
//   R1(config)#no ospf router-id 9.9.9.9
//   OSPF disabled                      <- the router id is not what was removed
//
// while the page documents the row as "forget the id, or one area". Every form disabled the whole
// process, so a lab configured with `ospf area 10` could not be put back into area 0 without losing
// its router id and its interfaces, and a nonsense value destroyed the process instead of being
// refused. The rules from the other removals apply unchanged: a value that cannot work is refused for
// what it is, and a removal removes exactly what it names.
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

function ospfRouter() {
  const t = new Topology();
  const d = t.addDevice(find('generic-router')); d.name = 'R1';
  const s = new CliSession(d, t, new Simulator(t));
  s.run('enable');
  s.run('configure terminal');
  s.run('router ospf 1');
  return { t: t, d: d, s: s };
}

console.log('A value that cannot be an area id is refused, and nothing is touched:');
{
  // `no ospf area` with no argument is the bare form, tested below - these are the values it must
  // judge before it decides anything.
  for (const bad of ['-1', 'zzz', '4294967296', '10.0.0']) {
    const env = ospfRouter();
    const out = text(env.s.run('no ospf area ' + bad));
    ok(/not an area id/.test(out), '"' + bad + '" is refused as an area id (' + out.split('\n')[0] + ')');
    ok(/0-4294967295/.test(out), 'and the range it must be in is named');
    ok(env.d.config.ospf !== null, 'and the OSPF process is still there');
  }
}

console.log('\nAn area the process is not in is refused, naming the one it is in:');
{
  const env = ospfRouter();
  env.s.run('ospf area 10');
  const out = text(env.s.run('no ospf area 99'));
  ok(/is not in area 99/.test(out), 'the area named is the one it is not in');
  ok(/It is in area 10/.test(out), 'and the one in use is printed');
  ok(env.d.config.ospf && env.d.config.ospf.areaId === 10, 'and the process stays in area 10');
}

console.log('\nThe area it is in can be removed, and that is all that changes:');
{
  const env = ospfRouter();
  env.s.run('ospf router-id 1.1.1.1');
  env.s.run('ospf area 10');
  const before = JSON.parse(JSON.stringify(env.d.config.ospf));
  const out = text(env.s.run('no ospf area 10'));
  ok(/area 10 removed/.test(out), 'the removal names the area (' + out.split('\n')[0] + ')');
  ok(/area 0/.test(out), 'and where it went back to');
  ok(env.d.config.ospf.areaId === 0, 'the process is in area 0');
  ok(env.d.config.ospf.routerId === before.routerId,
    'and the router id it had is untouched (' + env.d.config.ospf.routerId + ')');
  ok(env.d.config.ospf !== null, 'and the process still exists');
  // A dotted-quad area is the form RFC 2328 prints, and the same removal works on it.
  const d = ospfRouter();
  d.s.run('ospf area 0.0.0.1');
  ok(/area 1 removed/.test(text(d.s.run('no ospf area 0.0.0.1'))), 'a dotted-quad area is removable too');
}

console.log('\nThe router id is removed on its own, and a mismatched one is refused:');
{
  const env = ospfRouter();
  env.s.run('ospf router-id 1.1.1.1');
  const out = text(env.s.run('no ospf router-id 9.9.9.9'));
  ok(/does not use 9\.9\.9\.9/.test(out), 'a router id it does not use is refused');
  ok(/It uses 1\.1\.1\.1/.test(out), 'and the one it uses is printed');
  ok(env.d.config.ospf.routerId === '1.1.1.1', 'and it is unchanged');
  const gone = text(env.s.run('no ospf router-id'));
  ok(/Router-id 1\.1\.1\.1 removed/.test(gone), 'the bare form removes the configured id');
  ok(/derives one/.test(gone), 'and says what takes over');
  ok(env.d.config.ospf.routerId === null, 'and nothing is configured any more');
  ok(/No router-id is configured/.test(text(env.s.run('no ospf router-id'))),
    'removing it twice says there is none');
  // The configured id can also be named, so a `no` line can quote what it removes.
  const byName = ospfRouter();
  byName.s.run('ospf router-id 1.1.1.1');
  ok(/Router-id 1\.1\.1\.1 removed/.test(text(byName.s.run('no ospf router-id 1.1.1.1'))),
    'and the id can be named instead of implied');
  ok(byName.d.config.ospf.routerId === null, 'with the same effect');
}

console.log('\nThe bare form turns the process off, and says what it took:');
{
  const env = ospfRouter();
  env.d.interfaces.forEach(function (i) { if (/^Gi0\/0$/.test(i.name)) { i.ip = '10.0.0.1'; i.mask = '255.255.255.0'; } });
  env.s.run('ospf area 10');
  env.s.run('ospf router-id 1.1.1.1');
  const out = text(env.s.run('no ospf'));
  ok(/^OSPF disabled/.test(out), 'the process is disabled');
  ok(/area 10/.test(out), 'and the area it was in is named (' + out.split('\n')[0] + ')');
  ok(env.d.config.ospf === null, 'and it is gone');
  ok(/not enabled/.test(text(env.s.run('no ospf'))), 'disabling it twice says there is nothing to remove');
}

console.log('\nA word the form does not take is refused, not ignored:');
{
  const env = ospfRouter();
  env.s.run('ospf area 10');
  const out = text(env.s.run('no ospf process'));
  ok(/^%/.test(out), 'an unknown shape is a refusal');
  ok(/Usage: no ospf/.test(out), 'and the shapes it does take are listed');
  ok(env.d.config.ospf !== null && env.d.config.ospf.areaId === 10, 'and nothing was removed');
}

console.log('\nThe page and the parser agree on the shape:');
{
  const env = ospfRouter();
  // The rows live on the configuration page, not the router page: `end` first, which is also what a
  // person does before asking `?` about a global command.
  env.s.run('end');
  env.s.run('configure terminal');
  const page = (env.s._help() || []).join('\n');
  ok(/no ospf router-id/.test(page), 'the page offers the router-id removal');
  ok(/no ospf area/.test(page), 'and the area removal');
  ok(!/no ospf router-id \| no ospf area <id>/.test(page),
    'without pretending the argument is mandatory');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
