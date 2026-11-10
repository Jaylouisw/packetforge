'use strict';
// What is actually on the disk after the server says it did something (#1315).
//
// The persistence code carries a comment explaining that the debounce was removed: on Windows a kill calls
// TerminateProcess, so no signal handler and no 'exit' listener ever runs, and a board waiting on a timer is
// simply gone. That is a strong claim about a code path nobody had ever tested from outside. This file tests it
// the way it can fail:
//
//   * mutate through the API, then read the file - every endpoint that changes a board must have saved it by the
//     time it answers;
//   * mutate, SIGKILL with no warning, restart - the change is still there;
//   * two boards whose ids sanitise to the same file name must stay two boards (they used to share one file, and
//     one of them was silently lost);
//   * a file that parses but is not a board must be reported and left alone, not adopted as an empty lab;
//   * a truncated file must not stop the other boards from loading.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const ROOT = path.join(__dirname, '..');
const cat = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
const SW = cat.find(function (s) { return /CX 6000/.test(s.model); });
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

function freePort() {
  return new Promise(function (resolve, reject) {
    const p = net.createServer();
    p.unref(); p.on('error', reject);
    p.listen(0, '127.0.0.1', function () { const port = p.address().port; p.close(function () { resolve(port); }); });
  });
}
let PORT = 0;
function request(method, urlPath, body) {
  return new Promise(function (resolve, reject) {
    const payload = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: urlPath, method: method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}
    }, function (res) {
      let d = '';
      res.on('data', function (c) { d += c; });
      res.on('end', function () {
        let parsed = d;
        try { parsed = JSON.parse(d); } catch (e) { /* raw */ }
        resolve({ status: res.statusCode, body: parsed, text: d });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
function start(dataDir) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), PF_DATA: dataDir }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const srv = { child: child, log: '' };
  child.stdout.on('data', function (d) { srv.log += d; });
  child.stderr.on('data', function (d) { srv.log += d; });
  return new Promise(function (resolve, reject) {
    const deadline = Date.now() + 20000;
    (function poll() {
      request('GET', '/api/version').then(function (r) {
        if (r.status === 200) return resolve(srv);
        throw new Error('status ' + r.status);
      }).catch(function (e) {
        if (child.exitCode !== null) return reject(new Error('server exited: ' + srv.log));
        if (Date.now() > deadline) return reject(new Error('no answer: ' + e.message + ' | ' + srv.log));
        setTimeout(poll, 100);
      });
    })();
  });
}
function stopHard(srv) {
  return new Promise(function (resolve) {
    if (srv.child.exitCode !== null) return resolve();
    srv.child.on('exit', function () { resolve(); });
    // No SIGTERM: this is the TerminateProcess case the comment is about.
    try { srv.child.kill('SIGKILL'); } catch (e) {}
    setTimeout(resolve, 3000);
  });
}
function boardFiles(dataDir) {
  const dir = path.join(dataDir, 'topologies');
  try {
    return fs.readdirSync(dir).filter(function (n) { return /\.json$/i.test(n); });
  } catch (e) { return []; }
}
function readBoard(dataDir, name) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'topologies', name), 'utf8')); }
  catch (e) { return null; }
}

