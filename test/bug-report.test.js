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
console.log('\nThe control is in the app, in the top bar, with a name:');
const btn = (html.match(/<a[^>]*id="btn-bug"[^>]*>([\s\S]*?)<\/a>/) || []);
ok(btn.length > 0, 'index.html declares a #btn-bug control');
const btnTag = btn[0] || '';
ok(/aria-label="[^"]+"/.test(btnTag), 'it has an accessible name (aria-label)');
ok(/title="[^"]+"/.test(btnTag), 'it explains itself on hover (title)');
ok(/Report a bug/i.test(btn[1] || ''), 'it is labelled in words, not an icon alone');
const topbar = (html.match(/<div class="topbar-actions">([\s\S]*?)<\/div>/) || ['', ''])[1];
ok(topbar.indexOf('btn-bug') !== -1, 'it lives in the top bar, not behind a menu');
ok(appjs.indexOf("$('#btn-bug')") !== -1, 'app.js binds a click handler to it');

// --- the case that matters most: the app is what broke ---------------------
// A button that only works when JavaScript runs cannot report "the page is blank".
// The control is an anchor with a real href, so the reporting path survives the
// failure it exists to report.
console.log('\nReporting still works when the script does not:');
const href = (btnTag.match(/href="([^"]+)"/) || [])[1] || '';
ok(href.length > 0, 'the control is an anchor with a static href, not a script-only button');
ok(/^https:\/\/git\.jayw\.uk\/jaylouisw\/packetforge\/issues\/new\?title=/.test(href),
  'the static href opens the new-issue form directly');
ok(btnTag.indexOf('target="_blank"') !== -1, 'it opens in a new tab, leaving the app open');
ok(/rel="noopener"/.test(btnTag), 'and it does not hand the issue tracker window.opener');
const staticBody = decodeURIComponent((href.split('&body=')[1] || ''));
ok(staticBody.indexOf('### What happened') !== -1, 'the static form still asks what happened');
ok(staticBody.indexOf('### Steps to reproduce') !== -1, 'and still asks for reproduction steps');
ok(staticBody.indexOf('undefined') === -1 && staticBody.indexOf('null') === -1,
  'the static form contains no undefined or null');
ok(/<button[^>]*id="btn-bug"/.test(html) === false, 'it is not a <button>, which would be inert without app.js');
ok(/preventDefault/.test(appjs), 'the handler takes over from the anchor rather than firing twice');

// --- a blocked popup must still leave the reporter somewhere to go ---------
// The first version of this button toasted "the link is in the console" and wrote
// nothing there, so a popup blocker turned reporting into a dead end. Drive the
// real handler with window.open returning null and assert the URL was emitted.
function makeCtx(openResult, warnSink) {
  const c = {
    console: { log: function () {}, error: console.error, warn: function (m) { warnSink.push(m); } },
    setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval,
    encodeURIComponent: encodeURIComponent,
    fetch: function () { return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ version: '0.1.0', node: 'v20.0.0', platform: 'linux/x64' }); } }); },
    document: { addEventListener: function () {}, querySelector: function () { return fakeNode(); }, querySelectorAll: function () { return []; } },
    // A listener registry, so the tests can fire the events the browser would fire at us.
    window: { __listeners: {}, addEventListener: function (name, fn) { (this.__listeners[name] = this.__listeners[name] || []).push(fn); } },
    navigator: { userAgent: 'TestAgent/1.0' },
    location: { href: 'http://localhost:8000/' },
    PFCanvas: { on: {}, setTopology: function () {}, fitView: function () {}, render: function () {}, setSelected: function () {}, setSelectedLink: function () {}, animateEvents: function () {}, zoomBy: function () {} }
  };
  c.window.PFCanvas = c.PFCanvas;
  c.window.navigator = c.navigator;
  c.window.location = c.location;
  c.window.encodeURIComponent = encodeURIComponent;
  c.window.open = function () { return openResult; };
  vm.createContext(c);
  vm.runInContext(appjs, c, { filename: 'app.js' });
  return c;
}

function finish() {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.error('\n' + failed + ' bug-report check(s) failed'); process.exit(1); }
  console.log('\n' + passed + ' bug-report checks passed.');
}

