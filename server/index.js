'use strict';
// index.js — PacketForge server: static frontend + JSON API + WebSocket sync.
// Zero runtime dependencies. Run:  node server/index.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const { Topology, Simulator, CliSession, flow } = require('../engine');
const { loadCatalog, groupByCategory } = require('../devices/registry');
const media = require('../engine/media');
const { WebSocketServer } = require('./ws');

const PORT = parseInt(process.env.PORT || '8000', 10);
const WEB_DIR = path.join(__dirname, '..', 'web');
const DEVICES_DIR = path.join(__dirname, '..', 'devices');

// Where boards are kept between runs.
//
// The server used to hold every topology in memory only, so restarting it - which is a
// normal thing to do while developing - threw the board away. The browser kept drawing
// its own copy, and because the WebSocket had no reconnect it never found out it was
// looking at a board that no longer existed (issue #24). PF_DATA lets a test run against
// a scratch directory instead of the real one.
const DATA_DIR = process.env.PF_DATA ? path.resolve(process.env.PF_DATA)
  : path.join(__dirname, '..', 'data');
const TOPO_DIR = path.join(DATA_DIR, 'topologies');

// --- state ---
const topologies = new Map();
const sessions = new Map(); // `${topoId}:${devId}` -> CliSession
const catalog = loadCatalog(DEVICES_DIR);
const wss = new WebSocketServer();

// --- persistence -----------------------------------------------------------
// File per board, JSON, no database, no dependency. Writes are debounced because a
// single CLI command can touch several interfaces and each one broadcasts.
const pendingSaves = new Map();

function topologyFile(id) {
  const safe = String(id).replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(TOPO_DIR, safe + '.json');
}

function saveTopologyNow(id) {
  const t = topologies.get(id);
  if (!t) return false;
  try {
    fs.mkdirSync(TOPO_DIR, { recursive: true });
    const body = {
      format: 'packetforge-topology',
      version: 1,
      savedAt: new Date().toISOString(),
      topology: t.serialize()
    };
    // Write to a temporary file and rename, so a crash mid-write cannot leave a
    // half-written board that the next boot refuses to parse.
    const target = topologyFile(id);
    const tmp = target + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + String.fromCharCode(10));
    fs.renameSync(tmp, target);
    return true;
  } catch (e) {
    console.error('could not save topology ' + id + ': ' + e.message);
    return false;
  }
}

// Saved immediately, not on a debounce.
//
// A 120 ms debounce looked harmless and was not: on Windows a kill (or taskkill, or a
// crashed terminal) calls TerminateProcess, so no signal handler and no 'exit' listener
// ever runs, and anything still waiting on a timer is simply gone. The window was small
// and the loss was real - a board that had just been edited came back one edit short.
// A board is a few kilobytes and a human makes one change at a time, so the honest
// trade is a synchronous write per change.
function saveTopology(id) {
  if (pendingSaves.has(id)) { clearTimeout(pendingSaves.get(id)); pendingSaves.delete(id); }
  saveTopologyNow(id);
}

// Kept for the shutdown path: with immediate saves there is normally nothing pending,
// but a caller that sets pendingSaves itself must still be flushed.
function flushSaves() {
  for (const [id, timer] of pendingSaves) {
    clearTimeout(timer);
    saveTopologyNow(id);
  }
  pendingSaves.clear();
}

// Load whatever survived the last run. A board that cannot be parsed is reported and
// left alone rather than deleted: it is the user's work, and a later version may read it.
function loadSavedTopologies() {
  let names;
  try { names = fs.readdirSync(TOPO_DIR); } catch (e) { return; }
  for (const name of names) {
    if (!/\.json$/i.test(name)) continue;
    const full = path.join(TOPO_DIR, name);
    try {
      const body = JSON.parse(fs.readFileSync(full, 'utf8'));
      const raw = body && body.topology ? body.topology : body;
      const topo = Topology.fromJSON(raw);
      const id = name.replace(/\.json$/i, '');
      topologies.set(id, topo);
    } catch (e) {
      console.error('could not load ' + name + ': ' + e.message);
    }
  }
}

function ensureTopology(id) {
  let t = topologies.get(id);
  if (!t) { t = new Topology(); topologies.set(id, t); }
  return t;
}
ensureTopology('default');
loadSavedTopologies();
ensureTopology('default');

function sessionKey(topoId, devId) { return topoId + ':' + devId; }

function mapToObject(m) {
  const o = {};
  for (const [k, v] of m) o[k] = v;
  return o;
}

// A flow record is already plain data (no Maps), so the wire shape is the record
// plus the one thing a table always wants and has to compute: a summary line.
function describeFlow(rec) {
  if (!rec) return null;
  const out = {};
  for (const k of Object.keys(rec)) out[k] = rec[k];
  out.summary = flow.describe(rec);
  return out;
}

// The flow table belongs to the topology, not to a request. The server builds a
// fresh Simulator for every call, but the conversations it opened have to still be
// there when the UI asks for them a moment later -- and they have to die with the
// topology, because a flow to a device that no longer exists is a stale handle.
function flowStateFor(topo) {
  if (!topo.flowState) topo.flowState = flow.createFlowState();
  return topo.flowState;
}

function simForFlows(topo) {
  return new Simulator(topo, { flowState: flowStateFor(topo) });
}

