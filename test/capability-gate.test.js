'use strict';
// capability-gate.test.js - a verb family that changes state is refused where the device has no such state.
//
// The `?` page is capability-filtered: a row appears only where the device can use it. The parser was
// not. On a camera, a server and an AP - none of which bridges, routes or serves DHCP:
//
//   no spanning-tree vlan 10          -> "Spanning tree bridge priority on D1 is already the default (32768)"
//   ip dhcp pool lab                  -> "Created DHCP pool lab"      (and the session entered the pool)
//   no router bgp 65001               -> "BGP disabled"
//   no ospf area 10                   -> "OSPF disabled"
//   ip route 10.9.0.0 255.255.255.0 10.0.0.9 -> "Route added: 10.9.0.0/24 via 10.0.0.9"
//   no router ospf 1                  -> "% Unexpected argument \"1\" - no router ospf takes no more"
//
// Every one of those promises a state the device cannot have: a bridge priority for a box with no
// bridge, a DHCP pool on a DHCP client, a disabled routing protocol, a static route on a host. The last
// one answers a syntax question, which is the wrong question to answer first on a device that cannot run
// the protocol at all.
//
// The page already holds each refusal (`_helpRefusal` is what hides the row), so the parser asks it.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function text(out) { return out && out.output ? out.output.join('\n') : String(out); }
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const find = function (m) { return catalog.filter(function (x) { return x.model === m; })[0]; };

function device(model) {
  const t = new Topology();
  const d = t.addDevice(find(model)); d.name = 'D1';
  const s = new CliSession(d, t, new Simulator(t));
  s.run('enable');
  s.run('configure terminal');
  return { t: t, d: d, s: s };
}
const run = function (model, line) { return text(device(model).s.run(line)); };
// The NAT views are exec commands: asking for one from configuration mode is refused for the mode, not
// for the capability, and the suite has to ask in the right place.
const execRun = function (model, line) {
  const t = new Topology();
  const d = t.addDevice(find(model)); d.name = 'D1';
  const s = new CliSession(d, t, new Simulator(t));
  s.run('enable');
  return text(s.run(line));
};

// A host, a server and an AP: none bridges, routes or serves DHCP.
const HOSTS = ['NetBotz NBRK0750', 'RS500A-E11-RS12U', 'AP-N506'];

console.log('A device that does not bridge is not told about its bridge priority:');
{
  for (const model of HOSTS) {
    for (const line of ['no spanning-tree vlan 10', 'no spanning-tree vlan 10 priority 4096',
      'no spanning-tree vlan 10 root primary']) {
      const out = run(model, line);
      ok(/no spanning tree/.test(out), model + ": '" + line + "' names the capability (" + out.split('\n')[0] + ')');
      ok(!/bridge priority/.test(out), 'and does not report a bridge priority');
      ok(/^%/.test(out), 'as a refusal');
    }
  }
}

console.log('\nA device that is not a DHCP server has no pool, and no pool sub-mode:');
{
  for (const model of HOSTS) {
    const env = device(model);
    const out = text(env.s.run('ip dhcp pool lab'));
    ok(/not a DHCP server/.test(out), model + ': creating a pool is refused by capability');
    ok(!/Created DHCP pool/.test(out), 'and nothing claims a pool was created');
    ok(env.s.prompt().indexOf('config-dhcp') === -1, 'and the prompt is not in a pool sub-mode');
    ok(((env.d.config.pools || {}).lab === undefined), 'and no pool was stored');
    ok(/not a DHCP server/.test(text(device(model).s.run('no ip dhcp pool lab'))),
      'and removing one is refused the same way');
  }
}

console.log('\nA device that does not route does not disable a routing protocol:');
{
  for (const model of HOSTS) {
    for (const line of ['no router bgp 65001', 'no ospf area 10', 'no router ospf 1', 'ospf area 10']) {
      const out = run(model, line);
      ok(/^%/.test(out), model + ": '" + line + "' is a refusal");
      ok(!/(BGP|OSPF) disabled/.test(out), 'and does not claim a protocol was disabled');
    }
    const ospf = run(model, 'no router ospf 1');
    ok(!/takes no more/.test(ospf), model + ': `no router ospf 1` is not answered as a syntax problem'
      + ' (' + ospf.split('\n')[0] + ')');
    ok(/no routes|not a router|does not forward/.test(ospf), 'but as the capability it lacks');
  }
}

