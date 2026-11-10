'use strict';
// "Will this work in five seconds?" - answerable from the console, and from nowhere else (#1381).
//
// `Simulator.ping()` has honoured `opts.atMs` since convergence was modelled, and the console has had
// `ping <address> at <ms>`. `POST /ping` dropped both the instant and the accounting:
//
//   * `atMs` was not read, so every HTTP ping was asked at Infinity and a lab mid-convergence could not be
//     questioned through the API;
//   * it ran on `new Simulator(topo)` - a second accounting with its own flow state - so the packets it sent were
//     invisible to `/flows`, while the same ping typed into the console was counted. That is the defect #1335 fixed
//     for the console endpoint, one endpoint over.
//
// Each question gets its own board, so one answer cannot depend on how many questions were asked before it.
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
const SW = specs.find(function (s) { return /CX 6000 24G CL4/.test(s.model); }) ||
  specs.find(function (s) { return /CX 6000/.test(s.model); });
const HOST = specs.find(function (s) { return /Raspberry Pi 5/.test(s.model); }) ||
  specs.find(function (s) { return /^(pc|host)/i.test(s.category || ''); });

(async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-pingat-'));
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

  // A switch and two hosts on one VLAN. The access ports listen for 30 s, so the lab is visibly mid-convergence
  // at t=0 and settled from t=30000.
  const buildLab = async function (board) {
    const base = '/api/topologies/' + board;
    const created = await request('POST', '/api/topologies', { id: board });
    if (created.status !== 201 && created.status !== 200) throw new Error('could not create ' + board + ': ' + created.status);
    const ids = {};
    for (const key of ['sw', 'h1', 'h2']) {
      const spec = key === 'sw' ? SW : HOST;
      const r = await request('POST', base + '/devices', { vendor: spec.vendor, model: spec.model });
      ids[key] = r.body && r.body.device && r.body.device.id;
    }
    const state = await request('GET', base);
    const dev = function (id) { return (state.body.devices || []).filter(function (d) { return d.id === id; })[0]; };
    const usable = function (id) {
      return (dev(id).interfaces || []).filter(function (i) { return !/^(mgmt|console|aux)/i.test(i.name); })[0].name;
    };
    const h1Port = usable(ids.h1);
    const h2Port = usable(ids.h2);
    await request('POST', base + '/links', {
      a: { deviceId: ids.h1, iface: h1Port }, b: { deviceId: ids.sw, iface: '1/1/1' },
      mediaId: '1000base-t', speedMbps: 1000
    });
    await request('POST', base + '/links', {
      a: { deviceId: ids.h2, iface: h2Port }, b: { deviceId: ids.sw, iface: '1/1/2' },
      mediaId: '1000base-t', speedMbps: 1000
    });
    await request('POST', base + '/interfaces/' + ids.h1 + '/' + h1Port, { ip: '10.9.0.1', mask: '255.255.255.0' });
    await request('POST', base + '/interfaces/' + ids.h2 + '/' + h2Port, { ip: '10.9.0.2', mask: '255.255.255.0' });
    return { base: base, ids: ids, h1Port: h1Port, h2Port: h2Port };
  };

  try {
    for (let i = 0; i < 60; i++) {
      try { await request('GET', '/api/topologies'); break; } catch (e) { await new Promise(function (r) { setTimeout(r, 100); }); }
    }

    const instant = await buildLab('instant');
    ok(!!instant.ids.sw && !!instant.ids.h1 && !!instant.ids.h2,
      'a switch and two hosts on a board of its own');
    const settled = await request('POST', instant.base + '/ping', { src: instant.ids.h1, dst: '10.9.0.2', count: 1 });
    ok(settled.body.replies[0].success === true, 'the lab is sound: a ping now succeeds',
      JSON.stringify(settled.body.replies[0]).slice(0, 120));

    console.log('');
    console.log('POST /ping can be asked at an instant:');
    const zeroBoard = await buildLab('att');
    const early = await request('POST', zeroBoard.base + '/ping', { src: zeroBoard.ids.h1, dst: '10.9.0.2', count: 1, atMs: 0 });
    ok(early.status === 200, 'the request is accepted', String(early.status));
    ok(early.body.runAtMs === 0, 'the answer says which instant it was given at', String(early.body.runAtMs));
    ok(early.body.replies[0].success === false, 'at t=0 the path is not up yet');
    ok(early.body.replies[0].reason === 'converging', 'and that is reported as convergence, not as packet loss',
      String(early.body.replies[0].reason));
    ok(early.body.replies[0].convergingUntilMs === 30000, 'with the instant it will be ready',
      String(early.body.replies[0].convergingUntilMs));

    // The console, on a board of its own, says the same thing at the same instant.
    const consoleBoard = await buildLab('cns');
    const viaConsole = await request('POST', consoleBoard.base + '/config/' + consoleBoard.ids.h1,
      { commands: ['ping 10.9.0.2 1 at 0'], atMs: 0 });
    const consoleText = String((viaConsole.body && viaConsole.body.output) || '');
    ok(/converging/.test(consoleText), 'the console says the same thing at t=0', consoleText.slice(0, 80));

    const lateBoard = await buildLab('late');
    const later = await request('POST', lateBoard.base + '/ping', { src: lateBoard.ids.h1, dst: '10.9.0.2', count: 1, atMs: 60000 });
    ok(later.body.replies[0].success === true, 'at t=60000 the same ping succeeds',
      JSON.stringify(later.body.replies[0]).slice(0, 120));
    ok(later.body.runAtMs === 60000, 'and the answer says so', String(later.body.runAtMs));

    console.log('');
    console.log('An instant that is not an instant is a 400:');
    for (const bad of [-1, 'abc', {}]) {
      const r = await request('POST', lateBoard.base + '/ping', { src: lateBoard.ids.h1, dst: '10.9.0.2', atMs: bad });
      ok(r.status === 400 && /E_BAD_INSTANT/.test(JSON.stringify(r.body)),
        'atMs ' + JSON.stringify(bad) + ' is a 400 naming the rule', String(r.status) + ' ' + JSON.stringify(r.body).slice(0, 120));
    }
    const atZero = await request('POST', lateBoard.base + '/ping', { src: lateBoard.ids.h1, dst: '10.9.0.2', atMs: 0, count: 1 });
    ok(atZero.status === 200, 'atMs 0 is legal (it is a time, not a missing value)', String(atZero.status));

    console.log('');
    console.log('A ping over HTTP is counted where every other packet is counted:');
    // The device totals are flow accounting (transport payload), so ICMP deliberately does not move them; the
    // port tallies are interface accounting and count every frame. One ping, seen three ways.
    const tally = function (body, devId, portName) {
      const c = (body.counters || {})[devId] || {};
      const p = (c.ports || {})[portName] || {};
      return { packetsOut: p.packetsOut || 0, bytesOut: p.bytesOut || 0 };
    };
    const countBoard = await buildLab('count');
    const before = await request('GET', countBoard.base + '/flows');
    const beforeTally = tally(before.body, countBoard.ids.h1, countBoard.h1Port);
    ok(beforeTally.packetsOut === 0 && beforeTally.bytesOut === 0,
      'before the ping the host has carried nothing, as far as /flows knows',
      JSON.stringify({ counters: Object.keys(before.body.counters || {}), tally: beforeTally }));

    const sent = await request('POST', countBoard.base + '/ping', { src: countBoard.ids.h1, dst: '10.9.0.2', count: 3 });
    ok(sent.body.replies.filter(function (r) { return r.success; }).length === 3,
      'three echoes answered', JSON.stringify(sent.body.replies.map(function (r) { return r.reason || 'ok'; })));
    const after = await request('GET', countBoard.base + '/flows');
    const afterTally = tally(after.body, countBoard.ids.h1, countBoard.h1Port);
    ok(afterTally.packetsOut >= 3, 'and /flows counted the frames that left the host',
      JSON.stringify({ before: beforeTally, after: afterTally }));
    ok(afterTally.bytesOut > 0, 'bytes and all', JSON.stringify(afterTally));
    const answerTally = { packetsOut: ((sent.body.counters || {}).ports || {})[countBoard.h1Port]
      ? sent.body.counters.ports[countBoard.h1Port].packetsOut : 0 };
    ok(answerTally.packetsOut === afterTally.packetsOut,
      'the ping answer carries the same counters /flows reports, not a second set',
      JSON.stringify({ answer: answerTally.packetsOut, flows: afterTally.packetsOut }));

    // ...and `show interfaces` on the same port prints that number, so the three surfaces agree.
    const shown = await request('POST', countBoard.base + '/config/' + countBoard.ids.h1,
      { commands: ['show interfaces ' + countBoard.h1Port] });
    const showText = String((shown.body && shown.body.output) || '');
    const m = showText.match(/(\d+) packets output/);
    ok(!!m, 'the console prints the port output count', showText.slice(0, 100));
    ok(m && Number(m[1]) === afterTally.packetsOut,
      'and it is the same number /flows reports', JSON.stringify({ show: m && Number(m[1]), flows: afterTally.packetsOut }));

    console.log('');
    console.log('...and a ping the console sends lands in the same tally:');
    await request('POST', countBoard.base + '/config/' + countBoard.ids.h1, { commands: ['ping 10.9.0.2 2'] });
    const afterConsole = await request('GET', countBoard.base + '/flows');
    const consoleTally = tally(afterConsole.body, countBoard.ids.h1, countBoard.h1Port);
    ok(consoleTally.packetsOut > afterTally.packetsOut,
      'a console ping is counted in the same place as an API ping',
      JSON.stringify({ api: afterTally.packetsOut, console: consoleTally.packetsOut }));
  } finally {
    child.kill();
  }

  console.log('');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})();
