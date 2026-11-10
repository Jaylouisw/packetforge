'use strict';
// Where the boxes are is part of the board (#1325).
//
// Devices and cables got their round trip in #1321 and #1323. The third thing a board holds is where each box sits,
// and it was the least guarded of the three:
//
//   * `serialize()` handed out `this.layout` itself, so the document the API, the UI and every fixture receives was
//     the live board — write to the document, move the board;
//   * `Topology.removeDevice()` left the position behind. The server remembered to delete it and the engine did not,
//     so a removal from anywhere else left a box in the file that is not on the board, growing with every board;
//   * a document could carry any position at all. `{"x": "left"}` put the device at NaN — the canvas draws
//     `pos.x` straight from here — and `layout: []` was accepted (an array is an object), kept in memory and then
//     **silently dropped at the next save**, because JSON.stringify ignores an array's string keys;
//   * a position naming a device the document does not contain was kept as a ghost;
//   * and the API placed a device at 160,160 when asked for 0,0, because `body.x || 160` treats zero as missing.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const { loadCatalog } = require('../devices/registry');
const { Topology } = require('../engine/topology');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const ROOT = path.join(__dirname, '..');
const specs = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
const SW = specs.find(function (s) { return /CX 6000/.test(s.model); });

function twoDevices() {
  const t = new Topology();
  t.addDevice(SW, 'd1');
  t.addDevice(SW, 'd2');
  t.connect('d1', '1/1/1', 'd2', '1/1/1', { mediaId: '1000base-t', speedMbps: 1000 });
  return t;
}
function doc(t) { return JSON.parse(JSON.stringify(t.serialize())); }
function codes(t) { return (t.loadIssues || []).map(function (i) { return i.code; }); }

