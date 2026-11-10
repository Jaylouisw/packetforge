'use strict';
// When does a cable say it was pulled? (#1385)
//
// `setLinkState()` read `Number(o.atMs) || 0`, so a change with no instant named was stamped **t=0** — always.
// Typed into a console sitting at t=60000, `link down L1` recorded the pull at t=0 and then answered
// "Network converges again at 30000 ms": half a minute *before* the moment it was asked about. The same board,
// asked the same question through the API with `atMs: 60000`, answered 90000 — so the two doors disagreed, and
// one of them was nonsense.
//
// `markTopologyChange()` two methods up already had the right rule (the operator's instant, else 0). This test
// pins the one rule at both doors, plus a display defect found on the way: `link state` tested `stateSinceMs` for
// truth, so the first change in a run's life — t=0 — printed no instant at all.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const { Topology, Simulator } = require('../engine');
const { loadCatalog } = require('../devices/registry');
const cliModule = require('../engine/cli');
const CliSession = cliModule.CliSession || cliModule;

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const ROOT = path.join(__dirname, '..');
const specs = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
const SW = specs.find(function (s) { return /CX 6000 24G CL4/.test(s.model); }) ||
  specs.find(function (s) { return /CX 6000/.test(s.model); });
const HOST = specs.find(function (s) { return /Raspberry Pi 5/.test(s.model); }) ||
  specs.find(function (s) { return /^(pc|host)/i.test(s.category || ''); });

// Same shape as the stall that matters in practice: a switch, two hosts, one cable between them.
function lab(instant) {
  const t = new Topology();
  t.addDevice(SW, 's1'); t.addDevice(HOST, 'h1'); t.addDevice(HOST, 'h2');
  const first = function (id) {
    return Array.from(t.getDevice(id).interfaces.keys()).filter(function (n) {
      return !/^(mgmt|console|aux)/i.test(n);
    })[0];
  };
  const l1 = t.connect('h1', first('h1'), 's1', '1/1/1', { mediaId: '1000base-t', speedMbps: 1000 });
  const l2 = t.connect('h2', first('h2'), 's1', '1/1/2', { mediaId: '1000base-t', speedMbps: 1000 });
  const a = t.getDevice('h1').interfaces.get(first('h1'));
  a.ip = '10.9.0.1'; a.mask = '255.255.255.0';
  const b = t.getDevice('h2').interfaces.get(first('h2'));
  b.ip = '10.9.0.2'; b.mask = '255.255.255.0';
  const sim = new Simulator(t);
  if (instant !== null && instant !== undefined) sim.setRunTime(instant);
  return {
    topo: t, sim: sim, cli: new CliSession(t.getDevice('s1'), t, sim),
    id: l1.id || l1, far: l2.id || l2
  };
}

console.log('');
console.log('The engine: an instant named, an instant implied, and one that is not an instant');
{
  const atNow = lab(60000);
  const res = atNow.sim.setLinkState(atNow.id, 'down');
  ok(res.ok && res.changed, 'the cable goes down');
  ok(res.atMs === 60000, 'a change with no instant is stamped at the instant of the question', String(res.atMs));
  ok(res.reconvergeAtMs === 90000, 'and the network converges 30 s after that, not 30 s after t=0',
    String(res.reconvergeAtMs));
  ok(atNow.topo.links.get(res.linkId).stateSinceMs === 60000, 'the cable remembers the instant', 
    String(atNow.topo.links.get(res.linkId).stateSinceMs));
  ok(atNow.topo.lastChangeAtMs === 60000, 'and so does the board', String(atNow.topo.lastChangeAtMs));

  const stated = lab(60000);
  const at10 = stated.sim.setLinkState(stated.id, 'down', { atMs: 10000 });
  ok(at10.atMs === 10000 && at10.reconvergeAtMs === 40000, 'an instant that is named is the one used',
    JSON.stringify([at10.atMs, at10.reconvergeAtMs]));

  const settled = lab(null);
  const zero = settled.sim.setLinkState(settled.id, 'down');
  ok(zero.atMs === 0 && zero.reconvergeAtMs === 30000,
    'a settled board has no instant, and starts at 0 (unchanged behaviour)',
    JSON.stringify([zero.atMs, zero.reconvergeAtMs]));

  for (const bad of ['abc', -1, {}, NaN]) {
    const l = lab(60000);
    const r = l.sim.setLinkState(l.id, 'down', { atMs: bad });
    ok(r.ok === false && r.code === 'E_BAD_INSTANT',
      'atMs ' + JSON.stringify(bad) + ' is refused rather than becoming t=0', JSON.stringify(r));
    ok(l.topo.links.get(l.id).state !== 'down', 'and the cable was not touched');
  }
}

console.log('');
console.log('The console says the same thing');
{
  const c = lab(60000);
  const out = ((c.cli.run('link down ' + c.id) || {}).output || []);
  ok(out.some(function (l) { return /is now down/.test(l); }), 'link down reports the change', out.join(' | ').slice(0, 100));
  ok(out.some(function (l) { return /converges again at 90000 ms/.test(l); }),
    'and reconverges 30 s after the instant it was asked at', out.filter(function (l) { return /converge/.test(l); }).join(' '));
  ok(!out.some(function (l) { return /converges again at 30000 ms/.test(l); }), 'not 30 s after t=0');

  const view = ((c.cli.run('link state ' + c.id) || {}).output || []).join('\n');
  ok(/changed at 60000 ms \(0 ms ago\)/.test(view), 'the state view names the instant and how long ago it was',
    view.slice(-60));

  // An explicit instant still wins, and is still accepted.
  const stated = lab(60000);
  const st = ((stated.cli.run('link down ' + stated.id + ' at 1000') || {}).output || []).join('\n');
  ok(/converges again at 31000 ms/.test(st), 'an instant that is named is the one used', st.slice(0, 120));
}

