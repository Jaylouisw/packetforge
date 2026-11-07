'use strict';
// index.js — PacketForge server: static frontend + JSON API + WebSocket sync.
// Zero runtime dependencies. Run:  node server/index.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const { Topology, Simulator, CliSession } = require('../engine');
const { loadCatalog, groupByCategory } = require('../devices/registry');
const media = require('../engine/media');
const { WebSocketServer } = require('./ws');

const PORT = parseInt(process.env.PORT || '8000', 10);
const WEB_DIR = path.join(__dirname, '..', 'web');
const DEVICES_DIR = path.join(__dirname, '..', 'devices');

// --- state ---
const topologies = new Map();
const sessions = new Map(); // `${topoId}:${devId}` -> CliSession
const catalog = loadCatalog(DEVICES_DIR);
const wss = new WebSocketServer();

function ensureTopology(id) {
  let t = topologies.get(id);
  if (!t) { t = new Topology(); topologies.set(id, t); }
  return t;
}
ensureTopology('default');

function sessionKey(topoId, devId) { return topoId + ':' + devId; }

function mapToObject(m) {
  const o = {};
  for (const [k, v] of m) o[k] = v;
  return o;
}

function fullState(topo) {
  const s = topo.serialize();
  const runtime = {};
  for (const d of topo.devices.values()) {
    runtime[d.id] = {
      macTable: mapToObject(d.macTable),
      arp: mapToObject(d.arp),
      routes: d.routesTable()
    };
  }
  s.runtime = runtime;
  return s;
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    let data = '';
    req.on('data', function (c) {
      data += c;
      if (data.length > 5 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', function () {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function broadcast(topoId) {
  const t = topologies.get(topoId);
  if (!t) return;
  wss.broadcast({ type: 'topology', topologyId: topoId, state: fullState(t) });
}

// --- static file server ---
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function serveStatic(res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.normalize(path.join(WEB_DIR, rel));
  if (filePath.indexOf(WEB_DIR) !== 0) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, function (err, data) {
    if (err) {
      // SPA fallback: unknown paths serve index.html
      fs.readFile(path.join(WEB_DIR, 'index.html'), function (e2, html) {
        if (e2) { res.writeHead(404); res.end('Not found'); }
        else { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); }
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

// --- API ---
async function handleApi(req, res, urlPath) {
  const method = req.method.toUpperCase();
  const parts = urlPath.split('/').filter(Boolean); // e.g. ['api','topologies','default','devices']

  try {
    // GET /api/catalog
    if (parts[1] === 'catalog' && method === 'GET') {
      return sendJSON(res, 200, { specs: catalog, categories: groupByCategory(catalog) });
    }

    // GET /api/media -- physical media + cage catalogue (link-type picker)
    if (parts[1] === 'media' && method === 'GET') {
      return sendJSON(res, 200, { media: media.MEDIA, cages: media.CAGES });
    }

    // topologies collection
    if (parts[1] === 'topologies' && parts.length === 2) {
      if (method === 'GET') return sendJSON(res, 200, { ids: Array.from(topologies.keys()) });
      if (method === 'POST') {
        const body = await readBody(req);
        const id = body.id || ('topo-' + Date.now().toString(36));
        if (!topologies.has(id)) topologies.set(id, new Topology());
        return sendJSON(res, 201, { id: id, state: fullState(topologies.get(id)) });
      }
    }

    if (parts[1] !== 'topologies' || parts.length < 3) {
      return sendJSON(res, 404, { error: 'unknown endpoint' });
    }
    const topoId = parts[2];
    const topo = topologies.get(topoId);

    // GET / DELETE topology
    if (parts.length === 3) {
      if (method === 'GET') {
        if (!topo) return sendJSON(res, 404, { error: 'topology not found' });
        return sendJSON(res, 200, fullState(topo));
      }
      if (method === 'DELETE') {
        topologies.delete(topoId);
        return sendJSON(res, 200, { ok: true });
      }
    }

    if (!topo) return sendJSON(res, 404, { error: 'topology not found' });

    // /devices
    if (parts[3] === 'devices' && parts.length === 4) {
      if (method === 'POST') {
        const body = await readBody(req);
        const spec = catalog.find(function (s) { return s.vendor === body.vendor && s.model === body.model; });
        if (!spec) return sendJSON(res, 404, { error: 'unknown device model: ' + body.vendor + '/' + body.model });
        const dev = topo.addDevice(spec, body.id || null);
        topo.layout[dev.id] = { x: body.x || 160, y: body.y || 160 };
        broadcast(topoId);
        return sendJSON(res, 201, { device: dev.serialize(), state: fullState(topo) });
      }
    }

    // /devices/:devId
    if (parts[3] === 'devices' && parts.length === 5) {
      const devId = parts[4];
      if (method === 'DELETE') {
        topo.removeDevice(devId);
        delete topo.layout[devId];
        for (const key of Array.from(sessions.keys())) if (key.indexOf(topoId + ':') === 0) sessions.delete(key);
        broadcast(topoId);
        return sendJSON(res, 200, { ok: true, state: fullState(topo) });
      }
    }

    // /links
    if (parts[3] === 'links' && parts.length === 4) {
      if (method === 'POST') {
        const body = await readBody(req);
        try {
          const link = topo.connect(body.a.deviceId, body.a.iface, body.b.deviceId, body.b.iface, {
            mediaId: body.mediaId,
            lengthM: body.lengthM,
            duplex: body.duplex,
            lagId: body.lagId,
            force: !!body.force,
            type: body.type
          });
          broadcast(topoId);
          return sendJSON(res, 201, { link: link.serialize(), state: fullState(topo) });
        } catch (e) {
          // An impossible cable is a client error, not a server fault.
          return sendJSON(res, 409, {
            error: e.message,
            code: e.code || 'E_LINK',
            issues: e.issues || []
          });
        }
      }
    }

    // /validate-link -- dry-run a prospective cable before committing it
    if (parts[3] === 'validate-link' && parts.length === 4 && method === 'POST') {
      const body = await readBody(req);
      const verdict = topo.validateLink(body.a.deviceId, body.a.iface, body.b.deviceId, body.b.iface, {
        mediaId: body.mediaId,
        lengthM: body.lengthM
      });
      const options = topo.mediaOptions(body.a.deviceId, body.a.iface, body.b.deviceId, body.b.iface);
      return sendJSON(res, 200, { verdict: verdict, mediaOptions: options });
    }

    // /links/:linkId
    if (parts[3] === 'links' && parts.length === 5) {
      if (method === 'DELETE') {
        topo.disconnect(parts[4]);
        broadcast(topoId);
        return sendJSON(res, 200, { ok: true, state: fullState(topo) });
      }
    }

    // /config/:devId
    if (parts[3] === 'config' && parts.length === 5 && method === 'POST') {
      const devId = parts[4];
      const dev = topo.getDevice(devId);
      if (!dev) return sendJSON(res, 404, { error: 'device not found' });
      const body = await readBody(req);
      const commands = Array.isArray(body.commands) ? body.commands : [body.command];
      const key = sessionKey(topoId, devId);
      let session = sessions.get(key);
      if (!session) { session = new CliSession(dev, topo, new Simulator(topo)); sessions.set(key, session); }
      const lines = [];
      for (const cmd of commands) {
        lines.push(session.prompt() + cmd);
        const r = session.run(cmd);
        for (const l of r.output) lines.push(l);
      }
      broadcast(topoId);
      return sendJSON(res, 200, { output: lines.join('\n'), lines: lines, prompt: session.prompt(), device: dev.serialize() });
    }

    // /interfaces/:devId/:iface  (direct property edit — nice UI shortcut)
    if (parts[3] === 'interfaces' && parts.length === 6 && method === 'POST') {
      const devId = parts[4], ifaceName = parts[5];
      const dev = topo.getDevice(devId);
      if (!dev) return sendJSON(res, 404, { error: 'device not found' });
      const iface = dev.interfaces.get(ifaceName);
      if (!iface) return sendJSON(res, 404, { error: 'interface not found' });
      const body = await readBody(req);
      if (body.ip !== undefined) {
        if (body.ip === null || body.ip === '') { iface.ip = null; iface.mask = null; }
        else {
          require('../engine/net').ipToInt(body.ip);
          if (!body.mask) return sendJSON(res, 400, { error: 'mask required with ip' });
          require('../engine/net').maskToInt(body.mask);
          iface.ip = body.ip; iface.mask = body.mask;
        }
      }
      if (body.enabled !== undefined) iface.enabled = !!body.enabled;
      if (body.description !== undefined) iface.description = body.description || '';
      broadcast(topoId);
      return sendJSON(res, 200, { device: dev.serialize(), state: fullState(topo) });
    }

    // /ping
    if (parts[3] === 'ping' && parts.length === 4 && method === 'POST') {
      const body = await readBody(req);
      const dev = topo.getDevice(body.src);
      if (!dev) return sendJSON(res, 404, { error: 'source device not found' });
      const sim = new Simulator(topo);
      const result = sim.ping(body.src, body.dst, { count: body.count || 4 });
      return sendJSON(res, 200, { events: result.events, replies: result.replies, success: result.success, step: result.step, runtime: fullState(topo).runtime });
    }

    // /layout
    if (parts[3] === 'layout' && parts.length === 4 && method === 'POST') {
      const body = await readBody(req);
      if (body.positions && typeof body.positions === 'object') {
        for (const id of Object.keys(body.positions)) {
          if (topo.devices.has(id)) topo.layout[id] = body.positions[id];
        }
      }
      broadcast(topoId);
      return sendJSON(res, 200, { ok: true });
    }

    // /load  (import a full topology document)
    if (parts[3] === 'load' && parts.length === 4 && method === 'POST') {
      const body = await readBody(req);
      const newTopo = Topology.fromJSON(body);
      topologies.set(topoId, newTopo);
      for (const key of Array.from(sessions.keys())) if (key.indexOf(topoId + ':') === 0) sessions.delete(key);
      broadcast(topoId);
      return sendJSON(res, 200, { ok: true, state: fullState(newTopo) });
    }

    // /reset  (clear runtime forwarding state)
    if (parts[3] === 'reset' && parts.length === 4 && method === 'POST') {
      for (const d of topo.devices.values()) { d.macTable.clear(); d.arp.clear(); d.pending.clear(); }
      broadcast(topoId);
      return sendJSON(res, 200, { ok: true });
    }

    return sendJSON(res, 404, { error: 'unknown endpoint: ' + urlPath });
  } catch (e) {
    return sendJSON(res, 400, { error: e.message });
  }
}

// --- HTTP server ---
const server = http.createServer(function (req, res) {
  let urlPath;
  try { urlPath = new URL(req.url, 'http://localhost').pathname; }
  catch (e) { res.writeHead(400); res.end('Bad request'); return; }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  if (urlPath.indexOf('/api/') === 0) { handleApi(req, res, urlPath); return; }
  serveStatic(res, urlPath);
});

server.on('upgrade', function (req, socket) {
  try {
    const client = wss.handleUpgrade(req, socket);
    if (client) {
      client.onMessage = function (msg) {
        try {
          const m = JSON.parse(msg);
          if (m && m.type === 'subscribe' && topologies.has(m.topologyId)) {
            wss.send(client, { type: 'topology', topologyId: m.topologyId, state: fullState(topologies.get(m.topologyId)) });
          }
        } catch (e) { /* ignore */ }
      };
      // send default topology on connect
      wss.send(client, { type: 'topology', topologyId: 'default', state: fullState(topologies.get('default')) });
    }
  } catch (e) {
    console.error('upgrade error:', e && e.stack || e);
    try { socket.destroy(); } catch (e2) {}
  }
});

server.listen(PORT, function () {
  console.log('');
  console.log('  PacketForge — open-source, vendor-agnostic network simulator');
  console.log('  ------------------------------------------------------------');
  console.log('  Local:   http://localhost:' + PORT);
  console.log('  Devices: ' + catalog.length + ' models across ' +
    new Set(catalog.map(function (s) { return s.vendor; })).size + ' vendors');
  console.log('  WebSocket sync: ws://localhost:' + PORT + ' (live multi-client)');
  console.log('');
});
