'use strict';
// The inspector must actually show the hardware layer (cage, media, PoE, VLAN)
// and cables must be inspectable. This loads the real web/app.js in a stub DOM
// and asserts on the HTML it produces from a real serialized topology.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('  \u2713 ' + msg); } else { failed++; console.error('  \u2717 ' + msg); } }

// --- a topology that exercises PoE, an SFP uplink and a trunk --------------
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(v, m) {
  const s = catalog.find(function (x) { return x.vendor === v && x.model === m; });
  if (!s) throw new Error('missing spec ' + v + '/' + m);
  return s;
}
const t = new Topology();
const sw = t.addDevice(spec('generic', 'generic-switch'));
const pc = t.addDevice(spec('generic', 'generic-pc'));
const rt = t.addDevice(spec('generic', 'generic-router'));
sw.name = 'SW1'; pc.name = 'PC1'; rt.name = 'R1';
const l1 = t.connect(pc.id, 'eth0', sw.id, 'Fa0/1');
const l2 = t.connect(sw.id, 'Fa0/2', rt.id, 'Gi0/0');
runCommands(sw, t, null, ['enable', 'configure terminal',
  'interface Fa0/1', 'switchport mode access', 'switchport access vlan 20']);
const topo = JSON.parse(JSON.stringify(t.serialize()));
// The server puts a verdict and a carrying-state on every cable (server/index.js fullState); the
// inspector renders those instead of asserting the checks happened, so the fixture has to carry what
// a browser gets.
for (const l of topo.links) {
  l.verdict = t.linkVerdict(t.links.get(l.id));
  const st = t.linkState(t.links.get(l.id));
  l.carries = st.up;
  l.stateReason = st.reason;
}

// --- load the real frontend in a stub environment -------------------------
// Permissive node stub: any unknown property is a no-op function, so the
// top-level event wiring in app.js loads without a real DOM.
function fakeNode() {
  const base = {
    innerHTML: '', textContent: '', value: '', checked: false,
    style: {}, dataset: {},
    classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    addEventListener: function () {}, removeEventListener: function () {},
    appendChild: function () { return fakeNode(); }, append: function () {},
    setAttribute: function () {}, getAttribute: function () { return null; },
    removeAttribute: function () {}, remove: function () {}, focus: function () {}, click: function () {},
    querySelector: function () { return fakeNode(); }, querySelectorAll: function () { return []; },
    closest: function () { return null; }, parentElement: null, children: []
  };
  return new Proxy(base, {
    get: function (t, k) {
      if (k in t) return t[k];
      return function () { return fakeNode(); };
    },
    set: function (t, k, v) { t[k] = v; return true; }
  });
}

// A wrap whose innerHTML we can read back after rendering.
function makeWrap() {
  return {
    _html: '',
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = v; },
    addEventListener: function () {}, removeEventListener: function () {},
    style: {}, classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    querySelector: function () { return fakeNode(); },
    querySelectorAll: function () { return []; },
    setAttribute: function () {}, getAttribute: function () { return null; }
  };
}

const mainWrap = makeWrap();
const ctx = {
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  setInterval: setInterval,
  fetch: function () { return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); } }); },
  document: {
    addEventListener: function () {},
    querySelector: function () { return mainWrap; },
    querySelectorAll: function () { return []; }
  },
  window: {},
  PFCanvas: {
    on: {},
    setTopology: function () {}, fitView: function () {}, render: function () {},
    setSelected: function () {}, setSelectedLink: function () {},
    animateEvents: function () {}, zoomBy: function () {}
  }
};
ctx.window.PFCanvas = ctx.PFCanvas;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8'), ctx, { filename: 'app.js' });

const pf = ctx.window.__pf;
ok(!!pf, 'app.js loaded and exposed its inspector helpers');

console.log('\nSpeed and cage formatting:');
ok(pf.fmtSpeed(1000) === '1G', 'fmtSpeed(1000) === "1G"');
ok(pf.fmtSpeed(10000) === '10G', 'fmtSpeed(10000) === "10G"');
ok(pf.fmtSpeed(2500) === '2.5G', 'fmtSpeed(2500) === "2.5G"');
ok(pf.fmtSpeed(100) === '100M', 'fmtSpeed(100) === "100M"');
ok(pf.cageLabel('sfp+') === 'SFP+', 'cageLabel("sfp+") === "SFP+"');
ok(pf.cageLabel('rj45') === 'RJ45', 'cageLabel("rj45") === "RJ45"');
ok(pf.cageLabel('weird') === 'WEIRD', 'unknown cages fall back to upper case');

console.log('\nDevice inspector renders the hardware layer:');
pf.setTopology(topo);
pf.selectDevice(sw.id);
pf.renderDeviceTab();
const devHtml = mainWrap.innerHTML;

ok(/iface-list/.test(devHtml), 'interface list container is rendered');
ok(/iface-filter/.test(devHtml), 'port filter box is rendered');
const rowCount = (devHtml.match(/class="iface-row"/g) || []).length;
ok(rowCount === sw.interfaces.size, 'one row per interface (' + rowCount + ' of ' + sw.interfaces.size + ')');
ok(/class="iface-count"/.test(devHtml), 'port count summary is shown');
ok(/RJ45/.test(devHtml), 'RJ45 cages are labelled, not raw ids');
ok(/\b1G\b/.test(devHtml), 'link rates are humanised');
ok(/hw-grid/.test(devHtml), 'per-port hardware grid is present');
ok(/Speeds/.test(devHtml) && /Cage/.test(devHtml) && /Media/.test(devHtml), 'cage / speeds / media rows present');
ok(/VLAN/.test(devHtml) && /access 20/.test(devHtml), 'the VLAN config from the CLI shows up (access 20)');
// A voice VLAN is a second membership on the port, and the inspector's one line about the port has
// to name it - the field existed and was rendered nowhere (issue #1369).
ok(pf.vlanSummary({ vlan: { mode: 'trunk', nativeVlan: 1, allowedVlans: [10, 30], voiceVlan: 30 } }) ===
  'trunk \u00b7 native 1 \u00b7 allowed 10,30 \u00b7 voice 30', 'a trunk with a voice VLAN says so');
