'use strict';
// link-carries.test.js - "is this link up" is not "what did the operator do to the cable".
//
// `link.state` records the cable. Three readers printed it as the link's state: the web inspector
// showed `State up` on every cable ever drawn, including one entering a port the administrator had
// disabled, and `show interfaces transceiver` printed `(up)` for the same reason. The ports' own
// state is derived elsewhere (Simulator.computePortState keeps `lineUp` and `lineStateReason`) and
// nothing joined the two facts.
//
// Topology.linkState() joins them, the state payload carries the answer, and the inspector renders
// what it is given. The console's `_ifaceState()` is the interface-level counterpart of the same
// rule, so this suite also requires the two to agree on every combination - one fact, two doors.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(v, m) { return catalog.find(function (x) { return x.vendor === v && x.model === m; }); }

function lab(prep) {
  const t = new Topology();
  const a = t.addDevice(spec('generic', 'generic-pc')); a.name = 'PC1';
  const b = t.addDevice(spec('generic', 'generic-switch')); b.name = 'SW1';
  const link = t.connect(a.id, 'eth0', b.id, 'Fa0/1');
  const sim = new Simulator(t);
  if (prep) prep({ t: t, a: a, b: b, link: link, sim: sim });
  sim.computePortState();
  return { t: t, a: a, b: b, link: link, sim: sim };
}

console.log('A working cable reports that it carries:');
{
  const { t, link } = lab();
  const st = t.linkState(t.links.get(link.id));
  ok(st.up === true, 'the link carries');
  ok(st.reason === null, 'and gives no reason, because there is nothing wrong');
  ok(st.cause === null, 'with no cause recorded');
}

console.log('\nA disabled port at this end is named, with its device:');
{
  const { t, a, link } = lab();
  a.interfaces.get('eth0').enabled = false;
  const st = t.linkState(t.links.get(link.id));
  ok(st.up === false, 'the link does not carry');
  ok(st.cause === 'admin', 'the cause is the administrator (' + st.cause + ')');
  ok(st.reason === 'PC1/eth0 is administratively down', 'and the reason names the port: ' + st.reason);
}

console.log('\nA disabled port at the far end is named too, because our own port is fine:');
{
  const { t, b, link } = lab();
  b.interfaces.get('Fa0/1').enabled = false;
  const st = t.linkState(t.links.get(link.id));
  ok(st.up === false, 'the link does not carry');
  ok(/SW1\/Fa0\/1/.test(String(st.reason)) && /administratively down/.test(String(st.reason)),
    'and the reason points at the other end: ' + st.reason);
}

console.log('\nA cable taken down is a different fact, and says so in its own words:');
{
  const { t, link } = lab(function (l) { l.link.state = 'down'; });
  const st = t.linkState(t.links.get(link.id));
  ok(st.up === false, 'the link does not carry');
  ok(st.cause === 'cable', 'the cause is the cable, not a port (' + st.cause + ')');
  ok(st.reason === 'the cable is down', 'and the cable\'s own state is quoted: ' + st.reason);
}

console.log('\nA cable naming a port that is gone reports that, instead of throwing:');
{
  const { t, link } = lab();
  const live = t.links.get(link.id);
  live.b.iface = 'Fa0/99';
  const st = t.linkState(live);
  ok(st.up === false, 'the link does not carry');
  ok(st.cause === 'gone', 'the cause is a missing socket (' + st.cause + ')');
  ok(/Fa0\/99/.test(String(st.reason)), 'and the reason names it: ' + st.reason);
}

console.log('\nThe console and the engine answer different questions, and both answers are right:');
{
  // _ifaceState() answers "is THIS interface up". linkState() answers "does this LINK carry". They
  // agree wherever the fault is at our own end, and they differ, correctly, where it is at the far
  // end: our socket really is up, and the cable really is not passing frames. What must not happen
  // is the fault going unnamed, which is what `_portNotCarryingReason()` is for - it is what
  // `show lldp neighbors` and `show interfaces transceiver` print. The matrix is here because two
  // written-in-different-places rules drift silently; a single lab would have hidden the far-end case
  // entirely.
  const cases = [
    // name,                    setup,                                              iface up?, link up?, who is to blame
    ['a working cable', function () {}, true, true, null],
    ['this end disabled', function (l) { l.a.interfaces.get('eth0').enabled = false; }, false, false, 'this port'],
    ['far end disabled', function (l) { l.b.interfaces.get('Fa0/1').enabled = false; }, true, false, 'far port'],
    ['cable taken down', function (l) { l.link.state = 'down'; l.t.markChange(); }, false, false, 'this port']
  ];
  for (const [name, setup, wantIfaceUp, wantLinkUp, blame] of cases) {
    const l = lab(function (x) { setup(x); });
    const console1 = new CliSession(l.a, l.t, l.sim);
    const st = l.t.linkState(l.t.links.get(l.link.id));
    const here = console1._ifaceState(l.a.interfaces.get('eth0'));
    ok((here.reason === null) === wantIfaceUp,
      name + ': the console reports this interface ' + (wantIfaceUp ? 'up' : 'down'));
    ok(st.up === wantLinkUp, name + ': the engine reports the link ' + (wantLinkUp ? 'carrying' : 'down'));
    const why = console1._portNotCarryingReason('eth0');
    if (blame === null) {
      ok(why === null, name + ': and neither has a reason to give');
    } else {
      ok(why !== null && why.indexOf(blame) !== -1,
        name + ': and the console names who is to blame - ' + JSON.stringify(why));
    }
  }
}

