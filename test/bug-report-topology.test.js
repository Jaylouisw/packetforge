'use strict';
// The bug report has to carry the half of the picture only the running app can see.
//
// Build, browser and caught errors were already there. What was missing was the canvas: which
// devices were on screen and what was cabled to what. Without it, "my link won't come up" costs a
// maintainer two or three round trips to establish that the cable is 1000base-sx between a switch
// SFP and a router that has no SFP at all.
//
// Two things must stay true at once, and they pull against each other:
//   1. the digest must be specific enough to reproduce from (names, ports, media, speeds)
//   2. the digest must not turn the issue URL into a 414 (a 200-device campus is not a report)
// So it is bounded by 12 model lines and 15 links, with an explicit count of what was left out -
// silently truncating is how a report ends up describing the wrong half of a lab.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; }
  else { failed++; console.log('  not ok - ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const WEB = path.join(__dirname, '..', 'web');
const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
const appjs = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');

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
vm.runInContext(appjs, ctx, { filename: 'web/app.js' });
const pf = ctx.window.__pf || {};

const lab3 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'lab3-multi-vendor-campus.json'), 'utf8'));

console.log('');
console.log('The digest is exported and reads a real lab:');
{
  ok(typeof pf.describeTopology === 'function', 'describeTopology is exported for testing');
  const d = pf.describeTopology(lab3);
  ok(Array.isArray(d) && d.length > 5, 'it returns lines, not one giant string', String(d.length));
  ok(/^Devices on the canvas \(8\):$/.test(d[0]), 'the device count is stated first', d[0]);
  ok(d.some(function (l) { return /generic\/generic-pc x2/.test(l); }), 'identical models collapse to a count');
  const linkIdx = d.findIndex(function (l) { return /^Links \(7\):$/.test(l); });
  ok(linkIdx > 0, 'the link count is stated', String(linkIdx));
  const linkLines = d.slice(linkIdx + 1);
  ok(linkLines.length === 7, 'one line per link', String(linkLines.length));
  ok(linkLines.some(function (l) { return /1000base-sx/.test(l); }), 'the medium is in the report - copper vs fibre is the first thing to check');
  ok(linkLines.some(function (l) { return /1000M/.test(l); }), 'the speed is in the report');
}

console.log('');
console.log('Device names, not internal ids:');
{
  const d = pf.describeTopology(lab3);
  const links = d.slice(d.findIndex(function (l) { return /^Links/.test(l); }) + 1);
  ok(links.some(function (l) { return /PC1:eth0/.test(l); }), 'a named device appears by its name', links[0]);
  ok(!links.some(function (l) { return /^\- [a-z]+[0-9]+:/.test(l); }), 'no link line leads with a bare internal id');
  // The minted name is "<label>-<id>"; the id is already everywhere in the report, so the suffix is
  // stripped. If that ever stops working the report reads like "PC1-d6:eth0".
  ok(!links.some(function (l) { return /PC1-d6/.test(l); }), 'the "-<id>" suffix is stripped from names');
  const withSel = pf.describeTopology(lab3, { selected: { deviceId: 'd2' } });
  ok(withSel[withSel.length - 1] === 'Selected: EDGE', 'the selected device is named, so the maintainer knows what was in the inspector', withSel[withSel.length - 1]);
}

console.log('');
console.log('An empty canvas is a fact, not a blank:');
{
  ok(pf.describeTopology({})[0] === 'Canvas: no devices.', 'no devices says so');
  ok(pf.describeTopology(null)[0] === 'Canvas: no devices.', 'and a missing topology does not throw');
  const one = { devices: [{ id: 'd1', vendor: 'acme', model: 'box', name: 'Box-d1' }], links: [] };
  const d = pf.describeTopology(one);
  ok(d.indexOf('Links: none.') !== -1, 'a device with no cables says the cable list is empty');
}

