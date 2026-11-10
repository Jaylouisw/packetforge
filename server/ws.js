'use strict';
// ws.js — minimal, dependency-free WebSocket server (RFC 6455, text frames).
const crypto = require('crypto');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// One inbound frame may not be larger than this. Without a ceiling, `parseFrame()` waits for the length the client
// declared and `Buffer.concat()` grows until it arrives, so a single client can ask the server to hold as much
// memory as it likes (#1313). A message from this app is a JSON object naming a board; 1 MiB is generous.
const MAX_FRAME = 1024 * 1024;
const CLOSE_PROTOCOL = 0x03EA;  // 1002
const CLOSE_TOO_BIG = 0x03F1;   // 1009
const CLOSE_BAD_DATA = 0x03EF;  // 1007

class WebSocketServer {
  constructor() {
    this.clients = new Set();
  }

  // Handle an HTTP upgrade request on a raw socket. Returns the client handle.
  handleUpgrade(req, socket) {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return null; }

    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    const head = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: ' + accept,
      '', ''
    ].join('\r\n');
    socket.write(head);

    const client = { socket: socket, onMessage: null, onClose: null };
    this.clients.add(client);

    let buffer = Buffer.alloc(0);
    let done = false;
    let forgotten = false;
    const self = this;
    // An upgraded socket has allowHalfOpen = true. When the peer goes away it emits 'end' and **stops there** -
    // 'close' never fires, so removing the client only on 'close' would leave a half-open socket holding the entry
    // for the life of the process. `end` is the moment the client is gone (#1313).
    function forget() {
      if (forgotten) return;
      forgotten = true;
      self.clients.delete(client);
      if (client.onClose) client.onClose();
    }
    function finish(code) {
      if (done) return;
      done = true;
      // 1002 / 1009 say *why*. A bare FIN leaves the client guessing whether it said something wrong or the
      // server died.
      if (code) safeSendClose(client, code);
      forget();
      safeEnd(socket);
      // If the peer never finishes the handshake, release the descriptor anyway. Unref'd: it must not keep a
      // shutting-down process alive.
      setTimeout(function () { try { socket.destroy(); } catch (e) { /* already gone */ } }, 2000).unref();
    }
    socket.on('data', function (chunk) {
      // A client that has already been closed for a protocol error keeps its bytes out of the buffer.
      if (done) return;
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const frame = parseFrame(buffer);
        if (frame === PARSE_TOO_BIG) { finish(CLOSE_TOO_BIG); return; }
        if (frame === PARSE_UNMASKED) { finish(CLOSE_PROTOCOL); return; }
        if (frame === PARSE_BAD_LENGTH) { finish(CLOSE_PROTOCOL); return; }
        if (!frame) break;
        buffer = buffer.slice(frame.consumed);
        if (frame.opcode === 0x8) { // close
          finish(null);
          break;
        } else if (frame.opcode === 0x9) { // ping -> pong
          sendFrame(client, frame.payload, 0xA);
        } else if (frame.opcode === 0x1) { // text
          // A handler that throws must not take the process with it: onMessage ran inside a socket 'data'
          // listener, where a throw is an uncaught exception and every other client goes down with it.
          if (client.onMessage) {
            try { client.onMessage(frame.payload.toString('utf8')); } catch (e) { /* the client's problem */ }
          }
        }
      }
    });
    socket.on('error', forget);
    socket.on('end', function () { safeEnd(socket); forget(); });
    socket.on('close', forget);
    return client;
  }

  broadcast(obj) {
    const data = JSON.stringify(obj);
    for (const c of this.clients) sendFrame(c, data, 0x1);
  }

  send(client, obj) {
    sendFrame(client, JSON.stringify(obj), 0x1);
  }

  get count() { return this.clients.size; }
}

// Sentinel results, so a caller can tell "not enough bytes yet" (null) from "this frame is not allowed".
const PARSE_TOO_BIG = { tooBig: true };
const PARSE_UNMASKED = { unmasked: true };
const PARSE_BAD_LENGTH = { badLength: true };

function parseFrame(buffer) {
  if (buffer.length < 2) return null;
  const b0 = buffer[0], b1 = buffer[1];
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  // RFC 6455 5.1: a client frame that is not masked is a protocol error. Accepting one let any plain TCP writer
  // speak this protocol, and a browser never sends one, so refusing it costs nothing.
  if (!masked) return PARSE_UNMASKED;
  let len = b1 & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buffer.length < 4) return null;
    len = buffer.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buffer.length < 10) return null;
    // The 64-bit length: reading only the low word silently reinterpreted anything over 4 GiB as a small frame,
    // and then the parser waited for bytes that were never coming.
    if (buffer.readUInt32BE(2) !== 0) return PARSE_BAD_LENGTH;
    len = buffer.readUInt32BE(6);
    offset = 10;
  }
  if (len > MAX_FRAME) return PARSE_TOO_BIG;
  let maskKey = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    maskKey = buffer.slice(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + len) return null;
  let payload = buffer.slice(offset, offset + len);
  if (masked && maskKey) {
    const out = Buffer.alloc(len);
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i % 4];
    payload = out;
  }
  return { opcode: opcode, payload: payload, consumed: offset + len };
}

function sendFrame(client, payload, opcode) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (data.length < 126) {
    header = Buffer.from([0x80 | opcode, data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(data.length, 6);
  }
  try { client.socket.write(Buffer.concat([header, data])); } catch (e) { /* ignore */ }
}

function safeEnd(socket) { try { socket.end(); } catch (e) { /* ignore */ } }

// A close frame carries a two-byte status code and an optional reason.
function safeSendClose(client, code, reason) {
  const text = Buffer.from(reason || '', 'utf8');
  const payload = Buffer.alloc(2 + text.length);
  payload.writeUInt16BE(code, 0);
  text.copy(payload, 2);
  sendFrame(client, payload, 0x8);
}

module.exports = { WebSocketServer };
