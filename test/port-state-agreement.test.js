'use strict';
// Three views describe a port, and they must say the same thing (#1238).
//
// #1237 made `show ip interface brief` and `show interfaces` report whether a port can carry a frame,
// and why not. The UI was still answering the older question - "did somebody shut it" - in three
// places: the faceplate cell (web/faceplate.js), the canvas tooltip (web/canvas.js) and the inspector
// status bar (web/app.js). On the canvas, which is what you stare at when a link will not come up, an
// unplugged port was described as healthy.
//
// The rule now lives once, in faceplate.js, and the other two call it. This file proves:
//   * the engine and the UI agree, case for case, on what each situation is called;
//   * each view renders the reason, not just a red dot;
//   * the load order in index.html makes the shared rule available to both callers;
//   * none of the three sites went back to deriving the answer from `enabled`.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Topology, Simulator, runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');
const faceplate = require('../web/faceplate.js');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.filter(function (s) { return /ASR 1001-X/.test(s.model); })[0];
const ethPorts = function (d) {
  return [...d.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
};

// Four situations, built once and read three ways: the engine's verdict, the UI rule, the rendering.
function situations() {
  const t = new Topology();
  const r1 = t.addDevice(ROUTER, 'r1');
  const r2 = t.addDevice(ROUTER, 'r2');
  const cabled = ethPorts(r1)[0];       // cabled, both ends up
  const spare = ethPorts(r1)[1];        // nothing plugged in
  const farEnd = ethPorts(r2)[0];       // the far end of `cabled`
  const remote = ethPorts(r2)[1];       // spare on r2, will be shut
  const sim = new Simulator(t);
  runCommands(r1, t, sim, ['configure terminal', 'interface ' + spare.name, 'ip address 10.0.1.1 255.255.255.0', 'end']);
  t.connect('r1', cabled.name, 'r2', farEnd.name);
  const cli = new CliSession(r1, t, sim);
  return { t: t, r1: r1, r2: r2, cabled: cabled, spare: spare, farEnd: farEnd, remote: remote, sim: sim, cli: cli };
}

// A canvas in a recording stub DOM, loaded the way index.html loads it: faceplate.js first, because
// the canvas calls the rule it defines.
function canvasTitles(topoJson) {
  function rec(name, attrs) {
    return {
      tag: name, attrs: attrs || {}, children: [], textContent: '', style: {},
      appendChild: function (c) { this.children.push(c); return c; },
      setAttribute: function (k, v) { this.attrs[k] = v; },
      getAttribute: function (k) { return this.attrs[k]; },
      addEventListener: function () {}, removeEventListener: function () {},
      classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
      querySelector: function () { return null; }, querySelectorAll: function () { return []; },
      set innerHTML(v) { this.children.length = 0; }, get innerHTML() { return ''; }
    };
  }
  const roots = {};
  ['canvas', 'world', 'packets', 'overlay'].forEach(function (id) { roots[id] = rec('g', { id: id }); });
  const sandbox = {
    console: console,
    document: {
      getElementById: function (id) { return roots[id] || rec('div'); },
      createElementNS: function (ns, name) { return rec(name, {}); },
      createElement: function (name) { return rec(name, {}); },
      addEventListener: function () {}, querySelector: function () { return null; },
      querySelectorAll: function () { return []; }, body: rec('body')
    },
    window: {}, requestAnimationFrame: function () { return 0; },
    performance: { now: function () { return 0; } },
    setTimeout: setTimeout, clearTimeout: clearTimeout
  };
  sandbox.window.window = sandbox.window;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'faceplate.js'), 'utf8'), sandbox, { filename: 'faceplate.js' });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'canvas.js'), 'utf8'), sandbox, { filename: 'canvas.js' });
  const PFCanvas = sandbox.window.PFCanvas;
  if (!PFCanvas || typeof PFCanvas.render !== 'function') throw new Error('canvas.js did not load');
  PFCanvas.render(topoJson);
  const titles = [];
  (function walk(node) {
    (node.children || []).forEach(function (c) {
      if (c.tag === 'title') titles.push(String(c.textContent));
      walk(c);
    });
  })(roots.world);
  return titles;
}

