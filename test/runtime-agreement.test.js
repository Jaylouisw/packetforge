'use strict';
// What the tables say, once (#1327).
//
// `show mac address-table`, `show arp` and `show lldp` each grew an honest note: which port an entry was learned
// on, and whether that port can still carry a frame - `(administratively down)`, `(down: peer shut down)`,
// `(vlan mismatch)`, `(gone)`. The state payload the browser reads published the **raw maps** instead:
//
//   runtime[d].macTable = { "02:00:00:00:01:00": "1/1/1" }
//   runtime[d].arp      = { "10.0.0.2": "02:00:00:00:02:00" }
//
// so a stale entry and a live one were the same two strings, and LLDP was not published at all. This is the
// Routes table fault (#1300) again: the fact was computed in the console, not in the engine.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const { loadCatalog } = require('../devices/registry');
const { Topology } = require('../engine/topology');
const { Simulator } = require('../engine/simulator');
const cliModule = require('../engine/cli');
const CliSession = cliModule.CliSession || cliModule;

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const ROOT = path.join(__dirname, '..');
const specs = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
const SW = specs.find(function (s) { return /CX 6000/.test(s.model); });
const HOST = specs.find(function (s) { return /Raspberry Pi 5/.test(s.model); }) ||
  specs.find(function (s) { return s.category === 'host'; });
const MAC1 = '02:00:00:00:01:00';
const MAC2 = '02:00:00:00:02:00';
const IP2 = '10.0.0.2';

function lab() {
  const t = new Topology();
  t.addDevice(SW, 'sw'); t.addDevice(HOST, 'h1'); t.addDevice(HOST, 'h2');
  t.connect('sw', '1/1/1', 'h1', 'eth0');
  t.connect('sw', '1/1/2', 'h2', 'eth0');
  const sw = t.getDevice('sw');
  sw.macTable.set(MAC1, '1/1/1');
  sw.macTable.set(MAC2, '1/1/2');
  sw.arp.set(IP2, MAC2);
  sw.arpPorts.set(IP2, '1/1/2');
  sw.lldp.set('1/1/2', { systemName: 'h2', portId: 'eth0', mgmtIp: IP2 });
  return { t: t, sw: sw };
}
function cli(t, dev, cmd) {
  return ((new CliSession(dev, t, null).run(cmd) || {}).output || []).map(String).join('\n');
}

