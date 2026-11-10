'use strict';
// optional-args.test.js - a part the page puts in brackets is optional, and a default the operator
// did not type is not theirs to be refused for.
//
// Two checks in one pass:
//
//  1. For every help row containing [optional] parts, both spellings - with them and without them -
//     must be accepted by the parser. A page that brackets something the parser requires is a page
//     that lies about what a command needs.
//  2. `ipv6 nd prefix <p>/<len> valid 60` was refused:
//
//       % Preferred lifetime (604800s) cannot exceed the valid lifetime (60s)
//
//     citing the *default* preferred lifetime back at an operator who never typed one and could not
//     see one. The contradiction is real; the number in the refusal was not theirs.
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

function lab(model, name, prep) {
  const t = new Topology();
  const d = t.addDevice(find(model)); d.name = name;
  const s = new CliSession(d, t, new Simulator(t));
  s.run('enable');
  s.run('configure terminal');
  (prep || []).forEach(function (l) { s.run(l); });
  return { t: t, d: d, s: s };
}

console.log('\nA default cited back at the operator is not a reason to refuse their command:');
{
  const env = lab('generic-router', 'R1', ['interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0',
    'no shutdown', 'exit']);
  const out = text(env.s.run('ipv6 nd prefix 2001:db8:9::/64 valid 60'));
  ok(!/^\s*%/m.test(out.split('\n')[0]), 'valid on its own is accepted');
  ok(/valid 60s, preferred 60s/.test(out), 'the preferred lifetime follows the valid one down');
  ok(/followed the valid one down/.test(out), 'and the answer says which number was not the operator\'s');
  ok(/default 604800s/.test(out), 'naming the default it replaced');
  env.s.run('end');
  const rc = text(env.s.run('show running-config'));
  ok(/ipv6 nd prefix 2001:db8:9::\/64 valid 60 preferred 60/.test(rc),
    'the dump carries both numbers, so a paste reproduces the state');
  // The dump pastes back into a fresh device and produces the same line.
  const t2 = new Topology();
  const d2 = t2.addDevice(find('generic-router')); d2.name = 'R1';
  const s2 = new CliSession(d2, t2, new Simulator(t2));
  s2.run('enable');
  const paste = (rc.split('\n').filter(function (l) {
    return /^ipv6 nd prefix/.test(l.trim());
  }));
  s2.run('configure terminal'); paste.forEach(function (l) { s2.run(l); }); s2.run('end');
  const rc2 = text(s2.run('show running-config'));
  ok(/ipv6 nd prefix 2001:db8:9::\/64 valid 60 preferred 60/.test(rc2),
    'and pasting it back keeps the clamped values');
}

console.log('\nA contradiction between two typed numbers is still refused:');
{
  const env = lab('generic-router', 'R1', ['interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0',
    'no shutdown', 'exit']);
  const bad = text(env.s.run('ipv6 nd prefix 2001:db8:9::/64 valid 60 preferred 120'));
  ok(/cannot exceed/.test(bad), 'preferred past valid is refused when both were typed');
  ok(/120s/.test(bad) && /60s/.test(bad), 'and the refusal quotes the two numbers the operator wrote');
  const good = text(env.s.run('ipv6 nd prefix 2001:db8:9::/64 valid 120 preferred 60'));
  ok(/preferred 60s/.test(good), 'and a sane pair is accepted');
  ok(!/followed the valid one down/.test(good), 'with no note about a default nobody mentioned');
  env.s.run('end');
  ok(/valid 120 preferred 60/.test(text(env.s.run('show running-config'))), 'and dumped as typed');
}

console.log('\nEvery bracketed part of every page is optional where it stands:');
{
  const VALUES = { id: '10', name: 'LAB', ip: '10.0.0.1', addr: '10.0.0.1', address: '10.0.0.1',
    port: 'Fa0/1', 'process-id': '1', as: '65001', mac: '00:11:22:33:44:55', vlan: '10', group: '1',
    prefix: '2001:db8:9::', len: '64', mask: '255.255.0.0', dst: '9.9.9.9', net: '10.0.0.0',
    wildcard: '0.0.0.255', area: '0', vrid: '1', type: 'A', value: '10.0.0.5', version: '2',
    priority: '100', speed: '1000', mtu: '1500', text: 'hello', list: 'TEST', n: '2', ms: '100',
    count: '3', size: '100', host: 'host1.lab.test', seconds: '60', s: '60', seq: '10',
    'route-map': 'RM1', community: '65001:1', 'as-path': '65002', interface: 'Fa0/1',
    'vlan-id': '10', 'mac-address': '00:11:22:33:44:55', time: '60', number: '10', mask6: '64' };
  const fill = function (tok) {
    return tok.replace(/<([a-z0-9-]+)>/gi, function (m, k) { return VALUES[k] || '10'; });
  };
  // Every combination of optional parts present/absent for a row with `[...]` groups.
  const variants = function (syn) {
    const out = [];
    const expand = function (s) {
      const m = s.match(/\[[^\]]*\]/);
      if (!m) { out.push(s); return; }
      const inner = m[0].slice(1, -1);
      expand(s.replace(m[0], ' ').replace(/\s+/g, ' ').trim());
      expand(s.replace(m[0], inner).replace(/\s+/g, ' ').trim());
    };
    expand(syn.trim());
    return out.map(function (line) {
      return line.split(/\s+/).map(function (t) {
        return fill(t.indexOf('|') !== -1 ? t.split('|')[0] : t);
      }).join(' ');
    }).filter(Boolean);
  };
  const modes = [
    ['generic-switch', []],
    ['generic-router', ['interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit']]
  ];
  let rows = 0, lines = 0;
  for (const [model, prep] of modes) {
    for (const mode of [{ enter: ['configure terminal'], label: 'config' },
      { enter: ['configure terminal', 'interface Fa0/1'], label: 'interface' }]) {
      const env = lab(model, 'X1', prep);
      mode.enter.forEach(function (l) { env.s.run(l); });
      const page = text(env.s.run('?')).split('\n').map(function (l) { return l.trim(); })
        .filter(function (l) { return l && !l.startsWith('%'); })
        .map(function (l) { return l.split(/\s{2,}/)[0]; });
      for (const syn of page) {
        if (syn.indexOf('[') === -1) continue;
        // Ordinary control flow, not an exemption: navigation and exec verbs are not configuration
        // rows, and are checked by their own suites.
        if (/^(exit|end|help|do |show |ping |traceroute |clear |write |copy |reload|enable|disable)/.test(syn)) continue;
        rows++;
        const seen = new Set();
        for (const line of variants(syn)) {
          if (seen.has(line)) continue;
          seen.add(line);
          const e = lab(model, 'X1', prep);
          mode.enter.forEach(function (l) { e.s.run(l); });
          const out = text(e.s.run(line));
          const refused = /% (Unrecognized|Invalid|Incomplete)/.test(out.split('\n')[0] || '');
          ok(!refused, model + '/' + mode.label + ': "' + line + '" (from "' + syn + '") is accepted' +
            (refused ? ' — ' + JSON.stringify((out.split('\n')[0] || '').slice(0, 90)) : ''));
          lines++;
        }
      }
    }
  }
  ok(rows >= 4, 'the sweep found ' + rows + ' rows with optional parts (' + lines + ' lines typed)');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