console.log('');
console.log('Both caps hold, and say what they left out:');
{
  const many = { devices: [], links: [] };
  for (let i = 0; i < 30; i++) many.devices.push({ id: 'd' + i, vendor: 'acme', model: 'model-' + i, name: 'M' + i + '-d' + i });
  const d = pf.describeTopology(many);
  const modelLines = d.filter(function (l) { return /^- acme\//.test(l); });
  ok(modelLines.length === 12, 'twelve model lines at most', String(modelLines.length));
  ok(d.some(function (l) { return l === '- ... and 18 more model(s)'; }), 'and the remainder is counted, not dropped', d[d.length - 1]);

  const wired = { devices: [{ id: 'd1', vendor: 'a', model: 'b', name: 'A-d1' }, { id: 'd2', vendor: 'a', model: 'b', name: 'B-d2' }], links: [] };
  for (let i = 0; i < 40; i++) wired.links.push({ a: { deviceId: 'd1', iface: 'e' + i }, b: { deviceId: 'd2', iface: 'e' + i }, mediaId: '1000base-t', speedMbps: 1000 });
  const w = pf.describeTopology(wired);
  const linkLines = w.filter(function (l) { return / -- /.test(l); });
  ok(linkLines.length === 15, 'fifteen link lines at most', String(linkLines.length));
  ok(w.some(function (l) { return l === '- ... and 25 more link(s)'; }), 'and the remainder is counted');
}

console.log('');
console.log('The body carries it, in a fence, under its own heading:');
{
  const body = pf.bugReportBody({
    version: '1.2.3', node: 'v22', browser: 'Chrome', page: 'http://odin:3000', devices: 2015,
    errors: [], topology: pf.describeTopology(lab3)
  });
  ok(/### What was on screen/.test(body), 'the section exists');
  ok(/```\nDevices on the canvas \(8\):/.test(body), 'the digest sits inside a fence, so Markdown cannot mangle it');
  ok(body.indexOf('### What was on screen') > body.indexOf('### Errors the app caught'), 'and it follows the errors');
  ok(body.indexOf('### Where it happened') > body.indexOf('### What was on screen'), 'and precedes the environment block');
  ok(/Catalogue: 2015 models/.test(body), 'the fields that were already there are still there');

  const noTopo = pf.bugReportBody({ errors: [] });
  ok(/Not captured/.test(noTopo), 'an app that could not read the canvas says so instead of leaving an empty fence');
  ok(!/```\n```/.test(noTopo), 'there is never an empty code fence');
}

console.log('');
console.log('The URL stays a URL:');
{
  const huge = { devices: [], links: [] };
  for (let i = 0; i < 200; i++) {
    huge.devices.push({ id: 'd' + i, vendor: 'acme', model: 'model-' + (i % 40), name: 'N' + i + '-d' + i });
    if (i) huge.links.push({ a: { deviceId: 'd' + i, iface: 'eth0' }, b: { deviceId: 'd' + (i - 1), iface: 'eth1' }, mediaId: '1000base-t', speedMbps: 1000 });
  }
  const body = pf.bugReportBody({ errors: [], topology: pf.describeTopology(huge), devices: 2015 });
  ok(body.length < 4000, 'a 200-device lab still produces a report under 4 kB', String(body.length));
  const url = pf.bugReportUrl({ title: '[Bug]: ', errors: [], topology: pf.describeTopology(huge) });
  ok(url.length < 8000, 'and the encoded URL stays well inside what a server accepts', String(url.length));
}

console.log('');
console.log('The click-without-JS path still works:');
{
  // The static anchor is the only reporting route left if app.js fails to parse. If that href ever
  // gains a placeholder that only JS can fill, the bug button breaks exactly when it is needed.
  const m = html.match(/id="btn-bug"[\s\S]{0,600}?href="([^"]+)"/);
  ok(!!m, 'the report link has a static href');
  ok(m && m[1].indexOf('git.jayw.uk/jaylouisw/packetforge/issues/new') !== -1, 'and it points at the Forge issue form', m && m[1].slice(0, 60));
  ok(!/<button[^>]*btn-bug/.test(html), 'it is still an anchor, not a button');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
