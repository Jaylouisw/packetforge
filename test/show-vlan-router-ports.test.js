'use strict';
// `show vlan` on a box that does not switch: whose ports are VLAN members?
//
// A router's ports are routed ports. `show interfaces switchport` refuses them with "is not a switchable port",
// they have no access VLAN, and the VLAN view on a router with a switch module lists only the module's ports:
//
//   Router# show vlan-switch brief
//   VLAN Name                             Status    Ports
//   ---- -------------------------------- --------- -------------------------------
//   1    default                          active    Fa0/2, Fa0/9, Fa0/14, Gi0/0
//
// with the router's own routed ports absent - those belong to no VLAN. Cisco, "EtherSwitch Network Module"
// (https://www.cisco.com/en/US/docs/ios/lanswitch/configuration/guide/lsw_enet_switch_net.html) prints that
// table, and the Connected Grid 1000 Layer 2/3 Switching guide prints the same shape
// (https://www.cisco.com/c/en/us/td/docs/routers/connectedgrid/cgr1000/ios/software/15_4_1_cg/FEvlan_switchconf.html).
//
// This console answered every device with one shape, so a router's VLAN 1 row carried its own routed sockets as
// members. The table stays - this model lets a router hold a VLAN database, and `vlan 20` is accepted - but its
// Ports column may only name a port that is in a VLAN, and a routed port is not.
//
// research/vlan-on-a-router.md records the platform matrix behind the narrower rule.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const vlanLib = require('../engine/vlan');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const { loadCatalog } = require('../devices/registry');
const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];
const ROUTER = catalog.filter(function (s) { return s.model === 'generic-router'; })[0];

function env(spec) {
  const t = new Topology();
  const dev = t.addDevice(spec, 'd1');
  return { t: t, dev: dev, sim: new Simulator(t) };
}
function say(x, cmds) { return runCommands(x.dev, x.t, x.sim, cmds).lines.map(String); }
// The data rows of the VLAN table: everything between the device's rule line and the first blank line.
function rows(lines) {
  const start = lines.findIndex(function (l) { return /^VLAN\s+Name\s+Status\s+Ports/.test(l); });
  if (start === -1) return [];
  const out = [];
  for (let i = start + 2; i < lines.length; i++) {
    if (!String(lines[i]).trim()) break;
    out.push(lines[i]);
  }
  return out;
}
function rowFor(lines, id) {
  return rows(lines).filter(function (l) { return Number(String(l).slice(0, 4).trim()) === id; })[0] || null;
}
// The Ports cell is column 48 to the end of the line, as the table prints it.
function portsCell(line) { return line === null ? null : String(line).slice(48).trim(); }

console.log('A router\'s routed ports are not VLAN members:');
ok(!!ROUTER && !!SWITCH, 'the catalogue carries the generic router and the generic switch',
  (ROUTER ? ROUTER.model : 'no router') + ' / ' + (SWITCH ? SWITCH.model : 'no switch'));
{
  const x = env(ROUTER);
  const lines = say(x, ['show vlan brief']);
  const v1 = rowFor(lines, 1);
  ok(!!v1, 'the router still answers with the VLAN table it had', JSON.stringify(rows(lines)[0]));
  ok(portsCell(v1) === '', 'and VLAN 1 has no members: its ports are routed ports',
    JSON.stringify(portsCell(v1)));
  const every = rows(lines).map(function (l) { return portsCell(l); }).join(',');
  ok(every === '', 'no VLAN row on the router names a member at all', JSON.stringify(every));
  const first = Array.from(x.dev.interfaces.keys())[0];
  ok(x.dev.inactiveVlan(first) === null,
    'which is the predicate `inactiveVlan()` already uses for the same box');
}
{
  const x = env(ROUTER);
  const lines = say(x, ['configure terminal', 'vlan 10 lab', 'exit', 'show vlan brief']);
  const v10 = rowFor(lines, 10);
  ok(!!v10, 'a VLAN the router holds gets its own row');
  ok(portsCell(v10) === '', 'and it is empty too: the VLAN exists, but nothing on this box is in it',
    JSON.stringify(portsCell(v10)));
}

console.log('');
console.log('A switch is untouched - every access port is still a member:');
{
  const x = env(SWITCH);
  const lines = say(x, ['show vlan brief']);
  const v1 = rowFor(lines, 1);
  const ports = portsCell(v1);
  ok(!!v1, 'the switch prints its VLAN 1 row');
  ok(/^Fa0\/1,/.test(ports), 'and the Ports cell starts with the first access port', JSON.stringify(ports));
  // The cell wraps at the console's 80 columns (research/show-vlan-ports-wrap.md), so the row plus its
  // continuation lines are what names every port.
  const all = [ports].concat(lines.slice(lines.indexOf(v1) + 1).filter(function (l) {
    return l.slice(0, 48).trim() === '';
  }).map(function (l) { return l.slice(48).trim(); })).join(' ');
  ok((all.match(/Fa0\/\d+/g) || []).length === 8, 'all eight access ports are listed', JSON.stringify(all));
}
{
  const x = env(SWITCH);
  const lines = say(x, ['configure terminal', 'interface Fa0/2', 'switchport access vlan 20', 'exit',
    'show vlan brief']);
  const v20 = rowFor(lines, 20);
  ok(!!v20, 'moving a port to VLAN 20 creates that row');
  ok(portsCell(v20) === 'Fa0/2', 'with the port it was moved to', JSON.stringify(portsCell(v20)));
  ok(portsCell(rowFor(lines, 1)).split(',').indexOf('Fa0/2') === -1,
    'and VLAN 1 no longer names it', JSON.stringify(portsCell(rowFor(lines, 1))));
}
{
  // The reserved rows are not members of anything anywhere, and stay that way.
  const x = env(SWITCH);
  const lines = say(x, ['show vlan brief']);
  const reserved = rows(lines).filter(function (l) { return /act\/unsup/.test(l); });
  ok(reserved.length === vlanLib.RESERVED_VLANS.length,
    'the four reserved rows still print on a switch', String(reserved.length));
  ok(reserved.every(function (l) { return portsCell(l) === ''; }),
    'and none of them has a Ports cell at all', JSON.stringify(reserved.map(portsCell)));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