console.log('\nA host may still hold a route, which is not the same as routing:');
{
  // Deliberately *not* gated: a host in this model carries its way out as a route
  // (`ip route 0.0.0.0 0.0.0.0 <gateway>`), labs configure exactly that, and `ip routing` is the verb
  // that refuses by name ("is not a router ... ip default-gateway"). Turning the route away would break
  // every host that has a default gateway written the way IOS writes it.
  for (const model of HOSTS) {
    const env = device(model);
    const out = text(env.s.run('ip route 0.0.0.0 0.0.0.0 10.0.0.9'));
    ok(/Route added/.test(out), model + ': a default route is accepted (' + out.split('\n')[0] + ')');
    ok(((env.d.config.routes || []).length) === 1, 'and stored');
    // What a host cannot do is *turn on forwarding*.
    const on = text(device(model).s.run('ip routing'));
    ok(/^%/.test(on), 'and `ip routing` is refused');
    ok(/not a router|default-gateway/.test(on), 'naming what it is, and what it has instead');
  }
}

console.log('\nCapability is judged before syntax:');
{
  // Both facts are true of a host - it cannot run OSPF, and `1` is an extra word for the row - and the
  // capability is the one that answers the question the operator asked.
  const out = run('NetBotz NBRK0750', 'no router ospf 1');
  ok(!/takes no more/.test(out), 'the extra word is not the answer');
  ok(/does not forward|not a router/.test(out), 'the missing capability is');
  // On a router, where the capability exists, the same line keeps its own refusal.
  const r = run('generic-router', 'no router ospf 1');
  ok(/takes no more/.test(r), 'a router still judges the word it cannot take');
}

console.log('\nThe devices that do have these capabilities are untouched:');
{
  const sw = device('generic-switch').s;
  ok(/bridge priority 4096/.test(text(sw.run('spanning-tree vlan 10 priority 4096'))),
    'a switch still sets a bridge priority');
  ok(/root primary/.test(text(sw.run('spanning-tree vlan 10 root primary'))), 'and a root bridge');
  ok(/already the default|bridge priority/.test(text(sw.run('no spanning-tree vlan 10'))),
    'and the removal still reports what it restored');
  const r = device('generic-router');
  ok(/OSPF process 1 enabled/.test(text(r.s.run('router ospf 1'))), 'a router still starts OSPF');
  ok(/BGP enabled/.test(text(device('generic-router').s.run('router bgp 65001'))), 'and BGP');
  const rt = device('generic-router');
  ok(/Route added/.test(text(rt.s.run('ip route 10.9.0.0 255.255.255.0 10.0.0.9'))),
    'and installs a static route');
  const srv = device('RS500A-E11-RS12U');
  ok(/not a DHCP server/.test(text(srv.s.run('ip dhcp pool lab'))),
    'a server is a DHCP client here, so it is refused - the catalogue decides, not the name');
  const dr = device('generic-router');
  ok(/Created DHCP pool/.test(text(dr.s.run('ip dhcp pool lab'))), 'a router still creates a pool');
}

console.log('\nA device that does not translate is given no NAT role, but still shows the table:');
{
  // The role is a promise about packets; the table is a place to look. A device that cannot rewrite an
  // address has no business being told it is a NAT inside interface - but the *view* answers everywhere,
  // deliberately: a rule may come from the topology, and "no translations yet, and here is the command
  // that writes one" is a better answer than a refusal (test/nat-show.test.js fixes that choice).
  for (const model of HOSTS.concat(['generic-switch', '7050SX3'])) {
    for (const line of ['show ip nat translations', 'show ip nat statistics']) {
      const out = execRun(model, line);
      ok(/^NAT (translations|statistics) on/.test(out), model + ": '" + line + "' still answers");
      ok(/no translations yet|no rules/.test(out), 'and says there is nothing, with the command that '
        + 'would put something there');
    }
    ok(/was already empty/.test(execRun(model, 'clear ip nat translation *')),
      model + ': an empty table says it was already empty');
    // The role is set on a port, so the question is asked in the interface block.
    const env = device(model);
    const port = Array.from(env.d.interfaces.values())
      .filter(function (i) { return !/vlan|lo|mgmt/i.test(i.name || ''); })[0];
    const is = new CliSession(env.d, env.t, env.sim);
    is.run('enable'); is.run('configure terminal'); is.run('interface ' + port.name);
    const role = text(is.run('ip nat inside'));
    ok(/^%/.test(role), model + ': `ip nat inside` does not set a role (' + role.split('\n')[0] + ')');
    ok(/does not (translate|route)/.test(role), 'and names what the device does not do');
  }
  // A router holds the table, and says so when it is empty.
  ok(/NAT translations on/.test(execRun('generic-router', 'show ip nat translations')),
    'a router still shows its table');
  ok(/NAT statistics on/.test(execRun('generic-router', 'show ip nat statistics')), 'and its statistics');
  ok(/was already empty/.test(execRun('generic-router', 'clear ip nat translation *')),
    'and clearing an empty table says so');
}

