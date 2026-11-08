'use strict';
// The palette answers "do we have this device?". It could not answer "has anyone asked
// for it?" — that list lived in the issue tracker, which is why people kept filing
// requests for hardware that was already in the catalogue.
//
// The panel under the search results closes that loop. What is tested here is the
// matching rule, which has to do three things right: find a request from the same words
// a person would type, stay quiet when the catalogue already has the device (a card and
// a request for the same thing would read as "we have it and we don't"), and stay quiet
// entirely when nothing matches or no request list has arrived.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  <- ' + detail : '')); }
}

const WEB = path.join(__dirname, '..', 'web');
const appjs = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(WEB, 'style.css'), 'utf8');

const nodes = new Map();
function node(sel) {
  if (nodes.has(sel)) return nodes.get(sel);
  const n = {
    value: '', innerHTML: '', textContent: '', id: '', className: '', type: '', href: '', target: '', rel: '',
    children: [], style: {}, dataset: {}, options: { length: 2 }, selectedIndex: 0, disabled: false,
    classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    addEventListener: function () {}, setAttribute: function () {}, getAttribute: function () { return null; },
    appendChild: function (c) { n.children.push(c); return c; }, append: function () {},
    remove: function () {}, focus: function () {}, click: function () {},
    querySelector: function () { return node(sel + ' >x'); }, querySelectorAll: function () { return []; },
    closest: function () { return null; }, parentElement: null
  };
  nodes.set(sel, n);
  return n;
}
// A counter that is never reset: node() caches by key, so reusing '__el__0' after a
// reset hands back the earlier node with its children still attached, which made a
// five-row assertion see eight.
let uid = 0;
const created = [];
function anyNode() { const n = node('__el__' + (uid++)); created.push(n); return n; }

let sawRequestsCall = false;
const ctx = {
  console: console, setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval,
  encodeURIComponent: encodeURIComponent,
  fetch: function () { return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); } }); },
  document: {
    addEventListener: function () {},
    createElement: function () { return anyNode(); },
    getElementById: function () { return null; },
    querySelector: function (sel) { return node(sel); },
    querySelectorAll: function () { return []; }
  },
  window: {},
  navigator: { userAgent: 'TestAgent/1.0' },
  location: { href: 'http://localhost:8000/' },
  PFCanvas: { on: {}, setTopology: function () {}, fitView: function () {}, render: function () {}, setSelected: function () {}, setSelectedLink: function () {}, animateEvents: function () {}, zoomBy: function () {} }
};
ctx.window.PFCanvas = ctx.PFCanvas;
ctx.window.navigator = ctx.navigator;
ctx.window.location = ctx.location;
ctx.window.open = function () { return {}; };
vm.createContext(ctx);
vm.runInContext(appjs, ctx, { filename: 'app.js' });
const pf = ctx.window.__pf;

const specs = [
  { vendor: 'mikrotik', model: 'hEX Refresh (E50UG)', label: 'MikroTik hEX Refresh', category: 'router' },
  { vendor: 'aruba', model: '2530-48 (J9781A)', label: 'Aruba 2530-48', category: 'switch' }
];
const requests = [
  { number: 722, subject: 'Aruba 6000 48G 4SFP (R8N86A)', url: 'http://forge/issues/722' },
  { number: 843, subject: 'Microsoft Xbox', url: 'http://forge/issues/843' },
  { number: 583, subject: 'Mikrotik hEX Refresh Router (E50UG)', url: 'http://forge/issues/583' },
  { number: 842, subject: 'Amazon Fire TV Stick', url: 'http://forge/issues/842' }
];

console.log('Finding a request from the words someone would type:');
const aruba = pf.matchingRequests('aruba 6000', requests, specs);
ok(aruba.length === 1 && aruba[0].number === 722, 'a two-word query finds the request', JSON.stringify(aruba.map(function (r) { return r.number; })));
ok(pf.matchingRequests('xbox', requests, specs).length === 1, 'one word is enough');
ok(pf.matchingRequests('XBOX', requests, specs).length === 1, 'and case does not matter');
ok(pf.matchingRequests('fire tv', requests, specs).length === 1, 'the words do not have to be adjacent');
ok(pf.matchingRequests('r8n86a', requests, specs).length === 1, 'a model code in brackets is findable');
ok(pf.matchingRequests('aruba fire', requests, specs).length === 0, 'every word has to match, not any');

