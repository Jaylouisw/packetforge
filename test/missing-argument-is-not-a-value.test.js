'use strict';
// A short line is not a wrong value (#1497).
//
// Fifteen commands were asked what they do with no argument at all. Two answered by doing something:
//
//   hostname     cleared the device's name to null and printed nothing. The only way to find out was to look at a
//                surface that shows the name - and `hostname` is the command that sets it;
//   description  cleared the port's description and answered "Description set", a change it did not name.
//
// Three more answered a question nobody had asked, in the same shape as #1495: `ip name-server`, `ipv6 address` and
// `vrrp 1 ip` all reported the *empty string* as an invalid value - `% Invalid name server "": not an IPv4 address`
// - so a half-typed line read as a bad value rather than a short one.
//
// Two more measurements came out of the same pass and are pinned here rather than fixed, because both are correct
// already and neither was ever written down:
//
//   * whitespace: a command means the same thing with double spaces, tabs, a leading space or a trailing space.
//     108 variant runs, 0 differences. Labs are pasted, so this is a property worth holding on to;
//   * the wrong mode: a global command typed at an interface prompt is applied in global config, deliberately, so a
//     pasted running-config block works without `exit` lines between blocks (#1230). It is leniency by design; what
//     it costs is that the answer does not say where the configuration landed.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const cli = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
function section(name) { console.log('\n' + name); }

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const spec = function (m) { return catalog.find(function (x) { return x.model === m; }); };
const TAB = String.fromCharCode(9);

function env() {
  const t = new Topology();
  const r = t.addDevice(spec('ISR 4331'), 'r1');
  const sw = t.addDevice(spec('Catalyst2960'), 'sw');
  const p1 = t.addDevice(spec('generic-pc'), 'p1');
  const ports = function (d) {
    return Array.from(d.interfaces.values()).filter(function (p) { return p.type === 'ethernet'; })
      .map(function (p) { return p.name; });
  };
  const rp = ports(r), sp = ports(sw);
  t.connect('r1', rp[0], 'sw', sp[0], { mediaId: '100base-tx', speedMbps: 100 });
  t.connect('sw', sp[1], 'p1', ports(p1)[0], { mediaId: '100base-tx', speedMbps: 100 });
  return { t: t, r: r, sw: sw, rp: rp, sp: sp };
}
function flat(o, p, acc) {
  acc = acc || {};
  Object.keys(o || {}).forEach(function (k) {
    const v = o[k], key = p ? p + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, key, acc);
    else acc[key] = Array.isArray(v) ? JSON.stringify(v) : v;
  });
  return acc;
}
function run(e, who, cmds) {
  const dev = who === 'r' ? e.r : e.sw;
  const s = new cli.CliSession(dev, e.t, new Simulator(e.t));
  const said = [];
  cmds.map(function (x) {
    return x.replace('{RP1}', e.rp[1]).replace('{SP1}', e.sp[1]);
  }).forEach(function (l) {
    const res = s.run(l) || {};
    (res.output || []).forEach(function (o) { said.push(o); });
  });
  return said;
}

section('1. Every command given no argument refuses, and says what to type');
{
  const BARE = [
    ['r', 'ip route', ['configure terminal']],
    ['r', 'ip address', ['configure terminal', 'interface {RP1}']],
    ['r', 'ipv6 address', ['configure terminal', 'interface {RP1}']],
    ['r', 'vrrp 1 ip', ['configure terminal', 'interface {RP1}']],
    ['r', 'description', ['configure terminal', 'interface {RP1}']],
    ['r', 'hostname', ['configure terminal']],
    ['r', 'ip name-server', ['configure terminal']],
    ['r', 'clock rate', ['configure terminal', 'interface {RP1}']],
    ['r', 'speed', ['configure terminal', 'interface {RP1}']],
    ['r', 'duplex', ['configure terminal', 'interface {RP1}']],
    ['s', 'vlan', ['configure terminal']],
    ['s', 'switchport access vlan', ['configure terminal', 'interface {SP1}']],
    ['s', 'switchport mode', ['configure terminal', 'interface {SP1}']],
    ['s', 'channel-group', ['configure terminal', 'interface {SP1}']],
    ['s', 'spanning-tree priority', ['configure terminal']]
  ];
  const silent = [], useless = [];
  for (const c of BARE) {
    const e = env();
    const dev = c[0] === 'r' ? e.r : e.sw;
    const before = JSON.stringify(flat(dev.config, ''));
    const said = run(e, c[0], ['enable'].concat(c[2]).concat([c[1]]));
    const after = JSON.stringify(flat(dev.config, ''));
    const refusals = said.filter(function (l) { return /^\s*%/.test(l); });
    if (!refusals.length) { silent.push(c[1] + ' -> ' + JSON.stringify(said.slice(-1)[0] || '(nothing)')); continue; }
    // A refusal must say what to type: a form, or the capability that is missing.
    if (!/Incomplete command|Usage:|<[a-z-]+>|cannot |is only configurable/.test(refusals.join(' '))) {
      useless.push(c[1] + ' -> ' + refusals[0]);
    }
    if (before !== after) useless.push(c[1] + ' answered a refusal but wrote configuration');
  }
  ok(BARE.length === 15, 'fifteen commands were asked (' + BARE.length + ')');
  ok(silent.length === 0, 'none of them is silent', silent.join('; '));
  ok(useless.length === 0, 'and each refusal names a form to type, or the capability that is missing', useless.join('; '));
}

