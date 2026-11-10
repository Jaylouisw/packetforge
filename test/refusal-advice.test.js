'use strict';
// refusal-advice.test.js - a refusal that names a command is a promise that the command works.
//
// The `show` views were swept last pass; this one sweeps the *refusals*. Every malformed command
// (a missing argument, a bogus word, an impossible number) is typed at a switch, a router and a PC
// in each mode, and every quoted command the refusal prints is then typed back. A quoted command
// that comes back "unrecognized", or refused for a capability the device does not have, is advice
// that cannot be taken - the defect class behind `no vlan 20` telling an operator to run
// `switchport access vlan <other>` on an SVI, where no such command exists.
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

const VERBS = ['show', 'clear', 'ping', 'traceroute', 'flow', 'write', 'copy', 'reload', 'converge',
  'help', 'enable', 'ip', 'ipv6', 'interface', 'switchport', 'vlan', 'spanning-tree', 'power', 'lldp',
  'hostname', 'arp', 'no', 'shutdown', 'speed', 'duplex', 'mtu', 'channel-group', 'vrrp', 'dhcp',
  'acl', 'firewall', 'nat', 'router', 'network', 'bgp', 'ospf', 'description', 'encapsulation',
  'link', 'exit', 'end', 'timers', 'log', 'logging', 'mac', 'port-security', 'snmp', 'clock'];
const FILL = { port: 'Fa0/1', id: '10', ip: '10.0.0.1', mask: '255.255.255.0', addr: '10.0.0.1',
  address: '10.0.0.1', vlan: '10', name: 'TEST', n: '2', mac: '00:11:22:33:44:55', pid: '1',
  'process-id': '1', as: '65001', vrid: '1', group: '1', prefix: '10.9.0.0/24', ms: '100',
  seconds: '60', count: '2', dst: '9.9.9.9', wildcard: '0.0.0.255', net: '10.0.0.0', area: '0',
  text: 'hello', mode: 'access', list: 'TEST', number: '1', size: '64', len: '24' };
function fill(cmd) {
  let missing = null;
  const out = String(cmd).split(/\s+/).map(function (t) {
    if (/^\[.*\]$/.test(t)) t = t.replace(/[\[\]]/g, '').split('|')[0];
    if (t.indexOf('|') !== -1) t = t.split('|')[0];
    return t.replace(/<([a-z0-9-]+)>/gi, function (m, k) {
      if (FILL[k] === undefined) { missing = k; return ''; }
      return FILL[k];
    });
  }).join(' ').replace(/\s+/g, ' ').trim();
  return { cmd: out, missing: missing };
}

// A device with the objects every refusal might talk about, so the advice has somewhere to land.
function build(model, name) {
  const t = new Topology();
  const dev = t.addDevice(find(model)); dev.name = name;
  const s = new CliSession(dev, t, new Simulator(t));
  s.run('enable'); s.run('configure terminal');
  if (dev.isL2 && dev.isL2()) {
    s.run('interface vlan 20'); s.run('ip address 10.0.20.1 255.255.255.0'); s.run('exit');
    s.run('vlan 10'); s.run('vlan 20'); s.run('vlan 99');
    s.run('interface Fa0/1'); s.run('switchport mode trunk'); s.run('switchport trunk allowed vlan 10,20');
    s.run('exit');
    s.run('interface Fa0/2'); s.run('switchport port-security'); s.run('exit');
    s.run('spanning-tree vlan 10 priority 4096');
  } else {
    s.run('interface Gi0/0'); s.run('ip address 10.1.1.1 255.255.255.0'); s.run('exit');
    s.run('ip route 10.9.0.0 255.255.0.0 10.1.1.2');
  }
  s.run('end');
  return { t: t, dev: dev, s: s };
}

function states() {
  const out = [];
  for (const [model, name] of [['generic-switch', 'SW1'], ['generic-router', 'R1'], ['generic-pc', 'PC1']]) {
    const base = build(model, name);
    out.push({ label: name + ' exec', dev: base.dev, mk: function () { return build(model, name); }, where: 'exec' });
    out.push({ label: name + ' config', dev: base.dev, mk: function () { return build(model, name); }, where: 'config' });
    if (base.dev.isL2 && base.dev.isL2()) {
      out.push({ label: name + ' SVI', dev: base.dev, mk: function () { return build(model, name); },
        where: 'iface', iface: 'Vlan20' });
      out.push({ label: name + ' port', dev: base.dev, mk: function () { return build(model, name); },
        where: 'iface', iface: 'Fa0/1' });
    } else {
      out.push({ label: name + ' port', dev: base.dev, mk: function () { return build(model, name); },
        where: 'iface', iface: 'Gi0/0' });
    }
  }
  return out;
}

function enter(env, where, iface) {
  env.s.run('end');
  if (where === 'exec') return;
  env.s.run('configure terminal');
  if (where === 'iface') env.s.run('interface ' + iface);
}

// The rows of the page in a given state, as commands to break.
function rowsIn(state) {
  const env = state.mk();
  enter(env, state.where, state.iface);
  const page = text(env.s.run('?'));
  return page.split('\n').map(function (l) { return l.trim(); })
    .filter(function (l) { return /^[a-z][a-z0-9-]* /.test(l) && l.indexOf('%') === -1; })
    .map(function (l) { return l.split(/\s{2,}/)[0]; })
    .filter(function (l) { return l.indexOf(' / ') === -1 && l.indexOf('<') === -1; });
}

