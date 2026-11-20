'use strict';
// `show lldp neighbors` printed a table no box prints: a heading line, then Neighbour / Local port / Port ID /
// Mgmt address with widths taken from the data. The vendor's brief table is five fixed columns under a legend,
// and this suite pins that shape field by field (research/show-lldp-neighbors-columns.md).
//
// The shape comes from one preserved IOS capture - networktocode/ntc-templates keeps it as a test fixture,
// tests/cisco_ios/show_lldp_neighbors/cisco_ios_show_lldp_neighbors.raw - so the spacing below is the device's,
// not a reflow:
//
//   Capability codes:
//       (R) Router, (B) Bridge, (T) Telephone, (C) DOCSIS Cable Device
//       (W) WLAN Access Point, (P) Repeater, (S) Station, (O) Other
//
//   Device ID           Local Intf     Hold-time  Capability      Port ID
//   S2                  Fa0/13         120        B               Gi0/13
//   Cisco-switch-1      Gi1/0/7        120                        Gi0/1
//
// Two rules ride on the widths: a Device ID longer than 20 characters is cut at 20 (the field table says so, and
// the fixture shows a name ending flush against its port), and a neighbour that advertised no capabilities TLV
// leaves the Capability cell blank rather than inventing a letter.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');
const lldp = require('../engine/lldp');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const MODEL = function (m) { return catalog.find(function (s) { return s.model === m; }); };
const SWITCH = MODEL('generic-switch');
const ROUTER = MODEL('generic-router');
const L3 = catalog.find(function (s) { return s.category === 'l3-switch'; });
const PC = MODEL('generic-pc');

function show(dev, topo, sim, cmd) {
  return (new CliSession(dev, topo, sim).run(cmd || 'show lldp neighbors').output || []).map(String);
}

// A switch with a router and a host on it, so the table has three different capability letters - and a name
// longer than the 20-character column.
function lab() {
  const t = new Topology();
  const sw = t.addDevice(SWITCH, 'sw');
  const r = t.addDevice(ROUTER, 'r-long');
  r.name = 'a-very-long-router-name.example';
  const pc = t.addDevice(PC, 'pc');
  pc.name = 'PC-pc';
  const rPort = [...r.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; })[0].name;
  t.connect('r-long', rPort, 'sw', 'Fa0/1');
  t.connect('pc', 'eth0', 'sw', 'Fa0/2');
  const sim = new Simulator(t);
  sim.refreshNeighbours();
  return { t: t, sim: sim, sw: sw };
}

console.log('');
console.log('The legend is the box\'s, above a blank line and the header:');
{
  const env = lab();
  const out = show(env.sw, env.t, env.sim);
  ok(out[0] === 'Capability codes:', 'the view opens with the legend heading', out[0]);
  ok(out[1] === '    (R) Router, (B) Bridge, (T) Telephone, (C) DOCSIS Cable Device',
    'first legend line, indented four', out[1]);
  ok(out[2] === '    (W) WLAN Access Point, (P) Repeater, (S) Station, (O) Other',
    'second legend line', out[2]);
  ok(out[3] === '', 'a blank line closes the legend', JSON.stringify(out[3]));
  ok(out[4] === 'Device ID           Local Intf     Hold-time  Capability      Port ID',
    'and the header sits at the vendor\'s five column positions', out[4]);
  ok(out[4].indexOf('Local Intf') === 20 && out[4].indexOf('Hold-time') === 35 &&
     out[4].indexOf('Capability') === 46 && out[4].indexOf('Port ID') === 62,
    'columns start at 0, 20, 35, 46 and 62', out[4]);
}

console.log('');
console.log('Each field is printed in its own column, in the vendor\'s order:');
{
  const env = lab();
  const out = show(env.sw, env.t, env.sim);
  const body = out.slice(5).filter(function (l) { return l && !/^Total entries displayed:/.test(l); });
  ok(body.length === 2, 'two neighbour rows', JSON.stringify(body));
  const row = body.filter(function (l) { return /a-very-long/.test(l); })[0] || body[0];
  ok(row.slice(0, 20) === 'a-very-long-router-n', 'the Device ID is cut at exactly 20 characters', row.slice(0, 20));
  ok(row.slice(20, 35).trim() === 'Fa0/1', 'the Local Intf starts at 20', row.slice(20, 35));
  ok(row.slice(35, 46).trim() === '120', 'the Hold-time at 35', row.slice(35, 46));
  ok(row.slice(46, 62).trim() === 'R', 'the Capability at 46', row.slice(46, 62));
  ok(row.slice(62).trim() === 'Gi0/0', 'and the Port ID last, unindented', row.slice(62));
  const host = body.filter(function (l) { return /^PC-pc /.test(l); })[0];
  ok(!!host && host.slice(46, 62).trim() === 'S', 'a host advertises Station', host);
}

