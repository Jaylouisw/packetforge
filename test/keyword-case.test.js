'use strict';
// keyword-case.test.js - IOS keywords are case-insensitive, and `interface range` is not a typo.
//
//   R1#SHOW IP ROUTE
//   % Ambiguous command: "SHOW IP ROUTE"
//   % Candidates: ...
//
// Every other spelling worked: `SHOW VERSION` answered, `INTERFACE Gi0/0` entered the block, `NO
// SHUTDOWN` brought the port up. The `show ip ...` family alone failed, because `IP` matches both `ip`
// and `ipv6` and the rule that settles that - an exact match beats a longer keyword - compared the two
// spellings with `===`, which is false for `IP` and `ip`.
//
//   SW1(config)#interface range Fa0/1-4
//   % Unrecognized command: interface range Fa0/1-4
//
// A form that exists on a real device and cannot work here is not a typo; it is an absent command, and
// the answer names what this console keeps instead.
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

function lab() {
  const t = new Topology();
  const r = t.addDevice(find('generic-router')); r.name = 'R1';
  const sw = t.addDevice(find('generic-switch')); sw.name = 'SW1';
  const ports = Array.from(sw.interfaces.values()).filter(function (i) { return !i.svi; }).map(function (i) { return i.name; });
  t.connect(r.id, 'Gi0/0', sw.id, ports[0]);
  const sim = new Simulator(t);
  const sr = new CliSession(r, t, sim); sr.run('enable');
  const ss = new CliSession(sw, t, sim); ss.run('enable');
  return { t: t, sim: sim, r: r, sw: sw, sr: sr, ss: ss, swp: ports };
}

