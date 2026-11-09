'use strict';
// One LAG mode vocabulary, translated once (#1283).
//
// The console speaks IOS: `channel-group 1 mode active|passive|on`. The model speaks its own words:
// `lacp-active|lacp-passive|static`. Nothing translated between them, so every correct command stored the
// console's word and then had it validated against the model's list:
//
//   Interface Fa0/1 added to channel group 1 (mode active)
//   % Warning: LAG lag1: unknown mode "active" (expected one of lacp-active, lacp-passive, static).
//
// A warning on every correct command is a refusal that has learned to whisper: the operator either stops
// reading warnings or stops trusting them. Two smaller lies rode along with it:
//
//   * a group is one object with one mode, so configuring a second member with a different mode silently
//     rewrote the first port's configuration - and `show running-config` reprinted both with the new mode
//     without a word;
//   * `no channel-group` on a port that was in no group answered "Removed Fa0/4 from any channel group".
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
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];

function ports(dev) {
  return [...dev.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
}

// Two switches, two cables between them: a LAG with two live members.
function lab() {
  const t = new Topology();
  const a = t.addDevice(SWITCH, 'sw1');
  const b = t.addDevice(SWITCH, 'sw2');
  const pa = ports(a);
  const pb = ports(b);
  t.connect('sw1', pa[0].name, 'sw2', pb[0].name);
  t.connect('sw1', pa[1].name, 'sw2', pb[1].name);
  const sim = new Simulator(t);
  const s = new CliSession(a, t, sim);
  s.run('enable');
  s.run('configure terminal');
  return { t: t, a: a, b: b, sim: sim, s: s, pa: pa };
}

function say(env, cmd) {
  return ((env.s.run(cmd).output) || []).map(String);
}

function config(env) {
  return ((env.s.run('show running-config').output) || []).map(String);
}

console.log('');
console.log('The translation is total, and reversible:');
{
  const pairs = [['active', 'lacp-active'], ['passive', 'lacp-passive'], ['on', 'static'],
    ['lacp-active', 'lacp-active'], ['lacp-passive', 'lacp-passive'], ['static', 'static']];
  for (const [typed, canonical] of pairs) {
    ok(lagLib.canonicalMode(typed) === canonical, typed + ' -> ' + canonical,
      String(lagLib.canonicalMode(typed)));
    ok(lagLib.cliMode(canonical) === (typed.indexOf('lacp-') === 0 || typed === 'static'
      ? (canonical === 'static' ? 'on' : canonical.replace('lacp-', '')) : typed),
      canonical + ' -> ' + lagLib.cliMode(canonical), String(lagLib.cliMode(canonical)));
  }
  ok(lagLib.canonicalMode('ACTIVE') === 'lacp-active', 'case does not matter');
  ok(lagLib.canonicalMode('nonsense') === 'nonsense',
    'an unknown word survives translation, so validation can name it rather than swallow it');
}

console.log('');
console.log('Every correct channel-group command is silent about modes:');
{
  for (const mode of ['active', 'passive', 'on']) {
    const env = lab();
    const out = [].concat(say(env, 'interface ' + env.pa[0].name),
      say(env, 'channel-group 1 mode ' + mode));
    ok(out.some(function (l) { return /added to channel group 1 \(mode /.test(l); }),
      mode + ': the port joins the group', JSON.stringify(out));
    ok(!out.some(function (l) { return /unknown mode/.test(l); }),
      mode + ': with no complaint about the mode', JSON.stringify(out));
    ok(!out.some(function (l) { return /^%/.test(l); }),
      mode + ': and no warning at all, with the second member still to come', JSON.stringify(out));
    // "needs at least 2 members" is true of every bundle between the first and second line, so warning on it
    // turned every correct configuration into a warning storm. The standing view of the group says it
    // instead - the same fact, in the one place that is a statement about the group rather than about the
    // command just typed.
    const summary = ((env.s.run('show etherchannel summary').output) || []).map(String)
      .join(String.fromCharCode(10));
    ok(/has 1 member: a bundle needs at least 2 ports/.test(summary),
      mode + ': the shortfall is reported in the summary instead', summary);
  }
}

console.log('');
console.log('The model stores its own vocabulary, and the console prints the operator\'s:');
{
  const env = lab();
  say(env, 'interface ' + env.pa[0].name);
  say(env, 'channel-group 1 mode active');
  say(env, 'interface ' + env.pa[1].name);
  say(env, 'channel-group 1 mode active');
  ok(env.a.config.lags['1'].mode === 'lacp-active', 'stored as lacp-active',
    JSON.stringify(env.a.config.lags));
  say(env, 'end');
  const cfg = config(env);
  const lines = cfg.filter(function (l) { return /channel-group/.test(l); });
  ok(lines.length === 2, 'both members are printed', JSON.stringify(lines));
  ok(lines.every(function (l) { return /mode active$/.test(l.trim()); }),
    'in the console\'s word, which is the only spelling the parser takes back', JSON.stringify(lines));

  // ...and it replays.
  const fresh = lab();
  fresh.s.run('enable');
  const errs = [];
  for (const line of cfg) {
    for (const l of (fresh.s.run(line).output || [])) if (/^%/.test(String(l))) errs.push(String(l));
  }
  ok(errs.length === 0, 'and the printed config replays with nothing rejected', JSON.stringify(errs));
  ok(fresh.a.config.lags['1'] && fresh.a.config.lags['1'].mode === 'lacp-active',
    'into the same canonical state', JSON.stringify(fresh.a.config.lags));
}

console.log('');
console.log('Changing the mode says so, because it changes every member:');
{
  const env = lab();
  say(env, 'interface ' + env.pa[0].name);
  say(env, 'channel-group 1 mode active');
  say(env, 'interface ' + env.pa[1].name);
  const out = say(env, 'channel-group 1 mode passive');
  ok(out.some(function (l) { return /mode changed from active to passive/.test(l); }),
    'the change is announced', JSON.stringify(out));
  ok(out.some(function (l) { return /for every member: Fa0\/1/.test(l); }),
    'and names the other members it affects', JSON.stringify(out));
  ok(env.a.config.lags['1'].mode === 'lacp-passive', 'the group holds one mode', JSON.stringify(env.a.config.lags));
  say(env, 'end');
  ok(config(env).filter(function (l) { return /channel-group/.test(l); })
    .every(function (l) { return /mode passive/.test(l); }),
    'and the config prints what is actually in force', JSON.stringify(config(env).filter(function (l) {
      return /channel-group/.test(l);
    })));
}

console.log('');
console.log('The summary names the protocol and the mode, in the operator\'s words:');
{
  const env = lab();
  for (const p of [env.pa[0].name, env.pa[1].name]) {
    say(env, 'interface ' + p);
    say(env, 'channel-group 1 mode active');
  }
  say(env, 'end');
  const summary = (env.s.run('show etherchannel summary').output || []).map(String);
  const row = summary.filter(function (l) { return /^1\s/.test(l); })[0] || '';
  ok(/LACP \(active\)/.test(row), 'the row reads LACP (active)', row);
  ok(/Fa0\/1\(P\)/.test(row), 'and both members are bundled, because both cables are in', row);
  // The columns must not run together - the failure `show lldp` had.
  ok(/^Group\s+Protocol\s+Ports$/.test(summary[0] || ''), 'the header names three columns', summary[0]);
  const protoAt = (summary[0] || '').indexOf('Protocol');
  const portsAt = (summary[0] || '').indexOf('Ports');
  ok(protoAt >= 0 && portsAt > protoAt, 'with Ports to the right of Protocol', summary[0]);
  const rowProtoEnd = row.indexOf('LACP (active)') + 'LACP (active)'.length;
  ok(row.slice(rowProtoEnd).indexOf(' ') === 0 || rowProtoEnd === portsAt,
    'and the mode never touches the port list', row);

  // Static is spelled the way the operator spelled it.
  const env2 = lab();
  for (const p of [env2.pa[0].name, env2.pa[1].name]) {
    say(env2, 'interface ' + p);
    say(env2, 'channel-group 1 mode on');
  }
  say(env2, 'end');
  const row2 = ((env2.s.run('show etherchannel summary').output) || []).map(String)
    .filter(function (l) { return /^1\s/.test(l); })[0] || '';
  ok(/Static/.test(row2), 'mode on reads Static', row2);
}

console.log('');
console.log('Removing a port from a group reports what happened, not what was asked:');
{
  const env = lab();
  say(env, 'interface ' + env.pa[0].name);
  const notMember = say(env, 'no channel-group');
  ok(notMember.some(function (l) { return /is not in a channel group/.test(l); }),
    'a port in no group is refused by name', JSON.stringify(notMember));

  say(env, 'channel-group 1 mode active');
  say(env, 'interface ' + env.pa[1].name);
  say(env, 'channel-group 1 mode active');
  say(env, 'end');
  say(env, 'configure terminal');
  say(env, 'interface ' + env.pa[0].name);
  const one = say(env, 'no channel-group');
  ok(one.some(function (l) { return /removed from channel group 1/.test(l); }), 'a member is removed',
    JSON.stringify(one));
  ok(!one.some(function (l) { return /no other members/.test(l); }),
    'and the group is not reported gone while one member remains', JSON.stringify(one));
  ok(env.a.config.lags['1'] && env.a.config.lags['1'].members.length === 1, 'the group keeps its other member',
    JSON.stringify(env.a.config.lags));

  say(env, 'interface ' + env.pa[1].name);
  const last = say(env, 'no channel-group');
  ok(last.some(function (l) { return /no other members/.test(l); }),
    'the last member says the group went with it', JSON.stringify(last));
  ok(!env.a.config.lags['1'], 'and the group is gone', JSON.stringify(env.a.config.lags));
}

console.log('');
console.log('A lab saved by an older build still loads:');
{
  // Older builds stored the console's word. Normalising on the way in means those labs are the same state as
  // one configured today, rather than failing validation with "unknown mode".
  const env = lab();
  env.a.config.lags = { 1: { mode: 'active', hashPolicy: 'l2', members: [env.pa[0].name, env.pa[1].name] } };
  const norm = lagLib.normalizeLag(env.a.config.lags[1]);
  ok(norm.mode === 'lacp-active', 'the old spelling normalises to the canonical one', norm.mode);
  ok(lagLib.validateLag(norm).ok !== false, 'and validates',
    JSON.stringify(lagLib.validateLag(norm).errors || []));
  say(env, 'end');
  ok(config(env).some(function (l) { return /channel-group 1 mode active/.test(l); }),
    'and prints back in the console\'s word',
    JSON.stringify(config(env).filter(function (l) { return /channel-group/.test(l); })));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
