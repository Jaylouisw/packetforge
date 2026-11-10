'use strict';
// interface-verbs.test.js - two interface-mode verbs that answered with something other than the
// truth: `channel-group` (which stored a mode the library does not know) and `description` (which
// confirmed a write that was a clear).
//
// Measured before this pass, on a `generic-switch`:
//   channel-group 1 mode active
//     -> "Interface Fa0/1 added to channel group 1 (mode active)"
//     -> "% Warning: LAG lag1: unknown mode \"active\" (expected one of lacp-active, lacp-passive, static)."
//        ...every single time, because the console word went into the config verbatim and lag.js knows
//        only lacp-active / lacp-passive / static. `mode on` - the one mode with no LACP in it - was
//        rejected the same way, so a static bundle could not be configured at all.
//   channel-group abc        -> "added to channel group abc"  (then the same warning)
//   no channel-group 9       -> "Removed Fa0/2 from any channel group"  (it was never in one)
//   description              -> "Description set"   (it cleared the description)
//   no description           -> (nothing at all)
const path = require('path');
const { Topology, Simulator, CliSession } = require('../engine');
const lagLib = require('../engine/lag');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + (actual === expected ? '' : ' (got ' + JSON.stringify(actual) + ')'));
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const SWITCH = catalog.find(function (s) { return s.model === 'generic-switch'; });
const PC = catalog.find(function (s) { return s.model === 'generic-pc'; });

function oneSwitch() {
  const t = new Topology();
  const sw = t.addDevice(SWITCH); sw.name = 'SW1';
  const sim = new Simulator(t);
  const c = new CliSession(sw, t, sim); c.run('enable'); c.run('configure terminal');
  return { t: t, sw: sw, sim: sim, c: c };
}
const at = function (l, cmds, port) {
  l.c.run('interface ' + (port || 'Fa0/1'));
  let out = [];
  for (const cmd of cmds) out = l.c.run(cmd).output;
  return out;
};

console.log('\nThe console word and the library word are one word, translated:');
{
  const l = oneSwitch();
  const cases = [
    ['active', 'lacp-active', 'LACP active'],
    ['passive', 'lacp-passive', 'LACP passive'],
    ['on', 'static', 'static'],
    ['static', 'static', 'static'],
    ['lacp-active', 'lacp-active', 'LACP active']
  ];
  for (const [typed, stored, shown] of cases) {
    const out = at(l, ['channel-group 1 mode ' + typed]);
    eq(out[0], 'Interface Fa0/1 added to channel group 1 (' + shown + ')',
      'mode ' + typed + ' is described as ' + shown);
    eq(out.length, 1, 'and says nothing else - no warning about its own vocabulary');
    eq(l.sw.config.lags['1'].mode, stored, 'mode ' + typed + ' is stored as ' + stored);
    l.c.run('exit');
  }
  // The defect was invisible in the summary line and unmissable in the warning: assert on the warning
  // directly, so a regression here cannot pass as "one extra line of noise".
  const anyWarn = at(l, ['channel-group 2 mode active']).filter(function (x) { return /unknown mode/.test(x); });
  eq(anyWarn.length, 0, 'no "unknown mode" warning is ever printed');
  // And the library agrees the bundle is well-formed, which is what the warning was really about.
  const chk = lagLib.validateLag(Object.assign({ id: '1' }, l.sw.config.lags['1']), []);
  eq(chk.errors.filter(function (e) { return e.code === 'E_LAG_BAD_MODE'; }).length, 0,
    'lag.js accepts the stored mode');
  l.c.run('exit');
  const listed = l.c.run('show etherchannel').output;
  ok(listed.some(function (r) { return /^1\s+LACP active\s/.test(r); }),
    'show etherchannel prints the protocol, not the raw stored word');
  ok(!listed.some(function (r) { return /lacp-active/.test(r); }),
    'and never the library spelling');
}

console.log('\nA group id is a number, and a mode is one of three words:');
{
  const l = oneSwitch();
  const cases = [
    [['channel-group abc'], '% Channel group id must be a number, not "abc"'],
    [['channel-group 0'], '% Channel group 0 is outside 1-4096'],
    [['channel-group 4097'], '% Channel group 4097 is outside 1-4096'],
    [['channel-group 1 mode'], '% Incomplete command: channel-group 1 mode active|passive|on'],
    [['channel-group 1 mode bogus'], '% Invalid mode: bogus (use active|passive|on)'],
    [['channel-group 1 extra'], '% Unexpected argument "extra" - channel-group <id> mode active|passive|on takes no more'],
    [['channel-group 1 mode active extra'], '% Unexpected argument "extra" - channel-group <id> mode active|passive|on takes no more']
  ];
  for (const [cmds, want] of cases) {
    eq(at(l, cmds)[0], want, cmds[0] + ' is refused');
    l.c.run('exit');
  }
  eq(at(l, ['channel-group'])[0], '% Usage: channel-group <id> mode active|passive|on',
    'and a bare channel-group states the form');
  l.c.run('exit');
  ok(!Object.keys(l.sw.config.lags).some(function (k) { return !/^\d+$/.test(k); }),
    'no non-numeric group id was stored');
}