// Three ways to get a refusal out of an honest row: drop its last word, append a bogus word, and
// push an impossible number through it.
function brokenForms(row) {
  const words = row.split(/\s+/);
  const out = [];
  if (words.length > 1) out.push(words.slice(0, -1).join(' '));
  out.push(row + ' zz');
  const numeric = words.findIndex(function (w) { return /<\d|range|<n>|<id>/i.test(w); });
  if (numeric !== -1) out.push(words.slice(0, numeric).join(' ') + ' 99999');
  return out;
}

// Quoted commands, grouped into the *runs* the text describes. "interface Gi0/0.10, then
// encapsulation dot1q 10" is one instruction in two steps: the second only works after the first, so
// judging the second on its own calls correct advice broken. A run is typed in order, in one session.
function quotedCommands(body) {
  const runs = [];
  for (const line of String(body).split('\n')) {
    const found = [];
    const re = /"([a-z][^"]{2,70})"/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      const first = m[1].split(/\s+/)[0].toLowerCase();
      if (VERBS.indexOf(first) === -1) continue;
      found.push({ cmd: m[1], at: m.index, end: m.index + m[0].length });
    }
    let run = [];
    for (let i = 0; i < found.length; i++) {
      run.push(found[i].cmd);
      const next = found[i + 1];
      const between = next ? line.slice(found[i].end, next.at) : null;
      const joined = between !== null && /^\s*,?\s*then\s*$/i.test(between);
      if (!joined) { runs.push(run); run = []; }
    }
    if (run.length) runs.push(run);
  }
  return runs;
}

console.log('Every quoted command inside a refusal runs:');
{
  const statesList = states();
  let refusals = 0, quotes = 0, skipped = 0;
  const broken = [];
  for (const state of statesList) {
    const rows = rowsIn(state);
    const forms = [];
    for (const row of rows) for (const f of brokenForms(row)) forms.push(f);
    for (const form of new Set(forms)) {
      const env = state.mk();
      enter(env, state.where, state.iface);
      const body = text(env.s.run(form));
      // Nothing was refused, so there is no advice to judge. Ordinary control flow: the sweep is
      // over refusals, and a command that ran is not one of them.
      if (!/%/.test(body)) continue;
      refusals++;
      for (const run of quotedCommands(body)) {
        const filledRun = run.map(fill).filter(function (f) { return f.cmd && !f.missing; });
        if (!filledRun.length) { skipped++; continue; }
        quotes += filledRun.length;
        // Where the advice says to type it: exec, config, or the interface block the refusal names.
        const named = filledRun[0].cmd.split(/\s+/).filter(function (w) {
          return env.dev.interfaces.has(w);
        })[0];
        const trials = [state.where === 'exec' ? 'exec' : 'config', 'config', 'exec']
          .concat(named ? ['iface:' + named] : ['iface:' + (state.iface || '')]);
        let refusedAs = null, worked = false;
        for (const where of trials) {
          const probe = state.mk();
          if (where.indexOf('iface:') === 0) {
            const name = where.slice(6);
            if (!name || !probe.dev.interfaces.has(name)) continue;
            enter(probe, 'iface', name);
          } else {
            enter(probe, where);
          }
          // The run is typed in order, and the last command is the one being judged.
          let answer = '';
          for (const step of filledRun) answer = text(probe.s.run(step.cmd)).split('\n')[0];
          if (!/% Unrecognized|does not switch|logical interface|is not a switchport|only valid on/.test(answer)) {
            worked = true; break;
          }
          refusedAs = answer;
        }
        if (!worked) {
          broken.push({ where: state.label + ': ' + form,
            advice: filledRun.map(function (f) { return f.cmd; }).join(', then '), answer: refusedAs });
        }
      }
    }
  }
  console.log('  (' + refusals + ' refusals, ' + quotes + ' quoted commands typed, ' + skipped + ' skipped)');
  ok(refusals > 100, 'the sweep produced ' + refusals + ' refusals to read');
  ok(quotes > 25, 'and typed ' + quotes + ' quoted commands back');
  for (const b of broken.slice(0, 10)) {
    ok(false, b.where + ' -> "' + b.advice + '": ' + String(b.answer).slice(0, 100));
  }
  ok(broken.length === 0, 'no refusal names a command that is refused where it would be typed (' +
    broken.length + ' found)');
}

console.log('\nThe case the sweep found, pinned both ways:');
{
  const r = build('generic-router', 'R1');
  r.s.run('configure terminal'); r.s.run('interface Gi0/0');
  const refusal = text(r.s.run('no encapsulation dot1q'));
  ok(/not a subinterface/.test(refusal), 'a router port says it is not a subinterface');
  ok(!/switchport/.test(refusal), 'and no longer advises switchport, which it refuses');
  ok(/interface Gi0\/0\.10/.test(refusal), 'it names the subinterface instead');
  // The advice works, in the order it is given.
  r.s.run('interface Gi0/0.10');
  ok(/encapsulation dot1q 10/.test(text(r.s.run('encapsulation dot1q 10'))),
    'and the two steps it names run in order');
  const sw = build('generic-switch', 'SW1');
  sw.s.run('configure terminal'); sw.s.run('interface Fa0/1');
  const swRefusal = text(sw.s.run('no encapsulation dot1q'));
  ok(/switchport mode trunk/.test(swRefusal), 'a switch port is told to become a trunk');
  ok(/Carries tags|trunk/i.test(text(sw.s.run('switchport mode trunk'))),
    'which works there');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
