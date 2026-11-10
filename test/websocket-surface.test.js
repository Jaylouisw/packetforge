'use strict';
// What the WebSocket surface does with a client that misbehaves (#1313).
//
// `server/ws.js` is a hand-written RFC 6455 server, about a hundred lines, and until now the only thing any test
// asserted about it was that a broadcast carries `verdicts` (#1306). Nobody had ever sent it a frame it did not
// expect. Four things came out:
//
//   * `clients` only ever grew. `onClose` was never wired, so a closed browser tab stayed in the set: `broadcast()`
//     wrote to dead sockets for the life of the process and `count` never came down;
//   * an unmasked client frame was accepted. RFC 6455 5.1 makes that a protocol error; accepting it let any plain
//     TCP writer speak the protocol;
//   * there was no frame-size ceiling, so `Buffer.concat()` grew to whatever length a client declared - a single
//     connection could ask the server to hold as much memory as it liked;
//   * a `subscribe` naming a topology that does not exist was a silent no-op, indistinguishable from an empty board.
//
// The rules asserted here:
//
//   1. a client that has gone is gone (count comes down, and a broadcast reaches only the living);
//   2. a frame that is not allowed is refused with the close code that says which rule it broke;
//   3. every message gets an answer, including a message that is wrong;
//   4. none of the above takes the server down.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { WebSocketServer } = require('../server/ws');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const ROOT = path.join(__dirname, '..');
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

// A client, because a test of a hand-written protocol server should not need a library to speak it.
function frameFrom(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  let len = buf[1] & 0x7f, off = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = buf.readUInt32BE(6); off = 10; }
  if (buf.length < off + len) return null;
  return { opcode: opcode, payload: buf.slice(off, off + len), consumed: off + len };
}
function encode(obj, opts) {
  const payload = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj));
  const mask = !(opts && opts.unmasked);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, (mask ? 0x80 : 0) | payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4); header[0] = 0x81; header[1] = (mask ? 0x80 : 0) | 126; header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10); header[0] = 0x81; header[1] = (mask ? 0x80 : 0) | 127;
    header.writeUInt32BE(0, 2); header.writeUInt32BE(payload.length, 6);
  }
  if (!mask) return Buffer.concat([header, payload]);
  const key = crypto.randomBytes(4);
  const out = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ key[i % 4];
  return Buffer.concat([header, key, out]);
}
// A frame that declares a 64-bit length whose high word is not zero.
function absurdLengthFrame() {
  const header = Buffer.alloc(10);
  header[0] = 0x81; header[1] = 0x80 | 127;
  header.writeUInt32BE(1, 2);   // high word: 4 GiB and change
  header.writeUInt32BE(0, 6);
  return Buffer.concat([header, crypto.randomBytes(4)]);
}
function connect(port) {
  return new Promise(function (resolve, reject) {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(port, '127.0.0.1', function () {
      sock.write(['GET / HTTP/1.1', 'Host: localhost', 'Upgrade: websocket', 'Connection: Upgrade',
        'Sec-WebSocket-Key: ' + key, 'Sec-WebSocket-Version: 13', '', ''].join('\r\n'));
    });
    let buf = Buffer.alloc(0);
    const st = { frames: [], closeCode: null, closed: false, sock: sock, pongs: 0 };
    let handshook = false;
    sock.on('data', function (chunk) {
      buf = Buffer.concat([buf, chunk]);
      if (!handshook) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        st.handshake = buf.slice(0, i).toString('utf8');
        buf = buf.slice(i + 4);
        handshook = true;
        resolve(st);
      }
      for (;;) {
        const f = frameFrom(buf);
        if (!f) break;
        buf = buf.slice(f.consumed);
        if (f.opcode === 0x1) st.frames.push(f.payload.toString('utf8'));
        else if (f.opcode === 0xA) st.pongs++;
        else if (f.opcode === 0x8) { st.closed = true; st.closeCode = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : null; }
      }
    });
    sock.on('close', function () { st.closed = true; });
    sock.on('error', function () {});
    setTimeout(function () { reject(new Error('handshake timeout')); }, 5000);
  });
}
function parsed(st) {
  return st.frames.map(function (f) { try { return JSON.parse(f); } catch (e) { return null; } });
}
function freePort() {
  return new Promise(function (resolve, reject) {
    const p = net.createServer();
    p.unref(); p.on('error', reject);
    p.listen(0, '127.0.0.1', function () { const port = p.address().port; p.close(function () { resolve(port); }); });
  });
}

