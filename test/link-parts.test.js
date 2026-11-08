'use strict';
// A cable has to be able to tell you what it is (issue #34 follow-up, and issue #38).
//
// Two gaps, both about the UI refusing to answer a question it had the data for:
//
//   1. The link inspector stopped at the mediaId. "10gbase-lr" is a standard, not a part:
//      it does not tell you the reach, the ferrule or what you would actually order. The
//      catalogue (catalogue/optics/transceivers.json) knows SFP-10G-LR reaches 10 km over
//      LC/UPC at 1310 nm, and the inspector now says so - and says plainly when there is
//      no part at all, instead of rendering an empty box (or "undefined").
//   2. The canvas draws nine cable families in nine colours and nothing explained them.
//      The palette now carries a collapsible legend whose rows use the same family class
//      the canvas puts on the cable (link-copper, link-pon, ...), and it remembers being
//      collapsed in localStorage.
//
// Then issue #38: POST /config/ (the hostname form) answered without a `state` field, so
// `topo = r.state` stored undefined and the renderer was handed nothing to draw. The
// canvas went blank, nothing threw, and a reload brought the board back. Both halves are
// checked here: the client keeps the topology it already had, and the endpoint now
// returns the same `state:` envelope as every other mutating route.
//
// Loads the real web/app.js in the stub DOM the other UI tests use, and talks to a real
// server on a scratch port for the endpoint half.
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const { Topology } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const WEB = path.join(__dirname, '..', 'web');
const APP_JS = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
const CANVAS_JS = fs.readFileSync(path.join(WEB, 'canvas.js'), 'utf8');
const STYLE_CSS = fs.readFileSync(path.join(WEB, 'style.css'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
const PARTS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'catalogue', 'optics', 'transceivers.json'), 'utf8'));

// --- a stub DOM that can be driven, not just survived -----------------------------
// The other UI tests use a permissive proxy because they only read back innerHTML.
// This suite has to fire events (a hostname edit, a legend toggle) and check what was
// remembered, so elements are real little objects with listeners and classes.
function makeEl(name) {
  const el = {
    __name: name, _html: '', textContent: '', value: '', style: {}, dataset: {},
    attrs: {}, listeners: {}, classes: {}, _children: {},
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); },
    addEventListener: function (type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn); },
    removeEventListener: function () {},
    appendChild: function (c) { return c; },
    append: function () {},
    setAttribute: function (k, v) { el.attrs[k] = String(v); },
    getAttribute: function (k) { return el.attrs[k] === undefined ? null : el.attrs[k]; },
    removeAttribute: function (k) { delete el.attrs[k]; },
    remove: function () {}, focus: function () {}, click: function () {},
    classList: {
      add: function (c) { el.classes[c] = true; },
      remove: function (c) { delete el.classes[c]; },
      toggle: function (c, on) {
        if (on === undefined) { if (el.classes[c]) delete el.classes[c]; else el.classes[c] = true; }
        else if (on) el.classes[c] = true; else delete el.classes[c];
      },
      contains: function (c) { return !!el.classes[c]; }
    },
    // Children are cached by selector so a handler bound during a render can be fired
    // later - that is how the hostname form is driven below.
    querySelector: function (sel) { return el._children[sel] || (el._children[sel] = makeEl(name + ' ' + sel)); },
    querySelectorAll: function () { return []; },
    closest: function () { return null; },
    fire: function (type) {
      const hs = el.listeners[type] || [];
      return Promise.all(hs.map(function (h) { return h.call(el, { type: type, target: el, key: '', preventDefault: function () {}, stopPropagation: function () {} }); }));
    }
  };
  return el;
}

function makeLocalStorage() {
  const data = {};
  return {
    _data: data,
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem: function (k, v) { data[k] = String(v); },
    removeItem: function (k) { delete data[k]; }
  };
}