(async function main() {
  console.log('');
  console.log('A position comes back where it was put:');
  {
    const t = twoDevices();
    t.layout.d1 = { x: 42.5, y: -7 };
    t.layout.d2 = { x: 0, y: 0 };
    const back = Topology.fromJSON(doc(t));
    ok(back.layout.d1.x === 42.5 && back.layout.d1.y === -7, 'a fractional, negative position survives',
      JSON.stringify(back.layout.d1));
    ok(back.layout.d2.x === 0 && back.layout.d2.y === 0, 'and so does the origin', JSON.stringify(back.layout.d2));
    ok((back.loadIssues || []).length === 0, 'and a clean layout says nothing', JSON.stringify(back.loadIssues));
  }

  console.log('');
  console.log('The document you are given is yours to change:');
  {
    const t = twoDevices();
    t.layout.d1 = { x: 10, y: 20 };
    const out = t.serialize();
    ok(out.layout !== t.layout, 'serialize() hands out a copy of the layout');
    out.layout.d1.x = 999;
    out.layout.d2 = { x: 1, y: 1 };
    ok(t.layout.d1.x === 10, 'so moving a box in the document does not move it on the board', String(t.layout.d1.x));
    ok(!t.layout.d2, 'and adding one to the document does not add it to the board', JSON.stringify(t.layout.d2));
  }

  console.log('');
  console.log('Removing a device removes where it sat:');
  {
    const t = twoDevices();
    t.layout.d1 = { x: 1, y: 1 };
    t.layout.d2 = { x: 2, y: 2 };
    t.removeDevice('d2');
    ok(!t.layout.d2, 'the engine takes the position with the device', JSON.stringify(t.layout));
    const file = doc(t);
    ok(!file.layout.d2, 'so the saved document has no box that is not on the board', JSON.stringify(file.layout));
    const back = Topology.fromJSON(file);
    ok(!back.layout.d2, 'and a reload does not bring one back', JSON.stringify(back.layout));
  }

  console.log('');
  console.log('A position that is not a position is dropped, and said so:');
  {
    const junk = [
      [{ d1: { x: 'left', y: 'top' } }, 'E_LAYOUT_BAD_ENTRY'],
      [{ d1: { x: null, y: 0 } }, 'E_LAYOUT_BAD_ENTRY'],
      [{ d1: 'here' }, 'E_LAYOUT_BAD_ENTRY'],
      [{ d1: null }, 'E_LAYOUT_BAD_ENTRY'],
      [{ d2: { x: 1 } }, 'E_LAYOUT_BAD_ENTRY'],
      [{ d1: { x: 0, y: 0 }, ghost: { x: 9, y: 9 } }, 'E_LAYOUT_UNKNOWN_DEVICE']
    ];
    const wrong = [];
    for (const [layout, code] of junk) {
      const d = doc(twoDevices());
      d.layout = layout;
      const t = Topology.fromJSON(d);
      if (codes(t).indexOf(code) === -1) wrong.push(JSON.stringify(layout) + ' -> ' + JSON.stringify(codes(t)));
      // Whatever else it does, a bad entry must never become a position the canvas will draw.
      for (const id of Object.keys(t.layout || {})) {
        const p = t.layout[id];
        if (!p || typeof p.x !== 'number' || !isFinite(p.x) || typeof p.y !== 'number' || !isFinite(p.y)) {
          wrong.push(JSON.stringify(layout) + ' -> kept a bad position for ' + id);
        }
      }
    }
    ok(wrong.length === 0, junk.length + ' impossible layouts are reported with the right code and kept out',
      JSON.stringify(wrong.slice(0, 3)));

    // The good entry beside a bad one is kept.
    const d = doc(twoDevices());
    d.layout = { d1: { x: 3, y: 4 }, d2: { x: 'oops', y: 0 } };
    const t = Topology.fromJSON(d);
    ok(t.layout.d1 && t.layout.d1.x === 3, 'a good position beside a bad one survives', JSON.stringify(t.layout));
    ok(!t.layout.d2 && codes(t).indexOf('E_LAYOUT_BAD_ENTRY') !== -1, 'and the bad one is reported',
      JSON.stringify(codes(t)));

    // An array is an object, and was accepted - then its positions were dropped at the next save.
    const arr = doc(twoDevices());
    arr.layout = [{ x: 1, y: 1 }];
    const ta = Topology.fromJSON(arr);
    ok(codes(ta).indexOf('E_LAYOUT_MALFORMED') !== -1 && Object.keys(ta.layout).length === 0,
      'a layout that is an array is refused as malformed', JSON.stringify(codes(ta)));
  }

  console.log('');
  console.log('Over HTTP, zero is a coordinate and a bad position is a bad request:');
  {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-layout-'));
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
      const placed = await request('POST', '/api/topologies/default/devices',
        { vendor: SW.vendor, model: SW.model, x: 0, y: 0 });
      ok(placed.status === 201, 'a device can be placed at the origin', String(placed.status));
      const devId = placed.body.device.id;
      const pos = placed.body.state.layout[devId];
      ok(pos && pos.x === 0 && pos.y === 0, 'and it is at 0,0 rather than 160,160', JSON.stringify(pos));

      const bad = await request('POST', '/api/topologies/default/layout', { positions: { [devId]: { x: 'left', y: 0 } } });
      ok(bad.status === 400 && /must be \x7b x, y \x7d/.test(String(bad.body.error)),
        'a position that is not a position is a 400 naming the rule', bad.status + ' ' + String(bad.body.error));
      const after = await request('GET', '/api/topologies/default');
      ok(after.body.layout[devId].x === 0, 'and the board did not move', JSON.stringify(after.body.layout[devId]));

      const good = await request('POST', '/api/topologies/default/layout', { positions: { [devId]: { x: 300, y: 120 } } });
      ok(good.status === 200, 'a real position is accepted', String(good.status));
      const moved = await request('GET', '/api/topologies/default');
      ok(moved.body.layout[devId].x === 300 && moved.body.layout[devId].y === 120, 'and applied',
        JSON.stringify(moved.body.layout[devId]));

      const gone = await request('DELETE', '/api/topologies/default/devices/' + devId);
      ok(gone.status === 200 && !gone.body.state.layout[devId],
        'and deleting the device takes its position with it', JSON.stringify(gone.body.state.layout));
    } finally {
      try { child.kill('SIGKILL'); } catch (e) {}
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
    }
  }

  console.log('');
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
