'use strict';
// A gateway's LAN address is not served on its WAN socket (#130 fallback rows).
//
// engine/device.js `ownsIpOn` documents the rule in its own comments: "WAN and LAN are separate L3 surfaces. A
// router's LAN address is not reachable from its WAN port - that is what NAT is for - so role separation outranks
// the VLAN shortcut below." The check is `owner.role && inIface.role && owner.role !== inIface.role`, so it only
// fires when BOTH sides of the question carry a role. test/port-roles.test.js has asserted it for the RT-AX89X
// since #8 ("the WAN port does not answer the LAN address").
//
// The Dream Wall (UDW) and Dream Router (UDR) got their WAN role in PR #2320 and PR #2346 - and their LAN banks
// got no role at all, so the separation silently did not apply: with 192.168.1.1/24 on eth0, ownsIpOn(wan1,
// '192.168.1.1') returned true and a host cabled to the WAN socket inside that subnet got an ICMP reply from the
// LAN gateway. Ubiquiti prints the split on both surfaces the rows already cite - UDW datasheet "Networking
// interface (17) LAN: GbE RJ45 ports / (1) WAN: 2.5 GbE RJ45 port" (https://dl.ui.com/ds/udw_ds.pdf) and
// "Default WAN Ports (1) 2.5 GbE RJ45 (1) 10G SFP+" (https://techspecs.ui.com/unifi/cloud-gateways/udw); UDR
// "Networking interface LAN: (4) GbE RJ45 ports / WAN: (1) GbE RJ45 port" (https://dl.ui.com/ds/udr_ds.pdf) and
// "Default WAN Ports (1) GbE RJ45" (https://techspecs.ui.com/unifi/cloud-gateways/udr).
//
// What must not regress: the bank still answers bank-wide, the WAN socket still answers its own address, the
// radios still reach the LAN address, and the cages keep their dual role (the datasheet does not number them).
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
function spec(model) { return catalog.filter(function (s) { return s.model === model; })[0]; }
function PC() {
  return { vendor: 'generic', model: 'generic-pc', label: 'PC', category: 'host',
    capabilities: ['host', 'cli'], interfaces: [{ name: 'eth0', type: 'ethernet', speed: '1G' }] };
}
function replied(sim, from, to) {
  const res = sim.ping(from, to);
  const evs = (res && res.events) || [];
  return evs.some(function (e) { return e.type === 'icmp-received'; });
}

// Every row below is a vendor-stated split: the controller database's `ports` map names the uplink
// (static.ui.com/fingerprint/ui/public.json, `sku` = the model) and the product page repeats it in words
// ("Default WAN Ports ...", "Max. WAN Port Count ..."). The UCG and UXG rows were added 2026-11-21: their
// LAN banks carried no role either, so the separation did not fire on them. The three Dream Machine rows
// (UDM-Pro, UDM-Pro-Max, UDM-SE) followed the same day: eight 1G LAN sockets plus a 2.5G/1G uplink, all
// nine numbered `eth0`-`eth8` by the controller, with the uplink at `eth8`.
const ROWS = [
  { model: 'UDW', lan: 'eth0', wan: 'wan1', lanCount: 17, second: 'eth5' },
  { model: 'UDR', lan: 'eth0', wan: 'eth4', lanCount: 4, second: 'eth1' },
  { model: 'UCG-Ultra', lan: 'port1', wan: 'wan1', lanCount: 4, second: 'port2' },
  { model: 'UCG-Max', lan: 'Port 1', wan: 'WAN', lanCount: 4, second: 'Port 2' },
  { model: 'UXG-Lite', lan: 'eth0', wan: 'eth1', lanCount: 1, second: null },
  { model: 'UXG-Max', lan: 'eth0', wan: 'eth4', lanCount: 4, second: 'eth1' },
  { model: 'UX', lan: 'lan', wan: 'wan', lanCount: 1, second: null },
  { model: 'UX7', lan: 'eth0', wan: 'eth1', lanCount: 1, second: null },
  { model: 'UDM-Pro', lan: 'port1', wan: 'wan1', lanCount: 8, second: 'port2' },
  { model: 'UDM-Pro-Max', lan: 'Port 1', wan: 'WAN', lanCount: 8, second: 'Port 2' },
  { model: 'UDM-SE', lan: 'Port 1', wan: 'WAN', lanCount: 8, second: 'Port 2' },
  // The Dream Machine itself, added 2026-11-21: four 1G LAN sockets and the one 1G uplink, all five named in the
  // spec, with the controller database's `ports` map naming `eth4` as the uplink and the datasheet printing
  // "(4) LAN: GbE RJ45 ports / (1) WAN: GbE RJ45 port".
  { model: 'UDM', lan: 'LAN 1', wan: 'WAN', lanCount: 4, second: 'LAN 2' }
];