// Build a fresh context and run web/app.js in it.
function boot(opts) {
  opts = opts || {};
  const nodes = {};
  const canvasCalls = [];
  const document = {
    _nodes: nodes,
    addEventListener: function () {},
    removeEventListener: function () {},
    createElement: function () { return makeEl('created'); },
    getElementById: function (id) { return nodes['#' + id] || (nodes['#' + id] = makeEl('#' + id)); },
    querySelector: function (sel) { return nodes[sel] || (nodes[sel] = makeEl(sel)); },
    querySelectorAll: function () { return []; }
  };
  const PFCanvas = {
    on: {},
    setTopology: function (t) { canvasCalls.push(t); },
    setSelected: function () {}, setSelectedLink: function () {},
    fitView: function () {}, render: function () {},
    animateEvents: function () {}, zoomBy: function () {},
    setPlacing: function () {}, setConnecting: function () {}
  };
  const ctx = {
    console: console,
    setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval,
    JSON: JSON, Promise: Promise, Object: Object, Array: Array, Number: Number, String: String,
    Math: Math, Date: Date, Set: Set, isFinite: isFinite, parseFloat: parseFloat,
    localStorage: opts.localStorage || makeLocalStorage(),
    location: { protocol: 'http:', host: '127.0.0.1:0' },
    fetch: opts.fetch || function () { return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); } }); },
    document: document,
    window: {},
    PFCanvas: PFCanvas
  };
  ctx.window.PFCanvas = PFCanvas;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(APP_JS, ctx, { filename: 'app.js' });
  return { pf: ctx.window.__pf, ctx: ctx, document: document, nodes: nodes, canvasCalls: canvasCalls, localStorage: ctx.localStorage };
}

// ---------------------------------------------------------------------------------
console.log('The catalogue is the source of truth for the parts the UI quotes:');
{
  const app = boot();
  const pf = app.pf;
  ok(!!pf && Array.isArray(pf.opticParts), 'app.js loads and exposes the part table');
  const parts = pf.opticParts || [];
  ok(parts.length === PARTS.length,
    'the UI carries every catalogue part (' + parts.length + ' of ' + PARTS.length + ')');

  // The table is a snapshot because catalogue/ is outside the static root. A snapshot
  // that silently drifts is worse than no snapshot, so it is pinned to the JSON here.
  function ferruleOf(t) {
    const conn = String(t.connector || '').toUpperCase();
    const pol = String(t.polish || '').toUpperCase();
    if (!conn) return '';
    if (!pol) return conn;
    const head = conn.indexOf('-' + pol) !== -1 && conn.slice(-pol.length - 1) === '-' + pol
      ? conn.slice(0, -pol.length - 1) : conn;
    return head + '/' + pol;
  }
  const drift = [];
  for (const t of PARTS) {
    const mine = parts.find(function (p) { return p.partNumber === t.partNumber; });
    if (!mine) { drift.push(t.partNumber + ' missing'); continue; }
    const want = [t.formFactor, t.standard, Number(t.speedMbps), Number(t.reachM),
      ferruleOf(t), t.wavelengthNm === null || t.wavelengthNm === undefined ? null : Number(t.wavelengthNm)];
    const got = [mine.formFactor, mine.standard, mine.speedMbps, mine.reachM, mine.ferrule, mine.wavelengthNm];
    if (JSON.stringify(want) !== JSON.stringify(got)) {
      drift.push(t.partNumber + ': ' + JSON.stringify(got) + ' != ' + JSON.stringify(want));
    }
  }
  ok(drift.length === 0, 'and every field matches the catalogue file' +
    (drift.length ? ' - ' + drift.join('; ') : ''));

  const extra = parts.filter(function (p) {
    return !PARTS.some(function (t) { return t.partNumber === p.partNumber; });
  });
  ok(extra.length === 0, 'and it invents no part the catalogue does not list' +
    (extra.length ? ' - ' + extra.map(function (p) { return p.partNumber; }).join(', ') : ''));
}

