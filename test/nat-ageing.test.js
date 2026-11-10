'use strict';
// A NAT translation that has been idle longer than its timeout is not in force (#1393).
//
// `natLib.expireTranslations()` was written with the model and nothing ever called it. Two consequences, both
// measurable: a two-address dynamic pool stayed exhausted by connections that ended minutes ago, and
// `show ip nat translations` listed entries past their timeout because it read `dev.natTable` directly instead of
// asking at the instant the command was about.
//
//   t=60 s    h1 and h2 take both pool addresses; h3 is refused, pool exhausted   (correct)
//   t=200 s   h3 succeeds, because the ICMP entries from t=60 s are 140 s idle    (impossible before)
//
// The timeout is the protocol's, in seconds: ICMP 60, UDP 300, TCP 3600, other 300.
const { loadCatalog } = require('../devices/registry');
const { Topology } = require('../engine/topology');
const { Simulator } = require('../engine/simulator');
const cliModule = require('../engine/cli');
const natLib = require('../engine/nat');
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
const SWITCH = specs.find(function (s) { return /CX 6000 24G CL4/.test(s.model); });

function cli(dev, topo, cmds) {
  const s = new CliSession(dev, topo, new Simulator(topo));
  s.run('enable'); s.run('configure terminal');
  const out = (cmds || []).map(function (c) { return ((s.run(c) || {}).output || []).join(' | '); });
  return { out: out, session: s };
}

// r1 Gi0/0/0 (192.168.10.1, inside) -- sw1 -- h1, h2, h3   |   r1 Gi0/0/1 (203.0.113.1, outside) -- out1
// A two-address pool, and a /24 rule, so three inside hosts contend for two addresses.
function lab() {
  const t = new Topology();
  t.addDevice(ROUTER, 'r1');
  t.addDevice(SWITCH, 'sw1');
  for (const id of ['h1', 'h2', 'h3', 'out1']) t.addDevice(HOST, id);
  const r1 = t.getDevice('r1');
  r1.interfaces.get('Gi0/0/0').ip = '192.168.10.1'; r1.interfaces.get('Gi0/0/0').mask = '255.255.255.0';
  r1.interfaces.get('Gi0/0/1').ip = '203.0.113.1'; r1.interfaces.get('Gi0/0/1').mask = '255.255.255.0';
  const c = function (a, ap, b, bp) { t.connect(a, ap, b, bp, { mediaId: '1000base-t', speedMbps: 1000 }); };
  c('r1', 'Gi0/0/0', 'sw1', '1/1/1');
  c('h1', 'eth0', 'sw1', '1/1/2');
  c('h2', 'eth0', 'sw1', '1/1/3');
  c('h3', 'eth0', 'sw1', '1/1/4');
  c('out1', 'eth0', 'r1', 'Gi0/0/1');
  const host = function (id, ip) {
    cli(t.getDevice(id), t, ['interface eth0', 'ip address ' + ip + ' 255.255.255.0', 'exit',
      'ip default-gateway ' + (id === 'out1' ? '203.0.113.1' : '192.168.10.1')]);
  };
  host('h1', '192.168.10.50'); host('h2', '192.168.10.51'); host('h3', '192.168.10.52');
  host('out1', '203.0.113.9');
  cli(r1, t, ['ip nat pool two 203.0.113.10 203.0.113.11 netmask 255.255.255.0',
    'ip nat inside source list 192.168.10.0/24 pool two',
    'interface Gi0/0/0', 'ip nat inside', 'exit',
    'interface Gi0/0/1', 'ip nat outside', 'exit']);
  return t;
}

function table(t) {
  return t.getDevice('r1').natTable || { translations: [] };
}

console.log('The pool is the proof: two addresses, three hosts, two minutes');
{
  const t = lab();
  const sim = new Simulator(t);
  // The switch has to settle before anything crosses; both inside hosts then take one address each.
  sim.setRunTime(60000);
  const a = sim.ping('h1', '203.0.113.9', { count: 1 });
  const b = sim.ping('h2', '203.0.113.9', { count: 1 });
  ok(a.replies[0].success && b.replies[0].success, 'two inside hosts translate at t=60 s',
    a.replies[0].reason || b.replies[0].reason);
  ok(table(t).translations.length === 2, 'the two pool addresses are in use',
    String(table(t).translations.length));
  const third = sim.ping('h3', '203.0.113.9', { count: 1 });
  ok(!third.replies[0].success && /already translated/.test(String(third.replies[0].reason)),
    'a third host is refused: both addresses are held by live translations', third.replies[0].reason);

  // 140 s later the two ICMP translations are idle past the 60 s timeout. Before the fix nothing aged them and
  // the third host was refused for the life of the run.
  sim.setRunTime(200000);
  const late = sim.ping('h3', '203.0.113.9', { count: 1 });
  ok(late.replies[0].success, 'at t=200 s the third host gets an address', late.replies[0].reason);
  ok(table(t).translations.length === 1,
    'and the two lapsed entries are gone rather than accumulating', String(table(t).translations.length));
  ok(/^192\.168\.10\.5\d$/.test(String(table(t).translations[0].insideLocal)),
    'the live translation belongs to the host that just asked', String(table(t).translations[0].insideLocal));
}

