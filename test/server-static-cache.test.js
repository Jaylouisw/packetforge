'use strict';
// Static assets: five files, ~233 KB, and every load used to re-download all of it.
//
// `serveStatic` sent `Cache-Control: no-store` with no compression, so the browser could not keep
// app.js, canvas.js, faceplate.js or either stylesheet, and had no way to even ask whether they had
// changed. Now every asset carries an ETag and a Last-Modified, is gzipped when the client accepts
// it, and revalidates to an empty 304.
//
// The check that matters most here is the boring one: the ETag must be the same on two consecutive
// requests. The first version of this code computed it as `e4 && st.mtimeMs ? ... : Date.now()` -
// and the first argument of an `fs.stat` callback is the *error*, so that expression was always
// falsy and every response stamped a fresh ETag from the clock. Revalidation could never match, and
// it looked like it worked because the header was present and well-formed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const zlib = require('zlib');
const { spawn } = require('child_process');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; }
  else { failed++; console.log('  not ok - ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const ROOT = path.join(__dirname, '..');

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
function get(port, urlPath, headers) {
  return new Promise(function (resolve, reject) {
    const req = http.request({ host: '127.0.0.1', port: port, path: urlPath, method: 'GET', headers: headers || {} }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () { resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks) }); });
    });
    req.on('error', reject);
    req.end();
  });
}
function bodyOf(res) {
  return String(res.headers['content-encoding'] || '') === 'gzip' ? zlib.gunzipSync(res.raw) : res.raw;
}
function waitReady(port) {
  return new Promise(function (resolve, reject) {
    let left = 60;
    (function attempt() {
      const req = http.request({ host: '127.0.0.1', port: port, path: '/api/version' }, function (res) { res.resume(); resolve(); });
      req.on('error', function () { if (--left <= 0) return reject(new Error('server did not start')); setTimeout(attempt, 100); });
      req.end();
    })();
  });
}

(async function () {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-static-'));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(port), PF_DATA_DIR: dataDir }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stderr.on('data', function () {});

  try {
    await waitReady(port);

    console.log('');
    console.log('The ETag is stable, which is the whole point:');
    {
      const a = await get(port, '/app.js', {});
      const b = await get(port, '/app.js', {});
      ok(!!a.headers.etag, 'an ETag is present', String(a.headers.etag));
      ok(a.headers.etag === b.headers.etag, 'and two requests for an unchanged file agree on it (' + a.headers.etag + ' vs ' + b.headers.etag + ')');
      ok(!!a.headers['last-modified'], 'Last-Modified is present', String(a.headers['last-modified']));
      ok(String(a.headers['cache-control'] || '') === 'no-cache', 'Cache-Control asks for revalidation rather than forbidding storage', String(a.headers['cache-control']));
      ok(/Accept-Encoding/i.test(String(a.headers.vary || '')), 'Vary names Accept-Encoding', String(a.headers.vary));
      ok(Number(a.headers['content-length']) === a.raw.length, 'Content-Length matches the body actually sent', a.headers['content-length'] + ' vs ' + a.raw.length);
    }

    console.log('');
    console.log('Revalidation costs nothing:');
    {
      const first = await get(port, '/app.js', { 'Accept-Encoding': 'gzip' });
      const again = await get(port, '/app.js', { 'Accept-Encoding': 'gzip', 'If-None-Match': first.headers.etag });
      ok(again.status === 304, 'a matching If-None-Match gets 304', String(again.status));
      ok(again.raw.length === 0, 'with no body', String(again.raw.length));

      const byDate = await get(port, '/app.js', { 'If-Modified-Since': first.headers['last-modified'] });
      ok(byDate.status === 304, 'and so does If-Modified-Since from the Last-Modified we handed out', String(byDate.status));

      const stale = await get(port, '/app.js', { 'If-None-Match': 'W/"0-0"' });
      ok(stale.status === 200, 'a stale validator still gets the file', String(stale.status));
    }

    console.log('');
    console.log('Compression is real and lossless:');
    {
      const plain = await get(port, '/app.js', {});
      const gz = await get(port, '/app.js', { 'Accept-Encoding': 'gzip' });
      ok(gz.headers['content-encoding'] === 'gzip', 'Content-Encoding says gzip', String(gz.headers['content-encoding']));
      ok(bodyOf(gz).equals(plain.raw), 'and it gunzips to the exact bytes of the identity response');
      ok(gz.raw.length < plain.raw.length / 2, 'at under half the size', gz.raw.length + ' vs ' + plain.raw.length);
      ok(gz.headers.etag === plain.headers.etag, 'the ETag identifies the file, not the encoding');
      ok(Number(gz.headers['content-length']) === gz.raw.length, 'Content-Length is the compressed length', gz.headers['content-length'] + ' vs ' + gz.raw.length);
    }

    console.log('');
    console.log('Every asset the page loads is covered, with the right type:');
    {
      const expected = [
        ['/', 'text/html'],
        ['/style.css', 'text/css'],
        ['/app.js', 'application/javascript'],
        ['/canvas.js', 'application/javascript'],
        ['/faceplate.css', 'text/css']
      ];
      const wrong = [];
      for (const [p, type] of expected) {
        const r = await get(port, p, { 'Accept-Encoding': 'gzip' });
        if (r.status !== 200) { wrong.push(p + ': ' + r.status); continue; }
        if (String(r.headers['content-type'] || '').indexOf(type) !== 0) wrong.push(p + ': ' + r.headers['content-type']);
        if (!(r.headers['content-encoding'] === 'gzip' || r.raw.length < 1024)) wrong.push(p + ': not compressed and not small');
      }
      ok(wrong.length === 0, 'all five are served with the right type and compressed', wrong.join(' | '));
    }

    console.log('');
    console.log('The SPA fallback behaves like the assets do:');
    {
      const deep = await get(port, '/lab/anything', { 'Accept-Encoding': 'gzip', 'If-None-Match': await (async function () {
        const i = await get(port, '/', { 'Accept-Encoding': 'gzip' });
        return i.headers.etag;
      })() });
      ok(deep.status === 304, 'an unknown path falls back to index.html and revalidates', String(deep.status));
      const missing = await get(port, '/does-not-exist.js', {});
      ok(missing.status === 200, 'a missing asset falls back to the app rather than 404', String(missing.status));
      ok(String(missing.headers['content-type'] || '').indexOf('text/html') === 0, 'and is served as HTML', String(missing.headers['content-type']));
    }

    console.log('');
    console.log('Path traversal is still refused:');
    {
      const evil = await get(port, '/../server/index.js', {});
      const evilBody = bodyOf(evil).toString('utf8');
      ok(evil.status === 403 || evil.status === 404 || evilBody.indexOf('PacketForge server') === -1,
         'a path escaping web/ never returns server source', evil.status + ' ' + evilBody.slice(0, 40));
    }
  } finally {
    try { child.kill('SIGTERM'); } catch (e) { /* already gone */ }
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
})();
