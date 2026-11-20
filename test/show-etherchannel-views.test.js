'use strict';
// `show etherchannel` is six views; this console had one, and answered all six with it.
//
// The vendor's syntax line is
//   show etherchannel [channel-group-number | {detail | port | port-channel | protocol | summary}]
//   ... | [detail | load-balance | port | port-channel | protocol | summary]
// and Cisco gives each word its own meaning - `detail` "detailed EtherChannel information", `load-balance`
// "the load-balance or frame-distribution scheme among ports in the port channel", `port` "EtherChannel
// port information", `port-channel` "port-channel information", `protocol` "the protocol that is being used
// in the channel", `summary` "a one-line summary per channel group" - with a separate sample under each
// heading. The `protocol` sample is a block per group, not a table row:
//
//   Switch# show etherchannel protocol
//   Channel-group listing:
//   -----------------------
//   Group: 1
//   ----------
//   Protocol: LACP
//
// (Catalyst 2960-X Layer 2 Command Reference, IOS 15.2(2)E, `show etherchannel`, pp. 36-37; the same line
// and the same sample in the 3650 3.6E, 3850 16.3 and 9500 16.6/17.10 references.)
//
// The five views this model cannot answer are the bundle's internals - each member's LACP/PAgP state, its
// admin and oper key, the aggregator MAC, the age timers - or a policy the engine does not implement at all
// (frame distribution). Printing the summary for them answered a different question without saying so. Each
// word is now refused in one line, by the name the reader typed, and pointed at the table that does exist.
// `research/etherchannel-summary-layout.md`, "The other five views".
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const eq = function (a, b) { return JSON.stringify(a) === JSON.stringify(b); };

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];
const ROUTER = catalog.filter(function (s) { return s.model === 'ISR 4331'; })[0];

