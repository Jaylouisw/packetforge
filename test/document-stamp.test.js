'use strict';
// The format/version stamp was written twice and read by nothing (#1520).
//
// `serialize()` wrote `format: 'packetforge-topology', version: 1` and `server/index.js` wrote the same two
// lines by hand into the file envelope, so the same claim was stated in two places in two literals that could
// drift. And nothing ever read it: `Topology.fromJSON()` accepted a document stamped `version: 99` with a
// `format` of `lab` and built a board out of it without a word. A guard that looks like a guard and is none is
// worse than no guard, because the next person to read the file concludes the version is checked.
//
// What is asserted here is the rule, not today's strings:
//
//   1. the stamp the engine writes is the stamp it reads, from one pair of constants;
//   2. a document that says it is something else, or something newer, is refused in words that name both what
//      it said and what this build understands;
//   3. a document that says nothing at all still loads - every board written before the stamp existed has no
//      format and no version, and those files are the ones this must not break.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const { Topology, DOC_FORMAT, DOC_VERSION, documentStampProblem } = require('../engine');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const ROOT = path.join(__dirname, '..');

function emptyBoard() { return new Topology(); }

function refusal(doc) {
  try {
    Topology.fromJSON(JSON.parse(JSON.stringify(doc)));
    return null;
  } catch (e) {
    return e.message;
  }
}

// ---------------------------------------------------------------- 1: the stamp itself
console.log('The board document states its format and version, and reads them back:');
{
  const doc = emptyBoard().serialize();
  ok(doc.format === DOC_FORMAT, 'serialize() writes the format the engine exports (' + doc.format + ')');
  ok(DOC_FORMAT === 'packetforge-topology', 'and that format is the one every existing file carries (' + DOC_FORMAT + ')');
  ok(doc.version === DOC_VERSION, 'serialize() writes the version the engine exports (' + doc.version + ')');
  ok(Number.isInteger(DOC_VERSION) && DOC_VERSION >= 1, 'the version is a whole number at least 1 (' + DOC_VERSION + ')');
  ok(documentStampProblem(doc) === '', 'a board this build wrote has no stamp problem', JSON.stringify(documentStampProblem(doc)));
  ok(refusal(doc) === null, 'and it loads back with no complaint', String(refusal(doc)));
}

// ---------------------------------------------------------------- 2: read, not just written
console.log('');
console.log('A document that says it is something else is refused, in words that name it:');
{
  const wrongFormat = { format: 'lab', version: 1, devices: [], links: [] };
  const why = refusal(wrongFormat);
  ok(why !== null, 'a document with format "lab" is refused rather than loaded as an empty lab');
  ok(why !== null && why.indexOf('lab') !== -1, 'the refusal quotes what the document said (' + why + ')');
  ok(why !== null && why.indexOf(DOC_FORMAT) !== -1, 'and names the format this build reads (' + why + ')');

  const newer = { format: DOC_FORMAT, version: DOC_VERSION + 1, devices: [], links: [] };
  const whyNew = refusal(newer);
  ok(whyNew !== null, 'a document written by a newer build (version ' + (DOC_VERSION + 1) + ') is refused');
  ok(whyNew !== null && whyNew.indexOf(String(DOC_VERSION + 1)) !== -1, 'the refusal names the version the file claims (' + whyNew + ')');
  ok(whyNew !== null && whyNew.indexOf('version ' + DOC_VERSION) !== -1, 'and the newest version this build reads (' + whyNew + ')');

  const stringVersion = { format: DOC_FORMAT, version: '1', devices: [], links: [] };
  const whyStr = refusal(stringVersion);
  ok(whyStr !== null, 'a version that is a string, not a number, is refused');
  ok(whyStr !== null && /whole number/.test(whyStr), 'and says what a version has to be (' + whyStr + ')');

  const zero = { format: DOC_FORMAT, version: 0, devices: [], links: [] };
  ok(refusal(zero) !== null, 'version 0 is not a version: no build ever wrote one');
  const negative = { format: DOC_FORMAT, version: -3, devices: [], links: [] };
  ok(refusal(negative) !== null, 'nor is a negative one');
}

console.log('');
console.log('A document that says nothing about its format still loads, because old files do:');
{
  const bare = { devices: [], links: [] };
  ok(refusal(bare) === null, 'no format and no version is not an error - it is an older file');
  ok(documentStampProblem(bare) === '', 'and it has no stamp problem to report');
  const current = { format: DOC_FORMAT, version: DOC_VERSION, devices: [], links: [] };
  ok(refusal(current) === null, 'the current version loads');
  ok(documentStampProblem(null) === '', 'nothing at all is somebody else\'s answer to give, not a stamp problem');
}