console.log('\nThe interface block asks the same question as configuration mode:');
{
  // The last pass closed the removals in configuration mode and left the interface block open, so a
  // camera still answered `no spanning-tree cost` with "the speed-derived default" for a cost it does
  // not have.
  for (const model of HOSTS) {
    const env = device(model);
    const port = Array.from(env.d.interfaces.values())
      .filter(function (i) { return !/vlan|lo|mgmt/i.test(i.name || ''); })[0];
    const s = new CliSession(env.d, env.t, env.sim);
    s.run('enable'); s.run('configure terminal'); s.run('interface ' + port.name);
    const out = text(s.run('no spanning-tree cost'));
    ok(/^%/.test(out), model + ': `no spanning-tree cost` in a block is refused');
    ok(/no spanning tree/.test(out), 'naming the capability (' + out.split('\n')[0] + ')');
    ok(!/speed-derived default/.test(out), 'and claiming no cost was restored');
  }
  // A switch keeps the interface verb.
  const sw = device('generic-switch');
  const sp = Array.from(sw.d.interfaces.values()).filter(function (i) { return !/vlan|lo/i.test(i.name || ''); })[0];
  const ss = new CliSession(sw.d, sw.t, sw.sim);
  ss.run('enable'); ss.run('configure terminal'); ss.run('interface ' + sp.name);
  ok(!/^%/.test(text(ss.run('spanning-tree cost 20'))), 'a switch still sets a path cost');
}

console.log('\nThe page agrees with the parser:');
{
  for (const model of HOSTS) {
    const env = device(model);
    const page = (env.s._help() || []).join('\n');
    ok(!/ip dhcp pool/.test(page), model + ": the page offers no DHCP pool row it would refuse");
    ok(!/no spanning-tree/.test(page), 'and no spanning-tree row');
  }
}

