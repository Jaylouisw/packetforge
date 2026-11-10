'use strict';
// A `show` describes the lab at an instant; the control planes are results, not stored facts (#1338).
//
// `show ip route` printed whatever the last `computeOspf()` happened to leave on the device. Two consequences:
//
//   * a console with no run behind it reported `(no O routes)` on a lab that was fully converged - the routes only
//     appear if something (a `ping`, a load) ran the OSPF computation first;
//   * the answer to the same question depended on which run happened before it, so `show ip route` at instant 5000
//     could print the routes from a settled run 20000 ms later.
//
// `computeOspf()` itself honours `runAtMs` (routes appear at 16000 with the default hello/exchange/SPF timers), and so
// do `computeStp()`, `computeVrrp()` and `computeBgp()`. The console simply never asked them. `_show()` now refreshes
// the control planes at the instant the session is standing at, which is what the packet path already does before it
// sends anything.
const { loadCatalog } = require('../devices/registry');
const { Topology } = require('../engine/topology');
const { Simulator } = require('../engine/simulator');
const cliModule = require('../engine/cli');
const CliSession = cliModule.CliSession || cliModule;

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const ROOT = require('path').join(__dirname, '..');
const specs = loadCatalog(ROOT + '/devices').filter(function (s) { return !s.error; });
const R = specs.find(function (s) { return /ISR 4331/.test(s.model); });
const SW = specs.find(function (s) { return /CX 6000/.test(s.model); });
const HOST = specs.find(function (s) { return /Raspberry Pi 5/.test(s.model); });

// r1 --- r2 with a real segment behind each, so OSPF has something to advertise across the link.
function lab() {
  const t = new Topology();
  t.addDevice(R, 'r1'); t.addDevice(R, 'r2');
  t.addDevice(SW, 'sw1'); t.addDevice(SW, 'sw2');
  t.addDevice(HOST, 'h1'); t.addDevice(HOST, 'h2');
  const c = function (a, ap, b, bp) { t.connect(a, ap, b, bp, { mediaId: '1000base-t', speedMbps: 1000 }); };
  c('r1', 'Gi0/0/0', 'r2', 'Gi0/0/0');
  c('r1', 'Gi0/0/1', 'sw1', '1/1/1');
  c('sw1', '1/1/2', 'h1', 'eth0');
  c('r2', 'Gi0/0/1', 'sw2', '1/1/1');
  c('sw2', '1/1/2', 'h2', 'eth0');
  const r1 = t.getDevice('r1'), r2 = t.getDevice('r2');
  r1.interfaces.get('Gi0/0/0').ip = '10.0.0.1'; r1.interfaces.get('Gi0/0/0').mask = '255.255.255.0';
  r1.interfaces.get('Gi0/0/1').ip = '192.168.1.1'; r1.interfaces.get('Gi0/0/1').mask = '255.255.255.0';
  r2.interfaces.get('Gi0/0/0').ip = '10.0.0.2'; r2.interfaces.get('Gi0/0/0').mask = '255.255.255.0';
  r2.interfaces.get('Gi0/0/1').ip = '192.168.2.1'; r2.interfaces.get('Gi0/0/1').mask = '255.255.255.0';
  return { t: t, r1: r1, r2: r2 };
}
function osmf(env, sim, dev, id) {
  const s = new CliSession(dev, env.t, sim);
  s.run('enable'); s.run('configure terminal'); s.run('ospf router-id ' + id);
  for (const i of ['Gi0/0/0', 'Gi0/0/1']) { s.run('interface ' + i); s.run('ip ospf area 0'); s.run('exit'); }
  s.run('end');
}
// A brand-new session for every question: the console must not need a warm cache to answer.
function askedAt(env, sim, dev, cmds, atMs) {
  sim.setRunTime(atMs);
  const s = new CliSession(dev, env.t, sim);
  for (const c of cmds) s.run(c);
  return ((s.run(cmds[cmds.length - 1]) || {}).output || []).map(String);
}

