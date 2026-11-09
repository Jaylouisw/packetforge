'use strict';
// The endpoints that cannot change must not be rebuilt to answer "has anything changed?".
//
// `/api/catalog` is 4.4 MB of JSON. Before this, every request cost ~75 ms of server CPU: stringify
// the catalogue, hash it for the ETag, gzip it. The hash is *of the body*, so even a request that
// ended in `304 Not Modified` had to build the whole body first - a reload transferred nothing and
// cost as much as a first load.
//
// `sendImmutableJSON` serialises `/api/catalog` and `/api/media` once, keeps the body, the ETag and
// the gzipped bytes, and serves all three from memory. Measured: warm gzip 87 ms -> 4 ms, warm 304
// 75 ms -> 0.5 ms.
//
// What this file protects is not the speed, it is the correctness of a cache with no invalidation:
// the cached bytes must be the same bytes the uncached path would have produced, the ETag must
// identify them, and a request that asks for identity must still get identity.
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
function request(port, method, urlPath, headers, body) {
  return new Promise(function (resolve, reject) {
    const t0 = process.hrtime.bigint();
    const opts = { host: '127.0.0.1', port: port, path: urlPath, method: method, headers: headers || {} };
    if (body !== undefined) {
      opts.headers = Object.assign({}, opts.headers, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    }
    const req = http.request(opts, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          raw: Buffer.concat(chunks),
          ms: Number(process.hrtime.bigint() - t0) / 1e6
        });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-imm-'));
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
    console.log('The cached bytes are the real bytes:');
    const identity = await request(port, 'GET', '/api/catalog', {});
    const gzip = await request(port, 'GET', '/api/catalog', { 'Accept-Encoding': 'gzip' });
    ok(identity.status === 200 && gzip.status === 200, 'both encodings answer 200', identity.status + '/' + gzip.status);
    ok(bodyOf(gzip).equals(identity.raw), 'gunzipped catalogue is byte-identical to the identity response');
    let parsed = null;
    try { parsed = JSON.parse(identity.raw.toString('utf8')); } catch (e) { parsed = null; }
    ok(!!parsed && Array.isArray(parsed.specs) && parsed.specs.length > 2000, 'the body still parses as the catalogue', parsed && parsed.specs && parsed.specs.length);
    ok(!!parsed && parsed.categories && Object.keys(parsed.categories).length > 0, 'and still carries the category groups');
    ok(Number(identity.headers['content-length']) === identity.raw.length, 'Content-Length matches the identity body', identity.headers['content-length'] + ' vs ' + identity.raw.length);
    ok(Number(gzip.headers['content-length']) === gzip.raw.length, 'and the compressed length matches the compressed body', gzip.headers['content-length'] + ' vs ' + gzip.raw.length);

    console.log('');
    console.log('The ETag identifies the content, not the request:');
    const second = await request(port, 'GET', '/api/catalog', { 'Accept-Encoding': 'gzip' });
    ok(second.headers.etag === gzip.headers.etag, 'two requests agree on the ETag', gzip.headers.etag + ' vs ' + second.headers.etag);
    ok(second.raw.equals(gzip.raw), 'and on the bytes');
    const revalidated = await request(port, 'GET', '/api/catalog', { 'Accept-Encoding': 'gzip', 'If-None-Match': gzip.headers.etag });
    ok(revalidated.status === 304, 'a matching If-None-Match gets 304', String(revalidated.status));
    ok(revalidated.raw.length === 0, 'with no body', String(revalidated.raw.length));

    console.log('');
    console.log('A 304 no longer rebuilds the catalogue:');
    {
      // The regression this guards: computing the ETag from the body means a 304 costs the same as a
      // 200. The threshold is loose on purpose - a real regression is ~75 ms, a healthy run is under
      // a millisecond - so this fails loudly without being a benchmark that flakes on a busy runner.
      const times = [];
      for (let i = 0; i < 8; i++) {
        const r = await request(port, 'GET', '/api/catalog', { 'Accept-Encoding': 'gzip', 'If-None-Match': gzip.headers.etag });
        if (r.status !== 304) { ok(false, 'a warm revalidation stopped being a 304', String(r.status)); break; }
        times.push(r.ms);
      }
      times.sort(function (a, b) { return a - b; });
      const median = times[Math.floor(times.length / 2)];
      ok(median < 20, 'a warm revalidation costs well under 20 ms (' + median.toFixed(2) + ' ms)');
    }

    console.log('');
    console.log('One client asking for identity does not poison the cached gzip:');
    {
      const plainAfter = await request(port, 'GET', '/api/catalog', {});
      ok(!plainAfter.headers['content-encoding'], 'identity stays identity', String(plainAfter.headers['content-encoding']));
      ok(plainAfter.raw.equals(identity.raw), 'with the same bytes as the first identity response');
      const gzAfter = await request(port, 'GET', '/api/catalog', { 'Accept-Encoding': 'gzip' });
      ok(gzAfter.headers['content-encoding'] === 'gzip', 'and gzip stays gzip', String(gzAfter.headers['content-encoding']));
      ok(gzAfter.raw.equals(gzip.raw), 'with the same bytes as the first compressed response');
    }

    console.log('');
    console.log('A write elsewhere does not disturb the immutable pair:');
    {
      const created = await request(port, 'POST', '/api/topologies', { 'Accept-Encoding': 'gzip' }, JSON.stringify({ name: 'cache-test' }));
      ok(created.status === 200 || created.status === 201, 'a topology was created', String(created.status));
      const afterWrite = await request(port, 'GET', '/api/catalog', { 'Accept-Encoding': 'gzip' });
      ok(afterWrite.headers.etag === gzip.headers.etag, 'the catalogue ETag is unchanged - topologies are not the catalogue', String(afterWrite.headers.etag));
      ok(afterWrite.raw.equals(gzip.raw), 'and so are its bytes');
    }

    console.log('');
    console.log('The media catalogue gets the same treatment:');
    {
      const m1 = await request(port, 'GET', '/api/media', { 'Accept-Encoding': 'gzip' });
      const m2 = await request(port, 'GET', '/api/media', { 'Accept-Encoding': 'gzip', 'If-None-Match': m1.headers.etag });
      ok(m1.status === 200, 'media answers 200', String(m1.status));
      let mjson = null;
      try { mjson = JSON.parse(bodyOf(m1).toString('utf8')); } catch (e) { mjson = null; }
      ok(!!mjson && !!mjson.media && !!mjson.cages, 'with both vocabularies', Object.keys(mjson || {}).join(','));
      ok(m2.status === 304, 'and revalidates to 304', String(m2.status));
    }
  } finally {
    try { child.kill('SIGTERM'); } catch (e) { /* already gone */ }
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
})();
