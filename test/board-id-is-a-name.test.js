'use strict';
// A board is addressed by its name, so the name has to be one (#1506).
//
// `POST /api/topologies` took the id from a JSON body, which is not a URL, and stored it unexamined:
//
//   {"id": 123}            -> a NUMBER map key, `123.json` written, and `GET /api/topologies/123` 404s, because
//                             every lookup builds its key from a URL segment, i.e. a string
//   {"id": {"a": 1}}       -> `_object_Object_-<hash>.json`, and the list endpoint hands the caller an object
//   {"id": "b" x 400}      -> 201, then every save fails with ENOENT and the only signal is a console.error
//
// i.e. a board that exists and cannot be reached by the name it was created with, a list of things that are not
// names, and a board the API acknowledged that the disk never holds.
//
// The rule under test is stated once in the handler and named in the refusal, so the caller learns which rule it
// broke rather than being told "invalid id".
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-board-id-'));
const TOPO_DIR = path.join(dataDir, 'topologies');
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

// The port is an argument, not always the module-level PORT, because the one assertion that proves the
// wait honours the deadline it was given has to address a port with nothing listening on it (#1720).
function request(method, urlPath, body, rawBody, onPort) {
  return new Promise(function (resolve, reject) {
    const payload = rawBody !== undefined ? rawBody : (body === undefined ? null : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port: onPort || PORT, path: urlPath, method: method,
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

// One minute, not twenty seconds (#1720). At PF_TEST_CONCURRENCY=10 ten suites start a server at
// once, and this suite alone has measured 26.8 s inside that run, so the restart below had a couple
// of seconds of headroom and ran out of it on 2026-11-16 (10227 assertions, one red suite).
const START_DEADLINE_MS = 60000;

// A wall-clock deadline, not an attempt count (#1242, #1714) - and it takes the deadline as an
// argument, so that "gives up too early" and "never gives up" are both things a test can assert.
function waitReady(port, deadlineMs, child, logOf) {
  const started = Date.now();
  return new Promise(function (resolve, reject) {
    (function poll() {
      request('GET', '/api/catalog', undefined, undefined, port).then(function (r) {
        if (r.status === 200) return resolve(null);
        throw new Error('status ' + r.status);
      }).catch(function (e) {
        const log = logOf ? logOf() : '';
        if (child && child.exitCode !== null) return reject(new Error('server exited (' + child.exitCode + '): ' + log));
        if (Date.now() - started >= deadlineMs) {
          return reject(new Error('server did not start within ' + deadlineMs + ' ms (last error: ' +
            ((e && (e.code || e.message)) || 'no reply') + ') | ' + log));
        }
        setTimeout(poll, 100);
      });
    })();
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
  return waitReady(PORT, START_DEADLINE_MS, child, function () { return log; })
    .then(function () { return { child: child, log: function () { return log; } }; });
}

function stop(child, signal) {
  return new Promise(function (resolve) {
    child.on('exit', function () { resolve(); });
    try { child.kill(signal || 'SIGTERM'); } catch (e) { resolve(); }
    setTimeout(function () { try { child.kill('SIGKILL'); } catch (e) {} resolve(); }, 5000);
  });
}

function savedFiles() {
  if (!fs.existsSync(TOPO_DIR)) return [];
  return fs.readdirSync(TOPO_DIR).filter(function (f) { return /\.json$/.test(f); });
}

// The path segment a caller would use to reach a board by name.
function boardPath(id) { return '/api/topologies/' + encodeURIComponent(id); }

const longId = 'b'.repeat(129);
const longestOk = 'c'.repeat(128);

// Nine shapes a board name cannot be, and the rule each refusal has to name.
const REFUSED = [
  { label: 'a number',        body: { id: 123 },        rule: /string/ },
  { label: 'a boolean',       body: { id: true },       rule: /string/ },
  { label: 'an object',       body: { id: { a: 1 } },   rule: /string/ },
  { label: 'an array',        body: { id: [1, 2] },     rule: /string/ },
  { label: 'whitespace only', body: { id: '   ' },      rule: /blank/ },
  { label: 'a bare dot',      body: { id: '.' },        rule: /dot/ },
  { label: 'a bare dot dot',  body: { id: '..' },       rule: /dot/ },
  { label: 'a control char',  body: { id: 'a\u0001b' }, rule: /control/ },
  { label: '129 characters',  body: { id: longId },     rule: /128/ }
];

(async function main() {
  PORT = await freePort();

  // A bound nothing exercises is how the twenty-second cap came back (#1720), so this asserts on the
  // wait itself, against a port that has no server behind it: it must give up at the deadline it was
  // given, and say which one that was.
  {
    const closedPort = await freePort();
    const failedToStart = await waitReady(closedPort, 400)
      .then(function () { return null; }, function (e) { return e; });
    ok(/did not start within 400 ms/.test(failedToStart ? failedToStart.message : ''),
      'a port with no server behind it fails at the deadline it was given',
      failedToStart ? failedToStart.message : 'resolved instead of failing');
  }

  let srv = await startServer();

  console.log('');
  console.log('A name is a name: nine shapes are refused, and each refusal says which rule it broke');
  {
    const before = (await request('GET', '/api/topologies')).body.ids.slice().sort();
    for (const c of REFUSED) {
      const r = await request('POST', '/api/topologies', c.body);
      ok(r.status === 400, c.label + ' is refused (' + r.status + ')', JSON.stringify(r.body));
      ok(!!r.body && r.body.field === 'id', c.label + ': the answer names the field', JSON.stringify(r.body));
      ok(!!r.body && c.rule.test(String(r.body.error || '')),
        c.label + ': and names the rule (' + (r.body && r.body.error) + ')');
    }
    const after = (await request('GET', '/api/topologies')).body.ids.slice().sort();
    ok(JSON.stringify(after) === JSON.stringify(before),
      'a refused create changes nothing (' + before.length + ' boards before and after)');
    const files = savedFiles();
    ok(files.filter(function (f) { return /^123\.json$/.test(f); }).length === 0,
      'and no board file was written for a refused name', files.join(','));
  }

  console.log('');
  console.log('The list is a list of names');
  {
    const r = await request('GET', '/api/topologies');
    ok(r.status === 200, 'the list answers');
    ok(Array.isArray(r.body.ids), 'with an array of ids');
    ok(r.body.ids.every(function (i) { return typeof i === 'string'; }),
      'every id is a string', JSON.stringify(r.body.ids));
    ok(!r.body.ids.some(function (i) { return i === longId || i === '   ' || i === '.' || i === '..'; }),
      'and none of the refused names is in it', JSON.stringify(r.body.ids));
  }

  console.log('');
  console.log('No id still means "make me one"');
  {
    const a = await request('POST', '/api/topologies', {});
    ok(a.status === 201, 'an empty body creates a board (' + a.status + ')');
    ok(!!a.body && typeof a.body.id === 'string' && a.body.id.length > 0,
      'with a generated name', JSON.stringify(a.body && a.body.id));

    const b = await request('POST', '/api/topologies', { id: '' });
    ok(b.status === 201, 'so does an empty string (' + b.status + ')');
    ok(!!b.body && typeof b.body.id === 'string' && b.body.id.length > 0,
      'and it generates one rather than creating a board called nothing', JSON.stringify(b.body && b.body.id));

    const c = await request('POST', '/api/topologies', undefined, '');
    ok(c.status === 201, 'and so does no body at all (' + c.status + ')');

    const d = await request('POST', '/api/topologies', { id: null });
    ok(d.status === 201 && !!d.body && typeof d.body.id === 'string',
      'a null id is "make me one" too (' + d.status + ')');
  }

  console.log('');
  console.log('Five names that are names: each board is reachable by the name it was created with');
  const accepted = ['plain-name', 'a b', 'a/b', 'Board #1', longestOk];
  for (const id of accepted) {
    const shown = id.length > 20 ? id.slice(0, 8) + '...(' + id.length + ')' : id;
    const created = await request('POST', '/api/topologies', { id: id });
    ok(created.status === 201 && !!created.body && created.body.id === id,
      JSON.stringify(shown) + ' is created under exactly that name (' + created.status + ')');
    const read = await request('GET', boardPath(id));
    ok(read.status === 200, '  and GET by that name reaches it (' + read.status + ')');
    const listed = (await request('GET', '/api/topologies')).body.ids;
    ok(listed.indexOf(id) !== -1, '  and it is in the list');
  }

  {
    const again = await request('POST', '/api/topologies', { id: 'a b' });
    ok(again.status === 201 && again.body.id === 'a b',
      'creating an existing name is idempotent (' + again.status + ')');
  }

  console.log('');
  console.log('The files on disk are names the filesystem can hold');
  {
    const files = savedFiles();
    ok(files.length > 0, 'boards were written (' + files.length + ' files)');
    ok(files.every(function (f) { return Buffer.byteLength(f, 'utf8') < 255; }),
      'every file name is inside NAME_MAX',
      files.filter(function (f) { return Buffer.byteLength(f, 'utf8') >= 255; }).join(','));
    ok(files.some(function (f) { return /^c{128}/.test(f); }),
      'the 128-character name has a file', files.join(','));
    const bodies = files.map(function (f) {
      try { return JSON.parse(fs.readFileSync(path.join(TOPO_DIR, f), 'utf8')); } catch (e) { return null; }
    }).filter(Boolean);
    ok(bodies.every(function (b) { return typeof b.id === 'string'; }),
      'and every saved board records a string name',
      bodies.filter(function (b) { return typeof b.id !== 'string'; }).map(function (b) { return String(b.id); }).join(','));
  }

  await stop(srv.child, 'SIGTERM');

  console.log('');
  console.log('And after a restart the awkward names are still there');
  srv = await startServer();
  try {
    const ids = (await request('GET', '/api/topologies')).body.ids;
    ok(ids.indexOf(longestOk) !== -1, 'the 128-character board is listed');
    ok(ids.indexOf('a b') !== -1, 'so is the one with a space');
    ok(ids.indexOf('a/b') !== -1, 'and the one with a slash');
    const read = await request('GET', boardPath(longestOk));
    ok(read.status === 200, 'and the long one is still readable by its name (' + read.status + ')');
    const spaced = await request('GET', boardPath('a b'));
    ok(spaced.status === 200, 'as is the one with a space (' + spaced.status + ')');
    ok(ids.every(function (i) { return typeof i === 'string'; }), 'and the list is still all strings');
  } finally {
    await stop(srv.child, 'SIGTERM');
  }

  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(function (e) {
  console.error('test crashed: ' + ((e && e.stack) || e));
  process.exit(1);
});
