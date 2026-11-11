'use strict';
// The same lab has to replay identically - and nothing was checking it (#1419).
//
// Three engine modules say so in a comment, because the property is what makes the thing testable at all:
//
//   engine/flow.js:177   "A per-connection identity that is stable across runs: no Math.random(), no Date.now().
//                         The same lab replays identically, which is what makes a simulation ..."
//   engine/nat.js:15     "Steps are caller-supplied logical ticks, never Date.now()"
//   engine/dhcp.js:15    "... never Math.random. `step` is the simulator's tick"
//
// A convention written in three comments and enforced by none is how six other pairs of surfaces in this repository
// drifted (#1238, #1291, #1293, #1301, #1327, #1417). The drift here would be silent and nasty: one `Date.now()` in a
// new module makes the payload differ between two servers running the same document, and the symptom is a test that
// fails once a week, or a diff between two boards that looks like a real difference.
//
// So the convention is pinned two ways, because each catches what the other cannot:
//
//   1. statically - the engine source contains no clock, no die, no UUID (comment-aware, and the scanner is itself
//      checked against a source that does contain one, so it cannot silently stop working);
//   2. behaviourally - the same lab, built twice, in one process and across a real wall-clock second, fingerprints
//      the same; and the same document driven through two independent servers yields a byte-identical payload.
//
// Both are only worth anything if they can fail, so the fingerprint is also fed three *different* labs and required
// to tell them apart: a guard that hashes nothing always agrees with itself.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Topology, Simulator, CliSession, runCommands, flow } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const ROOT = path.join(__dirname, '..');
const ENGINE = path.join(ROOT, 'engine');
const catalog = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
function byModel(m) {
  const spec = catalog.find(function (s) { return s.model === m; });
  if (!spec) throw new Error('catalogue has no ' + m);
  return spec;
}

// --- 1. nothing in the engine asks the time or rolls a die ---------------------------------------------------------
//
// Comment-aware, because the engine *talks* about Math.random and Date.now in prose (in exactly the comments quoted
// above) and a scan that flagged its own documentation would be turned off within a week. Strings are skipped too, so
// a URL containing `//` does not swallow the rest of a line.
function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') i++;
        i++;
      }
      i++;
      out += '""';
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