section('2. `hostname` with no name no longer erases the name');
{
  const e = env();
  const said = run(e, 'r', ['enable', 'configure terminal', 'hostname core-router', 'hostname']);
  const name = e.r.config.hostname;
  ok(name === 'core-router', 'the name survives a bare `hostname`', String(name));
  ok(e.r.name === 'core-router', 'and so does the name every surface renders', String(e.r.name));
  ok(/Incomplete command: hostname/.test(said.join('\n')), 'the refusal says the name is unchanged', said.slice(-1)[0]);
  ok(/the name is unchanged/.test(said.join('\n')), 'in those words');
  const named = run(e, 'r', ['enable', 'configure terminal', 'hostname the bifrost']);
  ok(e.r.config.hostname === 'the bifrost', 'a name with spaces still works', String(e.r.config.hostname));
}

section('3. `description` refuses to be a destructive empty command, and a removal says what it removed');
{
  const e = env();
  const said = run(e, 'r', ['enable', 'configure terminal', 'interface {RP1}', 'description uplink to the core']);
  ok(e.r.interfaces.get(e.rp[1]).description === 'uplink to the core', 'the description is set');
  ok(/Description set: uplink to the core/.test(said.join('\n')), 'and the receipt names it', said.slice(-1)[0]);

  const bare = run(e, 'r', ['configure terminal', 'interface {RP1}', 'description']);
  ok(/Incomplete command: description/.test(bare.join('\n')), 'a bare `description` is refused', bare.slice(-1)[0]);
  ok(e.r.interfaces.get(e.rp[1]).description === 'uplink to the core', 'and does not clear what was there',
    String(e.r.interfaces.get(e.rp[1]).description));

  const gone = run(e, 'r', ['configure terminal', 'interface {RP1}', 'no description']);
  ok(/Description removed: uplink to the core/.test(gone.join('\n')), '`no description` says what it removed',
    gone.slice(-1)[0]);
  const again = run(e, 'r', ['configure terminal', 'interface {RP1}', 'no description']);
  ok(/had no description/.test(again.join('\n')), 'and does not pretend to remove one that is not there',
    again.slice(-1)[0]);
}

section('4. A missing value is reported as missing, not as invalid');
{
  const e = env();
  const ns = run(e, 'r', ['enable', 'configure terminal', 'ip name-server']);
  ok(/Incomplete command: ip name-server <address>/.test(ns.join('\n')), '`ip name-server` alone is incomplete',
    ns.slice(-1)[0]);
  ok(!/Invalid name server/.test(ns.join('\n')), 'and is not called an invalid address');
  const nsBad = run(e, 'r', ['configure terminal', 'ip name-server flurbish']);
  ok(/Invalid name server "flurbish"/.test(nsBad.join('\n')), 'a bad address is still quoted', nsBad.slice(-1)[0]);
  const nsOk = run(e, 'r', ['configure terminal', 'ip name-server 10.0.0.53']);
  ok(/Name server 10\.0\.0\.53/.test(nsOk.join('\n')), 'and a good one is accepted', nsOk.slice(-1)[0]);

  const v6 = run(e, 'r', ['configure terminal', 'interface {RP1}', 'ipv6 address']);
  ok(/Incomplete command: ipv6 address/.test(v6.join('\n')), '`ipv6 address` alone is incomplete', v6.slice(-1)[0]);
  ok(/autoconfig/.test(v6.join('\n')), 'and names the other form a reader may have meant');
  const v6Bad = run(e, 'r', ['configure terminal', 'interface {RP1}', 'ipv6 address 2001:db8::zz/64']);
  ok(/Invalid IPv6 address "2001:db8::zz"/.test(v6Bad.join('\n')), 'a malformed address is still quoted',
    v6Bad.slice(-1)[0]);

  const vrrp = run(e, 'r', ['configure terminal', 'interface {RP1}', 'vrrp 1 ip']);
  ok(/Incomplete command: vrrp <vrid> ip <address>/.test(vrrp.join('\n')), '`vrrp 1 ip` alone is incomplete',
    vrrp.slice(-1)[0]);
  const vrrpBad = run(e, 'r', ['configure terminal', 'interface {RP1}', 'vrrp 1 ip flurbish']);
  ok(/Invalid address "flurbish"/.test(vrrpBad.join('\n')), 'a bad virtual address is quoted', vrrpBad.slice(-1)[0]);
  // A VRRP group needs an address on the port to sit in front of, so the accepted case gives the port one first;
  // the refusal for the bare address above is about the address being missing, not about the port.
  const vrrpOk = run(e, 'r', ['configure terminal', 'interface {RP1}', 'ip address 10.0.0.1 255.255.255.0',
    'vrrp 1 ip 10.0.0.254']);
  ok(/owns 10\.0\.0\.254/.test(vrrpOk.join('\n')), 'and a good one is accepted', vrrpOk.slice(-1)[0]);
}