// ---------------------------------------------------------------- 3: one source of truth
console.log('');
console.log('The stamp is written in one place, not restated by hand in the server:');
{
  const engineSrc = fs.readFileSync(path.join(ROOT, 'engine', 'topology.js'), 'utf8');
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  ok(/DOC_FORMAT\s*=\s*'packetforge-topology'/.test(engineSrc), 'the engine declares the format once');
  ok(/DOC_VERSION\s*=\s*\d+/.test(engineSrc), 'and the version once');
  ok(!/'packetforge-topology'/.test(serverSrc), 'the server no longer restates the format literal: it imports it');
  ok(/DOC_FORMAT/.test(serverSrc) && /DOC_VERSION/.test(serverSrc),
    'the server writes its file envelope from the engine\'s constants');
  ok(/documentStampProblem/.test(serverSrc), 'and asks the engine whether a document\'s stamp is readable');
}

// ---------------------------------------------------------------- 4: the same rule over HTTP
function freePort() {
  return new Promise(function (resolve, reject) {
    const p = net.createServer();
    p.unref();
    p.on('error', reject);
    p.listen(0, '127.0.0.1', function () {
      const port = p.address().port;
      p.close(function () { resolve(port); });
    });
  });
}
let PORT = 0;
function request(method, urlPath, body) {
  return new Promise(function (resolve, reject) {
    const payload = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: urlPath, method: method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}
    }, function (res) {
      let data = '';
      res.on('data', function (c) { data += c; });
      res.on('end', function () {
        let parsed = data;
        try { parsed = JSON.parse(data); } catch (e) { /* keep the raw text */ }
        resolve({ status: res.statusCode, body: parsed, text: data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
function startServer(dataDir) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), PF_DATA: dataDir }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', function (d) { log += d; });
  child.stderr.on('data', function (d) { log += d; });
  return new Promise(function (resolve, reject) {
    // One minute, not twenty seconds (#1720). At PF_TEST_CONCURRENCY=10 ten suites start a server
    // at once, a cold start measured 3.5-4.8 s, and one suite that restarts its server spent 27 s.
    const deadline = Date.now() + 60000;
    (function poll() {
      request('GET', '/api/catalog').then(function (r) {
        if (r.status === 200) return resolve({ child: child, log: function () { return log; } });
        throw new Error('status ' + r.status);
      }).catch(function (e) {
        if (child.exitCode !== null) return reject(new Error('server exited: ' + log));
        if (Date.now() > deadline) return reject(new Error('no answer: ' + e.message + ' | ' + log));
        setTimeout(poll, 100);
      });
    })();
  });
}
function stop(child) {
  return new Promise(function (resolve) {
    child.on('exit', function () { resolve(); });
    try { child.kill('SIGTERM'); } catch (e) { resolve(); }
    setTimeout(function () { try { child.kill('SIGKILL'); } catch (e) {} resolve(); }, 5000);
  });
}

(async function main() {
  console.log('');
  console.log('The API applies the same rule when a document would replace the live board:');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-stamp-'));
  PORT = await freePort();
  const srv = await startServer(dataDir);
  try {
    const newer = await request('POST', '/api/topologies/default/load',
      { format: DOC_FORMAT, version: DOC_VERSION + 1, devices: [], links: [] });
    ok(newer.status === 400, 'a newer-version document is a 400, not a board (' + newer.status + ')');
    ok(newer.body && newer.body.code === 'E_BAD_DOCUMENT', 'with a code a client can branch on (' + (newer.body && newer.body.code) + ')');
    ok(newer.text.indexOf(String(DOC_VERSION + 1)) !== -1 && newer.text.indexOf('version ' + DOC_VERSION) !== -1,
      'and an error that names both versions (' + String(newer.body && newer.body.error) + ')');

    const wrong = await request('POST', '/api/topologies/default/load', { format: 'lab', devices: [], links: [] });
    ok(wrong.status === 400, 'a document with the wrong format is still a 400 (' + wrong.status + ')');

    const bare = await request('POST', '/api/topologies/default/load', { devices: [], links: [] });
    ok(bare.status === 200, 'a document with no stamp at all still loads (' + bare.status + ')');

    const good = await request('POST', '/api/topologies/default/load', emptyBoard().serialize());
    ok(good.status === 200, 'and so does one this build wrote (' + good.status + ')');
  } finally {
    await stop(srv.child);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('');
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