console.log('\nA medium resolves to the parts that implement it:');
{
  const pf = boot().pf;
  const lr = pf.partsForMedia('10gbase-lr');
  // More than one vendor makes a 10GBASE-LR module, and a lab may hold any of them, so the
  // resolver returns all of them. What must stay stable is the *first*, because that is the
  // part the inspector headlines - a vendor-agnostic toolbox whose advice reordered itself
  // when a catalogue entry was appended would be quoting its own file order as engineering.
  ok(lr.length >= 2, '10gbase-lr resolves to every part that implements it (' +
    lr.map(function (p) { return p.partNumber; }).join(', ') + ')');
  ok(lr[0].partNumber === 'SFP-10G-LR', 'and the first is the one the inspector headlines (' +
    (lr[0] && lr[0].partNumber) + ')');
  ok(lr.some(function (p) { return p.partNumber === 'OSX010000'; }),
    'a Huawei 10GBASE-LR part is offered alongside the Cisco one (#237)');
  ok(pf.partsForMedia('10GBASE-LR').length === lr.length,
    'the media id is matched case-insensitively');
  ok(pf.partsForMedia('10gbase-t')[0].partNumber === 'SFP-10G-T-X',
    '10gbase-t resolves to the copper SFP+ module');
  ok(pf.partsForMedia('1000base-t').length === 1, '1000base-t resolves to GLC-TE');
  ok(pf.partsForMedia('1000base-lx')[0].partNumber === 'GLC-LH-SMD',
    '1000BASE-LX/LH is found by its base name, not its whole string');
  ok(pf.partsForMedia('gpon-sc-apc').length > 0, 'a PON medium finds its GPON parts');
  ok(pf.partsForMedia('10gbase-lr4').length === 0,
    'but 10GBASE-LR is not offered for a 10GBASE-LR4 run');

  // A medium nothing implements must come back empty, not with a neighbour's part.
  const none = ['docsis-31', 'moca-25', 'vdsl2-17a', 'adsl2plus', 'homeplug-av2',
    'wireless-ptp-60', '8p8c-console', '10base-t'];
  const wrong = none.filter(function (m) { return pf.partsForMedia(m).length !== 0; });
  ok(wrong.length === 0, 'media with no catalogue part resolve to nothing' +
    (wrong.length ? ' - ' + wrong.join(', ') : ''));
  ok(pf.partsForMedia('').length === 0 && pf.partsForMedia(null).length === 0,
    'and an absent media id resolves to nothing instead of throwing');

  ok(pf.reachLabel(10000) === '10 km', 'reach is quoted the way a datasheet writes it (10 km)');
  ok(pf.reachLabel(550) === '550 m', 'short reaches stay in metres (550 m)');
  ok(pf.reachLabel(20000) === '20 km', 'and 20000 m is 20 km, not 20000 m');
}

console.log('\nThe link inspector names the parts, with reach and ferrule:');
{
  const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
  function spec(v, m) {
    const s = catalog.find(function (x) { return x.vendor === v && x.model === m; });
    if (!s) throw new Error('missing spec ' + v + '/' + m);
    return s;
  }
  const t = new Topology();
  const a = t.addDevice(spec('generic', 'generic-switch'));
  const b = t.addDevice(spec('generic', 'generic-router'));
  a.name = 'SW1'; b.name = 'R1';
  const ifA = [...a.interfaces.keys()][0];
  const ifB = [...b.interfaces.keys()][0];
  t.connect(a.id, ifA, b.id, ifB);
  const topo = JSON.parse(JSON.stringify(t.serialize()));
  ok(topo.links.length === 1, 'a one-cable topology was built to inspect');

  const app = boot();
  const pf = app.pf;

  const fizz = pf.renderLinkInspector;
  function inspect(mediaId) {
    topo.links[0].mediaId = mediaId;
    pf.setTopology(JSON.parse(JSON.stringify(topo)));
    pf.selectLink(topo.links[0].id);
    pf.renderDeviceTab();
    return app.nodes['#tab-device'].innerHTML;
  }

  const fibre = inspect('10gbase-lr');
  ok(/SFP-10G-LR/.test(fibre), 'the fibre cable names a real part number (SFP-10G-LR)');
  ok(/SFP\+/.test(fibre), 'with the cage it goes in (SFP+)');
  ok(/10 km/.test(fibre), 'its real reach (10 km)');
  ok(/LC\/UPC/.test(fibre), 'its ferrule (LC/UPC)');
  ok(/1310 nm/.test(fibre), 'and its wavelength (1310 nm)');
  ok(/class="part-row"/.test(fibre), 'rendered as part rows, not a paragraph');
  ok(/data-part="SFP-10G-LR"/.test(fibre), 'each row is machine-readable (data-part)');
  ok(!/undefined/.test(fibre) && !/NaN/.test(fibre), 'nothing renders as undefined or NaN');
  ok(/Catalogue parts/.test(fibre), 'and the section says what it is');

  const mmf = inspect('1000base-sx');
  ok(/GLC-SX-MMD/.test(mmf) && /550 m/.test(mmf),
    'a 1000BASE-SX run quotes GLC-SX-MMD at 550 m');

  const coax = inspect('docsis-31');
  ok(/no part for this medium/i.test(coax), 'a medium with no part says so plainly');
  ok(/docsis-31/.test(coax), 'and names the medium it could not answer for');
  ok(!/class="parts-list"/.test(coax), 'without rendering an empty part list');
  ok(!/undefined/.test(coax) && !/NaN/.test(coax), 'and without undefined/NaN leaking in');
  ok(/parts-none/.test(coax), 'the answer has its own class, so it is not mistaken for a gap');

  const adsl = inspect('adsl2plus');
  ok(/no part for this medium/i.test(adsl) && /adsl2plus/.test(adsl),
    'and the same is true of a DSL run');
}

