'use strict';
// index.js — PacketForge server: static frontend + JSON API + WebSocket sync.
// Zero runtime dependencies. Run:  node server/index.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { URL } = require('url');

const { Topology, Simulator, CliSession, flow, isPosition, positionProblem, WORLD_LIMIT } = require('../engine');
const { loadCatalog, groupByCategory } = require('../devices/registry');
const { validateTopology } = require('../engine/validation');
const media = require('../engine/media');
const { WebSocketServer } = require('./ws');
const { formatStartupError } = require('./startup-error');
const { createRequestCache } = require('./requests');

// Open hardware requests, cached. Built once so a burst of palette searches does not
// become a burst of forge API calls, and refreshed lazily so a forge that is down for a
// while costs one failed request per TTL rather than one per search.
const requestCache = createRequestCache({});

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

// A board's file name is derived from its id, and the derivation loses information: `a b` and `a_b` both
// become `a_b.json`, so two boards shared one file - one of them silently overwritten on every save and gone at
// the next boot. When the sanitised form differs from the id, a short hash of the exact id is appended, which
// makes the name injective again. The id itself is written into the file, so the name never has to be reversed
// (#1315).
// decodeURIComponent() throws on a malformed sequence (`%E0%A4%A`). A bad escape is a bad request, not a crash.
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch (e) { return s; }
}

function topologyFile(id) {
  const raw = String(id);
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, '_');
  if (safe === raw) return path.join(TOPO_DIR, raw + '.json');
  const tag = require('crypto').createHash('sha1').update(raw).digest('hex').slice(0, 8);
  return path.join(TOPO_DIR, safe + '-' + tag + '.json');
}

function saveTopologyNow(id) {
  const t = topologies.get(id);
  if (!t) return false;
  try {
    fs.mkdirSync(TOPO_DIR, { recursive: true });
    const body = {
      format: 'packetforge-topology',
      version: 1,
      id: id,
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
    // The path, because "could not save topology default" does not tell a human which directory to look at.
    console.error('could not save topology ' + id + ' to ' + topologyFile(id) + ': ' + e.message);
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
      // A file that parses but is not a board used to be adopted as an **empty** one: the operator opened the app
      // and their lab was gone, with nothing said. `Topology.fromJSON()` is tolerant on purpose (it reads old
      // files), so the envelope is checked here, where the decision to replace something is made (#1315).
      const raw = body && body.topology ? body.topology : body;
      const problem = savedDocProblem(raw, body);
      if (problem) {
        console.error('could not load ' + name + ': ' + problem + ' - left alone');
        continue;
      }
      const topo = Topology.fromJSON(raw);
      // The id is in the file when this server wrote it; older files are named after their board.
      const id = (body && typeof body.id === 'string' && body.id) ? body.id : name.replace(/\.json$/i, '');
      topologies.set(id, topo);
    } catch (e) {
      console.error('could not load ' + name + ': ' + e.message);
    }
  }
}