(async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-persist-'));
  PORT = await freePort();
  let srv = await start(dataDir);

  try {
    console.log('');
    console.log('Every change is on the disk before the answer arrives:');
    {
      const add = await request('POST', '/api/topologies/default/devices', { vendor: SW.vendor, model: SW.model });
      const devId = add.body.device.id;
      const after = readBoard(dataDir, 'default.json');
      ok(!!after, 'a board file exists after the first device', boardFiles(dataDir).join(','));
      ok(after && after.id === 'default', 'the file says whose board it is', after && after.id);
      ok(after && after.topology && after.topology.devices.length === 1,
        'and the device is in it', JSON.stringify(after && after.topology && after.topology.devices.length));

      await request('POST', '/api/topologies/default/config/' + devId, { commands: ['configure terminal', 'hostname lab-sw'] });
      const named = readBoard(dataDir, 'default.json');
      const savedDev = named.topology.devices.filter(function (d) { return d.id === devId; })[0];
      ok(savedDev && savedDev.name === 'lab-sw', 'a config command is saved', savedDev && savedDev.name);

      await request('POST', '/api/topologies/default/interfaces/' + devId + '/1/1/5', { enabled: false });
      const toggled = readBoard(dataDir, 'default.json');
      const port = (toggled.topology.devices[0].interfaces || []).filter(function (i) { return i.name === '1/1/5'; })[0];
      ok(port && port.enabled === false, 'a port shutdown is saved', JSON.stringify(port && port.enabled));

      const add2 = await request('POST', '/api/topologies/default/devices', { vendor: SW.vendor, model: SW.model });
      const dev2 = add2.body.device.id;
      const linked = await request('POST', '/api/topologies/default/links',
        { a: { deviceId: devId, iface: '1/1/1' }, b: { deviceId: dev2, iface: '1/1/1' } });
      ok(linked.status === 200 || linked.status === 201, 'a cable can be made', String(linked.status));
      const withLink = readBoard(dataDir, 'default.json');
      ok(withLink.topology.links.length === 1, 'and is saved', JSON.stringify(withLink.topology.links.length));

      const before = readBoard(dataDir, 'default.json').topology.devices.length;
      await request('DELETE', '/api/topologies/default/devices/' + dev2);
      const afterDelete = readBoard(dataDir, 'default.json');
      ok(afterDelete.topology.devices.length === before - 1, 'a device removal is saved',
        before + ' -> ' + afterDelete.topology.devices.length);
    }

    console.log('');
    console.log('A kill with no warning loses nothing:');
    {
      const state = await request('GET', '/api/topologies/default');
      const devId = state.body.devices[0].id;
      await request('POST', '/api/topologies/default/config/' + devId, { commands: ['configure terminal', 'hostname killed-mid-flight'] });
      // The answer is in hand. Nothing has had a chance to run a signal handler or an 'exit' listener.
      await stopHard(srv);
      srv = await start(dataDir);
      const again = await request('GET', '/api/topologies/default');
      const dev = again.body.devices.filter(function (d) { return d.id === devId; })[0];
      ok(dev && dev.name === 'killed-mid-flight', 'the last change survived SIGKILL',
        JSON.stringify(dev && dev.name));
    }

    console.log('');
    console.log('Two boards whose names look alike are two boards:');
    {
      // `a b` and `a_b` used to sanitise to the same file name: one board overwrote the other, and one of them was
      // gone at the next boot.
      const made = await Promise.all([
        request('POST', '/api/topologies', { id: 'a b' }),
        request('POST', '/api/topologies', { id: 'a_b' })
      ]);
      ok(made[0].status === 201 && made[1].status === 201, 'two boards with look-alike names can be made',
        made[0].status + '/' + made[1].status);
      // A created board is saved when it is acknowledged - it used to exist only in memory until something else
      // happened to it.
      const afterCreate = boardFiles(dataDir);
      ok(afterCreate.length === 3, 'three files exist as soon as the boards are acknowledged', afterCreate.join(','));
      const one = await request('POST', '/api/topologies/a%20b/devices', { vendor: SW.vendor, model: SW.model });
      const two = await request('POST', '/api/topologies/a_b/devices', { vendor: SW.vendor, model: SW.model });
      ok(one.status === 200 || one.status === 201, 'the first board accepts a device', String(one.status));
      ok(two.status === 200 || two.status === 201, 'and so does the second', String(two.status));
      const files = boardFiles(dataDir);
      ok(files.length === 3, 'they are three files, not two', files.join(','));
      const named = files.map(function (f) { return readBoard(dataDir, f); }).filter(Boolean);
      const ids = named.map(function (b) { return b.id; }).sort();
      ok(ids.join('|') === 'a b|a_b|default', 'and each file names its own board', ids.join('|'));

      await stopHard(srv);
      srv = await start(dataDir);
      const both = await Promise.all([request('GET', '/api/topologies/a%20b'), request('GET', '/api/topologies/a_b')]);
      ok(both[0].status === 200 && both[1].status === 200, 'both come back after a restart',
        both[0].status + '/' + both[1].status);
      const d0 = (both[0].body && both[0].body.devices) || [];
      const d1 = (both[1].body && both[1].body.devices) || [];
      ok(d0.length === 1 && d1.length === 1, 'with their own device', d0.length + '/' + d1.length);
      // The property that matters: saving one board must not touch the other's file. Device ids are per board
      // (`d1` in each), so the check is on the file contents, not on the ids.
      const filesAB = boardFiles(dataDir).map(function (f) { return { name: f, body: readBoard(dataDir, f) }; })
        .filter(function (f) { return f.body && f.body.id !== 'default'; });
      const aFile = filesAB.filter(function (f) { return f.body.id === 'a b'; })[0];
      const bFile = filesAB.filter(function (f) { return f.body.id === 'a_b'; })[0];
      ok(!!aFile && !!bFile, 'two files, one per board', filesAB.map(function (f) { return f.name; }).join(','));
      const before = JSON.stringify(bFile ? bFile.body : null);
      await request('POST', '/api/topologies/a%20b/devices', { vendor: SW.vendor, model: SW.model });
      const afterAB = bFile ? readBoard(dataDir, bFile.name) : null;
      ok(!!bFile && JSON.stringify(afterAB) === before, 'and changing one leaves the other file byte for byte');
      const grewA = aFile ? readBoard(dataDir, aFile.name) : null;
      ok(!!grewA && grewA.topology.devices.length === 2, 'while the board that changed grew',
        JSON.stringify(grewA && grewA.topology.devices.length));
    }

    console.log('');
    console.log('A file that is not a board is refused, not adopted as an empty one:');
    {
      await stopHard(srv);
      const dir = path.join(dataDir, 'topologies');
      fs.writeFileSync(path.join(dir, 'wrong-format.json'),
        JSON.stringify({ format: 'something-else', topology: { devices: [], links: [] } }));
      fs.writeFileSync(path.join(dir, 'no-arrays.json'), JSON.stringify({ format: 'packetforge-topology' }));
      fs.writeFileSync(path.join(dir, 'truncated.json'), '{"format":"packetforge-topology","topology":{"devic');
      srv = await start(dataDir);
      const wrong = await request('GET', '/api/topologies/wrong-format');
      const empty = await request('GET', '/api/topologies/no-arrays');
      ok(wrong.status === 404, 'a wrong format is not a board', String(wrong.status));
      ok(empty.status === 404, 'and neither is a document with no devices and no links', String(empty.status));
      ok(/wrong-format\.json/.test(srv.log) && /left alone/.test(srv.log),
        'the log names the file and says it was left alone', srv.log.split('\n').filter(function (l) { return /wrong-format/.test(l); }).join(' | ').slice(0, 120));
      ok(/truncated\.json/.test(srv.log), 'and a truncated file is reported too');
      ok(fs.existsSync(path.join(dir, 'wrong-format.json')) && fs.existsSync(path.join(dir, 'truncated.json')),
        'neither file is deleted: it is the operator\'s work');
      const survived = await request('GET', '/api/topologies/default');
      ok(survived.status === 200 && survived.body.devices.length >= 1,
        'and the good boards still load', String(survived.body.devices.length));
    }

    console.log('');
    console.log('A save that fails says which file it could not write:');
    {
      await stopHard(srv);
      // Make the save directory impossible: a *file* where the directory should be.
      const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-persist-broken-'));
      fs.writeFileSync(path.join(broken, 'topologies'), 'not a directory');
      const PORT2 = await freePort();
      const oldPort = PORT;
      PORT = PORT2;
      const bad = await start(broken);
      await request('POST', '/api/topologies/default/devices', { vendor: SW.vendor, model: SW.model });
      await sleep(300);
      ok(/could not save topology default/.test(bad.log) && /topologies/.test(bad.log),
        'the message names the board and the path', bad.log.split('\n').filter(function (l) { return /could not save/.test(l); })[0]);
      await stopHard(bad);
      PORT = oldPort;
      try { fs.rmSync(broken, { recursive: true, force: true }); } catch (e) {}
    }
  } finally {
    await stopHard(srv);
  }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