function ports(dev) {
  return [...dev.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
}

// A switch whose two front ports are in channel group 1, so the summary has a row and "the same table" is a
// statement about content rather than about two bare headers.
function lab() {
  const t = new Topology();
  const a = t.addDevice(SWITCH, 'sw1');
  const b = t.addDevice(SWITCH, 'sw2');
  t.connect('sw1', ports(a)[0].name, 'sw2', ports(b)[0].name);
  t.connect('sw1', ports(a)[1].name, 'sw2', ports(b)[1].name);
  const sim = new Simulator(t);
  const s = new CliSession(a, t, sim);
  s.run('configure terminal');
  for (const p of [ports(a)[0].name, ports(a)[1].name]) {
    s.run('interface ' + p);
    s.run('channel-group 1 mode active');
  }
  s.run('end');
  return { t: t, dev: a, sim: sim, s: s };
}

function say(env, cmd) {
  return ((env.s.run(cmd).output) || []).map(String);
}

console.log('');
console.log('The view this console has: `summary`, its own `brief`, and the bare command');
{
  const env = lab();
  const real = say(env, 'show etherchannel summary');
  const headAt = real.findIndex(function (l) { return /^Group  Port-channel/.test(l); });
  ok(headAt > 0 && /^1\s+Po1\(/.test(real[headAt + 2] || ''),
    'the summary still prints its header and a row for group 1', JSON.stringify(real.slice(headAt, headAt + 3)));
  ok(eq(say(env, 'show etherchannel brief'), real), '`brief` is still the same one-line-per-group view');
  ok(eq(say(env, 'show etherchannel'), real), 'and so is the bare command');
  ok(eq(say(env, 'show etherchannel 1 summary'), real), 'a group number in front still narrows, and does not refuse');
  ok(real.every(function (l) { return l.indexOf('% ') !== 0; }), 'nothing in the summary reports itself as an error');
}

console.log('');
console.log('The five views it does not have are refused, one line each, in the words the reader typed');
{
  const env = lab();
  const cases = [
    ['show etherchannel detail', 'show etherchannel detail', 'counters and age timers'],
    ['show etherchannel port', 'show etherchannel port', 'LACP/PAgP state'],
    ['show etherchannel port-channel', 'show etherchannel port-channel', 'counters and age timers'],
    ['show etherchannel protocol', 'show etherchannel protocol', 'Protocol column'],
    ['show etherchannel load-balance', 'show etherchannel load-balance', 'frame-distribution'],
    ['show etherchannel load', 'show etherchannel load', 'frame-distribution']
  ];
  cases.forEach(function (c) {
    const out = say(env, c[0]);
    ok(out.length === 1, '`' + c[0] + '` answers with one line, not a table', JSON.stringify(out));
    ok(out[0].indexOf('% ') === 0, 'and it says so as a refusal', out[0]);
    ok(out[0].indexOf('`' + c[1] + '` is a view this console does not have') !== -1,
      'it names the view the reader asked for', out[0]);
    ok(out[0].indexOf(c[2]) !== -1, 'it says what that view holds on a box (' + c[2] + ')', out[0]);
  });
  // The one word that can be pointed at a column is pointed at it by name.
  ok(say(env, 'show etherchannel protocol')[0].indexOf('Protocol column of `show etherchannel summary`') !== -1,
    '`protocol` points at the column that carries the same fact');
  // Every refusal names the table that does exist, except the policy this engine has no equivalent of.
  ['detail', 'port', 'port-channel', 'protocol'].forEach(function (w) {
    ok(say(env, 'show etherchannel ' + w)[0].indexOf('`show etherchannel summary`') !== -1,
      '`' + w + '` says where the answer is (`show etherchannel summary`)', say(env, 'show etherchannel ' + w)[0]);
  });
}

console.log('');
console.log('A group number is a filter, not a way back into a view that is not here');
{
  const env = lab();
  const out = say(env, 'show etherchannel 1 detail');
  ok(out.length === 1, '`show etherchannel 1 detail` is one line, not the group-1 table', JSON.stringify(out));
  ok(out[0].indexOf('`show etherchannel detail`') !== -1,
    'and it names the view without the number, which was only a filter', out[0]);
  ok(say(env, 'show etherchannel 1 protocol')[0].indexOf('`show etherchannel protocol`') !== -1,
    'the same for `1 protocol`', say(env, 'show etherchannel 1 protocol')[0]);
}

console.log('');
console.log('The other spelling of the view refuses in its own name');
{
  const env = lab();
  const out = say(env, 'show port-channel detail');
  ok(out.length === 1 && out[0].indexOf('`show port-channel detail`') !== -1,
    '`show port-channel detail` is refused by the name the reader typed', out[0]);
  ok(out[0].indexOf('`show etherchannel summary`') !== -1,
    'and the advice uses the spelling that owns the table, so it can be typed back', out[0]);
  ok(eq(say(env, 'show port-channel summary'), say(env, 'show etherchannel summary')),
    'while `show port-channel summary` still prints exactly that table');
}

console.log('');
console.log('A typo is still a typo, and a box with no bundles refuses the views too');
{
  const env = lab();
  const typo = say(env, 'show etherchannel flurbish');
  ok(typo.length === 1 && /show etherchannel does not take "flurbish"/.test(typo[0]),
    'an unknown word keeps the sentence it had', typo[0]);
  const t = new Topology();
  t.addDevice(ROUTER, 'r1');
  const sim = new Simulator(t);
  const rs = new CliSession(t.getDevice('r1'), t, sim);
  const detail = ((rs.run('show etherchannel detail').output) || []).map(String);
  ok(detail.length === 1 && detail[0].indexOf('is a view this console does not have') !== -1,
    'a router asked for `detail` is told the view is missing, not shown an empty table', detail[0]);
  const summary = ((rs.run('show etherchannel summary').output) || []).map(String);
  ok(summary.length === 13, 'and `summary` still prints the empty table it always did', JSON.stringify(summary.slice(-3)));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