console.log('');
console.log('A translation that is still in use does not expire');
{
  const t = lab();
  const sim = new Simulator(t);
  sim.setRunTime(60000);
  sim.ping('h1', '203.0.113.9', { count: 1 });
  ok(table(t).translations.length === 1, 'one translation exists');
  // 30 s later, still inside the 60 s ICMP timeout: asking again keeps the same mapping.
  sim.setRunTime(90000);
  sim.ping('h1', '203.0.113.9', { count: 1 });
  ok(table(t).translations.length === 1,
    'the same host reuses its translation instead of taking a second address', String(table(t).translations.length));
  const g1 = table(t).translations[0].insideGlobal;
  // 30 s after that: 30 s idle, so still in force - an idle timer, not a lifetime.
  sim.setRunTime(120000);
  sim.ping('h1', '203.0.113.9', { count: 1 });
  ok(table(t).translations[0].insideGlobal === g1 && table(t).translations.length === 1,
    'and each use refreshes it: 90 s after it was made it is still there', String(table(t).translations.length));
  // Now genuinely idle past the timeout.
  sim.setRunTime(200000);
  sim.ping('h2', '203.0.113.9', { count: 1 });
  ok(table(t).translations.length === 1 && table(t).translations[0].insideLocal === '192.168.10.51',
    'after 80 s of silence the first one is gone and the address is free',
    JSON.stringify(table(t).translations.map(function (e) { return e.insideLocal; })));
}

console.log('');
console.log('Each protocol is held to its own timeout');
{
  const t = lab();
  t.getDevice('r1').config.nat.timeouts = { icmp: 10, udp: 300, tcp: 3600, other: 300 };
  const sim = new Simulator(t);
  sim.setRunTime(60000);
  sim.ping('h1', '203.0.113.9', { count: 1 });
  ok(table(t).translations.length === 1, 'an entry exists under a 10 s ICMP timeout');
  sim.setRunTime(65000);   // 5 s later: still inside
  ok(sim._natTableOf(t.getDevice('r1')).translations.length === 1, '5 s later it is still in force');
  sim.setRunTime(71000);   // 11 s after it was made: outside
  ok(sim._natTableOf(t.getDevice('r1')).translations.length === 0,
    '11 s after it was made it is gone, because the configured timeout is 10 s',
    String(sim._natTableOf(t.getDevice('r1')).translations.length));
}

console.log('');
console.log('The console reads the table at the instant it is asked');
{
  const t = lab();
  const sim = new Simulator(t);
  sim.setRunTime(60000);
  sim.ping('h1', '203.0.113.9', { count: 1 });
  const s = new CliSession(t.getDevice('r1'), t, sim);
  const early = ((s.run('show ip nat translations') || {}).output || []).join('\n');
  ok(/203\.0\.113\.1[01]/.test(early), 'the translation is listed at the instant it was made', early.slice(0, 80));

  // The session's instant is the simulator's, the same one every `show` answers at.
  sim.setRunTime(200000);
  const late = ((s.run('show ip nat translations') || {}).output || []).join('\n');
  ok(!/203\.0\.113\.1[01]/.test(late),
    'and asking two minutes later does not list it - the report is at the instant asked', late.slice(0, 90));

  const stats = ((s.run('show ip nat statistics') || {}).output || []).join('\n');
  ok(/Active translations: 0/.test(stats), 'statistics agree: nothing is active', stats.split('\n').slice(-1)[0]);
  ok(/Timeouts \(seconds\): icmp 60, udp 300, tcp 3600, other 300/.test(stats),
    'and the timeouts the table is held to are printed, not assumed', stats.split('\n').filter(function (l) {
      return /Timeouts/.test(l); })[0]);

  // A device that has never translated anything still says so - creating a table to read it would be a lie.
  const fresh = lab();
  const s2 = new CliSession(fresh.getDevice('r1'), fresh, new Simulator(fresh));
  const none = ((s2.run('show ip nat translations') || {}).output || []).join('\n');
  ok(/No translations: no packet needing NAT has crossed/.test(none),
    'a device that has carried no NAT traffic says nothing has crossed', none.slice(0, 90));
  ok(!fresh.getDevice('r1').natTable, 'and reading it did not create a table');
}

console.log('');
console.log('The library keeps its own promise');
{
  // expireTranslations is the function that already existed; these checks pin the reading of it the fix relies on.
  const tbl = natLib.createNatTable();
  tbl.rules = [{ spec: 'ip', type: 'dynamic', insideLocal: '192.168.10.0/24',
    insideGlobal: '203.0.113.10-203.0.113.20', protocol: 'ip' }];
  const first = natLib.translateOutbound(tbl, { protocol: 'icmp', srcIp: '192.168.10.50', srcPort: null,
    dstIp: '203.0.113.9', dstPort: null }, 0);
  ok(first.action === 'translate', 'a dynamic rule translates', first.reason || first.action);
  ok(natLib.expireTranslations(tbl, null, 59) === 0, '59 s later nothing has expired (ICMP is 60 s)');
  ok(natLib.expireTranslations(tbl, null, 61) === 1, '61 s later the entry is gone');
  ok(tbl.translations.length === 0, 'and the table is empty');
  ok(natLib.timeoutFor(null, 'icmp') === 60 && natLib.timeoutFor(null, 'udp') === 300 &&
    natLib.timeoutFor(null, 'tcp') === 3600, 'the defaults are the protocol timeouts');
  ok(natLib.timeoutFor({ icmp: 5 }, 'icmp') === 5, 'and a configured value wins over the default');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