console.log('');
console.log('The engine and the UI call each situation the same thing:');
{
  const env = situations();

  // Engine wording, straight from Device.ifaceStatus, with the topology it needs.
  const engine = function (port) { return env.r1.ifaceStatus(port, env.t); };

  const upV = engine(env.cabled);
  ok(upV.status === 'up' && upV.protocol === 'up' && upV.reason === null,
    'engine: a cabled port is up', JSON.stringify(upV));
  ok(faceplate.portStateText({ enabled: true, cabled: true, peerEnabled: true }) === 'up',
    'ui: the same port reads "up"');

  const noCable = engine(env.spare);
  ok(noCable.status === 'down' && noCable.reason === 'no cable',
    'engine: a port with no cable is down for that reason', JSON.stringify(noCable));
  ok(faceplate.portStateText({ enabled: true, cabled: false }) === 'down (no cable)',
    'ui: the same port reads "down (no cable)"');
  ok(faceplate.portState({ enabled: true, cabled: false }).state === 'notconnect',
    'ui: and is styled notconnect, not a red fault light');

  // Shut at the far end: the near port cannot carry a frame either.
  runCommands(env.r2, env.t, env.sim, ['configure terminal', 'interface ' + env.farEnd.name, 'shutdown', 'end']);
  const peerDown = engine(env.cabled);
  ok(peerDown.status === 'down' && peerDown.reason === 'peer shut down',
    'engine: a cabled port whose far end is shut is down for that reason', JSON.stringify(peerDown));
  ok(faceplate.portStateText({ enabled: true, cabled: true, peerEnabled: false }) === 'down (peer shut down)',
    'ui: the same port reads "down (peer shut down)"');

  runCommands(env.r2, env.t, env.sim, ['configure terminal', 'interface ' + env.remote.name, 'shutdown', 'end']);
  const shut = engine(env.remote);
  ok(shut.status === 'administratively down' && shut.reason === 'shut down',
    'engine: a port shut here is administratively down', JSON.stringify(shut));
  ok(faceplate.portStateText({ enabled: false, cabled: true }) === 'administratively down',
    'ui: the same port reads "administratively down"');

  // An unknown cable is not a missing cable: a view that cannot see the topology must not claim down.
  ok(faceplate.portState({ enabled: true }).state === 'up',
    'ui: with no cable knowledge the port is not declared down');
}

