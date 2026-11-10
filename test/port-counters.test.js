'use strict';
// port-counters.test.js — per-port counts, and the invitation that had to be honoured.
//
// Last iteration's refusal for `show interfaces counters` ended with "per-port counters and status are
// in `show interfaces <port>`". That command printed a name, a state, an address and a peer. No
// counters. A pointer to a command that cannot answer is worse than "not a command here": the operator
// goes where they were told, finds nothing, and concludes the lab never carried traffic.
//
// So the counters are real, and the command that was refused is a command. What this suite holds them
// to is not "a number appeared" but that each number can be checked against something else the
// simulator recorded independently - the frame events - so a counter cannot drift from the traffic.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + (actual === expected ? '' : '\n      got: ' + JSON.stringify(actual) +
    '\n      want: ' + JSON.stringify(expected)));
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const model = (m) => {
  const s = catalog.find((x) => x.model === m);
  if (!s) throw new Error('missing model ' + m);
  return s;
};
const aruba = () => {
  const s = catalog.find((x) => x.vendor === 'aruba' && x.model === 'CX 6000 24G CL4 PoE 4SFP 370W');
  if (!s) throw new Error('missing switch');
  return s;
};

// A router with two hosts, so one port can be busy and another idle.
function lab() {
  const t = new Topology();
  const r = t.addDevice(model('generic-router'));
  const a = t.addDevice(model('generic-pc'));
  const b = t.addDevice(model('generic-pc'));
  r.name = 'R1'; a.name = 'PC1'; b.name = 'PC2';
  t.connect(a.id, 'eth0', r.id, 'Gi0/0');
  t.connect(b.id, 'eth0', r.id, 'Gi0/1');
  const sim = new Simulator(t);
  const bad = runCommands(r, t, sim, ['enable', 'configure terminal', 'hostname R1',
    'interface Gi0/0', 'ip address 10.0.1.1 255.255.255.0', 'exit',
    'interface Gi0/1', 'ip address 10.0.2.1 255.255.255.0', 'exit', 'exit'])
    .lines.filter((l) => /^%/.test(l));
  if (bad.length) throw new Error('lab refused: ' + bad.join(' / '));
  runCommands(a, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.1.10 255.255.255.0', 'exit', 'exit']);
  runCommands(b, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.2.10 255.255.255.0', 'exit', 'exit']);
  return { t, sim, r, a, b };
}
const answer = (dev, ctx, cmds) => runCommands(dev, ctx.t, ctx.sim, ['enable'].concat(cmds)).lines
  .filter((l) => !/^[^\s#>]+[#>]\s?/.test(l));
const text = (dev, ctx, cmds) => answer(dev, ctx, cmds).join('\n');

// The independent record: how many frames the log says crossed *this port*, per direction.
//
// Per port, not per device, because that is the claim being checked - a device total can be right while
// every port is wrong.
function logFrames(ctx, dev, iface) {
  let inb = 0, outb = 0;
  for (const e of ctx.sim.events) {
    if (e.type !== 'frame') continue;
    if (e.to === dev.id && e.toIface === iface) inb++;
    if (e.from === dev.id && e.fromIface === iface) outb++;
  }
  return { inb, outb };
}

console.log('The counters agree with the frames the log recorded:');
{
  const ctx = lab();
  answer(ctx.a, ctx, ['ping 10.0.1.1 count 1']);
  const frames = logFrames(ctx, ctx.r, 'Gi0/0');
  const st = ctx.sim.portStats(ctx.r.id, 'Gi0/0');
  eq(st.rx, frames.inb, 'rx packets == frames the log delivered to this port');
  eq(st.tx, frames.outb, 'tx packets == frames the log says this port emitted');
  ok(st.rx > 0 && st.tx > 0, 'and traffic actually crossed, so the comparison is not 0 == 0');
  // Every run also emits one LLDP frame per port - real traffic, which a real switch counts - so the
  // exact arithmetic is stated rather than asserted loosely: 64-byte LLDP + 64-byte ARP + 134-byte
  // ICMP echo (100 payload + 20 IP + 14 Ethernet). A byte counter nobody can reproduce is a byte
  // counter nobody can trust.
  eq(st.rx, 3, 'three frames arrived: LLDP, the ARP request and the echo');
  eq(st.rxBytes, 64 + 64 + 134, 'and the bytes are exactly those three frames');
  const counted = logFrames(ctx, ctx.r, 'Gi0/1');
  const other = ctx.sim.portStats(ctx.r.id, 'Gi0/1');
  eq(other.rx, counted.inb, 'a second port reconciles with the log too');
  eq(other.rxBytes, 64, 'it carried only its LLDP frame - the ping did not touch it');
}

console.log('\nCounters are per port, and cumulative:');
{
  const ctx = lab();
  answer(ctx.a, ctx, ['ping 10.0.1.1 count 1']);
  const busy = ctx.sim.portStats(ctx.r.id, 'Gi0/0');
  const idle = ctx.sim.portStats(ctx.r.id, 'Gi0/1');
  ok(busy.rx > 0, 'the port that carried the ping has traffic');
  ok(idle.rx < busy.rx && idle.rxBytes < busy.rxBytes,
    'the other port carries only link traffic, so it is counted separately and far less');
  const before = busy.rx;
  answer(ctx.a, ctx, ['ping 10.0.1.1 count 1']);
  ok(ctx.sim.portStats(ctx.r.id, 'Gi0/0').rx > before,
    'a second ping adds to the count instead of replacing it (cumulative from the lab start)');
  // And the same fact from the console, not the API: asking twice does not reset by asking.
  const first = text(ctx.r, ctx, ['show interfaces counters Gi0/0']);
  const second = text(ctx.r, ctx, ['show interfaces counters Gi0/0']);
  eq(second.split('\n').filter((l) => /^Gi0\/0 /.test(l))[0],
    first.split('\n').filter((l) => /^Gi0\/0 /.test(l))[0],
    'and asking does not clear - a reset on every console command would make the table always zero');
}

console.log('\n`show interfaces <port>` now prints the counters it was said to print:');
{
  const ctx = lab();
  answer(ctx.a, ctx, ['ping 10.0.1.1 count 1']);
  const out = text(ctx.r, ctx, ['show interfaces Gi0/0']);
  const st = ctx.sim.portStats(ctx.r.id, 'Gi0/0');
  ok(new RegExp('input : ' + st.rx + ' packets, ' + st.rxBytes + ' bytes').test(out),
    'input line matches portStats');
  ok(new RegExp('output: ' + st.tx + ' packets, ' + st.txBytes + ' bytes').test(out),
    'output line matches portStats');
  ok(/drops : 0/.test(out), 'drops line is present even when zero - an absent row reads as "not measured"');
  ok(/peer: PC1\/eth0/.test(out), 'and the peer line is still there');
}

console.log('\nThe command that used to be refused:');
{
  const ctx = lab();
  answer(ctx.a, ctx, ['ping 10.0.1.1 count 2']);
  const out = text(ctx.r, ctx, ['show interfaces counters']);
  ok(!/is not a command here/.test(out), 'no longer refused');
  ok(/^Interface counters on R1:$/m.test(out), 'it has its own heading naming the device');
  // Every row is parseable and equals portStats, so the table cannot drift from the model.
  const rows = out.split('\n').filter((l) => /^Gi0\/\d+ /.test(l));
  const stats = ctx.sim.portStats(ctx.r.id);
  eq(rows.length, stats.length, 'one row per counted port');
  let mismatched = [];
  for (const row of rows) {
    const cells = row.trim().split(/\s+/);
    const st = ctx.sim.portStats(ctx.r.id, cells[0]);
    if (cells[1] !== String(st.rx) || cells[3] !== String(st.tx) || cells[5] !== String(st.drops)) {
      mismatched.push(row);
    }
  }
  eq(mismatched.join(' | '), '', 'every cell equals portStats for that port');
  // The totals line must reconcile with the rows, or it is a second opinion.
  const totals = out.split('\n').filter((l) => /counted: .* in, .* out,/.test(l))[0] || '';
  const sum = (k) => stats.reduce((a, s) => a + s[k], 0);
  const nums = (totals.match(/(\d+) in, (\d+) out, (\d+) dropped/) || []).slice(1).map(Number);
  eq(nums.join(','), [sum('rx'), sum('tx'), sum('drops')].join(','),
    'the totals line sums the rows (' + totals.trim() + ')');
  ok(/^1 port counted|^[2-9]\d* ports counted/.test(totals.trim()),
    'and it says "port" or "ports" rather than "port(s)": "' + totals.trim().split(' counted')[0] + '"');
  // Column offsets: the sweep in table-layout covers most tables; this one is pinned here too.
  const header = out.split('\n').filter((l) => /^Port\s/.test(l))[0] || '';
  const starts = [];
  for (let i = 0; i < header.length; i++) if (header[i] !== ' ' && (i === 0 || header[i - 1] === ' ')) starts.push(i);
  let glued = [];
  for (const row of rows) {
    for (const s of starts) {
      if (s > 0 && row[s] === undefined) glued.push('short:' + row);
      else if (s > 0 && row[s - 1] !== ' ' && row[s] !== ' ') glued.push('glued:' + row);
    }
  }
  eq(glued.join(' | '), '', 'no cell is glued to its neighbour');
}

console.log('\nA drop is counted, with its reason:');
{
  const ctx = lab();
  // Deny at the router's ingress so the frame arrives and is then dropped: an input drop, which is
  // where a real device counts it.
  answer(ctx.r, ctx, ['configure terminal', 'access-list 101 deny ip 10.0.1.10 0.0.0.0 any',
    'access-list 101 permit ip any any', 'interface Gi0/0', 'ip access-group 101 in', 'exit', 'exit']);
  answer(ctx.a, ctx, ['ping 10.0.1.1 count 1']);
  const st = ctx.sim.portStats(ctx.r.id, 'Gi0/0');
  ok(st.drops > 0, 'the drop is counted on the port that refused the frame');
  const reasons = Object.keys(st.reasons);
  ok(reasons.length > 0, 'the reason is kept, not just the number: ' + JSON.stringify(st.reasons));
  const out = text(ctx.r, ctx, ['show interfaces Gi0/0']);
  const dropsLine = out.split('\n').filter((l) => /drops :/.test(l))[0] || '';
  ok(new RegExp('drops : ' + st.drops + '\\s+\\(').test(dropsLine),
    'and it is printed with the reasons beside it: "' + dropsLine.trim() + '"');
}

console.log('\nClearing is explicit, named, and privileged:');
{
  const ctx = lab();
  answer(ctx.a, ctx, ['ping 10.0.1.1 count 1']);
  answer(ctx.b, ctx, ['ping 10.0.2.1 count 1']);
  ok(ctx.sim.portStats(ctx.r.id, 'Gi0/0').rx > 0 && ctx.sim.portStats(ctx.r.id, 'Gi0/1').rx > 0,
    'both ports have traffic');
  // `clear counters <port>` touches one port.
  const out = text(ctx.r, ctx, ['clear counters Gi0/0']);
  ok(/Counters cleared on Gi0\/0/.test(out), 'the answer names the port: "' + out.trim() + '"');
  eq(ctx.sim.portStats(ctx.r.id, 'Gi0/0').rx, 0, 'that port is zero');
  ok(ctx.sim.portStats(ctx.r.id, 'Gi0/1').rx > 0, 'the other port is untouched');
  // And the whole-device form clears the rest, saying how much it discarded.
  const all = text(ctx.r, ctx, ['clear counters']);
  ok(/Counters cleared on R1/.test(all), 'the device form names the device');
  eq(ctx.sim.portStats(ctx.r.id, 'Gi0/1').rx, 0, 'everything is zero');
  // Refusals: a port that does not exist, and a session that is not enabled.
  ok(/% No interface named Gi0\/9 on R1/.test(text(ctx.r, ctx, ['clear counters Gi0/9'])),
    'an unknown port is refused by name');
  const unpriv = runCommands(ctx.r, ctx.t, ctx.sim, ['clear counters']).lines
    .filter((l) => !/^[^\s#>]+[#>]\s?/.test(l)).join('\n');
  ok(/needs enable mode/.test(unpriv), 'and a user-mode session is told it needs enable');
  // IOS spellings both work.
  answer(ctx.a, ctx, ['ping 10.0.1.1 count 1']);
  ok(/Counters cleared on R1/.test(text(ctx.r, ctx, ['clear interface counters'])),
    '`clear interface counters` is the same command');
}

console.log('\nA switch counts on the ports frames actually cross:');
{
  const t = new Topology();
  const sw = t.addDevice(aruba());
  const h1 = t.addDevice(model('generic-pc'));
  const h2 = t.addDevice(model('generic-pc'));
  sw.name = 'SW1'; h1.name = 'H1'; h2.name = 'H2';
  t.connect(h1.id, 'eth0', sw.id, '1/1/3');
  t.connect(h2.id, 'eth0', sw.id, '1/1/4');
  const sim = new Simulator(t);
  runCommands(h1, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.0.10 255.255.255.0', 'exit', 'exit']);
  runCommands(h2, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.0.11 255.255.255.0', 'exit', 'exit']);
  runCommands(h1, t, sim, ['enable', 'ping 10.0.0.11 count 1']);
  const toH2 = sim.portStats(sw.id, '1/1/4');
  const fromH1 = sim.portStats(sw.id, '1/1/3');
  ok(fromH1.rx > 0, 'the ingress port counted what arrived');
  ok(toH2.tx > 0, 'the egress port counted what it forwarded');
  const out = runCommands(sw, t, sim, ['enable', 'show interfaces counters']).lines
    .filter((l) => !/^[^\s#>]+[#>]\s?/.test(l)).join('\n');
  ok(/^1\/1\/3\s+\d+\s+\d+\s+\d+/m.test(out) && /^1\/1\/4\s+\d+/m.test(out),
    'and a switch shows both ports, with their slashed names intact');
  // The slashed name is the reason the counters are stored per device rather than in one "dev/iface"
  // map key: "SW1/1/1/3" cannot be split back into a device and a port.
  eq(sim.portStats(sw.id).length, sim.portStats(sw.id).filter((r) => /^\d+\/\d+\/\d+$/.test(r.iface)).length,
    'every counted port name survives the round trip');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
