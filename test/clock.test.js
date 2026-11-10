'use strict';
// The clock moves when the board changes (#1331).
//
// Logical time: `runAtMs` is the instant a question is asked at, `link.stateSinceMs` when a cable changed, and
// `topo.lastChangeAtMs` when the board last changed - the instant every convergence schedule is built from.
//
// The clock only moved for a **cable**. Shutting a port, enabling it, or moving it between VLANs all change what the
// control plane has to do - STP runs its timers again on every port behind it - and none of them moved the clock, so
// on a board that had already converged:
//
//   run time 40000, pending processes: 0            (correct: the board has settled)
//   port shut at 40000, pending:        0            (wrong: it has to re-converge)
//
// and a ping crossed a port that should have been listening. Two further faults were in the same mechanism: the
// console printed `state: down since 1200 ms` - an instant wearing a duration's clothes, read as "1200 ms ago" when
// it was 3800 ms ago - and the saved file carried `lastChangeAtMs`, so a board reopened tomorrow built its schedule
// from an instant belonging to a run that had ended.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
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
const ROOT = path.join(__dirname, '..');
const specs = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
const SW = specs.find(function (s) { return /CX 6000/.test(s.model); });

function triangle() {
  const t = new Topology();
  for (const id of ['s1', 's2', 's3']) t.addDevice(SW, id);
  t.connect('s1', '1/1/1', 's2', '1/1/1', { mediaId: '1000base-t', speedMbps: 1000 });
  t.connect('s2', '1/1/2', 's3', '1/1/2', { mediaId: '1000base-t', speedMbps: 1000 });
  t.connect('s3', '1/1/1', 's1', '1/1/2', { mediaId: '1000base-t', speedMbps: 1000 });
  return t;
}
function cli(t, dev, sim, cmds) {
  const s = new CliSession(dev, t, sim);
  const out = [];
  for (const c of cmds) out.push(((s.run(c) || {}).output || []).map(String).join('\n'));
  return out;
}

