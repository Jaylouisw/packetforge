'use strict';
// What happens when the request is wrong (#1309).
//
// Every test in this repository drove the engine. This one drives the HTTP surface with requests that are
// malformed on purpose, because that is where the failure modes live that no engine test can see:
//
//   * a missing body was dereferenced straight through, so the answer was the JavaScript engine's own words -
//     `{"error":"Cannot read properties of undefined (reading 'trim')"}` with a 400, and
//     `{"error":"Cannot read properties of undefined (reading 'deviceId')"}` with a 409, because a missing body
//     is apparently a conflict;
//   * `POST /load` with `{"format":"x"}` **replaced the live board with an empty one and answered `ok: true`** -
//     silent data loss, from a request that should never have been allowed to touch anything;
//   * `POST /ping` with no body answered 404 `source device not found`, blaming a device nobody named.
//
// Three rules are asserted here, and they are the rules rather than a list of today's strings:
//
//   1. a response never contains the runtime's own words;
//   2. the status says what the client can do about it - 400 for a request that does not parse, 404 for an id
//      that does not exist, 409/422 for content the engine refuses;
//   3. a request that is rejected changes nothing.
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
let PORT = 0;
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

// The runtime's own words, in any of their shapes.
const INTERNALS = /Cannot read propert|Cannot read of undefined|is not a function|is not iterable|\[object Object\]|undefined is not|of null \(reading/;

(async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-errors-'));
  PORT = await freePort();
  const srv = await startServer(dataDir);

  try {
    const add = await request('POST', '/api/topologies/default/devices', { vendor: SW.vendor, model: SW.model });
    const devId = add.body && add.body.device && add.body.device.id;
    ok(!!devId, 'a device to talk to exists (' + devId + ')');

    // Every malformed request this endpoint set can receive. Each one used to be a JavaScript error with a
    // status somebody guessed.
    const malformed = [
      ['GET', '/api/topologies/default', undefined, 'sanity: the endpoint works'],
      ['POST', '/api/topologies/default/config/' + devId, undefined, 'config with no body'],
      ['POST', '/api/topologies/default/config/' + devId, {}, 'config with an empty object'],
      ['POST', '/api/topologies/default/config/' + devId, { commands: [null] }, 'config with a null command'],
      ['POST', '/api/topologies/default/config/' + devId, { commands: 'hostname X' }, 'config with a string, not a list'],
      ['POST', '/api/topologies/default/links', undefined, 'link with no body'],
      ['POST', '/api/topologies/default/links', {}, 'link with an empty object'],
      ['POST', '/api/topologies/default/links', { a: { deviceId: devId } }, 'link with no port on the a end'],
      ['POST', '/api/topologies/default/links', { a: { deviceId: devId, iface: '1/1/1' } }, 'link with no b end'],
      ['POST', '/api/topologies/default/ping', undefined, 'ping with no body'],
      ['POST', '/api/topologies/default/ping', {}, 'ping with an empty object'],
      ['POST', '/api/topologies/default/flows', undefined, 'flow with no body'],
      ['POST', '/api/topologies/default/flows', { proto: 'tcp' }, 'flow with no devices'],
      ['POST', '/api/topologies/default/flows', { proto: 'tcp', srcDevice: devId }, 'flow with no destination'],
      ['POST', '/api/topologies/default/load', undefined, 'load with no body'],
      ['POST', '/api/topologies/default/load', '{"format":"x"}', 'load with the wrong format'],
      ['POST', '/api/topologies/default/load', '{"format":"packetforge-topology"}', 'load with no devices and no links'],
      ['POST', '/api/topologies/default/load', '{"format":"packetforge-topology","devices":"x"}', 'load with devices as a string'],
      ['POST', '/api/topologies/default/load', '{"format":"packetforge-topology","links":7}', 'load with links as a number'],
      ['POST', '/api/topologies/default/load', 'not json at all', 'load with a body that is not JSON'],
      ['POST', '/api/topologies/default/config/' + devId, '{oops', 'config with a body that is not JSON']
    ];

    console.log('');
    console.log('A wrong request never gets the runtime\'s own words back:');
    {
      const leaks = [];
      for (const [method, url, body, label] of malformed) {
        const r = await request(method, url, body);
        if (INTERNALS.test(r.text)) leaks.push(label + ' -> ' + r.text.slice(0, 120));
      }
      ok(leaks.length === 0, malformed.length + ' malformed requests, no JavaScript internals in any answer',
        JSON.stringify(leaks.slice(0, 3)));
    }

    console.log('');
    console.log('...and the status says what the client can do about it:');
    {
      const wrong = [];
      const expect = [
        ['POST', '/api/topologies/default/config/' + devId, undefined, 400],
        ['POST', '/api/topologies/default/config/' + devId, {}, 400],
        ['POST', '/api/topologies/default/links', undefined, 400],
        ['POST', '/api/topologies/default/links', { a: { deviceId: devId, iface: '1/1/1' } }, 400],
        ['POST', '/api/topologies/default/ping', undefined, 400],
        ['POST', '/api/topologies/default/ping', { src: 'nobody' }, 404],
        ['POST', '/api/topologies/default/flows', undefined, 400],
        ['POST', '/api/topologies/default/flows', { proto: 'tcp', srcDevice: 'nobody', dstDevice: 'nobody' }, 400],
        ['POST', '/api/topologies/default/load', '{"format":"x"}', 400],
        ['POST', '/api/topologies/default/load', '{"format":"packetforge-topology"}', 400],
        ['POST', '/api/topologies/default/interfaces/' + devId + '/9/9/9', { enabled: false }, 404],
        ['POST', '/api/topologies/default/interfaces/nosuch/1/1/1', { enabled: false }, 404],
        ['POST', '/api/topologies/default/links/nosuch/state', { state: 'down' }, 404],
        ['POST', '/api/topologies/default/links/nosuch/state', { state: 'sideways' }, 422],
        ['GET', '/api/topologies/nosuchtopology', undefined, 404]
      ];
      for (const [method, url, body, want] of expect) {
        const r = await request(method, url, body);
        if (r.status !== want) wrong.push(method + ' ' + url.replace(devId, '<dev>') + ' body ' +
          JSON.stringify(body) + ' -> ' + r.status + ' (wanted ' + want + ')');
      }
      ok(wrong.length === 0, expect.length + ' rejections carry the status a client can act on',
        JSON.stringify(wrong.slice(0, 3)));
    }

    console.log('');
    console.log('Every rejection says something a reader can act on:');
    {
      const bad = [];
      for (const [method, url, body, label] of malformed) {
        if (method === 'GET') continue;
        const r = await request(method, url, body);
        const msg = r.body && (r.body.error || r.body.reason);
        if (typeof msg !== 'string' || msg.length < 12) bad.push(label + ' -> ' + JSON.stringify(msg));
        if (/\bundefined\b/.test(msg || '') && !/got no body|no body/.test(msg || '')) {
          bad.push(label + ' -> names "undefined": ' + JSON.stringify(msg));
        }
      }
      ok(bad.length === 0, 'each one is a sentence, and none of them says "undefined" by accident',
        JSON.stringify(bad.slice(0, 3)));
    }

    console.log('');
    console.log('The endpoints that work still work:');
    {
      // A regression guard on the paths the fixes touched, so a shape check cannot reject a good request.
      const cfg = await request('POST', '/api/topologies/default/config/' + devId, { commands: ['enable', 'show version'] });
      ok(cfg.status === 200 && /show version|Version|version/i.test(String(cfg.body.output || '')),
        'config with a list of commands answers with output', String(cfg.body.output || '').slice(0, 80));
      const single = await request('POST', '/api/topologies/default/config/' + devId, { command: 'enable' });
      ok(single.status === 200, 'and the single-command form is still accepted', String(single.status));
      const ping = await request('POST', '/api/topologies/default/ping', { src: devId, dst: '10.0.0.1' });
      ok(ping.status === 200, 'ping with a real source answers', String(ping.status));
      const port = await request('POST', '/api/topologies/default/interfaces/' + devId + '/1/1/2', { enabled: false });
      ok(port.status === 200, 'a port toggle answers', String(port.status));
      const states = await request('GET', '/api/topologies/default');
      const dev = (states.body.devices || []).filter(function (d) { return d.id === devId; })[0];
      const p = (dev.interfaces || []).filter(function (i) { return i.name === '1/1/2'; })[0];
      ok(p && p.enabled === false, 'and the port really is down', JSON.stringify(p && p.enabled));
    }
    console.log('');
    console.log('A rejected load changes nothing, and a good one still works:');
    {
      const before = await request('GET', '/api/topologies/default');
      const devicesBefore = (before.body.devices || []).length;
      ok(devicesBefore === 1, 'the board has one device before the bad loads', String(devicesBefore));

      const destructive = [
        '{"format":"x"}',
        '{"format":"packetforge-topology"}',
        '[]',
        '{"format":"packetforge-topology","devices":"x"}',
        'null'
      ];
      const lost = [];
      for (const doc of destructive) {
        const r = await request('POST', '/api/topologies/default/load', doc);
        const after = await request('GET', '/api/topologies/default');
        const count = (after.body.devices || []).length;
        if (r.status !== 400 || count !== devicesBefore) {
          lost.push(doc + ' -> status ' + r.status + ', devices ' + count + ' (was ' + devicesBefore + ')');
        }
      }
      ok(lost.length === 0, destructive.length + ' bad documents refused, and the board is untouched',
        JSON.stringify(lost));

      // ...and a document that is a topology still loads, and still reports its verdicts.
      const t = require('../engine').Topology;
      const good = new t();
      const a = good.addDevice(SW, 'a'); a.name = 'SW1';
      const b = good.addDevice(SW, 'b'); b.name = 'SW2';
      good.connect(a.id, '1/1/1', b.id, '1/1/1');
      const doc = JSON.parse(JSON.stringify(good.serialize()));
      const loaded = await request('POST', '/api/topologies/default/load', doc);
      ok(loaded.status === 200 && loaded.body.state.devices.length === 2,
        'a real document loads (' + loaded.status + ', ' + (loaded.body.state && loaded.body.state.devices.length) + ')');
      ok(loaded.body.verdicts && loaded.body.verdicts.errorCount === 0, 'with its cable verdicts',
        JSON.stringify(loaded.body.verdicts && loaded.body.verdicts.errorCount));
    }

  } finally {
    await stop(srv.child);
  }

  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
