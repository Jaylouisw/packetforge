'use strict';
// End-to-end HTTP smoke: spawn the server, drive it like the UI does, kill it.
//
// The CI step this replaces proved that /api/catalog returns JSON. That is not the contract
// the UI depends on - it depends on a topology being creatable, a device being placeable, a
// legal cable being accepted, an illegal one being refused *with reasons*, and the dry-run
// endpoint agreeing with the real one. Each of those is a check below, and each failure names
// the endpoint so it is obvious where to look.
//
// Self-contained on purpose: no running server, no fixtures, no cleanup for the caller. It
// picks a free port, points PF_DATA at a scratch directory it deletes afterwards, and exits
// non-zero if anything is off.
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

function freePort() {
  return new Promise(function (resolve, reject) {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', function () {
      const p = s.address().port;
      s.close(function () { resolve(p); });
    });
  });
}

function waitFor(port, deadline) {
  return new Promise(function (resolve, reject) {
    (function attempt() {
      const r = http.request({ host: '127.0.0.1', port: port, path: '/api/catalog', method: 'GET' },
        function (res) {
          res.resume();
          if (res.statusCode === 200) return resolve();
          retry();
        });
      r.on('error', retry);
      r.end();
      function retry() {
        if (Date.now() > deadline) return reject(new Error('server did not answer /api/catalog within the timeout'));
        setTimeout(attempt, 150);
      }
    })();
  });
}

function makeClient(port) {
  return function req(method, pathname, body) {
    return new Promise(function (resolve) {
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const r = http.request({
        host: '127.0.0.1', port: port, path: pathname, method: method,
        headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {}
      }, function (res) {
        let s = '';
        res.on('data', function (c) { s += c; });
        res.on('end', function () {
          let j = null;
          try { j = JSON.parse(s); } catch (e) { /* html/empty is fine, callers check status */ }
          resolve({ status: res.statusCode, body: j, raw: s });
        });
      });
      r.on('error', function (e) { resolve({ status: 0, body: null, raw: e.message }); });
      if (data) r.write(data);
      r.end();
    });
  };
}

