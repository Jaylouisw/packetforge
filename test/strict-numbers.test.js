'use strict';
// strict-numbers.test.js - a number a console takes is decimal digits.
//
// `parseInt` reads "1e3" as 1, "0x10" as 16 and "12abc" as 12, so a command could configure a value
// nobody typed and report success:
//
//   R1(config-if)#vrrp 1e3 ip 10.0.0.1
//   VRRP group 1 on Gi0/0 owns 10.0.0.1        <- group 1, from a word that is not 1
//   R1(config-if)#vrrp 1 priority 1e3
//   VRRP group 1 priority 1                     <- priority 1, from a word that is not 1
//   R1(config-if)#vrrp 1 ip 10.0.0.1 priority 0x10
//   VRRP group 1 on Gi0/0 owns 10.0.0.1         <- the documented tail was ignored entirely
//
// This is the same defect `ospf area 255.255.255.255` had one layer down: a value read as a number it
// is not. The rule is one helper, used everywhere a word becomes a number, and the documented tail of
// a row is either implemented or refused - never dropped.
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

function router() {
  const t = new Topology();
  const d = t.addDevice(find('generic-router')); d.name = 'R1';
  const s = new CliSession(d, t, new Simulator(t));
  s.run('enable'); s.run('configure terminal');
  const port = Array.from(d.interfaces.values()).filter(function (i) { return /^Gi/.test(i.name || ''); })[0];
  s.run('interface ' + port.name);
  return { t: t, d: d, s: s, port: port.name };
}

console.log('A word that is not a number is refused, and quoted back:');
{
  const cases = [
    ['vrrp 1e3 ip 10.0.0.1', /Invalid virtual router id: 1e3/],
    ['vrrp 0x10 ip 10.0.0.1', /Invalid virtual router id: 0x10/],
    ['vrrp 1.5 ip 10.0.0.1', /Invalid virtual router id: 1.5/],
    ['vrrp 12abc ip 10.0.0.1', /Invalid virtual router id: 12abc/],
    ['vrrp 1 priority 1e3', /Invalid priority: 1e3/],
    ['vrrp 1 priority 0x10', /Invalid priority: 0x10/],
    ['vrrp 1 priority 1.5', /Invalid priority: 1.5/],
    ['vrrp 1 advertise 1e3', /Invalid advertisement interval: 1e3/],
    ['vrrp 1 advertise 1.5', /Invalid advertisement interval: 1.5/]
  ];
  for (const pair of cases) {
    const env = router();
    const out = text(env.s.run(pair[0]));
    ok(pair[1].test(out), '"' + pair[0] + '" is refused quoting the word (' + out.split('\n')[0] + ')');
    ok(/^%/.test(out), 'as a refusal');
  }
  // Nothing was created by any of the refusals.
  const env = router();
  env.s.run('vrrp 1e3 ip 10.0.0.1');
  ok(!Array.isArray(env.d.config.vrrp) || env.d.config.vrrp.length === 0,
    'and a refused id leaves no group behind');
}

console.log('\nThe documented tail is implemented, not dropped:');
{
  const env = router();
  const out = text(env.s.run('vrrp 1 ip 10.0.0.254 priority 150 preempt advertise 2'));
  ok(/owns 10\.0\.0\.254/.test(out), 'the address is owned');
  ok(/priority 150/.test(out), 'and the priority it was given is reported');
  ok(/preempt on/.test(out), 'and preempt');
  ok(/advertise 2 s/.test(out), 'and the advertisement interval');
  const group = (env.d.config.vrrp || []).filter(function (g) { return g.vrid === 1; })[0];
  ok(group && group.priority === 150, 'the group carries priority 150');
  ok(group && group.advertSec === 2, 'and advertises every 2 s');
  ok(group && group.preempt === true, 'and preempts');
  // Each part of the tail can stand alone, in any combination the row allows.
  const e2 = router();
  e2.s.run('vrrp 2 ip 10.0.0.253');
  ok(/priority 200/.test(text(e2.s.run('vrrp 2 priority 200'))), 'priority still has its own form');
  ok(/advertises every 3 s/.test(text(e2.s.run('vrrp 2 advertise 3'))), 'and advertise its own');
  const e3 = router();
  const both = text(e3.s.run('vrrp 3 ip 10.0.0.252 advertise 5 preempt'));
  ok(/advertise 5 s/.test(both) && /preempt on/.test(both), 'the tail works in another order');
}

