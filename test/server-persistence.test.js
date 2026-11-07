'use strict';
// A restart must not throw the board away (issue #24).
//
// The server kept every topology in memory only, so restarting the node process - which
// is a normal thing to do while developing - discarded the work. This starts a real
// server against a scratch data directory, builds a small board over HTTP, kills it with
// the signal a terminal actually sends, starts a second server on the same directory and
// checks the board came back.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const ROOT = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-data-'));
// Ask the OS for a free port instead of guessing one. A guess can collide with a server
// left running from an earlier session, and then the test talks to the wrong process
// while its own child dies of EADDRINUSE - which looks exactly like a persistence
// failure and is not one.
const net = require('net');
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

function startServer() {
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), PF_DATA: dataDir }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', function (d) { log += d; });
  child.stderr.on('data', function (d) { log += d; });
  // Readiness is a successful HTTP probe, not a line in the log: a log line proves a
  // process printed something, not that it is the one answering on the port.
  return new Promise(function (resolve, reject) {
    const deadline = Date.now() + 20000;
    (function poll() {
      request('GET', '/api/catalog').then(function (r) {
        if (r.status === 200) return resolve({ child: child, log: function () { return log; } });
        throw new Error('status ' + r.status);
      }).catch(function (e) {
        if (child.exitCode !== null) {
          return reject(new Error('server exited (' + child.exitCode + '): ' + log));
        }
        if (Date.now() > deadline) return reject(new Error('server did not answer: ' + e.message + ' | ' + log));
        setTimeout(poll, 100);
      });
    })();
  });
}

function stop(child, signal) {
  return new Promise(function (resolve) {
    child.on('exit', function () { resolve(); });
    try { child.kill(signal || 'SIGTERM'); } catch (e) { resolve(); }
    setTimeout(function () { try { child.kill('SIGKILL'); } catch (e) {} resolve(); }, 5000);
  });
}

(async function main() {
  PORT = await freePort();
  console.log('A board survives a restart (port ' + PORT + '):');
  let srv = await startServer();
  try {
    const empty = await request('GET', '/api/topologies/default');
    ok(empty.status === 200 && empty.body.devices.length === 0, 'a fresh server starts empty');

    const add = await request('POST', '/api/topologies/default/devices', { vendor: 'aruba', model: 'AP-515' });
    ok(add.status === 200 || add.status === 201, 'a device can be placed (' + add.status + ')');
    const devId = add.body && (add.body.id || (add.body.device && add.body.device.id));

    // A second device that is not in the catalogue must be refused, and refusing must
    // not disturb what is already saved.
    const bad = await request('POST', '/api/topologies/default/devices', { vendor: 'nope', model: 'nope' });
    ok(bad.status === 404, 'an unknown model is refused (' + bad.status + ')');

    const before = await request('GET', '/api/topologies/default');
    ok(before.body.devices.length === 1, 'the board holds one device before the restart');
  } finally {
    await stop(srv.child, 'SIGTERM');
  }

  const files = fs.existsSync(path.join(dataDir, 'topologies'))
    ? fs.readdirSync(path.join(dataDir, 'topologies')).filter(function (f) { return /\.json$/.test(f); })
    : [];
  ok(files.length === 1, 'the board was written to disk (' + files.length + ' file)');

  const saved = files.length ? JSON.parse(fs.readFileSync(path.join(dataDir, 'topologies', files[0]), 'utf8')) : null;
  ok(saved && saved.format === 'packetforge-topology', 'the file identifies itself and its version');
  ok(saved && saved.topology && saved.topology.devices && saved.topology.devices.length === 1,
    'and holds the device');

  console.log('\nThe restarted server serves it back:');
  srv = await startServer();
  try {
    const after = await request('GET', '/api/topologies/default');
    ok(after.body.devices.length === 1, 'the device is still there (' + after.body.devices.length + ')');
    ok(after.body.devices[0].model === 'AP-515', 'and it is the right device (' + after.body.devices[0].model + ')');

    // Ids must be restored too, or the next add reuses an id that is already taken.
    const again = await request('POST', '/api/topologies/default/devices', { vendor: 'aruba', model: 'AP-515' });
    const newId = again.body && (again.body.id || (again.body.device && again.body.device.id));
    const ids = (await request('GET', '/api/topologies/default')).body.devices.map(function (d) { return d.id; });
    ok(new Set(ids).size === ids.length, 'ids stay unique after a restart (' + ids.join(', ') + ')');
    ok(newId && ids.indexOf(newId) !== -1, 'the new device was accepted with its id');
  } finally {
    await stop(srv.child, 'SIGTERM');
  }

  console.log('\nA board that cannot be parsed is reported, not deleted:');
  {
    const dir = path.join(dataDir, 'topologies');
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json');
    const s = await startServer();
    try {
      const list = await request('GET', '/api/topologies');
      ok(list.status === 200, 'the server still starts with a corrupt board on disk');
      ok(fs.existsSync(path.join(dir, 'broken.json')), 'the corrupt file is left in place for the user');
    } finally {
      await stop(s.child, 'SIGTERM');
    }
  }

  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(function (e) {
  console.error('harness failed:', e && e.stack || e);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (x) {}
  console.log('\n' + passed + ' passed, ' + (failed + 1) + ' failed');
  process.exit(1);
});
