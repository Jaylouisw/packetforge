'use strict';
// How many links one EtherChannel can carry, and what the box does with the ones that do not fit (#2023).
//
// Every Catalyst chapter that documents EtherChannels gives the same three numbers, and the console applied
// none of them: "Each EtherChannel can consist of up to eight compatibly configured Ethernet ports ... For a
// PAgP EtherChannel, you can configure up to eight ports ... For a LACP EtherChannel, you can configure up to 16
// Ethernet ports ... Up to eight ports can be active, and up to eight ports can be in standby mode" (Cisco,
// *Configuring EtherChannels*, Catalyst 2960-X 15.2(3)E). It took a ninth, a tenth and a fortieth member, called
// every one of them `(P)` bundled, and hashed frames across all of them - so a "ten-link bundle" moved ten
// links' worth of traffic, which is a switch nobody sells. The `H - Hot-standby (LACP only)` line of the key
// printed above the table was unreachable for the same reason: no member could ever be in that state.
//
// What is locked here:
//   1. the pure rule: eight active, the rest hot-standby, chosen in port order;
//   2. a ninth `mode on` member is refused, and the group is left exactly as it was;
//   3. a sixteenth LACP member is accepted, a seventeenth is refused;
//   4. the receipt for a member that lands in hot-standby says so, because "added to channel group" alone
//      reads as a ninth active link;
//   5. `show etherchannel summary` prints `(H)` for the parked members - the letter in the key - and (P) for
//      the eight that carry;
//   6. the data plane never hashes a frame onto a hot-standby member;
//   7. an active link that goes away promotes a standby member, which is what hot-standby is for.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const lagLib = require('../engine/lag');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.filter(function (s) { return s.model === 'C2960X-24TS-L'; })[0];

if (!SWITCH) {
  console.error('  \u2717 C2960X-24TS-L is not in the catalogue');
  process.exit(1);
}