console.log('\nThe page and the parser agree across the catalogue:');
{
  // The guard for everything above: for every device in the catalogue, in every mode, take each row
  // even the device is not shown, fill its placeholders, and type it. If the capability oracle refuses
  // the line, the parser must refuse it too - otherwise the device has just accepted a family its own
  // page says it has no use for, and the page is the promise.
  const VALUES = {
    addr: '10.0.0.1', address: '10.0.0.1', ip: '10.0.0.1', dest: '10.9.0.0/24', dst: '10.0.0.2',
    src: '10.0.0.1', net: '10.9.0.0', mask: '255.255.255.0', wildcard: '0.0.0.255', gateway: '10.0.0.1',
    peer: '10.0.0.2', 'next-hop': '10.0.0.2', low: '10.9.0.1', high: '10.9.0.5', start: '10.9.0.1',
    end: '10.9.0.9', server: '10.0.0.53', host: 'host1.lab', p: '100', priority: '100', s: '60',
    sec: '60', ms: '100', n: '10', num: '10', count: '10', len: '24', prefix: '10.9.0.0/24', id: '10',
    vrid: '1', group: '1', vid: '10', vlan: '10', as: '65001', pid: '1', acl: '10', name: 'lab',
    text: 'lab', string: 'lab', domain: 'lab.example', hostname: 'host1', mac: '00:11:22:33:44:55',
    port: 'Fa0/1', iface: 'Fa0/1', interface: 'Fa0/1', proto: 'tcp', protocol: 'ip', speed: '100',
    size: '100', mss: '1460', w: '200', l: '100', entry: 'permit ip any any', list: '10,20', tag: '10',
    value: '1', x: '1', unit: 's', param: 'x', days: '1', gw: '10.0.0.1', local: '10.0.0.1',
    mbps: '1000', 'process-id': '1', sequence: '10', type: 'access', verb: 'inside', what: 'version',
    'isd-as': '1:ff00:0:110', 'inside-local': '10.0.0.1', any: 'any', global: '1', parent: 'Fa0/1',
    if: 'Fa0/1', 'list|all': 'all', 'prefix/len': '2001:db8:9::/64', 'addr/len': '2001:db8:9::1/64',
    v6dst: '2001:db8:9::2', 'config-mode command': 'hostname lab'
  };
  function fillRow(tokens, rowText) {
    const out = [];
    for (const t of tokens) {
      if (typeof t === 'string') { out.push(t); continue; }
      const key = String(t.placeholder || '').toLowerCase();
      let v = VALUES[key];
      if (v === undefined && /^\d+-\d+$/.test(key)) v = key.split('-')[0];
      if (v === undefined) return null;
      // A slot wants the value the row's own subject takes.
      if ((key === 'priority' || key === 'n') && /spanning-tree[^|]*priority/.test(rowText)) v = '4096';
      if (/ipv6/.test(rowText) && (key === 'addr' || key === 'address' || key === 'ip' || key === 'gateway')) {
        v = '2001:db8:9::1';
      }
      if (/ipv6/.test(rowText) && (key === 'next-hop' || key === 'dst' || key === 'v6dst')) v = '2001:db8:9::2';
      if (/ipv6/.test(rowText) && (key === 'prefix' || key === 'dest')) v = '2001:db8:9::/64';
      out.push(v);
    }
    return out;
  }
  const byKind = {};
  for (const cat of catalog) {
    const kind = cat.category || cat.kind || 'other';
    if (!byKind[kind]) byKind[kind] = cat;
  }
  let oracleRefused = 0, disagreements = 0;
  const found = [];
  for (const kind of Object.keys(byKind)) {
    const cat = byKind[kind];
    const t = new Topology();
    const d = t.addDevice(cat); d.name = 'D1';
    const ports = Array.from(d.interfaces.values()).filter(function (i) {
      return !/vlan|lo|tunnel|mgmt/i.test(i.name || '');
    });
    const portName = ports.length ? ports[0].name : 'Fa0/1';
    const modes = [
      ['exec', []],
      ['config', ['configure terminal']],
      ['iface', ['configure terminal', 'interface ' + portName]]
    ];
    for (const pair of modes) {
      const probe = new CliSession(d, t, new Simulator(t));
      probe.run('enable'); pair[1].forEach(function (l) { probe.run(l); });
      const rows = probe._helpFormRowsAll(probe.mode) || [];
      for (const row of rows) {
        const toks = row.tokens || [];
        if (!toks.length) continue;
        const rowText = toks.filter(function (x) { return typeof x === 'string'; }).join(' ')
          + ' ' + String(row.synopsis || '');
        const filled = fillRow(toks, rowText);
        if (!filled) continue;
        const line = filled.join(' ');
        // Not an exemption, ordinary control flow: navigation verbs leave the mode the row was read in,
        // so typing one would test the next mode rather than this row.
        if (/^(exit|end|do|help)\b/.test(line)) continue;
        const why = probe._helpRefusal(line);
        if (!why) continue;
        oracleRefused++;
        const s = new CliSession(d, t, new Simulator(t));
        s.run('enable'); pair[1].forEach(function (l) { s.run(l); });
        const ans = text(s.run(line));
        // Not an exemption, ordinary control flow: a `%` line is how every refusal in this console is
        // written, so this is the question the sweep asks, not a way around it.
        if (/^\s*%/.test(ans) || /\n\s*%/.test(ans)) continue;
        disagreements++;
        if (found.length < 6) found.push(kind + ' [' + pair[0] + "]: '" + line + "' -> " + (ans.split('\n')[0] || '(silence)'));
      }
    }
  }
  ok(oracleRefused > 400, 'the sweep found rows the capability oracle refuses (' + oracleRefused + ')');
  ok(disagreements === 0, 'and the parser refuses every one of them'
    + (disagreements ? ' - ' + found.join(' | ') : ''));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
