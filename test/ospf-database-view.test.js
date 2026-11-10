'use strict';
// ospf-database-view.test.js - a view printed the JavaScript value, and a route that did not forward
// looked like one that did.
//
//   R1#show ip ospf database
//   OSPF link-state database for process 1 (ID null)          <- cfg.routerId was null, printed
//   Router Link States (Area 0)
//   Link ID     ADV Router  Interface  Cost  Neighbour   State
//   null        null        Gi0/0      10    172.16.0.1  FULL
//   172.16.0.1  172.16.0.1  Gi0/0      -     10.0.0.1    FULL
//
// The identifier is derived when nobody typed one (`show ip ospf` has said so since it was fixed), but
// this view read the config and printed what it found there. And a prefix the SPF produced was listed
// as though it were in use, even when a static route at distance 1 held the same prefix.
//
// The last block is the general form of the first defect: no `null`, `undefined` or `NaN` may appear
// in operator-facing text, on any device, from any show command.
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

// R1 (peering with R2 over a cable) where R2 holds 172.16.0.0/24.
function ospfLab(opts) {
  const o = opts || {};
  const t = new Topology();
  const a = t.addDevice(find('generic-router')); a.name = 'R1';
  const b = t.addDevice(find('generic-router')); b.name = 'R2';
  t.connect(a.id, 'Gi0/0', b.id, 'Gi0/0');
  const sim = new Simulator(t);
  const sa = new CliSession(a, t, sim); sa.run('enable'); sa.run('configure terminal');
  sa.run('interface Gi0/0'); sa.run('ip address 10.0.0.1 255.255.255.0'); sa.run('exit');
  if (o.staticBeat) sa.run('ip route 172.16.0.0 255.255.255.0 192.0.2.9');
  sa.run('router ospf 1');
  if (o.routerId) sa.run('router-id ' + o.routerId);
  sa.run('network 10.0.0.0 0.0.0.255 area 0'); sa.run('exit'); sa.run('end');
  const sb = new CliSession(b, t, sim); sb.run('enable'); sb.run('configure terminal');
  sb.run('interface Gi0/0'); sb.run('ip address 10.0.0.2 255.255.255.0'); sb.run('exit');
  sb.run('interface Gi0/1'); sb.run('ip address 172.16.0.1 255.255.255.0'); sb.run('exit');
  sb.run('router ospf 1'); sb.run('network 10.0.0.0 0.0.0.255 area 0');
  sb.run('network 172.16.0.0 0.0.0.255 area 0'); sb.run('exit'); sb.run('end');
  return { t: t, sim: sim, a: a, b: b, sa: sa, sb: sb };
}

console.log('The database names the identifier the process is running with:');
{
  const env = ospfLab();
  const body = text(env.sa.run('show ip ospf database'));
  ok(!/\bnull\b/.test(body), 'no bare null anywhere in the view');
  ok(/OSPF link-state database for process 1 \(ID 10\.0\.0\.1\)/.test(body),
    'the header names the derived identifier');
  const rows = body.split('\n').filter(function (l) { return /FULL/.test(l); });
  ok(rows.length === 2, 'both link-state rows are present');
  for (const row of rows) ok(!/\bnull\b/.test(row), 'and neither has a null in it: ' + row.trim());
  ok(/10\.0\.0\.1\s+10\.0\.0\.1\s+Gi0\/0/.test(body), 'the local row carries the local id');
}

console.log('\nA configured identifier is the one printed:');
{
  const env = ospfLab({ routerId: '9.9.9.9' });
  const body = text(env.sa.run('show ip ospf database'));
  ok(/\(ID 9\.9\.9\.9\)/.test(body), 'the configured id is in the header');
  ok(/9\.9\.9\.9\s+9\.9\.9\.9/.test(body), 'and in the link-state row');
  ok(/Router ID       9\.9\.9\.9/.test(text(env.sa.run('show ip protocols'))),
    'show ip protocols agrees');
}

console.log('\nshow ip protocols names the id, not the rule:');
{
  const env = ospfLab();
  const body = text(env.sa.run('show ip protocols'));
  ok(/Router ID\s+10\.0\.0\.1 \(derived from the highest interface address\)/.test(body),
    'the elected id is printed, with why');
  ok(!/not configured - the highest interface address/.test(body),
    'and not a description of the rule instead of an answer');
}

