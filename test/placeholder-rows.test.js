'use strict';
// placeholder-rows.test.js - a documented row, filled in, is a command the console takes.
//
// The abbreviation sweep types every *keyword-only* row. This one types the rows that have a value in
// them - the ones an operator actually reads the help page for - by filling each placeholder from a
// table of values and requiring the answer not to be a typo:
//
//   config#ipv6 nd prefix ?
//     Next: <prefix>          <- two slots offered ...
//   config#ipv6 nd prefix ?
//     Next: <len>             <- ... for a command that takes one value
//
// `ipv6 nd prefix <prefix>/<len>` was lexed with the `/` rule that means "alias": the row became *two*
// rows, one placing `<prefix>` and one placing `<len>`, and nothing was refused for it - the page
// quietly offered a choice the command does not have. `ipv6 address <addr>/<len>` duplicated the same
// way. A `/` joining two placeholders is part of one value (`10.0.0.0/24` is one word).
//
// One row had a value as its *first* token: `clear ip dhcp binding * | <address>` parsed into a
// phantom row that was nothing but `<address>`, so the page offered a value slot where a verb goes and
// no abbreviation or completion could reach it.
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

const PREP = ['interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
  'vlan 10 name lab', 'router ospf 1', 'network 10.0.0.0 0.0.0.255 area 0', 'exit',
  'router bgp 65001', 'neighbor 10.0.0.2 remote-as 65002', 'exit',
  'ip access-list extended TEST', 'permit ip any any', 'exit',
  'ip dhcp pool LAN', 'network 10.9.0.0 255.255.255.0', 'exit'];

function session(model, enter) {
  const t = new Topology();
  const d = t.addDevice(find(model)); d.name = 'D1';
  const s = new CliSession(d, t, new Simulator(t));
  s.run('enable');
  if (model === 'generic-router') PREP.forEach(function (l) { s.run(l); });
  (enter || []).forEach(function (l) { s.run(l); });
  return s;
}

// Values by the name the row gives the slot. Two tables, because `ipv6 address <addr>` is not
// `ip address <addr>` - an IPv4 address in an IPv6 slot is a refusal, and would read as a defect.
const V4 = {
  addr: '10.0.0.1', address: '10.0.0.1', ip: '10.0.0.1', dest: '10.9.0.0/24', dst: '10.0.0.2',
  src: '10.0.0.1', net: '10.9.0.0', mask: '255.255.255.0', wildcard: '0.0.0.255',
  gateway: '10.0.0.1', peer: '10.0.0.2', 'next-hop': '10.0.0.2', low: '10.9.0.1', high: '10.9.0.5',
  start: '10.9.0.1', end: '10.9.0.9', server: '10.0.0.53', host: 'host1.lab', p: '100',
  priority: '100', s: '60', sec: '60', ms: '100', n: '10', num: '10', count: '10', len: '24',
  prefix: '10.9.0.0/24', id: '10', vrid: '1', group: '1', vid: '10', vlan: '10', as: '65001',
  pid: '1', acl: '10', name: 'lab', text: 'lab', string: 'lab', domain: 'lab.example',
  hostname: 'host1', mac: '00:11:22:33:44:55', port: 'Gi0/0', iface: 'Gi0/0', interface: 'Gi0/0',
  proto: 'tcp', protocol: 'ip', speed: '100', size: '100', mss: '1460', w: '200', l: '100',
  entry: 'permit ip any any', list: '10,20', tag: '10', value: '1', x: '1', unit: 's', param: 'x',
  // The names a row uses for a number-inside-a-range or a description of a thing, not a value.
  days: '1', gw: '10.0.0.1', local: '10.0.0.1', mbps: '1000', 'process-id': '1', sequence: '10',
  type: 'access', verb: 'inside', what: 'version', dest: '10.9.0.0/24', v6dst: '2001:db8:9::2',
  'isd-as': '1-ff00:0:110', 'inside-local': '10.0.0.1', 'addr...': '10.0.0.1', any: 'any', global: '1',
  parent: 'Gi0/0', if: 'Gi0/0', end: '10.9.0.9', 'list|all': 'all', 'config-mode command': 'hostname lab',
};
const V6 = {
  addr: '2001:db8:9::1', address: '2001:db8:9::1', ip: '2001:db8:9::1', gateway: '2001:db8:9::1',
  dest: '2001:db8:9::/64', dst: '2001:db8:9::2', src: '2001:db8:9::1', net: '2001:db8:9::',
  'next-hop': '2001:db8:9::2', prefix: '2001:db8:9::/64', server: '2001:db8:9::53',
  'prefix/len': '2001:db8:9::/64', 'addr/len': '2001:db8:9::1/64', v6dst: '2001:db8:9::2',
};
const fillRow = function (tokens, isV6, rowText) {
  const table = isV6 ? Object.assign({}, V4, V6) : V4;
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (typeof t === 'string') { out.push(t); continue; }
    const key = String(t.placeholder || '').toLowerCase();
    let v = table[key];
    // A bridge priority is not a VRRP priority: `spanning-tree vlan 10 priority 10` is refused because
    // the value must be a multiple of 4096, and the refusal is right. The row is filled with a value
    // its own command accepts, so a correct refusal is not counted as a defect.
    // A bridge priority is not a VRRP priority: `spanning-tree vlan 10 priority 10` is refused because
    // the value must be a multiple of 4096, and that refusal is right. The row is filled with a value
    // its own command accepts, so a correct refusal is not counted as a defect.
    if ((key === 'priority' || key === 'n') && /spanning-tree[^|]*priority/.test(String(rowText || ''))) v = '4096';
    // A slot named for its own range (`<0-512>`, `<1-2699>`) wants a number in that range, and the
    // low bound is always one.
    if (v === undefined && /^\d+-\d+$/.test(key)) v = key.split('-')[0];
    // A slot that packs two things (`<1-2699,entry>`) takes both in order.
    if (v === undefined && /^\d+-\d+,/.test(key)) {
      const tail = table[key.slice(key.indexOf(',') + 1)];
      if (tail !== undefined) v = key.slice(0, key.indexOf(',')) + ' ' + tail;
    }
    if (v === undefined) return null;
    out.push(v);
  }
  return out;
};

