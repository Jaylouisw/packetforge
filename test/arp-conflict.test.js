'use strict';
// Two boxes, one address: `show ip arp` used to show a single, confident binding (#1473).
//
// The table is keyed by address, so when two devices in the same segment both answer for 10.0.0.10 the second
// reply simply replaced the first. Nothing anywhere said so, and the consequence is the worst kind of
// intermittent: pings to that address pass or fail depending on which box answered last, with no configuration
// change between them and no error to read. The router can see both answers arrive - it is the only place they
// exist - so the fact belongs in the table that presents the address as settled.
//
// This guards both directions: the clash is reported when it happens, and it is NOT invented when it does not.
// A false duplicate warning would be its own defect - two subnets may legitimately reuse an address.
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
const HOST = specs.find(function (s) { return /^(pc|host|endpoint)/i.test(s.category || ''); });

function free(id, t) {
  return Array.from(t.getDevice(id).interfaces.keys()).filter(function (n) {
    return !/^(mgmt|console|aux)/i.test(n);
  })[0];
}
function sess(t, sim, id) { return new CliSession(t.getDevice(id), t, sim); }
function show(t, sim, id, cmd) {
  return ((sess(t, sim, id).run(cmd) || {}).output || []).join('\n');
}
function setIp(t, id, port, ip, mask) {
  const i = t.getDevice(id).interfaces.get(port);
  i.ip = ip; i.mask = mask || '255.255.255.0';
}
function configureRouter(t, sim, id, cmds) {
  const s = sess(t, sim, id);
  ['enable', 'configure terminal'].concat(cmds).concat(['end']).forEach(function (c) { s.run(c); });
}