section('5. Whitespace a person produces does not change what a command means');
{
  const CASES = [
    ['r', 'ip route 10.9.0.0 255.255.255.0 10.0.0.9', ['configure terminal']],
    ['r', 'ip name-server 10.0.0.53', ['configure terminal']],
    ['r', 'hostname core-r1', ['configure terminal']],
    ['r', 'ip address 10.0.0.1 255.255.255.0', ['configure terminal', 'interface {RP1}']],
    ['s', 'vlan 20 name lab', ['configure terminal']],
    ['s', 'switchport access vlan 20', ['configure terminal', 'interface {SP1}']],
    ['s', 'show vlan', []]
  ];
  const VARIANTS = [
    ['double space', function (c) { return c.replace(/ /g, '  '); }],
    ['tab', function (c) { return c.replace(/ /g, TAB); }],
    ['leading space', function (c) { return ' ' + c; }],
    ['trailing space', function (c) { return c + ' '; }],
    ['trailing spaces', function (c) { return c + '   '; }],
    ['mixed', function (c) { return c.replace(/ /g, function (m, i) { return i % 2 ? TAB : '  '; }); }]
  ];
  const differs = [];
  let runs = 0;
  for (const c of CASES) {
    const base = (function () {
      const e = env();
      return { said: run(e, c[0], ['enable'].concat(c[2]).concat([c[1]])), config: JSON.stringify(flat((c[0] === 'r' ? e.r : e.sw).config, '')) };
    })();
    for (const v of VARIANTS) {
      runs++;
      const e = env();
      const said = run(e, c[0], ['enable'].concat(c[2]).concat([v[1](c[1])]));
      const config = JSON.stringify(flat((c[0] === 'r' ? e.r : e.sw).config, ''));
      if (said.join('\n') !== base.said.join('\n') || config !== base.config) {
        differs.push(v[0] + ' of "' + c[1] + '"');
      }
    }
  }
  ok(differs.length === 0, 'every variant of every command behaves like the canonical form (' + runs + ' runs)',
    differs.join('; '));
}

section('6. The leniency that is deliberate stays, and stays written down');
{
  // A pasted running-config block is followed by global commands with no `exit` in front of them (#1230). Making
  // that an error would break the paste; what it costs is that the answer does not say where the command landed.
  const e = env();
  const said = run(e, 'r', ['enable', 'configure terminal', 'interface {RP1}', 'ip route 10.9.0.0 255.255.255.0 10.0.0.9']);
  ok(/Route added: 10\.9\.0\.0\/24/.test(said.join('\n')), 'a global command at an interface prompt still applies',
    said.slice(-1)[0]);
  ok(e.r.config.routes && e.r.config.routes.length === 1, 'and lands in global config', JSON.stringify(e.r.config.routes));

  // What must NOT be lenient: the reverse. An interface-only verb at global config is refused, by name.
  const wrong = run(e, 'r', ['configure terminal', 'speed 100']);
  ok(/Unrecognized config command: speed 100/.test(wrong.join('\n')), 'an interface command at global config is refused',
    wrong.slice(-1)[0]);
  const vrrpHint = run(e, 'r', ['configure terminal', 'vrrp 1 ip 10.0.0.254']);
  ok(/vrrp is configured per interface/.test(vrrpHint.join('\n')), 'and where the console knows better, it says so',
    vrrpHint.slice(-1)[0]);
}

section('');
if (failed) {
  console.error(passed + ' passed, ' + failed + ' failed');
  process.exit(1);
}
console.log(passed + ' passed, 0 failed');