// Two switches and `n` cables between their first n ports, each end configured into one group.
function lab(n, mode) {
  const t = new Topology();
  const a = t.addDevice(SWITCH, 'sw1');
  const b = t.addDevice(SWITCH, 'sw2');
  const pa = [...a.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
  const pb = [...b.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
  const links = [];
  for (let i = 0; i < n; i++) links.push(t.connect('sw1', pa[i].name, 'sw2', pb[i].name));
  const sim = new Simulator(t);
  const sa = new CliSession(a, t, sim);
  const sb = new CliSession(b, t, sim);
  for (const s of [sa, sb]) { s.run('enable'); s.run('configure terminal'); }
  const receipts = [];
  for (let i = 0; i < n; i++) {
    for (const pair of [[sa, pa], [sb, pb]]) {
      pair[0].run('interface ' + pair[1][i].name);
      const out = ((pair[0].run('channel-group 1 mode ' + (mode || 'active')).output) || []).map(String);
      if (pair[0] === sa) receipts.push.apply(receipts, out);
    }
  }
  sa.run('end'); sb.run('end');
  return { t: t, a: a, b: b, sa: sa, sb: sb, pa: pa, pb: pb, sim: sim, receipts: receipts, links: links };
}

function say(env, cmd) {
  return ((env.sa.run(cmd).output) || []).map(String);
}

function rowFor(lines, id) {
  return lines.filter(function (l) { return l.indexOf(String(id) + ' ') === 0; })[0] || '';
}

// The letters the Ports column uses for one member: "Gi1/0/9(H)" -> "H".
function flagOf(line, name) {
  const m = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\(([A-Za-z])\\)').exec(line);
  return m ? m[1] : '';
}

const TEN = [];
for (let i = 1; i <= 10; i++) TEN.push('Gi1/0/' + i);

console.log('');
console.log('The rule, in engine/lag.js: eight active links, then hot-standby in port order');
{
  ok(lagLib.MAX_ACTIVE_LINKS === 8, 'a bundle carries eight links', String(lagLib.MAX_ACTIVE_LINKS));
  ok(lagLib.maxMembers('lacp-active') === 16, 'an LACP group holds sixteen members', String(lagLib.maxMembers('lacp-active')));
  ok(lagLib.maxMembers('lacp-passive') === 16, 'active and passive are the same protocol and the same cap');
  ok(lagLib.maxMembers('static') === 8, 'a non-negotiating (`on`) group holds eight', String(lagLib.maxMembers('static')));
  ok(lagLib.activeMembers(TEN, null).length === 8 && lagLib.activeMembers(TEN, null)[7] === 'Gi1/0/8',
    'the first eight in port order are the active ones', lagLib.activeMembers(TEN, null).join(','));
  ok(lagLib.standbyMembers(TEN, null).join(',') === 'Gi1/0/9,Gi1/0/10',
    '"hot-standby ports that have lower port numbers become active in the channel first" - so 9 and 10 wait',
    lagLib.standbyMembers(TEN, null).join(','));
  // Port order, not string order: `Gi1/0/10` sorts before `Gi1/0/2` as text, and that is not the panel.
  const shuffled = ['Gi1/0/10', 'Gi1/0/2', 'Gi1/0/1'];
  ok(lagLib.activeMembers(shuffled, null).join(',') === 'Gi1/0/1,Gi1/0/2,Gi1/0/10',
    'port order, not string order', lagLib.activeMembers(shuffled, null).join(','));
  ok(lagLib.eligibleMembers(TEN, null).length === 8,
    'nothing outside the active eight is eligible for the hash', lagLib.eligibleMembers(TEN, null).join(','));
}

console.log('');
console.log('A ninth `mode on` member is refused, and the group keeps the eight it had');
{
  const env = lab(9, 'on');
  const out = env.receipts.slice(-3);
  const lag = env.a.config.lags['1'] || { members: [] };
  ok(lag.members.length === 8, 'the group still holds eight members', String(lag.members.length));
  ok(out.some(function (l) { return /^% Gi1\/0\/9 not added/.test(l); }),
    'the ninth line is refused by name', JSON.stringify(out));
  ok(out.some(function (l) { return /carries at most 8 links/.test(l); }),
    'and the refusal states the number it applies', JSON.stringify(out));
  ok(out.some(function (l) { return /Nothing was changed/.test(l); }),
    'and says the group was left alone', JSON.stringify(out));
  ok(env.a.config.lags['1'].members.indexOf('Gi1/0/9') === -1, 'the refused port is not a member');
  const lines = say(env, 'show etherchannel summary');
  ok(flagOf(rowFor(lines, 1), 'Gi1/0/9') === '', 'and it is not in the table either');
}

console.log('');
console.log('An LACP group takes sixteen, a hot-standby receipt above eight, and refuses the seventeenth');
{
  const env = lab(17, 'active');
  const lag = env.a.config.lags['1'] || { members: [] };
  ok(lag.members.length === 16, 'sixteen members are held, the seventeenth refused', String(lag.members.length));
  const refused = env.receipts.filter(function (l) { return /^% Gi1\/0\/17 not added/.test(l); });
  ok(refused.length === 1, 'the seventeenth is refused by name', JSON.stringify(env.receipts.slice(-3)));
  ok(/8 active links and 8 in hot-standby/.test(refused[0] || ''),
    'and the refusal says where the other eight go', refused[0]);
  const ninth = env.receipts.filter(function (l) { return /Gi1\/0\/9 is hot-standby/.test(l); });
  ok(ninth.length === 1, 'the ninth member is told it is hot-standby at the moment it is configured',
    JSON.stringify(env.receipts.filter(function (l) { return /hot-standby/.test(l); }).slice(0, 3)));
  const eighth = env.receipts.filter(function (l) { return /Gi1\/0\/8 is hot-standby/.test(l); });
  ok(eighth.length === 0, 'the eighth is not: the bundle had room for it');
}

console.log('');
console.log('The table prints the letter the key above it documents');
{
  const env = lab(10, 'active');
  const lines = say(env, 'show etherchannel summary');
  const row = rowFor(lines, 1);
  const flags = TEN.map(function (name) { return flagOf(row, name); });
  ok(flags.slice(0, 8).every(function (f) { return f === 'P'; }), 'the eight in the channel read (P)', JSON.stringify(flags));
  ok(flags[8] === 'H' && flags[9] === 'H', 'the two parked links read (H) hot-standby', JSON.stringify(flags));
  ok(/Gi1\/0\/9\s+hot-standby: the bundle already holds 8 active links/.test(lines.join('\n')),
    'the line under the table says why they are parked', lines.slice(-3).join(' | '));
  ok(/bundle 1 carries 8 active links; Gi1\/0\/9, Gi1\/0\/10 hot-standby/.test(lines.join('\n')),
    'and the bundle line states the split rather than calling it degraded', lines.slice(-2).join(' | '));
  ok(!/is running on 8 of 10/.test(lines.join('\n')),
    'a bundle at full width is not reported as running short', lines.slice(-2).join(' | '));
}

console.log('');
console.log('Hot-standby is not in the data plane, and takes over when an active link fails');
{
  const env = lab(10, 'active');
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    seen.add(lagLib.selectMember(env.a.config.lags['1'].members,
      { srcIp: '10.0.0.' + (i % 200), dstIp: '10.0.1.1', srcPort: 1024 + i, dstPort: 80 }, 'l3l4'));
  }
  ok(seen.size === 8, 'the hash lands on eight distinct members, not ten', String(seen.size));
  ok(!seen.has('Gi1/0/9') && !seen.has('Gi1/0/10'), 'and never on a hot-standby member',
    [...seen].sort().join(','));

  // Pull an active member's cable: the first standby takes its place.
  env.t.disconnect(env.links[2].id);
  const lines = say(env, 'show etherchannel summary');
  const row = rowFor(lines, 1);
  ok(flagOf(row, 'Gi1/0/3') === 'D', 'the pulled member reads (D)', row);
  ok(flagOf(row, 'Gi1/0/9') === 'P', 'and the standby is promoted in its place', row);
  ok(flagOf(row, 'Gi1/0/10') === 'H', 'the second standby stays parked', row);
  ok(/bundle 1 carries 8 active links/.test(lines.join('\n')), 'the bundle is still at eight links');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