console.log('\nA prefix that does not forward is marked, and explained:');
{
  const env = ospfLab({ staticBeat: true });
  const db = text(env.sa.run('show ip ospf database'));
  const row = db.split('\n').filter(function (l) { return /172\.16\.0\.0\/24/.test(l); })[0];
  ok(!!row, 'the prefix the SPF produced is listed');
  ok(/^\s*-/.test(row), 'marked as not forwarding: ' + row.trim());
  ok(/is held by a static route at distance 1, which beats OSPF at 110/.test(db),
    'and the answer says what holds it instead');
  // The routing table must agree, which is where the mark comes from.
  const rib = text(env.sa.run('show ip route'));
  ok(/^\s+O 172\.16\.0\.0\/24/m.test(rib), 'show ip route leaves the OSPF row unmarked too');
  ok(/^\s*\*\s+S 172\.16\.0\.0\/24/m.test(rib), 'and marks the static row installed');
}

console.log('\nAn installed prefix is marked, and the key is always there:');
{
  const env = ospfLab();
  const db = text(env.sa.run('show ip ospf database'));
  const row = db.split('\n').filter(function (l) { return /172\.16\.0\.0\/24/.test(l); })[0];
  ok(/^\s*\*/.test(row || ''), 'the installed prefix is marked: ' + (row || '').trim());
  ok(/this route forwards/.test(db), 'and the key explains the mark');
}

console.log('\nNo JavaScript value reaches operator text, on any device:');
{
  // Every show command on the exec page, on a lab with a bit of everything: a switch with a VLAN and
  // an SVI, a host on it, and a router with OSPF, a static route and no configured router-id.
  const t = new Topology();
  const sw = t.addDevice(find('generic-switch')); sw.name = 'SW1';
  const pc = t.addDevice(find('generic-pc')); pc.name = 'PC1';
  const r = t.addDevice(find('generic-router')); r.name = 'R1';
  const swPorts = Array.from(sw.interfaces.values()).filter(function (i) { return !i.svi; }).map(function (i) { return i.name; });
  const pcPort = Array.from(pc.interfaces.values())[0].name;
  t.connect(sw.id, swPorts[0], pc.id, pcPort);
  t.connect(sw.id, swPorts[1], r.id, 'Gi0/0');
  const sim = new Simulator(t);
  const ss = new CliSession(sw, t, sim); ss.run('enable'); ss.run('configure terminal');
  ss.run('vlan 10'); ss.run('interface vlan 10'); ss.run('ip address 10.0.10.1 255.255.255.0'); ss.run('exit');
  ss.run('interface ' + swPorts[0]); ss.run('switchport access vlan 10'); ss.run('exit');
  ss.run('end');
  const sp = new CliSession(pc, t, sim); sp.run('enable'); sp.run('configure terminal');
  sp.run('interface ' + pcPort); sp.run('ip address 10.0.10.11 255.255.255.0'); sp.run('exit'); sp.run('end');
  const sr = new CliSession(r, t, sim); sr.run('enable'); sr.run('configure terminal');
  sr.run('interface Gi0/0'); sr.run('ip address 10.0.10.2 255.255.255.0'); sr.run('exit');
  sr.run('ip route 172.16.0.0 255.255.0.0 10.0.10.1');
  sr.run('router ospf 1'); sr.run('network 10.0.10.0 0.0.0.255 area 0'); sr.run('exit'); sr.run('end');
  sp.run('ping 10.0.10.2 count 2');

  // The commands are taken from the page itself, so a new view is covered without editing this list.
  const page = sp.run('?').output.join('\n');
  const commands = page.split('\n').map(function (l) { return l.trim().split(/\s{2,}/)[0]; })
    .filter(function (l) { return /^show\s/.test(l); });
  ok(commands.length > 20, 'the exec page offers more than twenty show commands (' + commands.length + ')');
  const bad = [];
  let checked = 0;
  for (const cli of [ss, sr, sp]) {
    // The page above is the host's; ask each device for its own.
    const ownPage = cli.run('?').output.join('\n');
    const own = ownPage.split('\n').map(function (l) { return l.trim().split(/\s{2,}/)[0]; })
      .filter(function (l) { return /^show\s/.test(l); });
    for (const command of own) {
      const out = text(cli.run(command));
      checked += 1;
      for (const token of ['null', 'undefined', 'NaN', '[object Object]']) {
        if (new RegExp('\\b' + token.replace('[', '\\[').replace(']', '\\]') + '\\b').test(out)) {
          bad.push(cli.device.name + ' "' + command + '": ' + token);
        }
      }
    }
  }
  ok(bad.length === 0, 'no show command leaks a JavaScript value' + (bad.length ? ': ' + bad.join('; ') : ''));
  ok(checked > 40, 'the sweep ran (' + checked + ' commands across two devices)');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
