'use strict';
// #1527, the HTTP half: the WebSocket refuses a foreign page, and the REST API hands that page the board anyway.
//
// The upgrade check (`server/ws.js`, step 2 of docs/plans/server-exposure.md) closed the socket door. But every
// JSON answer carried `Access-Control-Allow-Origin: *`, so the same page could `fetch('/api/topologies/default')`
// and read every device, cable and CLI transcript - a cheaper path than the socket the issue named. A wildcard
// cannot see who is asking; echoing the caller's own `Origin` back, and only when `allowOrigin()` accepts it, can.
//
// The rules asserted here (docs/plans/server-exposure.md, step 3):
//
//   1. a same-origin page gets its own origin echoed back, on board data as well as on the preflight;
//   2. a foreign `Origin` gets no `Access-Control-Allow-Origin` at all, so the browser withholds the body;
//   3. `Origin: null` (sandboxed iframe, data: URL) is treated as foreign, because it names no host;
//   4. a request with no `Origin` - curl, a native client, every other suite in test/ - is unaffected;
//   5. `/api/catalog` and `/api/media` keep the wildcard: they are fixed catalogues, carry no board, and are read
//      from other origins on purpose;
//   6. `PF_ALLOWED_ORIGINS` admits exactly the origin it names, over HTTP as over the socket.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  ok   ' + msg); }
  else { failed++; console.error('  FAIL ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const ROOT = path.join(__dirname, '..');
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

function freePort() {
  return new Promise(function (resolve, reject) {
    const p = net.createServer();
    p.unref(); p.on('error', reject);
    p.listen(0, '127.0.0.1', function () { const port = p.address().port; p.close(function () { resolve(port); }); });
  });
}

// One request, headers read as sent. `origin: null` means "send no Origin", which is what curl does.
function request(port, method, p, opts) {
  const o = opts || {};
  return new Promise(function (resolve) {
    const headers = {};
    if (o.origin !== null && o.origin !== undefined) headers.Origin = o.origin;
    if (o.host) headers.Host = o.host;
    const req = http.request({ host: '127.0.0.1', port: port, path: p, method: method, headers: headers },
      function (res) {
        let d = '';
        res.on('data', function (c) { d += c; });
        res.on('end', function () { resolve({ status: res.statusCode, headers: res.headers, text: d }); });
      });
    req.on('error', function (e) { resolve({ status: 0, headers: {}, text: e.message }); });
    req.end();
  });
}

function acao(r) {
  const v = r.headers['access-control-allow-origin'];
  return v === undefined ? null : String(v);
}

// One real server, on a free port and a scratch data directory. `extraEnv` is how PF_ALLOWED_ORIGINS arrives.
async function startServer(extraEnv) {
  const PORT = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cors-'));
  const env = Object.assign({}, process.env, { PORT: String(PORT), PF_DATA: dataDir });
  delete env.PF_ALLOWED_ORIGINS;
  Object.assign(env, extraEnv || {});
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')],
    { env: env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', function (d) { log += d; });
  child.stderr.on('data', function (d) { log += d; });
  const deadline = Date.now() + 20000;
  for (;;) {
    const r = await request(PORT, 'GET', '/api/version');
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

(async function main() {
  console.log('');
  console.log('Board data now answers only the page that is allowed to read it:');
  const a = await startServer({});
  try {
    const self = 'http://127.0.0.1:' + a.port;

    // 1. The app's own page. It sends this Origin on a POST; a GET usually sends none, and both must work.
    {
      const r = await request(a.port, 'GET', '/api/topologies/default', { origin: self });
      ok(r.status === 200, 'a same-origin page can read the board', 'status ' + r.status);
      ok(acao(r) === self, 'and its own origin is echoed back, not a wildcard', String(acao(r)));
      ok(String(r.headers.vary || '').toLowerCase().indexOf('origin') !== -1,
        'with Vary: Origin, so a cache cannot hand the echo to another page', String(r.headers.vary));
      ok(r.text.indexOf('devices') !== -1, 'the body is the board it asked for', JSON.stringify(r.text.slice(0, 80)));
    }

    // 2. The hole this closes: any page Jay visits.
    {
      const r = await request(a.port, 'GET', '/api/topologies/default', { origin: 'http://evil.example' });
      ok(acao(r) === null, 'a foreign page gets no Access-Control-Allow-Origin', String(acao(r)));
      ok(String(r.headers.vary || '').toLowerCase().indexOf('origin') !== -1,
        'and the answer still varies by Origin, so a cache cannot serve it to a page that is allowed',
        String(r.headers.vary));
    }

    // A second route that also names a board, so the rule is the endpoints it covers rather than one path.
    {
      const r = await request(a.port, 'GET', '/api/topologies/default/flows', { origin: 'http://evil.example' });
      ok(acao(r) === null, 'a foreign page gets no header on a second board route either', String(acao(r)));
    }

    // 3. `Origin: null` - a sandboxed iframe or a data: URL. It names nothing, so it matches nothing.
    {
      const r = await request(a.port, 'GET', '/api/topologies/default', { origin: 'null' });
      ok(acao(r) === null, 'Origin: null is treated as foreign', String(acao(r)));
    }

    // An Origin that is not a URL at all must not be echoed by accident.
    {
      const r = await request(a.port, 'GET', '/api/topologies/default', { origin: 'evil.example' });
      ok(acao(r) === null, 'an Origin that is not a URL is not echoed', String(acao(r)));
    }

    // 4. Nothing changed for a client that never had a CORS conversation to have.
    {
      const r = await request(a.port, 'GET', '/api/topologies/default', { origin: null });
      ok(r.status === 200, 'a request with no Origin is unaffected', 'status ' + r.status);
      ok(acao(r) === null, 'and needs no header to be readable by it', String(acao(r)));
      ok(r.text.indexOf('devices') !== -1, 'the body is still the board', JSON.stringify(r.text.slice(0, 80)));
    }

    // 5. The catalogues stay public: two fixed files of hardware, no board, read from other origins on purpose.
    {
      const r = await request(a.port, 'GET', '/api/catalog', { origin: 'http://evil.example' });
      ok(acao(r) === '*', '/api/catalog keeps its wildcard - it carries no board', String(acao(r)));
      const m = await request(a.port, 'GET', '/api/media', { origin: 'http://evil.example' });
      ok(acao(m) === '*', '/api/media keeps its wildcard too', String(acao(m)));
    }

    // 6. The preflight follows the same rule, or a cross-origin POST would be refused by the browser after the
    //    page had already been turned away - which reads as a broken server rather than a closed door.
    {
      const r = await request(a.port, 'OPTIONS', '/api/topologies/default', { origin: self });
      ok(r.status === 204, 'a same-origin preflight is answered', 'status ' + r.status);
      ok(acao(r) === self, 'and echoes the origin', String(acao(r)));
      ok(String(r.headers['access-control-allow-methods'] || '').indexOf('POST') !== -1,
        'and still names the methods', String(r.headers['access-control-allow-methods']));
    }
    {
      const r = await request(a.port, 'OPTIONS', '/api/topologies/default', { origin: 'http://evil.example' });
      ok(acao(r) === null, 'a foreign preflight gets no header', String(acao(r)));
    }

    // 7. None of that took the server down.
    {
      const r = await request(a.port, 'GET', '/api/version', { origin: null });
      ok(r.status === 200, 'the server is still answering', 'status ' + r.status);
    }
  } finally {
    await a.stop();
  }

  console.log('');
  console.log('PF_ALLOWED_ORIGINS admits exactly what it names, over HTTP as over the socket:');
  const b = await startServer({ PF_ALLOWED_ORIGINS: 'http://allowed.example:1234' });
  try {
    {
      const r = await request(b.port, 'GET', '/api/topologies/default', { origin: 'http://allowed.example:1234' });
      ok(acao(r) === 'http://allowed.example:1234', 'the listed origin is echoed back', String(acao(r)));
      ok(r.text.indexOf('devices') !== -1, 'and can read the board', JSON.stringify(r.text.slice(0, 80)));
    }
    {
      const r = await request(b.port, 'GET', '/api/topologies/default', { origin: 'http://other.example' });
      ok(acao(r) === null, 'an origin that is not listed gets no header', String(acao(r)));
    }
    {
      // Same origin means same as the Host it was addressed to: a page served at localhost:PORT sends
      // that Origin, and a browser connects to localhost:PORT, so both headers name the same host.
      const r = await request(b.port, 'GET', '/api/topologies/default',
        { host: 'localhost:' + b.port, origin: 'http://localhost:' + b.port });
      ok(acao(r) === 'http://localhost:' + b.port, 'and being listed does not stop same-origin from working',
        String(acao(r)));
    }
  } finally {
    await b.stop();
  }

  console.log('');
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
