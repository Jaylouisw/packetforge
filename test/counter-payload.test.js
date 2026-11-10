'use strict';
// One shape for throughput, and a copy (#1329).
//
// `runtime[d].counters` was the last block of the state payload built by hand on the way out:
//
//   counters: counters[d.id] || { bytesIn: 0, ..., flowsRefused: 0 }
//
// Two faults in one line. The fallback had **six** keys and the real record has **eight** (`drops`, `ports`), so a
// client adding up drops on a device with no traffic read `undefined` and drew NaN, in a lab where the busier device
// beside it had the full record — one field, two shapes. And `counters[d.id]` was the engine's own live record, so
// editing what you were handed edited the tally - the third time a payload has handed out live state (#1323 for
// link endpoints, #1325 for layout).
//
// `flow.counterSnapshot()` is now what the payload carries: the whole shape always, a copy, and `counted` so
// "nothing has ever crossed this device" is not the same answer as "zero here".
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const { loadCatalog } = require('../devices/registry');
const { Topology } = require('../engine/topology');
const { Simulator } = require('../engine/simulator');
const flow = require('../engine/flow');

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

function lab() {
  const t = new Topology();
  t.addDevice(SW, 'sw'); t.addDevice(HOST, 'h1'); t.addDevice(HOST, 'h2');
  t.connect('sw', '1/1/1', 'h1', 'eth0');
  t.connect('sw', '1/1/2', 'h2', 'eth0');
  const h1 = t.getDevice('h1'), h2 = t.getDevice('h2');
  h1.interfaces.get('eth0').ip = '10.0.0.1'; h1.interfaces.get('eth0').mask = '255.255.255.0';
  h2.interfaces.get('eth0').ip = '10.0.0.2'; h2.interfaces.get('eth0').mask = '255.255.255.0';
  const sim = new Simulator(t, { flowState: flow.createFlowState() });
  t.flowState = sim.flowState;
  return { t: t, sim: sim, h1: h1, h2: h2 };
}
const SHAPE = ['bytesIn', 'bytesOut', 'packetsIn', 'packetsOut', 'flowsOpened', 'flowsRefused', 'counted', 'drops', 'ports'];