// Two hosts in the SAME segment (one switch, one VLAN), both holding 10.0.0.10.
function clashLab() {
  const SWITCH = specs.filter(function (s) { return /switch/i.test(s.category || ''); })
    .find(function (s) {
      return (s.interfaces || []).filter(function (i) {
        return i.connector === 'rj45' && i.type === 'ethernet';
      }).length >= 4;
    });
  const t = new Topology();
  t.addDevice(ROUTER, 'r1');
  t.addDevice(SWITCH, 'sw');
  t.addDevice(HOST, 'p1');
  t.addDevice(HOST, 'p2');
  t.connect('r1', 'Gi0/0/1', 'sw', free('sw', t), { mediaId: '1000base-t', speedMbps: 1000 });
  const ports = Array.from(t.getDevice('sw').interfaces.keys()).filter(function (n) {
    return !/^(mgmt|console|aux)/i.test(n) && t.getDevice('sw').interfaces.get(n).peer === null;
  });
  t.connect('sw', ports[0], 'p1', free('p1', t), { mediaId: '1000base-t', speedMbps: 1000 });
  t.connect('sw', ports[1], 'p2', free('p2', t), { mediaId: '1000base-t', speedMbps: 1000 });
  const sim = new Simulator(t);
  configureRouter(t, sim, 'r1', ['interface Gi0/0/1', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown']);
  setIp(t, 'p1', free('p1', t), '10.0.0.10');
  setIp(t, 'p2', free('p2', t), '10.0.0.10');
  return { t: t, sim: sim, macOf: function (id) { return t.getDevice(id).interfaces.get(free(id, t)).mac; } };
}

console.log('');
console.log('A second box answering for an address is recorded, and the table says so:');
{
  const lab = clashLab();
  const before = show(lab.t, lab.sim, 'r1', 'ping 10.0.0.10 1');
  ok(/Success rate is 100 percent/.test(before), 'the ping succeeds, which is why nobody looks', before);
  const r1 = lab.t.getDevice('r1');
  const row = r1.arpRows(lab.t, lab.sim.runAtMs).find(function (r) { return r.ip === '10.0.0.10'; });
  ok(!!row, 'the router holds a binding for the contested address');
  ok(!!row.conflict, 'and the row carries the fact that more than one box claims it');
  ok(!!row.conflict && row.conflict.macs.length === 2, 'naming both hardware addresses', JSON.stringify(row.conflict && row.conflict.macs));
  ok(!!row.conflict && row.conflict.macs.indexOf(lab.macOf('p1')) !== -1 && row.conflict.macs.indexOf(lab.macOf('p2')) !== -1,
    'the two hosts, not the router itself');
  ok(!!row.conflict && row.conflict.port === 'Gi0/0/1', 'and the port they were heard on', row.conflict && row.conflict.port);

  const table = show(lab.t, lab.sim, 'r1', 'show ip arp');
  ok(/is claimed by 2 hardware addresses on Gi0\/0\/1/.test(table),
    'the view says it in a sentence, not only in the data', table);
  ok(table.indexOf(lab.macOf('p1')) !== -1 && table.indexOf(lab.macOf('p2')) !== -1,
    'both addresses are named in the note');
  ok(/goes to whichever answers next/.test(table), 'and the consequence is spelled out');
  ok(/^Internet\s+10\.0\.0\.10/m.test(table), 'the ordinary row is still there to read');

  const events = (lab.sim.events || []).filter(function (e) { return e.type === 'arp-conflict'; });
  ok(events.length > 0, 'the clash is also an event, so the packet view can show it');
  ok(events.length > 0 && events[0].ip === '10.0.0.10', 'the event names the address');
  ok(events.length > 0 && events[0].macs && events[0].macs.length === 2, 'and both claimants');
}

console.log('');
console.log('One box holding the address is not a clash:');
{
  const lab = clashLab();
  setIp(lab.t, 'p2', free('p2', lab.t), '10.0.0.11');
  show(lab.t, lab.sim, 'r1', 'ping 10.0.0.10 1');
  const r1 = lab.t.getDevice('r1');
  const row = r1.arpRows(lab.t, lab.sim.runAtMs).find(function (r) { return r.ip === '10.0.0.10'; });
  ok(!!row, 'the healthy address is in the table');
  ok(!row.conflict, 'with no conflict recorded');
  const table = show(lab.t, lab.sim, 'r1', 'show ip arp');
  ok(table.indexOf('is claimed by') === -1, 'and nothing is claimed in the view');
  ok((lab.sim.events || []).filter(function (e) { return e.type === 'arp-conflict'; }).length === 0,
    'no conflict event was invented either');
}

console.log('');
console.log('The same neighbour answering again is not a clash:');
{
  const lab = clashLab();
  setIp(lab.t, 'p2', free('p2', lab.t), '10.0.0.11');
  show(lab.t, lab.sim, 'r1', 'ping 10.0.0.10 1');
  show(lab.t, lab.sim, 'r1', 'ping 10.0.0.10 3');
  const r1 = lab.t.getDevice('r1');
  const row = r1.arpRows(lab.t, lab.sim.runAtMs).find(function (r) { return r.ip === '10.0.0.10'; });
  ok(!row.conflict, 'four replies from one MAC record nothing');
}

console.log('');
console.log('Two subnets may reuse an address, and saying otherwise would be a defect:');
{
  // p1 and p2 hold 10.0.0.10, but on two different routers' segments: the addresses are in different broadcast
  // domains, so neither router ever hears the other's claimant.
  const t = new Topology();
  t.addDevice(ROUTER, 'r1');
  t.addDevice(ROUTER, 'r2');
  t.addDevice(HOST, 'p1');
  t.addDevice(HOST, 'p2');
  t.connect('r1', 'Gi0/0/1', 'p1', free('p1', t), { mediaId: '1000base-t', speedMbps: 1000 });
  t.connect('r2', 'Gi0/0/1', 'p2', free('p2', t), { mediaId: '1000base-t', speedMbps: 1000 });
  const sim = new Simulator(t);
  configureRouter(t, sim, 'r1', ['interface Gi0/0/1', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown']);
  configureRouter(t, sim, 'r2', ['interface Gi0/0/1', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown']);
  setIp(t, 'p1', free('p1', t), '10.0.0.10');
  setIp(t, 'p2', free('p2', t), '10.0.0.10');
  show(t, sim, 'r1', 'ping 10.0.0.10 1');
  show(t, sim, 'r2', 'ping 10.0.0.10 1');
  const forbid = function (id) {
    const d = t.getDevice(id);
    return typeof d.arpConflictFor === 'function' ? d.arpConflictFor('10.0.0.10') : null;
  };
  const c1 = forbid('r1');
  const c2 = forbid('r2');
  ok(!c1 && !c2, 'each router heard one claimant, so neither reports a clash');
  ok(show(t, sim, 'r1', 'show ip arp').indexOf('is claimed by') === -1, 'and neither view claims one');
}

console.log('');
console.log('The answer itself is unchanged - the note is added, nothing is replaced:');
{
  const lab = clashLab();
  show(lab.t, lab.sim, 'r1', 'ping 10.0.0.10 1');
  const r1 = lab.t.getDevice('r1');
  const mac = r1.arp.get('10.0.0.10');
  ok(mac === lab.macOf('p1') || mac === lab.macOf('p2'),
    'the binding is one of the two claimants, as it always was', mac);
  const table = show(lab.t, lab.sim, 'r1', 'show ip arp');
  const rowLine = table.split('\n').find(function (l) { return /^Internet\s+10\.0\.0\.10/.test(l); });
  ok(!!rowLine && rowLine.indexOf(mac) !== -1, 'and the row shows the binding it holds', rowLine);
  ok(/^Protocol\s+Address/m.test(table), 'the table header is intact');
}

console.log('');
console.log('A quiet device says nothing at all:');
{
  const t = new Topology();
  t.addDevice(ROUTER, 'r1');
  const sim = new Simulator(t);
  const table = show(t, sim, 'r1', 'show ip arp');
  ok(/Hardware Addr/.test(table), 'an empty cache still prints its header');
  ok(table.indexOf('is claimed by') === -1, 'and never a conflict note');
  ok(typeof t.getDevice('r1').arpConflictFor !== 'function' ||
  t.getDevice('r1').arpConflictFor('10.0.0.10') === null, 'with no conflict state behind it');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
