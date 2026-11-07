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
  const core = t.addDevice(spec('arista', '7050SX3'));
  const accA = t.addDevice(spec('huawei', 'S5735-L24T4S'));
  const accB = t.addDevice(spec('mikrotik', 'CRS326-24G'));
  const pc1 = t.addDevice(spec('generic', 'generic-pc'));
  const pc2 = t.addDevice(spec('generic', 'generic-pc'));
  const srv = t.addDevice(spec('generic', 'generic-server'));

  // WAN edge
  t.connect(cloud.id, 'eth0', edge.id, 'Gi0/0/0');
  // core
  t.connect(edge.id, 'Gi0/0/1', core.id, 'Et1');
  // access switches
  t.connect(core.id, 'Et2', accA.id, 'GE0/0/1');
  t.connect(core.id, 'Et3', accB.id, 'ether1');
  // hosts
  t.connect(accA.id, 'GE0/0/2', pc1.id, 'eth0');
  t.connect(accA.id, 'GE0/0/3', pc2.id, 'eth0');
  t.connect(accB.id, 'ether2', srv.id, 'eth0');

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

const labs = [
  ['lab1-two-pcs-switch.json', lab1()],
  ['lab2-router-two-subnets.json', lab2()],
  ['lab3-multi-vendor-campus.json', lab3()]
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
  else { src = Array.from(t.devices.values()).find(d => d.name === 'PC1'); dst = '10.0.0.30'; }
  const sim = new Simulator(t);
  const res = sim.ping(src.id, dst, { count: 1 });
  console.log('  verify ' + name + ': ' + (res.replies[0].success ? 'ping OK' : 'PING FAILED'));
}