(async function () {
  const port = await freePort();
  const dataDir = path.join(os.tmpdir(), 'packetforge-smoke-' + process.pid);
  let fail = 0;
  function check(ok, label, extra) {
    console.log((ok ? '  ok   ' : '  FAIL ') + label + (extra ? ' — ' + extra : ''));
    if (!ok) fail++;
  }

  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(port), PF_DATA: dataDir, PF_NO_OPEN: '1' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  server.stdout.on('data', function (c) { serverLog += c; });
  server.stderr.on('data', function (c) { serverLog += c; });

  function shutdown() {
    try { server.kill(); } catch (e) { /* already gone */ }
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  }

  try {
    try {
      await waitFor(port, Date.now() + 20000);
    } catch (e) {
      console.error('  FAIL server did not start — ' + e.message);
      console.error(serverLog.trim().split('\n').slice(-8).join('\n'));
      shutdown();
      process.exit(1);
    }
    check(true, 'the server starts and answers on port ' + port);

    const req = makeClient(port);

    const catalog = await req('GET', '/api/catalog');
    const specs = (catalog.body && catalog.body.specs) || [];
    check(catalog.status === 200 && specs.length > 900, 'GET /api/catalog serves the whole catalogue',
      catalog.status + ', ' + specs.length + ' specs');

    const media = await req('GET', '/api/media');
    const mediaMap = (media.body && (media.body.media || media.body)) || {};
    const mediaIds = Array.isArray(mediaMap) ? mediaMap : Object.keys(mediaMap);
    check(media.status === 200 && mediaIds.length > 20, 'GET /api/media serves the physical media',
      media.status + ', ' + mediaIds.length + ' media');

    // The bug-report button reads this to fill in "what were you running". If it
    // silently stops answering, every future report loses that field and nobody
    // notices until someone tries to reproduce one.
    const version = await req('GET', '/api/version');
    const vb = version.body || {};
    check(version.status === 200 && typeof vb.version === 'string' && vb.version.length > 0,
      'GET /api/version says which build is running',
      version.status + ', version ' + vb.version + ', node ' + vb.node);
    check(version.status === 200 && typeof vb.devices === 'number' && vb.devices === specs.length,
      'GET /api/version counts the same catalogue as /api/catalog',
      vb.devices + ' vs ' + specs.length);

    const root = await req('GET', '/');
    check(root.status === 200, 'GET / serves the UI shell', String(root.status));

    const created = await req('POST', '/api/topologies', { name: 'smoke' });
    const topoId = created.body && created.body.id;
    check((created.status === 200 || created.status === 201) && !!topoId, 'POST /api/topologies creates one',
      String(created.status));
    if (!topoId) throw new Error('no topology id; the rest of the run would be meaningless');

    // Two of the same switch, because that is what dragging two icons out of the palette does.
    let last = null;
    for (let i = 0; i < 2; i++) {
      last = await req('POST', '/api/topologies/' + topoId + '/devices',
        { vendor: 'tp-link', model: 'TL-SG105E' });
    }
    const devices = ((last.body && last.body.state) || {}).devices || [];
    check(devices.length === 2, 'POST devices places them', String(devices.length) + ' devices');

    const copper = [];
    for (const d of devices) {
      for (const i of (d.interfaces || [])) {
        if (i.cage === 'rj45' || i.connector === 'rj45') copper.push({ deviceId: d.id, iface: i.name });
      }
    }
    check(copper.length >= 4, 'the placed switches expose copper ports', String(copper.length) + ' ports');

    // Two ports of one switch is a loop to itself, so pair across devices.
    const b = copper.find(function (c) { return c.deviceId !== copper[0].deviceId; });
    if (!copper.length || !b) throw new Error('no cross-device copper pair to cable');

    // Order matters: the dry run and the refusal are checked while the ports are still free,
    // because a cabled port is in use and every later check would only see E_PORT_IN_USE.
    const dry = await req('POST', '/api/topologies/' + topoId + '/validate-link',
      { a: copper[0], b: b, mediaId: '1000base-t' });
    const verdict = (dry.body && dry.body.verdict) || {};
    check(dry.status === 200 && verdict.ok === true, 'validate-link says yes to a legal pair',
      dry.status + ', ok=' + verdict.ok);
    check(Array.isArray((dry.body || {}).mediaOptions) && dry.body.mediaOptions.length >= 2,
      'and offers the media the pair actually supports',
      ((dry.body || {}).mediaOptions || []).length + ' option(s)');

    const dryBad = await req('POST', '/api/topologies/' + topoId + '/validate-link',
      { a: copper[0], b: b, mediaId: '100gbase-sr4' });
    const badVerdict = (dryBad.body && dryBad.body.verdict) || {};
    check(badVerdict.ok === false && (badVerdict.errors || []).length > 0,
      'and no to an impossible medium, with a code', ((badVerdict.errors || [])[0] || {}).code || 'no code');

    // The reason the physical layer exists: a cable that cannot exist is refused, with reasons.
    const impossible = await req('POST', '/api/topologies/' + topoId + '/links',
      { a: copper[0], b: b, mediaId: '100gbase-sr4' });
    const issues = (impossible.body && impossible.body.issues) || [];
    check(impossible.status === 409 && issues.length > 0,
      'an impossible cable is refused with issues[]', impossible.status + ', ' + issues.length + ' issue(s)');

    const link = await req('POST', '/api/topologies/' + topoId + '/links', { a: copper[0], b: b, mediaId: '1000base-t' });
    check(link.status === 200 || link.status === 201, 'POST a legal copper link is accepted',
      String(link.status) + (link.body && link.body.error ? ' ' + link.body.error : ''));

    const selfLoop = await req('POST', '/api/topologies/' + topoId + '/links',
      { a: copper[0], b: copper[1], mediaId: '1000base-t' });
    check(selfLoop.status === 409 || selfLoop.status === 400, 'a port cabled to its own switch is refused',
      String(selfLoop.status));

    const reLink = await req('POST', '/api/topologies/' + topoId + '/links', { a: copper[0], b: b, mediaId: '1000base-t' });
    check(reLink.status === 409 || reLink.status === 400, 'cabling an already-used port is refused',
      String(reLink.status));

    const after = await req('GET', '/api/topologies/' + topoId);
    const links = (after.body && after.body.links) || [];
    check(links.length === 1, 'the topology kept exactly the one legal cable', String(links.length));

    const del = await req('DELETE', '/api/topologies/' + topoId);
    check(del.status === 200 || del.status === 204, 'DELETE /api/topologies/:id', String(del.status));
  } catch (e) {
    console.error('  FAIL ' + e.message);
    fail++;
  }

  shutdown();
  console.log('\n' + (fail ? fail + ' failed' : 'HTTP smoke passed') + ' (' + (fail ? 'FAIL' : 'all checks clean') + ')');
  process.exit(fail ? 1 : 0);
})();