// What a saved file must look like before it is allowed to become a board.
function savedDocProblem(raw, body) {
  if (body && body.format !== undefined && body.format !== 'packetforge-topology') {
    return 'expected format "packetforge-topology", got ' + JSON.stringify(body.format);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'not a topology document';
  // A save always has at least one of these keys; a board is allowed to be empty, but the keys have to be there,
  // because a file without them is a mistake rather than an empty lab.
  if (raw.devices === undefined && raw.links === undefined) {
    return 'no devices and no links: not a topology document';
  }
  if (raw.devices !== undefined && !Array.isArray(raw.devices)) return 'devices must be an array';
  if (raw.links !== undefined && !Array.isArray(raw.links)) return 'links must be an array';
  return '';
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

// The MAC table is published as address -> port, which is what it has always meant. The table itself now keeps
// `{ port, atMs }` per entry so it can age (#1395); the instant is not part of what a client reads here, and
// `runtime[id].mac` carries an age per row for anyone who wants it.
function macTableObject(m) {
  const o = {};
  for (const [mac, where] of m) {
    o[mac] = (where && typeof where === 'object') ? where.port : where;
  }
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

// After a device or a cable is removed, every open flow is asked whether the path it crossed still exists (#1427).
//
// A flow records the hops it actually took (`rec.hops`, captured from its own handshake), so this is a fact about the
// lab and not a guess: a hop that is gone, or two consecutive hops that are no longer cabled, means nothing can carry
// the conversation any more. A flow whose path is untouched is left strictly alone - its state, its bytes and its
// tally. Before this, deleting the switch a conversation crossed left that conversation listed as `established` on a
// board with no cables at all, and nothing ever corrected it.
function sweepFlows(topo, flowState, why) {
  const ended = [];
  for (const rec of flow.listFlows(flowState)) {
    if (!flow.isLive(rec)) continue;
    let reason = null;
    for (const hop of rec.hops || []) {
      if (!topo.getDevice(hop)) {
        // The caller knows which device it just removed, so say that rather than narrating it twice.
        reason = why || ('device ' + hop + ' was removed');
        break;
      }
    }
    if (!reason && Array.isArray(rec.hops)) {
      for (let i = 0; i + 1 < rec.hops.length; i++) {
        const a = rec.hops[i], b = rec.hops[i + 1];
        if (!topo.linksFor(a).some(function (l) { return l.touches(b); })) {
          reason = a + ' and ' + b + ' are no longer cabled' + (why ? ' (' + why + ')' : '');
          break;
        }
      }
    }
    if (reason && flow.resetFlow(rec, reason)) ended.push({ id: rec.id, reason: rec.reason });
  }
  return ended;
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

// What an answer says when the request changed something the control plane depends on.
//
// Only `/links/:id/state` used to report convergence, so an operator driving the API could see whether the lab was
// settled after cutting a cable and had no way to ask after disabling a port, adding a switch or moving a cable -
// the same four questions, one of which answered (#1333). Nothing here invents a convergence model: `getConvergence()`
// is the engine's own schedule, and the instant is the one the caller says they are standing at. A request that does
// not say leaves the clock alone rather than moving it to 0, which would claim the board changed before it did.
function noteChange(topo, body, extra) {
  const atMs = body && body.atMs !== undefined ? Number(body.atMs) : null;
  let recorded = null;
  if (atMs !== null && Number.isFinite(atMs) && atMs >= 0 && typeof topo.markChange === 'function') {
    recorded = topo.markChange(atMs);
  }
  const sim = simForFlows(topo);
  const out = Object.assign({}, extra || {});
  out.convergence = sim.getConvergence();
  if (recorded !== null) out.atMs = recorded;
  return out;
}

// What `/links` needs from each end of a cable, said as a sentence rather than a TypeError.
function endShape(end) {
  if (!end || typeof end !== 'object') return 'missing end of cable';
  if (typeof end.deviceId !== 'string' || !end.deviceId) return 'missing deviceId';
  if (typeof end.iface !== 'string' || !end.iface) return 'missing iface';
  return '';
}

// What a document must look like before it is allowed to replace a live board. Deliberately only the envelope:
// the engine decides what a valid cable is (#1304), and old files have to keep loading.
function documentShapeProblem(doc) {
  if (doc === undefined || doc === null) return 'expected a topology document, got nothing';
  if (typeof doc !== 'object' || Array.isArray(doc)) return 'expected a topology document (an object)';
  if (doc.format !== undefined && doc.format !== 'packetforge-topology') {
    return 'expected format "packetforge-topology", got ' + JSON.stringify(doc.format);
  }
  if (doc.devices !== undefined && !Array.isArray(doc.devices)) return 'devices must be an array';
  if (doc.links !== undefined && !Array.isArray(doc.links)) return 'links must be an array';
  // A document with neither key is not a topology, it is a mistake - and loading it empties the board.
  if (doc.devices === undefined && doc.links === undefined) {
    return 'no devices and no links: this is not a topology document, and loading it would empty the board';
  }
  return '';
}

function fullState(topo) {
  const s = topo.serialize();
  const runtime = {};
  for (const d of topo.devices.values()) {
    runtime[d.id] = {
      macTable: macTableObject(d.macTable),
      arp: mapToObject(d.arp),
      // The same rows the console prints, from the same place (#1327). `macTable` and `arp` above are bare maps -
      // MAC to port, address to MAC - which told a client that an entry existed and not whether the port it points
      // at can still carry a frame, so a stale entry and a live one were the same two strings; and LLDP was not
      // published at all. Each row carries the sentence `show mac address-table`, `show arp` and `show lldp`
      // append, written once in Device, so the two surfaces cannot drift.
      mac: d.macRows(topo),
      arpRows: d.arpRows(topo),
      lldp: d.lldpRows(topo),
      routes: d.routesTable(topo),
      // Throughput, so a table or a sparkline can be drawn without a second call. The engine's own snapshot: the
      // same shape whether or not the device has carried anything, and a copy, so editing what you were given does
      // not edit the tally (#1329). `counted` separates "nothing has crossed this device" from "zero shown here".
      counters: flow.counterSnapshot(topo.flowState, d.id)
    };
  }
  s.runtime = runtime;
  // What the engine thinks of every cable, computed once per state read. `validateTopology()` has existed since
  // the physical-layer rules did and nothing at runtime ever called it, so an impossible cable - one loaded from
  // a document written before a rule existed, or hand-edited - travelled through the whole UI without a verdict.
  // The cable inspector then printed a hardcoded "this cable passed the physical-layer check" over it (#1303).
  s.verdicts = linkVerdicts(topo);
  // Cables a document described that could not be restored. Kept next to `verdicts` so every state payload says the
  // same thing about the board it carries (#1306) - a lab that lost a cable says which one and why (#1323).
  s.loadIssues = (topo.loadIssues || []).slice();
  return s;
}

// One verdict per cable, in the shape the UI reads: `{ok, errorCount, warningCount, byLink, issues}`.
// `byLink` exists so a panel that has one cable selected does not have to filter the whole lab on every render.
function linkVerdicts(topo) {
  let v;
  try {
    v = validateTopology(topo);
  } catch (e) {
    return { ok: false, errorCount: 1, warningCount: 0, byLink: {}, checked: false,
      issues: [{ severity: 'error', code: 'E_LINK_UNCHECKABLE', message: 'Cables could not be checked: ' + e.message }] };
  }
  const byLink = {};
  for (const issue of (v.issues || [])) {
    const key = issue.linkId || '-';
    (byLink[key] = byLink[key] || []).push(issue);
  }
  return {
    ok: v.ok, errorCount: v.errorCount || 0, warningCount: v.warningCount || 0,
    byLink: byLink, issues: v.issues || [], checked: true
  };
}

// Every JSON response goes through here, which makes it the one place worth optimising.
//
// `/api/catalog` is the whole catalogue: 2,015 specs, ~2.2 MB of JSON, fetched on every page load.
// It used to be sent identity-encoded with `Cache-Control: no-store`, so a reload paid all 2.2 MB
// again over the wire - and the catalogue is required to keep growing, so that cost only goes up.
//
// Two changes, both of which are how the web has worked for twenty years:
//
//   * gzip when the client says it can take it (every browser does), which takes the catalogue to
//     ~308 KB - a 7x reduction on the single largest thing the app transfers;
//   * a strong ETag so a reload revalidates and gets an empty `304` instead of the body, while `no-cache` keeps the response revalidated on every use rather than trusted blind.
//
// The request is read from `res.pfReq`, set once per request in the handler: threading a new
// parameter through fifty call sites would have been a bigger change than the optimisation.
function sendJSON(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const req = res.pfReq || null;
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
    'ETag': '"' + crypto.createHash('sha1').update(body).digest('base64').replace(/=+$/, '') + '"',
    'Vary': 'Accept-Encoding'
  };

  // Revalidation: a client that already has this exact body gets no body at all.
  const inm = req && req.headers ? String(req.headers['if-none-match'] || '') : '';
  if (code === 200 && inm && inm.split(',').map(function (t) { return t.trim(); }).indexOf(headers.ETag) !== -1) {
    res.writeHead(304, headers);
    return res.end();
  }

  const accept = req && req.headers ? String(req.headers['accept-encoding'] || '') : '';
  if (/\bgzip\b/i.test(accept) && body.length >= 1024) {
    let gz = null;
    try { gz = zlib.gzipSync(body); } catch (e) { gz = null; }
    // Only claim the encoding when it actually helped: a 40-byte response can get bigger.
    if (gz && gz.length < body.length) {
      headers['Content-Encoding'] = 'gzip';
      res.writeHead(code, headers);
      return res.end(gz);
    }
  }

  res.writeHead(code, headers);
  res.end(body);
}

// Responses that cannot change while the server runs, serialised once.
//
// `/api/catalog` is 4.4 MB of JSON today. Building it costs ~75 ms of CPU per request: stringify the
// whole catalogue, then gzip 4.4 MB. Worse, the ETag is a hash *of the body*, so even a request that
// ends in `304 Not Modified` had to build the entire body first to discover it could have skipped it.
// A reload therefore cost the server as much as a first load while transferring nothing.
//
// These two endpoints are immutable after `loadCatalog()` runs at startup, so their serialised forms,
// their ETags and their gzipped bytes are all cacheable for the life of the process. If the catalogue
// ever becomes reloadable at runtime, this cache must be cleared where the reload happens - that is
// the only invalidation rule, and it is stated here because the failure would be silent (a stale
// catalogue served with a matching ETag looks perfectly healthy).
const immutableCache = new Map();

function sendImmutableJSON(req, res, key, build) {
  let entry = immutableCache.get(key);
  if (!entry) {
    const body = Buffer.from(JSON.stringify(build()), 'utf8');
    entry = {
      body: body,
      etag: '"' + crypto.createHash('sha1').update(body).digest('base64').replace(/=+$/, '') + '"',
      gzip: null
    };
    immutableCache.set(key, entry);
  }
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
    'ETag': entry.etag,
    'Vary': 'Accept-Encoding'
  };
  const inm = req && req.headers ? String(req.headers['if-none-match'] || '') : '';
  if (inm && inm.split(',').map(function (t) { return t.trim(); }).indexOf(entry.etag) !== -1) {
    res.writeHead(304, headers);
    return res.end();
  }
  const accept = req && req.headers ? String(req.headers['accept-encoding'] || '') : '';
  if (/\bgzip\b/i.test(accept)) {
    if (entry.gzip === null) {
      let gz = null;
      try { gz = zlib.gzipSync(entry.body); } catch (e) { gz = null; }
      entry.gzip = (gz && gz.length < entry.body.length) ? gz : false;
    }
    if (entry.gzip) {
      headers['Content-Encoding'] = 'gzip';
      headers['Content-Length'] = entry.gzip.length;
      res.writeHead(200, headers);
      return res.end(entry.gzip);
    }
  }
  headers['Content-Length'] = entry.body.length;
  res.writeHead(200, headers);
  res.end(entry.body);
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


// --- static file server ---
//
// The app is five files: 129 KB of app.js, 36 KB of canvas.js, 27 KB of faceplate.js, 30 KB of CSS
// and 7 KB of HTML. All of it used to go out with `Cache-Control: no-store` and no compression, so
// every single load re-downloaded ~236 KB that had not changed since the last one.
//
// Now: an ETag and a Last-Modified so a reload revalidates into an empty 304, and gzip for the text
// types, which is most of it. The compressed form is cached per (file, mtime, size) so the cost is
// paid once per version of a file rather than once per request.
const gzipCache = new Map();

function cachedGzip(filePath, mtimeMs, data) {
  const key = filePath + '|' + mtimeMs + '|' + data.length;
  const hit = gzipCache.get(key);
  if (hit) return hit;
  let out = null;
  try { out = zlib.gzipSync(data); } catch (e) { out = null; }
  if (out && out.length >= data.length) out = null;
  // One entry per file version; drop anything older for this path.
  for (const k of Array.from(gzipCache.keys())) {
    if (k.indexOf(filePath + '|') === 0) gzipCache.delete(k);
  }
  gzipCache.set(key, out);
  return out;
}

const COMPRESSIBLE = { '.html': 1, '.css': 1, '.js': 1, '.json': 1, '.svg': 1, '.txt': 1, '.map': 1 };

function sendAsset(req, res, filePath, data, mtimeMs) {
  const ext = path.extname(filePath).toLowerCase();
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    // Revalidate rather than trust: the server is also the thing being edited, and a browser holding
    // a stale app.js after a fix is the most confusing bug report there is.
    'Cache-Control': 'no-cache',
    'ETag': 'W/"' + data.length + '-' + Math.floor(mtimeMs) + '"',
    'Last-Modified': new Date(mtimeMs).toUTCString(),
    'Vary': 'Accept-Encoding'
  };

  const inm = String((req && req.headers && req.headers['if-none-match']) || '');
  if (inm && inm.split(',').map(function (t) { return t.trim(); }).indexOf(headers.ETag) !== -1) {
    res.writeHead(304, headers);
    return res.end();
  }
  const ims = Date.parse(String((req && req.headers && req.headers['if-modified-since']) || ''));
  if (isFinite(ims) && Math.floor(mtimeMs / 1000) * 1000 <= ims) {
    res.writeHead(304, headers);
    return res.end();
  }

  const accept = String((req && req.headers && req.headers['accept-encoding']) || '');
  if (COMPRESSIBLE[ext] && /\bgzip\b/i.test(accept) && data.length >= 1024) {
    const gz = cachedGzip(filePath, mtimeMs, data);
    if (gz) {
      headers['Content-Encoding'] = 'gzip';
      headers['Content-Length'] = gz.length;
      res.writeHead(200, headers);
      if (String((req && req.method) || 'GET').toUpperCase() === 'HEAD') return res.end();
      return res.end(gz);
    }
  }
  headers['Content-Length'] = data.length;
  res.writeHead(200, headers);
  // HEAD asks for the headers a GET would produce, and no body.
  if (String((req && req.method) || 'GET').toUpperCase() === 'HEAD') return res.end();
  res.end(data);
}

function serveStatic(req, res, urlPath) {
  // Only a read serves a file. Anything else used to be served too: `POST /index.html` answered 200 with the
  // document, which tells a client its write worked (#1311).
  const method = String((req && req.method) || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { 'Allow': 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed');
    return;
  }

  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.normalize(path.join(WEB_DIR, rel));
  // The check is a path boundary, not a string prefix. `indexOf(WEB_DIR) === 0` also accepts `web-backup/...`,
  // so a directory that merely shares the first characters would have been served. Nothing relies on the URL
  // parser for correctness here, because that is one place the answer must not depend on (#1311).
  const inside = filePath === WEB_DIR || filePath.slice(0, WEB_DIR.length + 1) === WEB_DIR + path.sep;
  if (!inside) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, function (err, data) {
    if (err) {
      // A path that names a file gets a 404. The fallback below is for documents - this app has no client-side
      // routes, so answering `/nope.js` with index.html only ever hid a wrong filename: the browser then reports
      // "Unexpected token '<'" in a file the reader can no longer identify (#1311).
      if (path.extname(urlPath)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); return; }
      // SPA fallback: unknown document paths serve index.html
      const indexPath = path.join(WEB_DIR, 'index.html');
      fs.readFile(indexPath, function (e2, html) {
        if (e2) { res.writeHead(404); res.end('Not found'); return; }
        fs.stat(indexPath, function (e3, st) {
          sendAsset(req, res, indexPath, html, !e3 && st && st.mtimeMs ? st.mtimeMs : Date.now());
        });
      });
      return;
    }
    fs.stat(filePath, function (e4, st) {
      sendAsset(req, res, filePath, data, !e4 && st && st.mtimeMs ? st.mtimeMs : Date.now());
    });
  });
}


// --- API ---
async function handleApi(req, res, urlPath) {
  // sendJSON needs the request to negotiate encoding and read If-None-Match. One assignment here
  // beats threading a parameter through fifty call sites.
  res.pfReq = req;
  const method = req.method.toUpperCase();
  const parts = urlPath.split('/').filter(Boolean); // e.g. ['api','topologies','default','devices']
  // A board's name is a name. It may contain a space, a slash or a `#`, so the path segment is percent-encoded by
  // the client - and it has to be decoded here, or a board called `a b` can be created and then never reached again
  // (#1315). Port names learned this in #1307.
  if (parts[1] === 'topologies' && parts.length > 2) parts[2] = safeDecode(parts[2]);

  try {
    // GET /api/catalog
    if (parts[1] === 'catalog' && method === 'GET') {
      return sendImmutableJSON(req, res, 'catalog', function () {
        return { specs: catalog, categories: groupByCategory(catalog) };
      });
    }

    // GET /api/version -- which build is answering. A bug report that does not say
    // what it was running against is a conversation, not a report, so the app reads
    // this to fill that in for the person filing it.
    if (parts[1] === 'version' && method === 'GET') {
      let pkg = {};
      try { pkg = require('../package.json'); } catch (e) { /* packaged without it */ }
      return sendJSON(res, 200, {
        name: pkg.name || 'packetforge',
        version: pkg.version || 'unknown',
        commit: process.env.PF_COMMIT || null,
        node: process.version,
        platform: process.platform + '/' + process.arch,
        devices: catalog.length
      });
    }

    // GET /api/requests -- open hardware requests from the issue tracker.
    //
    // The catalogue and the request backlog used to be separate worlds: what is modelled
    // was here, what has been asked for was in the tracker where nobody using the app
    // could see it. That is how sixty-plus people filed requests for hardware that was
    // already in the catalogue. This is read-only and never blocks the catalogue.
    if (parts[1] === 'requests' && method === 'GET') {
      return sendJSON(res, 200, await requestCache.get());
    }

    // GET /api/media -- physical media + cage catalogue (link-type picker)
    if (parts[1] === 'media' && method === 'GET') {
      return sendImmutableJSON(req, res, 'media', function () {
        return { media: media.MEDIA, cages: media.CAGES };
      });
    }

    // topologies collection
    if (parts[1] === 'topologies' && parts.length === 2) {
      if (method === 'GET') return sendJSON(res, 200, { ids: Array.from(topologies.keys()) });
      if (method === 'POST') {
        const body = await readBody(req);
        const id = body.id || ('topo-' + Date.now().toString(36));
        if (!topologies.has(id)) {
          topologies.set(id, new Topology());
          // A board that was created and acknowledged is a thing the operator made. It used to live only in memory
          // until something else happened to it, so "make a board, name it, come back tomorrow" lost it (#1315).
          saveTopology(id);
        }
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
        // `body.x || 160` turned a device placed at x = 0 into a device placed at 160: zero is a coordinate, and it
        // is the one at the top-left of the canvas (#1325).
        topo.layout[dev.id] = {
          x: (typeof body.x === 'number' && isFinite(body.x)) ? body.x : 160,
          y: (typeof body.y === 'number' && isFinite(body.y)) ? body.y : 160
        };
        broadcast(topoId);
        return sendJSON(res, 201, noteChange(topo, body, { device: dev.serialize(), state: fullState(topo) }));
      }
    }

    // /devices/:devId
    if (parts[3] === 'devices' && parts.length === 5) {
      const devId = parts[4];
      if (method === 'DELETE') {
        // A conversation on a device that is about to stop existing is not a conversation (#1427). The flow layer is a
        // picture of the topology and nothing used to tell it the topology had changed, so a flow stayed `established`
        // over a board with no cables, and the deleted device's counters waited for the next device created with the
        // same id. Both are answered here, in the same place the device goes.
        const flowState = flowStateFor(topo);
        const ended = [];
        for (const rec of flow.flowsForDevice(flowState, devId)) {
          if (flow.resetFlow(rec, 'device ' + devId + ' was deleted')) ended.push({ id: rec.id, reason: rec.reason });
        }
        topo.removeDevice(devId);
        delete topo.layout[devId];
        flow.forgetDevice(flowState, devId);
        ended.push.apply(ended, sweepFlows(topo, flowState, 'device ' + devId + ' was deleted'));
        for (const key of Array.from(sessions.keys())) if (key.indexOf(topoId + ':') === 0) sessions.delete(key);
        broadcast(topoId);
        return sendJSON(res, 200, noteChange(topo, null, { ok: true, resetFlows: ended, state: fullState(topo) }));
      }
    }

    // /links
    if (parts[3] === 'links' && parts.length === 4) {
      if (method === 'POST') {
        const body = await readBody(req);
        // A missing body used to be dereferenced straight through - `body.a.deviceId` - and answered 409 with
        // the JavaScript engine's own words ("Cannot read properties of undefined"). A malformed request is a
        // client error, it is 400, and it says what was expected (#1309).
        const endProblem = endShape(body && body.a) || endShape(body && body.b);
        if (endProblem) {
          return sendJSON(res, 400, {
            code: 'E_BAD_REQUEST',
            error: 'expected { a: { deviceId, iface }, b: { deviceId, iface } } - ' + endProblem
          });
        }
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
          return sendJSON(res, 201, noteChange(topo, body, { link: link.serialize(), state: fullState(topo) }));
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

    // /link-options -- every cable that could join two boxes, ranked (issue #68).
    //
    // The port-first flow made the user guess the socket before the engine would help, and a
    // wrong guess was one error with no way to see the pairs that would have worked. This is
    // the whole search in one answer: legal pairs grouped by medium, plus the refusals counted
    // by code so "nothing fits" can say why.
    if (parts[3] === 'link-options' && parts.length === 4 && method === 'POST') {
      const body = await readBody(req);
      const aId = body.a !== undefined ? body.a : (body.aId !== undefined ? body.aId : (body.from || null));
      const bId = body.b !== undefined ? body.b : (body.bId !== undefined ? body.bId : (body.to || null));
      if (aId === null || bId === null) {
        return sendJSON(res, 400, { code: 'E_BAD_REQUEST', reason: 'expected {a, b} device ids' });
      }
      // 200 even when nothing fits: the request succeeded, the answer is "no". A 409 here
      // would make the UI's fetch wrapper throw and lose the very explanation it asked for.
      const result = topo.linkOptions(aId, bId, { lengthM: body.lengthM });
      return sendJSON(res, 200, result);
    }

    // /links/:linkId/state - pull a cable or put it back, and re-converge from that instant.
    // The UI needs this to show what a Packet Tracer lab shows and a diagram cannot: a network
    // reacting to something going wrong.
    if (parts[3] === 'links' && parts.length === 6 && parts[5] === 'state') {
      if (method !== 'POST' && method !== 'PATCH') {
        return sendJSON(res, 405, { error: 'use POST' });
      }
      const body = await readBody(req);
      const state = String(body.state || '').toLowerCase();
      if (state !== 'up' && state !== 'down') {
        return sendJSON(res, 422, { error: 'state must be up or down', code: 'E_BAD_STATE' });
      }
      const sim = simForFlows(topo);
      // `Number(body.atMs) || 0` quietly turned a mistyped instant into t=0; the engine now refuses one and applies
      // the one rule for an absent one (the instant this request is being answered at) (#1385).
      const result = sim.setLinkState(parts[4], state, { atMs: body.atMs });
      if (!result.ok && result.code === 'E_BAD_INSTANT') {
        return sendJSON(res, 400, { error: result.detail, code: 'E_BAD_INSTANT' });
      }
      if (!result.ok) {
        return sendJSON(res, 404, { error: 'no such link', code: result.code || 'E_NO_LINK' });
      }
      broadcast(topoId);
      // `state` here used to appear twice in one object literal - the link's own 'up'/'down' first, the whole
      // topology last - so the payload was saved only by JavaScript taking the later key. Renaming the string to
      // `linkState` says what it is and removes the landmine (#1307).
      return sendJSON(res, 200, {
        ok: true, linkId: parts[4], linkState: state, atMs: result.atMs,
        reconvergeAtMs: result.reconvergeAtMs, changed: result.changed,
        convergence: sim.getConvergence(),
        state: fullState(topo)
      });
    }

    // /links/:linkId
    if (parts[3] === 'links' && parts.length === 5) {
      if (method === 'DELETE') {
        const linkId = parts[4];
        topo.disconnect(linkId);
        // A cable carries conversations. Removing one used to leave a flow `established` across a path that no longer
        // existed; every open flow is now asked whether the hops it actually crossed are still there and still cabled
        // (#1427). A flow with a path through the rest of the lab is left strictly alone - the lab healed, and the
        // conversation with it.
        const ended = sweepFlows(topo, flowStateFor(topo), 'cable ' + linkId + ' was deleted');
        broadcast(topoId);
        return sendJSON(res, 200, noteChange(topo, null, { ok: true, resetFlows: ended, state: fullState(topo) }));
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
      // `readBody()` gives back whatever was sent. With no body at all, `commands` became `[undefined]` and the
      // CLI session threw on `undefined.trim()`, so the operator got 400 with a JavaScript message instead of a
      // sentence mentioning commands (#1309).
      const raw = (body && Array.isArray(body.commands)) ? body.commands
        : (body && typeof body.command === 'string') ? [body.command] : null;
      if (!raw || !raw.length || raw.some(function (c) { return typeof c !== 'string'; })) {
        return sendJSON(res, 400, {
          code: 'E_BAD_REQUEST',
          error: 'expected { commands: ["configure terminal", ...] } - got ' +
            (body === undefined || body === null ? 'no body' : JSON.stringify(body).slice(0, 80))
        });
      }
      const commands = raw;
      const key = sessionKey(topoId, devId);
      let session = sessions.get(key);
      // The session used `new Simulator(topo)` - a second accounting with a second flow state - so traffic counted
      // by `/flows` was invisible to the console and traffic the console generated was invisible to the payload: one
      // board, two sets of counters (#1335). It now shares the topology's, like every other endpoint.
      if (!session) { session = new CliSession(dev, topo, simForFlows(topo)); sessions.set(key, session); }
      // Which instant the question is asked at. With no `atMs` the console answers "once everything has settled",
      // which is what it has always done; with one, the lab can be asked about mid-convergence. It is set on every
      // request rather than only when supplied, so a session cached by an earlier caller cannot pin this one to an
      // instant it did not ask for (#1335).
      const askedAt = (body && body.atMs !== undefined) ? Number(body.atMs) : NaN;
      session.sim.setRunTime(Number.isFinite(askedAt) && askedAt >= 0 ? askedAt : Infinity);
      const lines = [];
      for (const cmd of commands) {
        lines.push(session.prompt() + cmd);
        const r = session.run(cmd);
        for (const l of r.output) lines.push(l);
      }
      broadcast(topoId);
      // Same envelope as every other mutating endpoint. This one used to return only
      // output/lines/prompt/device, so the UI's `topo = r.state` stored undefined and
      // handed the renderer nothing to draw: setting a hostname blanked the board
      // while the server still held it (issue #38).
      return sendJSON(res, 200, {
        output: lines.join('\n'), lines: lines, prompt: session.prompt(),
        // The instant this answer describes, and where convergence stood at it - the same two facts every other
        // mutation reports (#1333), so an operator driving the API never has to guess which lab a console answer came
        // from.
        runAtMs: Number.isFinite(session.sim.runAtMs) ? session.sim.runAtMs : null,
        convergence: session.sim.getConvergence(),
        device: dev.serialize(), state: fullState(topo)
      });
    }

    // /interfaces/:devId/:iface  (direct property edit — nice UI shortcut)
    // A port name can contain a slash - `1/1/1`, `Fa0/1` - so the name is the rest of the path, not one segment,
    // and a correct client percent-encodes it. Both forms have to resolve. Until they did, the inspector's
    // shutdown toggle 404'd with `unknown endpoint: /api/topologies/default/interfaces/d1/1/1/1` for every port
    // named that way, which is most of the catalogue: the control was there, it was wired, and it did nothing
    // (#1307).
    if (parts[3] === 'interfaces' && parts.length >= 6 && method === 'POST') {
      const devId = parts[4];
      let ifaceName;
      try {
        ifaceName = decodeURIComponent(parts.slice(5).join('/'));
      } catch (e) {
        return sendJSON(res, 400, { error: 'bad interface name in path' });
      }
      const dev = topo.getDevice(devId);
      if (!dev) return sendJSON(res, 404, { error: 'device not found' });
      const iface = dev.interfaces.get(ifaceName);
      if (!iface) return sendJSON(res, 404, { error: 'interface not found' });
      const body = await readBody(req);
      // Every field of the body is checked **before** any of it is written.
      //
      // This handler used to write as it went - the address first, then `enabled`, then `description`, then `role` -
      // so a body carrying a good address and a role the hardware cannot take stored the address and answered `400`.
      // The caller was told the change failed while half of it had happened, which is the one thing a configuration
      // door must never do: after that, the board and the sentence about the board disagree and neither can be
      // trusted (#1425). It also asked `!!body.enabled` where a boolean was meant, so `{"enabled": "false"}` disabled
      // nothing and answered `200`.
      const refused = [];
      let nextIp = iface.ip;
      let nextMask = iface.mask;
      let ipChanged = false;
      if (body.ip !== undefined) {
        if (body.ip === null || body.ip === '') {
          nextIp = null; nextMask = null; ipChanged = true;
        } else {
          // This endpoint is a configuration door, and it answered different questions from the console (#1413).
          //
          // `maskToInt()` accepts any dotted quad - it is a parser, not a rule - so `255.0.255.0` was stored on the
          // port, read back by every surface as /8, and printed by `show running-config` as
          // `ip address 10.5.5.1 255.0.255.0`: a line the console itself refuses to type, so the lab could not be
          // rebuilt from its own configuration. And a prefix length was stored as the string "24" while the
          // console stores "255.255.255.0" for the same command, so the same intent had two spellings in state.
          //
          // Now: the address is asked of the address predicate, the mask of the mask rule, and a prefix length is
          // rewritten to the one spelling state uses. Each refusal carries a code, so a client can act on it.
          const netLib = require('../engine/net');
          const maskText = body.mask === undefined || body.mask === null ? '' : String(body.mask).trim();
          if (!netLib.isIp(String(body.ip))) {
            refused.push({ code: 'E_BAD_ADDRESS', error: 'ip "' + body.ip + '" is not an IPv4 address' });
          } else if (!maskText) {
            refused.push({ code: 'E_BAD_MASK', error: 'mask required with ip' });
          } else if (!netLib.isContiguousMask(maskText)) {
            refused.push({ code: 'E_BAD_MASK',
              error: 'mask "' + maskText + '" is not a netmask: a netmask is a run of ones then zeros ' +
                '(255.255.255.0, or 24)' });
          } else {
            nextIp = String(body.ip);
            nextMask = /^\d{1,2}$/.test(maskText) ? netLib.maskFromPrefix(Number(maskText)) : maskText;
            ipChanged = true;
          }
        }
      }
      // `enabled` is a boolean. `!!"false"` is `true`, so a client that sent the string got the opposite of what it
      // asked for and an `ok` to go with it.
      if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
        refused.push({ code: 'E_BAD_ENABLED',
          error: 'enabled must be true or false, not ' + JSON.stringify(body.enabled) });
      }
      if (body.description !== undefined && body.description !== null && typeof body.description !== 'string') {
        refused.push({ code: 'E_BAD_DESCRIPTION',
          error: 'description must be a string, not ' + JSON.stringify(body.description) });
      }
      // A dual-purpose cage (WAN or LAN) can be switched, but only to a role the hardware actually offers. Refusing
      // anything else keeps "impossible" out of the model while letting the complex-but-possible case through.
      if (body.role !== undefined) {
        const allowed = iface.dualRole || (iface.role ? [iface.role] : null);
        if (!allowed || allowed.indexOf(body.role) === -1) {
          refused.push({ code: 'E_BAD_ROLE',
            // "1 cannot be bogus" reads as a count; it is a port name.
            error: 'port ' + iface.name + ' cannot be ' + body.role +
              (allowed ? '; it is fixed to ' + allowed.join('/') : '; it has no configurable role') });
        }
      }
      if (refused.length) {
        // Nothing has been written at this point, so the board is exactly as it was. Every refusal is reported, not
        // just the first: a client that sent three bad fields should learn about three.
        return sendJSON(res, 400, {
          code: refused[0].code,
          error: refused.map(function (r) { return r.error; }).join('; '),
          problems: refused
        });
      }
      if (ipChanged) { iface.ip = nextIp; iface.mask = nextMask; }
      if (body.enabled !== undefined) iface.enabled = body.enabled;
      if (body.description !== undefined) iface.description = body.description || '';
      if (body.role !== undefined) iface.role = body.role;
      broadcast(topoId);
      return sendJSON(res, 200, noteChange(topo, body, { device: dev.serialize(), state: fullState(topo) }));
    }

    // /ping
    if (parts[3] === 'ping' && parts.length === 4 && method === 'POST') {
      const body = await readBody(req);
      if (!body || typeof body.src !== 'string' || !body.src) {
        return sendJSON(res, 400, {
          code: 'E_BAD_REQUEST',
          error: 'expected { src: <device id>, dst: <address or name> }'
        });
      }
      // The destination reached the engine unvalidated, so `10.0.0.999` threw inside `Simulator.ping()` and came
      // back as a 500 - a mis-typed octet presented as a server fault. And the browser's dialog refused a name the
      // engine resolves. Both are the same question: is this string a destination? (#1377)
      const dstProblem = function (v) {
        if (typeof v !== 'string' || !v.trim()) return 'dst must be an address or a hostname';
        const s = v.trim();
        if (/\s/.test(s)) return 'dst "' + s + '" contains whitespace, so it is neither an address nor a name';
        if (/^[0-9.]+$/.test(s)) {
          const parts = s.split('.');
          if (parts.length !== 4 || parts.some(function (o) { return !/^\d{1,3}$/.test(o) || Number(o) > 255; })) {
            return 'dst "' + s + '" is not an IPv4 address (four octets, each 0-255)';
          }
        }
        return null;
      };
      const dev = topo.getDevice(body.src);
      // A named device that does not exist is a 404; a request that named nothing is a 400, and the difference
      // matters when you are reading someone else's failed call. This is asked before the destination, so a
      // request that got both wrong is answered about the device it named.
      if (!dev) return sendJSON(res, 404, { error: 'source device not found: ' + body.src });
      const dstProblemText = dstProblem(body.dst);
      if (dstProblemText) return sendJSON(res, 400, { code: 'E_BAD_DESTINATION', error: dstProblemText });
      // `count` is a loop bound: one request asking for a billion echoes is hours of engine time and a response
      // nobody can hold, and the engine only learned to bound itself in this same change (#1379). Refuse it here
      // with the rule, so the caller learns the limit instead of being silently clamped.
      if (body.count !== undefined && body.count !== null) {
        const n = Number(body.count);
        const whole = Number.isFinite(n) && Math.floor(n) === n;
        if (!whole || n < 1 || n > 50) {
          return sendJSON(res, 400, {
            code: 'E_BAD_COUNT',
            error: 'count must be a whole number from 1 to 50 (got ' + JSON.stringify(body.count) + ')'
          });
        }
      }
      // `atMs`: the console has had `ping <address> at <ms>` since convergence was modelled, and the engine has
      // honoured `opts.atMs` - but this endpoint dropped it, so "will this work in five seconds?" was answerable
      // from the console and from nowhere else (#1381). Validate the instant the way the rest of the API does.
      const pingOpts = {};
      if (body.count !== undefined && body.count !== null) pingOpts.count = Number(body.count);
      if (body.atMs !== undefined && body.atMs !== null) {
        const at = Number(body.atMs);
        if (!Number.isFinite(at) || at < 0) {
          return sendJSON(res, 400, {
            code: 'E_BAD_INSTANT',
            error: 'atMs must be a time in milliseconds, at or after 0 (got ' + JSON.stringify(body.atMs) + ')'
          });
        }
        pingOpts.atMs = at;
      }
      // The ping used `new Simulator(topo)` - a second accounting with its own flow state - so every packet it sent
      // was invisible to `/flows`, while the same ping typed into the console was counted. That is the defect
      // #1335 fixed for the console endpoint, one endpoint over (#1381).
      const sim = simForFlows(topo);
      const result = sim.ping(body.src, body.dst.trim(), pingOpts);
      // A name is resolved before a packet is sent, and the resolver's verdict is part of the answer: a client that
      // only sees `replies: [{ success: false }]` cannot tell a lost packet from a name that does not exist.
      return sendJSON(res, 200, {
        events: result.events, replies: result.replies, success: result.success, step: result.step,
        count: result.count, dns: result.dns || null,
        runAtMs: Number.isFinite(sim.runAtMs) ? sim.runAtMs : null,
        counters: flow.counterSnapshot(flowStateFor(topo), body.src),
        runtime: fullState(topo).runtime
      });
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
        // An empty body reached the engine as `srcDevice: undefined` and came back as "Unknown source device:
        // undefined" - a 400 that names nothing the caller can act on (#1309).
        const srcId = body && (body.srcDevice !== undefined ? body.srcDevice : body.src);
        const dstId = body && (body.dstDevice !== undefined ? body.dstDevice : body.dst);
        if (typeof srcId !== 'string' || !srcId || typeof dstId !== 'string' || !dstId) {
          return sendJSON(res, 400, {
            code: 'E_BAD_REQUEST',
            error: 'expected { proto, srcDevice, dstDevice, srcPort, dstPort, bytes } - ' +
              (body ? 'missing ' + (typeof srcId !== 'string' || !srcId ? 'srcDevice' : 'dstDevice') : 'no body')
          });
        }
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
      const positions = body && body.positions;
      // This door kept its own copy of the rule - not `{ x, y }`, two *finite* numbers - while the engine asked
      // `isPosition()`, so the two could answer differently and did: `1e308` passed both, and a board holding it
      // opened blank with `translate(-Infinity)` and could not be framed back (#1421). It now asks the engine.
      if (!positions || typeof positions !== 'object' || Array.isArray(positions)) {
        return sendJSON(res, 400, {
          code: 'E_BAD_REQUEST',
          error: 'positions must be a map of device id to { x, y } - got ' +
            (positions === undefined ? 'nothing' : Array.isArray(positions) ? 'an array' : typeof positions)
        });
      }
      // Every position is checked before any is stored, so a bad entry cannot half-apply a layout. The canvas
      // draws `pos.x` directly: a string put the box at NaN and nothing said why (#1325).
      const bad = [];
      const ignored = [];
      for (const id of Object.keys(positions)) {
        if (!topo.devices.has(id)) { ignored.push(id); continue; }
        if (!isPosition(positions[id])) bad.push(id + ': ' + JSON.stringify(positions[id]) + ' is ' + positionProblem(positions[id]));
      }
      if (bad.length) {
        return sendJSON(res, 400, {
          code: 'E_BAD_POSITION',
          error: 'a position must be { x, y } with two numbers within ' + WORLD_LIMIT + ' of the origin - ' +
            bad.slice(0, 3).join('; ')
        });
      }
      for (const id of Object.keys(positions)) {
        if (topo.devices.has(id)) topo.layout[id] = { x: positions[id].x, y: positions[id].y };
      }
      broadcast(topoId);
      // An id that is not on the board is not an error - a client may be a moment behind a delete - but it is the
      // sort of thing a person would want to know, so it is reported instead of dropped in silence.
      return sendJSON(res, 200, { ok: true, ignored: ignored });
    }

    // /load  (import a full topology document)
    if (parts[3] === 'load' && parts.length === 4 && method === 'POST') {
      const body = await readBody(req);
      // `Topology.fromJSON()` is deliberately tolerant - it reads files this server wrote, including old ones,
      // and skips links whose ports are gone. But /load does not read a file, it **replaces the live board**, and
      // it used to do that with whatever it was handed: `{"format":"x"}` was accepted as an empty lab, reported
      // `ok: true`, and threw the operator's work away (#1309). So the shape is checked first, and a document
      // that is not a topology changes nothing at all.
      const docProblem = documentShapeProblem(body);
      if (docProblem) {
        return sendJSON(res, 400, { code: 'E_BAD_DOCUMENT', error: docProblem });
      }
      const newTopo = Topology.fromJSON(body);
      topologies.set(topoId, newTopo);
      for (const key of Array.from(sessions.keys())) if (key.indexOf(topoId + ':') === 0) sessions.delete(key);
      broadcast(topoId);
      // A document is loaded, not refused: an imported lab has to be fixable in place. But the operator is told
      // straight away what the engine makes of it, instead of finding out by clicking every cable in turn.
      const state = fullState(newTopo);
      return sendJSON(res, 200, { ok: true, state: state, verdicts: state.verdicts });
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
  serveStatic(req, res, urlPath);
});

server.on('upgrade', function (req, socket) {
  try {
    const client = wss.handleUpgrade(req, socket);
    if (client) {
      // Every message gets an answer. Until this, a `subscribe` naming a topology that does not exist was a silent
      // no-op: the client waited for a board that was never coming and could not tell that from an empty one, and a
      // message of an unknown type vanished the same way (#1313).
      client.onMessage = function (msg) {
        let m;
        try {
          m = JSON.parse(msg);
        } catch (e) {
          return wss.send(client, { type: 'error', code: 'E_BAD_MESSAGE', error: 'expected a JSON object' });
        }
        if (!m || typeof m !== 'object' || typeof m.type !== 'string') {
          return wss.send(client, { type: 'error', code: 'E_BAD_MESSAGE', error: 'expected { type: "subscribe", topologyId }' });
        }
        if (m.type === 'subscribe') {
          if (!topologies.has(m.topologyId)) {
            return wss.send(client, {
              type: 'error', code: 'E_NO_TOPOLOGY', topologyId: m.topologyId,
              error: 'no topology called ' + JSON.stringify(m.topologyId)
            });
          }
          return wss.send(client, { type: 'topology', topologyId: m.topologyId, state: fullState(topologies.get(m.topologyId)) });
        }
        return wss.send(client, {
          type: 'error', code: 'E_UNKNOWN_TYPE', error: 'unknown message type ' + JSON.stringify(m.type) +
            '; the only one is "subscribe"'
        });
      };
      // The board it is looking at, so a fresh tab draws something without asking.
      if (topologies.has('default')) {
        wss.send(client, { type: 'topology', topologyId: 'default', state: fullState(topologies.get('default')) });
      }
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

// Without this, a port that is already taken prints a raw EADDRINUSE stack trace and
// exits. That is the single most common reason PacketForge will not start, and the
// stack trace never mentions the obvious remedy - nor that the web UI, and with it
// the "Report a bug" button, is exactly what is missing.
server.on('error', function (err) {
  for (const line of formatStartupError(err, PORT)) console.error(line);
  process.exit(1);
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
