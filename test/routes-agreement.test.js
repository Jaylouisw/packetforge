'use strict';
// The inspector's Routes table and `show ip route` describe the same table (#1301).
//
// The panel printed `code | dest/len | gw` straight out of runtime state. The console, since #1234/#1271, prints
// four things the panel did not:
//
//   * the code the table actually installs - `S*` for the gateway of last resort, not a bare `S`;
//   * the administrative distance, which is half the rule that decides which route wins;
//   * `is directly connected, Gi0/0` instead of `via -` on a connected row;
//   * and the sentence saying a row cannot carry a packet.
//
// The last one is the defect. On a router whose only uplink was down, the console marked all three routes
// `(down: link down)` while the panel drew a healthy table - and the drop that follows says "no ARP reply from
// X", which sends the operator looking for a host instead of at the wire. Two surfaces, one table, and the one
// on screen said nothing was wrong.
//
// So the verdict is now computed once, in `Device.routesTable(topo)`, and both surfaces read it. This file pins
// the panel to the console, row by row, across every route source and every way a port can fail.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Topology, Simulator, Device } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const ROOT = path.join(__dirname, '..');
const catalog = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.find(function (s) { return /ASR 1001-X/.test(s.model); });

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

// The panel reads routes out of the payload the server sends: exactly what fullState() builds.
function panelRows(dev, topo) {
  const state = topo ? JSON.parse(JSON.stringify(topo.serialize())) : { devices: [], links: [] };
  state.runtime = state.runtime || {};
  state.runtime[dev.id] = { routes: dev.routesTable(topo) };
  pf.setTopology(state);
  const serialised = (state.devices || []).filter(function (d) { return d.id === dev.id; })[0] || { id: dev.id };
  return pf.routesRows(serialised);
}

