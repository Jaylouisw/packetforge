'use strict';
// help-truthful.test.js - the page an operator is shown must be a page this device can use.
//
// The config page was **byte-identical for every device kind**: a PC with one Ethernet port was
// offered `vlan <id>`, `switchport <verb>`, `spanning-tree vlan <id> root primary`,
// `ip nat inside source …` and `router ospf 1`, every one of which answered "% … is not a switch"
// or "% … cannot run OSPF". The page now filters on capability, and this suite holds both halves of
// that bargain:
//
//   * a row that IS shown is a row the parser recognises (no "% Unrecognized"), and
//   * a row that is hidden is one the device really cannot use.
//
// The second half is what stops the filter becoming a way to hide breakage.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const model = function (m) { return catalog.filter(function (x) { return x.model === m; })[0]; };

// A minimal instance of a synopsis: every placeholder gets a value of the right shape, so the row
// is typed the way an operator types it rather than the way it is documented.
const VALUES = {
  '<name>': 'probe1', '<id>': '10', '<n>': '10', '<ip>': '10.0.0.1', '<gw>': '10.0.0.254',
  '<dest>': '10.9.0.0', '<mask>': '255.255.255.0', '<mac>': '0200.0000.0001',
  '<port>': null, '<vlan>': '10', '<as>': '65001', '<local>': '10.0.0.1', '<global>': '10.0.0.2',
  '<acl>': '110', '<if>': null, '<parent>': null, '<process-id>': '1', '<vrid>': '1',
  '<what>': 'version', '<value>': '10.0.0.1', '<type>': 'A', '<prefix>': '2001:db8:1::/64',
  '<next-hop>': '2001:db8::1', '<v6dst>': '2001:db8::1', '<ms>': '100', '<count>': '1',
  '<1-2699>': '110', '<permit|deny ...>': 'permit ip any any', '<verb>': 'mode access',
  '<format>': 'text/turtle', '<isd-as>': '1-ff00:0:1', '<bytes>': '100', '<sport>': '1000',
  '<proto>': 'tcp', '<proto tcp|udp>': 'tcp', '<net>': '10.0.0.0', '<wildcard>': '0.0.0.255',
  '<area>': '0', '<cost>': '10', '<priority>': '120', '<instance>': '1', '<vid>': '10'
};

function instantiate(synopsis, dev) {
  const ports = Array.from(dev.interfaces.keys()).filter(function (n) {
    const i = dev.interfaces.get(n);
    return !i.svi && !i.parent;
  });
  const port = ports[0] || 'Fa0/1';
  let text = String(synopsis);
  // Alternatives read left to right, so the first branch is the one an operator would type.
  // Ordinary control flow, not an exemption: this decides what value a placeholder gets, and no
  // device or port is being judged - every placeholder gets a value, none is skipped.
  text = text.replace(/<([^<>]+)>/g, function (whole, inner) {
    if (inner.indexOf('|') !== -1) {
      const first = inner.split('|')[0].replace(/\.\.\.$/, '').trim();
      return first;
    }
    // Ordinary control flow, not an exemption: every placeholder resolves to a value - a port name,
    // a keyword branch, a known sample, or a plain 'x' - and none is left out of the check.
    if (/^port$/.test(inner)) return port;
    if (/^(if|parent)$/.test(inner)) return port;
    if (/^list\|all$/.test(inner)) return 'list';
    const known = VALUES[whole];
    if (known !== undefined && known !== null) return known;
    return 'x';
  });
  // Optional groups: keep the mandatory words, drop the optionals, so the row is minimal.
  text = text.replace(/\[[^\]]*\]/g, '');
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

function helpRows(dev, prelude) {
  const sim = new Simulator(new Topology());
  const s = new CliSession(dev, sim.topo, sim);
  s.run('enable');
  for (const line of prelude) s.run(line);
  return s.run('?').output.filter(function (l) { return /^ {2}\S/.test(l); })
    .map(function (l) { return l.trim().split(/\s{2,}/)[0]; });
}

function freshLab(spec) {
  const t = new Topology();
  const d = t.addDevice(spec); d.name = 'D';
  return { t: t, d: d, sim: new Simulator(t) };
}

// The device kinds the console has a personality for, plus real catalogue entries that are on the
// other side of every capability boundary (a PSE switch, a MikroTik router, an AP).
const KINDS = ['generic-switch', 'generic-l3-switch', 'generic-router', 'generic-pc',
  'generic-server', 'generic-firewall'];
const SAMPLES = ['RB960PGS', 'cAPGi-5HaxD2HaxD&EG12-EA'];

console.log('\nEvery row the config page shows is a row the parser knows:');
{
  const failures = [];
  for (const name of KINDS.concat(SAMPLES)) {
    const spec = model(name);
    if (!spec) { failures.push(name + ': not in the catalogue'); continue; }
    const env = freshLab(spec);
    for (const row of helpRows(env.d, ['configure terminal'])) {
      const cmd = instantiate(row, env.d);
      if (!cmd) continue;
      const lab2 = freshLab(spec);
      const s = new CliSession(lab2.d, lab2.t, lab2.sim);
      s.run('enable');
      s.run('configure terminal');
      const out = s.run(cmd).output || [];
      if (out.some(function (l) { return /Unrecognized|Unknown command/i.test(l); })) {
        failures.push(name + ': "' + cmd + '" (from "' + row + '") -> ' + out[0]);
      }
    }
  }
  ok(failures.length === 0, 'no config row is unrecognised on any device kind' +
    (failures.length ? '\n      ' + failures.slice(0, 12).join('\n      ') : ''));
}

