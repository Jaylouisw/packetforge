'use strict';
// logging.test.js — the event log, which until now nothing could read.
//
// Every protocol in this lab writes events: 25 separate drop sites, forwards, STP blocks, VLAN drops,
// PoE denials, DHCP exchanges, OSPF/BGP state changes, SCION hops, SLAAC refusals. `sim.events` was
// reachable only from a test. So the console could tell you a ping failed and never why:
//
//   PC1#ping 10.0.9.9 count 1
//   Success rate is 0 percent (0/1)
//
// and the reason - `acl-deny` on R1, ACL 101, inbound Gi0/0 - was sitting in the event stream with no
// door. That asymmetry is what this suite pins. `show clock` comes with it, because an event log with
// no clock needs to say so rather than invent a timestamp.
//
// Note the harness: this file drives `CliSession` directly and reads `.output`, so there is no prompt
// filter to get wrong. Earlier suites filtered prompt echoes with a regex, and that filter silently
// ate any row containing `->` (the arrow's `>` looked like a prompt) - a harness bug that reads as a
// missing row, which is the same class of defect as the backspace-in-a-regex trap.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + (actual === expected ? '' : ' (got ' + JSON.stringify(actual) +
    ', want ' + JSON.stringify(expected) + ')'));
}
function match(re, text, msg) {
  ok(re.test(text), msg + (re.test(text) ? '' : ' (no match in ' + JSON.stringify(String(text).slice(0, 400)) + ')'));
}
function model(name) {
  const found = loadCatalog(path.join(__dirname, '..', 'devices')).find((x) => x.model === name);
  if (!found) throw new Error('no such model: ' + name);
  return found;
}

// PC1 --- R1, with an inbound ACL on R1 that denies everything: a ping that must fail, for a reason
// only the log can name.
function lab() {
  const t = new Topology();
  const pc = t.addDevice(model('generic-pc'));
  const r1 = t.addDevice(model('generic-router'));
  pc.name = 'PC1'; r1.name = 'R1';
  t.connect(pc.id, 'eth0', r1.id, 'Gi0/0');
  const sim = new Simulator(t);
  const refusals = [];
  const cfg = function (dev, lines) {
    for (const l of runCommands(dev, t, sim, lines).lines) if (/^%/.test(l)) refusals.push(l);
  };
  cfg(r1, ['enable', 'configure terminal',
    'access-list 101 deny icmp any any', 'access-list 101 permit ip any any',
    'interface Gi0/0', 'ip address 10.0.1.1 255.255.255.0', 'ip access-group 101 in', 'exit', 'exit']);
  cfg(pc, ['enable', 'configure terminal',
    'interface eth0', 'ip address 10.0.1.10 255.255.255.0', 'exit',
    'ip route 0.0.0.0 0.0.0.0 10.0.1.1', 'exit']);
  sim.refreshControlPlanes({ ra: true, lldp: true });
  const session = function (dev) {
    const s = new CliSession(dev, t, sim);
    s.run('enable');
    return s;
  };
  return {
    t, sim, refusals, session,
    run: (dev, cmd) => session(dev).run(cmd).output,
    text: (dev, cmd) => session(dev).run(cmd).output.join('\n')
  };
}

console.log('An empty log says so, and says what to do about it:');
{
  // A lab that has actually run nothing: config plus a control-plane refresh already produces LLDP
  // events, which is the whole reason "empty" has to be its own case rather than a blank table.
  const t = new Topology();
  const r1 = t.addDevice(model('generic-router'));
  r1.name = 'R1';
  const sim = new Simulator(t);
  const s = new CliSession(r1, t, sim);
  s.run('enable');
  const out = s.run('show logging').output.join('\n');
  eq(sim.events.length, 0, 'nothing has run, so the log really is empty');
  match(/No events: the log is empty - nothing has run yet in this lab/, out,
    'the empty log names itself empty rather than printing a bare header');
  match(/Send a packet \(`ping <dst>`\) or run `converge`/, out,
    'and points at the two ways to make events');
}

