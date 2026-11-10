'use strict';
// Which side of a NAT translation a port is on (#1391).
//
// The model translated on every port in both directions: `_natOutbound()` ran at the top of `_forwardL3()`,
// before the route lookup, and asked only whether the *source* matched a rule. So a rule for 192.168.10.0/24
// rewrote the source address of a packet going from one inside host to another through the same router - a
// packet that never left the private network. And the two words that say which side is which, `ip nat inside`
// and `ip nat outside`, did not exist: type them and the console answered with the pool/rule usage, which does
// not mention inside or outside at all.
//
//   no roles declared   inside -> inside    translated   (the defect, kept as the older behaviour)
//   roles declared      inside -> inside    untouched    (the fix)
//   roles declared      inside -> outside   translated out and back
//
// A lab built before the roles existed keeps working, and `show ip nat` says out loud which of the two rules
// is in force.
const { loadCatalog } = require('../devices/registry');
const { Topology } = require('../engine/topology');
const { Simulator } = require('../engine/simulator');
const cliModule = require('../engine/cli');
const CliSession = cliModule.CliSession || cliModule;

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const ROOT = require('path').join(__dirname, '..');
const specs = loadCatalog(ROOT + '/devices').filter(function (s) { return !s.error; });
const ROUTER = specs.find(function (s) { return /ISR 4331/.test(s.model); });
const HOST = specs.find(function (s) { return /Raspberry Pi 5/.test(s.model); });
const L2 = specs.find(function (s) { return /CX 6000/.test(s.model) && !(s.capabilities || []).includes('nat'); });

function cli(dev, topo, cmds) {
  const s = new CliSession(dev, topo, new Simulator(topo));
  s.run('enable'); s.run('configure terminal');
  const out = (cmds || []).map(function (c) { return ((s.run(c) || {}).output || []).join(' | '); });
  return { out: out, session: s };
}

// in1 -- Gi0/0/0 (192.168.10.1)   inside
// in2 -- Gi0/0/1 (192.168.20.1)   inside
// out1 - Gi0/0/2 (203.0.113.1)    outside
function lab(declare) {
  const t = new Topology();
  t.addDevice(ROUTER, 'r1');
  for (const id of ['in1', 'in2', 'out1']) t.addDevice(HOST, id);
  t.connect('in1', 'eth0', 'r1', 'Gi0/0/0', { mediaId: '1000base-t', speedMbps: 1000 });
  t.connect('in2', 'eth0', 'r1', 'Gi0/0/1', { mediaId: '1000base-t', speedMbps: 1000 });
  t.connect('out1', 'eth0', 'r1', 'Gi0/0/2', { mediaId: '1000base-t', speedMbps: 1000 });
  const r1 = t.getDevice('r1');
  const set = function (p, ip) { const i = r1.interfaces.get(p); i.ip = ip; i.mask = '255.255.255.0'; };
  set('Gi0/0/0', '192.168.10.1'); set('Gi0/0/1', '192.168.20.1'); set('Gi0/0/2', '203.0.113.1');
  cli(t.getDevice('in1'), t, ['interface eth0', 'ip address 192.168.10.50 255.255.255.0', 'exit',
    'ip default-gateway 192.168.10.1']);
  cli(t.getDevice('in2'), t, ['interface eth0', 'ip address 192.168.20.60 255.255.255.0', 'exit',
    'ip default-gateway 192.168.20.1']);
  cli(t.getDevice('out1'), t, ['interface eth0', 'ip address 203.0.113.9 255.255.255.0', 'exit',
    'ip default-gateway 203.0.113.1']);
  const cmds = ['ip nat pool pub 203.0.113.10 203.0.113.10 netmask 255.255.255.255',
    'ip nat inside source list 192.168.10.0/24 pool pub overload'];
  if (declare) {
    cmds.push('interface Gi0/0/0', 'ip nat inside', 'exit',
      'interface Gi0/0/1', 'ip nat inside', 'exit',
      'interface Gi0/0/2', 'ip nat outside', 'exit');
  }
  cli(r1, t, cmds);
  return t;
}

// Count the translations a single ping produced, without re-implementing the engine.
function ping(t, src, dst) {
  const sim = new Simulator(t);
  const events = [];
  const orig = sim._emit.bind(sim);
  sim._emit = function (e) { if (/^nat-/.test(e.type)) events.push(e.type); return orig(e); };
  const res = sim.ping(src, dst, { count: 1 });
  return { ok: res.replies[0].success, reason: res.replies[0].reason, nat: events };
}