const CLOCK_OR_DIE = [
  { name: 'Math.random()', re: /\bMath\s*\.\s*random\s*\(/ },
  { name: 'Date.now()', re: /\bDate\s*\.\s*now\s*\(/ },
  { name: 'new Date()', re: /\bnew\s+Date\s*\(/ },
  { name: 'performance.now()', re: /\bperformance\s*\.\s*now\s*\(/ },
  { name: 'crypto.randomUUID()', re: /\bcrypto\s*\.\s*randomUUID\s*\(/ },
  { name: 'process.hrtime()', re: /\bprocess\s*\.\s*hrtime\b/ }
];

function scanSource(src) {
  const code = stripCommentsAndStrings(src);
  const hits = [];
  for (const rule of CLOCK_OR_DIE) {
    const m = rule.re.exec(code);
    if (m) hits.push(rule.name);
  }
  return hits;
}

console.log('Nothing in the engine asks what time it is, or rolls a die:');
{
  // The scanner is checked first: a guard that cannot see the thing it guards is worse than no guard.
  const sample = [
    "// Date.now() in a comment is documentation, not a defect.",
    "/* Math.random() in a block comment likewise */",
    "const url = 'http://example.test/?new=Date';   // a string, not a call",
    "const bad = Math.random();",
    "const worse = new Date();"
  ].join('\n');
  const hits = scanSource(sample);
  ok(hits.indexOf('Math.random()') !== -1, 'the scanner finds a real Math.random()', JSON.stringify(hits));
  ok(hits.indexOf('new Date()') !== -1, 'and a real new Date()', JSON.stringify(hits));
  ok(scanSource("// Math.random()\n/* Date.now() */\nconst u = 'Date.now()';\n").length === 0,
    'and skips comments and strings', JSON.stringify(scanSource("// Math.random()\n/* Date.now() */\nconst u = 'Date.now()';\n")));

  const files = fs.readdirSync(ENGINE).filter(function (f) { return f.endsWith('.js'); });
  ok(files.length > 20, 'the engine is more than a handful of files', String(files.length));
  const offenders = [];
  let prose = 0;
  for (const file of files) {
    const raw = fs.readFileSync(path.join(ENGINE, file), 'utf8');
    for (const rule of CLOCK_OR_DIE) if (rule.re.test(raw)) prose++;   // mentions, in comments, are expected
    const hitsHere = scanSource(raw);
    if (hitsHere.length) offenders.push(file + ': ' + hitsHere.join(', '));
  }
  ok(offenders.length === 0, 'no engine module reaches for a clock or a die',
    offenders.join(' | '));
  ok(prose > 0, 'and the modules that say so in prose are still saying so', String(prose) + ' mentions in comments');
}

// --- the lab, and one fingerprint of it ---------------------------------------------------------------------------
//
// The fingerprint is the whole of what an observer can see: the document `serialize()` would write, and the text the
// console prints for a fixed set of commands on every device. Anything a client would notice, it notices.
function lab(tweak) {
  tweak = tweak || {};
  const t = new Topology();
  const r1 = t.addDevice(byModel('ICR-3231'), 'r1');
  const sw = t.addDevice(byModel('EKI-5728I'), 'sw1');
  const h1 = t.addDevice(byModel('ICR-3231'), 'h1');
  const h2 = t.addDevice(byModel('ICR-3231'), 'h2');
  const eth = function (d) { return Array.from(d.interfaces.values()).filter(function (i) { return i.type === 'ethernet'; }); };
  const rp = eth(r1)[0], sp1 = eth(sw)[0], sp2 = eth(sw)[1], sp3 = eth(sw)[2];
  const hp = eth(h1)[0], h2p = eth(h2)[0];
  const links = [];
  links.push(t.connect(r1.id, rp.name, sw.id, sp1.name, {}));
  links.push(t.connect(sw.id, sp2.name, h1.id, hp.name, {}));
  if (!tweak.oneHostOnly) links.push(t.connect(sw.id, sp3.name, h2.id, h2p.name, {}));
  if (!t.flowState) t.flowState = flow.createFlowState();
  const sim = new Simulator(t, { flowState: t.flowState });
  const cfg = function (d, cmds) { return runCommands(d, t, sim, cmds); };
  const vlan = tweak.vlan || 10;
  cfg(sw, ['configure terminal', 'vlan ' + vlan, 'name USERS', 'exit',
    'interface ' + sp2.name, 'switchport mode access', 'switchport access vlan ' + vlan, 'exit',
    'interface ' + sp3.name, 'switchport mode access', 'switchport access vlan ' + vlan, 'exit',
    'interface ' + sp1.name, 'switchport mode trunk', 'end']);
  const rAddr = tweak.rAddr || '10.70.0.1';
  cfg(r1, ['configure terminal', 'interface ' + rp.name, 'ip address ' + rAddr + ' 255.255.255.0', 'exit',
    'ip route 10.99.0.0 255.255.0.0 10.70.0.9', 'end']);
  cfg(h1, ['configure terminal', 'interface ' + hp.name, 'ip address 10.70.0.11 255.255.255.0', 'end']);
  cfg(h2, ['configure terminal', 'interface ' + h2p.name, 'ip address 10.70.0.12 255.255.255.0', 'end']);
  sim.ping(h1.id, rAddr, { count: 2 });
  sim.ping(h2.id, rAddr, { count: 2 });
  return { t: t, sim: sim, devices: [r1, sw, h1, h2], ids: { r1: r1.id, sw: sw.id, h1: h1.id, h2: h2.id },
    ports: { rp: rp.name, sp1: sp1.name, sp2: sp2.name, sp3: sp3.name, hp: hp.name, h2p: h2p.name }, links: links };
}

const SHOWS = ['show running-config', 'show interfaces', 'show vlan', 'show ip route',
  'show mac address-table', 'show spanning-tree', 'show version'];

function fingerprint(env) {
  const parts = [];
  for (const d of env.devices) {
    const cli = new CliSession(d, env.t, env.sim);
    for (const cmd of SHOWS) parts.push(cmd + '::' + JSON.stringify(cli.run(cmd).output || []));
  }
  parts.push('serialize::' + JSON.stringify(env.t.serialize()));
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

function sleep(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* a real wall-clock wait, which is the point */ }
}

console.log('');
console.log('A lab built twice is the same lab:');
{
  const first = fingerprint(lab());
  const second = fingerprint(lab());
  ok(first === second, 'built twice in one process, it fingerprints the same', first + ' vs ' + second);

  sleep(1200);
  const third = fingerprint(lab());
  ok(first === third, 'and built again a real second later, still the same', first + ' vs ' + third);
}

console.log('');
console.log('And the fingerprint can tell two labs apart:');
{
  const base = fingerprint(lab());
  const otherVlan = fingerprint(lab({ vlan: 20 }));
  ok(otherVlan !== base, 'a different VLAN number is a different lab', otherVlan);
  const otherAddress = fingerprint(lab({ rAddr: '10.70.0.254' }));
  ok(otherAddress !== base, 'a different address is a different lab', otherAddress);
  const fewerCables = fingerprint(lab({ oneHostOnly: true }));
  ok(fewerCables !== base, 'one cable fewer is a different lab', fewerCables);
}

// --- 2. the same document, driven through two independent servers ---------------------------------------------------
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

function startServer(label, dataDir) {
  let port = 0;
  const child = { proc: null };
  return freePort().then(function (p) {
    port = p;
    child.proc = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
      env: Object.assign({}, process.env, { PORT: String(port), PF_DATA: dataDir }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    child.proc.stdout.on('data', function (d) { log += d; });
    child.proc.stderr.on('data', function (d) { log += d; });
    child.log = function () { return log; };
    child.port = port;
    const deadline = Date.now() + 20000;
    return new Promise(function (resolve, reject) {
      (function poll() {
        request(port, 'GET', '/api/version').then(function (r) {
          if (r.status === 200) return resolve(child);
          throw new Error('status ' + r.status);
        }).catch(function (e) {
          if (child.proc.exitCode !== null) return reject(new Error(label + ' exited: ' + log));
          if (Date.now() > deadline) return reject(new Error(label + ' never answered: ' + e.message + ' | ' + log));
          setTimeout(poll, 100);
        });
      })();
    });
  });
}

function stop(child) {
  return new Promise(function (resolve) {
    if (!child || !child.proc) return resolve();
    child.proc.on('exit', function () { resolve(); });
    try { child.proc.kill('SIGTERM'); } catch (e) { resolve(); }
    setTimeout(function () { try { child.proc.kill('SIGKILL'); } catch (e) {} resolve(); }, 5000);
  });
}

(async function () {
  console.log('');
  console.log('The same document, driven through two independent servers, is one payload:');
  const dirs = [];
  const children = [];
  try {
    const env = lab();
    const document = env.t.serialize();
    // The document carries the lab, so the script has to speak in the ids and port names it was written with.
    const script = [
      { kind: 'config', dev: env.ids.sw, body: { commands: ['configure terminal', 'vlan 30', 'name VOICE', 'exit',
        'interface ' + env.ports.sp3, 'switchport mode access', 'switchport access vlan 30', 'end'] } },
      { kind: 'config', dev: env.ids.r1, body: { commands: ['configure terminal', 'ip route 10.98.0.0 255.255.0.0 10.70.0.9', 'end'] } },
      { kind: 'config', dev: env.ids.h2, body: { commands: ['configure terminal', 'interface ' + env.ports.h2p,
        'ip address 10.70.0.112 255.255.255.0', 'end'] } },
      { kind: 'ping', dev: env.ids.h2, body: { src: env.ids.h2, dst: '10.70.0.1', count: 2 } },
      { kind: 'ping', dev: env.ids.h1, body: { src: env.ids.h1, dst: '10.70.0.112', count: 2 } }
    ];
    const payloads = [];
    for (const label of ['a', 'b']) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-replay-' + label + '-'));
      dirs.push(dir);
      const srv = await startServer(label, dir);
      children.push(srv);
      const made = await request(srv.port, 'POST', '/api/topologies', { id: 'topo-replay' });
      ok(made.status === 201, 'server ' + label + ' made a board', String(made.status));
      const loaded = await request(srv.port, 'POST', '/api/topologies/topo-replay/load', document);
      ok(loaded.status === 200 && (loaded.body.state.devices || []).length === 4,
        'server ' + label + ' loaded the document', String(loaded.status) + ' devices ' +
        ((loaded.body.state && loaded.body.state.devices || []).length));
      let refused = null;
      for (const step of script) {
        const url = step.kind === 'config'
          ? '/api/topologies/topo-replay/config/' + step.dev
          : '/api/topologies/topo-replay/ping';
        const body = step.body;
        const r = await request(srv.port, 'POST', url, body);
        if (r.status !== 200) refused = step.kind + ' on ' + step.dev + ' -> ' + r.status + ' ' + JSON.stringify(r.body);
      }
      ok(refused === null, 'server ' + label + ' accepted every step of the script', refused || 'all 200');
      const state = await request(srv.port, 'GET', '/api/topologies/topo-replay');
      ok(state.status === 200, 'server ' + label + ' published its state', String(state.status));
      payloads.push(JSON.stringify(state.body));
    }

    ok(payloads[0] === payloads[1], 'the two servers published byte-identical payloads',
      payloads[0] === payloads[1] ? String(payloads[0].length) + ' bytes'
        : (function () {
          let i = 0;
          while (i < payloads[0].length && payloads[0][i] === payloads[1][i]) i++;
          return 'first difference at ' + i + ': ' + payloads[0].slice(Math.max(0, i - 60), i + 80) +
            ' vs ' + payloads[1].slice(Math.max(0, i - 60), i + 80);
        })());
    ok(payloads[0].length > 4000, 'and the payload is not trivially small', String(payloads[0].length) + ' bytes');

    // Two empty boards are also byte-identical, so the payload being compared has to be one that a simulation ran on:
    // frames crossed, ports counted them, something was learned. Without this the whole comparison above could pass
    // over a server that never forwarded a packet.
    const state = JSON.parse(payloads[0]);
    const runtime = state.runtime || {};
    const counted = Object.keys(runtime).filter(function (id) { return runtime[id].counters && runtime[id].counters.counted; });
    ok(counted.length > 0, 'the compared payload is one traffic crossed', counted.join(', '));
    const crossed = counted.some(function (id) {
      const c = runtime[id].counters;
      return c.packetsIn + c.packetsOut > 0 || Object.keys(c.ports).some(function (p) { return c.ports[p].packetsIn + c.ports[p].packetsOut > 0; });
    });
    ok(crossed, 'with packets counted on it', JSON.stringify(counted.map(function (id) {
      const c = runtime[id].counters;
      return id + ':' + (c.packetsIn + c.packetsOut);
    })));
    const learned = Object.keys(runtime).filter(function (id) { return (runtime[id].mac || []).length > 0; });
    ok(learned.length > 0, 'and a forwarding table that was learned rather than shipped', learned.join(', '));

    // Nothing in the published state is derived from the clock: ask the same server again a second later.
    const first = payloads[0];
    sleep(1200);
    const again = await request(children[0].port, 'GET', '/api/topologies/topo-replay');
    const second = JSON.stringify(again.body);
    ok(first === second, 'and reading the same board a real second later changes nothing',
      first === second ? 'identical' : (function () {
        let i = 0;
        while (i < first.length && first[i] === second[i]) i++;
        return 'first difference at ' + i + ': ' + first.slice(Math.max(0, i - 60), i + 80) +
          ' vs ' + second.slice(Math.max(0, i - 60), i + 80);
      })());
  } catch (e) {
    ok(false, 'the two-server comparison ran to completion', e && e.message);
  } finally {
    for (const c of children) await stop(c);
    for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
  }

  console.log('');
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
