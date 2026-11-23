'use strict';
// A NAT rule the console added after traffic never fired, and a rule it removed kept translating (#2465).
//
// `_natTableOf()` returned early once `dev.natTable` existed, and the rule set was copied from
// `config.nat` in that same `if` block, exactly once. The snapshot was taken at the first packet that
// needed translating and never refreshed:
//
//   ip nat inside source static 192.168.10.50 203.0.113.5    ping h1   table built, one rule
//   ip nat inside source static 192.168.10.51 203.0.113.6    ping h2   never translated (not in the table)
//   no ip nat inside source                                  (NAT rule removed) inbound to .5 still translated
//
// The console was right both times and the data path was reading a copy nobody updated. The rule set is
// re-read on every lookup now. A static entry is configuration and goes with its rule - left behind it kept
// reversing outside packets to a host whose replies were no longer translated, half a translation per flow -
// while a dynamic or PAT entry, which is state, stays to serve out its timeout.
const { loadCatalog } = require('../devices/registry');
const { Topology } = require('../engine/topology');
const { Simulator } = require('../engine/simulator');
const cliModule = require('../engine/cli');
const CliSession = cliModule.CliSession || cliModule;

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.error('  ✗ ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const ROOT = require('path').join(__dirname, '..');
const specs = loadCatalog(ROOT + '/devices').filter(function (s) { return !s.error; });
const ROUTER = specs.find(function (s) { return /ISR 4331/.test(s.model); });
const HOST = specs.find(function (s) { return /Raspberry Pi 5/.test(s.model); });
const SWITCH = specs.find(function (s) { return /CX 6000 24G CL4/.test(s.model); });

function config(dev, topo, cmds) {
  const s = new CliSession(dev, topo, new Simulator(topo));
  s.run('enable'); s.run('configure terminal');
  return (cmds || []).map(function (c) { return ((s.run(c) || {}).output || []).join(' | '); });
}

// h1 192.168.10.50 -- sw1 -- r1 Gi0/0/0 (192.168.10.1) inside   |   r1 Gi0/0/1 (203.0.113.1) outside -- out1
// h2 192.168.10.51 -- sw1
function lab(rules) {
  const t = new Topology();
  t.addDevice(ROUTER, 'r1');
  t.addDevice(SWITCH, 'sw1');
  for (const id of ['h1', 'h2', 'out1']) t.addDevice(HOST, id);
  const c = function (a, ap, b, bp) { t.connect(a, ap, b, bp, { mediaId: '1000base-t', speedMbps: 1000 }); };
  c('r1', 'Gi0/0/0', 'sw1', '1/1/1');
  c('h1', 'eth0', 'sw1', '1/1/2');
  c('h2', 'eth0', 'sw1', '1/1/3');
  c('out1', 'eth0', 'r1', 'Gi0/0/1');
  const r1 = t.getDevice('r1');
  const set = function (p, ip) { const i = r1.interfaces.get(p); i.ip = ip; i.mask = '255.255.255.0'; };
  set('Gi0/0/0', '192.168.10.1'); set('Gi0/0/1', '203.0.113.1');
  config(t.getDevice('h1'), t, ['interface eth0', 'ip address 192.168.10.50 255.255.255.0', 'exit',
    'ip default-gateway 192.168.10.1']);
  config(t.getDevice('h2'), t, ['interface eth0', 'ip address 192.168.10.51 255.255.255.0', 'exit',
    'ip default-gateway 192.168.10.1']);
  config(t.getDevice('out1'), t, ['interface eth0', 'ip address 203.0.113.9 255.255.255.0', 'exit',
    'ip default-gateway 203.0.113.1']);
  config(r1, t, ['interface Gi0/0/0', 'ip nat inside', 'exit',
    'interface Gi0/0/1', 'ip nat outside', 'exit'].concat(rules || []));
  return t;
}

// One ping, and the translations it caused, read from the events the data path already emits.
function ping(t, src, dst) {
  const sim = new Simulator(t);
  sim.setRunTime(60000);
  const events = [];
  const orig = sim._emit.bind(sim);
  sim._emit = function (e) { if (/^nat-/.test(e.type)) events.push(e); return orig(e); };
  const res = sim.ping(src, dst, { count: 1 });
  return { ok: res.replies[0].success, reason: res.replies[0].reason, nat: events };
}
function translatedOut(events) {
  return events.filter(function (e) { return e.type === 'nat-outbound'; })[0] || null;
}
function translatedIn(events) {
  return events.filter(function (e) { return e.type === 'nat-inbound'; })[0] || null;
}

console.log('A rule added after the table exists fires, and the console said so all along');
{
  const t = lab(['ip nat inside source static 192.168.10.50 203.0.113.5']);
  const r1 = t.getDevice('r1');
  const first = ping(t, 'h1', '203.0.113.9');
  ok(first.ok && translatedOut(first.nat), 'h1 translates under the configured rule',
    first.reason || first.nat.map(function (e) { return e.type; }).join(','));
  ok(r1.natTable && r1.natTable.rules.length === 1, 'and the table exists with one rule',
    r1.natTable ? String(r1.natTable.rules.length) : 'no table');

  const said = config(r1, t, ['ip nat inside source static 192.168.10.51 203.0.113.6']);
  ok(/NAT rule added: /.test(said[0] || '') && String(said[0]).indexOf('192.168.10.51') !== -1,
    'the second rule is accepted', said[0]);

  const second = ping(t, 'h2', '203.0.113.9');
  const out = translatedOut(second.nat);
  ok(second.ok, 'h2 still reaches the outside host', second.reason);
  ok(out !== null, 'and the rule added after traffic translates it',
    second.nat.map(function (e) { return e.type; }).join(',') || 'none');
  ok(out && out.insideGlobal === '203.0.113.6', 'to the address the new rule names',
    out ? out.insideGlobal : 'none');
  ok(r1.natTable.rules.length === 2, 'the table holds both rules now', String(r1.natTable.rules.length));
}

console.log('');
console.log('A rule removed after traffic stops translating new packets');
{
  const t = lab(['ip nat inside source static 192.168.10.51 203.0.113.6',
    'ip nat inside source static 192.168.10.50 203.0.113.5']);
  const r1 = t.getDevice('r1');
  const first = ping(t, 'h1', '203.0.113.9');
  ok(first.ok && translatedOut(first.nat), 'h1 translates while its rule is configured', first.reason);

  const said = config(r1, t, ['no ip nat inside source']);
  ok(/NAT rule removed: /.test(said[0] || '') && String(said[0]).indexOf('192.168.10.50') !== -1,
    'the console removes the rule and names it', said[0]);
  ok(r1.config.nat.rules.length === 1, 'one rule is left in the config', String(r1.config.nat.rules.length));

  const after = ping(t, 'h1', '203.0.113.9');
  ok(after.ok, 'h1 still reaches the outside host', after.reason);
  ok(translatedOut(after.nat) === null, 'but nothing translates it any more: the rule is gone',
    (translatedOut(after.nat) || {}).insideGlobal || 'none');
}

console.log('');
console.log('The same in the other direction, and the console and the table agree afterwards');
{
  const t = lab(['ip nat inside source static 192.168.10.51 203.0.113.6',
    'ip nat inside source static 192.168.10.50 203.0.113.5']);
  const r1 = t.getDevice('r1');
  const first = ping(t, 'h1', '203.0.113.9');
  ok(first.ok && translatedOut(first.nat), 'h1 translates under its static rule', first.reason);

  // A packet from outside addressed to the global .5, handed straight to the ingress hook: the outside host
  // cannot ARP for a NAT global the box does not hold, so a ping to it never leaves out1 (a gap of its own).
  const frame = function () {
    return { ip: { src: '203.0.113.9', dst: '203.0.113.5' }, icmp: { type: 8, code: 0, id: 1, seq: 1 } };
  };
  const sim = new Simulator(t);
  sim.setRunTime(60000);
  const before = frame();
  const inb = sim._natInbound(r1, before, 'Gi0/0/1');
  ok(inb === true && before.ip.dst === '192.168.10.50',
    'an outside packet to the global address is translated in to h1', before.ip.dst);
  ok(r1.natTable.translations.some(function (e) {
    return e.type === 'static' && e.insideLocal === '192.168.10.50';
  }), 'and the table holds the static entry',
  JSON.stringify(r1.natTable.translations.map(function (e) { return e.type; })));

  config(r1, t, ['no ip nat inside source']);
  const after = frame();
  const stillIn = new Simulator(t)._natInbound(r1, after, 'Gi0/0/1');
  ok(stillIn === false && after.ip.dst === '203.0.113.5',
    'once removed, the same outside packet is no longer translated in', after.ip.dst);
  ok(!r1.natTable.translations.some(function (e) {
    return e.type === 'static' && e.insideLocal === '192.168.10.50';
  }), 'and the entry that rule made went with it, so no flow is left half-translated',
  JSON.stringify(r1.natTable.translations.map(function (e) { return e.type; })));
}

console.log('');
console.log('Pruning the static entries cannot touch state');
{
  const nat = require('../engine/nat');
  const table = nat.createNatTable();
  table.rules.push({ type: 'pat', insideLocal: '192.168.10.0/24', insideGlobal: '203.0.113.1' });
  nat.translateOutbound(table, { srcIp: '192.168.10.50', srcPort: 4000, dstIp: '8.8.8.8', dstPort: 443, protocol: 'tcp' }, 10);
  table.rules.push({ type: 'static', insideLocal: '192.168.10.60', insideGlobal: '203.0.113.7' });
  nat.translateOutbound(table, { srcIp: '192.168.10.60', srcPort: 4000, dstIp: '8.8.8.8', dstPort: 443, protocol: 'tcp' }, 11);
  ok(nat.pruneStaticTranslations(table) === 0, 'a rule still present keeps its entry');
  table.rules = table.rules.filter(function (r) { return r.type !== 'static'; });
  ok(nat.pruneStaticTranslations(table) === 1, 'a rule that has gone takes exactly its own entry');
  ok(table.translations.some(function (e) { return e.type === 'pat'; }),
    'and the PAT entry, which is state, is still there',
    JSON.stringify(table.translations.map(function (e) { return e.type; })));
  ok(nat.pruneStaticTranslations(nat.createNatTable()) === 0, 'an empty table prunes nothing');
}

console.log('Rebuilding the rule set neither mutates the config nor invents a table');
{
  const t = lab(['ip nat inside source static 192.168.10.50 203.0.113.5']);
  const r1 = t.getDevice('r1');
  const before = JSON.stringify(r1.config.nat);
  const rules = r1.config.nat.rules;
  ping(t, 'h1', '203.0.113.9');
  ping(t, 'out1', '203.0.113.5');
  ok(JSON.stringify(r1.config.nat) === before, 'the forced traffic leaves config.nat byte-identical', before);
  ok(r1.config.nat.rules === rules, 'and the config still owns the same rule array');
  ok(r1.natTable.rules !== r1.config.nat.rules, 'the table reads a copy, not the config array itself');

  const quiet = lab(['ip nat inside source static 192.168.10.50 203.0.113.5']);
  ok(!quiet.getDevice('r1').natTable, 'a box that has forwarded nothing still has no table');
}

console.log('');
console.log('NAT rule reload: ' + passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
