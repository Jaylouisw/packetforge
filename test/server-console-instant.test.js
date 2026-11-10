'use strict';
// server-console-instant.test.js - the console over HTTP is the same console (issue #1335).
//
// The HTTP console was not the browser console in three ways, all measured against
// `POST /api/topologies/:id/config/:devId`:
//
//   1. it was built on `new Simulator(topo)`, a second accounting, so traffic counted by `/flows`
//      was invisible to `show interfaces` and traffic the console generated was invisible to
//      `runtime[id].counters` - one board, two sets of counters;
//   2. it took no instant at all, so a lab reported mid-convergence by the cable endpoint could not
//      be asked about that moment;
//   3. `show spanning-tree` printed whatever tree was computed last, because `dev.stp` belongs to
//      whichever Simulator wrote it and a cached session never re-derived its planes after the next
//      request cut a cable.
//
// This starts a real server and asks it. Every number below is read from a response body.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + (actual === expected ? '' : ' (got ' + JSON.stringify(actual) +
    ', want ' + JSON.stringify(expected) + ')'));
}

const ROOT = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-console-'));
let PORT = 0;

function freePort() {
  return new Promise(function (resolve, reject) {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', function () {
      const port = probe.address().port;
      probe.close(function () { resolve(port); });
    });
  });
}