(async function main() {
  console.log('');
  console.log('A configuration change is a topology change:');
  {
    // Each command that changes the forwarding decision must move the clock and make the control plane pending
    // again. Before this, all three left `pending` at 0 on a board that had already converged.
    const cases = [
      ['shutdown', ['enable', 'configure terminal', 'interface 1/1/1', 'shutdown']],
      ['no shutdown', ['enable', 'configure terminal', 'interface 1/1/1', 'shutdown', 'no shutdown']],
      ['switchport access vlan 20', ['enable', 'configure terminal', 'interface 1/1/1', 'switchport access vlan 20']],
      ['switchport mode trunk', ['enable', 'configure terminal', 'interface 1/1/1', 'switchport mode trunk']]
    ];
    const wrong = [];
    for (const [label, cmds] of cases) {
      const t = triangle();
      const sim = new Simulator(t);
      sim.setRunTime(40000);
      const settled = sim._stillConverging().length;
      cli(t, t.getDevice('s1'), sim, cmds);
      const pending = sim._stillConverging().length;
      const clock = t.lastChangeAtMs;
      if (settled !== 0) wrong.push(label + ': the board was not settled to begin with (' + settled + ' pending)');
      if (clock !== 40000) wrong.push(label + ': clock is ' + clock + ', not the instant the operator stands at');
      // `no shutdown` lands on an already-up port in the second case, so it only has to move the clock when it
      // actually changed something - here it did (the port was shut a moment earlier).
      if (pending === 0) wrong.push(label + ': no process is pending again');
    }
    ok(wrong.length === 0, cases.length + ' configuration changes move the clock and re-converge the control plane',
      JSON.stringify(wrong.slice(0, 3)));
  }

  console.log('');
  console.log('A cable still does, and one truth says so:');
  {
    const t = triangle(); const sim = new Simulator(t);
    sim.setRunTime(5000);
    sim.linkDown(Array.from(t.links.values())[0].id, { atMs: 5000 });
    ok(t.lastChangeAtMs === 5000, 'pulling a cable records the instant', String(t.lastChangeAtMs));
    ok(sim._stillConverging().length > 0, 'and the control plane is pending', String(sim._stillConverging().length));
    // The schedule follows the topology's clock and nothing else - a second field on the simulator used to shadow
    // it, unset by anybody.
    ok(sim.reconvergeFromMs === undefined, 'there is no second answer for "when did the board change"',
      String(sim.reconvergeFromMs));
    t.markChange(7000);
    const sched = sim.getConvergence();
    ok(sched.entries.every(function (e) { return e.readyAtMs >= 7000; }),
      'and the schedule is built from it', JSON.stringify(sched.entries.map(function (e) { return e.readyAtMs; })));
  }

  console.log('');
  console.log('`show link state` prints an instant and an age:');
  {
    const t = triangle(); const sim = new Simulator(t);
    sim.setRunTime(5000);
    const lid = Array.from(t.links.values())[0].id;
    sim.linkDown(lid, { atMs: 1200 });
    const out = cli(t, t.getDevice('s1'), sim, ['enable', 'link state ' + lid])[1];
    ok(/changed at 1200 ms/.test(out), 'the instant is named as an instant', JSON.stringify(out));
    ok(/3800 ms ago/.test(out), 'and the age is given, because "since 1200 ms" reads as a duration',
      JSON.stringify(out));
    ok(!/since 1200 ms/.test(out), 'the old wording is gone', JSON.stringify(out));

    // No run time: no age to give, and it must not invent one.
    const sim2 = new Simulator(triangle());
    sim2.setRunTime(Infinity);
    const lid2 = Array.from(sim2.topo.links.values())[0].id;
    sim2.linkDown(lid2, { atMs: 1200 });
    const out2 = cli(sim2.topo, sim2.topo.getDevice('s1'), sim2, ['enable', 'link state ' + lid2])[1];
    ok(/changed at 1200 ms/.test(out2) && !/ago/.test(out2), 'with no run instant it says when, and nothing more',
      JSON.stringify(out2));

    // An instant from before this run cannot be given an age either.
    const t3 = triangle(); const sim3 = new Simulator(t3);
    sim3.setRunTime(500);
    const lid3 = Array.from(t3.links.values())[0].id;
    sim3.topo.links.get(lid3).stateSinceMs = 9000;
    const out3 = cli(t3, t3.getDevice('s1'), sim3, ['enable', 'link state ' + lid3])[1];
    ok(/not this run/.test(out3), 'and an instant after the run instant is not given a negative age',
      JSON.stringify(out3));
  }

  console.log('');
  console.log('A saved board carries the fault, not the instant:');
  {
    const t = triangle(); const sim = new Simulator(t);
    sim.setRunTime(9000);
    const lid = Array.from(t.links.values())[0].id;
    sim.linkDown(lid, { atMs: 9000 });
    const doc = JSON.parse(JSON.stringify(t.serialize()));
    ok(doc.lastChangeAtMs === undefined, 'the saved document has no run instant in it',
      JSON.stringify(doc.lastChangeAtMs));
    ok(doc.links.filter(function (l) { return l.state === 'down'; })[0].stateSinceMs === 9000,
      'and the cable that went down still says when');

    const back = Topology.fromJSON(doc);
    ok(back.lastChangeAtMs === 9000, 'a reloaded board\'s clock is the newest cable fault it carries',
      String(back.lastChangeAtMs));
    const quiet = Topology.fromJSON(JSON.parse(JSON.stringify({ devices: doc.devices, links: doc.links.map(function (l) {
      const c = Object.assign({}, l); delete c.stateSinceMs; if (c.state === 'up') delete c.state; return c;
    }) })));
    ok(quiet.lastChangeAtMs === 0, 'and a board with nothing wrong says nothing has changed', String(quiet.lastChangeAtMs));
  }

  console.log('');
  console.log('Over HTTP, a port shut re-converges the lab:');
  {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-clock-'));
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
        const payload = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
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
      for (let i = 0; ; i++) {
        const r = await request('GET', '/api/version').catch(function () { return { status: 0 }; });
        if (r.status === 200) break;
        if (i > 150) throw new Error('server did not start');
        await new Promise(function (res) { setTimeout(res, 100); });
      }
      const a = await request('POST', '/api/topologies/default/devices', { vendor: SW.vendor, model: SW.model });
      const b = await request('POST', '/api/topologies/default/devices', { vendor: SW.vendor, model: SW.model });
      await request('POST', '/api/topologies/default/links', {
        a: { deviceId: a.body.device.id, iface: '1/1/1' }, b: { deviceId: b.body.device.id, iface: '1/1/1' },
        mediaId: '1000base-t', speedMbps: 1000
      });
      const shut = await request('POST', '/api/topologies/default/interfaces/' + a.body.device.id + '/1%2F1%2F1',
        { enabled: false });
      ok(shut.status === 200, 'a port can be shut over the API', String(shut.status));
      const state = await request('GET', '/api/topologies/default');
      ok(state.body.lastChangeAtMs === undefined,
        'the state payload carries no run instant for a client to misread', JSON.stringify(state.body.lastChangeAtMs));
      const link = (state.body.links || [])[0];
      // A cable that has not changed state does not carry a time at all: an instant on every cable would be a
      // number nobody can check, and the payload is not allowed to invent one.
      ok(link && link.state === 'up' && link.stateSinceMs === undefined,
        'and a cable that has not changed carries no instant', JSON.stringify(link));
      // A document with a cable that went down at 9000 ms comes back with that instant, over the API as well.
      const doc = JSON.parse(JSON.stringify(state.body));
      doc.links[0].state = 'down';
      doc.links[0].stateSinceMs = 9000;
      const loaded = await request('POST', '/api/topologies/default/load', doc);
      ok(loaded.status === 200, 'a document with a faulted cable loads', String(loaded.status));
      const after = await request('GET', '/api/topologies/default');
      ok(after.body.links[0].state === 'down' && after.body.links[0].stateSinceMs === 9000,
        'and the instant it went down survives the trip', JSON.stringify(after.body.links[0]));
      ok(after.body.lastChangeAtMs === undefined,
        'while the run instant is still not published', JSON.stringify(after.body.lastChangeAtMs));
    } finally {
      try { child.kill('SIGKILL'); } catch (e) {}
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
    }
  }

  console.log('');
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