console.log('The defect: a translation belongs on a boundary, and there was no boundary');
{
  const legacy = lab(false);
  const a = ping(legacy, 'in1', '192.168.20.60');
  ok(a.ok, 'inside host reaches the other inside host', a.reason);
  ok(a.nat.length > 0, 'and the old model translated it on the way out (kept as the older behaviour)',
    a.nat.join(','));

  const declared = lab(true);
  const b = ping(declared, 'in1', '192.168.20.60');
  ok(b.ok, 'with the ports declared, the same ping still works', b.reason);
  ok(b.nat.length === 0, 'and nothing is translated: both ports are inside', b.nat.join(',') || 'none');
}

console.log('');
console.log('Across the boundary, both directions still translate');
{
  const t = lab(true);
  const out = ping(t, 'in1', '203.0.113.9');
  ok(out.ok, 'inside host reaches the outside host', out.reason);
  ok(out.nat.indexOf('nat-outbound') !== -1, 'the source is translated on the way out', out.nat.join(','));
  ok(out.nat.indexOf('nat-inbound') !== -1, 'and the reply is translated back in', out.nat.join(','));

  const out2 = ping(t, 'out1', '192.168.10.50');
  ok(typeof out2.ok === 'boolean', 'outside host is answered or refused, never an exception', out2.reason);
}

console.log('');
console.log('The command');
{
  const t = new Topology();
  t.addDevice(ROUTER, 'r1');
  const r1 = t.getDevice('r1');
  const s = new CliSession(r1, t, new Simulator(t));
  s.run('enable'); s.run('configure terminal');

  ok(/percent|%/.test(((s.run('ip nat inside') || {}).output || []).join(' ')),
    'in global config, `ip nat inside` says it belongs to an interface',
    ((s.run('ip nat inside') || {}).output || []).join(' '));

  s.run('interface Gi0/0/1');
  const setIn = ((s.run('ip nat inside') || {}).output || []).join(' | ');
  ok(/now the inside interface/.test(setIn), 'on a port it is accepted', setIn);
  const again = ((s.run('ip nat inside') || {}).output || []).join(' | ');
  ok(/already the inside interface/.test(again), 'setting it twice says so rather than silently repeating', again);
  const flip = ((s.run('ip nat outside') || {}).output || []).join(' | ');
  ok(/now the outside interface/.test(flip) && /\(was inside\)/.test(flip),
    'changing sides names the side it left', flip);
  ok(r1.interfaces.get('Gi0/0/1').natRole === 'outside', 'the port holds one side, not two',
    r1.interfaces.get('Gi0/0/1').natRole);
  const clearWrong = ((s.run('no ip nat inside') || {}).output || []).join(' | ');
  ok(/not the inside interface/.test(clearWrong) && /outside interface/.test(clearWrong),
    'clearing the side it does not hold says which side it does hold', clearWrong);
  const clear = ((s.run('no ip nat outside') || {}).output || []).join(' | ');
  ok(/no longer the outside interface/.test(clear), 'and clearing the side it holds works', clear);
  ok(!r1.interfaces.get('Gi0/0/1').natRole, 'the port has no side any more', String(r1.interfaces.get('Gi0/0/1').natRole));
  const nonsense = ((s.run('ip nat sideways') || {}).output || []).join(' | ');
  ok(/Usage: ip nat inside \| ip nat outside/.test(nonsense), 'a third side is refused with usage', nonsense);

  // A box that cannot translate cannot declare a side either.
  if (L2) {
    const t2 = new Topology();
    t2.addDevice(L2, 'sw1');
    const p = new CliSession(t2.getDevice('sw1'), t2, new Simulator(t2));
    p.run('enable'); p.run('configure terminal');
    const port = Array.from(t2.getDevice('sw1').interfaces.keys()).filter(function (n) { return !/^(mgmt|console)/i.test(n); })[0];
    p.run('interface ' + port);
    const refused = ((p.run('ip nat inside') || {}).output || []).join(' | ');
    ok(/cannot translate addresses/.test(refused) && /nat/.test(refused),
      'a switch with no `nat` capability is refused, naming the capability', refused);
    ok(!t2.getDevice('sw1').interfaces.get(port).natRole, 'and holds no side');
  }
}