console.log('\nThe answer is derived on read, so it is not written into the saved file:');
{
  const { t } = lab();
  const saved = t.serialize();
  ok(!('carries' in saved.links[0]), 'the saved link has no "carries" field');
  ok(!('stateReason' in saved.links[0]), 'and no "stateReason" either');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  ok(/l\.carries\s*=\s*st\s*\?\s*st\.up/.test(src), 'fullState attaches it to the payload instead');
  ok(/l\.stateReason\s*=\s*st\s*\?\s*st\.reason/.test(src), 'with the reason beside it');
}

// --- the inspector, in the same stub environment the render suites use -------------
function fakeNode() {
  const base = {
    innerHTML: '', textContent: '', value: '', checked: false, style: {}, dataset: {},
    classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    addEventListener: function () {}, removeEventListener: function () {},
    appendChild: function () { return fakeNode(); }, append: function () {},
    setAttribute: function () {}, getAttribute: function () { return null; },
    removeAttribute: function () {}, remove: function () {}, focus: function () {}, click: function () {},
    querySelector: function () { return fakeNode(); }, querySelectorAll: function () { return []; },
    closest: function () { return null; }, parentElement: null, children: []
  };
  return new Proxy(base, {
    get: function (t, k) { return k in t ? t[k] : function () { return fakeNode(); }; },
    set: function (t, k, v) { t[k] = v; return true; }
  });
}
function makeWrap() {
  return {
    _html: '', get innerHTML() { return this._html; }, set innerHTML(v) { this._html = v; },
    addEventListener: function () {}, removeEventListener: function () {}, style: {},
    classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    querySelector: function () { return fakeNode(); }, querySelectorAll: function () { return []; },
    setAttribute: function () {}, getAttribute: function () { return null; }
  };
}
const wrap = makeWrap();
const ctx = {
  console: console, setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval,
  fetch: function () { return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); } }); },
  document: { addEventListener: function () {}, querySelector: function () { return wrap; }, querySelectorAll: function () { return []; } },
  window: {},
  PFCanvas: {
    on: {}, setTopology: function () {}, fitView: function () {}, render: function () {},
    setSelected: function () {}, setSelectedLink: function () {}, animateEvents: function () {}, zoomBy: function () {}
  }
};
ctx.window.PFCanvas = ctx.PFCanvas;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
const pf = ctx.window.__pf;
ok(!!pf, 'web/app.js loads in the stub environment');

function stateWith(linkId, carries, reason, cableState) {
  const { t } = lab();
  const state = JSON.parse(JSON.stringify(t.serialize()));
  const l = state.links[0];
  if (carries !== undefined) l.carries = carries;
  if (reason !== undefined) l.stateReason = reason;
  if (cableState !== undefined) l.state = cableState;
  l.verdict = t.linkVerdict(t.links.get(l.id));
  return state;
}
function renderState(state) {
  pf.setTopology(state);
  pf.selectLink(state.links[0].id);
  const w = makeWrap();
  pf.renderLinkInspector(w);
  const m = w.innerHTML.match(/<span class="k">State<\/span><span>([\s\S]*?)<\/span><\/div>/);
  return { html: w.innerHTML, state: m ? m[1] : '(no state row)' };
}

console.log('\nThe inspector prints the engine\'s answer, not the cable\'s:');
{
  const up = renderState(stateWith(null, true, null));
  ok(up.state === 'up', 'a carrying link reads up (' + up.state + ')');
  ok(up.html.indexOf('<span class="k">Cable</span>') === -1, 'and no separate cable row, because it adds nothing');

  const shut = renderState(stateWith(null, false, 'PC1/eth0 is administratively down'));
  ok(/^down - /.test(shut.state), 'a shut port reads down (' + shut.state + ')');
  ok(/PC1\/eth0 is administratively down/.test(shut.state), 'and the row carries the reason the engine gave');

  const cableDown = renderState(stateWith(null, false, 'the cable is down', 'down'));
  ok(/^down - /.test(cableDown.state), 'a cable taken down reads down');
  ok(/<span class="k">Cable<\/span><span>down<\/span>/.test(cableDown.html),
    'and the cable row appears, because "down" alone would not say which of the two it was');

  const unchecked = renderState(stateWith(undefined, undefined, undefined));
  ok(unchecked.state === 'not checked in this session',
    'a payload with no answer is reported as unchecked (' + unchecked.state + ')');
  ok(unchecked.state !== 'up', 'never as up, which is what the row used to claim');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
