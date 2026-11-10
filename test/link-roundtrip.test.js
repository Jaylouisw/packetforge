'use strict';
// A cable in a document is restored or explained (#1323).
//
// The link half of the round trip. Every option `connect()` accepts survives a save and reload — that part was
// always true, and this file pins it. What was not true is what happens to a cable the loader cannot restore: it
// was skipped by a bare `catch`, so a document with two cables could come back with one and **nothing anywhere
// said so**:
//
//   * two cables sharing an id — the second silently replaced the first, because links are kept in a map;
//   * a cable whose `state` is not `up`/`down`/`blocked` — adopted as-is, giving a cable that `isUp()` says is not
//     up and nothing else can explain. The HTTP API refuses a bad state with 422; the load path accepted anything;
//   * a cable from a port to itself;
//   * a cable naming a device or port the document does not contain.
//
// `serialize()` also handed out its own endpoint records: `doc.links[0].a === link.a`, so a caller adjusting the
// document it was given was adjusting the board.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const { loadCatalog } = require('../devices/registry');
const { Topology } = require('../engine/topology');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const ROOT = path.join(__dirname, '..');
const specs = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
const SW = specs.find(function (s) { return /CX 6000/.test(s.model); });

function twoDevices() {
  const t = new Topology();
  t.addDevice(SW, 'd1');
  t.addDevice(SW, 'd2');
  t.connect('d1', '1/1/1', 'd2', '1/1/1', { mediaId: '1000base-t', speedMbps: 1000 });
  t.connect('d1', '1/1/2', 'd2', '1/1/2', { mediaId: '1000base-t', speedMbps: 1000 });
  return t;
}
function doc(t) { return JSON.parse(JSON.stringify(t.serialize())); }
function codes(topo) { return (topo.loadIssues || []).map(function (i) { return i.code; }); }

