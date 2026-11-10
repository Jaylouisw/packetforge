'use strict';
// show-capability.test.js - a view of a table the device cannot have says what the device is.
//
// The help page became capability-filtered in the previous pass. The `show` views were the other
// half, and they were worse, because they did not refuse - they *answered*:
//
//   PC1#show vlan
//   VLAN  Name      Status  Ports          <- a VLAN 1, invented, with "-" for ports
//   1     VLAN0001  active  -
//
//   PC1#show spanning-tree
//   Spanning tree enabled protocol ieee     <- "enabled", on a host
//     No bridged ports: this device is not part of any L2 loop.
//
//   PC1#show mac address-table
//   Vlan  Mac Address  Type  Ports          <- a switching table, empty, on a device with one port
//
//   PC1#show etherchannel
//   % No link aggregation groups configured <- true, and useless: it cannot have any
//
// `show port-security` already answered properly ("does not switch, so it has no secured ports"), so
// the fix was to make its four neighbours agree with it - both in the `show` handler and in the
// page, where a host was still being offered all four.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function match(re, haystack, msg) {
  const text = (haystack && haystack.output) ? haystack.output.join('\n') : String(haystack);
  ok(re.test(text), msg + (re.test(text) ? '' : ' (no match in ' + JSON.stringify(text.slice(0, 600)) + ')'));
}
function absent(re, haystack, msg) {
  const text = (haystack && haystack.output) ? haystack.output.join('\n') : String(haystack);
  ok(!re.test(text), msg + (re.test(text) ? ' (unexpectedly matched ' + JSON.stringify(text.slice(0, 300)) + ')' : ''));
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const model = function (m) { return catalog.filter(function (x) { return x.model === m; })[0]; };

function lab(m) {
  const t = new Topology();
  const d = t.addDevice(model(m)); d.name = 'D';
  const s = new CliSession(d, t, new Simulator(t)); s.run('enable');
  return { t: t, d: d, s: s };
}

const BRIDGE_VIEWS = ['show vlan', 'show spanning-tree', 'show port-security', 'show etherchannel',
  'show mac address-table'];

console.log('\nA host is told what it is, by every bridge view:');
{
  const pc = lab('generic-pc');
  match(/is a host: it has no VLANs/, pc.s.run('show vlan'), 'show vlan says a host has no VLANs');
  absent(/VLAN0001/, pc.s.run('show vlan'), 'and does not invent a VLAN 1 to put in the table');
  match(/does not bridge, so it runs no spanning tree/, pc.s.run('show spanning-tree'),
    'show spanning-tree does not claim a tree is "enabled"');
  absent(/Spanning tree enabled/, pc.s.run('show spanning-tree'), 'in any wording');
  match(/does not switch, so it has no MAC address table/, pc.s.run('show mac address-table'),
    'show mac address-table names the missing table');
  match(/show arp/, pc.s.run('show mac address-table'), 'and points at the cache a host does have');
  match(/does not switch, so it has no link aggregation/, pc.s.run('show etherchannel'),
    'show etherchannel is not "no groups configured" on a device that cannot have one');
  match(/does not switch, so it has no secured ports/, pc.s.run('show port-security'),
    'and port security keeps the answer it already had');
  // The same on a server, which is also a host with one port.
  const srv = lab('generic-server');
  match(/is a host: it has no VLANs/, srv.s.run('show vlan'), 'a server answers the same way');
}

console.log('\nA router does not bridge, but it can still name VLANs:');
{
  const rt = lab('generic-router');
  match(/does not bridge, so it has no VLAN table/, rt.s.run('show vlan'),
    'an empty VLAN table is not printed');
  match(/can still declare VLAN names/, rt.s.run('show vlan'), 'and the way to use it is named');
  rt.s.run('configure terminal');
  rt.s.run('vlan 10 name users');
  rt.s.run('end');
  const after = rt.s.run('show vlan');
  match(/users/, after, 'once declared, the VLAN is listed');
  match(/\b10\b/, after, 'with its id');
  absent(/VLAN0001/, after, 'and VLAN 1 is still not invented');
  match(/does not bridge, so it runs no spanning tree/, rt.s.run('show spanning-tree'),
    'its spanning-tree answer names the reason a router has none');
  match(/Routers forward at L3/, rt.s.run('show spanning-tree'), 'in a router\'s words');
  match(/does not switch, so it has no MAC address table/, rt.s.run('show mac address-table'),
    'and it has no MAC table either');
}

console.log('\nA switch still gets every table, because it has every table:');
{
  const sw = lab('generic-switch');
  match(/VLAN0001/, sw.s.run('show vlan'), 'show vlan lists VLAN 1');
  match(/Ports/, sw.s.run('show vlan'), 'with its membership column');
  match(/Spanning tree enabled protocol ieee/, sw.s.run('show spanning-tree'), 'the tree is real');
  match(/Root bridge:/, sw.s.run('show spanning-tree'), 'and names its root');
  match(/Vlan\s+Mac Address/, sw.s.run('show mac address-table'), 'the MAC table has a header');
  match(/No link aggregation groups configured/, sw.s.run('show etherchannel'),
    'and "no groups" is the right answer on a switch');
}

console.log('\nThe page agrees with the handler - a view that refuses is not offered:');
{
  const pc = lab('generic-pc');
  const pcShow = pc.s.run('?').output.filter(function (l) { return /^ {2}show /.test(l); })
    .map(function (l) { return l.trim().split(/\s{2,}/)[0]; }).join(' | ');
  for (const v of BRIDGE_VIEWS) {
    ok(pcShow.toLowerCase().indexOf(v.replace('show ', '')) === -1 ||
      /show interfaces/.test(v), 'a PC is not offered "' + v + '"');
  }
  ok(pcShow.indexOf('switchport') === -1, 'nor "show interfaces <port> switchport"');
  const sw = lab('generic-switch');
  const swShow = sw.s.run('?').output.filter(function (l) { return /^ {2}show /.test(l); })
    .map(function (l) { return l.trim().split(/\s{2,}/)[0]; }).join(' | ');
  for (const v of ['show vlan', 'show spanning-tree', 'show port-security', 'show etherchannel',
    'show mac address-table']) {
    ok(swShow.indexOf(v) !== -1, 'a switch is offered "' + v + '"');
  }
  // And the router: VLANs yes (it can declare them), a tree no.
  const rt = lab('generic-router');
  const rtShow = rt.s.run('?').output.filter(function (l) { return /^ {2}show /.test(l); })
    .map(function (l) { return l.trim().split(/\s{2,}/)[0]; }).join(' | ');
  ok(rtShow.indexOf('show vlan') !== -1, 'a router is offered show vlan, which it can use');
  ok(rtShow.indexOf('show spanning-tree') === -1, 'and not show spanning-tree, which it cannot');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
