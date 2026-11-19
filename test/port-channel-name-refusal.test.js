'use strict';
// `show interfaces Port-channel1` on a switch that has built the bundle (research/port-channel-show-interfaces.md).
//
// A box answers that command with a block headed `Port-channel1 is up, line protocol is up` and a
// `Members in this channel: Gi1/0/4 Gi1/0/5` line (Cisco doc 69979, doc 12033-89, doc 12029-71). This console
// prints no block for a bundle - and it answered the name with `% No interface Port-channel1 on <box>`, the
// sentence a *misspelt* physical port gets, about an interface the same session prints twice: the
// `Port-channel1 ... up up` row of `show ip interface brief` and the `Po1(SU)` row of
// `show etherchannel summary`. An operator who typed a name they had just read off a table was sent looking
// for a spelling mistake.
//
// What is locked here:
//   1. every spelling of a configured bundle's name is answered with the noun - an EtherChannel bundle - and
//      with the view that does print it (`show etherchannel summary`), and never with `No interface`;
//   2. the long form is used in the answer whatever was typed, because the answer is about the interface;
//   3. a bundle that is not configured is still `% No interface ...`, which is true;
//   4. a name that merely starts with the letters is not a bundle (`pod1`, `po`, `po-1`);
//   5. no block is invented: the answer carries no MAC, no status and no counters;
//   6. the member's own block is unchanged and still carries its `channel-group` line;
//   7. the views that do name the bundle still name it (`Po1(SU)` in the summary, `Port-channel1` in brief).
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

// Two switches, two cables, both ends in group 1 - the bundle a lab builds.
function lab(joined) {
  const t = new Topology();
  const a = t.addDevice(SWITCH, 'sw1');
  const b = t.addDevice(SWITCH, 'sw2');
  const pa = [...a.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
  const pb = [...b.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
  for (let i = 0; i < 2; i++) t.connect('sw1', pa[i].name, 'sw2', pb[i].name);
  const sim = new Simulator(t);
  const sa = new CliSession(a, t, sim);
  const sb = new CliSession(b, t, sim);
  if (joined) {
    sa.run('enable'); sb.run('enable');
    sa.run('configure terminal'); sb.run('configure terminal');
    for (let i = 0; i < 2; i++) {
      sa.run('interface ' + pa[i].name); sa.run('channel-group 1 mode active');
      sb.run('interface ' + pb[i].name); sb.run('channel-group 1 mode active');
    }
    sa.run('end'); sb.run('end');
  }
  return { t: t, sa: sa, sb: sb, pa: pa };
}

function say(env, cmd) { return ((env.sa.run(cmd).output) || []).map(String); }
function text(env, cmd) { return say(env, cmd).join('\n'); }

console.log('');
console.log('Every spelling of a configured bundle is answered as a bundle:');
{
  const env = lab(true);
  for (const typed of ['Po1', 'po1', 'Port-channel1', 'Port-channel 1', 'port-channel 1', 'portchannel1']) {
    const out = text(env, 'show interfaces ' + typed);
    ok(/^% Port-channel1 is an EtherChannel bundle/.test(out),
      '`' + typed + '` names the bundle by its interface name', out);
    ok(out.indexOf('show etherchannel summary') !== -1,
      'and points at the view that prints it', out);
    ok(out.indexOf('No interface') === -1,
      'and does not claim the port is missing', out);
  }
  ok(lagLib.bundleIdFromName('Port-channel 1') === 1 && lagLib.bundleIdFromName('Po1') === 1,
    'the two spellings are one id in one library');
}

console.log('');
console.log('A bundle nobody configured is still a name that matches nothing:');
{
  const env = lab(true);
  const out = text(env, 'show interfaces Po9');
  ok(/^% No interface Po9 on /.test(out), 'group 9 is not configured, so it is not called a bundle', out);
  const none = lab(false);
  const bare = text(none, 'show interfaces Port-channel1');
  ok(/^% No interface Port-channel1 on /.test(bare), 'and a switch with no bundle says so the old way', bare);
}

console.log('');
console.log('A name that merely starts with the letters is not a bundle:');
{
  const env = lab(true);
  for (const typed of ['pod1', 'po', 'po-1', 'Port-channel']) {
    const out = text(env, 'show interfaces ' + typed);
    ok(/^% No interface /.test(out), '`' + typed + '` is a port name nobody has', out);
    ok(out.indexOf('EtherChannel bundle') === -1, 'and is not offered the bundle sentence', out);
  }
  // The keyword refusals are not hijacked either: `status` is a view, not a bundle.
  ok(/is a view, not a port/.test(text(env, 'show interfaces status')),
    'and `show interfaces status` still answers as a view');
}

console.log('');
console.log('No block is invented for the bundle:');
{
  const env = lab(true);
  const out = say(env, 'show interfaces Po1');
  ok(out.length === 1, 'the answer is one line, not a block', String(out.length));
  ok(!/MAC |status: |packets input|counters/.test(out.join('\n')),
    'with no hardware address, no status and no counters it would have had to make up');
}

console.log('');
console.log('The physical port and the views that name the bundle are unchanged:');
{
  const env = lab(true);
  const member = say(env, 'show interfaces ' + env.pa[0].name);
  ok(/^Gi1\/0\/1 \(ethernet, 1G\), MAC /.test(member[0] || ''),
    'the member still prints its block', member[0]);
  ok(member.indexOf('  status: up, protocol: up') !== -1, 'with its status line', member.join('\n'));
  // The membership line belongs to the configuration view, not to `show interfaces` - a box does not print one
  // in the member's block either. Guard it so the new name test cannot have moved it.
  ok(/^  channel-group 1 mode active$/m.test(text(env, 'show running-config')),
    'and `show running-config` still carries its channel-group line under the member');
  const summary = say(env, 'show etherchannel summary');
  const groupRow = summary.filter(function (l) { return /^1\s+Po1\(/.test(l); })[0] || '';
  ok(/Po1\(SU\)/.test(groupRow), 'the summary still calls it Po1(SU)', groupRow);
  const brief = text(env, 'show ip interface brief');
  ok(/^Port-channel1\s+unassigned\s+YES unset\s+up\s+up$/m.test(brief),
    'and brief still carries its Port-channel1 row');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
