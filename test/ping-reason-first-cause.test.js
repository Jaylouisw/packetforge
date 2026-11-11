'use strict';
// The reason a ping failed is the earliest cause, not the last (#1431).
//
// `ping` reports why nothing came back by reading the discard events of the run. It read them **from the end
// backwards**, so the reason it reported was the last one - and the last one is usually the least true. With the
// uplink shut and the ARP cache still warm:
//
//   replies: [{ success: false, reason: "peer port shut (r1 Gi0/0/0)" }]      <- correct, the wire is shut
//
// but with a destination nobody owns (the ARP request itself is what got dropped at the shut port):
//
//   replies: [{ success: false, reason: "no ARP reply from 10.91.0.99" }]     <- the wire was shut, not silent
//
// The sweep that reports unanswered ARPs runs at the end of the queue, so its "no ARP reply" is always the last
// event - and it blames silence for a frame that never left. The port being shut is the cause; "no reply" is the
// symptom. So the causes are ranked: a port or wire that cannot carry the frame first, silence next, policy last.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(v, m) { return catalog.find(function (x) { return x.vendor === v && x.model === m; }); }

function lab() {
  const t = new Topology();
  const r1 = t.addDevice(spec('cisco', 'ISR 4331')); r1.name = 'R1';
  const sw = t.addDevice(spec('generic', 'generic-switch')); sw.name = 'SW';
  const a = t.addDevice(spec('generic', 'generic-pc')); a.name = 'PC';
  t.connect(r1.id, 'Gi0/0/0', sw.id, 'Fa0/1');
  t.connect(sw.id, 'Fa0/2', a.id, 'eth0');
  // Commands are run as two blocks: the pool/ACL block must be ended before the interface block, otherwise
  // the interface commands are typed at the wrong prompt and silently unrecognized (#1429 probe).
  const cfg = function (d, lines) { runCommands(d, t, null, ['configure terminal'].concat(lines)); };
  cfg(r1, ['interface Gi0/0/0', 'ip address 10.91.0.1 255.255.255.0', 'no shutdown', 'end']);
  cfg(a, ['interface eth0', 'ip address 10.91.0.10 255.255.255.0', 'end']);
  return { t: t, r1: r1, sw: sw, a: a, cfg: cfg };
}
const reasons = function (p) { return p.replies.map(function (r) { return r.reason; }); };

console.log('');
console.log('A shut port is the cause, and the ping says so:');
{
  const L = lab();
  let s = new Simulator(L.t);
  ok(s.ping(L.a.id, '10.91.0.1', { count: 1 }).success === true, 'the lab answers while the link is up');
  L.cfg(L.r1, ['interface Gi0/0/0', 'shutdown', 'end']);
  s = new Simulator(L.t);
  const p = s.ping(L.a.id, '10.91.0.1', { count: 3 });
  ok(p.replies.every(function (r) { return r.success === false; }), 'every echo fails with the port shut');
  ok(reasons(p).every(function (r) { return /^peer port shut/.test(String(r)); }),
    'and every reply names the shut port, not silence', JSON.stringify(reasons(p)));
  ok(reasons(p)[0].indexOf(L.r1.id) !== -1, 'naming the device whose port is shut', reasons(p)[0]);
}

console.log('');
console.log('An address nobody owns, behind the same shut port, still says the port is shut:');
{
  const L = lab();
  let s = new Simulator(L.t);
  s.ping(L.a.id, '10.91.0.1', { count: 1 });   // warm nothing we rely on; 10.91.0.99 has no entry
  L.cfg(L.r1, ['interface Gi0/0/0', 'shutdown', 'end']);
  s = new Simulator(L.t);
  const p = s.ping(L.a.id, '10.91.0.99', { count: 1 });
  const r = reasons(p)[0];
  // The ARP request for .99 was itself dropped at the shut port, and the end-of-run sweep added "no ARP reply".
  // The sweep's reason is last in the log; the port's is first. The port is the cause.
  ok(/^peer port shut/.test(String(r)), 'the reason is the shut port, not "no ARP reply"', String(r));
  ok(String(r).indexOf('no ARP reply') === -1, 'and it does not blame silence for a frame that never left', String(r));
}

console.log('');
console.log('With the port up, silence is the reason - and it says so:');
{
  const L = lab();
  const s = new Simulator(L.t);
  const p = s.ping(L.a.id, '10.91.0.99', { count: 2 });
  ok(reasons(p).every(function (r) { return /^no ARP reply from 10\.91\.0\.99/.test(String(r)); }),
    'an unanswered ARP is reported as silence when nothing is shut', JSON.stringify(reasons(p)));
}

console.log('');
console.log('Policy still wins over silence when the port is up:');
{
  const L = lab();
  // deny ICMP to the router's address from the PC
  L.cfg(L.r1, ['access-list 10 deny host 10.91.0.10', 'access-list 10 permit any', 'end']);
  L.cfg(L.r1, ['interface Gi0/0/0', 'ip access-group 10 in', 'end']);
  const s = new Simulator(L.t);
  const p = s.ping(L.a.id, '10.91.0.1', { count: 1 });
  const r = String(reasons(p)[0] || '');
  const denyEvents = (p.events || []).filter(function (e) { return e.type === 'acl-deny'; });
  ok(denyEvents.length > 0 && /ACL 10 denied/.test(r),
    'an ACL denial is the reason, not "no reply"',
    'reason=' + r + ' denyEvents=' + JSON.stringify(denyEvents.map(function (e) { return { acl: e.acl, dir: e.dir, dev: e.dev }; })));
}

console.log('');
console.log('And restoring the link makes the same ping answer again:');
{
  const L = lab();
  let s = new Simulator(L.t);
  s.ping(L.a.id, '10.91.0.1', { count: 1 });
  L.cfg(L.r1, ['interface Gi0/0/0', 'shutdown', 'end']);
  s = new Simulator(L.t);
  ok(s.ping(L.a.id, '10.91.0.1', { count: 1 }).success === false, 'fails while shut');
  L.cfg(L.r1, ['interface Gi0/0/0', 'no shutdown', 'end']);
  s = new Simulator(L.t);
  const p = s.ping(L.a.id, '10.91.0.1', { count: 2 });
  ok(p.success === true && p.replies.every(function (r) { return r.success; }),
    'and answers again after `no shutdown`, no stale state', JSON.stringify(reasons(p)));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
