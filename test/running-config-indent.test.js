'use strict';
// How deep is a line indented inside a first-level configuration submode in `show running-config`?
//
// One space. That is not a style preference, it is the vendor's written rule for the format of a
// configuration file, in the words Cisco repeats across four guides (Catalyst 9200 26.x and 9300 17.1
// "Configuration Replace and Configuration Rollback", IOS XE 17 "Contextual Configuration Diff Utility",
// and the Catalyst 9000 "Configuration Replace" page):
//
//   Start all commands on a new line with no indentation, unless the command is within a configuration
//   submode.
//   Indent commands within a first-level configuration submode one space.
//   Indent commands within a second-level configuration submode two spaces.
//   Indent commands within subsequent submodes accordingly.
//
// and then: "These indentation rules describe how the software creates configuration files for such
// commands as show running-config ... Any configuration file generated on a Cisco device complies with
// these rules."
//
// This console printed a first-level submode line at two spaces - the depth the rule reserves for a
// *second*-level submode - so every line of a backup taken here differed from the same box's own file.
// And the two children of `router bgp` were printed at the left margin, where a reader has to take them
// for global commands. research/running-config-indent.md carries the pages and the raw device captures.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const spec = function (model) {
  return catalog.filter(function (s) { return s.model === model && s.vendor === 'generic'; })[0];
};
const ROUTER = spec('generic-router');
const SWITCH = spec('generic-switch');
const SHUT = 'shutdown';

// A box with something in every stanza that owns a submode: an addressed interface with a description,
// a port that is administratively off, a VRRP group, a BGP process with a neighbour, a DHCP pool and a
// DNS zone.
function lab() {
  const t = new Topology();
  const r = t.addDevice(ROUTER, 'r1');
  const sw = t.addDevice(SWITCH, 'sw1');
  const sim = new Simulator(t);
  const rPorts = [...r.interfaces.keys()];
  const swPorts = [...sw.interfaces.keys()];
  const cli = new CliSession(r, t, sim);
  [
    'configure terminal',
    'interface ' + rPorts[0], 'description uplink to the core', 'ip address 10.0.0.1 255.255.255.0',
    'no ' + SHUT, 'vrrp 7 ip 10.0.0.254', 'vrrp 7 priority 120', 'exit',
    'interface ' + rPorts[1], SHUT, 'exit',
    'router bgp 65001', 'bgp router-id 1.1.1.1', 'neighbor 10.0.0.2 remote-as 65002', 'exit',
    'ip dhcp pool LAN', 'network 10.0.0.0 255.255.255.0', 'default-router 10.0.0.1', 'lease 0 1 0',
    'host 10.0.0.5 0200.0000.0005', 'exit',
    // `exit` from `router bgp` leaves configuration mode in this console, so the global commands
    // that follow are typed after re-entering it - the same sequence an operator performs.
    'configure terminal',
    'ip dhcp pool LAN', 'network 10.0.0.0 255.255.255.0', 'default-router 10.0.0.1', 'lease 0 1 0',
    'host 10.0.0.5 0200.0000.0005', 'exit',
    'dns zone example.com', 'dns add www A 10.0.0.9', 'end'
  ].forEach(function (c) { cli.run(c); });
  const swCli = new CliSession(sw, t, sim);
  ['configure terminal', 'vlan 10 sales', 'interface ' + swPorts[0], 'switchport mode trunk',
    'switchport trunk allowed vlan 10', 'exit', 'end'].forEach(function (c) { swCli.run(c); });
  return { t: t, sim: sim, r: r, sw: sw, rCli: cli, swCli: swCli };
}

const text = function (cli) { return (cli.run('show running-config').output || []).map(String); };

// The lines between a stanza header and the `!` that closes it, whatever the header is.
function stanza(lines, header) {
  const at = lines.indexOf(header);
  if (at === -1) return null;
  const out = [];
  for (let i = at + 1; i < lines.length && lines[i] !== '!' && lines[i] !== ''; i++) out.push(lines[i]);
  return out;
}

