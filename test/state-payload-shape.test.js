'use strict';
// Every state payload the server hands out has to be the same shape (#1307).
//
// #1304 added `state.verdicts` (one cable verdict per cable) and #1305 taught the canvas to draw from it. Both
// depend on a promise the server makes in one function: `fullState()`. A payload built anywhere else - a handler
// that returns `topo.serialize()`, a WebSocket frame assembled by hand, a new endpoint added next month - would
// arrive without verdicts, and every surface that reads them degrades to "unchecked" while the lab may be full of
// impossible cables. That is the failure this file exists to prevent, and it is checked three ways:
//
//   1. structurally, over the source: every `state:` in a response is `fullState(...)`;
//   2. over HTTP: every endpoint that returns a state returns a complete one, before and after a bad load;
//   3. over the WebSocket: the frame the browser actually lives on carries the same verdicts, on connect and on
//      every broadcast after a mutation.
//
// Plus a budget: `fullState()` now does work per cable, so its cost is asserted rather than assumed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Topology } = require('../engine');
const { validateTopology } = require('../engine/validation');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const ROOT = path.join(__dirname, '..');
const catalog = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
const SW = catalog.find(function (s) { return /CX 6000/.test(s.model); });

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
let PORT = 0;
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
function startServer(dataDir) {
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
        if (child.exitCode !== null) return reject(new Error('server exited: ' + log));
        if (Date.now() > deadline) return reject(new Error('no answer: ' + e.message + ' | ' + log));
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

// --- a dependency-free WebSocket client, because the project has none -------------------------------------------------
// The first frame can be late for reasons that have nothing to do with the payload: this suite runs on a container
// that is also building images, and on Node 22 it has timed out on the *connect* frame with no explanation in the
// output at all (#1415). A wait that fails must say what it saw and what the server said, and one retry is enough to
// tell a cold socket from a server that never answers.
function wsConnect(opts) {
  const timeoutHint = (opts && opts.timeoutHint) || null;
  return new Promise(function (resolve, reject) {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/',
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13'
      }
    });
    req.on('upgrade', function (res, socket) {
      const frames = [];
      const waiters = [];
      let buffer = Buffer.alloc(0);
      socket.on('data', function (chunk) {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          if (buffer.length < 2) return;
          const b0 = buffer[0];
          let len = buffer[1] & 0x7f;
          let offset = 2;
          if (len === 126) { if (buffer.length < 4) return; len = buffer.readUInt16BE(2); offset = 4; }
          else if (len === 127) { if (buffer.length < 10) return; len = buffer.readUInt32BE(6); offset = 10; }
          if (buffer.length < offset + len) return;
          const opcode = b0 & 0x0f;
          const payload = buffer.slice(offset, offset + len).toString('utf8');
          buffer = buffer.slice(offset + len);
          if (opcode !== 0x1) continue;
          let msg = null;
          try { msg = JSON.parse(payload); } catch (e) { msg = payload; }
          frames.push(msg);
          for (let i = waiters.length - 1; i >= 0; i--) {
            if (waiters[i].test(msg)) { waiters[i].resolve(msg); waiters.splice(i, 1); }
          }
        }
      });
      socket.on('error', function () {});
      resolve({
        socket: socket,
        frames: frames,
        // Resolve on the first frame (past or future) that satisfies `test`.
        next: function (test, timeoutMs) {
          const past = frames.filter(test)[0];
          if (past) return Promise.resolve(past);
          return new Promise(function (res2, rej2) {
            const waiter = { test: test, resolve: res2 };
            waiters.push(waiter);
            setTimeout(function () {
              const at = waiters.indexOf(waiter);
              if (at === -1) return;
              waiters.splice(at, 1);
              // What this connection actually received, and what the server said while it was waiting. Without
              // this the only thing a failing run could report was "nothing arrived", which is exactly the state
              // of knowledge it left us in.
              const seen = frames.length
                ? frames.map(function (m) { return String(m && m.type || m).slice(0, 40); }).join(', ')
                : 'nothing';
              const server = timeoutHint ? String(timeoutHint()).trim().split('\n').slice(-6).join(' | ') : 'no log';
              try { socket.destroy(); } catch (e) { /* already gone */ }
              rej2(new Error('no matching frame within ' + (timeoutMs || 5000) + 'ms; frames seen: ' + seen +
                '; server said: ' + server));
            }, timeoutMs || 5000);
          });
        },
        close: function () { try { socket.destroy(); } catch (e) {} }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// --- the shape -------------------------------------------------------------------------------------------------
function stateProblems(state, label) {
  const out = [];
  if (!state || typeof state !== 'object') return [label + ': no state object'];
  if (!Array.isArray(state.devices)) out.push(label + ': no devices array');
  if (!Array.isArray(state.links)) out.push(label + ': no links array');
  if (!state.verdicts) out.push(label + ': no verdicts');
  else {
    if (state.verdicts.checked !== true) out.push(label + ': verdicts not checked (' + state.verdicts.checked + ')');
    if (typeof state.verdicts.byLink !== 'object') out.push(label + ': verdicts.byLink is not an object');
    if (!Array.isArray(state.verdicts.issues)) out.push(label + ': verdicts.issues is not an array');
    if (typeof state.verdicts.errorCount !== 'number') out.push(label + ': no errorCount');
  }
  if (!state.runtime || typeof state.runtime !== 'object') out.push(label + ': no runtime');
  return out;
}

function doc(mediaId) {
  const t = new Topology();
  const a = t.addDevice(SW, 'a'); a.name = 'SW1';
  const b = t.addDevice(SW, 'b'); b.name = 'SW2';
  t.connect(a.id, '1/1/1', b.id, '1/1/1');
  const d = JSON.parse(JSON.stringify(t.serialize()));
  if (mediaId) d.links[0].mediaId = mediaId;
  return d;
}

(async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-shape-'));
  PORT = await freePort();

  console.log('');
  console.log('Structurally: a state is only ever built by fullState():');
  {
    const src = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
    // Every `state:` value handed to sendJSON / broadcast / wss.send, either directly or through a local that is
    // itself assigned from fullState(). Both are fine; a third would not be.
    const handed = src.match(/state:\s*[^,\n]+/g) || [];
    const locals = (src.match(/(?:const|let|var)\s+(\w+)\s*=\s*fullState\(/g) || []).map(function (m) {
      return /(\w+)\s*=/.exec(m)[1];
    });
    const bad = handed.filter(function (m) {
      // Ordinary control flow, not an exemption: this is matching text in the server source, not deciding that a
      // device or a port is outside a check.
      if (/state:\s*fullState\(/.test(m)) return false;
      const ident = /state:\s*([A-Za-z_$][\w$]*)\s*$/.exec(m);
      return !(ident && locals.indexOf(ident[1]) !== -1);
    });
    ok(handed.length >= 8, 'the server hands out state in ' + handed.length + ' places', String(handed.length));
    ok(bad.length === 0, 'and every one of them comes from fullState() (locals: ' + locals.join(', ') + ')',
      JSON.stringify(bad.slice(0, 3)));
    // The only topology serialisation that skips fullState() is the file on disk, which is a document, not a
    // payload. Device and link serialisations are different things and are not counted here.
    const topoSerialise = src.match(/\b(?:t|topo|newTopo|topologies\.get\([^)]*\))\.serialize\(\)/g) || [];
    ok(topoSerialise.length === 2, 'a topology is serialised bare exactly twice: the saved file and fullState()',
      JSON.stringify(topoSerialise));
  }

  const srv = await startServer(dataDir);
  try {
    console.log('');
    console.log('Over HTTP: every endpoint that returns a state returns a complete one:');
    {
      const problems = [];
      const collect = function (label, res) {
        const state = res.body && (res.body.state || (res.body.devices ? res.body : null));
        if (!state) return;         // runtime-only answers are checked below
        problems.push.apply(problems, stateProblems(state, label));
      };

      const created = await request('POST', '/api/topologies/default/load', doc());
      collect('load', created);
      const devP = await request('POST', '/api/topologies/default/devices', { vendor: SW.vendor, model: SW.model });
      collect('add device', devP);
      const devId = devP.body && (devP.body.device && devP.body.device.id);
      const linkP = await request('POST', '/api/topologies/default/links', {
        a: { deviceId: devId, iface: '1/1/2' }, b: { deviceId: devId, iface: '1/1/3' }
      });
      collect('add link', linkP);
      const cfg = await request('POST', '/api/topologies/default/config/' + devId, { commands: ['hostname SW9'] });
      collect('config', cfg);
      const iface = await request('POST', '/api/topologies/default/interfaces/' + devId + '/1/1/4', { enabled: false });
      collect('interface', iface);
      const got = await request('GET', '/api/topologies/default');
      collect('get', got);

      // A port whose name contains a slash. The URL the UI builds for a toggle used to 404 on these - most of the
      // catalogue - so the inspector's shutdown control did nothing at all (#1307).
      const plain = await request('POST', '/api/topologies/default/interfaces/' + devId + '/1/1/5',
        { enabled: false });
      ok(plain.status === 200, 'a slash-named port can be toggled with a plain path (' + plain.status + ')',
        String(plain.body).slice(0, 120));
      collect('toggle plain', plain);
      const enc = await request('POST', '/api/topologies/default/interfaces/' + devId + '/1%2F1%2F6',
        { enabled: false });
      ok(enc.status === 200, 'and with a percent-encoded name (' + enc.status + ')', String(enc.body).slice(0, 120));
      const offNow = await request('GET', '/api/topologies/default');
      const devNow = offNow.body.devices.filter(function (d) { return d.id === devId; })[0];
      const portStates = {};
      (devNow.interfaces || []).forEach(function (i) { portStates[i.name] = i.enabled; });
      ok(portStates['1/1/5'] === false && portStates['1/1/6'] === false,
        'and both ports really are down afterwards',
        JSON.stringify({ p5: portStates['1/1/5'], p6: portStates['1/1/6'] }));

      // The link-state endpoint used to put `state` in the same object twice: the link's 'up'/'down' string and
      // then the whole topology. It worked only because JavaScript keeps the later key.
      const linkId = offNow.body.links[0] && offNow.body.links[0].id;
      const pulled = await request('POST', '/api/topologies/default/links/' + linkId + '/state', { state: 'down' });
      ok(pulled.status === 200, 'a cable can be pulled (' + pulled.status + ')', String(pulled.body).slice(0, 120));
      ok(pulled.body && pulled.body.linkState === 'down', 'the answer names the cable state as linkState',
        JSON.stringify(pulled.body && pulled.body.linkState));
      ok(pulled.body && pulled.body.state && pulled.body.state.devices,
        'and the topology is still under state', JSON.stringify(pulled.body && typeof pulled.body.state));
      const ping = await request('POST', '/api/topologies/default/ping', { src: devId, dst: '1.1.1.1' });
      const pingState = ping.body && ping.body.state;
      if (pingState) collect('ping', ping);

      ok(problems.length === 0, 'every state payload carries verdicts, byLink, issues and errorCount',
        JSON.stringify(problems.slice(0, 4)));

      // A refused cable must reach every endpoint's payload, not just the load response.
      const badDoc = doc('10gbase-sr');
      await request('POST', '/api/topologies/default/load', badDoc);
      const after = await request('GET', '/api/topologies/default');
      const v = after.body.verdicts || {};
      ok(v.errorCount === 1, 'after loading an impossible cable, GET reports one error', JSON.stringify(v.errorCount));
      ok(v.byLink && Object.keys(v.byLink).length === 1, 'filed against the cable', JSON.stringify(Object.keys(v.byLink || {})));
      ok(stateProblems(after.body, 'get-after-bad').length === 0, 'and the payload is still complete',
        JSON.stringify(stateProblems(after.body, 'get-after-bad')));
    }

    console.log('');
    console.log('Over the WebSocket: the frame the browser lives on carries the same thing:');
    {
      // One retry on the connect frame. A cold socket that misses the first frame is indistinguishable, from here,
      // from a server that never answers - a second attempt with its own socket tells them apart, and the failure
      // message carries the frames and the server log either way.
      let ws = null;
      let first = null;
      let lastErr = null;
      for (let attempt = 0; attempt < 2 && !first; attempt++) {
        ws = await wsConnect({ timeoutHint: srv.log });
        try {
          first = await ws.next(function (m) { return m && m.type === 'topology'; }, 8000);
        } catch (e) {
          lastErr = e;
          ws.close();
          ws = null;
        }
      }
      if (!first && lastErr) throw lastErr;
      // A retry that was needed is said out loud. A flake that is quietly absorbed is a flake nobody ever fixes,
      // and this one is worth knowing about: it is the only reason a Node 22 container went red twice.
      if (lastErr) console.log('  note: the connect frame needed a second socket (' + lastErr.message.split(';')[0] + ')');
      ok(first && first.state, 'the server sends a topology frame on connect');
      ok(stateProblems(first.state, 'ws-connect').length === 0, 'and it is a complete state',
        JSON.stringify(stateProblems(first.state || {}, 'ws-connect')));
      ok(first.state.verdicts.errorCount === 1, 'with the refused cable already counted',
        JSON.stringify(first.state.verdicts.errorCount));

      // A mutation must broadcast a payload of the same shape - this is the path a browser actually renders.
      const mark = ws.frames.length;
      await request('POST', '/api/topologies/default/interfaces/' +
        (first.state.devices[0] && first.state.devices[0].id) + '/1/1/5', { enabled: false });
      const broadcast = await ws.next(function (m, i) {
        return m && m.type === 'topology' && ws.frames.indexOf(m) >= mark;
      }, 8000).catch(function () { return null; });
      ok(!!broadcast, 'a mutation is broadcast to the browser');
      ok(broadcast && stateProblems(broadcast.state, 'ws-broadcast').length === 0,
        'and the broadcast state is complete too',
        broadcast && JSON.stringify(stateProblems(broadcast.state || {}, 'ws-broadcast')));
      ok(broadcast && broadcast.state.verdicts.errorCount === 1,
        'still carrying the refused cable', broadcast && JSON.stringify(broadcast.state.verdicts.errorCount));
      ws.close();
    }
  } finally {
    await stop(srv.child);
  }

  console.log('');
  console.log('The work per payload is bounded:');
  {
    // fullState() now validates every cable, once per payload, and a payload is built for each response and each
    // broadcast. Measured on a 200-cable lab this is a few milliseconds; the budget is deliberately loose (it is
    // a tripwire for an accidental O(n^2), not a benchmark) and the numbers are printed so a regression is
    // visible even before it crosses the line.
    const t = new Topology();
    const devs = [];
    for (let i = 0; i < 30; i++) { const d = t.addDevice(SW, 'd' + i); d.name = 'SW' + i; devs.push(d); }
    const free = devs.map(function (d) {
      return [...d.interfaces.values()].filter(function (i) { return i.hardware && i.hardware.cage === 'rj45'; })
        .map(function (i) { return i.name; });
    });
    let cables = 0;
    for (let round = 0; cables < 200 && round < 40; round++) {
      for (let i = 0; i < devs.length && cables < 200; i++) {
        const j = (i + 1 + round) % devs.length;
        if (j === i || !free[i].length || !free[j].length) continue;
        t.connect(devs[i].id, free[i].shift(), devs[j].id, free[j].shift());
        cables++;
      }
    }
    ok(cables >= 150, 'the measured lab has ' + cables + ' cables', String(cables));
    const reps = 5;
    const t0 = process.hrtime.bigint();
    for (let k = 0; k < reps; k++) { t.serialize(); validateTopology(t); }
    const perPayload = Number(process.hrtime.bigint() - t0) / 1e6 / reps;
    ok(perPayload < 60, 'a state payload for ' + cables + ' cables costs ' + perPayload.toFixed(1) + ' ms (budget 60)',
      perPayload.toFixed(2));
  }

  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