console.log('');
console.log('The faceplate renders the reason, not just a colour:');
{
  const env = situations();
  runCommands(env.r1, env.t, env.sim, ['configure terminal', 'interface ' + ethPorts(env.r1)[2].name, 'shutdown', 'end']);
  const shutPort = ethPorts(env.r1)[2];
  const serialized = JSON.parse(JSON.stringify(env.r1.serialize()));
  const html = faceplate.render(serialized, { topology: env.t.serialize(), fullNames: true });

  const blockFor = function (name) {
    const i = html.indexOf('data-port="' + name + '"');
    if (i === -1) return '';
    return html.slice(Math.max(0, i - 260), i + 600);
  };
  const spareBlock = blockFor(env.spare.name);
  ok(/fp-notconnect/.test(spareBlock), 'the unplugged port is marked notconnect', spareBlock.slice(0, 120));
  ok(/down \(no cable\)/.test(spareBlock), 'its tooltip says why: down (no cable)');
  ok(!/\bup\b(?! \(no cable\))/.test((/title="([^"]*)"/.exec(spareBlock) || [])[1] || ''),
    'and the title does not call it up');

  const cabledBlock = blockFor(env.cabled.name);
  ok(/fp-cabled/.test(cabledBlock), 'the cabled port is marked cabled');
  ok(!/down/.test((/title="([^"]*)"/.exec(cabledBlock) || [])[1] || ''), 'and its title says nothing about being down');

  const shutBlock = blockFor(shutPort.name);
  ok(/fp-down/.test(shutBlock), 'the shut port is marked down');
  ok(/administratively down/.test(shutBlock), 'and says so in words');
}

console.log('');
console.log('The canvas says the same thing as the panel:');
{
  const env = situations();
  const shutPort = ethPorts(env.r1)[2];
  runCommands(env.r1, env.t, env.sim, ['configure terminal', 'interface ' + shutPort.name, 'shutdown', 'end']);
  const titles = canvasTitles(JSON.parse(JSON.stringify(env.t.serialize())));

  const titleStarting = function (port) {
    return titles.filter(function (s) { return s.indexOf(port + ' ') === 0; })[0] || '';
  };
  const spareTitle = titleStarting(env.spare.name);
  ok(/down \(no cable\)/.test(spareTitle), 'the canvas names the reason too: down (no cable)', spareTitle);
  ok(!/administratively down/.test(spareTitle), 'and does not call it administratively down', spareTitle);

  const shutTitle = titleStarting(shutPort.name);
  ok(/administratively down/.test(shutTitle), 'the shut port is administratively down on the canvas too', shutTitle);

  const cabledTitle = titleStarting(env.cabled.name);
  ok(!!cabledTitle && /cabled to/.test(cabledTitle), 'the cabled port says what it is cabled to', cabledTitle);
  ok(!/down/.test(cabledTitle), 'and nothing about being down', cabledTitle);
}

console.log('');
console.log('A patched cable that was taken down, in all three views:');
{
  // `link down` is a first-class state here: the ports stay patched and the simulator will not carry a
  // frame. Reporting up in that case is the same lie as calling an empty socket up.
  const env = situations();
  const linkId = env.t.linksFor('r1')[0].id;
  env.sim.setLinkState(linkId, 'down', { atMs: 1000 });
  ok(env.cabled.peer && env.cabled.peer.deviceId === 'r2', 'the cable is still patched', JSON.stringify(env.cabled.peer));

  const verdict = env.r1.ifaceStatus(env.cabled, env.t);
  ok(verdict.status === 'down' && verdict.reason === 'link down',
    'engine: down, and the reason is the cable, not the socket', JSON.stringify(verdict));
  ok(faceplate.portStateText({ enabled: true, cabled: true, peerEnabled: true, linkDown: true }) === 'down (link down)',
    'ui: "down (link down)"');

  const html = faceplate.render(JSON.parse(JSON.stringify(env.r1.serialize())),
    { topology: env.t.serialize(), fullNames: true });
  const i = html.indexOf('data-port="' + env.cabled.name + '"');
  const block = i === -1 ? '' : html.slice(Math.max(0, i - 200), i + 500);
  ok(/down \(link down\)/.test(block), 'the panel says so as well', block.slice(0, 120));
  ok(/fp-down/.test(block), 'and paints it down, because a cut cable is a fault, not an empty socket');

  const titles = canvasTitles(JSON.parse(JSON.stringify(env.t.serialize())));
  const t = titles.filter(function (s) { return s.indexOf(env.cabled.name + ' ') === 0; })[0] || '';
  ok(/down \(link down\)/.test(t), 'and so does the canvas tooltip', t);

  const res = env.sim.ping('r1', ethPorts(env.r2)[0].ip || '10.0.0.2', { count: 1 });
  ok(res.replies.every(function (r) { return !r.success; }), 'and nothing crosses it');
}

console.log('');
console.log('The composition makes the shared rule available:');
{
  const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  // The bare filename also appears in preloads and comments, so look at the script tags themselves.
  const tagAt = function (name) {
    const m = new RegExp('<script[^>]+src="' + name.replace('.', '\.') + '"').exec(html);
    return m ? m.index : -1;
  };
  const fp = tagAt('faceplate.js');
  const cv = tagAt('canvas.js');
  const app = tagAt('app.js');
  ok(fp !== -1 && cv !== -1 && app !== -1, 'all three scripts are loaded');
  ok(fp < cv, 'faceplate.js loads before canvas.js, so the canvas can call the rule');
  ok(cv < app, 'and canvas.js before app.js, so the status bar can too');

  const canvasSrc = fs.readFileSync(path.join(__dirname, '..', 'web', 'canvas.js'), 'utf8');
  ok(/PFFaceplate\.portState|lib\.portState/.test(canvasSrc), 'the canvas asks the shared rule');
  ok(!/iface\.enabled === false \? ' · administratively down'/.test(canvasSrc),
    'and no longer derives the status from `enabled` itself');

  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
  ok(/function portVerdict\(/.test(appSrc), 'the inspector has one place that resolves a port verdict');
  ok(/portVerdict\(d, name\)/.test(appSrc), 'and the status bar uses it');
  ok(!/\(iface\.enabled === false \? ' \(administratively down\)' : ''\)/.test(appSrc),
    'and no longer derives the status from `enabled` itself');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