console.log('\nThe canvas colours have a legend:');
{
  const app = boot();
  const pf = app.pf;
  const families = pf.cableFamilies.map(function (f) { return f.id; });

  // The families the canvas actually draws, read out of its own rule table.
  const canvasFamilies = [];
  const rules = /const MEDIUM_RULES = \[([\s\S]*?)\];/.exec(CANVAS_JS);
  ok(!!rules, 'the canvas still declares MEDIUM_RULES');
  if (rules) {
    // Line by line: the copper rule contains a character class (cat[0-9]), so a single
    // "no closing bracket" regex would swallow only part of the table.
    for (const line of rules[1].split('\n')) {
      const m = /'([a-z]+)'\]\s*,?\s*$/.exec(line.trim());
      if (m) canvasFamilies.push(m[1]);
    }
  }
  ok(canvasFamilies.length >= 9, 'the canvas draws ' + canvasFamilies.length + ' cable families');
  const missing = canvasFamilies.filter(function (f) { return families.indexOf(f) === -1; });
  ok(missing.length === 0, 'every family the canvas can draw has a legend row' +
    (missing.length ? ' - missing ' + missing.join(', ') : ''));
  const invented = families.filter(function (f) { return canvasFamilies.indexOf(f) === -1; });
  ok(invented.length === 0, 'and the legend invents no family the canvas cannot draw' +
    (invented.length ? ' - ' + invented.join(', ') : ''));

  const collapsed = pf.renderCableLegend();
  const html = app.nodes['#legend-body'].innerHTML;
  ok(collapsed === false, 'the legend starts expanded');
  const rows = (html.match(/class="lg-row link-[a-z]+"/g) || []);
  ok(rows.length === families.length, 'one row per family (' + rows.length + ' of ' + families.length + ')');
  for (const f of families) {
    ok(new RegExp('class="lg-row link-' + f + '"').test(html),
      'the ' + f + ' row carries the class the canvas puts on the cable (link-' + f + ')');
  }
  ok(/lg-chip/.test(html) && /Cable colours/.test(INDEX_HTML),
    'each row has a swatch and the panel is labelled');

  // A legend row is worthless if the colour it shows is not the colour that is drawn.
  const styleMisses = families.filter(function (f) {
    return STYLE_CSS.indexOf('.link.link-' + f) === -1 || STYLE_CSS.indexOf('var(--c-' + f + ')') === -1;
  });
  ok(styleMisses.length === 0, 'each family has a canvas rule and a swatch colour var' +
    (styleMisses.length ? ' - ' + styleMisses.join(', ') : ''));

  console.log('\n  ...and it collapses, and remembers that it did:');
  const store = makeLocalStorage();
  const first = boot({ localStorage: store });
  first.pf.renderCableLegend();
  first.pf.bindLegend();
  const box = first.nodes['#cable-legend'];
  ok(!box.classList.contains('collapsed'), 'it is open on a fresh profile');
  ok(first.nodes['#legend-toggle'].getAttribute('aria-expanded') === 'true',
    'and says so to a screen reader');

  first.nodes['#legend-toggle'].fire('click');
  ok(store.getItem('pf.cableLegend.collapsed') === '1', 'collapsing writes the preference to localStorage');
  ok(box.classList.contains('collapsed'), 'and the panel collapses');
  ok(first.nodes['#legend-toggle'].getAttribute('aria-expanded') === 'false',
    'aria-expanded follows it');

  // Reload: a new document, the same localStorage - the way a browser comes back.
  const second = boot({ localStorage: store });
  const stillCollapsed = second.pf.renderCableLegend();
  second.pf.bindLegend();
  ok(stillCollapsed === true, 'a reload remembers the legend was collapsed');
  ok(second.nodes['#cable-legend'].classList.contains('collapsed'), 'and draws it collapsed');

  second.nodes['#legend-toggle'].fire('click');
  ok(store.getItem('pf.cableLegend.collapsed') === '0', 'expanding it again is remembered too');
  ok(!second.nodes['#cable-legend'].classList.contains('collapsed'), 'and it reopens');

  // It must not be an overlay: in the palette it cannot cover a device by construction.
  const paletteStart = INDEX_HTML.indexOf('<aside id="palette">');
  const paletteEnd = INDEX_HTML.indexOf('</aside>', paletteStart);
  const canvasStart = INDEX_HTML.indexOf('<main id="canvas-wrap">');
  const canvasEnd = INDEX_HTML.indexOf('</main>', canvasStart);
  ok(paletteStart !== -1 && INDEX_HTML.slice(paletteStart, paletteEnd).indexOf('id="cable-legend"') !== -1,
    'the legend lives in the palette panel, not over the drawing');
  ok(INDEX_HTML.slice(canvasStart, canvasEnd).indexOf('id="cable-legend"') === -1,
    'so it cannot cover a device on the canvas');
  for (const id of ['cable-legend', 'legend-toggle', 'legend-caret', 'legend-body']) {
    ok(INDEX_HTML.indexOf('id="' + id + '"') !== -1, '#' + id + ' is declared in index.html');
  }
}

