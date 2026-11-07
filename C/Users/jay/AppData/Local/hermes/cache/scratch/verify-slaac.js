'use strict';
// Independent check of the SLAAC work that landed under the cable-matrix commit.
// Deliberately written from the outside: configure through the same CLI a user would
// type, run the simulator, and assert on the host's resulting addresses and on a ping.
// It does not import engine/ra.js or call any helper the implementation provides.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('./devices/registry');

const catalog = loadCatalog(path.join(path.resolve(__dirname, '..'), 'devices'));

function withPort(cat, pred) {
  for (const s of cat) {
    const d = new Topology().addDevice(s);
    const p = [...d.interfaces.values()].find(function (i) { return i.hardware.cage === 'rj45'; });
    if (p && pred(s)) return { spec: s, port: p.name };
  }
  return null;
}

function cfg(t, dev, cmds) {
  const out = runCommands(dev, t, null, ['enable', 'configure terminal'].concat(cmds));
  const bad = (out.lines || []).filter(function (l) { return /%|invalid|unknown|incomplete/i.test(l); });
  return bad;
}

const router = withPort(catalog, function (s) {
  return s.category === 'router' && (s.capabilities || []).indexOf('l3-forward') !== -1;
});
const host = withPort(catalog, function (s) {
  return ['laptop', 'desktop', 'server'].indexOf(s.category) !== -1;
});

console.log('router:', router.spec.vendor + '/' + router.spec.model, '| host:', host.spec.vendor + '/' + host.spec.model);

const t = new Topology();
const rt = t.addDevice(router.spec); rt.name = 'r1';
const pc = t.addDevice(host.spec); pc.name = 'pc1';
t.addLink(rt.id, router.port, pc.id, host.port, {});

const r1bad = cfg(t, rt, ['ipv6 address 2001:db8:1::1/64', 'ipv6 nd ra enable', 'ipv6 nd prefix 2001:db8:1::/64']);
const pcbad = cfg(t, pc, ['ipv6 address autoconfig']);
if (r1bad.length) console.log('router CLI complaints:', r1bad.join(' | '));
if (pcbad.length) console.log('host CLI complaints:', pcbad.join(' | '));

const sim = new Simulator(t);
if (typeof sim.run === 'function') sim.run({});

const addrs = [];
for (const i of pc.interfaces.values()) {
  for (const a of (i.ipv6 || [])) addrs.push((typeof a === 'string' ? a : a.address) + '@' + i.name);
}
console.log('host IPv6 after RA:', addrs.length ? addrs.join('  ') : '(none)');

const globalAddr = addrs.filter(function (a) { return a.indexOf('2001:db8:1:') === 0; });
console.log('global address formed from the advertised prefix:', globalAddr.length ? 'YES ' + globalAddr[0] : 'NO');

const routes = (typeof pc.ipv6Routes === 'function' ? pc.ipv6Routes() : (pc.ipv6Routes || [])) || [];
console.log('host v6 routes:', JSON.stringify(routes).slice(0, 220));

const p = sim.ping6(pc.id, '2001:db8:1::1');
console.log('ping6 router from a host with NO static address:', p && p.ok ? 'OK' : 'FAILED ' + JSON.stringify(p && (p.reason || p.errors)));

const types = [...new Set((sim.events || []).map(function (e) { return e.type; }))];
console.log('event types:', types.join(','));

const raEvents = (sim.events || []).filter(function (e) { return /ra|slaac/i.test(String(e.type)); });
console.log('RA/SLAAC events:', raEvents.length, raEvents.slice(0, 4).map(function (e) { return e.type; }).join(','));

// Negative case: a router that is not l3-forward must never advertise.
const plain = withPort(catalog, function (s) { return s.category === 'switch'; });
const t2 = new Topology();
const sw = t2.addDevice(plain.spec); sw.name = 'sw1';
const h2 = t2.addDevice(host.spec); h2.name = 'pc2';
t2.addLink(sw.id, plain.port, h2.id, host.port, {});
cfg(t2, sw, ['ipv6 nd ra enable', 'ipv6 nd prefix 2001:db8:2::/64']);
cfg(t2, h2, ['ipv6 address autoconfig']);
const sim2 = new Simulator(t2);
if (typeof sim2.run === 'function') sim2.run({});
const h2addrs = [];
for (const i of h2.interfaces.values()) for (const a of (i.ipv6 || [])) h2addrs.push(typeof a === 'string' ? a : a.address);
const formed = h2addrs.filter(function (a) { return a.indexOf('2001:db8:2:') === 0; });
console.log('switch advertising 2001:db8:2::/64 -> host autoconfigured from it:', formed.length ? 'YES (WRONG)' : 'NO (correct)');
