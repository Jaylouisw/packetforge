'use strict';
// svi-line.test.js — an SVI is up because its VLAN carries traffic, not because it exists.
//
// Last iteration gave a switch a management address. It was up from the moment it was created, which
// is wrong in the one situation an operator is usually looking at when they read it: a VLAN whose
// every port is shut. A real switch drops `Vlan10`'s line protocol when the last port in VLAN 10 goes
// away, keeps the address printed, and stops answering for it — and the two show commands say
// different things in the two columns, which is why there are two columns.
//
// The rule is one rule: lineUp is computed once, and ownsIpOn(), routeTo(), routesTable() and both
// show commands read it. This suite checks the answer from all of those doors, because an SVI whose
// address answers while its route is gone would be two models of one object.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + (actual === expected ? '' : '\n      got: ' + JSON.stringify(actual) +
    '\n      want: ' + JSON.stringify(expected)));
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(v, m) {
  const s = catalog.find(function (x) { return x.vendor === v && x.model === m; });
  if (!s) throw new Error('missing spec ' + v + '/' + m);
  return s;
}
function model(m) {
  const s = catalog.find(function (x) { return x.model === m; });
  if (!s) throw new Error('missing model ' + m);
  return s;
}

// One switch, an SVI in VLAN 10, and three hosts so a port can be moved between VLANs on demand.
function lab() {
  const t = new Topology();
  const sw = t.addDevice(spec('aruba', 'CX 6000 24G CL4 PoE 4SFP 370W'));
  const h1 = t.addDevice(model('generic-pc'));
  const h2 = t.addDevice(model('generic-pc'));
  sw.name = 'SW1'; h1.name = 'H1'; h2.name = 'H2';
  t.connect(h1.id, 'eth0', sw.id, '1/1/3');
  t.connect(h2.id, 'eth0', sw.id, '1/1/4');
  const sim = new Simulator(t);
  const bad = runCommands(sw, t, sim, ['enable', 'configure terminal', 'hostname SW1',
    'vlan 10 mgmt', 'vlan 20 users',
    'interface vlan 10', 'ip address 10.10.0.1 255.255.255.0', 'exit', 'exit'])
    .lines.filter(function (l) { return /^%/.test(l); });
  if (bad.length) throw new Error('lab refused: ' + bad.join(' / '));
  for (const h of [h1, h2]) {
    const ip = h === h1 ? '10.10.0.10' : '10.10.0.11';
    runCommands(h, t, sim, ['configure terminal', 'interface eth0',
      'ip address ' + ip + ' 255.255.255.0', 'exit', 'exit']);
  }
  return { t: t, sim: sim, sw: sw, h1: h1, h2: h2 };
}

