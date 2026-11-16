'use strict';
// #1527: the process listened on every interface and never said so.
//
// `server.listen(PORT)` with no host binds 0.0.0.0/::, so a simulator started on a laptop in a cafe,
// or in a container behind a reverse proxy, was reachable from anything that could route to it - and
// the banner said `localhost`, so nothing in the log disagreed with the reader's assumption. The
// WebSocket door has been Origin-checked (#1629); this is the other half of the same posture: where
// the socket is, and being told where it is.
//
// The rules asserted here (docs/plans/server-exposure.md, step 1):
//
//   1. with PF_HOST unset the server listens on 127.0.0.1 : the port answers there, and it does not
//      answer on the machine's first non-loopback address;
//   2. the banner prints the address that was actually bound, and says it is this machine only;
//   3. PF_HOST=0.0.0.0 is still available for the container and the lab box: it answers on the
//      non-loopback address too, and the banner stops claiming the server is local-only;
//   4. a PF_HOST this machine does not own exits 1 with a message naming that address and PF_HOST -
//      not a stack trace, and not a message that blames the port;
//   5. an address with a port on the end (the copy-from-a-URL mistake) is named as such.
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  ok   ' + msg); }
  else { failed++; console.error('  FAIL ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const ROOT = path.join(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-bind-'));
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

function freePort() {
  return new Promise(function (resolve, reject) {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', function () {
      const p = s.address().port;
      s.close(function () { resolve(p); });
    });
  });
}

// The first address this machine answers to that is not loopback. CI containers often have none, and
// then the off-loopback half of a case is skipped rather than asserted against nothing.
function offLoopbackIPv4() {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] || []) {
      const v4 = a && (a.family === 'IPv4' || a.family === 4);
      if (v4 && !a.internal) return a.address;
    }
  }
  return null;
}
const OFF_LOOPBACK = offLoopbackIPv4();

function get(host, port, urlPath) {
  return new Promise(function (resolve) {
    const req = http.request({ host: host, port: port, path: urlPath, method: 'GET', timeout: 4000 },
      function (res) {
        res.resume();
        res.on('end', function () { resolve(res.statusCode); });
      });
    req.on('timeout', function () { req.destroy(); resolve(0); });
    req.on('error', function () { resolve(0); });
    req.end();
  });
}

// Is anything accepting a TCP connection at host:port? A refusal and a timeout both mean no, and a
// test that insisted on the exact errno would fail on whichever platform answers differently.
function accepts(host, port, ms) {
  return new Promise(function (resolve) {
    const s = net.connect(port, host);
    let done = false;
    const finish = function (v) {
      if (done) return;
      done = true;
      try { s.destroy(); } catch (e) { /* already gone */ }
      resolve(v);
    };
    s.setTimeout(ms || 3000, function () { finish(false); });
    s.on('connect', function () { finish(true); });
    s.on('error', function () { finish(false); });
  });
}

// The environment a test server gets. PF_HOST and PF_ALLOWED_ORIGINS are deleted rather than inherited:
// a developer who exported either one in their shell would otherwise be testing a different server.
function baseEnv(extra) {
  const env = Object.assign({}, process.env, { PF_DATA: DATA_DIR });
  delete env.PF_HOST;
  delete env.PF_ALLOWED_ORIGINS;
  return Object.assign(env, extra || {});
}

// Start the real server and collect what it said. Readiness is an HTTP answer below, not a line in the
// log: a line proves a process printed something, not that it is the one listening.
function startServer(port, extra) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: baseEnv(Object.assign({ PORT: String(port) }, extra || {})),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const out = { child: child, stdout: '', stderr: '', code: null };
  child.stdout.on('data', function (d) { out.stdout += d.toString(); });
  child.stderr.on('data', function (d) { out.stderr += d.toString(); });
  child.on('exit', function (c) { out.code = c; });
  out.log = function () { return out.stdout + out.stderr; };
  out.stop = function () {
    return new Promise(function (resolve) {
      if (out.code !== null) return resolve();
      child.on('exit', function () { resolve(); });
      try { child.kill('SIGTERM'); } catch (e) { return resolve(); }
      setTimeout(function () { try { child.kill('SIGKILL'); } catch (e) {} resolve(); }, 4000).unref();
    });
  };
  return out;
}

async function waitUntil(fn, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (fn()) return true;
    if (Date.now() > deadline) return false;
    await sleep(100);
  }
}

