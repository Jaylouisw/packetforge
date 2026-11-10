'use strict';
// How many echoes may one ping ask for? Three surfaces, three answers (#1379).
//
//   engine/simulator.js `ping()`   took `count` as a loop bound and `opts.count || 4`, so 1e9 echoes meant hours of
//                                  engine time and a response nobody can hold, `count: -5` produced *zero* replies,
//                                  and `count: 'abc'` produced an empty answer that looks like a dead network
//   server            POST /ping   passed the number straight through, so all of the above was one unauthenticated
//                                  request away
//   web/app.js        dialog       `parseInt(...) || 4` - the input has min/max attributes, but a typed value is not
//                                  clamped, so 9999 was sent and 9999 replies drawn
//
// One rule: a whole number from 1 to 50. The engine bounds itself and says what it did, the API refuses with the
// rule, the console names it, and the dialog checks it before sending anything.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const vm = require('vm');
const { spawn } = require('child_process');
const { Topology, Simulator } = require('../engine');
const { loadCatalog } = require('../devices/registry');
const cliModule = require('../engine/cli');
const CliSession = cliModule.CliSession || cliModule;

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const ROOT = path.join(__dirname, '..');
const specs = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
const ROUTER = specs.find(function (s) { return /^ISR 4331$/.test(s.model); });

function lab() {
  const t = new Topology();
  t.addDevice(ROUTER, 'r1');
  const i = t.getDevice('r1').interfaces.get('Gi0/0/1');
  i.ip = '10.0.0.1'; i.mask = '255.255.255.0';
  return t;
}
function pingWith(count) {
  const t = lab();
  const sim = new Simulator(t);
  return sim.ping('r1', '10.0.0.1', count === 'ABSENT' ? {} : { count: count });
}

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
const countProblem = function (v) {
  if (typeof pf.pingCountProblem !== 'function') return 'pingCountProblem is not exported';
  return pf.pingCountProblem(v);
};
// The console's answer for the same value: refused, or accepted.
function consoleRefuses(value) {
  const t = lab();
  const s = new CliSession(t.getDevice('r1'), t, new Simulator(t));
  const out = ((s.run('ping 10.0.0.1 ' + value) || {}).output || []).join('\n');
  // A refusal is a line that starts with `%` and one of the parser's own sentences. (`% Still converging` is a
  // note attached to a ping that ran, so it must not count.)
  return /^% (Count must|Unrecognized|Invalid instant|Invalid ping target|Could not resolve)/m.test(out);
}

console.log('');
console.log('The engine bounds itself, and says what it did:');
{
  const normal = pingWith(3);
  ok(normal.replies.length === 3, 'a count in range is sent as asked', String(normal.replies.length));
  ok(normal.count === 3 && normal.requestedCount === 3, 'and reported back', JSON.stringify([normal.count, normal.requestedCount]));

  const absent = pingWith('ABSENT');
  ok(absent.replies.length === 4, 'no count is four', String(absent.replies.length));
  ok(absent.requestedCount === null, 'and nothing is claimed to have been asked for');

  const huge = pingWith(1000000000);
  ok(huge.replies.length === 50, 'a billion is sent as fifty, not as a billion', String(huge.replies.length));
  ok(huge.count === 50 && huge.requestedCount === 1000000000,
    'and the answer says both numbers, so the clamp is visible', JSON.stringify([huge.count, huge.requestedCount]));
  ok(huge.replies.length === huge.count, 'the reply list is exactly as long as the count it reports');

  // Values that are not a count at all fall back to the default instead of producing an empty, healthy-looking list.
  for (const bad of [0, -5, 'abc', null, '']) {
    const r = pingWith(bad);
    ok(r.replies.length === 4, 'count ' + JSON.stringify(bad) + ' falls back to four replies',
      String(r.replies.length));
  }
  const frac = pingWith(1.9);
  ok(frac.replies.length === 1, 'a fractional count is floored, not rounded up', String(frac.replies.length));
}