const answer = (dev, ctx, cmds) => runCommands(dev, ctx.t, ctx.sim, ['enable'].concat(cmds)).lines
  .filter(function (l) { return !/^[^\s#>]+[#>]\s?/.test(l); });
const text = (dev, ctx, cmds) => answer(dev, ctx, cmds).join('\n');
const configure = (dev, ctx, cmds) => answer(dev, ctx, ['configure terminal'].concat(cmds)
  .concat(['exit']));
const port = (dev, ctx, name, cmds) => configure(dev, ctx, ['interface ' + name].concat(cmds)
  .concat(['exit']));

function sviRow(ctx) {
  return text(ctx.sw, ctx, ['show ip interface brief']).split('\n')
    .filter(function (l) { return /^Vlan10 /.test(l); })[0] || '';
}
function pingSvi(ctx) {
  return /Success rate is 100 percent/.test(text(ctx.h1, ctx, ['ping 10.10.0.1 count 1']));
}

console.log('A VLAN with no member port leaves the address up and the line down:');
{
  const ctx = lab();
  const svi = ctx.sw.interfaces.get('Vlan10');
  ctx.sim.computeSviState();
  eq(svi.lineUp, false, 'the line protocol is down');
  eq(svi.lineStateReason, 'no active port in VLAN 10', 'and the reason names the VLAN');
  const out = text(ctx.sw, ctx, ['show interfaces Vlan10']);
  ok(/status: up/.test(out), 'the interface is still administratively up');
  ok(/line protocol: down \(no active port in VLAN 10\)/.test(out),
    'show interfaces separates the two: "' + (out.split('\n').filter(function (l) {
      return /line protocol/.test(l);
    })[0] || '').trim() + '"');
  const row = sviRow(ctx);
  ok(/up\s+down$/.test(row), 'show ip interface brief prints Status up, Protocol down: "' + row + '"');
  eq(pingSvi(ctx), false, 'and the address does not answer');
  // The data path and the table must agree: a down interface has no connected route.
  const routes = text(ctx.sw, ctx, ['show ip route']);
  ok(!/10\.10\.0\.0\/24/.test(routes), 'and there is no connected route for it');
  eq(ctx.sw.routeTo('10.10.0.5'), null, 'routeTo() agrees with the table');
}

console.log('\nA port joining the VLAN brings it up, and taking it away drops it again:');
{
  const ctx = lab();
  port(ctx.sw, ctx, '1/1/3', ['switchport mode access', 'switchport access vlan 10']);
  ctx.sim.computeSviState();
  eq(ctx.sw.interfaces.get('Vlan10').lineUp, true, 'the line comes up when a member port is up');
  ok(/up\s+up$/.test(sviRow(ctx)), 'the brief row says up/up');
  ok(pingSvi(ctx), 'and the address answers');
  ok(/10\.10\.0\.0\/24/.test(text(ctx.sw, ctx, ['show ip route'])), 'the connected route is back');
  ok(/line protocol: up/.test(text(ctx.sw, ctx, ['show interfaces Vlan10'])), 'and show interfaces agrees');

  port(ctx.sw, ctx, '1/1/3', ['shutdown']);
  ctx.sim.computeSviState();
  eq(ctx.sw.interfaces.get('Vlan10').lineUp, false, 'shutting the last member port drops the line');
  eq(ctx.sw.interfaces.get('Vlan10').lineStateReason, 'no active port in VLAN 10',
    'and the reason is the VLAN, not the cabling - the port is cabled, it is shut');
  eq(pingSvi(ctx), false, 'the address stops answering');

  port(ctx.sw, ctx, '1/1/3', ['no shutdown']);
  ctx.sim.computeSviState();
  eq(ctx.sw.interfaces.get('Vlan10').lineUp, true, 'no shutdown on the port brings it back');
  ok(pingSvi(ctx), 'and it answers again');
}

console.log('\nMembership is membership: another VLAN does not count, a trunk does:');
{
  const ctx = lab();
  // 1/1/3 in the wrong VLAN: the SVI stays down even though a port is up and cabled.
  port(ctx.sw, ctx, '1/1/3', ['switchport mode access', 'switchport access vlan 20']);
  ctx.sim.computeSviState();
  eq(ctx.sw.interfaces.get('Vlan10').lineUp, false, 'a port in VLAN 20 does not bring VLAN 10 up');
  eq(pingSvi(ctx), false, 'and the address does not answer');
  // The same port as a trunk carrying VLAN 10 does count, which is what a real switch does.
  port(ctx.sw, ctx, '1/1/3', ['switchport mode trunk', 'switchport trunk allowed vlan 10']);
  ctx.sim.computeSviState();
  eq(ctx.sw.interfaces.get('Vlan10').lineUp, true, 'a trunk carrying VLAN 10 does bring it up');
}

console.log('\nThe two ways to be down are told apart:');
{
  const ctx = lab();
  // Nothing is cabled at all on this switch - the lab's hosts are on 1/1/3 and 1/1/4, so use a switch
  // with no cables to see the other reason.
  const t2 = new Topology();
  const lonely = t2.addDevice(spec('aruba', 'CX 6000 24G CL4 PoE 4SFP 370W'));
  lonely.name = 'SW9';
  const sim2 = new Simulator(t2);
  runCommands(lonely, t2, sim2, ['enable', 'configure terminal', 'interface vlan 10',
    'ip address 10.10.0.1 255.255.255.0', 'exit', 'exit']);
  sim2.computeSviState();
  eq(lonely.interfaces.get('Vlan10').lineStateReason, 'no port is cabled',
    'an un-cabled switch says so, rather than blaming the VLAN');
  // And the cabled-but-shut case above says the opposite. Both are "down"; the difference is the
  // diagnosis, which is the only reason to print a reason at all.
  port(ctx.sw, ctx, '1/1/3', ['shutdown']);
  port(ctx.sw, ctx, '1/1/4', ['shutdown']);
  ctx.sim.computeSviState();
  eq(ctx.sw.interfaces.get('Vlan10').lineStateReason, 'no active port in VLAN 10',
    'a cabled-but-shut switch names the VLAN');
}

console.log('\nAdmin down outranks the line, and the columns say which is which:');
{
  const ctx = lab();
  port(ctx.sw, ctx, '1/1/3', ['switchport mode access', 'switchport access vlan 10']);
  configure(ctx.sw, ctx, ['interface vlan 10', 'shutdown', 'exit']);
  ctx.sim.computeSviState();
  const row = sviRow(ctx);
  ok(/administratively down\s+down$/.test(row), 'Status administratively down, Protocol down: "' + row + '"');
  ok(/line protocol: down \(administratively down\)/.test(text(ctx.sw, ctx, ['show interfaces Vlan10'])),
    'show interfaces names the administrator, not the VLAN, as the cause');
  eq(pingSvi(ctx), false, 'and it does not answer');
  configure(ctx.sw, ctx, ['interface vlan 10', 'no shutdown', 'exit']);
  ctx.sim.computeSviState();
  ok(pingSvi(ctx), 'no shutdown on the SVI restores it while the port is still in the VLAN');
}

console.log('\nOne answer, three readers:');
{
  const ctx = lab();
  port(ctx.sw, ctx, '1/1/3', ['switchport mode access', 'switchport access vlan 10']);
  ctx.sim.computeSviState();
  const upOwns = !!ctx.sw.ownsIpOn('1/1/3', '10.10.0.1');
  const upRoute = !!ctx.sw.routeTo('10.10.0.5');
  const upTable = /10\.10\.0\.0\/24/.test(text(ctx.sw, ctx, ['show ip route']));
  eq([upOwns, upRoute, upTable].join(','), 'true,true,true', 'while up: ownership, data path and table agree');
  port(ctx.sw, ctx, '1/1/3', ['shutdown']);
  ctx.sim.computeSviState();
  const downOwns = !!ctx.sw.ownsIpOn('1/1/3', '10.10.0.1');
  const downRoute = !!ctx.sw.routeTo('10.10.0.5');
  const downTable = /10\.10\.0\.0\/24/.test(text(ctx.sw, ctx, ['show ip route']));
  eq([downOwns, downRoute, downTable].join(','), 'false,false,false',
    'while down: all three agree it is gone, so no door tells a different story');
  // The address is still configured - that is what makes the state worth printing.
  // The dump prints the masked form, which is the form the config accepts; the point is that the
  // address survives the interface being down, because "down" is a state and not a deletion.
  ok(/ip address 10\.10\.0\.1 255\.255\.255\.0/.test(text(ctx.sw, ctx, ['show running-config'])),
    'and the address is still in the configuration');
}

console.log('\nA second port in the same VLAN is enough:');
{
  const ctx = lab();
  port(ctx.sw, ctx, '1/1/3', ['switchport mode access', 'switchport access vlan 10']);
  port(ctx.sw, ctx, '1/1/4', ['switchport mode access', 'switchport access vlan 10']);
  ctx.sim.computeSviState();
  eq(ctx.sw.interfaces.get('Vlan10').lineUp, true, 'two member ports, line up');
  port(ctx.sw, ctx, '1/1/3', ['shutdown']);
  ctx.sim.computeSviState();
  eq(ctx.sw.interfaces.get('Vlan10').lineUp, true, 'one of them shut, still up - the rule is *any* port');
  port(ctx.sw, ctx, '1/1/4', ['shutdown']);
  ctx.sim.computeSviState();
  eq(ctx.sw.interfaces.get('Vlan10').lineUp, false, 'both shut, down');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