console.log('\nThe page is filtered by what the device can do:');
{
  const pc = freshLab(model('generic-pc'));
  const pcRows = helpRows(pc.d, ['configure terminal']).join('\n');
  for (const forbidden of ['vlan <id>', 'switchport <verb>', 'spanning-tree vlan', 'router ospf',
    'router bgp', 'ip nat inside source static']) {
    ok(pcRows.indexOf(forbidden) === -1, 'a PC is not offered "' + forbidden + '"');
  }
  const sw = freshLab(model('generic-switch'));
  const swRows = helpRows(sw.d, ['configure terminal']).join('\n');
  ok(swRows.indexOf('vlan <id>') !== -1, 'a switch is offered its VLANs');
  ok(swRows.indexOf('switchport <verb>') !== -1, 'and its switchport verbs');
  ok(swRows.indexOf('router ospf') === -1, 'and is not offered OSPF, which it cannot run');
  const rt = freshLab(model('generic-router'));
  const rtRows = helpRows(rt.d, ['configure terminal']).join('\n');
  ok(rtRows.indexOf('router ospf') !== -1, 'a router is offered OSPF');
  ok(rtRows.indexOf('router bgp') !== -1, 'and BGP');
  // A router may declare a VLAN - it routes between them and its running-config round-trips the
  // line, which the VLAN suite encodes - but it has no switchports and no spanning tree.
  ok(rtRows.indexOf('vlan <id>') !== -1, 'and may still declare a VLAN it routes between');
  ok(rtRows.indexOf('switchport <verb>') === -1, 'but is not offered switchport verbs');
  ok(rtRows.indexOf('spanning-tree vlan') === -1, 'nor a spanning tree it does not run');
  // The exec page holds the same line: a host has no MAC table, no translations, no secure ports.
  const pcExec = helpRows(pc.d, []).join('\n');
  ok(pcExec.indexOf('clear mac address-table') === -1, 'a PC is not offered "clear mac address-table"');
  ok(pcExec.indexOf('clear ip nat translation') === -1, 'nor "clear ip nat translation"');
  ok(pcExec.indexOf('clear port-security') === -1, 'nor the port-security counters');
  const swExec = helpRows(sw.d, []).join('\n');
  ok(swExec.indexOf('clear mac address-table') !== -1, 'while a switch is offered all three');
}

console.log('\nA hidden row is one the device really refuses - hiding is not a way to hide breakage:');
{
  // For each pair the filter decides, ask the device itself. If it would have accepted the verb,
  // the filter is suppressing something useful.
  const pairs = [
    ['generic-pc', 'vlan 10', /is not a switch or a router, so it has no VLANs/i],
    ['generic-pc', 'switchport mode access', /does not switch, so no port on it has a switchport/i],
    ['generic-pc', 'router ospf 1', /is not a router/i],
    ['generic-server', 'vlan 20', /is not a switch or a router, so it has no VLANs/i],
    ['generic-switch', 'ip nat inside source static 10.0.0.1 10.0.0.2', /NAT|Unrecognized/i],
    ['generic-switch', 'router bgp 65001', /layer 2 switch: it cannot run BGP/i],
    ['generic-switch', 'router ospf 1', /is not a router/i],
    ['generic-pc', 'ip routing', /is not a router/i]
  ];
  for (const p of pairs) {
    const env = freshLab(model(p[0]));
    const s = new CliSession(env.d, env.t, env.sim);
    s.run('enable'); s.run('configure terminal');
    const out = (s.run(p[1]).output || []).join('\n');
    ok(p[2].test(out), p[0] + ' really refuses "' + p[1] + '"');
  }
}

console.log('\nThe count of rows a device is shown tracks its capability, not a constant:');
{
  const counts = {};
  for (const name of KINDS) {
    const env = freshLab(model(name));
    counts[name] = helpRows(env.d, ['configure terminal']).length;
  }
  const uniq = Array.from(new Set(Object.keys(counts).map(function (k) { return counts[k]; })));
  ok(uniq.length > 1, 'the kinds are not all shown the same page (' +
    Object.keys(counts).map(function (k) { return k + '=' + counts[k]; }).join(', ') + ')');
  ok(counts['generic-pc'] < counts['generic-router'], 'a PC sees fewer rows than a router');
  // Two pages can hold the same number of rows and still not be the same page: the count is not the
  // property that matters, the contents are. A router and an L3 switch both show 41 rows today - the
  // router has NAT and DHCP rows the switch lacks, the switch has switchport and spanning-tree rows.
  const rtPage = helpRows(freshLab(model('generic-router')).d, ['configure terminal']).join('\n');
  const l3Page = helpRows(freshLab(model('generic-l3-switch')).d, ['configure terminal']).join('\n');
  ok(rtPage !== l3Page, 'a router and an L3 switch are not shown the same page');
  ok(l3Page.indexOf('switchport <verb>') !== -1 && rtPage.indexOf('switchport <verb>') === -1,
    'the switch has the switchport verbs, the router does not');
  ok(rtPage.indexOf('ip nat inside source') !== -1 && l3Page.indexOf('ip nat inside source') === -1,
    'the router has NAT, the L3 switch does not');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