(async function main() {
  console.log('');
  console.log('One shape, whatever the device has done:');
  {
    const x = lab();
    x.sim.ping('h1', '10.0.0.2', { count: 1 });
    const busy = flow.counterSnapshot(x.t.flowState, 'h1');
    const idle = flow.counterSnapshot(x.t.flowState, 'sw');       // has carried control frames only
    const never = flow.counterSnapshot(x.t.flowState, 'ghost');   // has never existed
    const sets = [busy, idle, never].map(function (c) { return Object.keys(c).sort().join(','); });
    ok(sets[0] === sets[1] && sets[1] === sets[2], 'three devices in three states have the same keys',
      JSON.stringify(sets));
    ok(sets[0].split(',').join() === SHAPE.slice().sort().join(), 'and the keys are the documented ones', sets[0]);
    ok(typeof busy.drops.total === 'number' && typeof idle.drops.total === 'number' &&
      typeof never.drops.total === 'number', 'drops.total is a number on every one of them',
      [busy, idle, never].map(function (c) { return typeof c.drops.total; }).join());
    ok(busy.ports && typeof busy.ports === 'object' && never.ports && Object.keys(never.ports).length === 0,
      'and ports is an object, empty when nothing crossed', JSON.stringify(Object.keys(never.ports)));
    ok(Object.keys(idle.ports).length > 0 && idle.packetsIn === 0,
      'a switch that only forwarded frames has port tallies and no transport packets - two counts, two questions',
      JSON.stringify({ ports: Object.keys(idle.ports), packetsIn: idle.packetsIn }));

    // An idle device is not a broken one: `counted` separates the two facts a zero cannot.
    ok(busy.counted === true, 'a device that has carried something says so', String(busy.counted));
    ok(never.counted === false, 'and one that has carried nothing says that instead of showing a bare zero',
      String(never.counted));
  }

  console.log('');
  console.log('The snapshot is a snapshot:');
  {
    const x = lab();
    x.sim.ping('h1', '10.0.0.2', { count: 1 });
    const live = x.t.flowState.counters.h1;
    const snap = flow.counterSnapshot(x.t.flowState, 'h1');
    ok(snap !== live && snap.drops !== live.drops && snap.ports !== live.ports,
      'nothing in the snapshot is the engine record or one of its children');
    const before = JSON.stringify({ d: live.drops, p: live.ports, po: live.packetsOut });
    snap.drops.total = 999;
    snap.drops.byReason.made_up = 5;
    snap.ports.eth0.packetsOut = 999;
    snap.packetsOut = 999;
    const after = JSON.stringify({ d: live.drops, p: live.ports, po: live.packetsOut });
    ok(before === after, 'so editing what you were given does not edit the tally', after);
  }

  console.log('');
  console.log('The numbers are the engine\'s numbers:');
  {
    const x = lab();
    x.sim.ping('h1', '10.0.0.2', { count: 2 });
    const snap = flow.counterSnapshot(x.t.flowState, 'h1');
    const live = x.t.flowState.counters.h1;
    const pairs = [['bytesIn', snap.bytesIn, live.bytesIn], ['bytesOut', snap.bytesOut, live.bytesOut],
      ['packetsIn', snap.packetsIn, live.packetsIn], ['packetsOut', snap.packetsOut, live.packetsOut],
      ['flowsOpened', snap.flowsOpened, live.flowsOpened], ['flowsRefused', snap.flowsRefused, live.flowsRefused],
      ['drops.total', snap.drops.total, live.drops.total]];
    const wrong = pairs.filter(function (p) { return p[1] !== p[2]; });
    ok(wrong.length === 0, pairs.length + ' fields match the record they came from', JSON.stringify(wrong));
    // Per-port, copied with their own drop reasons.
    const port = Object.keys(live.ports)[0];
    ok(port && snap.ports[port] && snap.ports[port].packetsOut === live.ports[port].packetsOut &&
      snap.ports[port].drops.total === (live.ports[port].drops || {}).total,
      'and each port tally comes across with its own drop count', JSON.stringify(snap.ports[port]));

    // The device totals count transport payload, not every frame - a distinction the engine documents and a reader
    // of the payload has no other way to learn.
    const swSnap = flow.counterSnapshot(x.t.flowState, 'sw');
    ok(swSnap.ports['1/1/1'] && swSnap.ports['1/1/1'].packetsIn > swSnap.packetsIn,
      'the port tallies count every frame while the device totals count transport payload',
      JSON.stringify({ port: swSnap.ports['1/1/1'] && swSnap.ports['1/1/1'].packetsIn, device: swSnap.packetsIn }));
  }

  console.log('');
  console.log('Over HTTP, both devices come back with the same shape:');
  {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-counters-'));
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
      const a = await request('POST', '/api/topologies/default/devices', { vendor: SW.vendor, model: SW.model });
      const b = await request('POST', '/api/topologies/default/devices', { vendor: HOST.vendor, model: HOST.model });
      const state = await request('GET', '/api/topologies/default');
      const ca = state.body.runtime[a.body.device.id].counters;
      const cb = state.body.runtime[b.body.device.id].counters;
      ok(Object.keys(ca).sort().join() === Object.keys(cb).sort().join(),
        'two devices with nothing in common have the same counter keys',
        Object.keys(ca).sort().join() + ' vs ' + Object.keys(cb).sort().join());
      ok(ca.drops && typeof ca.drops.total === 'number' && ca.drops.byReason && typeof ca.drops.byReason === 'object',
        'drops is there with a number and a reason map', JSON.stringify(ca.drops));
      ok(ca.counted === false, 'and an untouched device says it has counted nothing', String(ca.counted));
      ca.drops.total = 12345;
      const again = await request('GET', '/api/topologies/default');
      ok(again.body.runtime[a.body.device.id].counters.drops.total === 0,
        'and the answer is a snapshot: nothing done to it reaches the next read',
        String(again.body.runtime[a.body.device.id].counters.drops.total));
    } finally {
      try { child.kill('SIGKILL'); } catch (e) {}
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
    }
  }

  console.log('');
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