function firstDiff(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return { line: i + 1, printed: a[i], replayed: b[i] };
  }
  return null;
}

// --- 1. no line has the indentation the rule reserves for a second-level submode -------------------
{
  const env = lab();
  const lines = text(env.rCli).concat(text(env.swCli));
  const twoDeep = lines.filter(function (l) { return /^ {2,}/.test(l); });
  ok(twoDeep.length === 0, 'no configuration line is indented two spaces or more',
    JSON.stringify(twoDeep.slice(0, 3)));
}

// --- 2. a global command starts in column 1 -------------------------------------------------------
{
  const env = lab();
  const lines = text(env.rCli);
  ok(lines[1] === 'hostname ' + env.r.name, '`hostname` is at the left margin', String(lines[1]));
  ok(lines.indexOf('router bgp 65001') !== -1, '`router bgp` is at the left margin');
  ok(lines.indexOf('ip dhcp pool LAN') !== -1, '`ip dhcp pool` is at the left margin');
  ok(lines.indexOf('dns zone example.com') !== -1, '`dns zone` is at the left margin');
  ok(lines.indexOf('end') !== -1, '`end` is at the left margin');
}

// --- 3. every line of an interface stanza is one space in -----------------------------------------
{
  const env = lab();
  const lines = text(env.rCli);
  const header = lines.filter(function (l) { return /^interface /.test(l); })[0];
  const body = stanza(lines, header);
  ok(!!body && body.length > 0, 'the first interface stanza has lines in it', JSON.stringify(body));
  ok((body || []).every(function (l) { return l.charAt(0) === ' ' && l.charAt(1) !== ' '; }),
    'each line of the stanza begins with exactly one space', JSON.stringify(body));
  ok((body || []).indexOf(' description uplink to the core') !== -1,
    'the description carries the one-space indent', JSON.stringify(body));
  ok((body || []).indexOf(' ip address 10.0.0.1 255.255.255.0') !== -1,
    'and so does the address', JSON.stringify(body));
  const offPort = lines.filter(function (l) { return /^interface /.test(l); })[1];
  const offBody = stanza(lines, offPort) || [];
  ok(offBody.indexOf(' ' + SHUT) !== -1, 'and so does the administrative-off command, on its own port',
    JSON.stringify({ stanza: offPort, body: offBody }));
  ok((body || []).some(function (l) { return l.indexOf(' vrrp 7 ip ') === 0; }),
    'and a VRRP group printed inside the block', JSON.stringify(body));
}

// --- 4. the children of `router bgp` are a submode, not globals -----------------------------------
{
  const env = lab();
  const lines = text(env.rCli);
  const at = lines.indexOf('router bgp 65001');
  ok(at !== -1, 'the BGP stanza is printed');
  const idAt = lines.indexOf(' bgp router-id 1.1.1.1');
  const nbrAt = lines.indexOf(' neighbor 10.0.0.2 remote-as 65002');
  ok(idAt === at + 1, '`bgp router-id` follows the stanza header and is indented one space',
    JSON.stringify(lines.slice(at, at + 3)));
  ok(nbrAt > idAt, '`neighbor ... remote-as` follows it, also indented one space',
    JSON.stringify(lines.slice(at, at + 3)));
  ok(lines.indexOf('bgp router-id 1.1.1.1') === -1, 'and is not printed at the left margin');
  ok(lines.indexOf('neighbor 10.0.0.2 remote-as 65002') === -1, 'nor is the neighbour line');
}

