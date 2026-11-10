'use strict';
// One question - "is this a ping destination?" - asked in three places, answered three ways (#1377).
//
//   engine/cli.js  `ping`         refused anything that was not an address, and accepted 10.0.0.999 because
//                                 `net.isIp()` only checks the shape (three dots, one to three digits)
//   server         POST /ping     passed the string straight to the engine, so 10.0.0.999 threw and came back as a
//                                 500 - a mistyped octet presented as a server fault
//   web/app.js     ping dialog    `/^(\d{1,3}\.){3}\d{1,3}$/`, so it accepted 10.0.0.999 and refused every name
//
// After #1376 the console resolves a name through the lab's DNS; this file checks that the other two surfaces ask
// the same question, and that a name which does not resolve is reported as a resolver verdict rather than as 0%
// packet loss.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const vm = require('vm');
const { spawn } = require('child_process');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const ROOT = path.join(__dirname, '..');

// --- the browser module, loaded the way the page loads it -------------------------------
function fakeNode() {
  const base = {
    innerHTML: '', textContent: '', value: '', style: {}, dataset: {},
    classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    addEventListener: function () {}, removeEventListener: function () {},
    appendChild: function () { return fakeNode(); }, append: function () {},
    setAttribute: function () {}, getAttribute: function () { return null; },
    removeAttribute: function () {}, remove: function () {}, focus: function () {}, click: function () {},
    querySelector: function () { return fakeNode(); }, querySelectorAll: function () { return []; },
    closest: function () { return null; }
  };
  return new Proxy(base, {
    get: function (t, k) { return k in t ? t[k] : function () { return fakeNode(); }; },
    set: function (t, k, v) { t[k] = v; return true; }
  });
}
const wrap = {
  _html: '', get innerHTML() { return this._html; }, set innerHTML(v) { this._html = v; },
  addEventListener: function () {}, style: {},
  classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
  querySelector: function () { return fakeNode(); }, querySelectorAll: function () { return []; },
  setAttribute: function () {}, getAttribute: function () { return null; }
};
const ctx = {
  console: console, setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval,
  fetch: function () { return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); } }); },
  document: { addEventListener: function () {}, querySelector: function () { return wrap; }, querySelectorAll: function () { return []; } },
  window: {},
  PFCanvas: { on: {}, setTopology: function () {}, fitView: function () {}, render: function () {}, setSelected: function () {}, setSelectedLink: function () {}, animateEvents: function () {}, zoomBy: function () {} }
};
ctx.window.PFCanvas = ctx.PFCanvas;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8'), ctx, { filename: 'web/app.js' });
const pf = ctx.window.__pf || {};
// If the helper is not exported at all (a reverted web/app.js), every check that needs it fails with a message
// rather than throwing - a crash tells you nothing about how many behaviours are gone.
const uiProblem = function (v) {
  if (typeof pf.pingTargetProblem !== 'function') return 'pingTargetProblem is not exported';
  return pf.pingTargetProblem(v);
};

// --- the console's rule, asked directly ------------------------------------------------
const { Topology } = require('../engine');
const cliModule = require('../engine/cli');
const CliSession = cliModule.CliSession || cliModule;
const specs = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
const ROUTER = specs.find(function (s) { return /^ISR 4331$/.test(s.model); });

function consoleAccepts(target) {
  const t = new Topology();
  t.addDevice(ROUTER, 'r1');
  const s = new CliSession(t.getDevice('r1'), t, null);
  const out = ((s.run('ping ' + target) || {}).output || []).join('\n');
  // The console refuses a *target* when it says the target is invalid or cannot be resolved; those are the two
  // answers under test here. Anything else means the target was accepted and the engine was asked.
  return !/% Invalid ping target|% Could not resolve/.test(out);
}

console.log('');
console.log('The dialog and the console ask the same question:');
{
  const candidates = ['10.0.0.1', '192.168.1.20', '10.0.0.999', '10.0.0', '1.2.3.4.5', '0.0.0.0', '255.255.255.255',
    'r1.lab', 'server.example.com', 'a', '10.0.0.1 ', 'nope', '256.1.1.1', '01.2.3.4'];
  let agree = 0;
  const disagreements = [];
  for (const c of candidates) {
    const ui = uiProblem(c);
    const uiOk = ui === null;
    const consoleOk = consoleAccepts(c.trim());
    // The console accepts a *syntactically valid* name and then reports whether it resolved; the dialog only
    // decides whether it is a destination at all. So the shapes must agree, and a name is a destination in both.
    const nameLike = /[a-z]/i.test(c) && !/\s/.test(c.trim());
    const equivalent = uiOk === consoleOk || (nameLike && uiOk);
    if (equivalent) agree++; else disagreements.push(c + ': ui=' + uiOk + ' console=' + consoleOk);
  }
  ok(agree === candidates.length, 'both surfaces accept and refuse the same strings',
    disagreements.join(' | '));

  // And the ones that matter, named one at a time.
  ok(uiProblem('10.0.0.999') !== null, 'the dialog refuses 10.0.0.999');
  ok(/four octets/.test(String(uiProblem('10.0.0.999'))), 'and says what an address looks like',
    uiProblem('10.0.0.999'));
  ok(uiProblem('r1.lab') === null, 'the dialog accepts a hostname');
  ok(uiProblem('') !== null, 'an empty target is refused');
  ok(uiProblem('a b') !== null, 'a target with a space is refused');
}

