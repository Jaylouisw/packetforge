'use strict';
// A switch has five VLANs before anyone configures one.
//
// `show vlan` on a factory-default switch printed VLAN 1 and stopped. The device it imitates prints five:
//
//   VLAN Name                             Status    Ports
//   ---- -------------------------------- --------- -------------------------------
//   1    default                          active    Gi1/0/2, Gi1/0/3
//   1002 fddi-default                     act/unsup
//   1003 token-ring-default               act/unsup
//   1004 fddinet-default                  act/unsup
//   1005 trnet-default                    act/unsup
//
// (Cisco Catalyst 2960-X Consolidated Platform Command Reference, `show vlan`; the same four rows appear in
// Cisco's "Configure Inter VLAN Routing with an External Router" note and in the Catalyst 9200 VLAN command
// chapter.) 1002-1005 are the reserved Token Ring / FDDI defaults: part of the VLAN database from boot, no
// port may be assigned to one, and their status is `act/unsup` rather than `active` because nothing can be
// configured into them. Reporting VLAN 1 alone made "VLAN id 1002 is reserved" a rule with nothing behind
// it, and made a factory-default switch look like a box with a single VLAN.
//
// The rows are read from `engine/vlan.js`'s RESERVED_VLANS, the same list the reserved-range refusal quotes,
// so the table and the refusal cannot name different ids.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');
const vlanLib = require('../engine/vlan');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];
const PC = catalog.filter(function (s) { return s.model === 'generic-pc'; })[0];
const ROUTER = catalog.filter(function (s) {
  return s.category === 'router' && (s.capabilities || []).indexOf('l3-forward') !== -1;
})[0];

function say(dev, t, sim, cmds) {
  return runCommands(dev, t, sim, cmds).lines.map(String);
}
// `VLAN  Name  Status  Ports`, with the same widths the console prints.
function table(lines) {
  const start = lines.findIndex(function (l) { return /^VLAN\s+Name\s+Status\s+Ports/.test(l); });
  if (start === -1) return null;
  // The header is followed by the device's rule line, which is not a row.
  return lines.slice(start + 1).filter(function (l) { return l.trim() && !/^-{4}/.test(l); }).map(function (l) {
    // Read by column position, as the header prints it: `1002 fddi-default ... act/unsup` has one space
    // after the id, so a whitespace-run regex sees the wrong fields.
    return {
      id: Number(l.slice(0, 4).trim()),
      name: l.slice(5, 37).trim(),
      status: l.slice(38, 47).trim(),
      ports: l.slice(48).trim(),
      raw: l
    };
  });
}
function row(rows, id) {
  return (rows || []).filter(function (r) { return r.id === id; })[0] || null;
}

console.log('A factory-default switch lists the VLANs the hardware has, not just VLAN 1:');
{
  const t = new Topology();
  const sw = t.addDevice(SWITCH, 'sw');
  const sim = new Simulator(t);
  const rows = table(say(sw, t, sim, ['show vlan']));
  const ids = function (rs) { return rs.map(function (r) { return r.id; }).join(','); };
  const raw = function (rs) { return rs.map(function (r) { return r.raw; }).join(' | '); };
  ok(!!rows, 'the table is printed');
  ok(rows.length === 5, 'in five rows, not one', raw(rows));
  ok(ids(rows) === '1,1002,1003,1004,1005', 'numbered 1 and then the reserved block, in ascending order', ids(rows));
  const names = { 1002: 'fddi-default', 1003: 'token-ring-default', 1004: 'fddinet-default', 1005: 'trnet-default' };
  for (const id of Object.keys(names)) {
    const r = row(rows, Number(id));
    ok(!!r && r.name === names[id], 'VLAN ' + id + ' is named ' + names[id], r && r.raw);
    ok(!!r && r.status === 'act/unsup', 'VLAN ' + id + ' is act/unsup, not active', r && r.status);
    ok(!!r && r.ports === '', 'and carries no port', r && JSON.stringify(r.ports));
  }
  const one = row(rows, 1);
  ok(one && one.name === 'default' && one.status === 'active', 'VLAN 1 is still default/active', one && one.raw);
  ok(one && /Fa0\/1/.test(one.ports), 'and still lists the ports that carry it', one && one.ports);
  const withPorts = rows.filter(function (r) { return r.status === 'act/unsup' && r.ports; });
  ok(withPorts.length === 0, 'no reserved VLAN is shown with ports', JSON.stringify(withPorts));
  const line = '1002 fddi-default                     act/unsup';
  ok(rows.some(function (r) { return r.raw === line; }), 'the row is laid out where the Status column is',
    (row(rows, 1002) || {}).raw);
}

