'use strict';
// GET /api/requests exists so the app can answer "has someone already asked for this,
// and is it in yet?" — the question that led sixty-plus people to file requests for
// hardware already in the catalogue, because the catalogue and the backlog were
// separate worlds.
//
// Two properties matter more than the happy path, and both are tested here:
//   * a forge that is down produces "unavailable", never a fabricated empty list that
//     reads as "nobody has asked for anything";
//   * the endpoint never invents a request — only issues that really are device
//     requests are returned.
const path = require('path');
const {
  requestSubject, isDeviceRequest, toRequest, fetchOpenRequests, createRequestCache, TTL_MS
} = require(path.join(__dirname, '..', 'server', 'requests.js'));

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  <- ' + detail : '')); }
}

function issue(number, title, extra) {
  return Object.assign({ number: number, title: title, created_at: '2026-11-08T06:21:55Z', comments: 0 }, extra || {});
}

function fakeFetch(pages) {
  const calls = [];
  const fn = async function (url) {
    calls.push(url);
    const page = Number(/[?&]page=(\d+)/.exec(url)[1]);
    const body = pages[page - 1] || [];
    return { ok: true, status: 200, json: async function () { return body; } };
  };
  fn.calls = calls;
  return fn;
}

(async function () {
  console.log('The subject keeps a bracketed model code:');
  ok(requestSubject('[Device]: HUAWEI 4G Mobile WiFi 3 (E5785) — the 5GHz one') === 'HUAWEI 4G Mobile WiFi 3 (E5785)',
    'a model code in brackets survives the dash cut', requestSubject('[Device]: HUAWEI 4G Mobile WiFi 3 (E5785) — the 5GHz one'));
  ok(requestSubject('[Device]: TP-Link ER605 — Omada VPN router') === 'TP-Link ER605', 'the explanation after the dash is dropped');
  ok(requestSubject('[Hardware]: something: with a colon') === 'something', 'a colon ends the subject');
  ok(requestSubject('no prefix at all') === 'no prefix at all', 'an unprefixed title is left alone');
  ok(requestSubject(null) === '', 'null does not throw');

  console.log('\nOnly device requests are requests:');
  ok(isDeviceRequest('[Device]: x') === true, '[Device] counts');
  ok(isDeviceRequest('[Hardware]: x') === true, '[Hardware] counts');
  ok(isDeviceRequest('Something broke in the canvas') === false, 'a bug report is not a device request');
  ok(isDeviceRequest(null) === false, 'null is not a device request');

  console.log('\nA request carries everything the UI needs:');
  const one = toRequest(issue(722, '[Device]: Aruba 6000 48G 4SFP (R8N86A) — not modelled'), 'http://odin:3000', 'jaylouisw/packetforge');
  ok(one.number === 722, 'the issue number');
  ok(one.subject === 'Aruba 6000 48G 4SFP (R8N86A)', 'the parsed subject, not the essay', one.subject);
  ok(one.url === 'http://odin:3000/jaylouisw/packetforge/issues/722', 'a link to the issue itself', one.url);
  ok(one.title.indexOf('[Device]') === 0, 'and the original title, for a tooltip');
  const trailingSlash = toRequest(issue(1, '[Device]: x'), 'http://odin:3000/', 'o/r');
  ok(trailingSlash.url === 'http://odin:3000/o/r/issues/1', 'a trailing slash on the base URL does not double up', trailingSlash.url);

  console.log('\nReading the tracker:');
  // A full page, because the scan stops at the first short one: the forge is asked for
  // 50 at a time, so a page with fewer than 50 in it is the end of the list.
  const fullPage = [];
  for (let i = 0; i < 47; i++) fullPage.push(issue(100 + i, 'a bug, not a request'));
  fullPage.push(issue(1, '[Device]: one'), issue(3, '[Hardware]: two'), { number: 4, title: 'a PR', pull_request: {} });
  const fetch1 = fakeFetch([fullPage, [issue(5, '[Device]: three')]]);
  const list = await fetchOpenRequests({ api: 'http://x', repo: 'o/r', fetch: fetch1 });
  ok(list.length === 3, 'three requests out of fifty issues, the bug reports and the PR dropped', String(list.length));
  ok(list.map(function (r) { return r.number; }).join(',') === '1,3,5', 'in tracker order');
  ok(fetch1.calls.length === 2, 'a short page ends the scan rather than asking for more', String(fetch1.calls.length));
  ok(fetch1.calls[0].indexOf('/api/v1/repos/o/r/issues?state=open') !== -1, 'it asks the forge for open issues', fetch1.calls[0]);
  ok(fetch1.calls[0].indexOf('type=issues') !== -1, 'and asks for issues, not pull requests');

  console.log('\nAn unreachable forge throws rather than pretending:');
  let threw = false;
  try {
    await fetchOpenRequests({ api: 'http://x', repo: 'o/r', fetch: async function () { return { ok: false, status: 502 }; } });
  } catch (e) { threw = true; ok(/502/.test(e.message), 'the error names the status', e.message); }
  ok(threw, 'a failed fetch is an error, not an empty catalogue');
  let threw2 = false;
  try {
    await fetchOpenRequests({ api: 'http://x', repo: 'o/r', fetch: async function () { throw new Error('ECONNREFUSED'); } });
  } catch (e) { threw2 = true; }
  ok(threw2, 'a network error propagates too');

  console.log('\nThe cache:');
  let clock = 1000;
  let calls = 0;
  const cache = createRequestCache({
    ttlMs: 500,
    now: function () { return clock; },
    fetcher: async function () { calls += 1; return [{ number: 9, subject: 'cached' }]; }
  });
  const first = await cache.get();
  ok(first.available === true && first.requests.length === 1, 'the first read fills the cache');
  ok(calls === 1, 'one fetch for the first read');
  clock += 100;
  const second = await cache.get();
  ok(calls === 1, 'a read inside the TTL does not fetch again');
  ok(second.requests.length === 1, 'and still answers');
  ok(second.stale === false, 'a fresh list is not marked stale');
  clock += 1000;
  const third = await cache.get();
  ok(calls === 2, 'a read past the TTL refreshes');
  ok(third.available === true, 'and answers from the new list');

  console.log('\nWhen the forge is down:');
  let failing = true;
  const flaky = createRequestCache({
    ttlMs: 0,
    now: function () { return 5000; },
    fetcher: async function () {
      if (failing) throw new Error('down');
      return [{ number: 1, subject: 'x' }];
    }
  });
  const none = await flaky.get();
  ok(none.available === false, 'the answer says it is unavailable', JSON.stringify(none).slice(0, 80));
  ok(none.requests.length === 0, 'with no rows');
  ok(/down/.test(none.error || ''), 'and the reason, so a bug report can carry it', none.error);
  failing = false;
  const after = await flaky.get();
  ok(after.available === true, 'a later success recovers without a restart');
  ok(TTL_MS === 10 * 60 * 1000, 'the default TTL is ten minutes');

  console.log('\nThe endpoint is wired into the server:');
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  ok(/parts\[1\] === 'requests' && method === 'GET'/.test(src), 'GET /api/requests is routed');
  ok(/await requestCache\.get\(\)/.test(src), 'and answers from the cache');
  ok(/createRequestCache\(\{\}\)/.test(src), 'the cache is built once, not per request');

  if (failed) { console.error('\n' + failed + ' requests-endpoint check(s) failed'); process.exit(1); }
  console.log('\n' + passed + ' requests-endpoint checks passed.');
})();
