'use strict';
// build-examples.js — regenerate the example topology JSON files from the engine.
// Run:  node examples/build-examples.js
const fs = require('fs');
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const spec = (v, m) => catalog.find(s => s.vendor === v && s.model === m);
const OUT = __dirname;

function cfg(topo, dev, commands) {
  runCommands(dev, topo, new Simulator(topo), commands);
}
function place(topo, dev, x, y) { topo.layout[dev.id] = { x: x, y: y }; }

// ---------------- Lab 1: two PCs through a switch ----------------
function lab1() {
  const t = new Topology();
  const pc1 = t.addDevice(spec('generic', 'generic-pc'));
  const pc2 = t.addDevice(spec('generic', 'generic-pc'));
  const sw = t.addDevice(spec('generic', 'generic-switch'));
  t.connect(pc1.id, 'eth0', sw.id, 'Fa0/1');
  t.connect(pc2.id, 'eth0', sw.id, 'Fa0/2');
  cfg(t, pc1, ['configure terminal', 'interface eth0', 'ip address 192.168.1.10 255.255.255.0']);
  cfg(t, pc2, ['configure terminal', 'interface eth0', 'ip address 192.168.1.20 255.255.255.0']);
  place(t, pc1, 120, 200); place(t, sw, 360, 200); place(t, pc2, 620, 200);
  return t;
}

// ---------------- Lab 2: router between two subnets ----------------
function lab2() {
  const t = new Topology();
  const pc1 = t.addDevice(spec('generic', 'generic-pc'));
  const pc2 = t.addDevice(spec('generic', 'generic-pc'));
  const r1 = t.addDevice(spec('generic', 'generic-router'));
  t.connect(pc1.id, 'eth0', r1.id, 'Gi0/0');
  t.connect(pc2.id, 'eth0', r1.id, 'Gi0/1');
  cfg(t, pc1, ['configure terminal', 'interface eth0', 'ip address 10.0.1.10 255.255.255.0', 'exit', 'ip default-gateway 10.0.1.1']);
  cfg(t, pc2, ['configure terminal', 'interface eth0', 'ip address 10.0.2.20 255.255.255.0', 'exit', 'ip default-gateway 10.0.2.1']);
  cfg(t, r1, ['configure terminal', 'interface Gi0/0', 'ip address 10.0.1.1 255.255.255.0', 'exit', 'interface Gi0/1', 'ip address 10.0.2.1 255.255.255.0']);
  place(t, pc1, 100, 200); place(t, r1, 400, 200); place(t, pc2, 700, 200);
  return t;
}

// ---------------- Lab 3: multi-vendor campus ----------------
function lab3() {
  const t = new Topology();
  const cloud = t.addDevice(spec('generic', 'generic-cloud'));
  const edge = t.addDevice(spec('cisco', 'ISR4321'));
  const core = t.addDevice(spec('mikrotik', 'CRS326-24G'));
  const accA = t.addDevice(spec('huawei', 'S5735-L24T4S'));
  const accB = t.addDevice(spec('ubiquiti', 'EdgeSwitch-16'));
  const pc1 = t.addDevice(spec('generic', 'generic-pc'));
  const pc2 = t.addDevice(spec('generic', 'generic-pc'));
  const srv = t.addDevice(spec('generic', 'generic-server'));

  // WAN edge (1G copper)
  t.connect(cloud.id, 'eth0', edge.id, 'Gi0/0/0');
  // edge -> core (1G copper)
  t.connect(edge.id, 'Gi0/0/1', core.id, 'ether1');
  // core -> access A (1G copper)
  t.connect(core.id, 'ether2', accA.id, 'GE0/0/1');
  // core -> access B over 1G fiber (SFP+ cage accepting a 1G SFP optic)
  t.connect(core.id, 'sfp-sfpplus1', accB.id, 'SFP1');
  // hosts
  t.connect(accA.id, 'GE0/0/2', pc1.id, 'eth0');
  t.connect(accA.id, 'GE0/0/3', pc2.id, 'eth0');
  t.connect(accB.id, 'port1', srv.id, 'eth0');

  cfg(t, cloud, ['configure terminal', 'interface eth0', 'ip address 198.51.100.1 255.255.255.0', 'exit', 'ip default-gateway 198.51.100.2']);
  cfg(t, edge, [
    'configure terminal', 'hostname EDGE',
    'interface Gi0/0/0', 'ip address 198.51.100.2 255.255.255.0', 'exit',
    'interface Gi0/0/1', 'ip address 10.0.0.1 255.255.255.0', 'exit',
    'ip route 0.0.0.0 0.0.0.0 198.51.100.1'
  ]);
  cfg(t, pc1, ['configure terminal', 'hostname PC1', 'interface eth0', 'ip address 10.0.0.10 255.255.255.0', 'exit', 'ip default-gateway 10.0.0.1']);
  cfg(t, pc2, ['configure terminal', 'hostname PC2', 'interface eth0', 'ip address 10.0.0.20 255.255.255.0', 'exit', 'ip default-gateway 10.0.0.1']);
  cfg(t, srv, ['configure terminal', 'hostname SRV1', 'interface eth0', 'ip address 10.0.0.30 255.255.255.0', 'exit', 'ip default-gateway 10.0.0.1']);

  place(t, cloud, 400, 60);
  place(t, edge, 400, 180);
  place(t, core, 400, 330);
  place(t, accA, 180, 480); place(t, accB, 640, 480);
  place(t, pc1, 60, 620); place(t, pc2, 300, 620); place(t, srv, 760, 620);
  return t;
}

