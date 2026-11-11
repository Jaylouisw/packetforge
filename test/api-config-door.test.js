'use strict';
// The API is a configuration door too (#1413).
//
// The console has been taught, one rule at a time, what an address is (#1411) and what a mask is (#1249). The HTTP
// surface edits a port directly - `POST /api/topologies/:id/interfaces/:devId/:port` - and it asked different
// questions, because it used the *parsers* rather than the rules:
//
//   POST {"ip":"10.5.5.1","mask":"255.0.255.0"}   → 200, and the port held a mask that is not a netmask
//   sw1#show running-config
//   ip address 10.5.5.1 255.0.255.0                ← a line the console itself refuses to type
//   sw1#show interfaces Gi0
//     ip: 10.5.5.1/8                               ← and every surface read it as /8
//
//   POST {"ip":"10.5.5.1","mask":"24"}            → 200, and the port held the *string* "24", while the console
//                                                  stores "255.255.255.0" for the same intent
//
// `POST /load` was the third door: `Device.hydrate` copies the port document through (right - it is the lab that was
// saved), so a hand-written or older document carrying a mask the engine refuses was adopted whole, and the board
// then contained a configuration that cannot be replayed.
//
// Four rules, asserted as rules rather than as today's strings:
//
//   1. a mask this build would refuse to type is refused by every door that writes one;
//   2. one intent has one spelling in state (a prefix length is rewritten to a dotted mask);
//   3. a request that is rejected changes nothing;
//   4. a document that is loaded is either restored or explained - never adopted into a state no door would accept,
//      and never dropped in silence.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const netSock = require('net');
const { spawn } = require('child_process');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const ROOT = path.join(__dirname, '..');
const cat = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
const ROUTER = cat.find(function (s) { return s.model === 'ISR 4331'; });

