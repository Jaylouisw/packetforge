'use strict';
// A cable's verdict has to come from the engine, not from the panel's opinion (#1303).
//
// The cable inspector printed, for every cable, unconditionally:
//
//   "Cages mate and the media is supported at both ends — this cable passed the physical-layer check when it
//    was created. An impossible combination is refused at that moment, not silently accepted."
//
// Nothing computed that. It was a sentence in the renderer. And there is a path that produces a cable nobody
// ever checked: `POST /topologies/:id/load` swaps a whole document in with no validation at all. A hand-edited or
// pre-rule document therefore carried an impossible cable through the entire UI wearing the same confident
// sentence as a good one - while `validateTopology()` had the exact answer available and no runtime caller.
//
// So: the server annotates state with one verdict per cable, the panel prints that verdict, and a load reports
// what it took in. This file checks both ends, over real HTTP for the server half.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const vm = require('vm');
const { spawn } = require('child_process');
const { Topology } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const ROOT = path.join(__dirname, '..');
const catalog = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
const COPPER_SW = catalog.find(function (s) { return /CX 6000/.test(s.model); });

// --- the panel, loaded the way the page loads it -------------------------------------------------------------
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
  document: {
    addEventListener: function () {},
    querySelector: function () { return wrap; },
    querySelectorAll: function () { return []; }
  },
  window: {},
  PFCanvas: { on: {}, setTopology: function () {}, fitView: function () {}, render: function () {},
    setSelected: function () {}, setSelectedLink: function () {}, animateEvents: function () {}, zoomBy: function () {} }
};
ctx.window.PFCanvas = ctx.PFCanvas;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'web', 'faceplate.js'), 'utf8'), ctx, { filename: 'web/faceplate.js' });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8'), ctx, { filename: 'web/app.js' });
const pf = ctx.window.__pf;