// ---------------- Lab 4: VLANs, a trunk and a redundant loop ----------------
function lab4() {
  const t = new Topology();
  const sw1 = t.addDevice(spec('generic', 'generic-switch'));
  const sw2 = t.addDevice(spec('generic', 'generic-switch'));
  const pc1 = t.addDevice(spec('generic', 'generic-pc'));
  const pc2 = t.addDevice(spec('generic', 'generic-pc'));
  const pc3 = t.addDevice(spec('generic', 'generic-pc'));

  // Two links between the switches: together they are a physical loop, which
  // spanning tree must break, otherwise broadcasts would storm forever.
  t.connect(sw1.id, 'Fa0/8', sw2.id, 'Fa0/8');
  t.connect(sw1.id, 'Fa0/7', sw2.id, 'Fa0/7');
  t.connect(pc1.id, 'eth0', sw1.id, 'Fa0/1');   // VLAN 10
  t.connect(pc2.id, 'eth0', sw2.id, 'Fa0/1');   // VLAN 10
  t.connect(pc3.id, 'eth0', sw2.id, 'Fa0/2');   // VLAN 20

  function swBase(name) {
    return [
      'enable', 'configure terminal', 'hostname ' + name,
      'vlan 10 USERS', 'vlan 20 GUEST',
      'interface Fa0/7', 'switchport mode trunk', 'switchport trunk allowed vlan 10,20', 'exit',
      'interface Fa0/8', 'switchport mode trunk', 'switchport trunk allowed vlan 10,20', 'exit'
    ];
  }
  cfg(t, sw1, swBase('SW1').concat([
    'interface Fa0/1', 'switchport mode access', 'switchport access vlan 10'
  ]));
  cfg(t, sw2, swBase('SW2').concat([
    'interface Fa0/1', 'switchport mode access', 'switchport access vlan 10', 'exit',
    'interface Fa0/2', 'switchport mode access', 'switchport access vlan 20'
  ]));

  cfg(t, pc1, ['configure terminal', 'hostname PC1', 'interface eth0', 'ip address 192.168.10.10 255.255.255.0']);
  cfg(t, pc2, ['configure terminal', 'hostname PC2', 'interface eth0', 'ip address 192.168.10.20 255.255.255.0']);
  cfg(t, pc3, ['configure terminal', 'hostname PC3', 'interface eth0', 'ip address 192.168.10.30 255.255.255.0']);

  place(t, pc1, 80, 620);
  place(t, sw1, 300, 440); place(t, sw2, 720, 440);
  place(t, pc3, 560, 620); place(t, pc2, 860, 620);
  return t;
}

const labs = [
  ['lab1-two-pcs-switch.json', lab1()],
  ['lab2-router-two-subnets.json', lab2()],
  ['lab3-multi-vendor-campus.json', lab3()],
  ['lab4-vlans-trunk-stp.json', lab4()]
];

for (const [name, topo] of labs) {
  const file = path.join(OUT, name);
  fs.writeFileSync(file, JSON.stringify(topo.serialize(), null, 2));
  console.log('wrote ' + name + '  (' + topo.devices.size + ' devices, ' + topo.links.size + ' links)');
}

// self-check: reload each and run a ping to confirm the examples actually work
for (const [name] of labs) {
  const t = Topology.fromJSON(JSON.parse(fs.readFileSync(path.join(OUT, name), 'utf8')));
  // pick a host + a reachable target per lab
  let src, dst;
  if (name.indexOf('lab1') === 0) { src = t.devices.values().next().value; dst = '192.168.1.20'; }
  else if (name.indexOf('lab2') === 0) { src = t.devices.values().next().value; dst = '10.0.2.20'; }
  else if (name.indexOf('lab4') === 0) { src = Array.from(t.devices.values()).find(d => d.name === 'PC1'); dst = '192.168.10.20'; }
  else { src = Array.from(t.devices.values()).find(d => d.name === 'PC1'); dst = '10.0.0.30'; }
  const sim = new Simulator(t);
  const res = sim.ping(src.id, dst, { count: 1 });
  console.log('  verify ' + name + ': ' + (res.replies[0].success ? 'ping OK' : 'PING FAILED'));
}
