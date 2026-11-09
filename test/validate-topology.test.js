'use strict';
// validateTopology() is named for a job it could not do.
//
// It aggregated a list of issues somebody else had already collected, so nothing but tests ever
// called it - and the tests passed it things it silently ignored. `validation.validateTopology(topo)`
// returned `{ ok: true }` without looking at a single cable, because a Topology has no `.code` field
// and the collector skipped it. A caller that passed the wrong shape was told its lab was clean.
//
// These checks hold it to the job: take a topology, produce one verdict per cable using the same
// validateLink() the canvas uses, name the cable in every issue, and say so loudly when it is handed
// something that is not a topology.
const fs = require('fs');
const path = require('path');
const { Topology } = require('../engine');
const validation = require('../engine/validation');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) passed++;
  else { failed++; console.log('  not ok - ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
function codes(list) { return (list || []).map(function (i) { return i.code; }); }

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.filter(function (s) { return /CRS326-24G/.test(s.model); })[0];
const PC = catalog.filter(function (s) { return /generic-pc/.test(s.model); })[0];

function lab() {
  const t = new Topology({});
  const sw = t.addDevice(SWITCH);
  const pc = t.addDevice(PC);
  const link = t.connect(sw.id, 'ether1', pc.id, 'eth0', { mediaId: '1000base-t' });
  return { t: t, sw: sw, pc: pc, link: link };
}

console.log('');
console.log('A whole topology is answered as a whole:');
{
  const { t } = lab();
  const summary = validation.validateTopology(t);
  ok(summary.ok === true, 'one good cable is a healthy topology');
  ok(summary.errorCount === 0 && summary.warningCount === 0, 'with nothing to report');
  ok(Array.isArray(summary.issues) && summary.issues.length === 0, 'and an empty issue list');

  const empty = validation.validateTopology(new Topology({}));
  ok(empty.ok === true && empty.issues.length === 0, 'an empty topology is healthy too, not an error');
}

console.log('');
console.log('It agrees with asking each cable separately:');
{
  const t = new Topology({});
  const sw = t.addDevice(SWITCH);
  const pc = t.addDevice(PC);
  const pc2 = t.addDevice(PC);
  const l1 = t.connect(sw.id, 'ether1', pc.id, 'eth0', { mediaId: '1000base-t' });
  const l2 = t.connect(sw.id, 'ether2', pc2.id, 'eth0', { mediaId: '1000base-t' });

  const aggregate = validation.validateTopology(t);
  const perLink = [];
  for (const [id, link] of t.links) {
    const verdict = t.validateLink(link.a.deviceId, link.a.iface, link.b.deviceId, link.b.iface, {
      mediaId: link.mediaId, lengthM: link.lengthM, revalidate: id
    });
    for (const e of (verdict.errors || [])) perLink.push(e.code);
    for (const w of (verdict.warnings || [])) perLink.push(w.code);
  }
  ok(JSON.stringify(aggregate.issues.map(function (i) { return i.code; }).sort()) === JSON.stringify(perLink.sort()),
    'the same codes in the same number, whichever way you ask',
    JSON.stringify(codes(aggregate.issues)) + ' vs ' + JSON.stringify(perLink));
  ok(aggregate.ok === true, 'two good cables are healthy');
  ok(t.links.size === 2 && l1.id !== l2.id, 'the fixture really has two distinct cables');
}

console.log('');
console.log('A bad cable is reported, and it is named:');
{
  const { t, link } = lab();
  // Make the cable impossible after the fact: an optical medium between two RJ45 ports.
  link.mediaId = '1000base-lx';
  const summary = validation.validateTopology(t);
  ok(summary.ok === false, 'the topology fails');
  ok(summary.issues.length > 0, 'with at least one issue');
  ok(summary.issues.every(function (i) { return i.linkId === link.id; }),
    'every issue names the cable it came from', JSON.stringify(summary.issues.map(function (i) { return i.linkId; })));
  ok(/MEDIA|SPEED|CONNECTOR/.test(codes(summary.issues).join(',')),
    'and the code is the physical complaint', codes(summary.issues).join(','));
  ok(summary.issues.every(function (i) { return typeof i.message === 'string' && i.message.length > 10; }),
    'each one carries a readable message');
}

console.log('');
console.log('A cable pointing at a device that is not there does not throw:');
{
  const { t, link } = lab();
  t.devices.delete(link.b.deviceId);
  let summary = null, threw = null;
  try { summary = validation.validateTopology(t); } catch (e) { threw = e; }
  ok(!threw, 'the check survives a dangling cable', threw && threw.message);
  ok(summary && summary.ok === false, 'and reports it as a failure rather than a clean lab');
  ok(summary && summary.issues.some(function (i) { return i.linkId === link.id; }),
    'naming the cable that is dangling', summary && JSON.stringify(codes(summary.issues)));
}

console.log('');
console.log('Being handed the wrong thing is an error, not a clean bill of health:');
{
  const junk = validation.validateTopology({ vendor: 'x', model: 'y' });
  ok(junk.ok === false, 'a random object fails');
  ok(codes(junk.issues).indexOf('E_NOT_A_TOPOLOGY') !== -1, 'with E_NOT_A_TOPOLOGY', codes(junk.issues).join(','));
  ok(/topology/i.test(junk.issues[0].message), 'and a message that says what it wanted');

  const device = validation.validateTopology({ interfaces: new Map(), config: {} });
  ok(device.ok === false, 'a device-shaped object fails the same way');

  // The list shape it always accepted must keep working untouched.
  const list = validation.validateTopology([{ code: 'E_PORT_IN_USE' }, { code: 'W_DISTANCE_NEAR_LIMIT' }]);
  ok(list.ok === false && list.errorCount === 1 && list.warningCount === 1,
    'a list of issues still aggregates exactly as before');
  ok(validation.validateTopology([]).ok === true, 'and an empty list is still healthy');
}

console.log('');
console.log('Re-checking an existing cable by name works, and an invented name grants nothing:');
{
  const { t, sw, pc, link } = lab();
  // The pair the port-in-use rule wants is the far end seen from each side, which is easy to get
  // backwards - and getting it backwards fails as "port in use" on a cable that plainly exists.
  const crossed = t.revalidateFor(link.id);
  ok(crossed && crossed.a.iface === link.b.iface && crossed.b.iface === link.a.iface,
    'revalidateFor() returns the crossed pair', JSON.stringify(crossed));
  ok(t.revalidateFor('l999') === null, 'and null for an id that is not a link');

  const byId = t.validateLink(sw.id, 'ether1', pc.id, 'eth0', { mediaId: '1000base-t', revalidate: link.id });
  ok(byId.ok === true, 'naming the cable satisfies the port-in-use rule', codes(byId.errors).join(','));

  const byStaleId = t.validateLink(sw.id, 'ether1', pc.id, 'eth0', { mediaId: '1000base-t', revalidate: 'l999' });
  ok(byStaleId.ok === false && codes(byStaleId.errors).indexOf('E_PORT_IN_USE') !== -1,
    'an id that is not a link is refused, so a stale id cannot wave in a second cable',
    codes(byStaleId.errors).join(','));

  const second = t.addDevice(PC);
  const nothing = t.validateLink(sw.id, 'ether2', second.id, 'eth0', { mediaId: '1000base-t' });
  ok(nothing.ok === true, 'two free ports need no revalidate at all');
  const occupied = t.validateLink(sw.id, 'ether2', pc.id, 'eth0', { mediaId: '1000base-t' });
  ok(occupied.ok === false && codes(occupied.errors).indexOf('E_PORT_IN_USE') !== -1,
    'and a port already carrying a cable is still refused, revalidate or not', codes(occupied.errors).join(','));

  const changed = t.setLinkLength(link.id, 3);
  ok(changed.ok === true, 'setLinkLength still revalidates its own cable');
}

console.log('');
console.log('Both entry points are documented, so the next caller finds the right one:');
{
  const doc = fs.readFileSync(path.join(__dirname, '..', 'engine', 'validation.js'), 'utf8');
  ok(/needs a topology, or a list of issues/.test(doc), 'validation.js explains what validateTopology accepts');
  ok(/revalidateFor/.test(fs.readFileSync(path.join(__dirname, '..', 'engine', 'topology.js'), 'utf8')),
    'topology.js keeps the pair convention in one place');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