// --- HTTP ---------------------------------------------------------------------------------------------------
const net2 = net;
function freePort() {
  return new Promise(function (resolve, reject) {
    const probe = net2.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', function () {
      const port = probe.address().port;
      probe.close(function () { resolve(port); });
    });
  });
}
let PORT = 0;
function request(method, urlPath, body) {
  return new Promise(function (resolve, reject) {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: urlPath, method: method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}
    }, function (res) {
      let data = '';
      res.on('data', function (c) { data += c; });
      res.on('end', function () {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (e) { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
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

// A good document, and the same document with the cable's media changed to one these ports cannot take.
function docs() {
  const t = new Topology();
  const a = t.addDevice(COPPER_SW, 'a'); a.name = 'SW1';
  const b = t.addDevice(COPPER_SW, 'b'); b.name = 'SW2';
  t.connect(a.id, '1/1/1', b.id, '1/1/1');
  const good = JSON.parse(JSON.stringify(t.serialize()));
  const bad = JSON.parse(JSON.stringify(good));
  bad.links[0].mediaId = '10gbase-sr';
  const longRun = JSON.parse(JSON.stringify(good));
  longRun.links[0].lengthM = 5000;      // 1000BASE-T reaches 100 m
  return { good: good, bad: bad, longRun: longRun };
}

(async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-verdicts-'));
  PORT = await freePort();
  const srv = await startServer(dataDir);
  let goodState = null, badLoad = null, longState = null;

  console.log('');
  console.log('The server sends a verdict per cable, and reports one on load:');
  try {
    const made = await request('GET', '/api/topologies/default');
    ok(made.status === 200, 'the server answers (' + made.status + ')');
    ok(made.body.verdicts && made.body.verdicts.checked === true,
      'even an empty board carries a verdict object that says it was checked',
      JSON.stringify(made.body.verdicts));

    const d = docs();
    const loadGood = await request('POST', '/api/topologies/default/load', d.good);
    ok(loadGood.status === 200 && loadGood.body.verdicts && loadGood.body.verdicts.errorCount === 0,
      'a good document loads with no errors', JSON.stringify(loadGood.body.verdicts && loadGood.body.verdicts.errorCount));
    goodState = loadGood.body.state;

    const loadBad = await request('POST', '/api/topologies/default/load', d.bad);
    badLoad = loadBad.body;
    ok(loadBad.status === 200, 'an impossible cable does not stop the document loading - it has to be fixable ' +
      'in place (' + loadBad.status + ')');
    const v = loadBad.body.verdicts || {};
    ok(v.errorCount === 1, 'but the load response says one cable is wrong', JSON.stringify(v.errorCount));
    ok((v.issues || []).some(function (i) { return i.code === 'E_MEDIA_NOT_SUPPORTED'; }),
      'naming the code', JSON.stringify((v.issues || []).map(function (i) { return i.code; })));

    const fetched = await request('GET', '/api/topologies/default');
    const sv = fetched.body.verdicts || {};
    ok(sv.errorCount === 1, 'and the state anyone reads afterwards agrees', JSON.stringify(sv.errorCount));
    ok(sv.byLink && Object.keys(sv.byLink).length === 1, 'the issue is filed against the cable that caused it',
      JSON.stringify(Object.keys(sv.byLink || {})));

    const loadLong = await request('POST', '/api/topologies/default/load', d.longRun);
    longState = loadLong.body.state;
    const lv = loadLong.body.verdicts || {};
    ok(lv.errorCount + lv.warningCount >= 1, 'a 5 km copper run is flagged too, at load time',
      JSON.stringify({ err: lv.errorCount, warn: lv.warningCount, codes: (lv.issues || []).map(function (i) { return i.code; }) }));
  } finally {
    await stop(srv.child);
  }

  console.log('');
  console.log('The panel prints the engine\'s verdict instead of asserting one:');
  {
    const link = goodState.links[0];
    pf.setTopology(goodState);
    pf.selectLink(link.id);
    pf.renderDeviceTab();
    const html = wrap._html;
    ok(!/this cable passed the physical-layer check when it was created/.test(html),
      'the unconditional claim is gone', /verdict[^>]*>([^<]{0,120})/.exec(html));
    ok(/checked by the engine/.test(html), 'a good cable says who checked it', /verdict[^>]*>([^<]{0,160})/.exec(html));
    ok(!/verdict bad/.test(html), 'and is not painted as a fault', /verdict[^>]*>/.exec(html));

    pf.setTopology(badLoad.state);
    pf.selectLink(badLoad.state.links[0].id);
    pf.renderDeviceTab();
    const badHtml = wrap._html;
    ok(/verdict bad/.test(badHtml), 'an impossible cable is painted as a fault');
    ok(/10GBASE-SR/.test(badHtml), 'with the engine\'s own message, naming the media', /verdict[^>]*>([\s\S]{0,240})/.exec(badHtml));
    ok(!/Cages mate and the media is supported/.test(badHtml),
      'and not one word of the reassuring sentence', /verdict[^>]*>([\s\S]{0,240})/.exec(badHtml));

    pf.setTopology(longState);
    pf.selectLink(longState.links[0].id);
    pf.renderDeviceTab();
    ok(/verdict bad/.test(wrap._html) || /reach/i.test(wrap._html),
      'an over-length run is reported on the cable too', /verdict[^>]*>([\s\S]{0,240})/.exec(wrap._html));
  }

  console.log('');
  console.log('A payload with no verdict at all is not read as a pass:');
  {
    const d = docs();
    const bare = JSON.parse(JSON.stringify(d.good));
    delete bare.verdicts;
    pf.setTopology(bare);
    pf.selectLink(bare.links[0].id);
    pf.renderDeviceTab();
    const html = wrap._html;
    ok(/has not been checked/.test(html), 'the panel says the cable was not checked',
      /verdict[^>]*>([\s\S]{0,160})/.exec(html));
    ok(!/Cages mate/.test(html), 'and does not print the reassuring sentence');
    // The helper itself, for a caller that wants the verdict without the sentence.
    const v = pf.linkVerdict(bare.links[0].id);
    ok(v.checked === false && v.issues.length === 0, 'linkVerdict() reports that it could not check',
      JSON.stringify(v));
  }

  console.log('');
  console.log('A lab-level issue is not lost when a cable is selected:');
  {
    // An issue with no linkId is about the whole lab (a cable whose ends no longer exist, say). Filtering by
    // link must not hide it, or the panel would report a clean cable inside a broken lab.
    const d = docs();
    const state = JSON.parse(JSON.stringify(d.good));
    state.verdicts = {
      ok: false, errorCount: 1, warningCount: 0, checked: true,
      byLink: {},
      issues: [{ severity: 'error', code: 'E_LAB', message: 'The lab has a cable with a missing end.' }]
    };
    pf.setTopology(state);
    const v = pf.linkVerdict(state.links[0].id);
    ok(v.issues.length === 1 && v.issues[0].code === 'E_LAB', 'a lab-level issue reaches the selected cable',
      JSON.stringify(v));
  }

  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
