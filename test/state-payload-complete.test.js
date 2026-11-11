'use strict';
// One state read shows both halves of one fact (#1433).
//
// The state payload (`GET /api/topologies/:id`) carries the board, the per-device runtime tables, and - since this
// change - the DHCP leases and the flow table. Before, a client that opened a flow and then read the state saw nothing
// about it (`flows` was absent), and a client that read the board after a DHCP exchange could see the client holding
// 10.91.0.10 but not the server's binding for the same address - the two halves of one lease, only one published.
// `/flows` and `show ip dhcp binding` had them; the board payload did not.
//
// The same payload must also be what a second client sees: the lease state and the flow state live on the topology,
// not on a request (#1427, #1429), so two clients reading the same board read the same facts.
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-state-'));
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
    await add({ vendor: 'cisco', model: 'ISR 4331', id: 'r1', x: 100, y: 100 });
    await add({ vendor: 'generic', model: 'generic-switch', id: 'sw', x: 300, y: 100 });
    await add({ vendor: 'generic', model: 'generic-pc', id: 'a', x: 500, y: 50 });
    await wire('r1', 'Gi0/0/0', 'sw', 'Fa0/1');
    await wire('sw', 'Fa0/2', 'a', 'eth0');
    await conf('r1', ['configure terminal', 'ip dhcp pool LAN', 'network 10.91.0.0 255.255.255.0',
      'range 10.91.0.10 10.91.0.50', 'default-router 10.91.0.1', 'end']);
    await conf('r1', ['configure terminal', 'interface Gi0/0/0', 'ip address 10.91.0.1 255.255.255.0', 'no shutdown', 'end']);
    await conf('a', ['configure terminal', 'interface eth0', 'ip address dhcp', 'end']);

    console.log('');
    console.log('A board with nothing running yet still has the two tables, empty:');
    {
      const s = await state();
      ok(Array.isArray(s.flows) && s.flows.length === 0, 'flows is present and empty before any conversation', JSON.stringify(s.flows));
      const leases = (s.runtime.r1 || {}).dhcpLeases;
      ok(Array.isArray(leases) && leases.length === 0, 'dhcpLeases is present and empty before any lease',
        JSON.stringify(leases));
      // a device with no pools reports an empty list too, not a missing key
      const other = (s.runtime.sw || {}).dhcpLeases;
      ok(Array.isArray(other), 'a switch with no pools has an empty lease list, not an absent one', JSON.stringify(other));
    }

    console.log('');
    console.log('After a DHCP exchange, one state read shows both halves:');
    {
      await request(port, 'POST', B('lab/ping'), { src: 'a', dst: '10.91.0.1', count: 2 });
      const s = await state();
      const a = (s.devices || []).filter(function (x) { return x.id === 'a'; })[0];
      const heldIp = a.interfaces[0].ip;
      ok(!!heldIp, 'the client holds an address', String(heldIp));
      const leases = (s.runtime.r1 || {}).dhcpLeases || [];
      ok(leases.some(function (l) { return l.ip === heldIp; }),
        'and the server\'s lease for the same address is in the same payload',
        JSON.stringify(leases) + ' vs held ' + heldIp);
      ok(leases[0] && leases[0].pool === 'LAN', 'the lease names its pool', JSON.stringify(leases[0]));
      // the console's view agrees
      const view = (await conf('r1', ['show ip dhcp binding'])).body.lines.join('\n');
      ok(view.indexOf(heldIp) !== -1, 'and `show ip dhcp binding` prints the same address', view);
    }

    console.log('');
    console.log('After a flow opens, the same payload carries it:');
    {
      const opened = await request(port, 'POST', B('lab/flows'),
        { proto: 'tcp', srcDevice: 'a', dstDevice: 'r1', srcPort: 50000, dstPort: 22, bytes: 100 });
      ok(opened.status === 201, 'the flow opens', String(opened.status));
      const s = await state();
      const flows = s.flows || [];
      ok(flows.length === 1 && flows[0].state === 'established', 'the state payload lists it as established',
        JSON.stringify(flows.map(function (f) { return f.state; })));
      ok(Array.isArray(flows[0].hops) && flows[0].hops.length === 3, 'with the path it took',
        JSON.stringify(flows[0].hops));
      ok(JSON.stringify(flows[0].hops) === JSON.stringify(['a', 'sw', 'r1']), 'the actual hops, in order',
        JSON.stringify(flows[0].hops));
      // and /flows agrees - one table, two doors
      const list = (await request(port, 'GET', B('lab/flows'))).body;
      ok((list.flows || []).length === 1 && list.flows[0].id === flows[0].id,
        'and `GET /flows` shows the same flow', JSON.stringify((list.flows || []).map(function (f) { return f.id; })));
    }

    console.log('');
    console.log('And a removal is visible in the same payload - the conversation does not outlive its path:');
    {
      const del = await request(port, 'DELETE', B('lab/devices/sw'));
      ok(del.status === 200, 'the middle switch is deleted', String(del.status));
      const s = await state();
      const flows = s.flows || [];
      ok(flows.length === 1 && flows[0].state === 'reset', 'and the flow is reset in the state payload too',
        JSON.stringify(flows.map(function (f) { return f.state; })));
      ok(/sw/.test(String(flows[0].reason)), 'with a reason naming what went', String(flows[0].reason));
      ok((del.body.resetFlows || []).length === 1, 'and the delete answer named it as well',
        JSON.stringify(del.body.resetFlows));
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