(async function main() {
  console.log('');
  console.log('The console row and the published row are the same row:');
  {
    const situations = [
      ['nothing is wrong', function (x) {}, ''],
      ['the port is administratively down', function (x) { x.sw.interfaces.get('1/1/1').enabled = false; },
        '(administratively down)'],
      ['the far end is shut down', function (x) { x.t.getDevice('h1').interfaces.get('eth0').enabled = false; },
        '(down: peer shut down)'],
      // `link down` is deliberately absent: a link state change flushes what was learned on that port, so an
      // entry cannot survive to carry the note. That is the engine's own rule (#1256), not a gap in this test.
      ['the port became a trunk that does not carry VLAN 1', function (x) {
        x.sw.interfaces.get('1/1/1').vlan = { mode: 'trunk', allowedVlans: [20] };
      }, '(vlan mismatch)'],
      ['the port moved to another VLAN', function (x) {
        x.sw.interfaces.get('1/1/1').vlan = { mode: 'access', accessVlan: 20 };
      }, '(vlan mismatch)']
    ];
    const wrong = [];
    let withNote = 0, withoutNote = 0;
    const noted = [];
    for (const [label, apply, expectNote] of situations) {
      const x = lab();
      apply(x);
      const mac = x.sw.macRows(x.t).filter(function (r) { return r.mac === MAC1; })[0];
      const arpRow = x.sw.arpRows(x.t)[0];
      const arpNote = arpRow.note;
      const lldpNote = x.sw.lldpRows(x.t)[0].note;
      if (mac.note !== expectNote) wrong.push(label + ': macRows says ' + JSON.stringify(mac.note) + ' not ' + JSON.stringify(expectNote));
      if (mac.note) { withNote++; noted.push(mac.note); } else withoutNote++;
      // The console must say exactly what the row says - not a second sentence that happens to be similar.
      const macOut = cli(x.t, x.sw, 'show mac address-table');
      const line = macOut.split('\n').filter(function (l) { return l.indexOf(MAC1) !== -1; })[0] || '';
      const wanted = mac.port + (mac.note ? ' ' + mac.note : '');
      if (line.indexOf(wanted) === -1) wrong.push(label + ': console prints ' + JSON.stringify(line.trim()) + ', row wants ' + JSON.stringify(wanted));
      // The same fact about the same port, in the two other tables.
      const arpOut = cli(x.t, x.sw, 'show arp');
      const arpLine = arpOut.split('\n').filter(function (l) { return l.indexOf(IP2) !== -1; })[0] || '';
      if (arpNote && arpLine.indexOf(arpNote) === -1) wrong.push(label + ': show arp does not carry ' + JSON.stringify(arpNote));
      // The ARP entry was learned on 1/1/2, so it is compared with the MAC row on 1/1/2 - same port, same fact.
      const onSamePort = x.sw.macRows(x.t).filter(function (r) { return r.port === arpRow.port; })[0];
      if (onSamePort && arpNote !== onSamePort.note) {
        wrong.push(label + ': arp says ' + JSON.stringify(arpNote) + ' while the MAC row on the same port says ' +
          JSON.stringify(onSamePort.note));
      }
      const lldpOut = cli(x.t, x.sw, 'show lldp');
      const lldpLine = lldpOut.split('\n').filter(function (l) { return l.indexOf('h2') !== -1; })[0] || '';
      if (lldpNote && lldpLine.indexOf(lldpNote) === -1) wrong.push(label + ': show lldp does not carry ' + JSON.stringify(lldpNote));
    }
    ok(wrong.length === 0, situations.length + ' situations agree between the console and the rows',
      JSON.stringify(wrong.slice(0, 3)));
    const distinct = {};
    for (const n of noted) distinct[n] = 1;
    ok(withNote > 0 && withoutNote > 0, 'and the matrix reaches both a note and no note',
      'with=' + withNote + ' without=' + withoutNote);
    ok(Object.keys(distinct).length >= 3, 'and at least three different reasons are reached',
      JSON.stringify(Object.keys(distinct)));
  }

  console.log('');
  console.log('A row is not just the port:');
  {
    const x = lab();
    x.sw.interfaces.get('1/1/2').enabled = false;
    const mac = x.sw.macRows(x.t).filter(function (r) { return r.mac === MAC2; })[0];
    ok(mac.vlan === 1 && mac.port === '1/1/2' && mac.note === '(administratively down)',
      'a MAC row carries its VLAN, its port and its reason', JSON.stringify(mac));
    const arp = x.sw.arpRows(x.t)[0];
    // The age is a number of minutes once the engine has heard the neighbour (#1397); this lab wrote the entry
    // by hand, so nothing dated it and the row says so with null - the console prints that as '-'.
    ok(arp.ip === IP2 && arp.mac === MAC2 && arp.port === '1/1/2' && arp.age === null,
      'an ARP row carries the neighbour, the port it was learned on, and an honest age', JSON.stringify(arp));
    const nb = x.sw.lldpRows(x.t)[0];
    ok(nb.systemName === 'h2' && nb.portId === 'eth0' && nb.mgmtIp === IP2 && nb.note,
      'and an LLDP row carries what was announced and where', JSON.stringify(nb));

    // An entry whose port is not on the device any more.
    x.sw.macTable.set('02:00:00:00:03:00', '9/9/9');
    const ghost = x.sw.macRows(x.t).filter(function (r) { return r.mac === '02:00:00:00:03:00'; })[0];
    ok(ghost.port === '9/9/9' && ghost.note === '(gone)', 'a row pointing at a port that is not there says so',
      JSON.stringify(ghost));

    // Everything sorts, so two callers never disagree about order.
    const rows = x.sw.macRows(x.t).map(function (r) { return r.mac; });
    ok(rows.length === 3 && rows.join() === rows.slice().sort().join(), 'and rows come back sorted', rows.join());
  }

  console.log('');
  console.log('Over HTTP, the payload carries the rows:');
  {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-runtime-'));
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
      const placed = await request('POST', '/api/topologies/default/devices', { vendor: SW.vendor, model: SW.model });
      const swId = placed.body.device.id;
      const state = await request('GET', '/api/topologies/default');
      const rt = state.body.runtime[swId];
      ok(Array.isArray(rt.mac) && Array.isArray(rt.arpRows) && Array.isArray(rt.lldp),
        'every device has mac, arpRows and lldp, even when they are empty',
        JSON.stringify({ mac: rt.mac, arpRows: rt.arpRows, lldp: rt.lldp }));
      ok(Object.keys(rt.macTable).length === rt.mac.length,
        'and the bare map and the rows do not disagree about how many entries there are',
        Object.keys(rt.macTable).length + ' vs ' + rt.mac.length);
    } finally {
      try { child.kill('SIGKILL'); } catch (e) {}
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
    }
  }

  console.log('');
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
