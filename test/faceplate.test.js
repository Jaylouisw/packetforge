'use strict';
// The faceplate must be readable where the canvas is not.
//
// On a 48-port switch the canvas draws 48 indistinguishable dots in two columns and
// hides the labels until you select the device. You can see that ports exist but not
// which socket is which, so the drawing stops being a tool.
//
// web/faceplate.js renders the front panel instead: numbered sockets, copper first,
// fibre cages at the end, wrapping into rows of twelve the way the silkscreen does.
// This loads the real module in a stub window and asserts on the HTML it produces
// from devices serialised by the real engine — every port once, in hardware order,
// with its connector family, its link state and its LLDP neighbour.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

// --- load the real module the way the browser will -------------------------
const sandbox = { console: console, window: {} };
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '..', 'web', 'faceplate.js'), 'utf8'),
  sandbox,
  { filename: 'faceplate.js' }
);
const FP = sandbox.window.PFFaceplate;

// --- helpers ---------------------------------------------------------------
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(v, m) {
  const s = catalog.find(function (x) { return x.vendor === v && x.model === m; });
  if (!s) throw new Error('missing spec ' + v + '/' + m);
  return s;
}
const CELL_RE = /<button type="button" class="fp-port[^"]*"[^>]*>/g;
function cells(html) { return html.match(CELL_RE) || []; }
function countOf(haystack, needle) { return haystack.split(needle).length - 1; }
// The markup for one port: the whole <button> … </button> that carries data-port.
function cellFor(html, name) {
  const at = html.indexOf('data-port="' + name + '"');
  if (at < 0) return '';
  const start = html.lastIndexOf('<button', at);
  const end = html.indexOf('</button>', at);
  return html.slice(start, end + 9);
}
function groupFor(html, cage) {
  const at = html.indexOf('data-cage="' + cage + '"');
  if (at < 0) return '';
  const start = html.lastIndexOf('<section', at);
  if (start < 0) return '';
  const end = html.indexOf('</section>', start);
  return html.slice(start, end + 10);
}
function rowsOf(groupHtml) { return groupHtml.match(/<div class="fp-row [^"]*">/g) || []; }

// --- a real 48-port switch, cabled, with one port shut down ---------------
const t = new Topology();
const sw = t.addDevice(spec('aruba', 'CX 6000 48G 4SFP'));
sw.name = 'SW48';
const pc = t.addDevice(spec('generic', 'generic-pc'));
pc.name = 'PC-LAB-7';
sw.interfaces.get('1/1/1').ip = '10.0.0.2';
sw.interfaces.get('1/1/1').mask = '255.255.255.0';
pc.interfaces.get('eth0').ip = '10.0.0.1';
pc.interfaces.get('eth0').mask = '255.255.255.0';
t.connect(pc.id, 'eth0', sw.id, '1/1/1');
runCommands(sw, t, null, ['enable', 'configure terminal', 'interface 1/1/5', 'shutdown']);
new Simulator(t).ping(pc.id, '10.0.0.99');          // makes LLDP actually cross the link
const topo = JSON.parse(JSON.stringify(t.serialize()));
const swState = topo.devices.find(function (d) { return d.name === 'SW48'; });

console.log('The module is a self-contained, dependency-free IIFE:');
ok(!!FP, 'window.PFFaceplate is exposed');
ok(FP && typeof FP.render === 'function', 'render(device) is a function');
ok(FP && typeof FP.plan === 'function' && typeof FP.bind === 'function' && typeof FP.mount === 'function',
  'plan / bind / mount helpers are exposed');
ok(FP && FP.fmtRate(1000) === '1G', 'fmtRate(1000) === "1G"');
ok(FP && FP.fmtRate(2500) === '2.5G', 'fmtRate(2500) === "2.5G"');
ok(FP && FP.fmtRate(100) === '100M', 'fmtRate(100) === "100M"');
ok(FP && FP.fmtRate(400000) === '400G', 'fmtRate(400000) === "400G"');
ok(FP && FP.cageLabel('sfp+') === 'SFP+', 'cageLabel("sfp+") === "SFP+"');
ok(FP && FP.cageLabel('qsfpdd') === 'QSFP-DD', 'cageLabel("qsfpdd") === "QSFP-DD"');
ok(FP && FP.cageLabel('nonsense') === 'Connector unknown', 'an unknown connector is drawn as unknown, not guessed');

console.log('\nA 48-port switch renders every port exactly once:');
const html = FP.render(swState, { topology: topo });
const allCells = cells(html);
ok(allCells.length === 52, '52 sockets drawn for 48 copper + 4 SFP (' + allCells.length + ')');
ok(countOf(html, 'data-port-count="52"') === 1, 'the panel declares its port count');
let dupes = [];
swState.interfaces.forEach(function (i) {
  const n = countOf(html, 'data-port="' + i.name + '"');
  if (n !== 1) dupes.push(i.name + '×' + n);
});
ok(dupes.length === 0, 'every interface appears exactly once' + (dupes.length ? ' (' + dupes.join(', ') + ')' : ''));
ok(countOf(html, 'data-device-id="' + swState.id + '"') === 53, 'each socket knows its device (52 + the panel root)');

console.log('\nPorts are grouped copper first, then the fibre cages:');
const groups = FP.plan(swState);
ok(groups.length === 2, 'two physical groups (' + groups.map(function (g) { return g.cage; }).join(', ') + ')');
ok(groups[0].cage === 'rj45' && groups[0].family === 'copper', 'the first group is the RJ45 block');
ok(groups[1].cage === 'sfp' && groups[1].family === 'fibre', 'the second group is the SFP cages');
ok(groups[0].ports.length === 48 && groups[1].ports.length === 4, '48 copper + 4 fibre');
ok(html.indexOf('data-family="copper"') < html.indexOf('data-family="fibre"'),
  'copper is rendered before fibre');
// The socket order itself must be 48 copper then 4 fibre - nothing interleaved.
const cageSeq = allCells.map(function (c) { return /data-cage="([^"]+)"/.exec(c)[1]; });
const firstFibreAt = cageSeq.indexOf('sfp');
ok(firstFibreAt === 48, 'the first fibre cage is socket 49 (' + firstFibreAt + ')');
ok(cageSeq.slice(firstFibreAt).every(function (c) { return c === 'sfp'; }),
  'no copper socket reappears among the cages');
const copperGroup = groupFor(html, 'rj45');
const fibreGroup = groupFor(html, 'sfp');
ok(/data-count="48"/.test(copperGroup), 'the copper group says how many it has');
ok(/data-count="4"/.test(fibreGroup) && !/data-cage="rj45"/.test(fibreGroup),
  'the fibre group is just the cages');

console.log('\n48 ports must wrap into rows, not one long line:');
const copperRows = rowsOf(copperGroup);
ok(copperRows.length === 4, 'four rows of twelve (' + copperRows.length + ')');
ok(copperRows.every(function (r) { return /fp-cols-12/.test(r); }),
  'every copper row is twelve wide, not one long line');
const copperRowCells = copperGroup.split('<div class="fp-row ').slice(1).map(function (r) { return cells(r).length; });
ok(copperRowCells.every(function (n) { return n === 12; }),
  'each copper row holds twelve sockets (' + copperRowCells.join(',') + ')');
ok(cells(fibreGroup).length === 4 && rowsOf(fibreGroup).length === 1,
  'the four SFP cages sit together in one row');

console.log('\nA 24-port switch is two rows of twelve:');
const t24 = new Topology();
const sw24 = t24.addDevice(spec('aruba', 'CX 6000 24G CL4 PoE 4SFP 370W'));
sw24.name = 'SW24';
const sw24State = JSON.parse(JSON.stringify(t24.serialize())).devices[0];
const html24 = FP.render(sw24State);
const g24 = groupFor(html24, 'rj45');
ok(cells(g24).length === 24, '24 copper sockets');
ok(rowsOf(g24).length === 2, 'wrapped into two rows (' + rowsOf(g24).length + ')');
ok(rowsOf(g24).every(function (r) { return /fp-cols-12/.test(r); }), 'of twelve');

console.log('\nThe silkscreen numbers the sockets, the tooltip gives the full name:');
const port1 = cellFor(html, '1/1/1');
ok(/class="fp-port-name">1</.test(port1), 'port 1/1/1 is labelled "1" like the panel');
ok(/data-port="1\/1\/1"/.test(port1), 'while the data attribute keeps the engine name');
ok(/data-port="1\/1\/42"/.test(html) && /class="fp-port-name">42</.test(html), 'port 42 is labelled 42');
ok(/class="fp-port-name">49</.test(html), 'the first SFP is numbered 49, continuing the panel');

console.log('\nConnector family is a CSS hook, never inline colour:');
const cages = allCells.map(function (c) { const m = /data-cage="([^"]+)"/.exec(c); return m && m[1]; });
ok(cages.every(function (c) { return c === 'rj45' || c === 'sfp'; }), 'copper cells are data-cage="rj45", cages are "sfp"');
ok(!/style=/.test(html), 'no inline styles are emitted');
ok(!/#[0-9a-fA-F]{3,8}\b/.test(html), 'no hex colours are baked into the markup');
ok(!/\brgba?\(|\bhsla?\(/.test(html), 'no rgb()/hsl() values either - the stylesheet owns the theme');
ok(/class="fp-key" data-cage="rj45"/.test(html), 'the legend uses the same cage hooks');

console.log('\nA cabled port says it is cabled, and to what:');
ok(/data-state="cabled"/.test(port1), 'data-state="cabled"');
ok(/fp-cabled/.test(port1), 'carries the fp-cabled class');
ok(/cabled to PC-LAB-7:eth0/.test(port1), 'the tooltip names the far end (PC-LAB-7:eth0)');
const port2 = cellFor(html, '1/1/2');
// This used to read `data-state="up"` with the tooltip "not cabled" - which was the bug (#1238): an
// empty socket cannot carry a frame, and the panel that says "up" is the panel you trust when a link
// will not come up. "notconnect" is the vendor word for exactly this state.
ok(/data-state="notconnect"/.test(port2), 'an empty socket is notconnect');
ok(/down \(no cable\)/.test(port2), 'and its tooltip says why (down (no cable))');
ok(!/fp-down/.test(port2), 'it is not painted as a fault - 46 red ports on a 48-port switch is not a signal');
ok(!/fp-cabled/.test(port2), 'and is not marked cabled');

console.log('\nAn administratively down port is visibly down:');
const port5 = cellFor(html, '1/1/5');
ok(/data-state="down"/.test(port5), 'data-state="down"');
ok(/fp-down/.test(port5), 'carries the fp-down class');
ok(/administratively down/.test(port5), 'the tooltip says why it is down');
ok(!/data-state="down"/.test(cellFor(html, '1/1/6')), 'its neighbours are still up');

console.log('\nThe LLDP neighbour is what is really in the socket:');
const port1Bare = cellFor(FP.render(swState), '1/1/1');   // no topology: only the frame knows
ok(/PC-LAB-7/.test(port1Bare), 'the neighbour name appears even without the topology');
ok(/LLDP PC-LAB-7:eth0/.test(port1Bare), 'as "LLDP name:port"');
ok(/data-lldp="PC-LAB-7"/.test(port1Bare), 'and is exposed as data-lldp for the host UI');
ok(!/data-lldp=/.test(cellFor(FP.render(swState), '1/1/2')), 'a port that heard nothing has no neighbour');

console.log('\nPoE is drawn where the hardware provides it:');
const tPoe = new Topology();
const swPoe = tPoe.addDevice(spec('aruba', 'CX 6000 48G CL4 PoE 4SFP 370W'));
swPoe.name = 'SWP';
const phone = tPoe.addDevice(spec('generic', 'generic-pc'));
phone.name = 'PHONE1';
tPoe.connect(phone.id, 'eth0', swPoe.id, '1/1/1');
const poeTopo = JSON.parse(JSON.stringify(tPoe.serialize()));
const poeState = poeTopo.devices.find(function (d) { return d.name === 'SWP'; });
const poeHtml = FP.render(poeState, { topology: poeTopo });
const poePort = cellFor(poeHtml, '1/1/1');
ok(/fp-poe/.test(poePort), 'a powered socket is flagged fp-poe');
ok(/PoE out 15\.4 W/.test(poePort), 'the tooltip states the PoE budget drawn (15.4 W)');
ok(/class="fp-port-flag"[^>]*>P</.test(poePort), 'and a "P" chip marks it on the panel');
ok(!/fp-poe/.test(cellFor(poeHtml, '1/1/9')), 'an empty socket is not flagged powered');
ok(/PoE out 15\.4 W \(capable\)/.test(cellFor(poeHtml, '1/1/9')), 'but still reports that it could power something');

console.log('\nThe panel degrades instead of throwing:');
ok(/no physical ports/i.test(FP.render({ id: 'x', name: 'X', interfaces: [] })),
  'a device with no interfaces says so');
ok(/No device selected/.test(FP.render(null)), 'a missing device says so');
// Logical subinterfaces are not sockets on a front panel.
const withSub = {
  id: 'd1', name: 'R1',
  interfaces: [
    { name: 'Gi0/0', cage: 'rj45', speedCaps: [1000], enabled: true },
    { name: 'Gi0/0.20', cage: 'rj45', speedCaps: [1000], enabled: true, parent: 'Gi0/0' }
  ]
};
const subHtml = FP.render(withSub);
ok(cells(subHtml).length === 1 && !/Gi0\/0\.20/.test(subHtml), 'subinterfaces are not drawn as sockets');
ok(/data-cage="unknown"/.test(FP.render({ id: 'd2', name: 'D2', interfaces: [{ name: 'p1', enabled: true }] })),
  'a port with no connector is drawn as unknown, not as copper');

console.log('\nNames are escaped, so a device cannot inject markup:');
const evil = FP.render({
  id: 'x" onload="y', name: '<img src=x onerror=alert(1)>',
  interfaces: [{ name: '1<2', cage: 'rj45', speedCaps: [1000], enabled: true }]
});
ok(!/<img/.test(evil), 'the device name is escaped');
ok(/&lt;img src=x/.test(evil), 'and appears as text');
ok(/data-port="1&lt;2"/.test(evil), 'so is the port name');
ok(!/onload="y"/.test(evil), 'attribute quoting survives a hostile id');

console.log('\nClicks are delegated from data attributes:');
let listener = null;
let removed = null;
const rootEl = {
  dataset: { deviceId: 'd1' },
  addEventListener: function (type, fn) { listener = fn; },
  removeEventListener: function (type, fn) { removed = fn; }
};
let hit = null;
const unbind = FP.bind(rootEl, function (info) { hit = info; });
ok(typeof listener === 'function', 'bind() attaches one click listener');
listener({ target: { closest: function (sel) { return sel === '.fp-port' ? { dataset: { port: '1/1/7', iface: '1/1/7', cage: 'sfp', state: 'up' } } : null; } } });
ok(hit && hit.port === '1/1/7' && hit.cage === 'sfp', 'the handler receives the port that was clicked (' + (hit && hit.port) + ')');
ok(hit && hit.deviceId === 'd1', 'and the device it belongs to');
hit = null;
listener({ target: { closest: function () { return null; } } });
ok(hit === null, 'a click elsewhere in the panel is ignored');
unbind();
ok(removed === listener, 'unbind() removes the listener it added');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
