'use strict';
// #1527: the WebSocket upgrade is the door a web page can walk through.
//
// The server handed `upgrade` straight to `wss.handleUpgrade` and, on success, pushed the whole `default`
// board before the client had sent a byte. Nothing looked at `Origin`, and a WebSocket handshake is not
// subject to the same-origin policy on its own - so any page Jay visited could open ws://127.0.0.1:8000/
// and read every device, cable and CLI transcript on the board. RFC 6455 10.2 says a server should
// compare `Origin` against `Host` for exactly this reason.
//
// The rules asserted here (docs/plans/server-exposure.md, step 2):
//
//   1. no `Origin` at all is allowed - curl, a test harness and a native client send none;
//   2. a same-origin page is allowed, and is handed the board;
//   3. a foreign `Origin` is refused with 403 *before* any 101, and no board frame follows;
//   4. `Origin: null` is refused: a browser page sends it (a sandboxed iframe, a data: URL) and it names nothing;
//   5. PF_ALLOWED_ORIGINS is the one way to name a page served from elsewhere, and it admits that origin only.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  ok   ' + msg); }
  else { failed++; console.error('  FAIL ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const ROOT = path.join(__dirname, '..');
const CRLF = String.fromCharCode(13, 10);
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

function frameFrom(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  let len = buf[1] & 0x7f, off = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = buf.readUInt32BE(6); off = 10; }
  if (buf.length < off + len) return null;
  return { opcode: opcode, payload: buf.slice(off, off + len), consumed: off + len };
}

// A raw socket, because the point is what the server answers to a handshake it should not have accepted.
// `origin: null` sends no Origin header at all, which is what curl and the other suites do.
function handshake(port, opts) {
  const o = opts || {};
  return new Promise(function (resolve, reject) {
    const key = crypto.randomBytes(16).toString('base64');
    const lines = ['GET / HTTP/1.1', 'Host: ' + (o.host || ('127.0.0.1:' + port)), 'Upgrade: websocket',
      'Connection: Upgrade', 'Sec-WebSocket-Key: ' + key, 'Sec-WebSocket-Version: 13'];
    if (o.origin !== null && o.origin !== undefined) lines.push('Origin: ' + o.origin);
    const sock = net.connect(port, '127.0.0.1', function () {
      sock.write(lines.concat(['', '']).join(CRLF));
    });
    const st = { status: 0, head: '', body: '', frames: [], sock: sock, closed: false };
    let buf = Buffer.alloc(0);
    let handshook = false;
    sock.on('data', function (chunk) {
      buf = Buffer.concat([buf, chunk]);
      if (!handshook) {
        const i = buf.indexOf(CRLF + CRLF);
        if (i < 0) return;
        st.head = buf.slice(0, i).toString('utf8');
        st.status = parseInt((st.head.split(CRLF)[0] || '').split(' ')[1], 10);
        buf = buf.slice(i + 4);
        handshook = true;
        resolve(st);
      }
      if (st.status !== 101) { st.body += buf.toString('utf8'); buf = Buffer.alloc(0); return; }
      for (;;) {
        const f = frameFrom(buf);
        if (!f) break;
        buf = buf.slice(f.consumed);
        if (f.opcode === 0x1) st.frames.push(f.payload.toString('utf8'));
      }
    });
    sock.on('close', function () { st.closed = true; });
    sock.on('error', function () {});
    setTimeout(function () { reject(new Error('handshake timeout')); }, 5000);
  });
}

function freePort() {
  return new Promise(function (resolve, reject) {
    const p = net.createServer();
    p.unref(); p.on('error', reject);
    p.listen(0, '127.0.0.1', function () { const port = p.address().port; p.close(function () { resolve(port); }); });
  });
}

function httpGet(port, p) {
  return new Promise(function (resolve) {
    http.get({ host: '127.0.0.1', port: port, path: p }, function (res) {
      let d = '';
      res.on('data', function (c) { d += c; });
      res.on('end', function () { resolve({ status: res.statusCode, text: d }); });
    }).on('error', function (e) { resolve({ status: 0, text: e.message }); });
  });
}

// One real server, on a free port and a scratch data directory. `extraEnv` is how PF_ALLOWED_ORIGINS arrives.
async function startServer(extraEnv) {
  const PORT = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-ws-origin-'));
  const env = Object.assign({}, process.env, { PORT: String(PORT), PF_DATA: dataDir });
  delete env.PF_ALLOWED_ORIGINS;
  Object.assign(env, extraEnv || {});
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')],
    { env: env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', function (d) { log += d; });
  child.stderr.on('data', function (d) { log += d; });
  // One minute, not twenty seconds (#1720). At PF_TEST_CONCURRENCY=10 ten suites start a server
  // at once, a cold start measured 3.5-4.8 s, and one suite that restarts its server spent 27 s.
  const deadline = Date.now() + 60000;
  for (;;) {
    const r = await httpGet(PORT, '/api/version');
    if (r.status === 200) break;
    if (child.exitCode !== null) throw new Error('server exited: ' + log);
    if (Date.now() > deadline) throw new Error('no answer: ' + log);
    await sleep(100);
  }
  return {
    port: PORT,
    log: function () { return log; },
    stop: async function () {
      try { child.kill('SIGTERM'); } catch (e) {}
      await sleep(300);
      try { child.kill('SIGKILL'); } catch (e) {}
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
    }
  };
}

function boards(st) {
  return st.frames.map(function (f) { try { return JSON.parse(f); } catch (e) { return null; } })
    .filter(function (m) { return m && m.type === 'topology'; });
}

(async function main() {
  console.log('');
  console.log('A page from somewhere else is turned away at the handshake:');
  const a = await startServer({});
  try {
    // 1. No Origin: curl, a native client, and every other suite in test/.
    {
      const c = await handshake(a.port, { origin: null });
      ok(c.status === 101, 'no Origin is allowed', 'status ' + c.status);
      await sleep(250);
      ok(boards(c).length === 1 && boards(c)[0].topologyId === 'default',
        'and is handed the board, as it always was', String(c.frames.length));
      c.sock.destroy();
    }

    // 2. The app's own page: the scheme, host and port it was served from match the Host it connected to.
    {
      const c = await handshake(a.port, { host: 'localhost:' + a.port, origin: 'http://localhost:' + a.port });
      ok(c.status === 101, 'a same-origin page is allowed', 'status ' + c.status);
      await sleep(250);
      ok(boards(c).length === 1, 'and is handed the board', String(c.frames.length));
      c.sock.destroy();
    }

    // 3. The hole itself: any page Jay visits.
    {
      const c = await handshake(a.port, { origin: 'http://evil.example' });
      ok(c.status === 403, 'a foreign Origin is refused', 'status ' + c.status + ' / ' + c.head.split(CRLF)[0]);
      ok(c.head.indexOf('101') === -1, 'without ever switching protocols', c.head.split(CRLF)[0]);
      await sleep(250);
      ok(c.frames.length === 0, 'and no board frame is sent', String(c.frames.length));
      ok(/Origin/.test(c.body), 'the refusal names the header that was wrong', JSON.stringify(c.body.slice(0, 240)));
      c.sock.destroy();
    }

    // A different port on the same host is a different origin - the port is part of it.
    {
      const c = await handshake(a.port, { host: '127.0.0.1:' + a.port, origin: 'http://127.0.0.1:1' });
      ok(c.status === 403, 'the same host on a different port is not the same origin', 'status ' + c.status);
      c.sock.destroy();
    }

    // 4. `Origin: null` - a sandboxed iframe or a data: URL. It names nothing, so it matches nothing.
    {
      const c = await handshake(a.port, { origin: 'null' });
      ok(c.status === 403, 'Origin: null is refused', 'status ' + c.status);
      c.sock.destroy();
    }

    // An Origin that is not a URL at all must not be allowed by accident.
    {
      const c = await handshake(a.port, { origin: 'evil.example' });
      ok(c.status === 403, 'an Origin that is not a URL is refused', 'status ' + c.status);
      c.sock.destroy();
    }

    // 5. None of that took the server down.
    {
      const r = await httpGet(a.port, '/api/version');
      ok(r.status === 200, 'the server is still answering after the refusals', 'status ' + r.status);
    }
  } finally {
    await a.stop();
  }

  console.log('');
  console.log('PF_ALLOWED_ORIGINS is the way to name a page served from elsewhere:');
  const b = await startServer({ PF_ALLOWED_ORIGINS: 'http://allowed.example:1234' });
  try {
    {
      const c = await handshake(b.port, { origin: 'http://allowed.example:1234' });
      ok(c.status === 101, 'the listed origin is allowed', 'status ' + c.status);
      await sleep(250);
      ok(boards(c).length === 1, 'and is handed the board', String(c.frames.length));
      c.sock.destroy();
    }
    // The list admits what it names and nothing else.
    {
      const c = await handshake(b.port, { origin: 'http://other.example' });
      ok(c.status === 403, 'an origin that is not listed is still refused', 'status ' + c.status);
      c.sock.destroy();
    }
    {
      const c = await handshake(b.port, { host: 'localhost:' + b.port, origin: 'http://localhost:' + b.port });
      ok(c.status === 101, 'and being listed does not stop same-origin from working', 'status ' + c.status);
      c.sock.destroy();
    }
  } finally {
    await b.stop();
  }

  console.log('');
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