console.log('');
console.log('...and a change at t=0 no longer prints nothing:');
{
  const c = lab(null);
  const view0 = ((c.cli.run('link down ' + c.id) || {}).output || []).join('\n');
  ok(/converges again at 30000 ms/.test(view0), 'a settled board still reconverges at 30000 ms');
  const state = ((c.cli.run('link state ' + c.id) || {}).output || []).join('\n');
  ok(/state: down, changed at 0 ms/.test(state),
    'and the first change in a run names its instant instead of printing none', state.slice(-60));
  ok(!/state: down$/.test(state.trim()), 'not a bare "down" with no instant at all');
}

console.log('');
console.log('The control plane and the data plane agree on the number it reports');
{
  const c = lab(60000);
  const res = c.sim.setLinkState(c.far, 'down');
  ok(res.atMs === 60000, 'the cut happened at the instant of the question', String(res.atMs));
  // The schedule is built from that instant, so "converges again at 90000 ms" is the tree finishing,
  // and the data plane says the same thing at the same numbers.
  const sched = c.sim.getConvergence();
  ok(sched.convergedAtMs === res.reconvergeAtMs,
    'the schedule converges at exactly the instant the console promised',
    JSON.stringify({ printed: res.reconvergeAtMs, schedule: sched.convergedAtMs }));
  ok((sched.entries || []).some(function (e) { return /after the change at 60000 ms/.test(String(e.basis || '')); }),
    'and it says which change it is reacting to', JSON.stringify((sched.entries || []).map(function (e) { return e.basis; })));

  const ping = c.sim.ping('h1', '10.9.0.2', { count: 1, atMs: 60000 });
  ok(ping.replies[0].success === false, 'at the instant of the cut, nothing crosses');
  ok(ping.replies[0].reason === 'converging', 'and it is reported as convergence, not as loss',
    String(ping.replies[0].reason));
  ok(ping.replies[0].convergingUntilMs === 90000,
    'until exactly the instant `link down` promised', String(ping.replies[0].convergingUntilMs));
  // Once the timers have run, convergence is no longer the reason - the cable still is. The engine stops
  // blaming a process that has finished.
  const later = c.sim.ping('h1', '10.9.0.2', { count: 1, atMs: 90000 });
  ok(later.replies[0].reason !== 'converging', 'after the instant promised, convergence is no longer the reason',
    String(later.replies[0].reason));
  ok(/no ARP reply/.test(String(later.replies[0].reason)),
    'the cable is: it was pulled, and nothing brings it back', String(later.replies[0].reason));
}

(async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-linkat-'));
  const port = await new Promise(function (resolve, reject) {
    const p = net.createServer();
    p.unref(); p.on('error', reject);
    p.listen(0, '127.0.0.1', function () { const n = p.address().port; p.close(function () { resolve(n); }); });
  });
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: Object.assign({}, process.env, { PORT: String(port), PF_DATA: dataDir }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const request = function (method, p, body) {
    return new Promise(function (resolve, reject) {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request({ host: '127.0.0.1', port: port, path: p, method: method,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} },
        function (res) {
          let d = '';
          res.on('data', function (c) { d += c; });
          res.on('end', function () { let j = d; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, body: j }); });
        });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  };

  try {
    for (let i = 0; i < 60; i++) {
      try { await request('GET', '/api/topologies'); break; } catch (e) { await new Promise(function (r) { setTimeout(r, 100); }); }
    }
    const a = await request('POST', '/api/topologies/default/devices', { vendor: HOST.vendor, model: HOST.model });
    const b = await request('POST', '/api/topologies/default/devices', { vendor: SW.vendor, model: SW.model });
    const link = await request('POST', '/api/topologies/default/links', {
      a: { deviceId: a.body.device.id, iface: 'eth0' }, b: { deviceId: b.body.device.id, iface: '1/1/1' },
      mediaId: '1000base-t', speedMbps: 1000
    });
    const lid = link.body && link.body.link && link.body.link.id;
    ok(!!lid, 'a cable to pull (' + lid + ')');
    const statePath = '/api/topologies/default/links/' + lid + '/state';

    console.log('');
    console.log('Over HTTP the same rule applies, and a bad instant is a 400:');
    const plain = await request('POST', statePath, { state: 'down' });
    ok(plain.status === 200 && plain.body.atMs === 0, 'no instant means 0 on a settled board (unchanged)',
      String(plain.status) + ' ' + JSON.stringify(plain.body && plain.body.atMs));
    const at60 = await request('POST', statePath, { state: 'up', atMs: 60000 });
    ok(at60.status === 200 && at60.body.atMs === 60000 && at60.body.reconvergeAtMs === 90000,
      'a named instant is used, and the reconvergence follows it',
      JSON.stringify({ at: at60.body.atMs, re: at60.body.reconvergeAtMs }));
    for (const bad of ['abc', -1]) {
      const r = await request('POST', statePath, { state: 'down', atMs: bad });
      ok(r.status === 400 && /E_BAD_INSTANT/.test(JSON.stringify(r.body)),
        'atMs ' + JSON.stringify(bad) + ' is a 400 with a code', String(r.status) + ' ' + JSON.stringify(r.body).slice(0, 120));
    }
    const after = await request('GET', '/api/topologies/default');
    const thatLink = (after.body.links || []).filter(function (l) { return l.id === lid; })[0];
    ok(thatLink && thatLink.state === 'up',
      'and the refused requests never moved the cable', JSON.stringify(thatLink && { s: thatLink.state, since: thatLink.stateSinceMs }));
  } finally {
    child.kill();
  }

  console.log('');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})();