(async function main() {
  // ---------------------------------------------------------------- the unit: who is in `clients`
  console.log('');
  console.log('A client that goes away leaves:');
  {
    const wss = new WebSocketServer();
    // An http.Server, because 'upgrade' is an HTTP event: a bare net server hands over the socket and never
    // parses a request, so nothing would ever be upgraded.
    const srv = http.createServer(function (req, res) { res.writeHead(404); res.end(); });
    await new Promise(function (r) { srv.listen(0, '127.0.0.1', r); });
    const port = srv.address().port;
    srv.on('upgrade', function (req, socket) { wss.handleUpgrade(req, socket); });

    const a = await connect(port);
    const b = await connect(port);
    await sleep(150);
    ok(wss.count === 2, 'two clients are counted', String(wss.count));

    // One leaves the way a browser tab does when it is closed - the socket just goes.
    b.sock.destroy();
    await sleep(300);
    ok(wss.count === 1, 'one client leaves and the count comes down', String(wss.count));

    // A broadcast reaches the one that is left, and does not throw on the one that is gone.
    let threw = null;
    try { wss.broadcast({ type: 'topology', topologyId: 'default', state: {} }); } catch (e) { threw = e.message; }
    await sleep(150);
    ok(threw === null, 'a broadcast after a client leaves does not throw', threw);
    ok(parsed(a).some(function (m) { return m && m.type === 'topology'; }), 'and reaches the client that is still there');

    // A close frame is answered, and the client goes as well.
    a.sock.write(Buffer.concat([Buffer.from([0x88, 0x82]), crypto.randomBytes(4), Buffer.from([0, 0])]));
    await sleep(300);
    ok(wss.count === 0, 'after a close frame the set is empty', String(wss.count));
    if (srv.closeAllConnections) srv.closeAllConnections();
    // A lingering half-open socket must not hold the whole file hostage - which is exactly what the old code did.
    await Promise.race([new Promise(function (r) { srv.close(r); }), sleep(3000)]);
    if (srv.closeAllConnections) srv.closeAllConnections();
  }

  // ---------------------------------------------------------------- the server, over real sockets
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-ws-'));
  const PORT = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), PF_DATA: dataDir }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', function (d) { log += d; });
  child.stderr.on('data', function (d) { log += d; });
  const alive = function () { return child.exitCode === null; };
  const httpGet = function (p) {
    return new Promise(function (resolve) {
      http.get({ host: '127.0.0.1', port: PORT, path: p }, function (res) {
        let d = ''; res.on('data', function (c) { d += c; }); res.on('end', function () { resolve({ status: res.statusCode, text: d }); });
      }).on('error', function (e) { resolve({ status: 0, text: e.message }); });
    });
  };
  try {
    const deadline = Date.now() + 20000;
    for (;;) {
      const r = await httpGet('/api/version');
      if (r.status === 200) break;
      if (child.exitCode !== null) throw new Error('server exited: ' + log);
      if (Date.now() > deadline) throw new Error('no answer: ' + log);
      await sleep(100);
    }

    console.log('');
    console.log('A new tab is given the board:');
    {
      const c = await connect(PORT);
      await sleep(200);
      const first = parsed(c)[0];
      ok(first && first.type === 'topology' && first.topologyId === 'default',
        'the connect frame is the default board', JSON.stringify(first && first.type));
      ok(first && first.state && first.state.verdicts && first.state.verdicts.checked === true &&
        typeof first.state.verdicts.errorCount === 'number',
        'with its cable verdicts', JSON.stringify(first && first.state && first.state.verdicts));
      c.sock.destroy();
    }

    console.log('');
    console.log('Every message gets an answer:');
    {
      const c = await connect(PORT);
      await sleep(150);
      c.sock.write(encode({ type: 'subscribe', topologyId: 'default' }));
      c.sock.write(encode({ type: 'subscribe', topologyId: 'nope' }));
      c.sock.write(encode({ type: 'nonsense' }));
      c.sock.write(encode('not json at all'));
      c.sock.write(encode({ topologyId: 'default' }));
      await sleep(400);
      const msgs = parsed(c).filter(Boolean);
      ok(msgs[1] && msgs[1].type === 'topology' && msgs[1].topologyId === 'default',
        'subscribing to a real board answers with that board');
      const noTopo = msgs.filter(function (m) { return m.type === 'error' && m.code === 'E_NO_TOPOLOGY'; })[0];
      ok(!!noTopo, 'an unknown board answers with an error, not silence', JSON.stringify(msgs.slice(1).map(function (m) { return m.code || m.type; })));
      ok(noTopo && noTopo.topologyId === 'nope' && /nope/.test(noTopo.error), 'naming the board that was asked for',
        noTopo && noTopo.error);
      const badType = msgs.filter(function (m) { return m.type === 'error' && m.code === 'E_UNKNOWN_TYPE'; })[0];
      ok(!!badType && /subscribe/.test(badType.error), 'an unknown type answers with the type that does exist',
        badType && badType.error);
      const badMsg = msgs.filter(function (m) { return m.type === 'error' && m.code === 'E_BAD_MESSAGE'; });
      ok(badMsg.length === 2, 'and two malformed messages answer twice', String(badMsg.length));
      ok(!c.closed, 'none of which closes the connection');
      c.sock.write(encode({ type: 'subscribe', topologyId: 'default' }));
      await sleep(250);
      // connect frame + the first subscribe + this one: the connection was never poisoned by the three bad messages.
      const boards = parsed(c).filter(function (m) { return m && m.type === 'topology'; }).length;
      ok(boards === 3, 'and it is still usable afterwards', String(boards));
      c.sock.destroy();
    }

    console.log('');
    console.log('A frame that is not allowed is refused, with a code:');
    {
      const unmasked = await connect(PORT);
      await sleep(150);
      unmasked.sock.write(encode({ type: 'subscribe', topologyId: 'default' }, { unmasked: true }));
      await sleep(350);
      ok(unmasked.closed && unmasked.closeCode === 1002, 'an unmasked frame closes with 1002',
        unmasked.closed + ' ' + unmasked.closeCode);

      const big = await connect(PORT);
      await sleep(150);
      big.sock.write(encode('x'.repeat(1024 * 1024 + 64)));
      await sleep(500);
      ok(big.closed && big.closeCode === 1009, 'a frame over the ceiling closes with 1009',
        big.closed + ' ' + big.closeCode);

      const absurd = await connect(PORT);
      await sleep(150);
      absurd.sock.write(absurdLengthFrame());
      await sleep(350);
      ok(absurd.closed && absurd.closeCode === 1002, 'a 64-bit length with a non-zero high word closes with 1002',
        absurd.closed + ' ' + absurd.closeCode);

      ok(alive(), 'and the server is still running after all three');
      ok((await httpGet('/api/version')).status === 200, 'still answering HTTP');

      // A close frame is answered rather than ignored.
      const polite = await connect(PORT);
      await sleep(150);
      polite.sock.write(Buffer.concat([Buffer.from([0x88, 0x82]), crypto.randomBytes(4), Buffer.from([0, 0])]));
      await sleep(300);
      ok(polite.closed, 'a close frame is honoured');
    }

    console.log('');
    console.log('Ping is still answered:');
    {
      const c = await connect(PORT);
      await sleep(150);
      const payload = Buffer.from('hb');
      const key = crypto.randomBytes(4);
      const masked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ key[i % 4];
      c.sock.write(Buffer.concat([Buffer.from([0x89, 0x80 | payload.length]), key, masked]));
      await sleep(250);
      ok(c.pongs >= 1, 'a ping gets a pong', String(c.pongs));
      c.sock.destroy();
    }
  } finally {
    try { child.kill('SIGTERM'); } catch (e) {}
    await sleep(300);
    try { child.kill('SIGKILL'); } catch (e) {}
  }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