function freePort() {
  return new Promise(function (resolve, reject) {
    const p = netSock.createServer();
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
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method: method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} },
    function (res) {
      let data = '';
      res.on('data', function (c) { data += c; });
      res.on('end', function () {
        let parsed = data;
        try { parsed = JSON.parse(data); } catch (e) { /* keep the text */ }
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

// One board with one router, and the port on it we will edit.
async function board(name) {
  const created = await request('POST', '/api/topologies', { name: name });
  const id = created.body.id || created.body.name;
  const base = '/api/topologies/' + encodeURIComponent(id);
  const added = await request('POST', base + '/devices', { vendor: ROUTER.vendor, model: ROUTER.model, name: 'r1' });
  const dev = added.body.device;
  const iface = dev.interfaces.filter(function (i) { return i.type === 'ethernet'; })[0];
  return { base: base, devId: dev.id, port: iface.name, url: base + '/interfaces/' + dev.id + '/' + encodeURIComponent(iface.name) };
}
async function portOf(b, portName) {
  const got = await request('GET', b.base);
  const state = got.body.state || got.body;
  const d = (state.devices || []).filter(function (x) { return x.id === b.devId; })[0];
  return d.interfaces.filter(function (i) { return i.name === (portName || b.port); })[0];
}
async function consoleLines(b, cmds) {
  const r = await request('POST', b.base + '/config/' + b.devId, { commands: ['enable'].concat(cmds) });
  return (r.body && r.body.lines) || [];
}

(async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-apidoor-'));
  PORT = await freePort();
  const srv = await startServer(dataDir);
  try {
    console.log('A mask the console would refuse is refused here too');
    {
      const b = await board('mask-door');
      const before = await portOf(b);
      const r = await request('POST', b.url, { ip: '10.5.5.1', mask: '255.0.255.0' });
      ok(r.status === 400, 'a non-contiguous mask is a 400', r.status + ' ' + r.text.slice(0, 80));
      ok(r.body && r.body.code === 'E_BAD_MASK', 'with a code the client can act on', r.body && r.body.code);
      ok(/not a netmask/.test((r.body && r.body.error) || ''), 'and a sentence saying what a netmask is',
        (r.body && r.body.error) || '');
      const after = await portOf(b);
      ok(after.ip === before.ip && after.mask === before.mask, 'and the port is untouched',
        JSON.stringify({ ip: after.ip, mask: after.mask }));

      const bad = await request('POST', b.url, { ip: '300.1.1.1', mask: '255.255.255.0' });
      ok(bad.status === 400 && bad.body.code === 'E_BAD_ADDRESS',
        'an address that cannot exist is a 400 with a code', bad.status + ' ' + bad.text.slice(0, 80));
      const stillNothing = await portOf(b);
      ok(!stillNothing.ip, 'and still nothing was set', JSON.stringify(stillNothing.ip));
    }

    console.log('');
    console.log('One intent, one spelling: a prefix length is stored as a dotted mask');
    {
      const b = await board('mask-spelling');
      const r = await request('POST', b.url, { ip: '10.5.5.1', mask: '24' });
      ok(r.status === 200, 'the prefix form is accepted', String(r.status));
      const port = await portOf(b);
      ok(port.mask === '255.255.255.0', 'and stored as the mask every other surface reads', JSON.stringify(port.mask));
      const rc = await consoleLines(b, ['show running-config']);
      ok(rc.some(function (l) { return /^\s*ip address 10\.5\.5\.1 255\.255\.255\.0$/.test(l); }),
        'so the config prints the dotted form, not "24"', rc.filter(function (l) { return /ip address/.test(l); }).join(' | '));
      const si = await consoleLines(b, ['show interfaces ' + b.port]);
      ok(si.some(function (l) { return /ip: 10\.5\.5\.1\/24/.test(l); }), 'and the port reads /24',
        si.filter(function (l) { return /ip:/.test(l); }).join(' | '));
    }

    console.log('');
    console.log('What this door writes, the console can type back');
    {
      // The property that was broken: a board built through the API produced a running-config line the console
      // refuses. Every accepted mask form is replayed through the console here.
      const replays = [];
      for (const mask of ['255.255.255.0', '24', '255.255.255.128', '25', '0', '255.255.255.254', '30']) {
        const b = await board('replay-' + mask.replace(/\./g, '_'));
        const r = await request('POST', b.url, { ip: '10.5.5.1', mask: mask });
        if (r.status !== 200) { replays.push(mask + ' was refused: ' + r.text.slice(0, 60)); continue; }
        const rc = await consoleLines(b, ['show running-config']);
        const line = rc.filter(function (l) { return /^\s*ip address /.test(l); })[0];
        if (!line) { replays.push(mask + ': no ip address line in the config'); continue; }
        // Type that exact line on the same port and see whether the console refuses it. One config session: the
        // session persists between calls, so a second `configure terminal` would itself be the refusal.
        const typed = await consoleLines(b, ['configure terminal', 'interface ' + b.port, 'no ip address',
          line.trim()]);
        const refused = typed.filter(function (l) { return /^%/.test(String(l)); });
        if (refused.length) replays.push(mask + ' -> "' + line.trim() + '" is refused by the console: ' + refused[0]);
      }
      ok(replays.length === 0, 'every mask this door accepts is a line the console accepts', replays.join(' ;; '));
    }

    console.log('');
    console.log('A loaded document is restored or explained');
    {
      const b = await board('load-door');
      const good = await portOf(b);
      const doc = {
        format: 'packetforge-topology',
        devices: [{
          id: 'd1', vendor: ROUTER.vendor, model: ROUTER.model, label: 'r1', category: ROUTER.category,
          capabilities: ROUTER.capabilities,
          interfaces: [
            { name: 'Gi0', type: 'ethernet', ip: '10.5.5.1', mask: '255.0.255.0' },
            { name: 'Gi1', type: 'ethernet', ip: '10.5.6.1', mask: '24' },
            { name: 'Gi2', type: 'ethernet', ip: '300.1.1.1', mask: '255.255.255.0' },
            { name: 'Gi3', type: 'ethernet', ip: '10.5.7.1', mask: '255.255.255.0' }
          ]
        }],
        links: []
      };
      const loaded = await request('POST', b.base + '/load', doc);
      ok(loaded.status === 200 && loaded.body.ok !== false, 'the document loads rather than being refused wholesale',
        loaded.status + ' ' + loaded.text.slice(0, 80));
      if (!loaded.body || !loaded.body.state) {
        ok(false, 'the load answered with a board', loaded.text.slice(0, 120));
        console.log('');
        console.log(passed + ' passed, ' + failed + ' failed');
        process.exit(1);
      }
      const issues = (loaded.body.state && loaded.body.state.loadIssues) || [];
      const codes = issues.map(function (i) { return i.code; });
      ok(codes.indexOf('E_IFACE_BAD_MASK') !== -1, 'the impossible mask is reported', JSON.stringify(codes));
      ok(codes.indexOf('E_IFACE_BAD_ADDRESS') !== -1, 'and so is the impossible address', JSON.stringify(codes));
      const why = issues.filter(function (i) { return i.code === 'E_IFACE_BAD_MASK'; })[0];
      ok(why && /Gi0/.test(why.message) && /255\.0\.255\.0/.test(why.message),
        'naming the port and the value', why && why.message);

      const state = loaded.body.state;
      const dev = (state.devices || []).filter(function (x) { return x.id === 'd1'; })[0];
      const p = function (name) { return dev.interfaces.filter(function (i) { return i.name === name; })[0]; };
      ok(!p('Gi0').ip && !p('Gi0').mask, 'the port with the impossible mask carries no address', JSON.stringify(p('Gi0')));
      ok(!p('Gi2').ip, 'and neither does the one with the impossible address');
      ok(p('Gi1').ip === '10.5.6.1' && p('Gi1').mask === '255.255.255.0',
        'the old spelling is rewritten, not thrown away', JSON.stringify(p('Gi1')));
      ok(p('Gi3').ip === '10.5.7.1' && p('Gi3').mask === '255.255.255.0',
        'and a good address is untouched', JSON.stringify(p('Gi3')));
      // Nothing that survived can be read as a mask the console would refuse.
      const badMasks = (dev.interfaces || []).filter(function (i) {
        return i.mask && !require('../engine/net').isContiguousMask(i.mask);
      });
      ok(badMasks.length === 0, 'no port in the loaded board holds an impossible mask',
        JSON.stringify(badMasks.map(function (i) { return i.name + '=' + i.mask; })));
      ok(good && good.ip === null, 'and the board was the one we were editing', JSON.stringify(good && good.ip));
    }

    console.log('');
    console.log('A saved board comes back as itself');
    {
      const b = await board('roundtrip-door');
      await request('POST', b.url, { ip: '10.5.5.1', mask: '25' });
      const saved = await request('GET', b.base);
      const state = saved.body.state || saved.body;
      const reloaded = await request('POST', b.base + '/load', JSON.parse(JSON.stringify(state)));
      ok(reloaded.status === 200, 'the document reloads', String(reloaded.status));
      const dev = (reloaded.body.state.devices || []).filter(function (x) { return x.id === b.devId; })[0];
      const port = dev.interfaces.filter(function (i) { return i.name === b.port; })[0];
      ok(port.ip === '10.5.5.1' && port.mask === '255.255.255.128',
        'and the address is still /25', JSON.stringify({ ip: port.ip, mask: port.mask }));
      ok(((reloaded.body.state.loadIssues) || []).length === 0, 'with nothing to explain',
        JSON.stringify(reloaded.body.state.loadIssues));
    }
  } finally {
    await stop(srv.child);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* temp dir */ }
  }

  console.log('');
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(function (e) {
  console.error('suite failed: ' + (e && e.stack || e));
  process.exit(1);
});
