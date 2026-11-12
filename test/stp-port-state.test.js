'use strict';
// A port the tree blocks cannot carry a frame, and every view must say so (#1441).
//
// `show spanning-tree` printed `Fa0/1  alternate  blocking  (traffic dropped)` for a port that was dropping
// everything. The board painted the same port green: `portState()` - the one rule the faceplate cell, the canvas
// tooltip and the inspector footer all ask - knew about shut ports, unplugged sockets, link-down cables and a shut
// peer, and nothing about the tree. The state payload did not carry the tree either, so the views could not have
// known. This file proves the fact is published, says the console's words, and reaches all three views.
//
// It must also prove the opposite mistake is not made: a blocked port is *not* a fault. A redundant lab blocks
// ports by design, so painting them red would report a healthy tree as a broken board - the same trap `notconnect`
// avoids for empty sockets.
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const faceplate = require('../web/faceplate.js');

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

// A triangle of three switches: the tree's only way to stay loop-free is to block exactly one port.
(async function () {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-stp-'));
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
  const conf = function (dev, commands) { return request(port, 'POST', B('lab/config/' + dev), { commands: commands }); };
  const state = async function () { return (await request(port, 'GET', B('lab'))).body; };

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
    const SW = { vendor: 'generic', model: 'generic-switch' };
    await add(Object.assign({ id: 's1', x: 100, y: 100 }, SW));
    await add(Object.assign({ id: 's2', x: 320, y: 100 }, SW));
    await add(Object.assign({ id: 's3', x: 210, y: 260 }, SW));
    await add({ vendor: 'cisco', model: 'ISR 4331', id: 'r9', x: 520, y: 100 });
    await wire('s1', 'Fa0/1', 's2', 'Fa0/1');
    await wire('s2', 'Fa0/2', 's3', 'Fa0/1');
    await wire('s3', 'Fa0/2', 's1', 'Fa0/2');

    console.log('');
    console.log('The tree is in the payload, and it names the port it shut:');
    const s = await state();
    const stpOf = function (devId) { return (s.runtime && s.runtime[devId] && s.runtime[devId].stp) || null; };
    const blockedPorts = [];
    Object.keys(s.runtime || {}).forEach(function (devId) {
      const ports = stpOf(devId) || {};
      Object.keys(ports).forEach(function (name) {
        if (ports[name] && ports[name].blocked === true) blockedPorts.push({ dev: devId, port: name, row: ports[name] });
      });
    });
    ok(!!stpOf('s1') && Object.keys(stpOf('s1')).length > 0,
      'a switch publishes what the tree decided about each port', JSON.stringify(stpOf('s1')));
    ok(blockedPorts.length === 1,
      'a triangle blocks exactly one port, and the payload says which', JSON.stringify(blockedPorts.map(function (b) { return b.dev + ':' + b.port; })));
    const shut = blockedPorts[0];
    ok(shut && shut.row.state === 'blocking', 'the blocked port is in state blocking', shut && JSON.stringify(shut.row));
    ok(shut && shut.row.role === 'alternate', 'and carries the role that explains why', shut && String(shut.row.role));
    ok(shut && shut.row.text === 'blocking (traffic dropped)',
      'and the sentence says what happens to the traffic, not merely "blocking"', shut && String(shut.row.text));

    const forwardPort = (function () {
      const ports = stpOf('s1') || {};
      return Object.keys(ports).filter(function (n) { return ports[n] && ports[n].blocked === false; })[0];
    })();
    ok(!!forwardPort, 'a port the tree forwards is published too, marked not blocked', String(forwardPort));
    ok(forwardPort && (stpOf('s1')[forwardPort] || {}).text !== 'blocking (traffic dropped)',
      'and its sentence is not the blocked one', forwardPort && JSON.stringify(stpOf('s1')[forwardPort]));

    console.log('');
    console.log('A box that is not a bridge publishes nothing about a tree:');
    ok((s.runtime.r9 || {}).stp === null,
      'a router reports no tree at all, rather than an empty one that reads as "nothing is blocked"',
      JSON.stringify((s.runtime.r9 || {}).stp));

    console.log('');
    console.log('The console and the payload use the same words:');
    const row = (await conf(shut.dev, ['show spanning-tree'])).body.lines.join('\n');
    const rowLine = row.split('\n').filter(function (l) { return l.indexOf(shut.port) === 0; })[0] || '';
    ok(/blocking\s+\(traffic dropped\)/.test(rowLine),
      '`show spanning-tree` prints a row for that port saying the traffic is dropped', rowLine);
    ok(rowLine.replace(/\s+/g, ' ').indexOf(shut.row.text) !== -1,
      'and the payload\'s sentence appears in that row word for word',
      rowLine.replace(/\s+/g, ' ') + ' vs ' + shut.row.text);

    console.log('');
    console.log('The one rule every view asks now takes the tree into account:');
    const blockedVerdict = faceplate.portState({ enabled: true, cabled: true, blocked: true });
    ok(blockedVerdict.state === 'blocked', 'a cabled, up, blocked port is not reported as up', JSON.stringify(blockedVerdict));
    ok(faceplate.portStateText({ enabled: true, cabled: true, blocked: true }) === 'blocking (traffic dropped)',
      'the tooltip sentence is the console\'s sentence',
      faceplate.portStateText({ enabled: true, cabled: true, blocked: true }));
    ok(blockedVerdict.state !== 'down',
      'a blocked port is not painted as a fault: a redundant lab blocks ports by design', JSON.stringify(blockedVerdict));
    ok(faceplate.portStateText({ enabled: true, cabled: true, blocked: true }).indexOf('down') === -1,
      'and neither sentence contains the word a fault uses', faceplate.portStateText({ enabled: true, cabled: true, blocked: true }));

    console.log('');
    console.log('And it does not overrule the facts it is not about:');
    ok(faceplate.portState({ enabled: false, cabled: true, blocked: true }).state === 'down',
      'a shut port is still administratively down, whatever the tree thinks',
      JSON.stringify(faceplate.portState({ enabled: false, cabled: true, blocked: true })));
    ok(faceplate.portState({ enabled: true, cabled: false, blocked: true }).state === 'notconnect',
      'an unplugged port is still not connected', JSON.stringify(faceplate.portState({ enabled: true, cabled: false, blocked: true })));
    ok(faceplate.portState({ enabled: true, cabled: true, peerEnabled: false, blocked: true }).reason === 'peer shut down',
      'a shut peer still wins', JSON.stringify(faceplate.portState({ enabled: true, cabled: true, peerEnabled: false, blocked: true })));
    ok(faceplate.portState({ enabled: true, cabled: true }).state === 'cabled',
      'a port with no tree information is unchanged', JSON.stringify(faceplate.portState({ enabled: true, cabled: true })));
    ok(faceplate.portState({ enabled: true, cabled: true, blocked: undefined }).state === 'cabled',
      'and so is one that was told `undefined` - an unknown tree is not a blocking tree',
      JSON.stringify(faceplate.portState({ enabled: true, cabled: true, blocked: undefined })));

    console.log('');
    console.log('The readers find the tree in either shape a caller holds:');
    const asTopologyDoc = { runtime: s.runtime };
    const asCanvasState = { topology: { runtime: s.runtime } };
    ok(!!faceplate.stpOf(asTopologyDoc, shut.dev), 'the panel\'s shape (the topology document) resolves');
    ok(!!faceplate.stpOf(asCanvasState, shut.dev), 'the canvas\'s shape (`state.topology`) resolves');
    ok(faceplate.stpOf(asTopologyDoc, 'nope') === null, 'an unknown device resolves to null, not to an empty tree');
    ok(faceplate.stpVerdict(null, shut.port) === undefined, 'and an unknown tree is `undefined`, not `blocked: false`');
    ok(faceplate.stpVerdict(faceplate.stpOf(asTopologyDoc, shut.dev), shut.port).blocked === true,
      'a known tree answers blocked for the port it shut');
    ok(faceplate.stpVerdict(faceplate.stpOf(asTopologyDoc, shut.dev), 'Fa0/99') === undefined,
      'and `undefined` for a port it never reported');

    console.log('');
    console.log('No view was left deriving the answer from something else:');
    const canvasSrc = fs.readFileSync(path.join(ROOT, 'web', 'canvas.js'), 'utf8');
    const appSrc = fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8');
    const fpSrc = fs.readFileSync(path.join(ROOT, 'web', 'faceplate.js'), 'utf8');
    ok(/stpVerdict\(lib\.stpOf\(/.test(canvasSrc), 'the canvas asks the shared rule for the tree\'s verdict');
    ok(/blocked: stpFacts \? stpFacts\.blocked : undefined/.test(canvasSrc),
      'and passes the fact into `portState`, so the canvas cannot disagree');
    ok(/stpVerdict\(lib\.stpOf\(topo, dev\.id\)/.test(appSrc), 'the inspector asks the same place');
    ok(/blocked: stpFacts \? stpFacts\.blocked : undefined/.test(appSrc),
      'and passes the fact too, so the status bar cannot call a blocked port healthy');
    ok(/linkState\.state === 'blocked'/.test(fpSrc), 'the faceplate cell renders the blocked state it is given');
    ok(/fp-blocked/.test(fs.readFileSync(path.join(ROOT, 'web', 'faceplate.css'), 'utf8')),
      'and the stylesheet has a colour for it that is not the alarm colour');
  } finally {
    child.kill();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  }

  console.log('');
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
})().catch(function (e) {
  console.error('  \u2717 ' + (e && e.stack || e));
  process.exitCode = 1;
});
