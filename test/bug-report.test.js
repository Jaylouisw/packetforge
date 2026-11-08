'use strict';
// Bug reporting is a feature with a contract: one click from the app produces an
// issue that already contains what the person reporting it cannot reasonably be
// asked to find - the build, the Node version, the browser, the page.
//
// The failure mode this guards against is quiet and expensive: a report form that
// silently loses a field. Nobody notices at the time, and the report arrives
// months later with "Browser: undefined" in it and gets closed as
// cannot-reproduce. So the builder is pure, it is tested directly, and the
// fallbacks are tested too.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const WEB = path.join(__dirname, '..', 'web');
const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
const appjs = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');

// --- load the real app.js in a stub DOM, as ui-render.test.js does ----------
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
    get: function (t, k) { if (k in t) return t[k]; return function () { return fakeNode(); }; },
    set: function (t, k, v) { t[k] = v; return true; }
  });
}

const ctx = {
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  setInterval: setInterval,
  encodeURIComponent: encodeURIComponent,
  fetch: function () { return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); } }); },
  document: {
    addEventListener: function () {},
    querySelector: function () { return fakeNode(); },
    querySelectorAll: function () { return []; }
  },
  window: {},
  navigator: { userAgent: 'TestAgent/1.0 (contract test)' },
  location: { href: 'http://localhost:8000/' },
  PFCanvas: {
    on: {}, setTopology: function () {}, fitView: function () {}, render: function () {},
    setSelected: function () {}, setSelectedLink: function () {},
    animateEvents: function () {}, zoomBy: function () {}
  }
};
ctx.window.PFCanvas = ctx.PFCanvas;
ctx.window.navigator = ctx.navigator;
ctx.window.location = ctx.location;
ctx.window.open = function () { return {}; };
ctx.window.encodeURIComponent = encodeURIComponent;
vm.createContext(ctx);
vm.runInContext(appjs, ctx, { filename: 'app.js' });

const pf = ctx.window.__pf;
ok(!!pf, 'app.js loaded and exposed its test surface');
ok(typeof pf.bugReportUrl === 'function', 'the report builder is exposed (bugReportUrl)');
ok(typeof pf.bugReportBody === 'function', 'the report body builder is exposed (bugReportBody)');

// --- the link goes to this project's tracker, not a mirror -----------------
console.log('\nThe report goes to the tracker that reads it:');
ok(/^https:\/\/git\.jayw\.uk\//.test(pf.issueUrl || ''),
  'issue base URL points at the Forgejo instance', pf.issueUrl);
ok(!/github\.com/.test(pf.issueUrl || ''),
  'issue base URL is not the retired GitHub mirror');
ok(/\/issues\/new$/.test(pf.issueUrl || ''), 'issue base URL ends at the new-issue form');

// --- what a filled-in report contains -------------------------------------
console.log('\nA report carries the environment the reporter cannot be asked for:');
const env = {
  title: '[Bug]: ping fails between two switches',
  version: '0.1.0 (abc1234)',
  node: 'v20.11.0 on win32/x64',
  browser: 'Firefox/121.0',
  page: 'http://localhost:8000/',
  devices: 1042
};
const body = pf.bugReportBody(env);
ok(body.indexOf('### What happened') !== -1, 'asks what happened');
ok(body.indexOf('### Steps to reproduce') !== -1, 'asks for reproduction steps');
ok(body.indexOf('ab c1234') === -1 && body.indexOf('abc1234') !== -1, 'records the build');
ok(body.indexOf('v20.11.0') !== -1, 'records the Node version');
ok(body.indexOf('Firefox/121.0') !== -1, 'records the browser');
ok(body.indexOf('1042 models') !== -1, 'records the catalogue size');

const url = pf.bugReportUrl(env);
ok(url.indexOf('?title=') !== -1 && url.indexOf('&body=') !== -1, 'the form is pre-filled via title and body parameters');
ok(url.indexOf(' ') === -1, 'the prefilled URL is fully encoded (no raw spaces)');
ok(decodeURIComponent(url.split('&body=')[1]).indexOf('Firefox/121.0') !== -1,
  'the encoded body decodes back to the report text');
ok(decodeURIComponent(url.split('?title=')[1].split('&')[0]) === env.title,
  'the encoded title decodes back to the title');

// --- the idiotproof part: missing information never becomes "undefined" ----
console.log('\nMissing information degrades to "unknown", never to "undefined":');
const bare = pf.bugReportBody({});
ok(bare.indexOf('undefined') === -1, 'an empty environment produces no "undefined"');
ok(bare.indexOf('null') === -1, 'an empty environment produces no "null"');
ok((bare.match(/unknown/g) || []).length >= 4, 'unset fields are spelled out as unknown');
ok(pf.bugReportUrl({}).indexOf('body=') !== -1, 'a report can still be opened with no environment at all');

// --- one click, and it is reachable ---------------------------------------
console.log('\nThe button is in the app, in the top bar, with a name:');
const btn = (html.match(/<button[^>]*id="btn-bug"[^>]*>([\s\S]*?)<\/button>/) || []);
ok(btn.length > 0, 'index.html declares a #btn-bug button');
const btnTag = btn[0] || '';
ok(/aria-label="[^"]+"/.test(btnTag), 'the button has an accessible name (aria-label)');
ok(/title="[^"]+"/.test(btnTag), 'the button explains itself on hover (title)');
ok(/Report a bug/i.test(btn[1] || ''), 'the button is labelled in words, not an icon alone');
const topbar = (html.match(/<div class="topbar-actions">([\s\S]*?)<\/div>/) || ['', ''])[1];
ok(topbar.indexOf('btn-bug') !== -1, 'the button lives in the top bar, not behind a menu');
ok(appjs.indexOf("$('#btn-bug')") !== -1, 'app.js binds a click handler to it');

if (failed) { console.error('\n' + failed + ' bug-report check(s) failed'); process.exit(1); }
console.log('\n' + passed + ' bug-report checks passed.');
