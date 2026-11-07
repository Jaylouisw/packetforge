'use strict';
// ws.js — minimal, dependency-free WebSocket server (RFC 6455, text frames).
const crypto = require('crypto');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

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
    socket.on('data', function (chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const frame = parseFrame(buffer);
        if (!frame) break;
        buffer = buffer.slice(frame.consumed);
        if (frame.opcode === 0x8) { // close
          safeEnd(socket);
          break;
        } else if (frame.opcode === 0x9) { // ping -> pong
          sendFrame(client, frame.payload, 0xA);
        } else if (frame.opcode === 0x1) { // text
          if (client.onMessage) client.onMessage(frame.payload.toString('utf8'));
        }
      }
    });
    socket.on('error', function () {});
    socket.on('close', function () {
      if (client.onClose) client.onClose();
    });
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

function parseFrame(buffer) {
  if (buffer.length < 2) return null;
  const b0 = buffer[0], b1 = buffer[1];
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buffer.length < 4) return null;
    len = buffer.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buffer.length < 10) return null;
    len = buffer.readUInt32BE(6);
    offset = 10;
  }
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

module.exports = { WebSocketServer };