console.log('\nA failed ping reports the reason, which is the whole point:');
{
  const l = lab();
  const ping = l.text(l.t.getDevice('d1'), 'ping 10.0.9.9 count 1');
  match(/Success rate is 0 percent/, ping, 'the ping fails as the ACL intends');
  ok(!/acl|denied|101/i.test(ping), 'and the ping itself says nothing about why - no ACL, no device');
  const log = l.text(l.t.getDevice('d1'), 'show logging');
  match(/acl-deny/, log, 'the log names the event type');
  match(/R1/, log, 'the device that dropped it');
  match(/101/, log, 'the access list responsible');
  match(/src 10\.0\.1\.10, dst 10\.0\.9\.9/, log, 'and the flow it applied to');
}

console.log('\nThe log is ordered, numbered and readable:');
{
  const l = lab();
  l.run(l.t.getDevice('d1'), 'ping 10.0.9.9 count 1');
  const rows = l.run(l.t.getDevice('d1'), 'show logging');
  const body = rows.filter((r) => /^ {2}\d/.test(r));
  ok(body.length >= 5, 'the table has rows (' + body.length + ')');
  const numbers = body.map((r) => Number(r.trim().split(/\s+/)[0]));
  ok(numbers.every((n, i) => i === 0 || n === numbers[i - 1] + 1),
    'the # column runs consecutively, so no event is silently missing: ' + numbers.join(','));
  match(/^Event log \(\d+ events\):$/, rows[0], 'the heading counts what follows');
  // A frame has no single device, so the Device column reports the pair. Previously this printed
  // `-` for every link-level row.
  match(/PC1 -> R1/, rows.join('\n'), 'a frame names both ends rather than a bare dash');
  const lldp = body.filter((r) => /\blldp\b/.test(r))[0];
  ok(lldp !== undefined, 'lldp events are in the same table');
  match(/on eth0|on Gi0\/0/, lldp, 'with the port they arrived on');
}

console.log('\nFiltering by type, and refusing a type that is not there:');
{
  const l = lab();
  l.run(l.t.getDevice('d1'), 'ping 10.0.9.9 count 1');
  const drops = l.run(l.t.getDevice('d1'), 'show logging acl-deny');
  const body = drops.filter((r) => /^ {2}\d/.test(r));
  eq(body.length, 1, 'exactly one acl-deny row');
  ok(body.every((r) => /acl-deny/.test(r)), 'and every row is that type');
  match(/1 acl-deny events/, drops.join('\n'), 'the heading names the filter and the count');
  const bad = l.text(l.t.getDevice('d1'), 'show logging nonsense');
  match(/% No events of type "nonsense" in this lab/, bad, 'an unknown type is refused');
  match(/% Types seen: .*acl-deny/, bad, 'and the refusal lists the types that do exist');
}

console.log('\nlast <n> trims from the end and validates its argument:');
{
  const l = lab();
  l.run(l.t.getDevice('d1'), 'ping 10.0.9.9 count 1');
  const all = l.run(l.t.getDevice('d1'), 'show logging').filter((r) => /^ {2}\d/.test(r));
  const three = l.run(l.t.getDevice('d1'), 'show logging last 3').filter((r) => /^ {2}\d/.test(r));
  eq(three.length, 3, 'three rows were asked for and three arrived');
  // Compare the row numbers, not the raw lines: two tables have different column widths, so the same
  // event renders with different padding in each. Comparing text would fail for the wrong reason.
  const num = (r) => Number(r.trim().split(/\s+/)[0]);
  eq(num(three[three.length - 1]), num(all[all.length - 1]),
    'and they are the *last* three, not the first');
  eq(num(three[0]), num(all[all.length - 3]), 'the window starts where the full table ends minus three');
  match(/last 3 of \d+ events/, l.run(l.t.getDevice('d1'), 'show logging last 3').join('\n'),
    'the heading says it is trimmed, and from how many');
  for (const bad of ['last abc', 'last 0', 'last -2', 'last 2.5', 'last']) {
    match(/% show logging last <n> takes a positive whole number of events/,
      l.text(l.t.getDevice('d1'), 'show logging ' + bad), '"' + bad + '" is refused by name');
  }
}

