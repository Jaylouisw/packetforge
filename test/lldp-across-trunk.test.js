'use strict';
// An allowed-VLAN list ate the protocol that describes the link (#1457).
//
// Two switches joined by a trunk. Somebody trims the trunk to the VLAN it is meant to carry:
//
//   s1(config-if)# switchport trunk allowed vlan 10
//
// The cable stays up - `show interfaces Fa0/1` still prints `peer: s2/Fa0/1` - and yet both ends stop naming each
// other in `show lldp neighbors`, which is now `(none - no LLDP has been heard on any port)`. The only trace left
// behind is a drop counter on a perfectly healthy port, attributed to a VLAN nobody mentioned:
//
//   1 drop (VLAN 1 not allowed on egress)
//
// LLDP is a link protocol, not customer traffic: it is sent untagged to the nearest-bridge multicast group, and the
// allowed list decides which switched frames the link carries, not whether its two ends may describe themselves to
// each other. Running the announcement through the egress filter turned a routine trunk trim into a blind spot.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');
const lldp = require('../engine/lldp');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const ROOT = path.join(__dirname, '..');
const catalog = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.find(function (s) { return s.model === 'generic-switch'; });
const PC = catalog.find(function (s) { return s.model === 'generic-pc'; });

// Two switches on a trunk, plus a host on each so there is traffic to ask a question about.
function lab(trunkLines) {
  const t = new Topology();
  t.addDevice(SWITCH, 's1'); t.addDevice(SWITCH, 's2');
  t.addDevice(PC, 'a'); t.addDevice(PC, 'b');
  t.connect('s1', 'Fa0/1', 's2', 'Fa0/1');
  t.connect('a', 'eth0', 's1', 'Fa0/2');
  t.connect('b', 'eth0', 's2', 'Fa0/2');
  const sim = new Simulator(t);
  const S = {};
  const cli = function (id) { return (S[id] = S[id] || new CliSession(t.getDevice(id), t, sim)); };
  const cfg = function (id, lines) {
    cli(id).run('configure terminal');
    lines.forEach(function (l) { return cli(id).run(l); });
    cli(id).run('end');
  };
  ['s1', 's2'].forEach(function (s) { cfg(s, ['interface Fa0/1'].concat(trunkLines)); });
  cfg('a', ['interface eth0', 'ip address 10.0.0.1 255.255.255.0']);
  cfg('b', ['interface eth0', 'ip address 10.0.0.2 255.255.255.0']);
  // Ports announce themselves when the devices come up, not when someone asks a question; the same call the board
  // makes after a cable is plugged in.
  sim.refreshNeighbours();
  return {
    t: t, sim: sim, cli: cli, cfg: cfg,
    show: function (id, cmd) { return cli(id).run(cmd).output; },
    row: function (id, name) {
      return this.show(id, 'show lldp neighbors').filter(function (l) {
        return new RegExp('^\\s*' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s').test(l);
      })[0] || '';
    },
    drops: function (id, port) {
      const line = this.show(id, 'show interfaces ' + port).filter(function (l) {
        return /\d+ drop/.test(l);
      })[0] || '';
      return line.trim();
    }
  };
}

console.log('');
console.log('A trimmed trunk still names the box at the other end:');
{
  const L = lab(['switchport mode trunk', 'switchport trunk allowed vlan 10']);
  const s1Row = L.row('s1', 'Switch (L2)-s2');
  const s2Row = L.row('s2', 'Switch (L2)-s1');
  ok(s1Row !== '', 's1 lists s2 as a neighbour', L.show('s1', 'show lldp neighbors').join(' | '));
  ok(s2Row !== '', 's2 lists s1 as a neighbour', L.show('s2', 'show lldp neighbors').join(' | '));
  ok(/Fa0\/1/.test(s1Row), 'the row names the local port the neighbour is on', s1Row);
  ok(/Fa0\/1/.test(s2Row), 'and so does the other end', s2Row);
  ok(!/no LLDP has been heard/.test(L.show('s1', 'show lldp neighbors').join(' ')),
    'the empty-table sentence is gone from s1', L.show('s1', 'show lldp neighbors').join(' | '));
  ok(!/no LLDP has been heard/.test(L.show('s2', 'show lldp neighbors').join(' ')),
    'and from s2', L.show('s2', 'show lldp neighbors').join(' | '));

  const port = L.show('s1', 'show interfaces Fa0/1');
  ok(/switchport: trunk/.test(port.join('\n')) && /allowed 10/.test(port.join('\n')),
    'the configuration that caused it is still reported as it is', port.join(' | '));
  ok(/peer: s2\/Fa0\/1/.test(port.join('\n')), 'and the cable still names its peer', port.join(' | '));

  const drops = L.drops('s1', 'Fa0/1');
  ok(drops === '', 'a healthy port carries no drop counter for announcing itself', drops);
  ok(!/VLAN 1 not allowed/.test(L.show('s1', 'show interfaces Fa0/1').join(' ')),
    'and never blames a VLAN nobody mentioned', L.show('s1', 'show interfaces Fa0/1').join(' | '));
  const out = L.show('s1', 'show interfaces Fa0/1').filter(function (l) { return /packets output/.test(l); })[0] || '';
  ok(/[1-9]\d* packets output/.test(out), 'the announcement was counted as sent, not dropped', out.trim());
}

console.log('');
console.log('It leaves untagged, because that is what a link protocol is:');
{
  const L = lab(['switchport mode trunk', 'switchport trunk allowed vlan 10']);
  const s1 = L.t.getDevice('s1');
  const port = s1.interfaces.get('Fa0/1');
  L.sim.announceLldp();
  const wire = L.sim.queue.filter(function (q) {
    return q.devId === 's1' && q.iface === 'Fa0/1' && lldp.isLldp(q.frame);
  })[0];
  ok(!!wire, 's1 puts an LLDP frame on the trimmed trunk', JSON.stringify(L.sim.queue.length));
  ok(wire && wire.frame.wireTagged === false, 'it goes out untagged', wire && String(wire.frame.wireTagged));
  ok(wire && wire.frame.wireVid === null, 'with no VLAN tag on the wire', wire && String(wire.frame.wireVid));
  const heard = [];
  const orig = L.sim._emit.bind(L.sim);
  L.sim._emit = function (ev) { heard.push(ev); return orig(ev); };
  L.sim.announceLldp(); L.sim._run();
  L.sim._emit = orig;
  const far = heard.filter(function (e) { return e.type === 'lldp' && e.dev === 's2' && e.iface === 'Fa0/1'; })[0];
  ok(!!far, 'the far end records the announcement on the port it arrived on', JSON.stringify(heard.filter(function (e) { return e.type === 'lldp'; })));
  ok(far && far.neighbour === 'Switch (L2)-s1', 'naming the box that sent it', far && far.neighbour);
}

console.log('');
console.log('The exemption is LLDP only - customer traffic is still filtered:');
{
  const L = lab(['switchport mode trunk', 'switchport trunk allowed vlan 10']);
  const s1 = L.t.getDevice('s1');
  const port = s1.interfaces.get('Fa0/1');
  const arp = {
    dstMac: 'ff:ff:ff:ff:ff:ff', srcMac: '02:00:00:00:00:99', etherType: 0x0806,
    arp: { op: 'request', senderMac: '02:00:00:00:00:99', senderIp: '10.0.0.9', targetMac: '00:00:00:00:00:00', targetIp: '10.0.0.8' }
  };
  const heard = [];
  const orig = L.sim._emit.bind(L.sim);
  L.sim._emit = function (ev) { heard.push(ev); return orig(ev); };
  L.sim.queue.length = 0;
  L.sim._emitFrame(s1, port, arp, 1);                 // customer frame in the excluded VLAN
  const wireAfterArp = L.sim.queue.length;
  L.sim._emitFrame(s1, port, lldp.buildFrame(s1, port));   // link protocol on the same port
  const wireAfterLldp = L.sim.queue.length;
  L.sim._emit = orig;

  const refusal = heard.filter(function (e) { return e.type === 'vlan-drop'; })[0];
  ok(!!refusal, 'a VLAN 1 customer frame is still refused', JSON.stringify(heard.map(function (e) { return e.type; })));
  ok(refusal && refusal.vlan === 1 && /VLAN 1 not allowed on egress/.test(refusal.reason),
    'with the same sentence it always had', refusal && refusal.reason);
  ok(refusal && refusal.iface === 'Fa0/1', 'on the port that cannot carry it', refusal && refusal.iface);
  ok(wireAfterArp === 0, 'and it never reaches the wire', String(wireAfterArp));
  ok(wireAfterLldp === 1, 'while the link protocol does', String(wireAfterLldp));

  // The same refusal, seen the way a reader sees it: the port's own counters.
  L.sim.queue.length = 0;
  const dropped = [];
  const orig2 = L.sim._emit.bind(L.sim);
  L.sim._emit = function (ev) { dropped.push(ev); return orig2(ev); };
  L.sim._emitFrame(s1, port, arp, 20);               // a second excluded VLAN
  L.sim._emit = orig2;
  const twenty = dropped.filter(function (e) { return e.type === 'vlan-drop' && e.vlan === 20; })[0];
  ok(!!twenty, 'a VLAN 20 frame is refused too', JSON.stringify(dropped.map(function (e) { return [e.type, e.vlan]; })));
}

console.log('');
console.log('A native VLAN that is not allowed changes nothing about discovery:');
{
  const L = lab(['switchport mode trunk', 'switchport trunk native vlan 20', 'switchport trunk allowed vlan 10']);
  const s1Row = L.row('s1', 'Switch (L2)-s2');
  const s2Row = L.row('s2', 'Switch (L2)-s1');
  ok(s1Row !== '' && s2Row !== '', 'both ends still list each other', s1Row + ' || ' + s2Row);
  const port = L.show('s1', 'show interfaces Fa0/1').join('\n');
  ok(/native 20/.test(port) && /allowed 10/.test(port), 'the port still reports native 20, allowed 10', port);
  ok(L.drops('s1', 'Fa0/1') === '', 'with no drop recorded for announcing itself', L.drops('s1', 'Fa0/1'));
  const stale = L.show('s1', 'show lldp neighbors').join(' ');
  ok(!/VLAN 20 not allowed/.test(stale), 'and no complaint about the native VLAN either', stale);
}

console.log('');
console.log('Everything that worked still works:');
{
  // A trunk with no list at all: the case that always worked, kept as the regression guard.
  const L = lab(['switchport mode trunk']);
  ok(L.row('s1', 'Switch (L2)-s2') !== '', 'a default trunk exchanges announcements', L.show('s1', 'show lldp neighbors').join(' | '));
  ok(L.row('s2', 'Switch (L2)-s1') !== '', 'in both directions', L.show('s2', 'show lldp neighbors').join(' | '));
  const host = L.row('s1', 'PC-a');
  ok(host !== '' && /Fa0\/2/.test(host), 'a host on an access port is still discovered', host);
  ok(/10\.0\.0\.1/.test(host), 'with its management address', host);
}
{
  // A shut port announces nothing, and the neighbour that is already known is not silently forgotten.
  const L = lab(['switchport mode trunk', 'switchport trunk allowed vlan 10']);
  L.cfg('s1', ['interface Fa0/1', 'shutdown']);
  L.sim.refreshNeighbours();
  const s2Rows = L.show('s2', 'show lldp neighbors');
  const row = s2Rows.filter(function (l) { return /Switch \(L2\)-s1/.test(l); })[0] || '';
  ok(/down/.test(row), 'the neighbour row says the peer is down, not that it never existed', row.trim());
  L.cfg('s1', ['interface Fa0/1', 'no shutdown']);
  L.sim.refreshNeighbours();
  const back = L.row('s2', 'Switch (L2)-s1');
  ok(/down/.test(back) === false, 'and it goes healthy again when the port comes up', back.trim());
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
