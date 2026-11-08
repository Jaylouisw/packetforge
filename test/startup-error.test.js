'use strict';
// The failure that makes the "Report a bug" button unreachable has to carry the
// reporting path itself.
//
// Two kinds of check here, deliberately:
//   - unit: the wording for each errno, including that a known remedy is offered
//   - integration: start two real servers on one port and read what the loser says
// The integration half is the point. A message builder that is never wired up is
// still dead code, and the wiring is what this test exists to hold in place.
const assert = require('assert');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { describeListenError, formatStartupError, REPORT_URL } = require('../server/startup-error');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const ROOT = path.join(__dirname, '..');

console.log('Known failures are explained, not dumped:');
const busy = describeListenError(Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }), 8000);
ok(/already in use/.test(busy.headline), 'a taken port says so in the first line');
ok(/8000/.test(busy.headline), 'the headline names the port that is taken');
ok(busy.lines.join('\n').indexOf('PORT=8081') !== -1, 'it offers a different port to try');
ok(/PowerShell/.test(busy.lines.join('\n')), 'it gives the shell-specific form, not just the POSIX one');
ok(/still running/.test(busy.lines.join('\n')), 'it names the likely cause');
ok(busy.reportable === true, 'an unexpected hold on the port is still worth reporting');

const denied = describeListenError(Object.assign(new Error('listen EACCES'), { code: 'EACCES' }), 80);
ok(/not allowed/i.test(denied.headline), 'a privileged port is explained');
ok(/1024/.test(denied.lines.join('\n')), 'it says where the privilege boundary is');
ok(denied.reportable === false, 'a permission error is not a bug in PacketForge');

const other = describeListenError(new Error('something else entirely'), 8000);
ok(/something else entirely/.test(other.headline), 'an unknown failure keeps the original message');
ok(other.reportable === true, 'an unknown failure is reportable');
ok(other.headline.indexOf('undefined') === -1, 'an unknown failure never prints undefined');

const noErr = describeListenError(null, 8000);
ok(typeof noErr.headline === 'string' && noErr.headline.length > 0, 'a null error still produces a sentence');

console.log('\nThe printed block always ends with somewhere to go:');
const block = formatStartupError(Object.assign(new Error('boom'), { code: 'EADDRINUSE' }), 8000).join('\n');
ok(block.indexOf(REPORT_URL) !== -1, 'a reportable failure prints the report URL');
ok(REPORT_URL.indexOf('/issues/new') !== -1, 'the URL opens the new-issue form directly');
ok(REPORT_URL.indexOf('undefined') === -1 && REPORT_URL.indexOf('%20%20') === -1,
  'the prefilled URL is clean');
const quiet = formatStartupError(Object.assign(new Error('nope'), { code: 'EACCES' }), 80).join('\n');
ok(quiet.indexOf('/issues/new') === -1, 'a self-inflicted failure does not invite a bug report');

// --- integration: two servers, one port -----------------------------------
function freePort() {
  return new Promise(function (resolve, reject) {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', function () {
      const p = s.address().port;
      s.close(function () { resolve(p); });
    });
  });
}

function startServer(port) {
  const child = spawn(process.execPath, [path.join('server', 'index.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(port) }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const out = { pid: child.pid, stdout: '', stderr: '', code: null, child: child };
  child.stdout.on('data', function (d) { out.stdout += d.toString(); });
  child.stderr.on('data', function (d) { out.stderr += d.toString(); });
  child.on('exit', function (c) { out.code = c; });
  return out;
}

function waitFor(fn, ms) {
  return new Promise(function (resolve) {
    const t0 = Date.now();
    (function poll() {
      if (fn()) return resolve(true);
      if (Date.now() - t0 > ms) return resolve(false);
      setTimeout(poll, 50);
    })();
  });
}

(async function () {
  console.log('\nTwo servers, one port - the second explains itself and stops:');
  const port = await freePort();
  const first = startServer(port);
  const up = await waitFor(function () { return first.stdout.indexOf('Local:') !== -1; }, 30000);
  ok(up, 'the first server started on port ' + port);
  if (!up) {
    try { first.child.kill(); } catch (e) {}
    return finish();
  }

  const second = startServer(port);
  const ended = await waitFor(function () { return second.code !== null; }, 20000);
  const text = second.stdout + second.stderr;
  ok(ended, 'the second server exited instead of hanging');
  ok(second.code === 1, 'it exits with a failing status, so a script notices', 'code ' + second.code);
  ok(/already in use/.test(text), 'it says the port is in use rather than printing a stack trace');
  ok(/EADDRINUSE/.test(text) === false, 'the raw errno does not reach the user on its own');
  ok(text.indexOf('/issues/new') !== -1, 'it leaves the user a way to report it');
  ok(/PORT=/.test(text), 'it leaves the user a way to fix it');
  ok(/\n\s+at /.test(text) === false, 'no stack trace is printed');

  try { first.child.kill(); } catch (e) {}
  finish();
})();

function finish() {
  if (failed) { console.error('\n' + failed + ' startup-error check(s) failed'); process.exit(1); }
  console.log('\n' + passed + ' startup-error checks passed.');
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(0);
}