ROWS.forEach(function (row) {
  const model = row.model;
  const lanPort = row.lan;
  const wanPort = row.wan;
  const lanCount = row.lanCount;

  console.log('\n' + model + ': the vendor\'s LAN bank carries a LAN role and the uplink a WAN role');
  {
    const s = spec(model);
    ok(!!s, 'the ' + model + ' is in the catalogue');
    const copper = (s.interfaces || []).filter(function (i) {
      return i.type === 'ethernet' && i.connector !== 'sfp+' && i.name !== wanPort;
    });
    ok(copper.length === lanCount, lanCount + ' copper LAN port(s), as the vendor prints', String(copper.length));
    ok(copper.every(function (i) { return i.role === 'lan'; }),
      'every one of them declares role "lan"',
      copper.filter(function (i) { return i.role !== 'lan'; }).map(function (i) { return i.name; }).join(','));
    const w = s.interfaces.filter(function (i) { return i.name === wanPort; })[0];
    ok(w && w.role === 'wan', 'the uplink declares role "wan"');
  }

  console.log('\n' + model + ': the WAN socket does not answer the LAN address');
  {
    const t = new Topology();
    const r = t.addDevice(spec(model)); r.name = 'GW';
    const lan = r.interfaces.get(lanPort);
    lan.ip = '192.168.1.1'; lan.mask = '255.255.255.0';
    const wan = r.interfaces.get(wanPort);
    wan.ip = '203.0.113.1'; wan.mask = '255.255.255.252';

    ok(!r.ownsIpOn(wan, '192.168.1.1'), 'the address held on ' + lanPort + ' is not owned by ' + wanPort);
    if (row.second) {
      const other = r.interfaces.get(row.second);
      ok(!!r.ownsIpOn(other, '192.168.1.1'),
        'but another LAN port in the bank still reaches it (' + other.name + ')');
    }
    ok(!!r.ownsIpOn(wan, '203.0.113.1'), 'and ' + wanPort + ' still answers its own address');
  }

  console.log('\n' + model + ': a host cabled to the uplink gets no reply from the LAN gateway');
  {
    // The overlapping-subnet case: the WAN host sits in 192.168.1.0/24, so nothing but role separation stops it
    // from reaching the address held on the LAN bank. Before the LAN role existed this ping was answered.
    const t = new Topology();
    const r = t.addDevice(spec(model)); r.name = 'GW';
    const rep = r.interfaces.get(lanPort);
    rep.ip = '192.168.1.1'; rep.mask = '255.255.255.0';

    const w = t.addDevice(PC()); w.name = 'WAN-HOST';
    t.connect(w.id, 'eth0', r.id, wanPort);
    const wi = w.interfaces.get('eth0');
    wi.ip = '192.168.1.50'; wi.mask = '255.255.255.0';
    w.arp.set('192.168.1.1', rep.mac);

    const a = t.addDevice(PC()); a.name = 'LAN-A';
    t.connect(a.id, 'eth0', r.id, lanPort);
    const ai = a.interfaces.get('eth0');
    ai.ip = '192.168.1.10'; ai.mask = '255.255.255.0';

    const sim = new Simulator(t);
    ok(replied(sim, a.id, '192.168.1.1'), 'a host on ' + lanPort + ' reaches the LAN address');
    if (row.second) {
      const b = t.addDevice(PC()); b.name = 'LAN-B';
      t.connect(b.id, 'eth0', r.id, row.second);
      const bi = b.interfaces.get('eth0');
      bi.ip = '192.168.1.20'; bi.mask = '255.255.255.0';
      const sim2 = new Simulator(t);
      ok(replied(sim2, b.id, '192.168.1.1'), 'a host on the other side of the bank reaches it too');
    }
    ok(!replied(sim, w.id, '192.168.1.1'), 'a host on ' + wanPort + ' does NOT');
  }
});

