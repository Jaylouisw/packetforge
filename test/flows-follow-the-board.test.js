'use strict';
// A conversation cannot outlive its path (#1427).
//
// The flow table belongs to the topology, but nothing told it when the topology changed. Measured against a live
// server, with r1 -- sw -- h1 and one established TCP conversation:
//
//   DELETE /links/l1        ->  200, and flow-1 is still `established` across a board with no cable
//   DELETE /devices/sw      ->  200, and flow-1 is still `established` on a two-device board with no links at all
//   create a new `sw`       ->  the brand-new switch reports packetsIn 5, packetsOut 5, ports {1: 6/5, 2: 5/6}
//
// The first two are a board and a description of the board that disagree: a state no packet could produce, which
// nothing would ever correct. The third is worse than stale - it is a new device inheriting a dead device's tally, so
// "is this switch passing traffic?" answers yes for a box that was created a second ago.
//
// What makes this checkable is that a flow already knows the answer: it crossed specific devices, and those hops are in
// its own timeline. `rec.hops` is that path. So removal asks a fact, not a guess - and a flow whose path is untouched
// is left strictly alone, because a lab that healed should not lose its conversation.
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
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

function request(port, method, urlPath, body) {
  return new Promise(function (resolve, reject) {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: port, path: urlPath, method: method,
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

(async function () {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-flowpath-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: Object.assign({}, process.env, { PORT: String(port), PF_DATA: dataDir }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', function (d) { log += d; });
  child.stderr.on('data', function (d) { log += d; });

  const B = function (p) { return '/api/topologies/' + p; };
  const add = function (spec) { return request(port, 'POST', B('lab/devices'), spec); };
  const wire = function (a, ai, b, bi) {
    return request(port, 'POST', B('lab/links'), { a: { deviceId: a, iface: ai }, b: { deviceId: b, iface: bi } });
  };
  const flows = async function () {
    const r = await request(port, 'GET', B('lab/flows'));
    return (r.body && r.body.flows) || [];
  };
  const byId = function (list, id) { return list.filter(function (f) { return f.id === id; })[0] || null; };

  try {
    const deadline = Date.now() + 20000;
    for (;;) {
      try {
        const r = await request(port, 'GET', '/api/version');
        if (r.status === 200) break;
      } catch (e) { /* not up yet */ }
      if (child.exitCode !== null) throw new Error('server exited: ' + log);
      if (Date.now() > deadline) throw new Error('server never answered: ' + log.slice(-400));
      await new Promise(function (r) { setTimeout(r, 100); });
    }

    await request(port, 'POST', '/api/topologies', { id: 'lab' });
    // r1 and h1 are hosts that route; sw is in the middle and is the point of the exercise.
    await add({ vendor: 'advantech', model: 'ICR-3231', id: 'r1', x: 100, y: 100 });
    await add({ vendor: 'advantech', model: 'EKI-7708G-4FI', id: 'sw', x: 300, y: 100 });
    await add({ vendor: 'advantech', model: 'ICR-3231', id: 'h1', x: 500, y: 100 });
    await add({ vendor: 'advantech', model: 'ICR-3231', id: 'spare', x: 700, y: 100 });
    const l1 = await wire('r1', 'eth0', 'sw', '1');
    await wire('sw', '2', 'h1', 'eth0');
    ok(l1.status === 201, 'a lab with a switch in the middle', String(l1.status));
    await request(port, 'POST', B('lab/interfaces/r1/eth0'), { ip: '10.80.0.1', mask: '255.255.255.0' });
    await request(port, 'POST', B('lab/interfaces/h1/eth0'), { ip: '10.80.0.2', mask: '255.255.255.0' });
    const open = await request(port, 'POST', B('lab/flows'),
      { proto: 'tcp', srcDevice: 'r1', dstDevice: 'h1', srcPort: 40000, dstPort: 22, bytes: 1000 });
    ok(open.status === 201, 'and a conversation across it', String(open.status));

    console.log('');
    console.log('A flow knows the path it took:');
    {
      const rec = byId(await flows(), (open.body.flow || {}).id);
      ok(!!rec, 'the flow is in the table', JSON.stringify(open.body).slice(0, 120));
      ok(Array.isArray(rec.hops) && rec.hops.length === 3, 'and it records three hops', JSON.stringify(rec && rec.hops));
      ok(JSON.stringify(rec.hops) === JSON.stringify(['r1', 'sw', 'h1']),
        'in the order the packets took them, endpoints included', JSON.stringify(rec.hops));
      // A hop list that omitted the endpoints would pass a deletion test for the middle of the path and fail the ends;
      // one that repeated itself (the reply crosses the same switches in reverse) would do neither.
      ok(new Set(rec.hops).size === rec.hops.length, 'with each device once, not once per direction',
        JSON.stringify(rec.hops));
    }

    console.log('');
    console.log('A removed cable ends the conversation it carried, and says so:');
    {
      const flowId = (open.body.flow || {}).id;
      const del = await request(port, 'DELETE', B('lab/links/l1'));
      ok(del.status === 200, 'the cable is removed', String(del.status));
      const ended = (del.body && del.body.resetFlows) || [];
      ok(ended.some(function (e) { return e.id === flowId; }), 'the answer names the flow it ended',
        JSON.stringify(ended));
      const rec = byId(await flows(), flowId);
      ok(rec && rec.state === 'reset', 'the flow is no longer established', rec && rec.state);
      ok(rec && /no longer cabled/.test(String(rec.reason)), 'and the reason is the cable', rec && rec.reason);
      ok(rec && /l1/.test(String(rec.reason)), 'naming which cable', rec && rec.reason);
    }

    console.log('');
    console.log('A removed device ends the conversation that crossed it:');
    {
      await wire('r1', 'eth0', 'sw', '1');
      const again = await request(port, 'POST', B('lab/flows'),
        { proto: 'tcp', srcDevice: 'r1', dstDevice: 'h1', srcPort: 40001, dstPort: 22, bytes: 500 });
      ok(again.status === 201, 'a second conversation on the repaired lab', String(again.status));
      const flowId = (again.body.flow || {}).id;
      // `spare` was never cabled: removing it must not touch a conversation it had nothing to do with.
      const unrelated = await request(port, 'DELETE', B('lab/devices/spare'));
      ok(((unrelated.body || {}).resetFlows || []).length === 0,
        'deleting an unrelated device leaves it alone', JSON.stringify((unrelated.body || {}).resetFlows));
      const kept = byId(await flows(), flowId);
      ok(kept && kept.state === 'established', 'and the conversation is still established', kept && kept.state);

      const del = await request(port, 'DELETE', B('lab/devices/sw'));
      const ended = (del.body && del.body.resetFlows) || [];
      ok(ended.some(function (e) { return e.id === flowId; }), 'deleting the middle switch ends it',
        JSON.stringify(ended));
      const rec = byId(await flows(), flowId);
      ok(rec && rec.state === 'reset', 'the flow is reset', rec && rec.state);
      ok(rec && /device sw/.test(String(rec.reason)), 'with a reason naming the device', rec && rec.reason);
      // One failure, reported once: a flow already reset is not swept again.
      const twice = await request(port, 'DELETE', B('lab/devices/spare'));
      ok(((twice.body || {}).resetFlows || []).length === 0, 'and it is not reported a second time',
        JSON.stringify((twice.body || {}).resetFlows));
    }

    console.log('');
    console.log('And a device that is gone does not leave its tally behind:');
    {
      await add({ vendor: 'advantech', model: 'EKI-7708G-4FI', id: 'sw', x: 300, y: 100 });
      const state = (await request(port, 'GET', B('lab'))).body;
      const runtime = (state.runtime || {}).sw || {};
      const counters = runtime.counters || {};
      ok(counters.counted === false, 'a device created with the id of a deleted one starts uncounted',
        JSON.stringify(counters.counted));
      ok(!counters.packetsIn && !counters.packetsOut, 'with no packets from a device that no longer exists',
        JSON.stringify({ in: counters.packetsIn, out: counters.packetsOut }));
      const busy = Object.keys(counters.ports || {}).filter(function (k) {
        return counters.ports[k].packetsIn || counters.ports[k].packetsOut;
      });
      ok(busy.length === 0, 'and no port tallies', JSON.stringify(counters.ports));
    }
  } catch (e) {
    ok(false, 'the lab could be exercised', e && e.message);
  } finally {
    try { child.kill('SIGTERM'); } catch (e) {}
    await new Promise(function (r) { setTimeout(r, 300); });
    try { child.kill('SIGKILL'); } catch (e) {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('');
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