// --- 5. the DHCP pool and DNS zone stanzas print their bodies the same way ------------------------
{
  const env = lab();
  const lines = text(env.rCli);
  const poolAt = lines.indexOf('ip dhcp pool LAN');
  ok(poolAt !== -1, 'the pool is printed');
  const pool = lines.slice(poolAt + 1, poolAt + 7);
  ok(pool[0] === ' network 10.0.0.0 255.255.255.0', 'the network line is one space in',
    JSON.stringify(pool));
  ok(pool.indexOf(' default-router 10.0.0.1') !== -1, 'the default-router line too', JSON.stringify(pool));
  ok(pool.indexOf(' lease 0 1') !== -1, 'and the lease, in the form the command takes back',
    JSON.stringify(pool));
  const zoneAt = lines.indexOf('dns zone example.com');
  ok(zoneAt !== -1 && lines[zoneAt + 1] === ' dns add www A 10.0.0.9',
    'a zone record is one space in', JSON.stringify(lines.slice(zoneAt, zoneAt + 2)));
}

// --- 6. a `vlan` line is global, and a `switchport` line is a submode line ------------------------
{
  const env = lab();
  const lines = text(env.swCli);
  ok(lines.indexOf(' vlan 10 sales') === -1, 'a `vlan` line is a global command, not a submode line');
  ok(lines.indexOf('vlan 10 sales') !== -1, 'and is printed at the left margin', JSON.stringify(lines.slice(0, 6)));
  ok(lines.indexOf(' switchport mode trunk') !== -1, 'a trunk line is one space in',
    JSON.stringify(lines.filter(function (l) { return /switchport/.test(l); })));
}

// --- 7. the file still replays, byte for byte, on a fresh device of the same model ----------------
{
  const env = lab();
  const before = text(env.rCli);
  const t2 = new Topology();
  const r2 = t2.addDevice(ROUTER, 'r1');
  const sim2 = new Simulator(t2);
  const cli2 = new CliSession(r2, t2, sim2);
  const refused = [];
  cli2.run('configure terminal');
  before.forEach(function (line) {
    const out = (cli2.run(line).output || []).join(' ');
    // A refusal is what starts with `%`. `exit` at the end of a pool also answers with the pool's
    // completeness check ("both rangeStart and rangeEnd are required"), which is this console's
    // statement about the lab the config describes, not a complaint about the words on the line - and
    // it is the same answer a pool built by hand gets, so it is not what this check is about.
    if (out.charAt(0) === '%' && !/is incomplete - DHCP pool/.test(out)) refused.push(line + ' -> ' + out);
  });
  ok(refused.length === 0, 'every printed line is accepted when pasted back', JSON.stringify(refused));
  const after = text(cli2);
  ok(before.join('\n') === after.join('\n'), 'and the replayed configuration is identical',
    JSON.stringify({ firstDifference: firstDiff(before, after) }));
}

// --- 8. a config pasted in the shape a real box prints lands on the right ports -------------------
{
  const t = new Topology();
  const r = t.addDevice(ROUTER, 'r1');
  const sim = new Simulator(t);
  const cli = new CliSession(r, t, sim);
  const ports = [...r.interfaces.keys()];
  const boxShape = [
    'configure terminal',
    'interface ' + ports[0],
    ' ip address 192.0.2.1 255.255.255.0',
    ' no ' + SHUT,
    '!',
    'interface ' + ports[1],
    ' ip address 198.51.100.5 255.255.255.0',
    ' ' + SHUT,
    '!',
    'end'
  ];
  const said = [];
  boxShape.forEach(function (l) {
    const out = (cli.run(l).output || []).join(' ');
    if (out.charAt(0) === '%') said.push(l + ' -> ' + out);
  });
  ok(said.length === 0, 'a one-space paste is read without a complaint', JSON.stringify(said));
  ok(r.interfaces.get(ports[0]).ip === '192.0.2.1', 'the first block landed on its port',
    String(r.interfaces.get(ports[0]).ip));
  ok(r.interfaces.get(ports[1]).ip === '198.51.100.5', 'the second landed on its own port',
    String(r.interfaces.get(ports[1]).ip));
  ok(r.interfaces.get(ports[0]).enabled === true, 'and the first port was not shut by the second block');
  ok(r.interfaces.get(ports[1]).enabled === false, 'while the second one was');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