// --- issue #38, client half ---------------------------------------------------------
async function issue38Client() {
  console.log('\nIssue #38 - a config response without state must not blank the board:');
  const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
  const spec = catalog.find(function (x) { return x.vendor === 'generic' && x.model === 'generic-switch'; });
  const t = new Topology();
  const sw = t.addDevice(spec);
  sw.name = 'SW1';
  const topo = JSON.parse(JSON.stringify(t.serialize()));

  const requests = [];
  function client(bodyFor) {
    return boot({
      fetch: function (url, opts) {
        requests.push({ url: url, opts: opts });
        return Promise.resolve({ ok: true, json: function () { return Promise.resolve(bodyFor(url)); } });
      }
    });
  }

  // (a) the shape /config/ used to answer with: CLI output and nothing to draw.
  const a = client(function () {
    return { output: '#hostname SW1', lines: [], prompt: '#', device: { id: sw.id, name: 'SW1' } };
  });
  a.pf.setTopology(topo);
  a.pf.selectDevice(sw.id);
  a.pf.renderDeviceTab();
  const before = a.pf.getTopology();
  const hn = a.nodes['#tab-device']._children['#hostname-input'];
  ok(!!hn, 'the hostname form is rendered and wired');
  hn.value = 'CORE-SW';
  await hn.fire('change');

  ok(requests.some(function (r) { return /\/config\//.test(r.url) && r.opts.method === 'POST'; }),
    'editing the hostname POSTs to /config/');
  const after = a.pf.getTopology();
  ok(after === before, 'a response with no state leaves the existing topology intact');
  ok(!!after && Array.isArray(after.devices) && after.devices.length === 1,
    'the board is still the one we had (' + (after && after.devices ? after.devices.length : 0) + ' device)');
  const drawn = a.canvasCalls[a.canvasCalls.length - 1];
  ok(!!drawn && drawn === after, 'and the renderer was still handed that topology, so the canvas redraws');
  ok(/SW1|CORE-SW/.test(a.nodes['#tab-device'].innerHTML), 'the inspector still has something to show');

  // (b) positive control: when the response does carry state, it is still adopted.
  const fresh = JSON.parse(JSON.stringify(topo));
  fresh.devices[0].name = 'CORE-SW';
  const b = client(function () { return { output: '', lines: [], state: fresh }; });
  b.pf.setTopology(topo);
  b.pf.selectDevice(sw.id);
  b.pf.renderDeviceTab();
  b.nodes['#tab-device']._children['#hostname-input'].value = 'CORE-SW';
  await b.nodes['#tab-device']._children['#hostname-input'].fire('change');
  ok(b.pf.getTopology().devices[0].name === 'CORE-SW',
    'a response that does carry state is still adopted (the guard is not a freeze)');

  // And structurally: no handler anywhere may adopt an absent state again.
  const bare = (APP_JS.match(/topo\s*=\s*r\.state\s*;/g) || []).length +
    (APP_JS.match(/topo\s*=\s*m\.state\s*;/g) || []).length;
  ok(bare === 0, 'every state adoption in app.js is guarded (topo = r.state || topo)');
  const guarded = (APP_JS.match(/topo = r\.state \|\| topo/g) || []).length;
  ok(guarded >= 10, 'and there are ' + guarded + ' of them');
}

// --- issue #38, server half --------------------------------------------------------
// Started against a scratch data directory on a port the OS picks, like
// test/server-persistence.test.js: a guessed port can collide with a server left
// running from an earlier session, and then the test talks to the wrong process.
function freePort() {
  return new Promise(function (resolve, reject) {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', function () {
      const port = probe.address().port;
      probe.close(function () { resolve(port); });
    });
  });
}

