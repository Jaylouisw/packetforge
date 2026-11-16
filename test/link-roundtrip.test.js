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
console.log('A label on a cable is a field of the cable, not a property of the session (#1513):');
{
  // A cable annotation - "via 0-LR-FP1 keystone 2", "USB Ethernet adapter", "DOWN - host decommissioned" -
  // used to be accepted by the live Link and dropped by serialize(), so the whole cabling record was gone the
  // moment the board was saved. A property that reads back but is not in the document is the worst of both
  // worlds: it looks like it worked.
  const at = 'via 0-LR-FP1 keystone 2';
  const t = twoDevices();
  const link = Array.from(t.links.values())[0];
  link.label = at;
  const back = Topology.fromJSON(doc(t)).links.get(link.id);
  ok(back && back.label === at, 'a label set on the cable survives a save and reload',
    back && JSON.stringify(back.label));
  ok(doc(t).links[0].label === at, 'and it is in the document the API hands out', JSON.stringify(doc(t).links[0]));

  // The same through the door a caller actually uses: connect().
  const t2 = new Topology();
  t2.addDevice(SW, 'd1');
  t2.addDevice(SW, 'd2');
  const made = t2.connect('d1', '1/1/1', 'd2', '1/1/1', { mediaId: '1000base-t', speedMbps: 1000, label: at });
  ok(made.label === at, 'connect() takes a label', JSON.stringify(made && made.label));
  ok(Topology.fromJSON(doc(t2)).links.get(made.id).label === at, 'and that one survives too');

  // A cable nobody labelled carries no label key, exactly as before: a saved lab that predates this field must
  // not grow a line of noise in every diff.
  const plain = doc(twoDevices());
  ok(!Object.prototype.hasOwnProperty.call(plain.links[0], 'label'), 'an unlabelled cable writes no label key',
    JSON.stringify(Object.keys(plain.links[0])));

  // And the failure mode this issue is about: a value that is not a label at all must be refused where it is
  // set, not accepted here and dropped by the serialiser.
  let threw = null;
  try {
    const t3 = new Topology();
    t3.addDevice(SW, 'd1');
    t3.addDevice(SW, 'd2');
    t3.connect('d1', '1/1/1', 'd2', '1/1/1', { mediaId: '1000base-t', speedMbps: 1000, label: { note: at } });
  } catch (e) { threw = e; }
  ok(!!threw && threw.code === 'E_BAD_LABEL', 'a label that is not a string is refused, with a code',
    threw && (threw.code + ': ' + threw.message));
  ok(!!threw && /label/i.test(threw.message) && /string/i.test(threw.message),
    'and the refusal says what a label has to be', threw && threw.message);

  // A document stating one is explained rather than adopted, like every other un-restorable cable fact.
  const bad = doc(twoDevices());
  bad.links[0].label = 42;
  const t4 = Topology.fromJSON(bad);
  const badLabel = (t4.loadIssues || []).filter(function (i) { return i.code === 'E_LINK_BAD_LABEL'; })[0];
  ok(!!badLabel, 'a document with a numeric label is explained', JSON.stringify((t4.loadIssues || []).map(function (i) { return i.code; })));
  ok(t4.links.size === 1, 'and that cable is not adopted with the label silently gone', String(t4.links.size));
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
    // A deadline, not an attempt count (#1242 did this for server-immutable-json; #1714 the rest).
    // 150 attempts x 100 ms is fifteen seconds of wall clock, sized for one server on an idle machine.
    // Ten suites start one each at PF_TEST_CONCURRENCY=10 and each start costs 6.98-7.41 s measured, so
    // the bound has to be time the machine actually took. A server that never comes up still fails, and
    // now the failure says what the last attempt saw instead of only that it gave up.
    const startDeadline = Date.now() + 60000;
    let startError = null;
    for (;;) {
      const r = await request('GET', '/api/version').catch(function (e) { startError = e; return { status: 0 }; });
      if (r.status === 200) break;
      if (Date.now() >= startDeadline) {
        throw new Error('server did not start within 60000 ms (last error: ' +
          ((startError && (startError.code || startError.message)) || 'no reply') + ')');
      }
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

    // A label given to the API is on the cable it made, in the answer and in the document every surface reads
    // (#1513). Before this, the label was accepted by the live Link and gone from the save.
    const cab = await request('POST', '/api/topologies/default/links', {
      a: { deviceId: 'd1', iface: '1/1/3' }, b: { deviceId: 'd2', iface: '1/1/3' },
      mediaId: '1000base-t', label: 'via keystone 2'
    });
    ok(cab.status === 201 && cab.body.link && cab.body.link.label === 'via keystone 2',
      'a label given with a cable comes back on the cable',
      cab.status + ' ' + JSON.stringify(cab.body && cab.body.link));
    const reread = await request('GET', '/api/topologies/default');
    ok((reread.body.links || []).filter(function (l) { return l.label === 'via keystone 2'; }).length === 1,
      'and is in the state payload', JSON.stringify((reread.body.links || []).map(function (l) { return l.label; })));

    // A cable that is already there can be named afterwards, and a PATCH that carries only a label must not take
    // the length away with it.
    const linkId = cab.body.link.id;
    const patched = await request('PATCH', '/api/topologies/default/links/' + linkId, { lengthM: 12 });
    ok(patched.status === 200 && patched.body.link.lengthM === 12, 'a length still sets a length', String(patched.status));
    const named = await request('PATCH', '/api/topologies/default/links/' + linkId, { label: 'USB Ethernet adapter' });
    ok(named.status === 200 && named.body.link.label === 'USB Ethernet adapter' && named.body.link.lengthM === 12,
      'a label-only PATCH names the cable and leaves its length alone',
      JSON.stringify(named.body && named.body.link));
    const cleared = await request('PATCH', '/api/topologies/default/links/' + linkId, { label: null });
    ok(cleared.status === 200 && cleared.body.link.label === null, 'and null clears it',
      JSON.stringify(cleared.body && cleared.body.link));
    const refused = await request('POST', '/api/topologies/default/links', {
      a: { deviceId: 'd1', iface: '1/1/5' }, b: { deviceId: 'd2', iface: '1/1/5' },
      mediaId: '1000base-t', label: 42
    });
    ok(refused.status === 409 && refused.body.code === 'E_BAD_LABEL',
      'a label that is not text is refused, not accepted and dropped',
      refused.status + ' ' + JSON.stringify(refused.body && refused.body.code));
  } finally {
    try { child.kill('SIGKILL'); } catch (e) {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  }
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
})();
