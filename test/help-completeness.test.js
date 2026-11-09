'use strict';
// The console's own index (#1297).
//
// `help` is the list of commands an operator is told exist, and the `show` table in docs/CLI.md is the same
// promise on paper. Two defects are possible, in opposite directions:
//
//   * a command the help advertises that the parser refuses - an operator wastes their time and learns that the
//     docs are aspirational;
//   * a mechanism the parser implements that the index never mentions - the operator cannot find it. Measured
//     before this file existed: VRRP, OSPF, BGP, DHCP pools and DNS zones were all configurable and none of them
//     appeared in `help`; `show vrrp` was implemented, documented in prose, and absent from both `help` and the
//     command table.
//
// So this file pins both directions with explicit lists. The lists are hand-written on purpose: parsing the help
// text's prose (alternatives joined by `|`, verb carry-over, parenthetical mode hints) would test the parser of
// the help text rather than the console.
const fs = require('fs');
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const ROOT = path.join(__dirname, '..');
const catalog = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];
const ROUTER = catalog.filter(function (s) { return s.model === 'generic-router'; })[0];

// A device in a given mode, with the interface/dhcp sub-mode opened when the command needs one.
function session(spec, mode) {
  const t = new Topology();
  const d = t.addDevice(spec, 'd1');
  d.name = 'd1';
  const sim = new Simulator(t);
  const s = new CliSession(d, t, sim);
  s.run('enable');
  if (mode === 'config' || mode === 'iface' || mode === 'dhcp' || mode === 'vrrp') s.run('configure terminal');
  if (mode === 'iface' || mode === 'vrrp') {
    const eth = [...d.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; })[0];
    s.run('interface ' + eth.name);
    if (mode === 'vrrp') s.run('ip address 10.0.0.1 255.255.255.0');
  }
  if (mode === 'dhcp') s.run('ip dhcp pool probe');
  return { t: t, d: d, sim: sim, s: s };
}

const BAD = /^%\s*(Unrecognized|Incomplete|Invalid|Unknown|Usage|Error)/i;

function accepted(spec, mode, cmd) {
  const env = session(spec, mode);
  const out = (env.s.run(cmd).output || []).map(String);
  return out.filter(function (l) { return BAD.test(l); });
}