// --- the console --------------------------------------------------------------------------------------------
function cliRows(dev, topo) {
  const s = new CliSession(dev, topo || null, topo ? new Simulator(topo) : null);
  const lines = (s.run('show ip route').output || []).map(String);
  const rows = [];
  for (const line of lines) {
    // Ordinary control flow, not an exemption: these two lines are the legend and the gateway summary, not
    // rows of the table. Nothing about a device or a port is being decided here.
    if (/^Codes:/.test(line) || /^Gateway of last resort/.test(line)) continue;
    const m = /^(\S+)\s+(\d+\.\d+\.\d+\.\d+)\s+\/(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const code = m[1];
    const prefix = m[2] + '/' + m[3];
    const rest = m[4].trim();
    let distance = null, gw = null, iface = null, note = '';
    const c = /^is directly connected,\s+(\S+)/.exec(rest);
    if (c) {
      iface = c[1];
      const tail = rest.slice(c[0].length).trim();
      note = tail;
    } else {
      const d = /^\[(\d+)\/\d+\] via (\S+)/.exec(rest);
      if (d) { distance = Number(d[1]); gw = d[2]; }
      let tail = rest.slice(d ? d[0].length : 0).trim();
      const noteM = /\s*(\(.*\))$/.exec(tail);
      if (noteM) { note = noteM[1].trim(); tail = tail.slice(0, noteM.index).trim(); }
      iface = tail || null;
    }
    rows.push({ code: code, network: prefix, distance: distance, gw: gw, iface: iface, note: note });
  }
  return rows;
}

// --- labs ---------------------------------------------------------------------------------------------------
// One router, one peer, and whichever route sources the case is about.
function lab(kind) {
  const t = new Topology();
  const r1 = t.addDevice(ROUTER, 'r1'); r1.name = 'R1';
  const r2 = t.addDevice(ROUTER, 'r2'); r2.name = 'R2';
  const ports1 = [...r1.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
  const ports2 = [...r2.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
  if (kind === 'empty') return { t: t, r1: r1, r2: r2 };
  t.connect(r1.id, ports1[0].name, r2.id, ports2[0].name);
  ports1[0].ip = '10.1.2.3'; ports1[0].mask = '255.255.255.0';
  ports2[0].ip = '10.1.2.1'; ports2[0].mask = '255.255.255.0';

  if (kind === 'connected') return { t: t, r1: r1, r2: r2 };

  if (kind === 'static-default' || kind === 'link-down' || kind === 'peer-shut') {
    r1.config.routes = [
      { dest: '0.0.0.0', mask: '0.0.0.0', gw: '10.1.2.1', iface: null },
      { dest: '192.168.5.0', mask: '255.255.255.0', gw: '10.1.2.1', iface: null }
    ];
    if (kind === 'link-down') [...t.links.values()][0].state = 'down';
    if (kind === 'peer-shut') ports2[0].enabled = false;
    return { t: t, r1: r1, r2: r2 };
  }
  if (kind === 'gateway-and-static') {
    // A configured gateway is distance 254 and loses to a static default at 1. Both rows must be visible, and
    // only the configured one carries `S*` - that is the code the panel used to print as a bare `S`.
    r1.config.defaultGateway = '10.1.2.254';
    r1.config.routes = [{ dest: '0.0.0.0', mask: '0.0.0.0', gw: '10.1.2.1', iface: null }];
    return { t: t, r1: r1, r2: r2 };
  }
  if (kind === 'iface-only-static') {
    r1.config.routes = [{ dest: '172.16.0.0', mask: '255.255.0.0', gw: null, iface: ports1[0].name }];
    return { t: t, r1: r1, r2: r2 };
  }
  if (kind === 'local-shut') {
    r1.config.routes = [{ dest: '172.16.0.0', mask: '255.255.0.0', gw: '10.1.2.9', iface: null }];
    ports1[0].enabled = false;
    return { t: t, r1: r1, r2: r2 };
  }
  if (kind === 'learned') {
    r1.ospfRoutes = [{ dest: '10.77.0.0', mask: '255.255.0.0', nextHop: '10.1.2.9', iface: ports1[0].name }];
    r1.bgpRoutes = [
      { dest: '203.0.113.0', mask: '255.255.255.0', nextHop: '10.1.2.2', iface: ports1[0].name, ad: 20 },
      { dest: '198.18.0.0', mask: '255.255.0.0', nextHop: '10.1.2.4', iface: ports1[0].name, ad: 200 }
    ];
    return { t: t, r1: r1, r2: r2 };
  }
  throw new Error('unknown case ' + kind);
}

const cases = ['empty', 'connected', 'static-default', 'gateway-and-static', 'iface-only-static', 'learned',
  'link-down', 'peer-shut', 'local-shut'];

console.log('');
console.log('The two surfaces describe the same rows:');
{
  const bad = [];
  for (const kind of cases) {
    const env = lab(kind);
    const p = panelRows(env.r1, env.t);
    const c = cliRows(env.r1, env.t);
    const pNetworks = p.map(function (r) { return r.network; }).sort();
    const cNetworks = c.map(function (r) { return r.network; }).sort();
    if (pNetworks.join(',') !== cNetworks.join(',')) {
      bad.push(kind + ': panel [' + pNetworks.join(' ') + '] console [' + cNetworks.join(' ') + ']');
      continue;
    }
    // Two rows can share a prefix: a configured gateway (254) and a static default (1) are both 0.0.0.0/0.
    // So rows are compared as a multiset keyed by code, prefix, distance and note, not looked up by prefix.
    // The trailing words, in the order both surfaces print them: the fault note first, then the sentence that
    // says a healthy row is not the route chosen (#1407). They are separate fields so that a shadowed route is
    // not styled as a fault - the check below tests exactly that - but the words have to match.
    const tail = function (r) { return [r.note, r.shadow].filter(Boolean).join('  '); };
    const pSigs = p.map(function (r) {
      const d = /\[(\d+)\/0\]/.exec(r.via);
      return r.code + '|' + r.network + '|' + (d ? d[1] : 'connected') + '|' + tail(r);
    }).sort();
    const cSigs = c.map(function (r) {
      return r.code + '|' + r.network + '|' + (r.distance === null ? 'connected' : r.distance) + '|' + (r.note || '');
    }).sort();
    if (pSigs.join('~') !== cSigs.join('~')) {
      bad.push(kind + ': panel ' + JSON.stringify(pSigs) + ' console ' + JSON.stringify(cSigs));
      continue;
    }
    // ...and the interface the console names has to appear on the matching panel row.
    for (const cRow of c) {
      if (!cRow.iface) continue;
      const candidates = p.filter(function (x) { return x.network === cRow.network && x.code === cRow.code; });
      if (!candidates.some(function (x) { return x.via.indexOf(cRow.iface) !== -1; })) {
        bad.push(kind + ' ' + cRow.network + ': panel via ' + JSON.stringify(candidates.map(function (x) { return x.via; })) +
          ' never names ' + cRow.iface);
      }
    }
  }
  ok(bad.length === 0, cases.length + ' situations: same prefixes, same codes, same next hops, same notes',
    JSON.stringify(bad.slice(0, 5)));
}

console.log('');
console.log('A route that cannot carry a packet is marked in both places, and only in both:');
{
  const bad = [];
  for (const kind of cases) {
    const env = lab(kind);
    const p = panelRows(env.r1, env.t);
    const c = cliRows(env.r1, env.t);
    for (const cRow of c) {
      const pRow = p.filter(function (x) { return x.network === cRow.network && x.code === cRow.code; })[0];
      if (!pRow) continue;
      // The console's own words for "this row cannot be used". The no-next-hop caveat is a caveat, not a fault:
      // an interface-only static still carries a packet where the far side proxies ARP.
      const consoleSaysDead = /(down|administratively down|gone)/.test(cRow.note || '');
      if (pRow.unusable !== consoleSaysDead) {
        bad.push(kind + ' ' + cRow.network + ': panel unusable=' + pRow.unusable +
          ' console note "' + (cRow.note || '') + '"');
      }
      if (consoleSaysDead && !pRow.note) bad.push(kind + ' ' + cRow.network + ': dead in the console, silent in the panel');
      if (!consoleSaysDead && pRow.note && !/no next hop/.test(pRow.note)) {
        bad.push(kind + ' ' + cRow.network + ': panel invents a fault "' + pRow.note + '"');
      }
    }
  }
  ok(bad.length === 0, cases.length + ' situations: no missed dead route, no invented fault',
    JSON.stringify(bad.slice(0, 5)));
}

console.log('');
console.log('The reported case: a router whose only uplink is down.');
{
  const env = lab('link-down');
  const p = panelRows(env.r1, env.t);
  ok(p.length === 3, 'the panel still lists all three routes - they are installed', JSON.stringify(p));
  ok(p.every(function (r) { return r.unusable; }), 'and marks every one of them unusable',
    JSON.stringify(p.map(function (r) { return r.network + '=' + r.unusable; })));
  ok(p.every(function (r) { return /down: link down/.test(r.note); }), 'with the reason',
    JSON.stringify(p.map(function (r) { return r.note; })));
  ok(p.filter(function (r) { return r.code === 'S' && r.network === '0.0.0.0/0'; }).length === 1,
    'the default route is still shown', JSON.stringify(p));
}

console.log('');
console.log('The gateway of last resort is distinguishable from a static default:');
{
  const env = lab('gateway-and-static');
  const p = panelRows(env.r1, env.t);
  const star = p.filter(function (r) { return r.code === 'S*'; });
  ok(star.length === 1, 'exactly one row carries the S* code', JSON.stringify(p));
  ok(star[0] && star[0].via.indexOf('[254/0]') !== -1, 'the configured gateway shows distance 254', star[0] && star[0].via);
  const plain = p.filter(function (r) { return r.code === 'S'; });
  ok(plain.length === 1 && plain[0].via.indexOf('[1/0]') !== -1, 'the static default shows distance 1',
    JSON.stringify(plain));
}

console.log('');
console.log('Nothing to say when nothing is wrong:');
{
  const env = lab('connected');
  const p = panelRows(env.r1, env.t);
  ok(p.every(function (r) { return r.note === '' && r.unusable === false; }),
    'a healthy table carries no notes and no faults', JSON.stringify(p));
  ok(/^is directly connected, /.test(p[0].via), 'a connected row says so rather than "via -"', p[0].via);
  ok(/10\.1\.2\.0\/24/.test(p[0].network), 'and names the prefix the console names', p[0].network);

  const empty = lab('empty');
  ok(panelRows(empty.r1, empty.t).length === 0, 'a device with no routes produces no rows',
    JSON.stringify(panelRows(empty.r1, empty.t)));
}

console.log('');
console.log('A payload from an older server is not silently presented as healthy:');
{
  // The panel used to read `code/dest/gw` and nothing else. If it is pointed at a server that still sends only
  // those fields, every row would look fine because nobody looked - so it says so instead.
  const env = lab('link-down');
  const state = JSON.parse(JSON.stringify(env.t.serialize()));
  const d = state.devices.filter(function (x) { return x.id === env.r1.id; })[0];
  state.runtime = state.runtime || {};
  state.runtime[env.r1.id] = { routes: [{ code: 'S', dest: '0.0.0.0', mask: '0.0.0.0', gw: '10.1.2.1',
    iface: '-', type: 'static' }] };
  pf.setTopology(state);
  const rows = pf.routesRows(d);
  ok(rows.length === 1 && /not checked/.test(rows[0].note), 'an unannotated row says it was not checked',
    JSON.stringify(rows));
  ok(rows[0].unusable === false, 'and does not claim a fault it cannot know about', JSON.stringify(rows));
}

console.log('');
console.log('The rule lives in one place, and it says when it could not look:');
{
  const env = lab('link-down');
  const withTopo = env.r1.routesTable(env.t);
  const without = env.r1.routesTable();
  ok(withTopo.every(function (r) { return r.checked === true; }), 'a table built with a topology is checked',
    JSON.stringify(withTopo.map(function (r) { return r.checked; })));
  ok(without.every(function (r) { return r.checked === false; }), 'and one built without says so',
    JSON.stringify(without.map(function (r) { return r.checked; })));
  ok(without.every(function (r) { return r.unusable === false && r.note === ''; }),
    'claiming neither health nor fault', JSON.stringify(without));
  // The distance table is shared, so the console's sort and the panel's column cannot drift.
  ok(Device.routeDistance({ type: 'connected' }) === 0 &&
    Device.routeDistance({ type: 'static' }) === 1 &&
    Device.routeDistance({ type: 'ospf' }) === 110 &&
    Device.routeDistance({ type: 'bgp', ad: 20 }) === 20 &&
    Device.routeDistance({ type: 'bgp' }) === 200 &&
    Device.routeDistance({ type: 'default' }) === 254,
    'distances: C 0, S 1, O 110, B (ad or 200), gateway 254');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