(async function () {
  console.log('\nA blocked popup still leaves a usable report:');
  const warned = [];
  const blocked = makeCtx(null, warned);
  const ret = await blocked.window.__pf.openBugReport();
  ok(typeof ret === 'string' && ret.indexOf('/issues/new?title=') !== -1,
    'the handler returns the prefilled issue URL even when the window is blocked');
  ok(warned.length > 0, 'the URL is actually written somewhere the user can copy it');
  ok(warned.join(' ').indexOf('/issues/new') !== -1, 'what is logged is the report link, not a promise of one');
  ok(warned.join(' ').indexOf('undefined') === -1, 'the logged link contains no undefined fields');

  const opened = [];
  const allowed = makeCtx({}, opened);
  const ret2 = await allowed.window.__pf.openBugReport();
  ok(ret2.indexOf('/issues/new') !== -1, 'the same handler returns the URL when the window does open');

  // The part the reporter cannot know: what the app was doing when it broke. The browser
  // hands this over for free and it is discarded unless something is listening, which is why
  // this project's reports used to say "it doesn't work" and nothing else.
  console.log('\nErrors the app caught go into the report:');
  const pf = makeCtx({}, []).window.__pf;

  const clean = pf.bugReportBody({ version: '1.0.0', errors: [] });
  ok(clean.indexOf('### Errors the app caught') !== -1, 'the report has a section for caught errors');
  ok(clean.indexOf('None since the page loaded') !== -1,
    'with nothing caught it says so, rather than leaving the section blank');

  pf.recordError('error', 'x is not a function', { where: 'app.js:120:9', detail: 'TypeError: x is not a function\n    at render (app.js:120:9)' });
  const one = pf.bugReportBody({ version: '1.0.0', errors: pf.recentErrors });
  ok(one.indexOf('x is not a function') !== -1, 'a caught error appears in the body');
  ok(one.indexOf('app.js:120:9') !== -1, 'and so does where it happened');
  ok(one.indexOf('at render') !== -1, 'the stack makes it into the body');
  ok(one.indexOf('None since the page loaded') === -1, 'the "none" line is gone once there is something to report');

  for (let i = 0; i < 20; i++) pf.recordError('error', 'loop failure ' + i);
  ok(pf.recentErrors.length === 5, 'the buffer is bounded at five, so a throwing loop cannot bloat the report');
  ok(pf.bugReportBody({ errors: pf.recentErrors }).indexOf('loop failure 19') !== -1, 'the newest error is kept');
  ok(pf.bugReportBody({ errors: pf.recentErrors }).indexOf('loop failure 0') === -1, 'the oldest is dropped');

  const huge = pf.recordError('error', 'boom', { detail: 'a\nb\nc\nd\ne\nf\ng' });
  ok(huge.detail.split('\n').length === 4, 'a stack is truncated to four frames, so one bad error cannot produce a 2 MB issue');

  const missing = pf.bugReportBody({ errors: [{}] });
  ok(missing.indexOf('unknown error') !== -1, 'a malformed error still renders instead of printing undefined');
  ok(missing.indexOf('undefined') === -1, 'and nothing in the body says undefined');

  // The listeners themselves, fired the way a browser would fire them.
  const live = makeCtx({}, []);
  ok(live.window.__pf.installErrorCapture() === true, 'capture installs when the window can be listened to');
  ok((live.window.__listeners.error || []).length === 1, 'an error listener is registered');
  ok((live.window.__listeners.unhandledrejection || []).length === 1, 'and one for unhandled rejections');

  live.window.__listeners.error[0]({ message: 'x is not a function', filename: 'app.js', lineno: 42, colno: 7, error: { stack: 'TypeError\n    at render' } });
  ok(live.window.__pf.recentErrors.length === 1, 'a thrown error is caught');
  ok(live.window.__pf.recentErrors[0].where === 'app.js:42:7', 'it records file, line and column - the first thing anyone asks for');
  ok(live.window.__pf.recentErrors[0].detail.indexOf('at render') !== -1, 'the stack is kept');

  live.window.__listeners.unhandledrejection[0]({ reason: new Error('promise gave up') });
  ok(live.window.__pf.recentErrors[1].kind === 'unhandled rejection', 'a rejected promise is caught under its own name');
  ok(live.window.__pf.recentErrors[1].message === 'promise gave up', 'and with its message');

  live.window.__listeners.error[0]({ target: { tagName: 'IMG', src: '/missing.png' } });
  ok(live.window.__pf.recentErrors[2].where.indexOf('/missing.png') !== -1,
    'a missing asset is recorded with the URL that failed, since it has no stack');

  const dead = makeCtx({}, []);
  dead.window.addEventListener = undefined;
  ok(dead.window.__pf.installErrorCapture() === false,
    'installErrorCapture reports honestly when the window cannot be listened to');
  ok(typeof makeCtx({}, []).window.__pf.installErrorCapture === 'function',
    'the capture hook is installed by boot, not by a separate entry point');

  finish();
})();