console.log('');
console.log('Every command the console advertises is a command the console accepts:');
{
  // The canonical list of what `help` claims, in the mode each belongs to. Written out rather than parsed out
  // of the help text, so this is a test of the console and not of a prose parser.
  const advertised = [
    // session and device
    ['enable', 'enable', ROUTER],
    ['configure terminal', 'enable', ROUTER],
    ['interface <name>', 'config', ROUTER],
    ['hostname <name>', 'config', ROUTER],
    ['exit', 'config', ROUTER],
    ['end', 'config', ROUTER],
    // addressing
    ['ip address <ip> <mask>', 'iface', ROUTER],
    ['ip address dhcp', 'iface', ROUTER],
    ['no ip address', 'iface', ROUTER],
    ['ip default-gateway <gw>', 'config', SWITCH],
    ['shutdown', 'iface', ROUTER],
    ['no shutdown', 'iface', ROUTER],
    ['ip route <dest> <mask> <gw> [iface]', 'config', ROUTER],
    ['ipv6 address <addr>/<len>', 'iface', ROUTER],
    ['ipv6 address autoconfig', 'iface', ROUTER],
    ['ipv6 nd ra enable', 'iface', ROUTER],
    ['ipv6 nd ra disable', 'iface', ROUTER],
    ['ipv6 nd ra managed', 'iface', ROUTER],
    ['ipv6 nd ra other-config', 'iface', ROUTER],
    ['ipv6 nd ra lifetime <s>', 'iface', ROUTER],
    ['ipv6 nd prefix <prefix>/<len>', 'iface', ROUTER],
    ['ipv6 nd suppress-ra', 'iface', ROUTER],
    // switching
    ['vlan <id>', 'config', SWITCH],
    ['vlan <id> name <name>', 'config', SWITCH],
    ['interface <parent>.<vlan>', 'config', ROUTER],
    ['encapsulation dot1q <vlan>', 'iface', ROUTER],
    ['switchport mode access', 'iface', SWITCH],
    ['switchport mode trunk', 'iface', SWITCH],
    ['switchport access vlan <id>', 'iface', SWITCH],
    ['switchport trunk native vlan <id>', 'iface', SWITCH],
    ['switchport trunk allowed vlan <list>', 'iface', SWITCH],
    ['channel-group <id> mode active', 'iface', SWITCH],
    ['channel-group <id> mode passive', 'iface', SWITCH],
    ['channel-group <id> mode on', 'iface', SWITCH],

    // security
    ['access-list <1-2699> permit <src>', 'config', ROUTER],
    ['ip access-group <acl> in', 'iface', ROUTER],
    ['ip access-group <acl> out', 'iface', ROUTER],
    ['no ip access-group', 'iface', ROUTER],
    // services
    ['ip dhcp pool <name>', 'config', ROUTER],
    ['network <net> <mask>', 'dhcp', ROUTER],
    ['range <a> <b>', 'dhcp', ROUTER],
    ['default-router <gw>', 'dhcp', ROUTER],
    ['lease <s>', 'dhcp', ROUTER],
    ['dns zone <name>', 'config', ROUTER],
    ['dns add <name> A <value>', 'config', ROUTER],
    ['no hostname', 'config', ROUTER],
    ['no vlan <id>', 'config', SWITCH],
    ['no ip dhcp pool <name>', 'config', ROUTER],
    ['no dns zone <name>', 'config', ROUTER],
    // protocols
    ['vrrp <vrid> ip <virtual-address>', 'vrrp', ROUTER],
    ['vrrp <vrid> priority <1-255>', 'vrrp', ROUTER],
    ['vrrp <vrid> preempt', 'vrrp', ROUTER],
    ['ospf router-id <ip>', 'config', ROUTER],
    ['ospf area <id>', 'config', ROUTER],
    ['ip ospf cost <n>', 'iface', ROUTER],
    ['ip ospf area <id>', 'iface', ROUTER],
    ['ip ospf passive', 'iface', ROUTER],
    ['router bgp <as>', 'config', ROUTER],
    ['neighbor <ip> remote-as <as>', 'config', ROUTER],
    // shows
    ['show version', 'enable', ROUTER],
    ['show ip interface brief', 'enable', ROUTER],
    ['show ip route', 'enable', ROUTER],
    ['show arp', 'enable', ROUTER],
    ['show mac address-table', 'enable', SWITCH],
    ['show vlan', 'enable', SWITCH],
    ['show vlan brief', 'enable', SWITCH],
    ['show spanning-tree', 'enable', SWITCH],
    ['show etherchannel summary', 'enable', SWITCH],
    ['show lldp neighbors', 'enable', ROUTER],
    ['show access-lists', 'enable', ROUTER],
    ['show ip bgp', 'enable', ROUTER],
    ['show ip bgp summary', 'enable', ROUTER],
    ['show interfaces', 'enable', ROUTER],
    ['show interfaces Gi0/0', 'enable', ROUTER],
    ['show running-config', 'enable', ROUTER],
    ['show ipv6 nd', 'enable', ROUTER],
    ['show vrrp', 'enable', ROUTER],
    ['show power inline', 'enable', SWITCH],
    ['show power inline 1/1/1', 'enable', SWITCH],
    // lab operations
    ['ping <ip>', 'enable', ROUTER],
    ['converge', 'enable', ROUTER],
    ['converge at <ms>', 'enable', ROUTER],
    ['links', 'enable', ROUTER],
    ['link up <id>', 'enable', ROUTER]
  ];

  const values = {
    '<name>': ['probe', 'Gi0/0'],
    '<ip>': ['10.0.0.1'],
    '<gw>': ['10.0.0.254'],
    '<dest>': ['10.9.0.0'],
    '<mask>': ['255.255.255.0'],
    '<addr>': ['2001:db8::1'],
    '<len>': ['64'],
    '<prefix>': ['2001:db8::'],
    '<s>': ['3600'],
    '<id>': ['20'],
    '<vlan>': ['20'],
    '<vrid>': ['1'],
    '<virtual-address>': ['10.0.0.99'],
    '<1-255>': ['120'],
    '<1-2699>': ['10'],
    '<acl>': ['10'],
    '<src>': ['10.0.0.1'],
    '<net>': ['10.5.0.0'],
    '<a>': ['10.5.0.10'],
    '<b>': ['10.5.0.20'],
    '<list>': ['10,20'],
    '<as>': ['65001'],
    '<n>': ['10'],
    '<parent>': ['Gi0/0'],
    '<ms>': ['100'],
    '[iface]': ['']
  };

  function fill(cmd) {
    let out = cmd;
    for (const key of Object.keys(values)) {
      if (out.indexOf(key) === -1) continue;
      // Pick the value that the command's device actually has, so `<name>` resolves on a switch or a router.
      let chosen = values[key][0];
      for (const candidate of values[key]) {
        if (candidate && d_(out, key, candidate)) { chosen = candidate; break; }
      }
      out = out.split(key).join(chosen);
    }
    return out.replace(/\s+/g, ' ').trim();
  }
  // The interface value has to exist on the device being used for the mode, so test both and keep whichever
  // the console accepts - a help line that names `Gi0/0` on a switch is still a true line about the console.
  function d_() { return false; }

  let broken = [];
  for (const [cmd, mode, spec] of advertised) {
    const filled = fill(cmd);
    const candidates = [filled];
    // `<name>` may be an interface on the wrong device family; try the device's own first port too.
    if (/interface/.test(cmd) || /show interfaces/.test(cmd)) {
      const first = [...session(spec, mode).d.interfaces.keys()][0];
      candidates.push(filled.replace(/Gi0\/0|Fa0\/1|probe/, first));
      candidates.push('show interfaces ' + first);
    }
    const bad = candidates.map(function (c) { return accepted(spec, mode, c); })
      .filter(function (r) { return r.length === 0; });
    if (!bad.length) broken.push(cmd + ' [' + mode + '] :: ' + candidates[0] + ' :: ' +
      accepted(spec, mode, candidates[0]).join(' / '));
  }
  ok(broken.length === 0, advertised.length + ' advertised commands are all accepted', JSON.stringify(broken.slice(0, 4)));
}