console.log('');
console.log('A converged lab says it is converged, without a run behind it:');
{
  const env = lab();
  const sim = new Simulator(env.t);
  osmf(env, sim, env.r1, '1.1.1.1');
  osmf(env, sim, env.r2, '2.2.2.2');
  const routes = function (atMs) {
    return askedAt(env, sim, env.r1, ['enable', 'show ip route'], atMs)
      .filter(function (l) { return /^O /.test(l); }).join(' | ') || '(none)';
  };
  ok(/^O /.test(routes(Infinity)), 'show ip route on a settled lab lists the OSPF route', routes(Infinity));
  ok(routes(Infinity).indexOf('192.168.2.0') !== -1, 'the route to the far segment, via the far router',
    routes(Infinity));
  ok(routes(5000) === '(none)', 'and at 5000 ms, before OSPF can have converged, it does not', routes(5000));
  ok(routes(20000) === routes(Infinity), 'at 20000 ms it is back, and identical', routes(20000));

  console.log('');
  console.log('The same question gives the same answer whatever ran first:');
  {
    const order = [Infinity, 5000, Infinity, 5000, 20000];
    const answers = order.map(routes);
    const expectSettled = answers[0];
    ok(answers[2] === answers[0] && answers[4] === answers[0],
      'a settled answer is not changed by an early question in between',
      JSON.stringify({ first: answers[0], third: answers[2], fifth: answers[4] }));
    ok(answers[1] === answers[3] && answers[1] === '(none)',
      'and an early answer is not changed by a settled question in between',
      JSON.stringify({ second: answers[1], fourth: answers[3] }));
    ok(answers[0].length > 0 && expectSettled === answers[0], 'the settled answer is not empty', answers[0]);
  }
}

console.log('');
console.log('The same rule for the other control planes:');
{
  const env = lab();
  const sim = new Simulator(env.t);
  // VRRP on the link both routers share.
  for (const d of [env.r1, env.r2]) {
    const s = new CliSession(d, env.t, sim);
    s.run('enable'); s.run('configure terminal'); s.run('interface Gi0/0/0');
    s.run('vrrp 10 ip 10.0.0.254'); s.run('exit'); s.run('end');
  }
  const vrrp = function (atMs) {
    return askedAt(env, sim, env.r1, ['enable', 'show vrrp'], atMs)
      .filter(function (l) { return /Master|Backup|Init/.test(l); }).join(' | ');
  };
  const early = vrrp(1000), settled = vrrp(20000);
  ok(/pending/.test(early), 'at 1000 ms the election has not settled, and show vrrp says so', early.slice(0, 120));
  ok(!/pending/.test(settled), 'at 20000 ms it has', settled.slice(0, 120));
  ok(vrrp(1000) === early, 'and asking early again in the same session gives the same answer', vrrp(1000).slice(0, 120));

  // Spanning tree is guarded in test/console-over-http.test.js, on a switch (a router runs no STP).
}

console.log('');
console.log('What a show does not change:');
{
  const env = lab();
  const sim = new Simulator(env.t);
  osmf(env, sim, env.r1, '1.1.1.1');
  osmf(env, sim, env.r2, '2.2.2.2');
  const before = JSON.stringify((env.r1.config.ospf || {}));
  askedAt(env, sim, env.r1, ['enable', 'show ip route'], Infinity);
  askedAt(env, sim, env.r1, ['enable', 'show ip route'], 5000);
  ok(JSON.stringify((env.r1.config.ospf || {})) === before, 'asking does not rewrite the configuration', before);
  const routeRows = askedAt(env, sim, env.r1, ['enable', 'show ip route'], Infinity)
    .filter(function (l) { return /^[CSOB]\*?\s+\d+\.\d+\.\d+\.\d+/.test(l); });
  ok(routeRows.length > 0 && routeRows.every(function (l) { return /\[\d+\/\d+\]|is directly connected/.test(l); }),
    'and every row still carries its distance or says it is directly connected', JSON.stringify(routeRows.slice(0, 2)));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