console.log('A keyword typed in capitals is the same keyword:');
{
  const env = lab();
  ok(/Codes:|Prefix/.test(text(env.sr.run('SHOW IP ROUTE'))), 'SHOW IP ROUTE answers the table');
  ok(/Interface/.test(text(env.sr.run('Show Ip Interface Brief'))), 'mixed case answers the brief table');
  ok(/No IPv6 routes|Prefix/.test(text(env.sr.run('SHOW IPV6 ROUTE'))), 'SHOW IPV6 ROUTE is not the ip form');
  ok(/PacketForge/.test(text(env.sr.run('SHOW VERSION'))), 'SHOW VERSION answers');
  env.sr.run('CONFIGURE TERMINAL');
  ok(/\(config\)#/.test(env.sr.prompt()), 'CONFIGURE TERMINAL enters config mode');
  env.sr.run('HOSTNAME CAPS');
  ok(env.r.config.hostname === 'CAPS', 'HOSTNAME takes its argument');
  env.sr.run('INTERFACE Gi0/0');
  ok(/\(config-if\)#/.test(env.sr.prompt()), 'INTERFACE enters the block');
  ok(/IP address set/.test(text(env.sr.run('IP ADDRESS 10.0.0.1 255.255.255.0'))),
    'IP ADDRESS sets the address');
  ok(/up/.test(text(env.sr.run('NO SHUTDOWN'))), 'NO SHUTDOWN brings the port up');
  env.sr.run('end');
  ok(/Saved startup-config/.test(text(env.sr.run('WRITE MEMORY'))), 'WRITE MEMORY saves');
  ok(/ARP cache/.test(text(env.sr.run('CLEAR ARP'))), 'CLEAR ARP clears');
}

console.log('\nAn argument keyword in capitals is the same keyword:');
{
  const env = lab();
  env.ss.run('configure terminal');
  env.ss.run('interface ' + env.swp[1]);
  ok(/mode access/.test(text(env.ss.run('SWITCHPORT MODE ACCESS'))), 'SWITCHPORT MODE ACCESS is read');
  ok(!/^%/.test(text(env.ss.run('SWITCHPORT ACCESS VLAN 10'))), 'SWITCHPORT ACCESS VLAN 10 is read');
  env.ss.run('exit');
  ok(/VLAN 10|Ports/.test(text(env.ss.run('SHOW VLAN BRIEF'))), 'SHOW VLAN BRIEF is the table');
  env.ss.run('VLAN 20');
  const one = text(env.ss.run('SHOW VLAN 20'));
  ok(/^20\s/m.test(one), 'SHOW VLAN 20 narrows to the VLAN');
  ok(!/^10\s/m.test(one), 'and leaves VLAN 10 out of it');
}

console.log('\nEvery documented row survives being typed in capitals:');
{
  const env = lab();
  // Each row is compared on a fresh lab, twice: once as documented, once in capitals. A shared lab
  // would let an earlier row change the state the next one is refused or accepted for.
  const cases = [
    ['exec', 'generic-router', []],
    ['config', 'generic-router', ['configure terminal']],
    ['interface', 'generic-switch', ['configure terminal', 'interface Fa0/1']]
  ];
  const probeLab = function (model, enter) {
    const t = new Topology();
    const d = t.addDevice(find(model)); d.name = 'D1';
    const sim = new Simulator(t);
    const s = new CliSession(d, t, sim); s.run('enable');
    for (const line of enter) s.run(line);
    return s;
  };
  const bad = [];
  let checked = 0;
  for (const [label, model, enter] of cases) {
    const rows = (probeLab(model, enter)._helpFormRowsAll(probeLab(model, enter).mode) || [])
      .filter(function (f) {
        return f.tokens && f.tokens.every(function (t) { return typeof t === 'string'; });
      }).map(function (f) { return f.tokens.join(' '); });
    for (const row of rows) {
      // Ordinary control flow: navigation verbs are covered by their own suites, and `do` wraps another
      // command whose arguments are judged where they belong.
      if (/^(exit|end|do|help|\?)\b/.test(row)) continue;
      const a = probeLab(model, enter);
      const b = probeLab(model, enter);
      const lower = text(a.run(row));
      const upper = text(b.run(row.toUpperCase()));
      checked += 1;
      if (!/^\s*%/.test(lower) && /^\s*%/.test(upper)) {
        bad.push(label + ": '" + row + "' -> " + upper.split('\n')[0]);
      }
    }
  }
  ok(bad.length === 0, 'no documented row is refused only when typed in capitals'
    + (bad.length ? ': ' + bad.slice(0, 4).join('; ') : ''));
  ok(checked > 150, 'the sweep ran (' + checked + ' rows)');
}

console.log('\ninterface range is answered, not called a typo:');
{
  const env = lab();
  env.ss.run('configure terminal');
  const body = text(env.ss.run('interface range Fa0/1-4'));
  ok(/one block per port/.test(body), 'the answer says what this console keeps');
  ok(/Fa0\/1, Fa0\/2, Fa0\/3, Fa0\/4/.test(body), 'and names the ports the form covers');
  ok(/interface Fa0\/1/.test(body), 'and how to enter them');
  ok(!/Unrecognized/.test(body), 'nothing calls it unrecognized');
  ok(!/\(config-if\)#/.test(env.ss.prompt()), 'and no block was entered');
  const comma = text(env.ss.run('interface Fa0/1 , Fa0/9'));
  ok(/Fa0\/1/.test(comma) && !/Fa0\/9/.test(comma.split('\n')[1] || ''),
    'a comma list names only the ports the device has');
}

console.log('\nA dump saved on Windows (CRLF) applies as it stands:');
{
  const env = lab();
  const dump = ['! PacketForge running-config', 'hostname CR1', 'interface Gi0/0',
    '  ip address 10.9.9.1 255.255.255.0', '  no shutdown',
    'ip route 10.8.0.0 255.255.0.0 10.9.9.254', 'end'];
  env.sr.run('configure terminal');
  for (const line of dump) env.sr.run(line + '\r');
  env.sr.run('end');
  ok(env.r.config.hostname === 'CR1', 'the hostname line lost neither word nor carriage return');
  ok(/10\.8\.0\.0\/16/.test(text(env.sr.run('show ip route static'))), 'and the static route is in the table');
  ok(!/10\.9\.9\.1\/24\s*$/m.test('') , 'placeholder');
  ok(/10\.9\.9\.1\/24/.test(text(env.sr.run('show ip interface brief'))), 'and the address is on the port');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
