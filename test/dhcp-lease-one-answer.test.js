'use strict';
// One question, one answer: the client's address and the server's binding are the same lease (#1429).
//
// A lease is a fact about the lab, and it used to be stored as a property of a *run*: `this._dhcpStates` was rebuilt
// for every Simulator, and the server builds a fresh Simulator for every request. So the client and its server were
// always in different requests. Measured against a live server, with r1 -- sw -- a/b and both PCs on `ip address dhcp`:
//
//   request 1 (a pings)        -> a holds 10.91.0.10
//   request 2 (the board is read) -> h1 eth0 ip: 10.91.0.10          <- the client's half says yes
//   request 3 (r1 is asked)   -> "% no leases: nothing has asked this server for an address yet"
//                                 "In use: 0 of 41 address(es)"    <- the server's half says no
//
// Two answers to one question, in one payload. And because every request started with an empty allocator, the next
// client was handed the address the first already holds - a conflict the lab created and could not report. Inside one
// run the allocator also never honoured an existing lease, so the clients traded addresses on every exchange
// (.10 -> .12 -> .11 across three runs) and no run could hold still.
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-dhcp-'));
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
  const ping = function (src) { return request(port, 'POST', B('lab/ping'), { src: src, dst: '10.91.0.1', count: 2 }); };
  const board = async function () {
    return (await request(port, 'GET', B('lab'))).body;
  };
  const ipOf = function (state, id) {
    const d = (state.devices || []).filter(function (x) { return x.id === id; })[0];
    return d.interfaces[0].ip;
  };
  const bindingText = async function (dev) {
    const r = await conf(dev, ['show ip dhcp binding']);
    return (r.body.lines || []).join('\n');
  };
  const poolText = async function (dev, pool) {
    const r = await conf(dev, ['show ip dhcp pool' + (pool ? ' ' + pool : '')]);
    return (r.body.lines || []).join('\n');
  };

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
    await add({ vendor: 'generic', model: 'generic-pc', id: 'b', x: 500, y: 200 });
    await wire('r1', 'Gi0/0/0', 'sw', 'Fa0/1');
    await wire('sw', 'Fa0/2', 'a', 'eth0');
    await wire('sw', 'Fa0/3', 'b', 'eth0');
    await conf('r1', ['configure terminal', 'ip dhcp pool LAN', 'network 10.91.0.0 255.255.255.0',
      'range 10.91.0.10 10.91.0.50', 'default-router 10.91.0.1', 'end']);
    await conf('r1', ['configure terminal', 'interface Gi0/0/0', 'ip address 10.91.0.1 255.255.255.0',
      'no shutdown', 'end']);
    for (const c of ['a', 'b']) {
      await conf(c, ['configure terminal', 'interface eth0', 'ip address dhcp', 'end']);
    }

    console.log('');
    console.log('Each client gets an address in its own request, and they differ:');
    {
      const p1 = await ping('a');
      ok(p1.status === 200 && p1.body.success === true, 'client a pings the gateway', String(p1.status));
      const p2 = await ping('b');
      ok(p2.status === 200 && p2.body.success === true, 'client b pings the gateway', String(p2.status));
      const state = await board();
      const ipA = ipOf(state, 'a'), ipB = ipOf(state, 'b');
      ok(ipA && ipB, 'and both hold an address', ipA + ' / ' + ipB);
      ok(ipA !== ipB, 'and the two addresses are different - no conflict', ipA + ' vs ' + ipB);
    }

    console.log('');
    console.log('And the server\'s binding table - a later request - says the same thing:');
    {
      const state = await board();
      const ipA = ipOf(state, 'a'), ipB = ipOf(state, 'b');
      const text = await bindingText('r1');
      ok(text.indexOf(ipA) !== -1, 'client a\'s address appears in `show ip dhcp binding`', text);
      ok(text.indexOf(ipB) !== -1, 'and so does client b\'s', text);
      ok(!/no leases/.test(text), 'the table is not empty while clients hold addresses', text);
      const pool = await poolText('r1', 'LAN');
      // The leases live on the topology now, so a request that ran no exchange still sees them - the count is a fact
      // about the lab, not about this request (#1429).
      ok(/In use:\s+2 of 41/.test(pool), 'and the pool counts both leases', pool.split('\n').filter(function (l) { return /In use/.test(l); })[0]);
      ok(pool.indexOf(ipA) !== -1 && pool.indexOf(ipB) !== -1, 'naming both addresses',
        pool.split('\n').slice(-2).join(' | '));
    }

    console.log('');
    console.log('And the addresses do not move between requests:');
    {
      const before = await board();
      const ipA0 = ipOf(before, 'a'), ipB0 = ipOf(before, 'b');
      await ping('a'); await ping('b'); await ping('a');
      const after = await board();
      ok(ipOf(after, 'a') === ipA0, 'client a keeps its address across later runs', ipA0 + ' -> ' + ipOf(after, 'a'));
      ok(ipOf(after, 'b') === ipB0, 'and so does client b', ipB0 + ' -> ' + ipOf(after, 'b'));
      const text = await bindingText('r1');
      ok(text.indexOf(ipA0) !== -1 && text.indexOf(ipB0) !== -1, 'and the table still shows the same two addresses', text);
    }

    console.log('');
    console.log('A reset clears both halves together:');
    {
      const r = await request(port, 'POST', B('lab/reset'));
      ok(r.status === 200, 'the reset is accepted', String(r.status));
      const state = await board();
      ok(ipOf(state, 'a') === null && ipOf(state, 'b') === null, 'the clients no longer hold addresses',
        ipOf(state, 'a') + ' / ' + ipOf(state, 'b'));
      const dhcpFlag = function (id) {
        const d = (state.devices || []).filter(function (x) { return x.id === id; })[0];
        return d.interfaces[0].dhcp;
      };
      ok(dhcpFlag('a') === true && dhcpFlag('b') === true, 'and they are still DHCP clients (that is configuration)',
        dhcpFlag('a') + ' / ' + dhcpFlag('b'));
      const text = await bindingText('r1');
      ok(/no leases/.test(text), 'and the server has no bindings left', text);
      // the typed address on the router is configuration and must survive
      const r1ip = (state.devices || []).filter(function (x) { return x.id === 'r1'; })[0];
      ok(r1ip.interfaces.filter(function (i) { return i.ip === '10.91.0.1'; }).length === 1,
        'while the address that was typed in stays', JSON.stringify(r1ip.interfaces.map(function (i) { return i.ip; })));
      // and a fresh exchange after the reset works
      const p = await ping('a');
      ok(p.body.success === true, 'a client can get an address again after the reset', String(p.body.success));
      const after = await board();
      ok(!!ipOf(after, 'a'), 'and it holds one', String(ipOf(after, 'a')));
      const text2 = await bindingText('r1');
      ok(text2.indexOf(ipOf(after, 'a')) !== -1, 'and the table shows it again', text2);
    }

    console.log('');
    console.log('A deleted server device forgets its leases, and a pool that cannot serve says why:');
    {
      await request(port, 'DELETE', B('lab/devices/r1'));
      await add({ vendor: 'cisco', model: 'ISR 4331', id: 'r1', x: 100, y: 100 });
      const text = await bindingText('r1');
      ok(!/10\.91\.0\.1[01]/.test(text), "a re-created server with the same id does not inherit the dead device's bindings", text);

      const pool = await conf('r1', ['configure terminal', 'ip dhcp pool HALF', 'network 10.99.0.0 255.255.255.0', 'end']);
      const view = await poolText('r1', 'HALF');
      ok(view.indexOf('undefined') === -1, '`show ip dhcp pool` never prints "undefined"', view);
      ok(/rangeStart and rangeEnd are required/.test(view), 'a pool that cannot serve says why', view);
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