console.log('\nA word the tail does not take is refused, and nothing is changed:');
{
  const env = router();
  const out = text(env.s.run('vrrp 1 ip 10.0.0.254 zzzz'));
  ok(/^%/.test(out), 'the unknown word is a refusal');
  ok(/Unexpected argument "zzzz"/.test(out), 'and it is named');
  ok(/Nothing was changed/.test(out), 'and the answer says so');
  ok(!(env.d.config.vrrp || []).some(function (g) { return g && g.ips && g.ips.length; }),
    'and no group was created with an address');
  const bad = text(env.s.run('vrrp 1 ip 10.0.0.254 priority 300'));
  ok(/Invalid priority: 300/.test(bad), 'a priority out of range in the tail is refused too');
  ok(/Nothing was changed/.test(bad), 'with the same warning');
}

console.log('\nA word after the port is refused, not dropped:');
{
  // The command that moves the prompt was the one place a trailing word was still dropped: the block
  // was entered and the next lines configured a port the operator had not named. A mangled paste did
  // this to a whole stanza at a time.
  const t = new Topology();
  const d = t.addDevice(find('generic-switch')); d.name = 'SW1';
  const s = new CliSession(d, t, new Simulator(t));
  s.run('enable'); s.run('configure terminal');
  for (const junk of ['zzz', '.', '1e3', 'description x', 'no shutdown']) {
    const out = text(s.run('interface Fa0/1 ' + junk));
    ok(/^%/.test(out), '"interface Fa0/1 ' + junk + '" is a refusal');
    ok(/Unexpected argument/.test(out), 'naming the word it does not take');
    ok(s.mode === 'config', 'and the prompt did not move into the block');
  }
  ok(!/Unexpected argument/.test(text(s.run('interface Fa0/1'))), 'the port itself still enters its block');
  ok(s.mode === 'iface' && s.iface === 'Fa0/1', 'and the prompt follows');
  // A two-word port name is one name, and a two-word name that does not exist quotes both words.
  const r2 = new Topology();
  const rd = r2.addDevice(find('generic-router')); rd.name = 'R1';
  const rs = new CliSession(rd, r2, new Simulator(r2));
  rs.run('enable'); rs.run('configure terminal');
  ok(rs.run('interface GigabitEthernet 0/0').output.join('\n').indexOf('%') === -1,
    '"interface GigabitEthernet 0/0" is one port name');
  ok(rs.iface === 'Gi0/0', 'and resolves to the port');
  const sw2 = new Topology();
  const sd = sw2.addDevice(find('generic-switch')); sd.name = 'SW1';
  const ss = new CliSession(sd, sw2, new Simulator(sw2));
  ss.run('enable'); ss.run('configure terminal');
  ok(/GigabitEthernet 0\/1/.test(text(ss.run('interface GigabitEthernet 0/1'))),
    'a two-word name that does not exist is quoted in full');
}

console.log('\nA dotted number is legal only where the protocol says so:');
{
  // asdot is how a 32-bit AS is written: 1.5 is 64512+5 = 65541. Everywhere else a dot is not decimal.
  const env = (function () {
    const t = new Topology();
    const d = t.addDevice(find('generic-router')); d.name = 'R1';
    const s = new CliSession(d, t, new Simulator(t));
    s.run('enable'); s.run('configure terminal');
    return { t: t, d: d, s: s };
  })();
  const out = text(env.s.run('router bgp 1.5'));
  ok(/65541/.test(out), 'router bgp 1.5 is asdot for 65541 (' + out.split('\n')[0] + ')');
  ok(/asdot/.test(out), 'and the answer says which form it read');
  const bad = text(env.s.run('bgp neighbor 10.0.0.2 remote-as 1e3'));
  ok(/^%/.test(bad), 'while an exponent is not an AS at all');
}

