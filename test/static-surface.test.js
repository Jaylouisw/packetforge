'use strict';
// What the static server answers, and what it refuses (#1311).
//
// The browser half of this app is four files. `serveStatic` had three problems that no engine test could see:
//
//   * a missing file was answered with `index.html` and a 200. So `/nope.js` returned the app with
//     `Content-Type: text/html`, and the browser's only report was "Uncaught SyntaxError: Unexpected token '<'"
//     in a file the reader can no longer identify. This app has no client-side routes - the fallback was hiding
//     wrong filenames and nothing else;
//   * the method was ignored: `POST /index.html` answered 200 with the document, and `DELETE` did the same, so a
//     client could believe a write had landed;
//   * the "is this inside web/" test was `filePath.indexOf(WEB_DIR) !== 0` - a string prefix, not a path
//     boundary, so a sibling directory whose name merely begins with `web` would pass it. The URL parser happens
//     to make that unreachable today; a check that has to be unreachable by luck is not a check.
//
// This file pins all three, over real HTTP, and pins the boundary property in the source too, since HTTP cannot
// reach it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');

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
function request(method, rawPath, headers) {
  return new Promise(function (resolve, reject) {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: rawPath, method: method, headers: headers || {} },
      function (res) {
        let data = '';
        res.on('data', function (c) { data += c; });
        res.on('end', function () {
          resolve({ status: res.statusCode, headers: res.headers, text: data, length: data.length });
        });
      });
    req.on('error', reject);
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
    const deadline = Date.now() + 20000;
    (function poll() {
      request('GET', '/api/version').then(function (r) {
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-static-'));
  PORT = await freePort();
  const srv = await startServer(dataDir);

  try {
    console.log('');
    console.log('The app is served:');
    {
      const index = await request('GET', '/');
      ok(index.status === 200 && /^text\/html/.test(index.headers['content-type'] || ''),
        '/ answers with the document', index.status + ' ' + index.headers['content-type']);
      ok(/<!DOCTYPE html>/.test(index.text) && /app\.js/.test(index.text), 'and it is the app', index.text.slice(0, 40));

      const js = await request('GET', '/app.js');
      ok(js.status === 200 && /javascript/.test(js.headers['content-type'] || ''),
        'app.js is served as JavaScript', js.headers['content-type']);
      const css = await request('GET', '/style.css');
      ok(css.status === 200 && /text\/css/.test(css.headers['content-type'] || ''),
        'style.css is served as CSS', css.headers['content-type']);
      ok(js.length > 1000 && css.length > 500, 'and both have their content', js.length + '/' + css.length);
    }

    console.log('');
    console.log('A missing file is a 404, not the app dressed up as one:');
    {
      const bad = [];
      for (const p of ['/nope.js', '/nope.png', '/assets/missing.woff2', '/app.js.map', '/favicon.ico']) {
        const r = await request('GET', p);
        if (r.status !== 404) bad.push(p + ' -> ' + r.status + ' ' + (r.headers['content-type'] || ''));
        // Whatever the status, an HTML body where a file was expected is the defect.
        if (/<html/i.test(r.text) && !p.endsWith('.html')) bad.push(p + ' -> answered with HTML');
      }
      ok(bad.length === 0, 'five file-shaped misses are 404s and none of them is the document',
        JSON.stringify(bad.slice(0, 3)));

      // A document-shaped miss still gets the app, because that is a deep link and this app can open on any path.
      const doc = await request('GET', '/lab/created/by/a/bookmark');
      ok(doc.status === 200 && /<!DOCTYPE html>/.test(doc.text), 'a document-shaped path still opens the app',
        doc.status);
    }

    console.log('');
    console.log('Nothing outside web/ is ever served:');
    {
      // A marker only this file knows, asked for in every spelling that has historically reached past a root.
      const attempts = ['/../server/index.js', '/../../server/index.js', '/..%2fserver%2findex.js',
        '/%2e%2e%2fserver%2findex.js', '/....//server/index.js', '/./../server/index.js',
        '/web/../server/index.js', '//server/index.js', '/../package.json', '/..%2fpackage.json',
        '/../engine/topology.js', '/%2e%2e/engine/topology.js'];
      const leaked = [];
      for (const p of attempts) {
        const r = await request('GET', p);
        const body = r.text || '';
        if (/require\(|module\.exports|"name": "packetforge"|class Topology/.test(body)) {
          leaked.push(p + ' -> ' + r.status + ' ' + body.slice(0, 60));
        }
      }
      ok(leaked.length === 0, attempts.length + ' escapes, none of them returned server or engine source',
        JSON.stringify(leaked.slice(0, 2)));

      // The property, in the source: the containment test is a path boundary, not a string prefix. HTTP cannot
      // reach the difference today - the URL parser collapses `..` before the path is joined - which is exactly
      // why the check must not depend on that.
      const src = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
      ok(/filePath\.slice\(0, WEB_DIR\.length \+ 1\) === WEB_DIR \+ path\.sep/.test(src),
        'the containment test compares whole path segments');
      ok(!/filePath\.indexOf\(WEB_DIR\) !== 0/.test(src), 'and the string-prefix version is gone');
    }

    console.log('');
    console.log('Only a read serves a file:');
    {
      const allow = [];
      for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        const r = await request(m, '/index.html');
        if (r.status !== 405) allow.push(m + ' -> ' + r.status);
        if (!/GET/.test(r.headers.allow || '')) allow.push(m + ' -> Allow: ' + JSON.stringify(r.headers.allow));
      }
      ok(allow.length === 0, 'four write methods are 405 with Allow: GET, HEAD', JSON.stringify(allow.slice(0, 3)));

      const head = await request('HEAD', '/index.html');
      const get = await request('GET', '/index.html');
      ok(head.status === 200, 'HEAD answers 200', String(head.status));
      ok(head.length === 0, 'with no body', String(head.length));
      ok(head.headers['content-length'] === get.headers['content-length'],
        'and the length a GET would send', head.headers['content-length'] + ' vs ' + get.headers['content-length']);

      const gzHead = await request('HEAD', '/app.js', { 'Accept-Encoding': 'gzip' });
      ok(gzHead.status === 200 && gzHead.length === 0, 'even when the response would have been compressed',
        gzHead.status + ' ' + gzHead.length);
    }

    console.log('');
    console.log('Caching still revalidates rather than trusts:');
    {
      const first = await request('GET', '/style.css');
      ok(!!first.headers.etag, 'the asset carries an ETag', first.headers.etag);
      const again = await request('GET', '/style.css', { 'If-None-Match': first.headers.etag });
      ok(again.status === 304 && again.length === 0, 'a matching ETag gets an empty 304', again.status);
      const ims = await request('GET', '/style.css', { 'If-Modified-Since': first.headers['last-modified'] });
      ok(ims.status === 304, 'and so does If-Modified-Since', String(ims.status));
      const stale = await request('GET', '/style.css', { 'If-None-Match': 'W/"0-0"' });
      ok(stale.status === 200 && stale.length > 0, 'a stale tag still gets the bytes', String(stale.status));
    }
  } finally {
    await stop(srv.child);
  }

  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