function fullState(topo) {
  const s = topo.serialize();
  const runtime = {};
  const counters = (topo.flowState && topo.flowState.counters) || {};
  for (const d of topo.devices.values()) {
    runtime[d.id] = {
      macTable: mapToObject(d.macTable),
      arp: mapToObject(d.arp),
      routes: d.routesTable(),
      // Throughput, so a table or a sparkline can be drawn without a second call.
      counters: counters[d.id] || {
        bytesIn: 0, bytesOut: 0, packetsIn: 0, packetsOut: 0,
        flowsOpened: 0, flowsRefused: 0
      }
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
  // Every mutation broadcasts, so this is the one place that has to know a board
  // changed. Persisting here cannot drift out of step with the in-memory state.
  saveTopology(topoId);
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
        // A client-supplied id that is already taken must not replace the device that
        // holds it. addDevice throws for that; answer with a conflict instead of a 500.
        if (body.id && topo.devices.has(body.id)) {
          return sendJSON(res, 409, {
            error: 'device id already in use',
            id: body.id,
            existing: topo.devices.get(body.id).label || topo.devices.get(body.id).model
          });
        }
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
            patchCord: body.patchCord,
            force: !!body.force,
            type: body.type
          });
          // Populate the LLDP neighbour tables now, so the port inspector can say
          // what is on the other end without waiting for a ping.
          try { new Simulator(topo).refreshNeighbours(); } catch (e) { /* best effort */ }
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
        lengthM: body.lengthM,
        patchCord: body.patchCord
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
      if (method === 'PATCH' || method === 'POST') {
        const body = await readBody(req);
        const result = topo.setLinkLength(parts[4], body.lengthM);
        if (!result.ok) {
          return sendJSON(res, 422, { error: (result.errors[0] || {}).message, code: (result.errors[0] || {}).code, state: fullState(topo) });
        }
        broadcast(topoId);
        const link = result.link;
        return sendJSON(res, 200, {
          ok: true,
          link: { id: link.id, mediaId: link.mediaId, lengthM: link.lengthM },
          warnings: result.warnings,
          state: fullState(topo)
        });
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
      // A dual-purpose cage (WAN or LAN) can be switched, but only to a role the
      // hardware actually offers. Refusing anything else keeps "impossible" out of
      // the model while letting the complex-but-possible case through.
      if (body.role !== undefined) {
        const allowed = iface.dualRole || (iface.role ? [iface.role] : null);
        if (!allowed || allowed.indexOf(body.role) === -1) {
          return sendJSON(res, 400, {
            error: iface.name + ' cannot be ' + body.role +
              (allowed ? '; it is fixed to ' + allowed.join('/') : '; it has no configurable role')
          });
        }
        iface.role = body.role;
      }
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

    // /flows  (GET: list and counters, POST: open a transport flow)
    if (parts[3] === 'flows' && parts.length === 4) {
      if (method === 'GET') {
        const state = flowStateFor(topo);
        const list = flow.listFlows(state).map(function (f) { return describeFlow(f); });
        return sendJSON(res, 200, { flows: list, counters: state.counters });
      }
      if (method === 'POST') {
        const body = await readBody(req);
        const sim = simForFlows(topo);
        let result;
        try {
          result = sim.openFlow({
            proto: body.proto,
            srcDevice: body.srcDevice !== undefined ? body.srcDevice : body.src,
            dstDevice: body.dstDevice !== undefined ? body.dstDevice : body.dst,
            dstIp: body.dstIp,
            srcPort: body.srcPort,
            dstPort: body.dstPort,
            bytes: body.bytes
          });
        } catch (e) {
          // An unknown device is a client bug, not a network condition.
          return sendJSON(res, 400, { error: e.message });
        }
        if (!result.ok) {
          return sendJSON(res, 400, {
            error: result.reason, code: result.code, reason: result.reason,
            flow: result.flow ? describeFlow(result.flow) : null,
            events: result.events, step: result.step
          });
        }
        broadcast(topoId);
        return sendJSON(res, 201, {
          flow: describeFlow(result.flow),
          mtu: result.mtu, mss: result.mss, segments: result.segments,
          events: result.events, step: result.step,
          counters: flowStateFor(topo).counters,
          runtime: fullState(topo).runtime
        });
      }
    }

    // /flows/:id  (GET one, DELETE to tear it down)
    if (parts[3] === 'flows' && parts.length === 5) {
      const id = decodeURIComponent(parts[4]);
      const state = flowStateFor(topo);
      if (method === 'GET') {
        const rec = state.flows.get(id);
        if (!rec) return sendJSON(res, 404, { error: 'flow not found' });
        return sendJSON(res, 200, { flow: describeFlow(rec) });
      }
      if (method === 'DELETE') {
        const sim = simForFlows(topo);
        const result = sim.closeFlow(id);
        if (!result.ok) return sendJSON(res, 404, { error: result.reason, code: result.code });
        broadcast(topoId);
        return sendJSON(res, 200, {
          ok: true, flow: describeFlow(result.flow), already: !!result.already,
          events: result.events, step: result.step,
          counters: flowStateFor(topo).counters,
          runtime: fullState(topo).runtime
        });
      }
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
      // A reset clears the conversations too: they are runtime state, and a flow
      // left behind would point at a NAT translation or a socket that no longer
      // exists.
      flow.resetFlowState(flowStateFor(topo));
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

// A debounced save must not die with the process. Ctrl-C while a device is being
// placed is exactly the moment the work is most likely to be lost.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  flushSaves();
  console.log('  ' + signal + ' - boards saved, shutting down.');
  try {
    server.close(function () { process.exit(0); });
  } catch (e) { process.exit(0); }
  setTimeout(function () { process.exit(0); }, 1000).unref();
}
process.on('SIGINT', function () { shutdown('SIGINT'); });
process.on('SIGTERM', function () { shutdown('SIGTERM'); });
process.on('SIGBREAK', function () { shutdown('SIGBREAK'); });
process.on('SIGHUP', function () { shutdown('SIGHUP'); });
// Last resort for a normal exit path: synchronous, so it completes during shutdown.
process.on('exit', function () { try { flushSaves(); } catch (e) {} });

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