console.log('');
console.log('The letters come from the device\'s own capabilities, not from its name:');
{
  const t = new Topology();
  const sw = t.addDevice(SWITCH, 'sw');
  const l3 = t.addDevice(L3, 'l3');
  l3.name = 'L3';
  const r = t.addDevice(ROUTER, 'r');
  r.name = 'R';
  const pc = t.addDevice(PC, 'pc');
  pc.name = 'PC';
  const ethOf = function (d) {
    return [...d.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; })[0].name;
  };
  t.connect('l3', ethOf(l3), 'sw', 'Fa0/1');
  t.connect('r', ethOf(r), 'sw', 'Fa0/2');
  t.connect('pc', 'eth0', 'sw', 'Fa0/3');
  const sim = new Simulator(t);
  sim.refreshNeighbours();
  ok(lldp.capabilityLetters(lldp.capabilityMask(l3)) === 'B,R', 'an L3 switch is a bridge and a router');
  ok(lldp.capabilityLetters(lldp.capabilityMask(r)) === 'R', 'a router is a router');
  ok(lldp.capabilityLetters(lldp.capabilityMask(sw)) === 'B', 'an L2 switch is a bridge');
  ok(lldp.capabilityLetters(lldp.capabilityMask(pc)) === 'S', 'a host is a station, and only that');
  const out = show(sw, t, sim);
  ok(/^L3 +Fa0\/1 +120 +B,R +/.test(out.filter(function (l) { return /^L3 /.test(l); })[0] || ''),
    'and the table prints both letters, comma-separated, in bit order',
    out.filter(function (l) { return /^L3 /.test(l); })[0]);
}

console.log('');
console.log('A neighbour that advertised no capabilities leaves the cell blank:');
{
  const env = lab();
  env.sw.lldp.set('Fa0/5', {
    chassisId: '02:00:00:00:00:99', portId: 'eth9', systemName: 'quiet', mgmtIp: null, capabilities: ''
  });
  const out = show(env.sw, env.t, env.sim);
  const row = out.filter(function (l) { return /^quiet /.test(l); })[0];
  ok(!!row, 'the row is printed', out.join(' | '));
  ok(!!row && row.slice(46, 62).trim() === '', 'with nothing in the Capability column', row && row.slice(46, 62));
  ok(!!row && row.slice(62).indexOf('eth9') === 0, 'and the Port ID still starts its column', row && row.slice(62));
}

console.log('');
console.log('The frame carries the System Capabilities TLV the column reads:');
{
  const t = new Topology();
  const pc = t.addDevice(PC, 'pc');
  const iface = pc.interfaces.get('eth0');
  const f = lldp.buildFrame(pc, iface);
  ok(f.lldp.capabilities === 'S', 'the PC advertises Station', f.lldp.capabilities);
  ok(f.lldp.capabilityMask === 0x0080, 'as 802.1AB bit 7', String(f.lldp.capabilityMask));
  const nb = lldp.neighbourFrom(f, 'Fa0/1', 0);
  ok(nb.capabilities === 'S', 'and the receiving record keeps the letters', nb.capabilities);
  // The TLV is two 2-byte bitmaps: 2 bytes of header plus 4 of value.
  const bare = lldp.buildFrame({ config: { hostname: 'h' }, name: 'h', label: 'h', id: 'h', hasCap: function () { return false; } },
    { name: 'eth0', mac: '02:00:00:00:00:01' });
  const rich = lldp.buildFrame({ config: { hostname: 'h' }, name: 'h', label: 'h', id: 'h', hasCap: function () { return true; } },
    { name: 'eth0', mac: '02:00:00:00:00:01' });
  ok(bare.lldp.bytes === rich.lldp.bytes, 'the TLV is sent whether or not a device claims capabilities',
    bare.lldp.bytes + ' vs ' + rich.lldp.bytes);
}

console.log('');
console.log('The count still closes the view, one blank line down:');
{
  const env = lab();
  const out = show(env.sw, env.t, env.sim);
  ok(out[out.length - 1] === 'Total entries displayed: 2', 'the count is the last line', out[out.length - 1]);
  ok(out[out.length - 2] === '', 'with a blank line above it', JSON.stringify(out.slice(-2)));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
