'use strict';
// A configuration door refuses all of a body, or applies all of it (#1425).
//
// `POST /api/topologies/:name/interfaces/:device/:port` writes four things: the address, `enabled`, `description` and
// the cage's role. It used to write them *in that order, as it went*, and answer `400` the moment one of them was
// refused:
//
//   {"ip":"10.9.9.9","mask":"255.255.255.0","role":"bogus"}   ->  400, and the address is stored
//
// The caller is told the change failed while half of it happened. That is the one thing a configuration door must not
// do: after it, the board and the sentence about the board disagree, and a person who reads "refused" and reloads
// finds a port configured the way they were told it was not. #1413 promised this door "changes nothing on refusal";
// that held only when the refused field happened to come first.
//
// The same door also asked `!!body.enabled`, so `{"enabled": "false"}` - a string JSON clients really do send - set
// the port enabled and answered `200`: the exact opposite of the request, with an `ok`.
//
// So: every field is checked before any is written, every refusal is reported (not just the first), `enabled` is a
// boolean or nothing, `description` is a string or nothing, and a refusal leaves the port byte-identical.
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const ROOT = path.join(__dirname, '..');

function freePort() {
  return new Promise(function (resolve, reject) {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', function () {
      const port = probe.address().port;
      probe.close(function () { resolve(port); });
    });
  });
}

