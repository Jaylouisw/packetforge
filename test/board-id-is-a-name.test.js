'use strict';
// A board that is created has to be reachable by the name it was created with.
//
// The id arrives in a JSON body, which is not a URL: nothing about it is a string and nothing about it is bounded.
// Three failures came out of that one gap (#1506):
//
//   * `{"id": 123}` answered 201 and put the board in the map under the *number* 123, and wrote `123.json`. Every
//     later request - GET, DELETE, save - builds its key from a URL segment, which is always a string, so the board
//     that had just been created answered 404 to the name it was created with. `{"id": true}` did the same.
//   * `{"id": {"a": 1}}` was worse: the key was an object, `GET /api/topologies` handed it back inside `ids`, and
//     the file was named `_object_Object_-c1d44ff0.json`.
//   * a 400-character id was accepted, and every save after it failed with `ENOENT ... <name>.json.tmp` - the file
//     name is longer than the filesystem allows - so the API acknowledged a board the disk never held.
//
// These are the same shape as #1315 (a board called `a b` could be created and never reached): a name is a name.
// So this suite asserts the rule, not today's strings: a name the caller chose is a string, it is bounded, it has no
// control characters, it is not a bare dot, and if it is accepted it is both reachable *and* on disk afterwards.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const ROOT = path.join(__dirname, '..');
const MAX = 128;
let PORT = 0;

function freePort() {
  return new Promise(function (resolve, reject) {
    const p = net.createServer();
    p.unref();
    p.on('error', reject);
    p.listen(0, '127.0.0.1', function () {
      const port = p.address().port;
      p.close(function () { resolve(port); });
    });
  });
}