console.log('\nno channel-group is as narrow as the command that made the group:');
{
  const l = oneSwitch();
  at(l, ['channel-group 1 mode active']);
  l.c.run('exit');
  eq(at(l, ['no channel-group 9'])[0], '% Fa0/1 is not in channel group 9',
    'removing a group the port is not in is refused by name');
  l.c.run('exit');
  at(l, ['channel-group 1 mode active']);
  l.c.run('exit');
  eq(at(l, ['no channel-group 1'])[0], 'Removed Fa0/1 from channel group 1 - the group is gone',
    'removing the last member says the group went with it');
  l.c.run('exit');
  ok(!l.sw.config.lags['1'], 'and the group is really gone');
  eq(at(l, ['no channel-group'])[0], 'Fa0/1 is not in any channel group - nothing to remove',
    'a bare no channel-group on a port in no group says there was nothing to do');
  l.c.run('exit');
  // With two members, removing one keeps the group.
  const m = oneSwitch();
  at(m, ['channel-group 1 mode active'], 'Fa0/1');
  at(m, ['channel-group 1 mode active'], 'Fa0/2');
  eq(at(m, ['no channel-group 1'], 'Fa0/1')[0], 'Removed Fa0/1 from channel group 1 (1 port left)',
    'removing one of two members reports what is left');
  eq(m.sw.config.lags['1'].members.join(','), 'Fa0/2', 'and the survivor is the other port');
}

console.log('\nA bundle is one logical link - the spanning tree and the counters agree:');
{
  const build = function (bundle) {
    const t = new Topology();
    const sw1 = t.addDevice(SWITCH); sw1.name = 'SW1';
    const sw2 = t.addDevice(SWITCH); sw2.name = 'SW2';
    const p1 = t.addDevice(PC); p1.name = 'PC1';
    const p2 = t.addDevice(PC); p2.name = 'PC2';
    t.connect(p1.id, 'eth0', sw1.id, 'Fa0/1');
    t.connect(p2.id, 'eth0', sw2.id, 'Fa0/1');
    t.connect(sw1.id, 'Fa0/7', sw2.id, 'Fa0/7');
    t.connect(sw1.id, 'Fa0/8', sw2.id, 'Fa0/8');
    const sim = new Simulator(t);
    const cfg = function (dev, cmds) {
      const s = new CliSession(dev, t, sim);
      s.run('enable'); s.run('configure terminal');
      for (const cmd of cmds) s.run(cmd);
      s.run('end');
      return s;
    };
    for (const [pc, addr] of [[p1, '10.0.0.1'], [p2, '10.0.0.2']]) {
      const ps = new CliSession(pc, t, sim);
      for (const cmd of ['enable', 'configure terminal', 'interface eth0',
        'ip address ' + addr + ' 255.255.255.0', 'end']) ps.run(cmd);
    }
    const links = function (sw) {
      const cmds = [];
      for (const port of ['Fa0/7', 'Fa0/8']) {
        cmds.push('interface ' + port, 'switchport mode trunk');
        if (bundle) cmds.push('channel-group 1 mode active');
        cmds.push('exit');
      }
      cfg(sw, cmds);
    };
    links(sw1); links(sw2);
    return { t: t, sw1: sw1, sim: sim, p1: p1, cfg: cfg };
  };

  const lagged = build(true);
  const c1 = new CliSession(lagged.sw1, lagged.t, lagged.sim); c1.run('enable');
  const stp = c1.run('show spanning-tree').output.join('\n');
  ok(/lag-1/.test(stp), 'with a bundle, the spanning tree sees one port called lag-1');
  ok(!/Fa0\/7/.test(stp) && !/Fa0\/8/.test(stp), 'and not the two physical links separately');

  const hostOf = function (env) { const h = new CliSession(env.p1, env.t, env.sim); h.run('enable'); return h; };
  const rate = function (env, dst) {
    const m = /Success rate is (\d+) percent/.exec(
      hostOf(env).run('ping ' + dst + ' count 4').output.join(' '));
    return m ? Number(m[1]) : null;
  };
  eq(rate(lagged, '10.0.0.2'), 100, 'and traffic crosses the bundle');
  const used = ['Fa0/7', 'Fa0/8'].filter(function (port) {
    const out = c1.run('show interfaces counters ' + port).output.join('\n');
    const m = new RegExp('^' + port + '\\s+(\\d+)', 'm').exec(out);
    return m && Number(m[1]) > 0;
  });
  eq(used.length, 2, 'both member links carried frames (' + used.join(', ') + ')');

  const plain = build(false);
  const c2 = new CliSession(plain.sw1, plain.t, plain.sim); c2.run('enable');
  const stp2 = c2.run('show spanning-tree').output.join('\n');
  ok(/Fa0\/7/.test(stp2) && /Fa0\/8/.test(stp2),
    'without a bundle the same lab lists the two ports individually - so the collapse is the bundle');
  eq(rate(plain, '10.0.0.2'), 100, 'and the lab still forwards either way, so the difference is the LAG');
}

console.log('\ndescription writes what it says, and a clear says what it cleared:');
{
  const l = oneSwitch();
  eq(at(l, ['description'])[0], '% Incomplete command: description <text>',
    'description with no text is incomplete, not a successful write');
  eq(at(l, ['description uplink to core'])[0], 'Description set on Fa0/1: "uplink to core"',
    'and a real description is echoed back');
  l.c.run('exit');
  eq(at(l, ['no description'])[0], 'Description cleared on Fa0/1 (was "uplink to core")',
    'no description reports what it removed');
  l.c.run('exit');
  eq(at(l, ['no description'])[0], 'No description on Fa0/1 - nothing to clear',
    'and says so when there was nothing to clear');
  l.c.run('exit');
  // The description must not become empty when the command refuses.
  at(l, ['description keep me']);
  l.c.run('exit');
  at(l, ['description']);
  l.c.run('exit');
  eq(String(l.sw.interfaces.get('Fa0/1').description), 'keep me',
    'a refused description leaves the existing one alone');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