const MODES = [
  ['exec', 'generic-router', []],
  ['config', 'generic-router', ['configure terminal']],
  ['interface', 'generic-switch', ['configure terminal', 'interface Fa0/1']],
  ['router-if', 'generic-router', ['configure terminal', 'interface Gi0/1']],
  ['ospf', 'generic-router', ['configure terminal', 'router ospf 1']],
  ['bgp', 'generic-router', ['configure terminal', 'router bgp 65001']],
  ['acl', 'generic-router', ['configure terminal', 'ip access-list extended TEST']],
  ['dhcp', 'generic-router', ['configure terminal', 'ip dhcp pool LAN']],
];

console.log('No row offers a value where a verb goes:');
{
  const offenders = [];
  let rows = 0;
  for (const [label, model, enter] of MODES) {
    const probe = session(model, enter);
    for (const f of (probe._helpFormRowsAll(probe.mode) || [])) {
      const toks = f.tokens || [];
      if (!toks.length) continue;
      rows += 1;
      if (typeof toks[0] !== 'string') offenders.push(label + ': <' + toks[0].placeholder + '>');
    }
  }
  ok(rows > 300, 'the rows were read (' + rows + ')');
  ok(offenders.length === 0, 'every row starts with a word'
    + (offenders.length ? ': ' + offenders.slice(0, 3).join('; ') : ''));
}

console.log('\nA `/` between two placeholders is one value, not a choice:');
{
  const s = session('generic-router', ['configure terminal']);
  const one = text(s.run('ipv6 nd prefix ?'));
  ok(/<prefix\/len>/.test(one), 'the page offers one slot: <prefix/len>');
  ok(!/<prefix>\s*\n?\s*<len>/.test(one), 'not two slots for one value');
  const rows = (s._helpFormRowsAll(s.mode) || [])
    .filter(function (f) { return /ipv6 nd prefix/.test(String(f.synopsis || '')); })
    .map(function (f) { return (f.tokens || []).map(function (t) { return typeof t === 'string' ? t : '<' + t.placeholder + '>'; }).join(' '); });
  ok(rows.length === 4, 'four optional-group spellings, not eight (' + rows.length + ')');
  ok(rows.every(function (r) { return r.indexOf('<prefix/len>') !== -1; }), 'each keeps the one value slot');
  const typed = text(s.run('ipv6 nd prefix 2001:db8:9::/64 valid 60'));
  ok(/IPv6 ND prefix 2001:db8:9::\/64/.test(typed), 'and the documented form runs');
  const addr = text(session('generic-switch', ['configure terminal', 'interface Fa0/1'])
    .run('ipv6 address 2001:db8:9::10/64'));
  ok(/2001:db8:9::10\/64/.test(addr), '`ipv6 address <addr>/<len>` is one value too');
}

