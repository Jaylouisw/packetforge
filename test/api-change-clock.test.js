'use strict';
// Every change answers the same question (#1333).
//
// `POST /links/:id/state` reports where convergence stands, and it was the only mutating endpoint that did. An
// operator driving the API could see whether the lab was settled after cutting a cable, and had no way to ask after
// disabling a port, adding a switch, moving a cable or removing a device - four changes that decide exactly what the
// control plane has to do, one of which answered.
//
// Nothing here invents a convergence model: `getConvergence()` is the engine's own schedule, and the instant is the
// one the caller says they are standing at. A request that does not say leaves the clock alone, because moving it to
// 0 would claim the board changed before it did - a lie in the other direction.
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

function shape(c) {
  return !!c && Array.isArray(c.entries) && typeof c.fromMs === 'number';
}

(async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-apiclock-'));
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

  try {
    for (let i = 0; ; i++) {
      const r = await request('GET', '/api/version').catch(function () { return { status: 0 }; });
      if (r.status === 200) break;
      if (i > 150) throw new Error('server did not start');
      await new Promise(function (res) { setTimeout(res, 100); });
    }

    console.log('');
    console.log('Every change answers where convergence stands:');

    const a = await request('POST', '/api/topologies/default/devices', { vendor: SW.vendor, model: SW.model });
    ok(shape(a.body.convergence), 'adding a device says how the control plane stands', JSON.stringify(a.body.convergence && a.body.convergence.fromMs));

    const b = await request('POST', '/api/topologies/default/devices', { vendor: SW.vendor, model: SW.model });
    const link = await request('POST', '/api/topologies/default/links', {
      a: { deviceId: a.body.device.id, iface: '1/1/1' }, b: { deviceId: b.body.device.id, iface: '1/1/1' },
      mediaId: '1000base-t', speedMbps: 1000
    });
    ok(shape(link.body.convergence), 'moving a cable does', String(link.status));

    const edit = await request('POST', '/api/topologies/default/interfaces/' + a.body.device.id + '/1%2F1%2F1',
      { enabled: false });
    ok(shape(edit.body.convergence), 'and so does disabling a port - the one that used to answer nothing',
      JSON.stringify(Object.keys(edit.body)));

    // While the cable still exists: the endpoint that always answered must keep answering.
    const state = await request('POST', '/api/topologies/default/links/' + link.body.link.id + '/state',
      { state: 'down', atMs: 5000 });
    ok(shape(state.body.convergence) && state.body.convergence.fromMs === 5000,
      'the cable endpoint still reports it, from the instant it was given',
      JSON.stringify({ status: state.status, from: state.body.convergence && state.body.convergence.fromMs }));

    const del = await request('DELETE', '/api/topologies/default/devices/' + b.body.device.id);
    ok(shape(del.body.convergence), 'removing a device does too', JSON.stringify(Object.keys(del.body)));

    const back = await request('POST', '/api/topologies/default/devices', { vendor: SW.vendor, model: SW.model });
    const l2 = await request('POST', '/api/topologies/default/links', {
      a: { deviceId: a.body.device.id, iface: '1/1/2' }, b: { deviceId: back.body.device.id, iface: '1/1/1' },
      mediaId: '1000base-t', speedMbps: 1000
    });
    const cut = await request('DELETE', '/api/topologies/default/links/' + l2.body.link.id);
    ok(shape(cut.body.convergence), 'and cutting one out', JSON.stringify(Object.keys(cut.body)));

    console.log('');
    console.log('The instant is the caller\'s to name, and never invented:');
    {
      const moved = await request('POST', '/api/topologies/default/interfaces/' + a.body.device.id + '/1%2F1%2F2',
        { enabled: false, atMs: 40000 });
      ok(moved.body.atMs === 40000 && moved.body.convergence.fromMs === 40000,
        'a change at instant 40000 moves the clock there',
        JSON.stringify({ atMs: moved.body.atMs, from: moved.body.convergence && moved.body.convergence.fromMs }));

      const silent = await request('POST', '/api/topologies/default/interfaces/' + a.body.device.id + '/1%2F1%2F2',
        { enabled: true });
      ok(silent.body.atMs === undefined && silent.body.convergence.fromMs === 40000,
        'a change that does not name an instant leaves the clock where it was, not at 0',
        JSON.stringify({ atMs: silent.body.atMs, from: silent.body.convergence && silent.body.convergence.fromMs }));

      const nonsense = await request('POST', '/api/topologies/default/interfaces/' + a.body.device.id + '/1%2F1%2F2',
        { enabled: true, atMs: 'soon' });
      ok(nonsense.body.atMs === undefined && nonsense.body.convergence.fromMs === 40000,
        'and a nonsense instant is ignored rather than recorded',
        JSON.stringify({ atMs: nonsense.body.atMs, from: nonsense.body.convergence && nonsense.body.convergence.fromMs }));

      const negative = await request('POST', '/api/topologies/default/interfaces/' + a.body.device.id + '/1%2F1%2F2',
        { enabled: true, atMs: -5 });
      ok(negative.body.atMs === undefined && negative.body.convergence.fromMs === 40000,
        'as is a negative one', JSON.stringify({ atMs: negative.body.atMs, from: negative.body.convergence && negative.body.convergence.fromMs }));
    }

    console.log('');
    console.log('And the schedule is the engine\'s own:');
    {
      const r = await request('POST', '/api/topologies/default/interfaces/' + a.body.device.id + '/1%2F1%2F1',
        { enabled: true, atMs: 0 });
      const c = r.body.convergence;
      ok(c.entries.length > 0 && c.entries.every(function (e) { return typeof e.readyAtMs === 'number'; }),
        'each entry carries the instant it will be ready', JSON.stringify(c.entries.slice(0, 2)));
      ok(c.entries.every(function (e) { return e.readyAtMs >= c.fromMs; }),
        'and nothing claims to be ready before the change', JSON.stringify({ from: c.fromMs, first: c.entries[0] && c.entries[0].readyAtMs }));
    }
  } finally {
    try { child.kill('SIGKILL'); } catch (e) {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('');
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