console.log('');
console.log('The report says which rule is in force');
{
  const none = lab(false);
  const s1 = new CliSession(none.getDevice('r1'), none, new Simulator(none));
  const stats = ((s1.run('show ip nat statistics') || {}).output || []).join(' | ');
  ok(/no port is declared inside or outside/.test(stats),
    'undeclared ports are stated, not left to be guessed', stats.slice(0, 120));
  ok(/may translate on any port/.test(stats), 'and the consequence is spelled out', stats.slice(0, 120));

  const declared = lab(true);
  const s2 = new CliSession(declared.getDevice('r1'), declared, new Simulator(declared));
  const stats2 = ((s2.run('show ip nat statistics') || {}).output || []).join(' | ');
  ok(/inside Gi0\/0\/0, Gi0\/0\/1/.test(stats2), 'the inside ports are listed', stats2.slice(0, 100));
  ok(/outside Gi0\/0\/2/.test(stats2), 'and the outside ports', stats2.slice(0, 140));
  ok(!/no port is declared/.test(stats2), 'the honest fallback disappears once someone has said', stats2.slice(0, 80));
}

console.log('');
console.log('It survives the config and the file');
{
  const t = lab(true);
  const r1 = t.getDevice('r1');
  const s = new CliSession(r1, t, new Simulator(t));
  const printed = ((s.run('show running-config') || {}).output || []).join('\n');
  ok(/^\s+ip nat inside\s*$/m.test(printed), '`show running-config` prints the side inside the interface block',
    printed.split('\n').filter(function (l) { return /nat/.test(l); }).join(' / '));
  ok(/^\s+ip nat outside\s*$/m.test(printed), 'both sides appear');

  // What the printer wrote, the parser takes back.
  const fresh = new Topology();
  fresh.addDevice(ROUTER, 'r1');
  const fs = new CliSession(fresh.getDevice('r1'), fresh, new Simulator(fresh));
  fs.run('enable'); fs.run('configure terminal');
  let refusals = 0;
  for (const line of printed.split('\n')) {
    // Control-flow, not an exemption: a blank line or a banner is not a config line to replay.
    if (!line.trim() || /^(Building|Current|end)/i.test(line.trim())) continue;
    const o = ((fs.run(line.trim()) || {}).output || []).join(' ');
    if (/%/.test(o)) { refusals++; console.error('    refused: ' + line.trim() + ' -> ' + o); }
  }
  ok(refusals === 0, 'and the printed config replays with no refusals', String(refusals) + ' refusals');

  const doc = t.serialize();
  const saved = doc.devices.find(function (d) { return d.id === 'r1'; });
  ok(saved.interfaces.filter(function (i) { return i.natRole; }).length === 3,
    'a saved board carries the sides', JSON.stringify(saved.interfaces.filter(function (i) { return i.natRole; })
      .map(function (i) { return i.name + ':' + i.natRole; })));
  const back = Topology.fromJSON(doc).getDevice('r1');
  ok(back.interfaces.get('Gi0/0/0').natRole === 'inside' && back.interfaces.get('Gi0/0/2').natRole === 'outside',
    'and a reloaded board has them again',
    Array.from(back.interfaces.values()).filter(function (i) { return i.natRole; })
      .map(function (i) { return i.name + ':' + i.natRole; }).join(','));

  // And the behaviour survives the round trip, which is the point of saving it.
  const replayed = Topology.fromJSON(t.serialize());
  const c = ping(replayed, 'in1', '192.168.20.60');
  ok(c.ok && c.nat.length === 0, 'after a save and reload, inside-to-inside is still untouched',
    c.nat.join(',') || 'none');

  // A file that states nonsense is tolerated, not trusted.
  const bad = t.serialize();
  bad.devices.find(function (d) { return d.id === 'r1'; })
    .interfaces.forEach(function (i) { if (i.natRole) i.natRole = 'sideways'; });
  const tolerated = Topology.fromJSON(bad).getDevice('r1');
  ok(!Array.from(tolerated.interfaces.values()).some(function (i) { return i.natRole; }),
    'a role that is neither inside nor outside is dropped on load');
}

console.log('');
console.log('passed=' + passed + ' failed=' + failed);
process.exit(failed ? 1 : 0);
