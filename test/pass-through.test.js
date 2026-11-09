'use strict';
// pass-through.test.js -- a patch panel has to pass traffic.
//
// A panel is not a switch and not a splitter. It has no MAC table and never
// floods: every front port is joined to exactly one rear port, so a run is
// host -> port N -> rear N -> host. Until the engine grew port pairs, the second
// cable of that run was refused ("<dev>/port1 is already connected") and a panel
// was a dead end that looked cabled. These tests pin the behaviour down.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(v, m) {
  const s = catalog.find(function (x) { return x.vendor === v && x.model === m; });
  if (!s) throw new Error('spec not found: ' + v + '/' + m);
  return s;
}
function PC() { return spec('generic', 'generic-pc'); }

function setIp(dev, topo, sim, addr) {
  return runCommands(dev, topo, sim, [
    'configure terminal', 'interface eth0',
    'ip address ' + addr + ' 255.255.255.0'
  ]);
}
function ping(from, topo, sim, addr) {
  return runCommands(from, topo, sim, ['ping ' + addr]).output;
}

console.log('A. the panel declares paired ports, not a flat block of sockets');
{
  const t = new Topology();
  const panel = t.addDevice(spec('fs', 'C6AP-S24FT1U'));
  ok(panel.interfaces.size === 48, '24 channels expose 48 ports (' + panel.interfaces.size + ')');
  ok(panel.isPassThrough() === true, 'the panel reports itself as pass-through');
  ok(panel.passThroughPeer('port7') === panel.interfaces.get('rear7'), 'port7 is paired with rear7');
  ok(panel.passThroughPeer('rear7').name === 'port7', 'the pairing is symmetric');
  ok(panel.isL2() === false, 'a panel is not an L2 bridge - it must not learn');
}

console.log('B. two cables through one channel are a real path');
{
  const t = new Topology(), sim = new Simulator(t);
  const panel = t.addDevice(spec('fs', 'C6AP-S24FT1U'));
  const a = t.addDevice(PC()), b = t.addDevice(PC());
  t.connect(a.id, 'eth0', panel.id, 'port1');
  t.connect(b.id, 'eth0', panel.id, 'rear1');
  ok(t.links.size === 2, 'both halves of the run cable without refusal');
  setIp(a, t, sim, '10.9.0.1');
  setIp(b, t, sim, '10.9.0.2');
  const out = ping(a, t, sim, '10.9.0.2');
  ok(/Reply from 10\.9\.0\.2/.test(out), 'ping crosses the panel (' + out.split('\n').pop().slice(0, 48) + ')');
}

console.log('C. a frame leaves on its partner only - no flooding across channels');
{
  const t = new Topology(), sim = new Simulator(t);
  const panel = t.addDevice(spec('fs', 'C6AP-S24FT1U'));
  const a = t.addDevice(PC()), b = t.addDevice(PC());
  const c = t.addDevice(PC()), d = t.addDevice(PC());
  t.connect(a.id, 'eth0', panel.id, 'port1');
  t.connect(b.id, 'eth0', panel.id, 'rear1');
  t.connect(c.id, 'eth0', panel.id, 'port2');
  t.connect(d.id, 'eth0', panel.id, 'rear2');
  setIp(a, t, sim, '10.9.1.1');
  setIp(b, t, sim, '10.9.1.2');
  setIp(c, t, sim, '10.9.1.3');
  setIp(d, t, sim, '10.9.1.4');
  sim.events.length = 0;
  // An ARP is a broadcast, which is the frame a hub or a splitter would fan out.
  runCommands(a, t, sim, ['ping 10.9.1.2']);
  const crossed = sim.events.filter(function (e) { return e.type === 'pass-through'; });
  ok(crossed.length > 0, 'the panel reports pass-through events (' + crossed.length + ')');
  const channelOf = function (n) { return String(n).replace(/^(port|rear)/, ''); };
  const offChannel = crossed.filter(function (e) { return channelOf(e.from) !== channelOf(e.to); });
  ok(offChannel.length === 0, 'every frame stayed in its own channel (' + offChannel.length + ' left it)');
  const toC = sim.events.filter(function (e) { return e.type === 'frame' && e.to === c.id; });
  const toD = sim.events.filter(function (e) { return e.type === 'frame' && e.to === d.id; });
  ok(toC.length === 0 && toD.length === 0,
    'the neighbouring channel received nothing (' + (toC.length + toD.length) + ' frames)');
  ok(panel.macTableFor(1).size === 0, 'the panel learned no MAC addresses');
  const fanOut = sim.events.filter(function (e) { return e.type === 'split' && e.dev === panel.id; });
  ok(fanOut.length === 0, 'the panel never took the splitter path');
}

console.log('D. only panels behave this way');
{
  const t = new Topology();
  const sw = t.addDevice(spec('generic', 'generic-switch'));
  const ospf = t.addDevice(PC());
  ok(sw.isPassThrough() === false, 'a switch is not pass-through');
  ok(sw.passThroughPeer('Fa0/1') === null, 'a switch port has no partner');
  ok(ospf.isPassThrough() === false, 'a host is not pass-through');
}

console.log('E. the fibre panel in the catalogue gets the same treatment');
{
  const t = new Topology();
  const odf = t.addDevice(spec('fs', 'FHD-1U-PP-24LC'));
  ok(odf.isPassThrough() === true, 'the LC/UPC ODF reports pass-through');
  ok(odf.interfaces.size === 48, '24 fibres expose 48 ports (' + odf.interfaces.size + ')');
  ok(odf.passThroughPeer('port3').name === 'rear3', 'fibre port3 is paired with rear3');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