(async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-ping-'));
  const port = await new Promise(function (resolve, reject) {
    const p = net.createServer();
    p.unref(); p.on('error', reject);
    p.listen(0, '127.0.0.1', function () { const n = p.address().port; p.close(function () { resolve(n); }); });
  });
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: Object.assign({}, process.env, { PORT: String(port), PF_DATA: dataDir }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const request = function (method, p, body) {
    return new Promise(function (resolve, reject) {
      const payload = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
      const req = http.request({ host: '127.0.0.1', port: port, path: p, method: method,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} },
        function (res) {
          let d = '';
          res.on('data', function (c) { d += c; });
          res.on('end', function () { let j = d; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, body: j }); });
        });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  };

  try {
    // Wait for the server to answer at all.
    for (let i = 0; i < 60; i++) {
      try { await request('GET', '/api/topologies'); break; } catch (e) { await new Promise(function (r) { setTimeout(r, 100); }); }
    }

    // A lab with a DNS zone, so a name has something to resolve against.
    const catalog = specs;
    const HOST = catalog.find(function (s) { return /Raspberry Pi 5/.test(s.model); }) ||
      catalog.find(function (s) { return /^(pc|host)/i.test(s.category || ''); });
    const dev = await request('POST', '/api/topologies/default/devices', { vendor: ROUTER.vendor, model: ROUTER.model });
    const devId = dev.body && dev.body.device && dev.body.device.id;
    const host = await request('POST', '/api/topologies/default/devices', { vendor: HOST.vendor, model: HOST.model });
    const hostId = host.body && host.body.device && host.body.device.id;
    ok(!!devId && !!hostId, 'two devices to ping from (' + devId + ', ' + hostId + ')');

    console.log('');
    console.log('POST /ping refuses a bad destination with a 400 that names the rule:');
    const bad = await request('POST', '/api/topologies/default/ping', { src: devId, dst: '10.0.0.999' });
    ok(bad.status === 400, 'a mistyped octet is a 400, not a 500', String(bad.status) + ' ' + JSON.stringify(bad.body));
    ok(/E_BAD_DESTINATION/.test(JSON.stringify(bad.body)), 'with a code a client can branch on');
    ok(/not an IPv4 address/.test(JSON.stringify(bad.body)), 'and a message that says what is wrong');
    const empty = await request('POST', '/api/topologies/default/ping', { src: devId, dst: '' });
    ok(empty.status === 400, 'an empty destination is a 400', String(empty.status));
    const spaced = await request('POST', '/api/topologies/default/ping', { src: devId, dst: 'a b' });
    ok(spaced.status === 400, 'a destination with a space is a 400', String(spaced.status));
    const noSrc = await request('POST', '/api/topologies/default/ping', { dst: '10.0.0.1' });
    ok(noSrc.status === 400, 'a missing source is still a 400', String(noSrc.status));

    console.log('');
    console.log('A name goes through the resolver, and the answer says so:');
    const named = await request('POST', '/api/topologies/default/ping', { src: hostId, dst: 'server.lab' });
    ok(named.status === 200, 'a hostname is accepted', String(named.status));
    ok(named.body && named.body.dns, 'the response carries the resolver verdict', JSON.stringify(named.body && named.body.dns));
    const dnsBody = (named.body && named.body.dns) || null;
    ok(!!dnsBody && dnsBody.ok === false, 'and a name with no zone is a failed resolution, not a crash',
      JSON.stringify(dnsBody));
    ok(/NXDOMAIN|SERVFAIL|NODATA/.test(String(dnsBody && dnsBody.status)),
      'naming the status the resolver reported', String(dnsBody && dnsBody.status));
    const replies = (named.body && named.body.replies) || [];
    ok(replies.length === 1 && replies[0].success === false,
      'with no packet sent - one reply object, and it failed', JSON.stringify(replies));
    ok(/dns-/.test(String(replies[0] && replies[0].reason)),
      'and the reason says DNS, so a client does not report it as packet loss', String(replies[0] && replies[0].reason));

    const byIp = await request('POST', '/api/topologies/default/ping', { src: hostId, dst: '10.0.0.1' });
    ok(byIp.status === 200, 'an address still works');
    ok(byIp.body && byIp.body.dns === null, 'and reports no resolution', JSON.stringify(byIp.body && byIp.body.dns));
  } finally {
    child.kill();
  }

  console.log('');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})();
