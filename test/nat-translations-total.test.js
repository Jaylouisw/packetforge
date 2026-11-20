'use strict';
// `show ip nat translations` closes with the box's own count (#fidelity).
//
// Every IOS XE sample of the view ends with one sentence after the last row -
// `Total number of translations: N` - and a box whose table is empty answers with that sentence alone, no
// column headings (research/show-ip-nat-translations-total.md). PacketForge printed the headings and the rows
// and then stopped, so the reader had to count them, and the empty table was a bare header over nothing.
//
// The count is the number of rows the view just printed. The model's table holds only the translations that
// are live at the instant asked, so rows printed == active translations, which is what the vendor's sentence
// claims to count.
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

// r1 (NAT) -- in1 inside | r1 -- out1 outside
function lab() {
  const t = new Topology();
  t.addDevice(ROUTER, 'r1');
  t.addDevice(HOST, 'in1');
  t.addDevice(HOST, 'out1');
  const c = function (a, ap, b, bp) { t.connect(a, ap, b, bp, { mediaId: '1000base-t', speedMbps: 1000 }); };
  c('r1', 'Gi0/0/0', 'in1', 'eth0');
  c('r1', 'Gi0/0/1', 'out1', 'eth0');
  const r1 = t.getDevice('r1');
  r1.interfaces.get('Gi0/0/0').ip = '192.168.10.1'; r1.interfaces.get('Gi0/0/0').mask = '255.255.255.0';
  r1.interfaces.get('Gi0/0/1').ip = '203.0.113.1'; r1.interfaces.get('Gi0/0/1').mask = '255.255.255.0';
  const in1 = t.getDevice('in1');
  in1.interfaces.get('eth0').ip = '192.168.10.50'; in1.interfaces.get('eth0').mask = '255.255.255.0';
  in1.config.defaultGateway = '192.168.10.1';
  const out1 = t.getDevice('out1');
  out1.interfaces.get('eth0').ip = '203.0.113.9'; out1.interfaces.get('eth0').mask = '255.255.255.0';
  out1.config.defaultGateway = '203.0.113.1';
  const cli = new CliSession(r1, t, new Simulator(t));
  cli.run('enable'); cli.run('configure terminal');
  cli.run('ip nat pool WAN 203.0.113.1 203.0.113.1 netmask 255.255.255.0');
  cli.run('ip nat inside source list 192.168.10.0/24 pool WAN overload');
  cli.run('interface Gi0/0/0'); cli.run('ip nat inside'); cli.run('exit');
  cli.run('interface Gi0/0/1'); cli.run('ip nat outside'); cli.run('exit');
  return { t: t, sim: new Simulator(t) };
}
function output(t, sim, cmd) {
  const s = new CliSession(t.getDevice('r1'), t, sim);
  return ((s.run('show ip nat ' + cmd) || {}).output || []);
}
const TOTAL = /^Total number of translations: (\d+)$/;

console.log('');
console.log('A table with rows ends with the count, after the last row:');
{
  const env = lab();
  env.sim.setRunTime(60000);
  env.sim.ping('in1', '203.0.113.9', { count: 1 });
  const live = (env.t.getDevice('r1').natTable || { translations: [] }).translations.length;
  ok(live > 0, 'a flow left a live translation in the table', String(live));

  const lines = output(env.t, env.sim, 'translations');
  const last = lines[lines.length - 1];
  ok(TOTAL.test(last), 'the last line is the count, and nothing follows it', JSON.stringify(last));
  ok(Number(TOTAL.exec(last)[1]) === live,
    'and the number is the rows it just printed', last + ' vs ' + String(live));
  ok(lines[0] === 'Pro  Inside global          Inside local           Outside local          Outside global',
    'the headings still come first', JSON.stringify(lines[0]));
  const totals = lines.filter(function (l) { return TOTAL.test(l); });
  ok(totals.length === 1, 'exactly one count line is printed', String(totals.length));
  // The rows sit between the headings and the count: nothing is printed after the sentence.
  ok(lines.length === 2 + live, 'headings, one line per translation, then the count',
    lines.length + ' lines for ' + live + ' translations');
}

console.log('');
console.log('An empty table answers with the count alone, and no headings:');
{
  const env = lab();
  env.t.getDevice('r1').config.nat.timeouts = { icmp: 10, udp: 300, tcp: 86400, other: 86400 };
  env.sim.setRunTime(60000);
  env.sim.ping('in1', '203.0.113.9', { count: 1 });
  env.sim.setRunTime(71000);            // 11 s on: the ICMP entry is idle past its 10 s timeout
  const lines = output(env.t, env.sim, 'translations').filter(function (l) { return l !== ''; });
  ok(lines.length === 1 && TOTAL.test(lines[0]), 'the whole answer is one count line', JSON.stringify(lines));
  ok(Number(TOTAL.exec(lines[0])[1]) === 0, 'and it reads zero', lines[0]);
  ok(!lines.some(function (l) { return /^Pro\b/.test(l); }),
    'no column headings over an empty table', JSON.stringify(lines));
}

console.log('');
console.log('A device that has never translated says so, and still counts:');
{
  const env = lab();
  const lines = output(env.t, env.sim, 'translations').filter(function (l) { return l !== ''; });
  ok(/No translations: no packet needing NAT has crossed/.test(lines[0]),
    'the report still explains that nothing has crossed', JSON.stringify(lines[0]));
  ok(TOTAL.test(lines[lines.length - 1]) && Number(TOTAL.exec(lines[lines.length - 1])[1]) === 0,
    'and the box\'s count closes it at zero', JSON.stringify(lines[lines.length - 1]));
  ok(!env.t.getDevice('r1').natTable, 'reading the view still did not create a table');
}

console.log('');
console.log('The two views agree on how many are live:');
{
  const env = lab();
  env.sim.setRunTime(60000);
  env.sim.ping('in1', '203.0.113.9', { count: 1 });
  const tr = output(env.t, env.sim, 'translations');
  const total = Number(TOTAL.exec(tr[tr.length - 1])[1]);
  const st = output(env.t, env.sim, 'statistics').join('\n');
  const claimed = /Active translations: (\d+)/.exec(st);
  ok(!!claimed && Number(claimed[1]) === total,
    'statistics\' "Active translations" is the same number the table counts', st.split('\n').slice(-1)[0]);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
