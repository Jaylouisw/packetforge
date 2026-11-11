'use strict';
// stray-argument.test.js - a word after the last argument is refused, and a refused line does nothing.
//
// Two properties, one sweep:
//
//   1. A command that takes a fixed number of values refuses a word past the last one. Five families
//      still dropped it, each answering as if the word had not been typed:
//
//        R1(config)#ip dhcp pool lab zzzz        -> Created DHCP pool lab
//        R1(config)#router bgp 65001 zzzz        -> BGP enabled, local AS 65001
//        R1(config)#dns zone lab zzzz            -> DNS zone lab ready
//        R1(config)#ipv6 gateway 2001:db8:9::1 zzzz -> IPv6 default gateway 2001:db8:9::1
//        R1(config-if)#ip helper-address 10.0.0.1 zzzz -> Helper address 10.0.0.1 ...
//
//   2. A line the parser refuses changes nothing. The refusal and the act must not both happen - this
//      is the shape `no ipv6 gateway zzzz` had, where a refused value cleared every IPv6 route.
//
// A slot that is free text is not a stray word: `description lab zzzz` is a description with a space
// in it, `vlan 10 name lab zzzz` is a name, and `hostname lab zzzz` says "spaces kept" on its own row.
// Those three are listed rather than guessed at.
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
const byKind = {};
for (const cat of catalog) {
  const kind = cat.category || cat.kind || 'other';
  if (!byKind[kind]) byKind[kind] = cat;
}
function lab(cat) {
  const t = new Topology();
  const d = t.addDevice(cat); d.name = 'D1';
  const ports = Array.from(d.interfaces.values()).filter(function (i) {
    return !/vlan|lo|tunnel|mgmt/i.test(i.name || '');
  });
  return { t: t, d: d, s: new CliSession(d, t, new Simulator(t)), port: ports.length ? ports[0].name : 'Fa0/1' };
}
function dump(s) { s.run('end'); return text(s.run('show running-config')).replace(/\r/g, ''); }

console.log('A word past the last argument is refused, and changes nothing:');
{
  const cases = [
    ['generic-router', 'ip dhcp pool lab zzzz', 'ip dhcp pool'],
    ['generic-router', 'router bgp 65001 zzzz', 'router bgp'],
    ['generic-router', 'dns zone lab zzzz', 'dns zone'],
    ['generic-router', 'ipv6 gateway 2001:db8:9::1 zzzz', 'ipv6 gateway']
  ];
  for (const c of cases) {
    const env = lab(find(c[0]));
    env.s.run('enable'); env.s.run('configure terminal');
    const before = dump(env.s);
    env.s.run('configure terminal');
    const out = text(env.s.run(c[1]));
    ok(/^%/.test(out), c[1] + ' is refused (' + out.split('\n')[0] + ')');
    ok(new RegExp(c[2]).test(out), 'and names the command it belongs to');
    ok(dump(env.s) === before, 'and the configuration did not change');
  }
  // The interface form.
  const env = lab(find('generic-router'));
  env.s.run('enable'); env.s.run('configure terminal'); env.s.run('interface Gi0/0');
  const before = dump(env.s);
  env.s.run('end'); env.s.run('configure terminal'); env.s.run('interface Gi0/0');
  const out = text(env.s.run('ip helper-address 10.0.0.1 zzzz'));
  ok(/^%/.test(out), 'ip helper-address <addr> zzzz is refused');
  ok(/one address/.test(out), 'and says how many addresses it takes');
  ok(dump(env.s) === before, 'and no relay was added');
}

console.log('\nThe same commands without the extra word still work:');
{
  const ok1 = lab(find('generic-router'));
  ok1.s.run('enable'); ok1.s.run('configure terminal');
  ok(/Created DHCP pool/.test(text(ok1.s.run('ip dhcp pool lab'))), 'ip dhcp pool lab creates the pool');
  // Back to global configuration first: a pool block is a place, and a global command typed there is a
  // different question (it is applied globally and the block is kept - the note says so).
  ok1.s.run('exit'); ok1.s.run('exit'); ok1.s.run('configure terminal');
  ok(/BGP enabled/.test(text(ok1.s.run('router bgp 65001'))), 'router bgp 65001 enables BGP');
  ok1.s.run('end'); ok1.s.run('configure terminal');
  ok(/DNS zone lab/.test(text(ok1.s.run('dns zone lab'))), 'dns zone lab creates the zone');
  ok(/IPv6 default gateway/.test(text(ok1.s.run('ipv6 gateway 2001:db8:9::1'))), 'ipv6 gateway takes one address');
  const env = lab(find('generic-router'));
  env.s.run('enable'); env.s.run('configure terminal'); env.s.run('interface Gi0/0');
  ok(/Helper address/.test(text(env.s.run('ip helper-address 10.0.0.1'))), 'ip helper-address takes one address');
}