console.log('\nThe radios and the cages keep what the vendor does say');
{
  const u = spec('UDR');
  const radios = u.interfaces.filter(function (i) { return i.type === 'wireless'; });
  ok(radios.length === 2, 'the UDR still carries its two radios');
  ok(radios.every(function (i) { return !i.role; }), 'and they stay role-less: the access point is on the LAN side');

  const d = spec('UDW');
  const cages = d.interfaces.filter(function (i) { return i.connector === 'sfp+'; });
  ok(cages.length === 2, 'the UDW still carries its two SFP+ cages');
  ok(cages.every(function (i) { return (i.dualRole || []).join(',') === 'wan,lan'; }),
    'both stay dual-role - the datasheet prints one LAN and one WAN cage without numbering them');

  // The Dream Machine cages are the one place these rows stop short of a role: the datasheet prints
  // "SFP+ interface (1) LAN: 10G SFP+ / (1) WAN: 10G SFP+" without numbering the two cages, so which of
  // `sfp1`/`sfp2` is the WAN cage is not stated. They keep no role and no dualRole rather than invent one.
  ['UDM-Pro', 'UDM-Pro-Max', 'UDM-SE'].forEach(function (model) {
    const s = spec(model);
    const cages = s.interfaces.filter(function (i) { return i.connector === 'sfp+'; });
    ok(cages.length === 2, model + ' keeps its two SFP+ cages');
    ok(cages.every(function (i) { return !i.role && !i.dualRole; }),
      'and neither cage claims a WAN or LAN role the datasheet does not number');
  });

  const t = new Topology();
  const r = t.addDevice(spec('UDR')); r.name = 'GW';
  const rep = r.interfaces.get('eth0');
  rep.ip = '192.168.1.1'; rep.mask = '255.255.255.0';
  ok(!!r.ownsIpOn(r.interfaces.get('radio0'), '192.168.1.1'),
    'and a wireless client is still answered by the LAN bridge');
}

console.log('\nThe engine rule this rests on is still the one documented');
{
  // A synthetic port pair: WAN on one side, LAN on the other, one address. If the engine ever stops honouring
  // `role`, this fails before the catalogue does.
  const t = new Topology();
  const r = t.addDevice({ vendor: 'generic', model: 'probe-router', label: 'R', category: 'router',
    capabilities: ['route', 'nat', 'l3-forward'],
    interfaces: [
      { name: 'lan1', type: 'ethernet', speed: '1G', role: 'lan' },
      { name: 'wan1', type: 'ethernet', speed: '1G', role: 'wan' }
    ] });
  r.name = 'R';
  const l = r.interfaces.get('lan1');
  l.ip = '10.0.0.1'; l.mask = '255.255.255.0';
  ok(!r.ownsIpOn(r.interfaces.get('wan1'), '10.0.0.1'), 'role separation: the WAN port refuses the LAN address');
  ok(!!r.ownsIpOn(l, '10.0.0.1'), 'and the LAN port still owns it');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