function request(port, method, urlPath, body) {
  return new Promise(function (resolve, reject) {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: port, path: urlPath, method: method,
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

function startServer(dataDir, port) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: Object.assign({}, process.env, { PORT: String(port), PF_DATA: dataDir }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', function (d) { log += d; });
  child.stderr.on('data', function (d) { log += d; });
  return new Promise(function (resolve, reject) {
    const deadline = Date.now() + 20000;
    (function poll() {
      request(port, 'GET', '/api/catalog').then(function (r) {
        if (r.status === 200) return resolve({ child: child, log: function () { return log; } });
        throw new Error('status ' + r.status);
      }).catch(function (e) {
        if (child.exitCode !== null) return reject(new Error('server exited (' + child.exitCode + '): ' + log));
        if (Date.now() > deadline) return reject(new Error('server did not answer: ' + e.message + ' | ' + log));
        setTimeout(poll, 100);
      });
    })();
  });
}

function stopServer(child) {
  return new Promise(function (resolve) {
    child.on('exit', function () { resolve(); });
    try { child.kill('SIGTERM'); } catch (e) { resolve(); }
    setTimeout(function () { try { child.kill('SIGKILL'); } catch (e) {} resolve(); }, 5000);
  });
}

async function issue38Server() {
  console.log('\n...and the endpoint answers with the envelope every other route uses:');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-parts-'));
  const port = await freePort();
  const srv = await startServer(dataDir, port);
  try {
    const add = await request(port, 'POST', '/api/topologies/default/devices',
      { vendor: 'generic', model: 'generic-switch' });
    ok(add.status === 200 || add.status === 201, 'a switch was placed (' + add.status + ')');
    const id = add.body.id || (add.body.device && add.body.device.id);

    const cfg = await request(port, 'POST', '/api/topologies/default/config/' + id,
      { commands: ['configure terminal', 'hostname CORE-SW'] });
    ok(cfg.status === 200, 'POST /config/ succeeds (' + cfg.status + ')');
    ok(!!cfg.body && !!cfg.body.state, '/config/ now returns a state envelope');
    ok(!!cfg.body.state && Array.isArray(cfg.body.state.devices) && cfg.body.state.devices.length === 1,
      'and that state is the whole board, not a fragment');
    const dev = cfg.body.state && cfg.body.state.devices.find(function (d) { return d.id === id; });
    ok(!!dev && /CORE-SW/.test(JSON.stringify(dev)),
      'the state it carries already shows the new hostname');
    ok(/CORE-SW/.test(String(cfg.body.output)), 'the CLI transcript is still returned alongside it');

    const got = await request(port, 'GET', '/api/topologies/default');
    const saved = (got.body.devices || []).find(function (d) { return d.id === id; });
    ok(!!saved && /CORE-SW/.test(JSON.stringify(saved)),
      'and the hostname really landed on the server');
  } finally {
    await stopServer(srv.child);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

(async function main() {
  await issue38Client();
  await issue38Server();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(function (e) {
  console.error('harness failed:', (e && e.stack) || e);
  console.log('\n' + passed + ' passed, ' + (failed + 1) + ' failed');
  process.exit(1);
});