function request(method, urlPath, body) {
  return new Promise(function (resolve, reject) {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: urlPath, method: method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}
    }, function (res) {
      let data = '';
      res.on('data', function (c) { data += c; });
      res.on('end', function () {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (e) { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function startServer() {
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), PF_DATA: dataDir }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', function (d) { log += d; });
  child.stderr.on('data', function (d) { log += d; });
  return new Promise(function (resolve, reject) {
    const deadline = Date.now() + 20000;
    (function poll() {
      request('GET', '/api/catalog').then(function (r) {
        if (r.status === 200) return resolve({ child: child, log: function () { return log; } });
        throw new Error('status ' + r.status);
      }).catch(function (e) {
        if (child.exitCode !== null) return reject(new Error('server exited (' + child.exitCode + '): ' + log));
        if (Date.now() > deadline) return reject(new Error('server did not answer: ' + e.message + ' | ' + log));
        setTimeout(poll, 100);
      });
    })();
  });
}

function stop(child) {
  return new Promise(function (resolve) {
    child.on('exit', function () { resolve(); });
    try { child.kill('SIGTERM'); } catch (e) { resolve(); }
    setTimeout(function () { try { child.kill('SIGKILL'); } catch (e) {} resolve(); }, 5000);
  });
}

const T = '/api/topologies/default';

async function place(model, name) {
  const r = await request('POST', T + '/devices', { vendor: model.split('/')[0], model: model.split('/')[1] });
  if (r.status !== 200 && r.status !== 201) throw new Error('could not place ' + model + ': ' + r.status + ' ' + JSON.stringify(r.body));
  const id = r.body.id || (r.body.device && r.body.device.id);
  if (name && id) await request('POST', T + '/config/' + id, { commands: ['enable', 'configure terminal', 'hostname ' + name, 'exit', 'end'] });
  return id;
}

async function cable(aId, aIf, bId, bIf) {
  const r = await request('POST', T + '/links', { a: { deviceId: aId, iface: aIf }, b: { deviceId: bId, iface: bIf } });
  if (r.status !== 201) throw new Error('could not cable ' + aIf + ' to ' + bIf + ': ' + r.status + ' ' + JSON.stringify(r.body));
  return r.body.link.id;
}

function text(r) { return String((r.body && r.body.output) || ''); }
function console_run(devId, commands, extra) {
  return request('POST', T + '/config/' + devId, Object.assign({ commands: commands }, extra || {}));
}

(async function main() {
  PORT = await freePort();
  console.log('The console over HTTP is the same console (port ' + PORT + '):');
  const srv = await startServer();
  try {
    // A board with a loop in it, so the spanning tree has an election to report.
    const sw1 = await place('generic/generic-switch', 'SW1');
    const sw2 = await place('generic/generic-switch', 'SW2');
    const sw3 = await place('generic/generic-switch', 'SW3');
    const host = await place('generic/generic-pc', 'PC1');
    // The generic switch's template is Fa0/1..Fa0/8 (ports the catalogue actually declares, not a
    // guess at a vendor's panel).
    const firstCable = await cable(sw1, 'Fa0/1', sw2, 'Fa0/1');
    await cable(sw2, 'Fa0/2', sw3, 'Fa0/1');
    const lastCable = await cable(sw3, 'Fa0/2', sw1, 'Fa0/2');
    await cable(host, 'eth0', sw1, 'Fa0/3');

    console.log('\n1. One board, one set of counters:');
    // Configure an address on the host and the switch's own SVI, then let the console start a
    // conversation: the counters that conversation moves must appear in the payload the UI reads.
    await console_run(host, ['enable', 'configure terminal', 'interface eth0',
      'ip address 10.9.9.10 255.255.255.0', 'exit', 'ip default-gateway 10.9.9.1', 'end']);
    await console_run(sw1, ['enable', 'configure terminal', 'interface vlan 1',
      'ip address 10.9.9.1 255.255.255.0', 'exit', 'end']);
    const pong = await console_run(host, ['enable', 'ping 10.9.9.1']);
    ok(/[1-9]\d* (bytes|packet)/.test(text(pong)) || /!!!!|Success rate is 100/.test(text(pong)),
      'the host can reach the switch address (the run moved packets)');
    const afterPing = await request('GET', T);
    const hostRuntime = (afterPing.body.runtime || {})[host] || {};
    const swRuntime = (afterPing.body.runtime || {})[sw1] || {};
    ok(((hostRuntime.counters || {}).packetsOut || 0) > 0,
      'traffic the console generated is counted in the payload the UI publishes (' +
      ((hostRuntime.counters || {}).packetsOut || 0) + ' out)');
    ok(((swRuntime.counters || {}).packetsIn || 0) > 0,
      'and at the far end (' + ((swRuntime.counters || {}).packetsIn || 0) + ' in)');
    const shown = await console_run(host, ['enable', 'show interfaces eth0']);
    const outPackets = Number((text(shown).match(/output:\s*(\d+) packets/) || [0, 0])[1]);
    ok(outPackets > 0, 'and the console prints those packets on the port, not a second set (' +
      outPackets + ' out)');

    // The other direction: a payload flow, then the console's view of the port it left by.
    const flow = await request('POST', T + '/flows', { src: host, dst: sw1, proto: 'udp', bytes: 400 });
    ok(flow.status === 201 || flow.status === 200, 'the payload can open a flow (' + flow.status + ')');
    const shownAfterFlows = await console_run(host, ['enable', 'show interfaces eth0']);
    const outAfter = Number((text(shownAfterFlows).match(/output:\s*(\d+) packets/) || [0, 0])[1]);
    ok(outAfter > outPackets,
      'a frame the payload moved is counted on the port the console prints (' + outPackets + ' -> ' + outAfter + ')');
    const counters = await console_run(host, ['enable', 'show flows counters']);
    ok(/Flow counters in this lab/.test(text(counters)) && /\b400\b/.test(text(counters)),
      'and the console sees the flow the payload opened');

    console.log('\n2. The console answers at the instant it is asked:');
    // At 500 ms nothing has finished the 15 s + 15 s to Forwarding, so a port that will forward is
    // still Listening. With no instant the answer is the converged tree.
    // SW3 is the non-root bridge in this triangle, so it has a port that will be blocked and, before
    // the election has finished, ports that are still Listening.
    const early = await console_run(sw3, ['enable', 'show spanning-tree'], { atMs: 500 });
    eq(early.body.runAtMs, 500, 'the answer says which instant it describes');
    const sched = early.body.convergence || {};
    ok(Array.isArray(sched.entries) && sched.entries.length > 0,
      'and carries the convergence schedule it was computed from (' +
      ((sched.entries || []).length) + ' entries)');
    ok(/listening|learning/i.test(text(early)), 'at 500 ms the port has not reached Forwarding yet');
    const settled = await console_run(sw3, ['enable', 'show spanning-tree']);
    eq(settled.body.runAtMs, null, 'a request that names no instant answers "settled" and says so');
    ok(/forwarding|blocking|designated|root/i.test(text(settled)), 'and prints the converged tree');
    ok(!/listening|learning/i.test(text(settled)), 'not the one it printed for the earlier request');
    const bad = await console_run(sw3, ['enable', 'show version'], { atMs: -5 });
    eq(bad.status, 400, 'a negative instant is refused (' + bad.status + ')');
    const word = await console_run(sw3, ['enable', 'show spanning-tree'], { atMs: 'converged' });
    eq(word.status, 200, '"converged" is accepted as a spelling of settled');
    eq(word.body.runAtMs, null, 'and reported as settled, not as Infinity');

    console.log('\n3. The tree is recomputed at the session\'s instant before it is read:');
    // `dev.stp` belongs to whichever Simulator wrote it, and the session here has already derived its
    // own. Remove a cable through the REST surface, which touches the topology and no simulator at
    // all: a reader that trusts the tree it derived last now describes a loop that no longer exists.
    //
    // The session is already in enable mode, so these requests carry only the view. That matters:
    // a config command marks the session's planes stale (a console that was reconfigured must
    // re-derive), so a request that sends `enable` re-derives for free and hides the defect being
    // tested here.
    const view = function (extra) {
      return request('POST', T + '/config/' + sw3, Object.assign({ commands: ['show spanning-tree'] }, extra || {}));
    };
    const before = await view();
    const blockedBefore = (text(before).match(/blocking/g) || []).length;
    ok(blockedBefore > 0, 'the triangle has a blocked port before the cable is cut (' + blockedBefore + ')');
    const removed = await request('DELETE', T + '/links/' + firstCable);
    eq(removed.status, 200, 'a cable can be removed (' + removed.status + ')');
    const noLoop = await view();
    ok(!/blocking/.test(text(noLoop)),
      'the cached session re-derives the tree after a cable was removed elsewhere - no blocked port left');
    // Put it back, so the tree has a loop again for the instant question below.
    await request('POST', T + '/links', { a: { deviceId: sw1, iface: 'Fa0/1' }, b: { deviceId: sw2, iface: 'Fa0/1' } });
    // The cable cut is SW3's *root* port, so the tree has to heal through the port that was blocked.
    const cut = await request('POST', T + '/links/' + lastCable + '/state', { state: 'down', atMs: 20000 });
    ok(cut.status === 200, 'a cable can be cut at an instant (' + cut.status + ')');
    const healed = await console_run(sw3, ['enable', 'show spanning-tree']);
    ok(!/blocking/.test(text(healed)),
      'the cached session re-derives the tree after another request cut the cable - no blocked port left');
    const midCut = await console_run(sw3, ['enable', 'show spanning-tree'], { atMs: 25000 });
    eq(midCut.body.runAtMs, 25000, 'and it can still be asked about the seconds after the cut');
    ok(/listening|learning/i.test(text(midCut)),
      'where the healed port is still Listening, not Forwarding');

    console.log('\n4. The session is not pinned to whichever instant created it:');
    const fresh = await console_run(sw3, ['enable', 'show version']);
    eq(fresh.body.runAtMs, null, 'a later request with no instant is settled again');
    ok(!/at t=/.test(text(fresh)), 'and `show version` is not answered at an instant it never asked for');
  } finally {
    await stop(srv.child);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(function (e) {
  console.error('harness failed:', e && e.stack || e);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (x) {}
  console.log('\n' + passed + ' passed, ' + (failed + 1) + ' failed');
  process.exit(1);
});