console.log('');
console.log('The console names the rule:');
{
  ok(!consoleRefuses('3'), 'a count in range is accepted');
  ok(consoleRefuses('51'), '51 is refused');
  ok(consoleRefuses('0'), '0 is refused');
  ok(consoleRefuses('999999'), 'a huge count is refused, not quietly clamped');
  const t = lab();
  const s = new CliSession(t.getDevice('r1'), t, new Simulator(t));
  const text = ((s.run('ping 10.0.0.1 51') || {}).output || []).join('\n');
  ok(/from 1 to 50/.test(text), 'and the refusal states the range', text);
  ok(/asked for 51/.test(text), 'and what was asked for');
  const stray = ((s.run('ping 10.0.0.1 abc') || {}).output || []).join('\n');
  ok(/Unrecognized "abc"/.test(stray), 'a stray word is refused rather than ignored', stray);
  ok(/ping <address\|name>/.test(stray), 'and the usage is printed with it');
  const atBad = ((s.run('ping 10.0.0.1 5 at later') || {}).output || []).join('\n');
  ok(/Invalid instant: later/.test(atBad), 'an instant that is not a number is refused', atBad);
  const atMissing = ((s.run('ping 10.0.0.1 5 at') || {}).output || []).join('\n');
  ok(/needs a time in milliseconds/.test(atMissing), 'and so is a bare "at"', atMissing);
  // `at` still works: it is not a count, and must not be read as one.
  const atOut = ((s.run('ping 10.0.0.1 5 at 20000') || {}).output || []).join('\n');
  ok(/to 10\.0\.0\.1/.test(atOut), 'ping ... at <ms> still parses', atOut.split('\n')[0]);
  ok(/t=20000 ms/.test(atOut), 'and asks the question at the instant named');
}

console.log('');
console.log('The dialog and the console refuse the same values:');
{
  const values = ['1', '4', '50', '51', '0', '0.5', '1.5', 'abc', '', ' 7 ', '007', '1000000'];
  const disagreements = [];
  for (const v of values) {
    const ui = countProblem(v);
    const uiRefuses = ui !== null;
    // An empty field means "use the default" in the dialog, and an empty token cannot be typed into the console
    // command at all, so that one case is compared separately below.
    if (v === '') continue;
    const conRefuses = consoleRefuses(v.trim());
    if (uiRefuses !== conRefuses) disagreements.push(v + ': ui=' + uiRefuses + ' console=' + conRefuses);
  }
  ok(disagreements.length === 0, 'both refuse and accept the same counts', disagreements.join(' | '));
  ok(countProblem('') !== null, 'an empty count is refused by the dialog (it never sends a default it did not check)');
  ok(/1 to 50/.test(String(countProblem('51'))), 'and the message names the range', String(countProblem('51')));
  ok(countProblem('7') === null, 'a valid count passes');
}

(async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-pingcount-'));
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
    for (let i = 0; i < 60; i++) {
      try { await request('GET', '/api/topologies'); break; } catch (e) { await new Promise(function (r) { setTimeout(r, 100); }); }
    }
    const dev = await request('POST', '/api/topologies/default/devices', { vendor: ROUTER.vendor, model: ROUTER.model });
    const devId = dev.body && dev.body.device && dev.body.device.id;
    ok(!!devId, 'a device to ping from (' + devId + ')');

    console.log('');
    console.log('POST /ping refuses a count outside the rule, with the rule:');
    for (const bad of [51, 0, -1, 1.5, 'abc']) {
      const r = await request('POST', '/api/topologies/default/ping', { src: devId, dst: '10.0.0.1', count: bad });
      const good = r.status === 400 && /E_BAD_COUNT/.test(JSON.stringify(r.body)) && /1 to 50/.test(JSON.stringify(r.body));
      ok(good, 'count ' + JSON.stringify(bad) + ' is a 400 naming the range', String(r.status) + ' ' + JSON.stringify(r.body));
    }
    const nulled = await request('POST', '/api/topologies/default/ping', { src: devId, dst: '10.0.0.1', count: null });
    ok(nulled.status === 200 && nulled.body.replies.length === 4,
      'an explicit null is treated as no count at all, not as an error',
      String(nulled.status) + ' ' + JSON.stringify(nulled.body && nulled.body.replies && nulled.body.replies.length));
    const fifty = await request('POST', '/api/topologies/default/ping', { src: devId, dst: '10.0.0.1', count: 50 });
    ok(fifty.status === 200, '50 is accepted', String(fifty.status));
    ok(fifty.body.replies.length === 50 && fifty.body.count === 50,
      'and 50 replies come back, with the count reported', JSON.stringify([fifty.body.replies.length, fifty.body.count]));
    const absent = await request('POST', '/api/topologies/default/ping', { src: devId, dst: '10.0.0.1' });
    ok(absent.body.replies.length === 4 && absent.body.count === 4,
      'no count means four, and the answer says four',
      JSON.stringify([absent.body.replies.length, absent.body.count]));
  } finally {
    child.kill();
  }

  console.log('');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})();
