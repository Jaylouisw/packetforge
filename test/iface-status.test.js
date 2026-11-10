'use strict';
// iface-status.test.js - the two lines an operator types first, and the state column that lied.
//
// Measured before this pass:
//   SW1#show interfaces status       -> % "show interfaces status" is not a command here
//   SW1#show interfaces description  -> % "show interfaces description" is not a command here
//   R1#show ip interface             -> % Invalid show command: ip interface
//   SW1#show ip interface brief      -> Fa0/5   unassigned  YES  manual  up   up     (nothing plugged in)
//
// The first two are the reason you give a port a description at all: the label was stored, dumped
// and pasted back, and could only ever be read one port at a time. The third is the detail view of a
// table that already existed. The fourth is the state column: `lineUp` was maintained only for SVIs
// and subinterfaces, so a port with no cable answered `up/up` in every table that has a state column.
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
  const text = Array.isArray(haystack) ? haystack.join('\n') : String(haystack);
  ok(re.test(text), msg + (re.test(text) ? '' : ' (no match in ' + JSON.stringify(text.slice(0, 600)) + ')'));
}
function noMatch(re, haystack, msg) {
  const text = Array.isArray(haystack) ? haystack.join('\n') : String(haystack);
  ok(!re.test(text), msg + (re.test(text) ? ' (found ' + re + ')' : ''));
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const ROUTER = catalog.find(function (s) { return s.model === 'generic-router'; });
const SWITCH = catalog.find(function (s) { return s.model === 'generic-switch'; });
const PC = catalog.find(function (s) { return s.model === 'generic-pc'; });

// PC1 --Fa0/1 [SW1] Fa0/2-- Gi0/0 R1, with Fa0/3 in VLAN 20, Fa0/4 labelled and shut, and Fa0/5..8
// deliberately left unplugged so every state the status table can report is on screen at once.
function lab() {
  const t = new Topology();
  const sw = t.addDevice(SWITCH); sw.name = 'SW1';
  const r1 = t.addDevice(ROUTER); r1.name = 'R1';
  const pc = t.addDevice(PC); pc.name = 'PC1';
  t.connect(pc.id, 'eth0', sw.id, 'Fa0/1');
  t.connect(sw.id, 'Fa0/2', r1.id, 'Gi0/0');
  const sim = new Simulator(t);
  const mk = function (d) { const s = new CliSession(d, t, sim); s.run('enable'); return s; };
  const s1 = mk(sw), r = mk(r1), sp = mk(pc);
  const cfg = function (s, cmds) {
    s.run('configure terminal');
    const out = [];
    for (const c of cmds) out.push.apply(out, s.run(c).output);
    s.run('end');
    return out;
  };
  cfg(sp, ['hostname PC1', 'interface eth0', 'ip address 10.0.0.50 255.255.255.0',
    'ip default-gateway 10.0.0.1', 'exit']);
  cfg(r, ['hostname R1', 'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'exit']);
  cfg(s1, ['hostname SW1',
    'interface Fa0/1', 'description to PC1', 'speed 100', 'exit',
    'interface Fa0/2', 'description uplink to R1', 'exit',
    'interface Fa0/3', 'switchport access vlan 20', 'exit',
    'interface Fa0/4', 'description spare (unused)', 'shutdown', 'exit']);
  sp.run('ping 10.0.0.1 count 1');
  return { t: t, sim: sim, sw: sw, r1: r1, pc: pc, s1: s1, r: r, sp: sp, cfg: cfg };
}

console.log('\n`show interfaces status` is the switch table, and it reports every state:');
{
  const env = lab();
  const out = env.s1.run('show interfaces status').output;
  match(/Port\s+Name\s+Status\s+Vlan\s+Duplex\s+Speed\s+Type/, out,
    'the seven columns of the table an operator lives in');
  match(/Fa0\/1\s+to PC1\s+connected\s+1\s+a-full\s+100M\s+ethernet/, out,
    'a cabled port: connected, its VLAN, and the speed that was configured');
  match(/Fa0\/2\s+uplink to R1\s+connected\s+1\s+a-full\s+a-1G\s+ethernet/, out,
    'a port left to negotiate says so with the `a-` prefix');
  match(/Fa0\/3\s+notconnect\s+20/, out, 'an unplugged port in VLAN 20 says notconnect and names the VLAN');
  match(/Fa0\/4\s+spare \(unused\)\s+disabled\s+1/, out, 'a shut port reads disabled');
  // The counts must be the rows: a summary that disagrees with the table is worse than none.
  const rows = out.filter(function (l) { return /^Fa\d\/\d/.test(l); });
  const connected = rows.filter(function (l) { return /\sconnected\s/.test(l); }).length;
  const notconnect = rows.filter(function (l) { return /\snotconnect\s/.test(l); }).length;
  const disabled = rows.filter(function (l) { return /\sdisabled\s/.test(l); }).length;
  match(new RegExp('^' + connected + ' connected, ' + disabled + ' disabled, ' + notconnect + ' notconnect$', 'm'),
    out, 'and the totals line counts exactly the rows above it');
  eq(rows.length, 8, 'every port is listed, cabled or not');
  // A trunk carries many VLANs, and the column says so rather than picking one.
  env.cfg(env.s1, ['interface Fa0/6', 'switchport mode trunk', 'exit']);
  match(/Fa0\/6\s+notconnect\s+trunk\s/, env.s1.run('show interfaces status').output,
    'a trunk port answers `trunk` in the Vlan column');
  match(/% R1 does not switch, so it has no per-port VLAN status/,
    env.r.run('show interfaces status').output, 'a router refuses the command by naming why');
  match(/% Unexpected argument "extra" - show interfaces status takes no more/,
    env.s1.run('show interfaces status extra').output, 'and a trailing word is refused');
}

console.log('\n`show interfaces description` is why you label a port:');
{
  const env = lab();
  const out = env.s1.run('show interfaces description').output;
  match(/Interface\s+Status\s+Protocol\s+Description/, out, 'the labelled table exists');
  match(/Fa0\/1\s+up\s+up\s+to PC1/, out, 'a label is read back beside the state of its port');
  match(/Fa0\/4\s+administratively down\s+down\s+spare \(unused\)/, out,
    'and a shut port is marked administratively down, not `down`');
  const one = env.s1.run('show interfaces description Fa0/2').output;
  match(/Fa0\/2\s+up\s+up\s+uplink to R1/, one, 'one port can be asked for by name');
  match(/Interfaces on SW1 \(1\):/, one, 'and the header says how many rows follow');
  match(/no port on this device has a description/, env.r.run('show interfaces description').output,
    'a device where nobody labelled anything says so, and how to label one');
}

console.log('\nA port with no cable is down, in every table that has a state column:');
{
  const env = lab();
  // Three tables, one answer: brief, description and status.
  const brief = env.s1.run('show ip interface brief').output.join('\n');
  match(/Fa0\/5\s+unassigned\s+YES\s+manual\s+down\s+down/, brief,
    '`show ip interface brief` says down/down for a port with nothing plugged in');
  match(/Fa0\/1\s+unassigned\s+YES\s+manual\s+up\s+up/, brief, 'and up/up for the one that is cabled');
  match(/Fa0\/4\s+unassigned\s+YES\s+manual\s+administratively down\s+down/, brief,
    'and administratively down for the one that is shut');
  match(/Fa0\/5\s+down\s+down/, env.s1.run('show interfaces description').output,
    'the description table agrees');
  match(/Fa0\/5\s+notconnect/, env.s1.run('show interfaces status').output,
    'and the status table calls the same port notconnect');
  eq(env.sw.interfaces.get('Fa0/5').lineUp, false, 'the model records the line as down');
  eq(env.sw.interfaces.get('Fa0/1').lineUp, true, 'and the cabled port as up');
  // A logical interface keeps IOS's `up / down`: it is not shut, its line protocol is waiting.
  env.cfg(env.s1, ['interface vlan 30', 'ip address 10.30.0.1 255.255.255.0', 'exit']);
  const svi = env.s1.run('show ip interface brief').output.join('\n');
  match(/Vlan30\s+10\.30\.0\.1\/24\s+YES\s+manual\s+up\s+down/, svi,
    'an SVI with no live member port is up/down, as IOS reports it');
  match(/Vlan30 is up, line protocol is down[\s\S]{0,400}?  Line state: no /,
    env.s1.run('show ip interface').output,
    'and the detail view says why the line protocol is down');
  // Plug a member of the SVI's VLAN in and the line comes up.
  env.cfg(env.s1, ['interface Fa0/7', 'switchport access vlan 30', 'exit']);
  const pc2 = env.t.addDevice(PC); pc2.name = 'PC2';
  env.t.connect(pc2.id, 'eth0', env.sw.id, 'Fa0/7');
  match(/Vlan30\s+10\.30\.0\.1\/24\s+YES\s+manual\s+up\s+up/,
    env.s1.run('show ip interface brief').output, 'a live member port brings the SVI up');
  match(/Fa0\/7\s+connected\s+30/, env.s1.run('show interfaces status').output,
    'and the status table shows the port it came up through');
}

console.log('\n`show ip interface` is the detail view of the same ports:');
{
  const env = lab();
  const out = env.r.run('show ip interface').output;
  match(/Gi0\/0 is up, line protocol is up/, out, 'each port is a block headed by its state');
  match(/Internet address is 10\.0\.0\.1\/24/, out, 'with its address and prefix');
  match(/Broadcast address is 10\.0\.0\.255/, out, 'and the broadcast address of its subnet');
  match(/MTU is 1500 bytes/, out, 'and its MTU');
  match(/Gi0\/1 is down, line protocol is down[\s\S]*?Internet address is not set/,
    out, 'an unaddressed port says so instead of omitting the line');
  const one = env.r.run('show ip interface Gi0/0').output;
  match(/Interfaces on R1 \(1\):/, one, 'one port can be asked for by name');
  eq(one.filter(function (l) { return / is (up|down|administratively down), line protocol is /.test(l); }).length, 1,
    'and only that port is described');
  // The fields nobody set are not invented; the fields somebody set are printed.
  env.cfg(env.r, ['interface Gi0/0', 'duplex full', 'exit',
    'ip nat inside source static 10.0.0.50 198.51.100.5', 'interface Gi0/0', 'ip nat inside', 'exit',
    'access-list 10 permit 10.0.0.0 0.0.0.255', 'interface Gi0/0', 'ip access-group 10 in', 'exit']);
  const nat = env.r.run('show ip interface Gi0/0').output;
  match(/NAT role: inside/, nat, 'a NAT role is shown');
  match(/Inbound access list is 10/, nat, 'and an inbound ACL binding');
  noMatch(/Outgoing access list/, nat, 'while the direction nobody bound is not printed at all');
  match(/% show ip interface takes one port, not "Gi0\/0 extra"/,
    env.r.run('show ip interface Gi0/0 extra').output, 'two words are refused');
  // `brief` still routes to the brief table, with the same port filter.
  match(/Interface\s+IP-Address/, env.r.run('show ip interface brief').output,
    '`brief` is still its own table');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
