'use strict';
// running-config-ra.test.js — the last two lines that did not come back:
// IPv6 router advertisements, and the DHCP-client flag on a port that also has a
// static address. A running-config is only useful if pasting it reproduces the box.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(v, m) {
  const s = catalog.find(function (x) { return x.vendor === v && x.model === m; });
  if (!s) throw new Error('spec not found: ' + v + '/' + m);
  return s;
}

const RA_CONFIG = [
  'ipv6 nd ra enable',
  'ipv6 nd ra managed',
  'ipv6 nd ra other-config',
  'ipv6 nd suppress-ra',
  'ipv6 nd ra lifetime 900',
  'ipv6 nd prefix 2001:db8:1::/64 valid 3600 preferred 1800'
];

function fresh(name) {
  const t = new Topology();
  const r = t.addDevice(spec('generic', 'generic-router'));
  r.name = name;
  return { t: t, sim: new Simulator(t), r: r };
}

function config(env, lines) {
  return runCommands(env.r, env.t, env.sim, ['configure terminal'].concat(lines));
}
function runningConfig(env) {
  return runCommands(env.r, env.t, env.sim, ['enable', 'show running-config']).lines;
}
function script(lines) {
  return lines.filter(function (l) {
    return l && l.trim() && l.indexOf('!') !== 0 &&
      !/^[A-Za-z0-9._-]+[>#]/.test(l) && !/^Building configuration/.test(l) && !/^Current configuration/.test(l);
  });
}

// A router that never touched RA must not gain a single `ipv6 nd` line.
{
  const env = fresh('PLAIN');
  const rc = runningConfig(env).join('\n');
  ok(!/ipv6 nd/.test(rc), 'an untouched router emits no ipv6 nd lines');
}

// Every configured knob comes back.
const L = fresh('R1');
const applied = config(L, RA_CONFIG);
ok(applied.lines.filter(function (l) { return /^% /.test(l); }).length === 0,
  'the RA configuration is accepted without errors');

const rc = runningConfig(L).join('\n');
ok(/^ipv6 nd ra enable$/m.test(rc), 'running-config carries ra enable');
ok(/^ipv6 nd ra managed$/m.test(rc), 'running-config carries the M flag');
ok(/^ipv6 nd ra other-config$/m.test(rc), 'running-config carries the O flag');
ok(/^ipv6 nd suppress-ra$/m.test(rc), 'running-config carries suppress-ra');
ok(/^ipv6 nd ra lifetime 900$/m.test(rc), 'running-config carries a non-default router lifetime');
ok(/^ipv6 nd prefix 2001:db8:1::\/64 valid 3600 preferred 1800$/m.test(rc),
  'running-config carries the advertised prefix with its lifetimes');

// The real test: paste the dump into a blank box and get the same dump back.
const R = fresh('R1');
const paste = config(R, script(runningConfig(L)));
const errors = paste.lines.filter(function (l) { return /^% /.test(l); });
ok(errors.length === 0, 'the emitted config replays without errors' +
  (errors.length ? ': ' + errors.join(' | ') : ''));
ok(script(runningConfig(R)).join('\n') === script(runningConfig(L)).join('\n'),
  'a paste of the dump reproduces the dump');

// Including the `!` header line: a comment must not be an error.
const C = fresh('R1');
const raw = config(C, runningConfig(L).filter(function (l) { return !/^[A-Za-z0-9._-]+[>#]/.test(l); }));
ok(raw.lines.filter(function (l) { return /^% /.test(l); }).length === 0,
  'the raw dump, comment line and all, replays without errors');

// Default RA state is not emitted, so a paste cannot turn advertising on.
const D = fresh('R2');
config(D, ['ipv6 nd ra enable']);
const drc = runningConfig(D).join('\n');
ok(/^ipv6 nd ra enable$/m.test(drc), 'enabling advertising alone is recorded');
ok(!/lifetime 1800/.test(drc), 'a default router lifetime is not emitted');

// The DHCP-client flag survives alongside a static address.
const H = fresh('R3');
config(H, ['interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'ip address dhcp']);
const hrc = runningConfig(H).join('\n');
ok(/ip address 10\.0\.0\.1 255\.255\.255\.0/.test(hrc), 'the static address is emitted');
ok(/ip address dhcp/.test(hrc), 'and the DHCP flag on the same port is emitted too');

const H2 = fresh('R3');
config(H2, script(runningConfig(H)));
ok(script(runningConfig(H2)).join('\n') === script(runningConfig(H)).join('\n'),
  'the dual-addressed port round-trips');
ok(H2.r.interfaces.get('Gi0/0').dhcp === true, 'the pasted port is still a DHCP client');

// A port with only a static address must not gain `ip address dhcp`.
const S = fresh('R4');
config(S, ['interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0']);
ok(!/ip address dhcp/.test(runningConfig(S).join('\n')), 'a static-only port stays static');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
