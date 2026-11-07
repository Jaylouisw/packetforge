'use strict';
// Port roles and bridge groups (issue #8).
//
// Two things a consumer router does that the model got wrong:
//
// 1. The RT-AX89X's 10G SFP+ and 10G RJ45 cages are each *either* WAN or LAN,
//    chosen in the web UI. Modelling them as fixed ports means you cannot build
//    the WAN-on-10G lab the hardware exists for.
//
// 2. The eight LAN sockets are one switch chip with one router address. Modelling
//    them as eight independent L3 interfaces meant an address on lan1 was dead
//    from lan5 - you had to insert a switch into the lab to work around hardware
//    that is already a switch.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const pcSpec = {
  vendor: 'generic', model: 'generic-pc', label: 'PC', category: 'host',
  capabilities: ['host', 'cli'],
  interfaces: [{ name: 'eth0', type: 'ethernet', speed: '1G' }]
};

const router = catalog.find(function (s) { return s.vendor === 'asus' && s.model === 'RT-AX89X'; });

console.log('The router declares what its hardware can do:');
{
  const t = new Topology();
  const r = t.addDevice(router);
  const lan = [...r.interfaces.values()].filter(function (i) { return i.role === 'lan' && i.bridgeGroup === 'lan'; });
  ok(lan.length === 8, 'all eight LAN sockets are in one bridge group (' + lan.length + ')');
  const wan = r.interfaces.get('wan');
  ok(wan && wan.role === 'wan', 'the WAN port is a WAN port');
  ok(!wan.dualRole, 'and it is not dual-purpose');

  const ten = ['10g-rj45', '10g-sfp'].map(function (n) { return r.interfaces.get(n); });
  ok(ten.every(function (i) { return i && i.dualRole; }), 'both 10G cages are dual-purpose');
  ok(ten.every(function (i) { return i.dualRole.indexOf('wan') !== -1 && i.dualRole.indexOf('lan') !== -1; }),
    'and offer exactly WAN or LAN');
  ok(ten[0].hardware.cage === 'rj45' && ten[1].hardware.cage === 'sfp+',
    'one is copper and one is fibre - the same choice in two media');
}

console.log('\nThe LAN address belongs to the switch, not to a socket:');
{
  const t = new Topology();
  const r = t.addDevice(router);
  r.name = 'R1';
  const a = t.addDevice(pcSpec); a.name = 'PC-LAN1';
  const b = t.addDevice(pcSpec); b.name = 'PC-LAN5';

  t.connect(a.id, 'eth0', r.id, 'lan1');
  t.connect(b.id, 'eth0', r.id, 'lan5');

  // One address, configured once, on the group's representative port.
  const lan1 = r.interfaces.get('lan1');
  lan1.ip = '192.168.1.1'; lan1.mask = '255.255.255.0';

  a.interfaces.get('eth0').ip = '192.168.1.10'; a.interfaces.get('eth0').mask = '255.255.255.0';
  b.interfaces.get('eth0').ip = '192.168.1.20'; b.interfaces.get('eth0').mask = '255.255.255.0';
  r.arp.set('192.168.1.20', b.interfaces.get('eth0').mac);

  // The bug: PC-LAN5 reaches a router whose address is on lan1.
  const sim = new Simulator(t);
  const res = sim.ping(b.id, '192.168.1.1');
  const evs = (res && res.events) || [];
  ok(evs.some(function (e) { return e.type === 'icmp-received'; }),
    'a host on lan5 reaches the LAN address held on lan1');
  const arpReplies = evs.filter(function (e) { return e.type === 'arp-reply'; });
  ok(arpReplies.length > 0, 'the router answered ARP');
  ok(arpReplies.every(function (e) { return e.iface === 'lan5'; }),
    'and answered out of the port that asked (lan5), not the one holding the address');

  // The same address must NOT answer on a port outside the group.
  const wan = r.interfaces.get('wan');
  ok(!r.ownsIpOn(wan, '192.168.1.1'), 'the WAN port does not answer the LAN address');
  ok(!!r.ownsIpOn(r.interfaces.get('lan7'), '192.168.1.1'),
    'but any other port in the group does');
}

console.log('\nEvery port in the group still has its own identity:');
{
  const t = new Topology();
  const r = t.addDevice(router);
  const lan = [...r.interfaces.values()].filter(function (i) { return i.bridgeGroup === 'lan'; });
  const macs = new Set(lan.map(function (i) { return i.mac; }));
  ok(macs.size === lan.length, 'each LAN port has its own MAC');
  ok(lan.every(function (i) { return !i.ip; }), 'and none of them carries an address of its own');
  const rep = r.bridgeGroupRep('lan');
  ok(rep && rep.name === 'lan1', 'the group has one obvious representative to configure (' + (rep && rep.name) + ')');
}

console.log('\nA role cannot be set to something the hardware does not offer:');
{
  // Mirrors the server's guard: only roles the port already lists are legal.
  function canSetRole(iface, role) {
    const allowed = iface.dualRole || (iface.role ? [iface.role] : null);
    return !!allowed && allowed.indexOf(role) !== -1;
  }
  const t = new Topology();
  const r = t.addDevice(router);
  const ten = r.interfaces.get('10g-rj45');
  ok(canSetRole(ten, 'wan') === true, 'a 10G cage can be switched to WAN');
  ok(canSetRole(ten, 'lan') === true, 'and back to LAN');
  ok(canSetRole(ten, 'dmz') === false, 'but not to a role it does not have');
  ok(canSetRole(r.interfaces.get('wan'), 'lan') === false, 'the fixed WAN port cannot be made a LAN port');
  ok(canSetRole(r.interfaces.get('lan3'), 'wan') === false, 'and a LAN socket cannot be made a WAN port');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