(async function main() {
console.log('');
console.log('A cable that is saved comes back the same:');
{
  const cases = [
    ['defaults', undefined],
    ['media and speed', { mediaId: '1000base-t', speedMbps: 1000 }],
    ['half duplex', { mediaId: '1000base-t', speedMbps: 1000, duplex: 'half' }],
    ['a length', { mediaId: '1000base-t', speedMbps: 1000, lengthM: 55 }],
    ['a lag', { mediaId: '1000base-t', speedMbps: 1000, lagId: 'po1' }],
    ['cut at 12.345 s', { mediaId: '1000base-t', speedMbps: 1000, state: 'down', stateSinceMs: 12345 }],
    ['blocked by STP', { mediaId: '1000base-t', speedMbps: 1000, state: 'blocked', stateSinceMs: 999 }],
    ['a legacy type string', 'copper']
  ];
  const wrong = [];
  let port = 1;
  for (const [label, opts] of cases) {
    const t = new Topology();
    t.addDevice(SW, 'd1');
    t.addDevice(SW, 'd2');
    const made = t.connect('d1', '1/1/' + port, 'd2', '1/1/' + port, opts);
    const before = JSON.stringify(made.serialize());
    const back = Topology.fromJSON(doc(t)).links.get(made.id);
    const after = back ? JSON.stringify(back.serialize()) : '(gone)';
    if (before !== after) wrong.push(label + ': ' + before + ' -> ' + after);
    port++;
  }
  ok(wrong.length === 0, cases.length + ' kinds of cable are identical after a save and reload',
    JSON.stringify(wrong.slice(0, 2)));
}

console.log('');
console.log('A cable that cannot be restored is reported, not skipped:');
{
  // Two cables sharing an id.
  {
    const d = doc(twoDevices());
    d.links[1].id = d.links[0].id;
    const t = Topology.fromJSON(d);
    ok(t.links.size === 1, 'two cables with one id leave one cable', String(t.links.size));
    ok(codes(t).indexOf('E_LINK_DUPLICATE_ID') !== -1, 'and the loss is reported', JSON.stringify(codes(t)));
    const issue = (t.loadIssues || []).filter(function (i) { return i.code === 'E_LINK_DUPLICATE_ID'; })[0];
    ok(issue && /share the id/i.test(issue.message), 'with a message saying what happened', issue && issue.message);
  }
  // A state nobody defines.
  {
    const d = doc(twoDevices());
    d.links[0].state = 'sideways';
    const t = Topology.fromJSON(d);
    ok(t.links.size === 1, 'a cable in a state nobody defines is not adopted', String(t.links.size));
    ok(codes(t).indexOf('E_LINK_BAD_STATE') !== -1, 'and is reported', JSON.stringify(codes(t)));
    const issue = (t.loadIssues || [])[0];
    ok(issue && /sideways/.test(issue.message) && /up, down, blocked/.test(issue.message),
      'naming the state and the ones that exist', issue && issue.message);
  }
  // A port cabled to itself.
  {
    const d = doc(twoDevices());
    d.links[0].b = { deviceId: d.links[0].a.deviceId, iface: d.links[0].a.iface };
    const t = Topology.fromJSON(d);
    ok(t.links.size === 1, 'a cable from a port to itself is not adopted', String(t.links.size));
    ok(codes(t).indexOf('E_LINK_SELF_LOOP') !== -1, 'and is reported', JSON.stringify(codes(t)));
  }
  // An endpoint that is not in the document.
  {
    const d = doc(twoDevices());
    d.links[0].b.deviceId = 'gone';
    const t = Topology.fromJSON(d);
    ok(t.links.size === 1, 'a cable to a device that is not there is not adopted', String(t.links.size));
    const issue = (t.loadIssues || [])[0];
    ok(issue && issue.code === 'E_LINK_ENDPOINT_MISSING' && /gone/.test(issue.message),
      'and the report names the end that is missing', issue && issue.message);

    const d2 = doc(twoDevices());
    d2.links[0].a.iface = '1/1/99';
    const t2 = Topology.fromJSON(d2);
    ok((t2.loadIssues || []).some(function (i) { return /1\/1\/99/.test(i.message); }),
      'and a port the device does not have', JSON.stringify((t2.loadIssues || []).map(function (i) { return i.message; })));
  }
  // A cable the engine refuses on its own terms: two cables into one port.
  {
    const d = doc(twoDevices());
    d.links[1].a = { deviceId: d.links[0].a.deviceId, iface: d.links[0].a.iface };
    const t = Topology.fromJSON(d);
    ok(t.links.size === 1, 'a second cable into a port that already has one is not adopted', String(t.links.size));
    const issue = (t.loadIssues || []).filter(function (i) { return i.code === 'E_LINK_NOT_RESTORED'; })[0];
    ok(!!issue && /already connected/.test(issue.message),
      'and the engine sentence is the reason it gives', issue && issue.message);
  }
  // And a clean document says nothing at all.
  {
    const t = Topology.fromJSON(doc(twoDevices()));
    ok(t.links.size === 2 && (t.loadIssues || []).length === 0, 'a clean document loads cleanly and quietly',
      JSON.stringify(t.loadIssues));
  }
}

console.log('');
console.log('The document you are given is yours to change:');
{
  const t = twoDevices();
  const link = Array.from(t.links.values())[0];
  const out = t.serialize();
  ok(out.links[0].a !== link.a, 'serialize() hands out copies of the endpoints');
  out.links[0].a.iface = 'MUTATED';
  out.links[0].mediaId = 'MUTATED';
  ok(t.links.get(link.id).a.iface === link.a.iface && link.mediaId !== 'MUTATED',
    'so writing to the document does not change the board',
    t.links.get(link.id).a.iface + ' / ' + t.links.get(link.id).mediaId);
}

console.log('');
console.log('Over HTTP, a load says which cables it could not keep:');
{
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-link-'));
  const port = await new Promise(function (resolve, reject) {
    const p = net.createServer();
    p.unref(); p.on('error', reject);
    p.listen(0, '127.0.0.1', function () { const n = p.address().port; p.close(function () { resolve(n); }); });
  });
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: Object.assign({}, process.env, { PORT: String(port), PF_DATA: dataDir }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const request = function (method, p, body) {
    return new Promise(function (resolve, reject) {
      const payload = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
      const req = http.request({ host: '127.0.0.1', port: port, path: p, method: method,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} },
        function (res) {
          let d = '';
          res.on('data', function (c) { d += c; });
          res.on('end', function () { let j = d; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, body: j }); });
        });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  };
  try {
    for (let i = 0; ; i++) {
      const r = await request('GET', '/api/version').catch(function () { return { status: 0 }; });
      if (r.status === 200) break;
      if (i > 150) throw new Error('server did not start');
      await new Promise(function (res) { setTimeout(res, 100); });
    }
    // Two documents, one defect each: a document with both is not twice as informative, because a cable that is
    // not restored never takes its id and so cannot clash with itself.
    const dup = doc(twoDevices());
    dup.links[1].id = dup.links[0].id;
    const loadedDup = await request('POST', '/api/topologies/default/load', dup);
    ok(loadedDup.status === 200, 'the document loads rather than being refused', String(loadedDup.status));
    const dupIssues = loadedDup.body && loadedDup.body.state && loadedDup.body.state.loadIssues;
    ok(Array.isArray(dupIssues) && dupIssues.length === 1 && dupIssues[0].code === 'E_LINK_DUPLICATE_ID',
      'and the answer says which cable it could not keep',
      JSON.stringify(dupIssues && dupIssues.map(function (i) { return i.code; })));
    const fetched = await request('GET', '/api/topologies/default');
    ok(fetched.body && Array.isArray(fetched.body.loadIssues) && fetched.body.loadIssues.length === 1,
      'the state payload carries it too, so every surface can see it',
      JSON.stringify(fetched.body && fetched.body.loadIssues));

    const badState = doc(twoDevices());
    badState.links[0].state = 'sideways';
    const loadedBad = await request('POST', '/api/topologies/default/load', badState);
    ok(loadedBad.body && loadedBad.body.state.loadIssues.length === 1 &&
      loadedBad.body.state.loadIssues[0].code === 'E_LINK_BAD_STATE',
      'and a cable in a state nobody defines is reported the same way',
      JSON.stringify(loadedBad.body && loadedBad.body.state.loadIssues));
  } finally {
    try { child.kill('SIGKILL'); } catch (e) {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  }
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
})();