console.log('\nA request the catalogue already satisfies is not shown as a request:');
const hex = pf.matchingRequests('hex refresh', requests, specs);
ok(hex.length === 0, 'the modelled device is left to its card', JSON.stringify(hex.map(function (r) { return r.number; })));
ok(pf.matchingRequests('mikrotik', requests, specs).length === 0, 'and it does not reappear under the vendor name');

console.log('\nSilence where silence is right:');
ok(pf.matchingRequests('', requests, specs).length === 0, 'no query, no requests');
ok(pf.matchingRequests('   ', requests, specs).length === 0, 'whitespace is no query');
ok(pf.matchingRequests('zzzz', requests, specs).length === 0, 'no match, nothing shown');
ok(pf.matchingRequests('xbox', [], specs).length === 0, 'no request list yet, nothing shown');
ok(pf.matchingRequests('xbox', null, specs).length === 0, 'and a null list does not throw');
ok(pf.matchingRequests('xbox', requests, []).length === 1, 'an empty catalogue means everything is unmodelled');

console.log('\nThe panel itself:');
pf.setOpenRequests(requests);
created.length = 0;
const section = pf.renderRequestedSection('aruba', specs);
ok(!!section, 'a section is built when something matches');
ok(section && section.className === 'requested-group', 'with its own class', section && section.className);
const head = section && section.children[0];
ok(head && head.textContent === 'Requested, not yet modelled', 'and a heading that says what it is', head && head.textContent);
const item = section && section.children[1];
ok(item && item.href === 'http://forge/issues/722', 'each row links to the issue itself', item && item.href);
ok(item && item.target === '_blank' && item.rel === 'noopener', 'opened in a new tab, without handing over the opener');
ok(item && /Aruba 6000 48G 4SFP/.test(item.innerHTML), 'and names the hardware');
ok(item && /#722/.test(item.innerHTML), 'with the issue number, so it can be quoted');
ok(pf.renderRequestedSection('zzzz', specs) === null, 'nothing is built when nothing matches');
created.length = 0;
const capped = pf.renderRequestedSection('', specs);
ok(capped === null, 'and at rest the palette is a catalogue, not a changelog');

console.log('\nRow limits and escaping:');
pf.setOpenRequests([
  { number: 1, subject: 'a', url: 'u1' }, { number: 2, subject: 'a', url: 'u2' },
  { number: 3, subject: 'a', url: 'u3' }, { number: 4, subject: 'a', url: 'u4' },
  { number: 5, subject: 'a', url: 'u5' }, { number: 6, subject: 'a', url: 'u6' }
]);
const many = pf.renderRequestedSection('a', []);
ok(many && many.children.length === 6, 'at most five rows plus the heading', many && String(many.children.length));
pf.setOpenRequests([{ number: 9, subject: '<img src=x onerror=alert(1)>', url: 'u' }]);
const evil = pf.renderRequestedSection('img', []);
const evilRow = evil && evil.children[1];
ok(evilRow && evilRow.innerHTML.indexOf('<img') === -1, 'a hostile title is escaped, not rendered', evilRow && evilRow.innerHTML);
pf.setOpenRequests(requests);

console.log('\nWiring:');
ok(/api\('GET', '\/requests'\)/.test(appjs), 'the app asks the server for the request list');
ok(/openRequests = \(r && r\.requests\) \|\| \[\]/.test(appjs), 'and keeps the rows it got');
ok(/\.catch\(function \(\) \{ openRequests = \[\]; \}\)/.test(appjs), 'a failed call leaves the palette alone rather than breaking it');
ok(/if \(q\) \{\s*\n\s*const asked = renderRequestedSection/.test(appjs), 'the section only renders while searching');
ok(/\.requested-group/.test(css) && /\.requested-item/.test(css), 'both are styled');
ok(/\.requested-item:focus-visible/.test(css), 'and the rows are reachable by keyboard');

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.error('\n' + failed + ' requests-panel check(s) failed'); process.exit(1); }
console.log('\n' + passed + ' requests-panel checks passed.');