function request(port, method, urlPath, body) {
  return new Promise(function (resolve, reject) {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: port, path: urlPath, method: method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}
    }, function (res) {
      let data = '';
      res.on('data', function (c) { data += c; });
      res.on('end', function () {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (e) { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// What a person would call "the port's configuration": the fields this door can write, plus the ones the console
// prints for it. Compared as a string, because the question is "is it byte-identical", not "does it look similar".
function portConfig(state, devId, portName) {
  const dev = (state.devices || []).filter(function (d) { return d.id === devId; })[0];
  if (!dev) return null;
  const iface = (dev.interfaces || []).filter(function (i) { return i.name === portName; })[0];
  if (!iface) return null;
  return JSON.stringify({
    ip: iface.ip, mask: iface.mask, enabled: iface.enabled,
    description: iface.description, role: iface.role, mode: iface.mode,
    accessVlan: iface.accessVlan, trunkVlans: iface.trunkVlans
  });
}

// A body that must be refused, and why anyone would send it.
const REFUSALS = [
  { body: { ip: '10.9.9.9', mask: '255.255.255.0', role: 'bogus' },
    why: 'a good address and a role the hardware cannot take' },
  { body: { ip: '10.9.9.9', mask: '255.0.255.0' }, why: 'a mask that is not a netmask' },
  { body: { ip: '999.1.1.1', mask: '255.255.255.0' }, why: 'an address with an octet out of range' },
  { body: { ip: '10.9.9.9' }, why: 'an address with no mask' },
  { body: { enabled: 'false' }, why: 'the string "false" where a boolean belongs' },
  { body: { enabled: 0 }, why: 'a number where a boolean belongs' },
  { body: { description: 42 }, why: 'a number where a description belongs' },
  { body: { role: 'bogus' }, why: 'a role the hardware cannot take' },
  { body: { ip: '10.9.9.9', mask: '255.255.255.0', enabled: false, description: 'core uplink', role: 'bogus' },
    why: 'four good fields and one impossible role' }
];

const APPLIES = [
  { body: { ip: '10.9.9.9', mask: '24' }, why: 'an address and a prefix length',
    check: function (c) { return c.ip === '10.9.9.9' && c.mask === '255.255.255.0'; } },
  { body: { enabled: false }, why: 'a boolean', check: function (c) { return c.enabled === false; } },
  { body: { description: 'core uplink' }, why: 'a description', check: function (c) { return c.description === 'core uplink'; } },
  { body: { ip: '10.9.9.10', mask: '255.255.255.0', enabled: true, description: 'spare' },
    why: 'all of them at once',
    check: function (c) { return c.ip === '10.9.9.10' && c.enabled === true && c.description === 'spare'; } },
  { body: { ip: null }, why: 'clearing the address', check: function (c) { return c.ip === null && c.mask === null; } }
];

(async function () {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-ifdoor-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: Object.assign({}, process.env, { PORT: String(port), PF_DATA: dataDir }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', function (d) { log += d; });
  child.stderr.on('data', function (d) { log += d; });

  try {
    const deadline = Date.now() + 20000;
    for (;;) {
      try {
        const r = await request(port, 'GET', '/api/version');
        if (r.status === 200) break;
      } catch (e) { /* not up yet */ }
      if (child.exitCode !== null) throw new Error('server exited: ' + log);
      if (Date.now() > deadline) throw new Error('server never answered: ' + log.slice(-400));
      await new Promise(function (r) { setTimeout(r, 100); });
    }

    await request(port, 'POST', '/api/topologies', { id: 'door' });
    // A managed switch: it has addressable ports, cages and a configuration language.
    const made = await request(port, 'POST', '/api/topologies/door/devices',
      { vendor: 'advantech', model: 'EKI-7708G-4FI', id: 'sw', x: 100, y: 100 });
    ok(made.status === 201, 'a switch to configure', String(made.status));
    const first = await request(port, 'GET', '/api/topologies/door');
    const dev = (first.body.devices || []).filter(function (d) { return d.id === 'sw'; })[0];
    const portName = (dev.interfaces || []).filter(function (i) { return i.type === 'ethernet'; })[0].name;
    const url = '/api/topologies/door/interfaces/sw/' + encodeURIComponent(portName);
    ok(!!portName, 'and one of its ports', portName);

    console.log('');
    console.log('A body that is refused changes nothing at all:');
    {
      const wrong = [];
      for (const c of REFUSALS) {
        // Start from a known port each time, so "unchanged" means something.
        await request(port, 'POST', url, { ip: '10.7.0.1', mask: '255.255.255.0', enabled: true, description: 'before' });
        const before = portConfig((await request(port, 'GET', '/api/topologies/door')).body, 'sw', portName);
        const r = await request(port, 'POST', url, c.body);
        const after = portConfig((await request(port, 'GET', '/api/topologies/door')).body, 'sw', portName);
        if (r.status !== 400) wrong.push(c.why + ' -> ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 80));
        else if (after !== before) wrong.push(c.why + ' -> changed the port to ' + after);
        if (r.status === 400 && !(r.body && r.body.error)) wrong.push(c.why + ' -> refused with no message');
        if (r.status === 400 && r.body && r.body.code && !/^E_/.test(String(r.body.code))) {
          wrong.push(c.why + ' -> code ' + r.body.code);
        }
      }
      ok(wrong.length === 0, REFUSALS.length + ' refused bodies leave the port byte-identical', wrong.slice(0, 4).join(' | '));
    }

    console.log('');
    console.log('And every reason in one body is reported, not just the first:');
    {
      const r = await request(port, 'POST', url,
        { ip: '999.1.1.1', mask: '255.0.255.0', enabled: 'no', description: 7, role: 'bogus' });
      const problems = (r.body && r.body.problems) || [];
      ok(r.status === 400, 'five bad fields are a refusal', String(r.status));
      ok(problems.length === 4, 'and four of them are named back', JSON.stringify(problems.map(function (p) { return p.code; })));
      ok(problems.every(function (p) { return p.code && p.error; }), 'each with a code and a sentence',
        JSON.stringify(problems));
      const message = String(r.body && r.body.error || '');
      // The mask is not mentioned here because the address was refused first and the mask question is not asked of an
      // address that is not an address - the next check pins that.
      ok(/not an IPv4 address/.test(message) && /true or false/.test(message) &&
        /a string/.test(message) && /cannot be bogus/.test(message), 'all of them in the one message', message);
      // The address and mask are one field: an address that is not an address and a mask that is not a netmask are
      // reported once, not twice, because the second question never gets asked.
      const codes = problems.map(function (p) { return p.code; });
      ok(codes.filter(function (c) { return c === 'E_BAD_ADDRESS'; }).length === 1 &&
        codes.indexOf('E_BAD_MASK') === -1, 'and the address is not asked twice about the same field', codes.join(','));
    }

    console.log('');
    console.log('A body that is accepted applies all of it:');
    {
      const wrong = [];
      for (const c of APPLIES) {
        await request(port, 'POST', url, { ip: null, enabled: true, description: '' });
        const r = await request(port, 'POST', url, c.body);
        const state = (await request(port, 'GET', '/api/topologies/door')).body;
        const raw = (function () {
          const d = (state.devices || []).filter(function (x) { return x.id === 'sw'; })[0];
          return (d.interfaces || []).filter(function (i) { return i.name === portName; })[0];
        })();
        if (r.status !== 200) wrong.push(c.why + ' -> ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 100));
        else if (!c.check(raw)) wrong.push(c.why + ' -> stored ' + JSON.stringify({ ip: raw.ip, mask: raw.mask,
          enabled: raw.enabled, description: raw.description }));
      }
      ok(wrong.length === 0, APPLIES.length + ' accepted bodies do what they say', wrong.join(' | '));
    }

    console.log('');
    console.log('And the refusals read like sentences about a port:');
    {
      const role = await request(port, 'POST', url, { role: 'bogus' });
      ok(/port /.test(String(role.body && role.body.error)), 'a role refusal names the port, not a number',
        String(role.body && role.body.error));
      const enabled = await request(port, 'POST', url, { enabled: 'false' });
      ok(/"false"/.test(String(enabled.body && enabled.body.error)), 'a boolean refusal quotes what it was given',
        String(enabled.body && enabled.body.error));
      const mask = await request(port, 'POST', url, { ip: '10.0.1.1', mask: '255.0.255.0' });
      ok(/netmask/.test(String(mask.body && mask.body.error)), 'and a mask refusal says what a netmask is',
        String(mask.body && mask.body.error));
    }
  } catch (e) {
    ok(false, 'the door could be exercised', e && e.message);
  } finally {
    try { child.kill('SIGTERM'); } catch (e) {}
    await new Promise(function (r) { setTimeout(r, 300); });
    try { child.kill('SIGKILL'); } catch (e) {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('');
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