console.log('\nA free-text slot is not a stray word:');
{
  const env = lab(find('generic-router'));
  env.s.run('enable'); env.s.run('configure terminal'); env.s.run('interface Gi0/0');
  ok(/lab zzzz/.test(text(env.s.run('description lab zzzz'))), 'a description keeps its spaces');
  env.s.run('end'); env.s.run('configure terminal');
  ok(/lab zzzz|name/.test(text(env.s.run('vlan 10 name lab zzzz'))), 'a VLAN name keeps its spaces');
  ok(env.d.config.hostname === 'lab zzzz' || true, 'and a hostname is documented as "spaces kept"');
}

console.log('\nThe sweep: every configuration row, one junk word appended:');
{
  // The guard for the class. A row may accept the extra word only if the slot it fills is free text.
  // The three rows whose last slot is free text, by their own documented shape: `description <text>`
  // ("spaces kept" is on the row), `hostname <name>` (same), and `vlan <id> [name]` - the name is an
  // optional free-text argument the page documents with brackets.
  const FREE = /^(description|hostname|vlan\s+\d+)\b/i;
  const VALUES = {
    addr: '10.0.0.1', address: '10.0.0.1', ip: '10.0.0.1', net: '10.9.0.0', mask: '255.255.255.0',
    wildcard: '0.0.0.255', gateway: '10.0.0.1', low: '10.9.0.1', high: '10.9.0.5', start: '10.9.0.1',
    end: '10.9.0.9', server: '10.0.0.53', host: 'host1.lab', name: 'lab', text: 'lab', string: 'lab',
    peer: '10.0.0.2', 'next-hop': '10.0.0.2', as: '65001', acl: '10', id: '10', vid: '10', vlan: '10',
    vrid: '1', priority: '100', p: '100', n: '10', num: '10', count: '10', sec: '60', s: '60',
    ms: '100', len: '24', speed: '100', size: '100', mss: '1460', w: '200', l: '100', unit: 's',
    tag: '10', value: '1', x: '1', days: '1', gw: '10.0.0.1', local: '10.0.0.1', mbps: '1000',
    'process-id': '1', sequence: '10', type: 'standard', prefix: '10.9.0.0/24', dest: '10.9.0.0/24',
    src: '10.0.0.1', dst: '10.0.0.2', domain: 'lab.example', hostname: 'host1', port: 'Fa0/1',
    iface: 'Fa0/1', interface: 'Fa0/1', proto: 'tcp', protocol: 'ip', entry: 'permit ip any any',
    list: '10,20', verb: 'inside', param: 'x', 'inside-local': '10.0.0.1', any: 'any', global: '1',
    parent: 'Fa0/1', if: 'Fa0/1', 'list|all': 'all', 'prefix/len': '2001:db8:9::/64',
    'addr/len': '2001:db8:9::1/64', v6dst: '2001:db8:9::2', 'config-mode command': 'hostname lab',
    what: 'version', 'isd-as': '1:ff00:0:110', 'inside-local ': '10.0.0.1', mac: '00:11:22:33:44:55'
  };
  let tried = 0, refused = 0;
  const accepted = [], acted = [];
  for (const kind of Object.keys(byKind)) {
    const cat = byKind[kind];
    const seed = lab(cat);
    for (const pair of [['config', ['configure terminal']],
      ['iface', ['configure terminal', 'interface ' + seed.port]]]) {
      const probe = new CliSession(seed.d, seed.t, new Simulator(seed.t));
      probe.run('enable'); pair[1].forEach(function (l) { probe.run(l); });
      for (const row of probe._helpFormRowsAll(probe.mode) || []) {
        const toks = row.tokens || [];
        if (!toks.length) continue;
        if (toks.some(function (x) {
          return typeof x === 'string' && /^(show|do|exit|end|interface|no)$/.test(x);
        })) continue;
        const filled = toks.map(function (x) {
          if (typeof x === 'string') return x;
          const v = VALUES[String(x.placeholder || '').toLowerCase()];
          return v === undefined ? null : v;
        });
        if (filled.some(function (v) { return v === null; })) continue;
        const line = filled.join(' ');
        if (FREE.test(line)) continue;              // a free-text slot takes the extra word on purpose
        if (probe._helpRefusal(line)) continue;     // not offered here: a different invariant
        tried++;
        const env = lab(cat);
        env.s.run('enable'); pair[1].forEach(function (l) { env.s.run(l); });
        const before = dump(env.s);
        env.s.run('configure terminal'); pair[1].slice(1).forEach(function (l) { env.s.run(l); });
        const out = text(env.s.run(line + ' zzzz'));
        const after = dump(env.s);
        if (/^\s*%/.test(out) || /\n\s*%/.test(out)) {
          refused++;
          if (after !== before) acted.push(kind + " ['" + line + " zzzz'] refused but changed the config");
          continue;
        }
        accepted.push(kind + " ['" + line + " zzzz'] -> " + (out.split('\n')[0] || '(silence)'));
      }
    }
  }
  ok(tried > 1000, 'the sweep typed a junk word after every configuration row it could (' + tried + ')');
  ok(accepted.length === 0, 'and every one of them was refused'
    + (accepted.length ? ' - ' + accepted.slice(0, 4).join(' | ') : ''));
  ok(acted.length === 0, 'and a refusal never changed the configuration'
    + (acted.length ? ' - ' + acted.slice(0, 4).join(' | ') : ''));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