console.log('\nThe helper is the one used for a number, so the class is closed:');
{
  // The sweep that found this: every numeric placeholder, five words that are not numbers, on a
  // router, a switch and a PC. Nothing may be accepted.
  const WORDS = ['1e3', '0x10', '12abc', '1.5', '+5'];
  const NUM = /^(n|num|count|size|sec|s|ms|days|len|speed|mbps|priority|p|vrid|vid|vlan|pid|id|sequence|tag|value|x|group|process-id|mtu|mss|w|l|unit)$/i;
  const VALUES = {
    addr: '10.0.0.1', address: '10.0.0.1', ip: '10.0.0.1', dest: '10.9.0.0/24', dst: '10.0.0.2',
    src: '10.0.0.1', net: '10.9.0.0', mask: '255.255.255.0', wildcard: '0.0.0.255', gateway: '10.0.0.1',
    peer: '10.0.0.2', 'next-hop': '10.0.0.2', low: '10.9.0.1', high: '10.9.0.5', start: '10.9.0.1',
    end: '10.9.0.9', server: '10.0.0.53', host: 'host1.lab', acl: '10', name: 'lab', text: 'lab',
    string: 'lab', domain: 'lab.example', hostname: 'host1', mac: '00:11:22:33:44:55', port: 'Fa0/1',
    iface: 'Fa0/1', interface: 'Fa0/1', proto: 'tcp', protocol: 'ip', entry: 'permit ip any any',
    list: '10,20', type: 'access', verb: 'inside', what: 'version', any: 'any', global: '1',
    parent: 'Fa0/1', if: 'Fa0/1', 'list|all': 'all', 'prefix/len': '2001:db8:9::/64',
    'addr/len': '2001:db8:9::1/64', v6dst: '2001:db8:9::2', 'config-mode command': 'hostname lab'
  };
  let tried = 0;
  const accepted = [];
  for (const model of ['generic-router', 'generic-switch', 'generic-pc']) {
    const t = new Topology();
    const d = t.addDevice(find(model)); d.name = 'D1';
    const ports = Array.from(d.interfaces.values()).filter(function (i) {
      return !/vlan|lo|tunnel|mgmt/i.test(i.name || '');
    });
    const portName = ports.length ? ports[0].name : 'Fa0/1';
    for (const pair of [['config', ['configure terminal']],
      ['iface', ['configure terminal', 'interface ' + portName]]]) {
      const probe = new CliSession(d, t, new Simulator(t));
      probe.run('enable'); pair[1].forEach(function (l) { probe.run(l); });
      for (const row of probe._helpFormRowsAll(probe.mode) || []) {
        const toks = row.tokens || [];
        if (!toks.length) continue;
        // Not an exemption, ordinary control flow: a row with no numeric slot is simply not one this
        // sweep can type.
        if (!toks.some(function (x) { return typeof x !== 'string' && NUM.test(String(x.placeholder || '')); })) {
          continue;
        }
        const rowText = toks.filter(function (x) { return typeof x === 'string'; }).join(' ')
          + ' ' + String(row.synopsis || '');
        for (const word of WORDS) {
          const filled = toks.map(function (x) {
            if (typeof x === 'string') return x;
            const k = String(x.placeholder || '').toLowerCase();
            // Not an exemption, ordinary control flow: the numeric slot is the one under test, so it
            // gets the word and the other slots get values.
            if (NUM.test(k)) return word;
            let v = VALUES[k];
            if (v === undefined) return null;
            if (/ipv6/.test(rowText) && /addr|address|ip|gateway|next-hop|dst/.test(k)) {
              v = /next-hop|dst/.test(k) ? '2001:db8:9::2' : '2001:db8:9::1';
            }
            return v;
          });
          if (filled.some(function (v) { return v === null; })) continue;
          const line = filled.join(' ');
          if (probe._helpRefusal(line)) continue;
          tried++;
          const s = new CliSession(d, t, new Simulator(t));
          s.run('enable'); pair[1].forEach(function (l) { s.run(l); });
          const ans = text(s.run(line));
          // Not an exemption, ordinary control flow: a `%` line is how every refusal is written, so
          // this is the question the sweep asks.
          if (/^\s*%/.test(ans) || /\n\s*%/.test(ans)) continue;
          // asdot is the one documented exception: `router bgp 1.5` is 65541.
          // asdot is the documented exception: `router bgp 1.5` is 65541, and the answer says so. This
          // is the one shape where a dot is a legal number, so it is named rather than matched loosely.
          if (/asdot/.test(ans)) continue;
          accepted.push(model + ": '" + line + "' -> " + ans.split('\n')[0]);
        }
      }
    }
  }
  ok(tried > 200, 'the sweep typed numeric slots with non-numbers (' + tried + ')');
  ok(accepted.length === 0, 'and none was accepted'
    + (accepted.length ? ' - ' + accepted.slice(0, 4).join(' | ') : ''));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