function request(method, urlPath, body) {
  return new Promise(function (resolve, reject) {
    const payload = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: urlPath, method: method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}
    }, function (res) {
      let data = '';
      res.on('data', function (c) { data += c; });
      res.on('end', function () {
        let parsed = data;
        try { parsed = JSON.parse(data); } catch (e) { /* keep the raw text */ }
        resolve({ status: res.statusCode, body: parsed, text: data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// A body that is not an object: `readBody()` hands back whatever `JSON.parse` returned, so `null` is a real
// request a client can make, and `body.id` on it was a TypeError answered as
// `400 {"error":"Cannot read properties of null (reading 'id')"}` (#1506).
function requestRaw(method, urlPath, raw) {
  return new Promise(function (resolve, reject) {
    const payload = Buffer.from(raw);
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: urlPath, method: method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length }
    }, function (res) {
      let data = '';
      res.on('data', function (c) { data += c; });
      res.on('end', function () {
        let parsed = data;
        try { parsed = JSON.parse(data); } catch (e) { /* keep the raw text */ }
        resolve({ status: res.statusCode, body: parsed, text: data });
      });
    });
    req.on('error', reject);
    req.write(payload);
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

function ids(body) {
  return (body && Array.isArray(body.ids)) ? body.ids : [];
}

(async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-boardid-'));
  PORT = await freePort();
  let srv = await startServer(dataDir);

  try {
    // --- ids that are not names -------------------------------------------------
    const rejected = [
      [{ id: 123 }, 'a number', /has to be a string/i],
      [{ id: true }, 'a boolean', /has to be a string/i],
      [{ id: { a: 1 } }, 'an object', /has to be a string/i],
      [{ id: ['a'] }, 'an array', /has to be a string/i],
      [{ id: '   ' }, 'whitespace only', /cannot be empty/i],
      [{ id: '.' }, 'a bare dot', /cannot be/i],
      [{ id: '..' }, 'a bare double dot', /cannot be/i],
      [{ id: 'line\nbreak' }, 'a control character', /control characters/i],
      [{ id: 'x'.repeat(MAX + 1) }, String(MAX + 1) + ' characters', /limited to 128/i]
    ];

    const before = ids((await request('GET', '/api/topologies')).body);
    for (const [payload, what, wording] of rejected) {
      const r = await request('POST', '/api/topologies', payload);
      ok(r.status === 400, 'a board named with ' + what + ' is refused with 400', 'status ' + r.status);
      ok(!!(r.body && wording.test(String(r.body.error))),
        '  and the refusal says which rule it broke: ' + what, 'error ' + JSON.stringify(r.body && r.body.error));
    }
    const after = ids((await request('GET', '/api/topologies')).body);
    ok(JSON.stringify(before) === JSON.stringify(after), 'a refused create changes nothing', JSON.stringify(after));

    const list = await request('GET', '/api/topologies');
    ok(ids(list.body).every(function (k) { return typeof k === 'string'; }),
      'the list of boards is a list of names (every id is a string)', JSON.stringify(ids(list.body)));
    ok(!ids(list.body).some(function (k) { return /^_object_|^true$|^123$/.test(k); }),
      '  and none of the refused names got in', JSON.stringify(ids(list.body)));

    // --- ids that are names ------------------------------------------------------
    const generated = await request('POST', '/api/topologies', {});
    ok(generated.status === 201 && typeof generated.body.id === 'string' && /^topo-/.test(generated.body.id),
      'an empty body still means "make me one"', JSON.stringify(generated.body && generated.body.id));

    const emptyId = await request('POST', '/api/topologies', { id: '' });
    ok(emptyId.status === 201 && typeof emptyId.body.id === 'string' && emptyId.body.id.length > 0,
      '  and so does an empty string (the client asks for a generated name that way)', String(emptyId.status));

    const noBody = await request('POST', '/api/topologies', undefined);
    ok(noBody.status === 201 && typeof noBody.body.id === 'string',
      '  and so does no body at all', String(noBody.status));

    for (const name of ['lab 1', 'a/b', 'Board #1', 'ok.name_1', 'x'.repeat(MAX)]) {
      const created = await request('POST', '/api/topologies', { id: name });
      const label = name.length > 20 ? name.length + ' characters' : JSON.stringify(name);
      ok(created.status === 201, 'a board named ' + label + ' is created', 'status ' + created.status + ' ' + created.text.slice(0, 80));
      const read = await request('GET', '/api/topologies/' + encodeURIComponent(name));
      ok(read.status === 200, '  and it can be reached by the name it was created with', 'status ' + read.status);
      const again = await request('POST', '/api/topologies', { id: name });
      ok(again.status === 201 && again.body.id === name,
        '  and creating it twice is idempotent, not a second board', JSON.stringify(again.body && again.body.id));
    }

    // The name that fits is not just accepted, it is written: a file whose base name is longer than the
    // filesystem allows is where the 400-character id used to fail, silently, on every save after the first.
    const topoDir = path.join(dataDir, 'topologies');
    const files = fs.existsSync(topoDir) ? fs.readdirSync(topoDir).filter(function (f) { return /\.json$/.test(f); }) : [];
    ok(files.length > 0, 'accepted boards exist on disk (' + files.length + ' file(s))');
    ok(files.every(function (f) { return Buffer.byteLength(f) < 255; }),
      '  and every file name fits what the filesystem allows', files.filter(function (f) { return Buffer.byteLength(f) >= 255; }).join(','));
    ok(!files.some(function (f) { return /passwd|^true\.json$|^123\.json$/.test(f); }),
      '  and no refused name was written', files.join(','));

    // --- a body that parses but is not an object --------------------------------
    const RUNTIME_WORDS = /Cannot read propert|is not a function|is not iterable|of null \(reading|\[object Object\]/;
    for (const [what, raw] of [['null', 'null'], ['a number', '123'], ['a string', '"hello"'], ['an array', '[]'],
      ['true', 'true']]) {
      const r = await requestRaw('POST', '/api/topologies', raw);
      ok(!RUNTIME_WORDS.test(r.text), 'a body that is ' + what + ' does not answer in the runtime\'s words',
        r.text.slice(0, 90));
      ok(r.status === 201 && typeof r.body.id === 'string' && r.body.id.length > 0,
        '  and it means "make me one", like an empty body does', 'status ' + r.status + ' ' + r.text.slice(0, 80));
    }

    // --- the same names after a restart -----------------------------------------
    await stop(srv.child);
    srv = await startServer(dataDir);
    const reloaded = ids((await request('GET', '/api/topologies')).body);
    ok(reloaded.indexOf('x'.repeat(MAX)) !== -1, 'a ' + MAX + '-character board survives a restart');
    ok(reloaded.indexOf('lab 1') !== -1, '  and so does one with a space in its name', JSON.stringify(reloaded.slice(-4)));
    const readBack = await request('GET', '/api/topologies/' + encodeURIComponent('x'.repeat(MAX)));
    ok(readBack.status === 200, '  and it is readable, not merely listed', 'status ' + readBack.status);
  } finally {
    await stop(srv.child);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* the temp dir is not the point */ }
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
})().catch(function (e) {
  console.error('suite failed: ' + (e && e.stack || e));
  process.exitCode = 1;
});
