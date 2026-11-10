'use strict';
// The console over HTTP is the same console (#1335).
//
// `POST /config/:devId` ran the console on `new Simulator(topo)` - a second accounting, with its own flow state - and
// it took no instant at all. Three consequences, all measured:
//
//   * traffic counted by `/flows` was invisible to the console, and traffic the console generated (`ping`) was
//     invisible to the payload: one board, two sets of counters;
//   * every console answer was given at `Infinity`, so a lab could not be asked about mid-convergence through the
//     API even though the cable endpoint reports a schedule and takes `atMs`;
//   * `show spanning-tree` printed `dev.stp`, which is written by whichever Simulator computed it last. A console
//     asked at instant 25000 printed the tree from an earlier pass at Infinity, calling a port that was still
//     listening "forwarding".
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
const specs = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
const SW = specs.find(function (s) { return /CX 6000/.test(s.model); });
const HOST = specs.find(function (s) { return /Raspberry Pi 5/.test(s.model); }) ||
  specs.find(function (s) { return s.category === 'host'; });

(async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-httpconsole-'));
  const port = await new Promise(function (resolve, reject) {
    const p = net.createServer();
    p.unref(); p.on('error', reject);
    p.listen(0, '127.0.0.1', function () { const n = p.address().port; p.close(function () { resolve(n); }); });
  });
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: Object.assign({}, process.env, { PORT: String(port), PF_DATA: dataDir }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const request = function (method, p, body) {
    return new Promise(function (resolve, reject) {
      const payload = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
      const req = http.request({ host: '127.0.0.1', port: port, path: p, method: method,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} },
        function (res) {
          let d = '';
          res.on('data', function (c) { d += c; });
          res.on('end', function () { let j = d; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, body: j }); });
        });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  };
  const CONFIG = '/api/topologies/default/config/';
  const console_ = function (dev, commands, extra) {
    return request('POST', CONFIG + dev, Object.assign({ commands: commands }, extra || {}));
  };

  try {
    for (let i = 0; ; i++) {
      const r = await request('GET', '/api/version').catch(function () { return { status: 0 }; });
      if (r.status === 200) break;
      if (i > 150) throw new Error('server did not start');
      await new Promise(function (res) { setTimeout(res, 100); });
    }

    const h1 = await request('POST', '/api/topologies/default/devices', { vendor: HOST.vendor, model: HOST.model });
    const sw = await request('POST', '/api/topologies/default/devices', { vendor: SW.vendor, model: SW.model });
    const h2 = await request('POST', '/api/topologies/default/devices', { vendor: HOST.vendor, model: HOST.model });
    const A = h1.body.device.id, S = sw.body.device.id, B = h2.body.device.id;
    await request('POST', '/api/topologies/default/links', {
      a: { deviceId: A, iface: 'eth0' }, b: { deviceId: S, iface: '1/1/1' }, mediaId: '1000base-t', speedMbps: 1000 });
    await request('POST', '/api/topologies/default/links', {
      a: { deviceId: S, iface: '1/1/2' }, b: { deviceId: B, iface: 'eth0' }, mediaId: '1000base-t', speedMbps: 1000 });
    await request('POST', '/api/topologies/default/interfaces/' + A + '/eth0', { ip: '10.0.0.1', mask: '255.255.255.0' });
    await request('POST', '/api/topologies/default/interfaces/' + B + '/eth0', { ip: '10.0.0.2', mask: '255.255.255.0' });

    console.log('');
    console.log('One board, one set of counters:');
    {
      const flow = await request('POST', '/api/topologies/default/flows',
        { srcDevice: A, dstDevice: B, dstIp: '10.0.0.2', srcPort: 1234, dstPort: 80, bytes: 100 });
      ok(flow.status === 201, 'a flow opens between the two hosts', String(flow.status));
      const state = await request('GET', '/api/topologies/default');
      const p = state.body.runtime[A].counters.ports.eth0 || {};
      const shown = await console_(A, ['enable', 'show interfaces eth0']);
      const text = shown.body.output || '';
      ok(p.packetsIn > 0 && text.indexOf(p.packetsIn + ' packets input, ' + p.bytesIn + ' bytes') !== -1,
        'the counters the console prints are the counters the payload publishes',
        JSON.stringify({ payload: { pi: p.packetsIn, bi: p.bytesIn }, console: (text.split('\n').filter(function (l) { return /packets input/.test(l); })[0] || '').trim() }));
      ok(text.indexOf(p.packetsOut + ' packets output, ' + p.bytesOut + ' bytes') !== -1,
        'in both directions', String(p.packetsOut) + ' / ' + String(p.bytesOut));
    }

    console.log('');
    console.log('An answer says which instant it describes:');
    {
      const plain = await console_(S, ['enable', 'show version']);
      ok(plain.status === 200 && plain.body.runAtMs === null,
        'with no instant asked for, the answer says it settled the lab', JSON.stringify(plain.body.runAtMs));
      ok(plain.body.convergence && Array.isArray(plain.body.convergence.entries),
        'and carries where convergence stood, like every other mutation (#1333)',
        JSON.stringify(Object.keys(plain.body)));

      const at = await console_(S, ['enable', 'show version'], { atMs: 25000 });
      ok(at.body.runAtMs === 25000, 'and asked at 25000 it says so', JSON.stringify(at.body.runAtMs));
    }

    console.log('');
    console.log('A lab can be asked about mid-convergence:');
    {
      const links = (await request('GET', '/api/topologies/default')).body.links.map(function (l) { return l.id; });
      const cut = await request('POST', '/api/topologies/default/links/' + links[1] + '/state',
        { state: 'down', atMs: 20000 });
      ok(cut.status === 200, 'a cable cut at 20000', String(cut.status));

      const during = await console_(S, ['enable', 'show spanning-tree'], { atMs: 25000 });
      const after = await console_(S, ['enable', 'show spanning-tree']);
      const lineOf = function (r) {
        return ((r.body.output || '').split('\n').filter(function (l) { return /1\/1\/1/.test(l); })[0] || '').trim();
      };
      // 20000 + listening + learning + forwarding delays: at 25000 the port cannot be forwarding yet.
      ok(/listening|learning/.test(lineOf(during)),
        'at 25000 the port is still coming up', JSON.stringify(lineOf(during)));
      ok(/forwarding/.test(lineOf(after)),
        'and asked with no instant, once everything has settled, it forwards', JSON.stringify(lineOf(after)));
      ok(during.body.convergence.fromMs === 20000,
        'the answer says when the board last changed', String(during.body.convergence && during.body.convergence.fromMs));
    }

    console.log('');
    console.log('A cached session does not pin the next caller to a past instant:');
    {
      const a = await console_(S, ['enable', 'show spanning-tree'], { atMs: 25000 });
      const b = await console_(S, ['enable', 'show spanning-tree']);
      const lineOf = function (r) {
        return ((r.body.output || '').split('\n').filter(function (l) { return /1\/1\/1/.test(l); })[0] || '').trim();
      };
      ok(a.body.runAtMs === 25000 && b.body.runAtMs === null,
        'each request names its own instant', JSON.stringify([a.body.runAtMs, b.body.runAtMs]));
      ok(/listening|learning/.test(lineOf(a)) && /forwarding/.test(lineOf(b)),
        'and the answers differ accordingly, in the same session', JSON.stringify([lineOf(a), lineOf(b)]));
    }
  } finally {
    try { child.kill('SIGKILL'); } catch (e) {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('');
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