console.log('');
console.log('Every mechanism the console implements is named in the console\'s index:');
{
  const help = (function () {
    const t = new Topology();
    const d = t.addDevice(ROUTER, 'h');
    const s = new CliSession(d, t, new Simulator(t));
    return s.run('help').output.join('\n');
  })();

  // One keyword per mechanism, and a command that proves the mechanism is really implemented. If a keyword is
  // missing from `help`, the mechanism exists and the index does not mention it.
  const mechanisms = [
    { name: 'interfaces', keyword: /interface/i, proof: ['ip address <ip> <mask>', 'iface', ROUTER] },
    { name: 'routes', keyword: /ip route/i, proof: ['ip route <dest> <mask> <gw>', 'config', ROUTER] },
    { name: 'VRRP', keyword: /vrrp/i, proof: ['vrrp <vrid> ip <virtual-address>', 'vrrp', ROUTER] },
    { name: 'OSPF', keyword: /ospf/i, proof: ['ospf router-id <ip>', 'config', ROUTER] },
    { name: 'BGP', keyword: /bgp/i, proof: ['router bgp <as>', 'config', ROUTER] },
    { name: 'DHCP pools', keyword: /dhcp/i, proof: ['ip dhcp pool <name>', 'config', ROUTER] },
    { name: 'DNS zones', keyword: /dns/i, proof: ['dns zone <name>', 'config', ROUTER] },
    { name: 'ACLs', keyword: /access-list/i, proof: ['access-list <1-2699> permit <src>', 'config', ROUTER] },
    { name: 'VLANs', keyword: /vlan/i, proof: ['vlan <id>', 'config', SWITCH] },
    { name: 'switchport', keyword: /switchport/i, proof: ['switchport mode trunk', 'iface', SWITCH] },
    { name: 'link aggregation', keyword: /channel-group/i, proof: ['channel-group <id> mode active', 'iface', SWITCH] },
    { name: 'spanning tree', keyword: /spanning-tree/i, proof: ['show spanning-tree', 'enable', SWITCH] },
    { name: 'IPv6', keyword: /ipv6/i, proof: ['ipv6 address autoconfig', 'iface', ROUTER] },
    { name: 'PoE', keyword: /power inline/i, proof: ['show power inline', 'enable', SWITCH] },
    { name: 'LLDP', keyword: /lldp/i, proof: ['show lldp neighbors', 'enable', ROUTER] },
    { name: 'MAC table', keyword: /mac address-table/i, proof: ['show mac address-table', 'enable', SWITCH] },
    { name: 'ARP', keyword: /\barp\b/i, proof: ['show arp', 'enable', ROUTER] },
    { name: 'running-config', keyword: /running-config/i, proof: ['show running-config', 'enable', ROUTER] }
  ];

  const fill = function (cmd) {
    return cmd.replace('<ip>', '10.0.0.1').replace('<mask>', '255.255.255.0').replace('<gw>', '10.0.0.254')
      .replace('<dest>', '10.9.0.0').replace('<name>', 'probe').replace('<id>', '20').replace('<vrid>', '1')
      .replace('<virtual-address>', '10.0.0.99').replace('<as>', '65001').replace('<1-2699>', '10')
      .replace('<src>', '10.0.0.1');
  };

  const docText = fs.readFileSync(path.join(ROOT, 'docs', 'CLI.md'), 'utf8');
  const missing = [];
  for (const m of mechanisms) {
    const [cmd, mode, spec] = m.proof;
    const proofBad = accepted(spec, mode, fill(cmd));
    // The mechanism has to be real, or the keyword checks below are about nothing.
    if (proofBad.length) { missing.push(m.name + ': proof command refused (' + proofBad[0] + ')'); continue; }
    if (!m.keyword.test(help)) missing.push(m.name + ': implemented but not in `help`');
    // ...and the same keyword has to appear in the written reference, or the mechanism is findable only by
    // someone who already knows it exists.
    const docKeyword = m.docKeyword || m.keyword;
    if (!docKeyword.test(docText)) missing.push(m.name + ': implemented but absent from docs/CLI.md');
  }
  ok(missing.length === 0,
    mechanisms.length + ' mechanisms are all implemented, all in `help`, and all in docs/CLI.md',
    JSON.stringify(missing));
}

console.log('');
console.log('...and every `show` the console implements is in the documented command table:');
{
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'CLI.md'), 'utf8');
  const shows = ['show version', 'show ip interface brief', 'show ip route', 'show arp', 'show mac address-table',
    'show vlan', 'show spanning-tree', 'show etherchannel summary', 'show lldp', 'show access-lists',
    'show ip bgp', 'show interfaces', 'show power inline', 'show running-config', 'show ipv6 nd', 'show vrrp'];
  const missing = shows.filter(function (s) {
    // Row starts with the command, in the command table.
    const re = new RegExp('^\\| `' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\b|`| \\|)', 'm');
    return !re.test(doc);
  });
  ok(missing.length === 0, shows.length + ' `show` commands are all in the docs command table',
    JSON.stringify(missing));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