ok(pf.vlanSummary({ vlan: { mode: 'trunk', nativeVlan: 1, allowedVlans: 'all', voiceVlan: null } }) ===
  'trunk \u00b7 native 1 \u00b7 allowed all', 'and a trunk without one does not invent it');
ok(/class="dot up"/.test(devHtml), 'admin state is shown per port');
ok(/port-link/.test(devHtml) || /port-peer/.test(devHtml), 'cabled ports are marked');
// A dot alone said "cabled" without saying where to. The row must name the peer.
ok(/class="port-peer"/.test(devHtml), 'a cabled port names what is plugged into it');
ok(/\u2192\s/.test(devHtml), 'and points at the far end (device:port)');

console.log('\nPoE is surfaced where the hardware provides it:');
let poePick = null;
for (const s of catalog) {
  const probe = new Topology();
  const pd = probe.addDevice(s);
  if (pd.poeBudget > 0 && [...pd.interfaces.values()].some(function (i) { return i.hardware.poeOut; })) {
    poePick = s; break;
  }
}
if (poePick) {
  const t2 = new Topology();
  const pd = t2.addDevice(poePick);
  const t2s = JSON.parse(JSON.stringify(t2.serialize()));
  pf.setTopology(t2s);
  pf.selectDevice(pd.id);
  pf.renderDeviceTab();
  const h = mainWrap.innerHTML;
  ok(/PoE budget/.test(h), 'a PoE switch reports its power budget (' + poePick.model + ')');
  ok(h.indexOf(String(pd.poeBudget) + ' W') >= 0, 'the budget value appears (' + pd.poeBudget + ' W)');
  ok(/PSE ports/.test(h), 'and its PSE port count');
  ok(/PSE, /.test(h), 'per-port PoE capability shows in the hardware grid');
} else {
  ok(false, 'no PoE PSE with a known budget in the catalogue');
}

console.log('\nLink inspector:');
pf.setTopology(topo);
pf.selectLink(l1.id);
const lw = makeWrap();
pf.renderLinkInspector(lw);
const linkHtml = lw.innerHTML;
const link = topo.links.find(function (l) { return l.id === l1.id; });
ok(/Physical cable/.test(linkHtml), 'the link inspector opens');
ok(linkHtml.indexOf(link.mediaId) >= 0, 'the negotiated media id is shown (' + link.mediaId + ')');
ok(linkHtml.indexOf('SW1') >= 0 && linkHtml.indexOf('PC1') >= 0, 'both endpoints are named');
ok(/Cages mate/.test(linkHtml), 'and it states the physical check that allowed the cable');
ok(/<span class="k">State<\/span><span>up<\/span>/.test(linkHtml),
  'and the link reads up, because the payload says it carries');
ok((linkHtml.match(/class="endpoint"/g) || []).length === 2, 'two endpoint cards');

console.log('\nA missing link degrades gracefully:');
pf.selectLink('does-not-exist');
const bw = makeWrap();
pf.renderLinkInspector(bw);
ok(/no longer exists/.test(bw.innerHTML), 'a stale selection says so instead of throwing');

console.log('\nThe PoE display agrees with the engine:');
const t5 = new Topology();
const sw5 = t5.addDevice(spec('aruba', 'CX 6000 24G CL4 PoE 4SFP 370W'));
const q1 = t5.addDevice(spec('ubiquiti', 'UCG-Ultra'));
const q2 = t5.addDevice(spec('ubiquiti', 'UCG-Ultra'));
sw5.name = 'SW5'; q1.name = 'P1'; q2.name = 'P2';
t5.connect(q1.id, 'port1', sw5.id, '1/1/1');
t5.connect(q2.id, 'port1', sw5.id, '1/1/2');
sw5.poeBudget = 25;                       // 2 x 12.95 W cannot both fit
const t5s = JSON.parse(JSON.stringify(t5.serialize()));
const sim5 = new Simulator(t5);
const enginePoe = sim5.computePoe()[0];
pf.setTopology(t5s);
pf.selectDevice(sw5.id);
const uiPoe = pf.poeSummary(t5s.devices.find(function (d) { return d.id === sw5.id; }));
ok(uiPoe.budget === enginePoe.budget, 'budget matches (' + uiPoe.budget + ' W)');
ok(uiPoe.used === enginePoe.used, 'power in use matches the engine (' + uiPoe.used + ' W)');
ok(uiPoe.denied === enginePoe.ports.filter(function (p) { return !p.powered; }).length,
   'denied port count matches (' + uiPoe.denied + ')');
pf.renderDeviceTab();
ok(/PoE in use/.test(mainWrap.innerHTML), 'the inspector shows power in use');
ok(/DENIED/.test(mainWrap.innerHTML), 'and flags the port that missed out');
sw5.poeBudget = 370;
pf.setTopology(JSON.parse(JSON.stringify(t5.serialize())));
pf.selectDevice(sw5.id);
pf.renderDeviceTab();
ok(!/DENIED/.test(mainWrap.innerHTML), 'with enough budget nothing is flagged');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