console.log('');
console.log('They are not configuration: nothing in the running-config, and still refused to assign:');
{
  const t = new Topology();
  const sw = t.addDevice(SWITCH, 'sw');
  const sim = new Simulator(t);
  const rc = say(sw, t, sim, ['show running-config']).join('\n');
  ok(!/^vlan 100[2-5]\b/m.test(rc), 'show running-config does not print the reserved VLANs', rc);
  const refused = say(sw, t, sim, ['configure terminal', 'vlan 1002']);
  ok(/reserved/.test(refused.join('\n')), 'and `vlan 1002` is still refused as reserved', refused.join(' | '));
  const port = say(sw, t, sim, ['configure terminal', 'interface Fa0/1', 'switchport access vlan 1003']);
  ok(/reserved/.test(port.join('\n')), 'as is `switchport access vlan 1003`', port.join(' | '));
  const after = table(say(sw, t, sim, ['show vlan']));
  ok(row(after, 1) && /Fa0\/1/.test(row(after, 1).ports),
    'the refused assignment left the port in VLAN 1', row(after, 1) && row(after, 1).ports);
}

console.log('');
console.log('They sort into place rather than being glued to the end:');
{
  const t = new Topology();
  const sw = t.addDevice(SWITCH, 'sw');
  const sim = new Simulator(t);
  say(sw, t, sim, ['configure terminal', 'vlan 2000 two-thousand', 'vlan 40 forty', 'end']);
  const rows = table(say(sw, t, sim, ['show vlan']));
  const ids = rows.map(function (r) { return r.id; }).join(',');
  ok(ids === '1,40,1002,1003,1004,1005,2000',
    'a configured VLAN 2000 comes after 1005 and VLAN 40 before 1002', ids);
}

console.log('');
console.log('`show vlan brief` is the same table, and a router is not given a VLAN database it does not have:');
{
  const t = new Topology();
  const sw = t.addDevice(SWITCH, 'sw');
  const pc = t.addDevice(PC, 'pc');
  t.connect(pc.id, 'eth0', sw.id, 'Fa0/1');
  const sim = new Simulator(t);
  const full = table(say(sw, t, sim, ['show vlan']));
  const brief = table(say(sw, t, sim, ['show vlan brief']));
  ok(JSON.stringify(full) === JSON.stringify(brief), 'brief and the full form agree row for row');
  ok(brief.filter(function (r) { return r.status === 'act/unsup'; }).length === 4,
    'and brief carries the four act/unsup rows too');
  if (ROUTER) {
    const rt = new Topology();
    const r = rt.addDevice(ROUTER, 'r1');
    const rsim = new Simulator(rt);
    const rows = table(say(r, rt, rsim, ['show vlan'])) || [];
    ok(rows.every(function (x) { return x.status !== 'act/unsup'; }),
      'a router is not handed the reserved rows (' + ROUTER.model + ')',
      rows.map(function (x) { return x.raw; }).join(' | '));
  }
}

console.log('');
console.log('The list the table prints is the list the refusal is built from:');
{
  const ids = vlanLib.RESERVED_VLANS.map(function (r) { return r.id; });
  ok(ids.length === 4, 'four reserved VLANs', String(ids.length));
  ok(ids.join(',') === '1002,1003,1004,1005', 'covering 1002-1005, the range `vlan 1002` is refused for',
    ids.join(','));
  ok(vlanLib.RESERVED_VLANS.every(function (r) { return typeof r.name === 'string' && r.name; }),
    'and every one of them has the name the device prints',
    vlanLib.RESERVED_VLANS.map(function (r) { return r.name; }).join(','));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