(async function () {
  console.log('\nThe default bind is loopback, and the banner says where it is:');
  {
    const port = await freePort();
    const s = startServer(port);
    try {
      const up = await waitUntil(function () { return s.code !== null || s.stdout.indexOf('Bind:') !== -1; }, 30000);
      ok(up && s.code === null, 'the server started with PF_HOST unset', 'code ' + s.code + ' ' + s.log().slice(-300));
      const answer = await get('127.0.0.1', port, '/api/version');
      ok(answer === 200, 'it answers on 127.0.0.1', 'status ' + answer);
      ok(s.stdout.indexOf('127.0.0.1:' + port) !== -1,
        'the banner prints the address that was bound',
        s.stdout.split('\n').filter(function (l) { return /Bind:|Local:/.test(l); }).join(' | '));
      ok(/this machine only/.test(s.stdout), 'and says it is not on the network');
      ok(/Local:\s+http:\/\/127\.0\.0\.1:/.test(s.stdout), 'Local: is the loopback URL, not the word localhost');
      if (OFF_LOOPBACK) {
        const off = await accepts(OFF_LOOPBACK, port, 3000);
        ok(off === false, 'nothing accepts a connection on ' + OFF_LOOPBACK + ' - it is not bound there');
      } else {
        console.log('  --   skipped: this machine has no non-loopback IPv4 address');
      }
    } finally {
      await s.stop();
    }
  }

  console.log('\nPF_HOST=0.0.0.0 is still how a container or a lab box asks to be reachable:');
  {
    const port = await freePort();
    const s = startServer(port, { PF_HOST: '0.0.0.0' });
    try {
      const up = await waitUntil(function () { return s.code !== null || s.stdout.indexOf('Bind:') !== -1; }, 30000);
      ok(up && s.code === null, 'the server started with PF_HOST=0.0.0.0', 'code ' + s.code + ' ' + s.log().slice(-300));
      ok(s.stdout.indexOf('0.0.0.0:' + port) !== -1, 'the banner names the address it was told to bind');
      ok(/this machine only/.test(s.stdout) === false, 'and no longer claims the server is local-only');
      ok(/reachable from other hosts/.test(s.stdout), 'it says the socket is on the network');
      const answer = await get('127.0.0.1', port, '/api/version');
      ok(answer === 200, 'loopback still works when every interface is bound', 'status ' + answer);
      if (OFF_LOOPBACK) {
        const off = await accepts(OFF_LOOPBACK, port, 4000);
        ok(off === true, 'and the non-loopback address accepts a connection now (' + OFF_LOOPBACK + ')');
      } else {
        console.log('  --   skipped: this machine has no non-loopback IPv4 address');
      }
    } finally {
      await s.stop();
    }
  }

  console.log('\nA PF_HOST this machine does not own is refused, and the message names it:');
  {
    // 192.0.2.0/24 is TEST-NET-1 (RFC 5737): reserved for documentation, owned by nothing, so binding it
    // fails the same way on every platform without depending on this machine's addresses.
    const port = await freePort();
    const s = startServer(port, { PF_HOST: '192.0.2.123' });
    const ended = await waitUntil(function () { return s.code !== null; }, 20000);
    const text = s.log();
    ok(ended, 'the process exited instead of hanging');
    ok(s.code === 1, 'with status 1, so a script notices', 'code ' + s.code);
    ok(text.indexOf('192.0.2.123') !== -1, 'the message names the address that was tried');
    ok(/PF_HOST/.test(text), 'and the variable that holds it');
    ok(/no such address/.test(text), 'it says the address is not on this machine');
    ok(/\n\s+at /.test(text) === false, 'no stack trace is printed');
    ok(/PF_HOST=0\.0\.0\.0/.test(text), 'it leaves the user a way to name a real interface');
    await s.stop();
  }

  console.log('\nThe copy-from-a-URL mistake is named as such:');
  {
    const port = await freePort();
    const s = startServer(port, { PF_HOST: '127.0.0.1:' + port });
    const ended = await waitUntil(function () { return s.code !== null; }, 20000);
    const text = s.log();
    ok(ended, 'a host and a port in PF_HOST does not start the server');
    ok(s.code === 1, 'it exits with status 1', 'code ' + s.code);
    ok(/port belongs in PORT/.test(text), 'the message says where the port belongs');
    ok(text.indexOf('[') === -1, 'and the value is not dressed up as an IPv6 literal with a port on top');
  }

  console.log('');
  console.log(passed + ' passed, ' + failed + ' failed');
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  process.exit(failed ? 1 : 0);
})();