console.log('\nEvery row, filled in, is a command the console takes:');
{
  const bad = [], unknown = [];
  let tried = 0;
  for (const [label, model, enter] of MODES) {
    const probe = session(model, enter);
    for (const f of (probe._helpFormRowsAll(probe.mode) || [])) {
      const toks = f.tokens || [];
      if (!toks.length) continue;
      if (!toks.some(function (t) { return typeof t !== 'string'; })) continue;  // keyword-only rows: the other sweep
      const isV6 = toks.some(function (t) { return typeof t === 'string' && /ipv6/i.test(t); }) ||
        /ipv6/i.test(String(f.synopsis || ''));
      const filled = fillRow(toks, isV6, (toks.filter(function (t) { return typeof t === 'string'; }).join(' ') + ' ' +
        String(f.synopsis || '')));
      if (!filled) { unknown.push(toks.filter(function (t) { return typeof t !== 'string'; }).map(function (t) { return t.placeholder; }).join(',') ); continue; }
      const line = filled.join(' ');
      // Not an exemption, ordinary control flow: navigation verbs leave the mode the row was read in,
      // and `do` wraps another command whose arguments are judged where they belong.
      if (/^(exit|end|do|help|\?)\b/.test(line)) continue;
      tried += 1;
      const answer = text(session(model, enter).run(line));
      if (/%\s*(Unrecognized|Invalid|Incomplete)/.test(answer)) {
        bad.push(label + ": '" + line + "' -> " + answer.split('\n')[0]);
      }
    }
  }
  ok(tried > 300, 'the sweep ran (' + tried + ' filled rows across ' + MODES.length + ' modes)');
  ok(unknown.length === 0, 'every value slot had a value in the table (' + unknown.length + ' unknown'
    + (unknown.length ? ': ' + unknown.slice(0, 5).join(' ') : '') + ')');
  ok(bad.length === 0, 'no documented row is refused once its values are filled in'
    + (bad.length ? ': ' + bad.slice(0, 4).join('; ') : ''));
}

console.log('\nEvery device in the catalogue is shown rows its own handlers take:');
{
  // The pages are capability-gated per device, so a page is a promise made by *that* device: a row put
  // in front of a camera or an AP has to be a command the camera or the AP implements. One device per
  // catalogue category, every mode, every row filled in.
  const seen = {};
  for (const d of catalog) {
    const kind = d.category || d.kind || '?';
    if (!seen[kind]) seen[kind] = d;
  }
  const kinds = Object.keys(seen).sort();
  const bad = [];
  let tried = 0;
  for (const kind of kinds) {
    const dev = seen[kind];
    const topo = new Topology();
    const d = topo.addDevice(dev); d.name = 'D1';
    const ports = Array.from(d.interfaces.values()).filter(function (i) { return !/vlan|lo|tunnel|mgmt/i.test(i.name || ''); });
    const ifn = ports.length ? ports[0].name : 'Fa0/1';
    const modes = [['exec', []], ['config', ['configure terminal']], ['interface', ['configure terminal', 'interface ' + ifn]]];
    for (const [label, enter] of modes) {
      const probe = new CliSession(d, topo, new Simulator(topo));
      probe.run('enable');
      enter.forEach(function (l) { probe.run(l); });
      for (const f of (probe._helpFormRows(probe.mode) || [])) {
        const toks = f.tokens || [];
        if (!toks.length || !toks.some(function (t) { return typeof t !== 'string'; })) continue;
        const isV6 = toks.some(function (t) { return typeof t === 'string' && /ipv6/i.test(t); }) ||
          /ipv6/i.test(String(f.synopsis || ''));
        const filled = fillRow(toks, isV6, toks.filter(function (t) { return typeof t === 'string'; }).join(' ') + ' ' + String(f.synopsis || ''));
        if (!filled) continue;
        const line = filled.join(' ');
        // Not an exemption, ordinary control flow: navigation verbs leave the mode the row was read in,
        // and `do` wraps another command whose arguments are judged where they belong.
        if (/^(exit|end|do|help|\?)\b/.test(line)) continue;
        const s = new CliSession(d, topo, new Simulator(topo));
        s.run('enable');
        enter.forEach(function (l) { s.run(l); });
        tried += 1;
        const answer = text(s.run(line));
        if (/%\s*(Unrecognized|Invalid)/.test(answer)) {
          bad.push(kind + ' (' + dev.model + ') [' + label + "]: '" + line + "' -> " + answer.split('\n')[0]);
        }
      }
    }
  }
  ok(kinds.length >= 20, 'one device swept per catalogue category (' + kinds.length + ': ' + kinds.slice(0, 8).join(', ') + ', ...)');
  ok(tried > 3000, 'the sweep ran (' + tried + ' filled rows)');
  ok(bad.length === 0, 'no device is shown a row its handlers do not take'
    + (bad.length ? ': ' + bad.slice(0, 4).join('; ') : ''));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
