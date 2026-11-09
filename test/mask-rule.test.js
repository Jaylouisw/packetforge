'use strict';
// One mask rule, four places that used to answer it differently (#1249).
//
// Four implementations, four answers:
//
//   engine/net.js prefixOf()      leading ones      -> 255.0.255.0 is /8
//   engine/dhcp.js maskContiguous() a bit trick      -> refused the pool
//   engine/ospf.js maskPrefix()   rebuilt and compared -> null
//   web/app.js maskBits()         counted every set bit -> 255.0.255.0 is /16
//
// and the console validated none of it, so `ip address 10.9.9.9 255.0.255.0` was accepted and the panel
// then showed /16 for a port the router would route as /8 - a number with no meaning at all, in the
// inspector you open to find out why the link behaves as it does.
//
// There is a second, quieter half: `ip address 10.0.0.1 24` stored the string "24". Anything that parses a
// dotted mask - the front panel included - read that as 0.0.0.24 and printed /2.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const net = require('../engine/net');
const { Topology, Simulator, runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.filter(function (s) { return /ASR 1001-X/.test(s.model); })[0];
const ethernet = function (d) {
  return [...d.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
};

// The front panel's rule, loaded the way the browser loads it (see test/fabric-agreement.test.js).
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
  return new Proxy(base, { get: function (t, k) { return k in t ? t[k] : function () { return fakeNode(); }; }, set: function (t, k, v) { t[k] = v; return true; } });
}
const wrap = {
  _html: '', get innerHTML() { return this._html; }, set innerHTML(v) { this._html = v; },
  addEventListener: function () {}, style: {}, classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
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
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8'), ctx, { filename: 'web/app.js' });
const pf = ctx.window.__pf || {};

function configure(ip, mask) {
  const t = new Topology();
  const r = t.addDevice(ROUTER, 'r1');
  const port = ethernet(r)[0];
  const cli = new CliSession(r, t, null);
  cli.run('configure terminal');
  cli.run('interface ' + port.name);
  cli.run('ip address 10.1.2.3 255.255.255.0');        // a good address first, to see what survives
  const out = ((cli.run('ip address ' + ip + ' ' + mask).output) || []).map(String);
  return { t: t, r: r, port: port, portState: r.interfaces.get(port.name), out: out, cli: cli };
}

console.log('');
console.log('Every prefix length agrees, in both spellings:');
{
  ok(typeof pf.maskBits === 'function', 'the front panel rule is available');
  const bad = [];
  for (let bits = 0; bits <= 32; bits++) {
    const dotted = net.maskFromPrefix(bits);
    const engine = net.prefixOf(dotted);
    const ints = net.prefixOfInt(net.maskToInt(dotted));
    const ui = pf.maskBits(dotted);
    const uiShort = pf.maskBits(String(bits));
    if (engine !== bits) bad.push('engine(' + dotted + ')=' + engine);
    if (ints !== bits) bad.push('prefixOfInt(' + dotted + ')=' + ints);
    if (ui !== String(bits)) bad.push('ui(' + dotted + ')=' + ui);
    if (uiShort !== String(bits)) bad.push('ui("' + bits + '")=' + uiShort);
    if (!net.isContiguousMask(dotted)) bad.push('isContiguousMask(' + dotted + ') false');
  }
  ok(bad.length === 0, 'all 33 prefix lengths, dotted and short, engine and panel alike',
    bad.slice(0, 4).join(' | '));
}

console.log('');
console.log('A mask that is not a run of ones has no prefix length:');
{
  const invalid = ['255.0.255.0', '0.255.255.255', '255.255.255.253', '255.255.0.255', '255.255.255.7'];
  const engineBad = invalid.filter(function (m) { return net.isContiguousMask(m); });
  const uiGood = invalid.filter(function (m) { return pf.maskBits(m) !== '?'; });
  ok(engineBad.length === 0, 'the engine calls none of them contiguous', engineBad.join(' | '));
  ok(uiGood.length === 0, 'and the panel says "?" instead of a plausible number',
    invalid.map(function (m) { return m + ' -> ' + pf.maskBits(m); }).join(' | '));
  ok(pf.maskBits('255.255.255.0') === '24', 'while a real mask still reads normally', pf.maskBits('255.255.255.0'));
  ok(pf.maskBits('garbage') === '?' && pf.maskBits('') === '?', 'and junk reads as unknown');
}

console.log('');
console.log('The console refuses it, and says which argument is wrong:');
{
  const env = configure('10.9.9.9', '255.0.255.0');
  const refusal = env.out.filter(function (l) { return /^%/.test(l); })[0] || '';
  ok(!!refusal, 'the command is refused', JSON.stringify(env.out));
  ok(/Invalid mask/.test(refusal), 'naming the mask, not the address', refusal);
  ok(/255\.0\.255\.0/.test(refusal), 'quoting what was typed', refusal);
  ok(/run of ones/.test(refusal), 'and explaining the rule', refusal);
  ok(env.portState.ip === '10.1.2.3' && env.portState.mask === '255.255.255.0',
    'the previous address is untouched',
    env.portState.ip + '/' + env.portState.mask);

  const junk = configure('10.9.9.9', 'garbage');
  const junkMsg = junk.out.filter(function (l) { return /^%/.test(l); })[0] || '';
  ok(/Invalid mask/.test(junkMsg), 'a junk mask is reported as a mask', junkMsg);
  ok(!/IPv4 address/i.test(junkMsg), 'not as an address - which is what it used to say', junkMsg);

  const badIp = configure('999.1.1.1', '255.255.255.0');
  ok(badIp.out.some(function (l) { return /Invalid IPv4 address/.test(l); }),
    'and a bad address is still reported as an address', badIp.out.join(' | '));

  const badPrefix = configure('10.9.9.9', '33');
  ok(badPrefix.out.some(function (l) { return /Invalid mask/.test(l); }),
    'a prefix length out of range is a mask error too', badPrefix.out.join(' | '));
}

console.log('');
console.log('The mask is stored in one spelling:');
{
  const env = configure('10.9.9.9', '24');
  ok(env.portState.mask === '255.255.255.0',
    'configuring /24 stores the dotted mask', env.portState.mask);
  ok(net.prefixOf(env.portState.mask) === 24, 'which the engine reads as /24', String(net.prefixOf(env.portState.mask)));
  ok(pf.maskBits(env.portState.mask) === '24', 'and the panel reads as /24', pf.maskBits(env.portState.mask));
  ok(env.out.some(function (l) { return /10\.9\.9\.9\/24/.test(l); }), 'the confirmation still says /24');

  // And it survives the round trip that #1230/#1233 established.
  const cfg = ((new CliSession(env.r, env.t, null).run('show running-config').output) || []).map(String);
  const line = cfg.filter(function (l) { return /ip address/.test(l); })[0] || '';
  ok(/255\.255\.255\.0/.test(line), 'the config prints the dotted mask', line.trim());

  const t2 = new Topology();
  const r2 = t2.addDevice(ROUTER, 'r1');
  runCommands(r2, t2, null, ['configure terminal'].concat(cfg));
  const port2 = ethernet(r2)[0];
  const back = r2.interfaces.get(port2.name);
  ok(back.ip === '10.9.9.9' && back.mask === '255.255.255.0', 'and replays to the same address and mask',
    back.ip + '/' + back.mask);
}

console.log('');
console.log('DHCP and OSPF still refuse what they refused, through the shared rule:');
{
  const dhcp = require('../engine/dhcp');
  const pool = {
    name: 'lan1', network: '10.0.0.0', mask: '255.255.255.0',
    rangeStart: '10.0.0.10', rangeEnd: '10.0.0.20', gateway: '10.0.0.1',
    dns: ['10.0.0.1'], reservations: {}, excluded: [], leaseSec: 600
  };
  const messages = function (r) {
    return (r.errors || []).map(function (e) { return (e && e.message) || String(e); }).join(' | ');
  };
  const good = dhcp.validatePool(pool);
  ok(!/contiguous/.test(messages(good)), 'a /24 pool validates', messages(good));
  const bad = dhcp.validatePool(Object.assign({}, pool, { mask: '255.0.255.0' }));
  ok(/not a valid contiguous IPv4 mask/.test(messages(bad)),
    'a non-contiguous pool mask is refused', messages(bad));

  const ospf = require('../engine/ospf');
  ok(ospf.maskPrefix('255.255.255.0') === 24, 'OSPF reads a /24', String(ospf.maskPrefix('255.255.255.0')));
  ok(ospf.maskPrefix('255.0.255.0') === null, 'and refuses a non-contiguous mask', String(ospf.maskPrefix('255.0.255.0')));
  ok(ospf.maskPrefix('') === null && ospf.maskPrefix(null) === null, 'as it does an absent one');

  // One predicate: the three modules must answer identically for every mask int a caller can hold.
  const disagreements = [];
  for (let bits = 0; bits <= 32; bits++) {
    const m = net.maskToInt(net.maskFromPrefix(bits)) >>> 0;
    if (!net.isContiguousMask(m)) disagreements.push(bits + ': shared says not contiguous');
    if (ospf.maskPrefix(net.maskFromPrefix(bits)) !== bits) disagreements.push(bits + ': ospf disagrees');
  }
  ok(disagreements.length === 0, 'and every prefix length agrees across all three callers',
    disagreements.slice(0, 3).join(' | '));
}

console.log('');
console.log('A lab saved before the check still renders, and says it cannot say:');
{
  // The reachable case this leaves room for: a topology file written by hand (or by an older build) that
  // carries a mask the console would now refuse. It must not take the UI or the tables down, and it must
  // not be summarised into a confident prefix length.
  const env = configure('10.1.2.3', '255.255.255.0');
  env.portState.mask = '255.0.255.0';
  ok(pf.maskBits(env.portState.mask) === '?', 'the panel shows "?" for it', pf.maskBits(env.portState.mask));
  ok(!net.isContiguousMask(env.portState.mask), 'and the engine agrees it is not a netmask');
  const brief = ((new CliSession(env.r, env.t, null).run('show ip interface brief').output) || [])
    .map(String).join('\n');
  ok(brief.length > 0, 'the tables still print');
  ok(/10\.1\.2\.3/.test(brief), 'with the address on the row', brief.split('\n').slice(-1)[0]);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