console.log('\nFiltering by device:');
{
  const l = lab();
  l.run(l.t.getDevice('d1'), 'ping 10.0.9.9 count 1');
  const out = l.run(l.t.getDevice('d1'), 'show logging device R1');
  const body = out.filter((r) => /^ {2}\d/.test(r));
  ok(body.length > 0, 'R1 has events');
  ok(body.every((r) => /\bR1\b/.test(r)), 'and every row is R1\'s');
  match(/events on R1/, out.join('\n'), 'the heading names the device');
  match(/% No device named "NOPE9"/, l.text(l.t.getDevice('d1'), 'show logging device NOPE9'),
    'an unknown device is refused');
  match(/% show logging device <name> needs a device name/,
    l.text(l.t.getDevice('d1'), 'show logging device'), 'a missing name is refused');
  match(/% Unexpected argument/, l.text(l.t.getDevice('d1'), 'show logging acl-deny extra'),
    'a trailing word is refused rather than ignored');
}

console.log('\nThe summary counts, and its numbers are the table\'s:');
{
  const l = lab();
  l.run(l.t.getDevice('d1'), 'ping 10.0.9.9 count 1');
  const total = l.sim.events.length;
  const sum = l.text(l.t.getDevice('d1'), 'show logging summary');
  match(new RegExp('Event summary \\(' + total + ' of ' + total + ' events\\)'), sum,
    'the summary covers the whole log');
  // Sum the "Events" column of the by-type table and require it to equal the total: a summary that
  // does not add up is worse than no summary.
  const typeRows = sum.split('\n').filter((r) => /^ {2}\S/.test(r) && !/Type|Device|by device/.test(r));
  const counts = typeRows.map((r) => Number(r.trim().split(/\s+/).pop())).filter((n) => !isNaN(n));
  eq(counts.reduce((a, b) => a + b, 0), total, 'the per-type counts add up to the total');
  match(/by device:/, sum, 'and there is a per-device breakdown');
  const onlyDrops = l.text(l.t.getDevice('d1'), 'show logging acl-deny summary');
  match(/Event summary \(1 of \d+ events\)/, onlyDrops, 'the summary composes with the type filter');
}

console.log('\nshow clock says when "now" is, instead of inventing a time:');
{
  const l = lab();
  const atRest = l.text(l.t.getDevice('d1'), 'show clock');
  match(/^t=0 ms - the lab is at rest \(no instant asked\)$/m, atRest,
    'at rest the clock reports t=0 and says why');
  match(/no wall clock/, atRest, 'and states plainly that there is no wall clock');
  l.run(l.t.getDevice('d1'), 'ping 10.0.9.9 count 1 at 5000');
  const asked = l.text(l.t.getDevice('d1'), 'show clock');
  match(/^t=5000 ms {2}\(5 s\) - the instant this lab was asked about$/m, asked,
    'after an instant is named, the clock reports it');
  l.run(l.t.getDevice('d1'), 'ping 10.0.9.9 count 1 at converged');
  match(/^t=0 ms - the lab is at rest/m, l.text(l.t.getDevice('d1'), 'show clock'),
    'and `at converged` puts it back to rest');
}

console.log('\nclear logging is privileged, exact, and honest about what it dropped:');
{
  const l = lab();
  l.run(l.t.getDevice('d1'), 'ping 10.0.9.9 count 1');
  const had = l.sim.events.length;
  ok(had > 0, 'there are events to clear');
  const s = new CliSession(l.t.getDevice('d1'), l.t, l.sim);
  // user exec: refused, and the log is untouched
  const refused = s.run('clear logging').output.join('\n');
  match(/% clear logging needs enable mode - this session is at the user prompt/, refused,
    'clearing from user exec is refused');
  eq(l.sim.events.length, had, 'and nothing was cleared');
  s.run('enable');
  match(new RegExp('Event log cleared \\(' + had + ' events? dropped\\)'),
    s.run('clear logging').output.join('\n'), 'clearing says how many events it dropped');
  eq(l.sim.events.length, 0, 'the log is empty afterwards');
  match(/the log is empty/, s.run('show logging').output.join('\n'),
    'and `show logging` says empty rather than printing a header and nothing');
  s.run('ping 10.0.9.9 count 1');
  ok(l.sim.events.length > 0, 'new events are recorded after a clear');
  match(/% Unexpected argument "now"/, l.run(l.t.getDevice('d1'), 'clear logging now').join('\n'),
    'clear logging refuses an argument it does not have');
}

console.log('\nThe commands are discoverable:');
{
  const l = lab();
  const help = l.text(l.t.getDevice('d1'), '?');
  match(/show clock/, help, 'help lists show clock');
  match(/show logging \[<type>\|summary\] \[last <n>\] \[device <name>\]/, help,
    'help lists show logging with its filters');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
