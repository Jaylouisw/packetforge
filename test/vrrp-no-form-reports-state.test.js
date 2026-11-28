'use strict';
// A `no vrrp <vrid> <setting>` that unsets nothing must not claim it reset the setting.
//
// The three default-restoring `no` forms in interface mode wrote their receipt before looking at the
// value they were about to overwrite:
//
//   r1(config-if)#no vrrp 42 priority                  <- priority was never set: it is already 100
//   VRRP group 42 priority reset to 100
//   r1(config-if)#no vrrp 42 preempt                   <- typed again, preemption is already off
//   VRRP group 42 preempt disabled
//   r1(config-if)#no vrrp 42 timers advertise          <- the interval is already the 1 s default
//   VRRP group 42 advertises every 1 s
//
// Each sentence names a change that did not happen. The first one is the worst of the three: a group that
// has just been given its address holds priority 100 and advertises every 1 s by default, so the very
// first keystroke of `no vrrp 42 priority` - the keystroke an operator types to find out whether a setting
// was inherited from a template - reports a reset that never happened. It is the defect the channel-group
// receipt had (test/channel-group-retype-is-not-a-join.test.js, #1675) and the one `no description`
// avoids by answering "had no description".
//
// Nothing else moves: a `no` that really does restore a non-default value keeps the sentence it always had
// ("reset to 100", "preempt disabled", "advertises every 1 s"), an attribute form never removes the group,
// and neither `show vrrp` nor `show running-config` changes because a no-op was typed.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  ok   ' + msg); }
  else { failed++; console.error('  FAIL ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.filter(function (s) { return s.model === 'generic-router'; })[0];
const PORT = 'Gi0/0';

function session(opts) {
  const t = new Topology();
  const dev = t.addDevice(ROUTER, 'r1');
  const cli = new CliSession(dev, t, new Simulator(t));
  const run = function (cmds) {
    const lines = [];
    for (const c of cmds) {
      const r = cli.run(c);
      for (const l of ((r && r.output) || [])) lines.push(String(l));
    }
    return lines.filter(function (l) {
      return l && !/^r1[>#(]/.test(l) && !/^Enter configuration commands/.test(l);
    });
  };
  const base = ['enable', 'configure terminal', 'interface ' + PORT, 'ip address 10.0.0.1 255.255.255.0',
    'vrrp 42 ip 10.0.0.254'];
  if (opts && opts.priority) base.push('vrrp 42 priority ' + opts.priority);
  if (opts && opts.advert) base.push('vrrp 42 timers advertise ' + opts.advert);
  if (opts && opts.noPreempt) base.push('no vrrp 42 preempt');
  run(base);
  return { t: t, dev: dev, cli: cli, run: run };
}

function group(dev) {
  return (Array.isArray(dev.config.vrrp) ? dev.config.vrrp : []).filter(function (g) { return g.vrid === 42; })[0] || null;
}
// Snapshot the config. `end` leaves interface mode, so a test that types more interface commands
// afterwards goes back through atIface() rather than guessing where the session is.
function config(env) {
  return env.run(['end', 'show running-config']).join('\n');
}
function atIface(env) {
  env.run(['end', 'configure terminal', 'interface ' + PORT]);
}
const NO_CHANGE = /nothing changed/;

console.log('\nA priority that was never set is already the default, and the `no` says so:');
{
  const env = session();
  const before = config(env);
  atIface(env);
  const out = env.run(['no vrrp 42 priority']);
  ok(out.length === 1, 'one sentence', JSON.stringify(out));
  ok(NO_CHANGE.test(out[0]), 'it does not claim a reset it did not make', out[0]);
  ok(/100/.test(out[0]), 'and it names the value in force', out[0]);
  ok(!/reset to/.test(out[0]), 'the word "reset" is not used for a value that did not move', out[0]);
  ok(group(env.dev) && group(env.dev).priority === 100, 'the priority is still 100',
    String(group(env.dev) && group(env.dev).priority));
  ok(group(env.dev) && group(env.dev).ips.length === 1 && group(env.dev).ips[0] === '10.0.0.254',
    'and the virtual address is untouched', JSON.stringify(group(env.dev) && group(env.dev).ips));
  ok(config(env) === before, 'the running-config is byte for byte what it was');
}

console.log('\nTyping it a second time says the same thing, and still changes nothing:');
{
  const env = session();
  env.run(['no vrrp 42 priority']);
  const first = config(env);
  atIface(env);
  const out = env.run(['no vrrp 42 priority']);
  ok(out.length === 1 && NO_CHANGE.test(out[0]), 'the same no-op sentence', JSON.stringify(out));
  ok(config(env) === first, 'and the config has not drifted');
  ok(group(env.dev) !== null, 'the group is still standing', JSON.stringify(group(env.dev)));
}

console.log('\nA `no` that does restore a non-default priority keeps the sentence it always had:');
{
  const env = session({ priority: 150 });
  const out = env.run(['no vrrp 42 priority']);
  ok(out[0] === 'VRRP group 42 priority reset to 100', 'still says the priority is back at 100', out[0]);
  ok(group(env.dev).priority === 100, 'and the value really moved', String(group(env.dev).priority));
}

console.log('\nPreemption: the first `no` turns it off, the second one has nothing to turn off:');
{
  const env = session();
  ok(group(env.dev).preempt === true, 'a new group preempts');
  const first = env.run(['no vrrp 42 preempt']);
  ok(first[0] === 'VRRP group 42 preempt disabled', 'the first one disables it', first[0]);
  ok(group(env.dev).preempt === false, 'and the flag is off', String(group(env.dev).preempt));
  const before = config(env);
  atIface(env);
  const second = env.run(['no vrrp 42 preempt']);
  ok(second.length === 1 && NO_CHANGE.test(second[0]), 'the second one reports no change', JSON.stringify(second));
  ok(!/preempt disabled$/.test(second[0]), 'and does not say it disabled what was already disabled', second[0]);
  ok(config(env) === before, 'the running-config did not move');
}

console.log('\nThe advertisement interval: the default needs no reset, a set value does:');
{
  const env = session();
  const before = config(env);
  atIface(env);
  const out = env.run(['no vrrp 42 timers advertise']);
  ok(out.length === 1 && NO_CHANGE.test(out[0]), 'a default interval is not "reset"', JSON.stringify(out));
  ok(group(env.dev).advertSec === 1, 'it is still 1 s', String(group(env.dev).advertSec));
  ok(config(env) === before, 'and the config is unchanged');

  const set = session({ advert: 4 });
  const back = set.run(['no vrrp 42 timers advertise']);
  ok(back[0] === 'VRRP group 42 advertises every 1 s', 'a real reset keeps its sentence', back[0]);
  ok(group(set.dev).advertSec === 1, 'and the interval really moved', String(group(set.dev).advertSec));
}

console.log('\nNo attribute form removes the group:');
{
  const env = session();
  env.run(['no vrrp 42 priority', 'no vrrp 42 preempt', 'no vrrp 42 timers advertise']);
  ok(group(env.dev) !== null, 'the group survived all three', JSON.stringify(env.dev.config.vrrp));
  const shown = env.run(['end', 'show vrrp']).join('\n');
  ok(/10\.0\.0\.254/.test(shown), 'and `show vrrp` still lists its virtual address',
    shown.split('\n').filter(function (l) { return /10\.0\.0\.254/.test(l); })[0] || '');
}

console.log('\n' + (failed ? 'FAILED ' : '') + passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
