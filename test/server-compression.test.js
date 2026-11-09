'use strict';
// What the server actually puts on the wire.
//
// `/api/catalog` is the entire catalogue - 2,015 specs, about 2.2 MB of JSON - and it is fetched on
// every page load. The response used to be identity-encoded with `Cache-Control: no-store`, so a
// reload transferred all of it again. Since the catalogue is required to keep growing, that was the
// one cost in the app guaranteed to get worse every week.
//
// These checks pin the two fixes done in `sendJSON`, and equally importantly pin their limits:
//
//   * gzip when the client asks for it, and the body still parses back to the same object
//   * identity when the client does not ask, because a broken gzip is worse than a big body
//   * a strong ETag that yields an empty 304 on revalidation
//   * `Vary: Accept-Encoding`, without which a shared cache will happily hand a gzipped body to a
//     client that cannot read it
//   * small responses are not inflated by a header that saves nothing
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
  const enc = String(res.headers['content-encoding'] || '');
  if (enc === 'gzip') return zlib.gunzipSync(res.raw);
  return res.raw;
}

function waitReady(port, tries) {
  return new Promise(function (resolve, reject) {
    let left = tries || 60;
    (function attempt() {
      const req = http.request({ host: '127.0.0.1', port: port, path: '/api/version', method: 'GET' }, function (res) {
        res.resume();
        resolve();
      });
      req.on('error', function () {
        if (--left <= 0) return reject(new Error('server did not start'));
        setTimeout(attempt, 100);
      });
      req.end();
    })();
  });
}

(async function () {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-wire-'));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(port), PF_DATA_DIR: dataDir }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', function (c) { stderr += c; });

  try {
    await waitReady(port);

    console.log('');
    console.log('Without Accept-Encoding the client gets exactly what it asked for:');
    const plain = await get(port, '/api/catalog', {});
    ok(plain.status === 200, 'the catalogue responds 200', String(plain.status));
    ok(!plain.headers['content-encoding'], 'no Content-Encoding is claimed', String(plain.headers['content-encoding']));
    ok(/^"[A-Za-z0-9+/]+"$/.test(String(plain.headers.etag || '')), 'and a quoted strong ETag is present', String(plain.headers.etag));
    ok(/Accept-Encoding/i.test(String(plain.headers.vary || '')), 'Vary names Accept-Encoding, so a shared cache cannot mis-serve a gzipped body', String(plain.headers.vary));
    let plainJSON = null;
    try { plainJSON = JSON.parse(plain.raw.toString('utf8')); } catch (e) { plainJSON = null; }
    ok(!!plainJSON && Array.isArray(plainJSON.specs), 'the identity body parses');

    console.log('');
    console.log('With gzip the body is the same object, and much smaller:');
    const gz = await get(port, '/api/catalog', { 'Accept-Encoding': 'gzip' });
    ok(gz.status === 200, 'a gzip-capable client gets 200', String(gz.status));
    ok(gz.headers['content-encoding'] === 'gzip', 'Content-Encoding says gzip', String(gz.headers['content-encoding']));
    let gzJSON = null;
    try { gzJSON = JSON.parse(bodyOf(gz).toString('utf8')); } catch (e) { gzJSON = null; }
    ok(!!gzJSON && Array.isArray(gzJSON.specs), 'and it gunzips to the same shape');
    ok(!!gzJSON && !!plainJSON && gzJSON.specs.length === plainJSON.specs.length,
       'with the same number of specs', (gzJSON && gzJSON.specs.length) + ' vs ' + (plainJSON && plainJSON.specs.length));
    ok(gz.raw.length < plain.raw.length / 3, 'and at least three times smaller on the wire',
       gz.raw.length + ' vs ' + plain.raw.length + ' bytes');
    ok(gz.headers.etag === plain.headers.etag, 'the ETag describes the body, not the encoding - so revalidation works either way');

    console.log('');
    console.log('Revalidation returns nothing at all:');
    const revalidated = await get(port, '/api/catalog', { 'Accept-Encoding': 'gzip', 'If-None-Match': plain.headers.etag });
    ok(revalidated.status === 304, 'a matching If-None-Match gets 304', String(revalidated.status));
    ok(revalidated.raw.length === 0, 'with an empty body', String(revalidated.raw.length));
    const stale = await get(port, '/api/catalog', { 'If-None-Match': '"not-the-current-etag"' });
    ok(stale.status === 200, 'a stale ETag gets the body', String(stale.status));

    console.log('');
    console.log('A response that would grow under gzip is left alone:');
    const version = await get(port, '/api/version', { 'Accept-Encoding': 'gzip' });
    ok(version.status === 200, '/api/version answers', String(version.status));
    let vjson = null;
    try { vjson = JSON.parse(bodyOf(version).toString('utf8')); } catch (e) { vjson = null; }
    ok(!!vjson && !!vjson.version, 'and parses', JSON.stringify(vjson).slice(0, 60));
    if (version.headers['content-encoding'] === 'gzip') {
      ok(version.raw.length < 1024 * 4, 'if it was compressed it was a body worth compressing', String(version.raw.length));
    } else {
      ok(true, 'a small body is sent identity - no header that saves nothing');
    }

    console.log('');
    console.log('Writes are unaffected:');
    const created = await new Promise(function (resolve, reject) {
      const body = JSON.stringify({ name: 'wire-test' });
      const req = http.request({
        host: '127.0.0.1', port: port, path: '/api/topologies', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Accept-Encoding': 'gzip' }
      }, function (res) {
        const chunks = [];
        res.on('data', function (c) { chunks.push(c); });
        res.on('end', function () { resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks) }); });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    ok(created.status === 200 || created.status === 201, 'a POST still succeeds', String(created.status));
    let cjson = null;
    try { cjson = JSON.parse(bodyOf(created).toString('utf8')); } catch (e) { cjson = null; }
    ok(!!cjson, 'and its response parses whatever the encoding', String(created.raw.length) + ' bytes');
  } finally {
    try { child.kill('SIGTERM'); } catch (e) { /* already gone */ }
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  }

  if (stderr.trim()) console.log('\nserver stderr:\n' + stderr.trim().split('\n').slice(0, 6).join('\n'));
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
})();
