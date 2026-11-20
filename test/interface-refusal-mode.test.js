'use strict';
// A refused `interface <name>` line leaves the session where it was.
//
// A box refuses a name it cannot open at the parser - the caret sits under the bad token and the line
// never runs - so the session mode is untouched and the cursor stays on the interface that was already
// open. This console stepped down to `(config)#` first and then asked the config-mode door, so a
// mistyped name typed at `(config-if)#` answered
//
//   r1(config-if)#interface Gi9/9
//   % Interface not found: Gi9/9
//   r1(config)#                      <- a prompt the operator never asked to be at
//
// and the next line - a `description`, a `no ip address` - landed nowhere instead of on the port under
// the cursor. The rule is held by `_ifaceMode()`: the mode is adopted only when a port was really
// opened. research/interface-refusal-mode.md has the captures and the half that is inference.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const ROOT = path.join(__dirname, '..');
const catalog = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.find(function (s) { return s.vendor === 'generic' && s.model === 'generic-router'; });
const SWITCH = catalog.find(function (s) { return s.model === 'generic-switch'; });

// One session per lab. `desc()` reads the description a port carries; a port that was never given one
// answers the empty string the interface object starts with, so "untouched" is the falsy check.
function lab(spec, id) {
  const t = new Topology();
  const dev = t.addDevice(spec, id);
  const sim = new Simulator(t);
  const cli = new CliSession(dev, t, sim);
  const env = {
    dev: dev,
    cli: cli,
    run: function (cmd) { return (cli.run(cmd).output || []).map(String); },
    prompt: function () { return cli.prompt(); },
    desc: function (name) { const i = dev.interfaces.get(name); return i ? i.description : null; }
  };
  env.run('enable');
  env.run('configure terminal');
  env.run('hostname ' + id);
  return env;
}

console.log('A name the box cannot open is refused, and the cursor does not move:');
{
  const env = lab(SWITCH, 's1');
  env.run('interface Fa0/1');
  ok(env.prompt() === 's1(config-if)#', 'the lab starts on a physical port', env.prompt());
  const out = env.run('interface Fa9/9');
  ok(out.length === 1 && out[0] === '% Interface not found: Fa9/9',
    'the line is refused by the name that was typed', JSON.stringify(out));
  ok(env.prompt() === 's1(config-if)#',
    'and the prompt is the port it was on, not `(config)#` one level up', env.prompt());
  ok(env.cli.iface === 'Fa0/1', 'the session still names the port it was on', String(env.cli.iface));
  const next = env.run('description after-the-refusal');
  ok(next.length === 1 && next[0] === 'Description set: after-the-refusal',
    'the next line is a normal interface command, not an unknown one', JSON.stringify(next));
  ok(env.desc('Fa0/1') === 'after-the-refusal',
    'and it lands on the port under the cursor', JSON.stringify(env.desc('Fa0/1')));
  ok(!env.desc('Fa0/2'), 'nothing was written to the next port', JSON.stringify(env.desc('Fa0/2')));
}

console.log('');
console.log('The same refusal one level down, on a dot1q subinterface:');
{
  const env = lab(ROUTER, 'r1');
  env.run('interface Gi0/0');
  const created = env.run('interface Gi0/0.10');
  ok(env.prompt() === 'r1(config-subif)#', 'the subinterface opens its own mode', env.prompt());
  ok(created.length === 1 && /^Created subinterface Gi0\/0\.10/.test(created[0]),
    'and says it was created', JSON.stringify(created));
  // A subinterface *number* is not a VLAN id: `.5000` opens (research/subinterface-number.md). `.0` is
  // the name outside the subinterface range 1-4294967293, so the refusal this scenario needs is that one.
  const bad = env.run('interface Gi0/0.0');
  ok(bad.length === 1 && bad[0] === '% Subinterface number out of range: 0',
    'a subinterface number outside 1-4294967293 is refused', JSON.stringify(bad));
  ok(env.prompt() === 'r1(config-subif)#', 'and the subinterface mode survives the refusal', env.prompt());
  env.run('description stays-on-subif');
  ok(env.desc('Gi0/0.10') === 'stays-on-subif',
    'so the next line configures the subinterface', JSON.stringify(env.desc('Gi0/0.10')));
  ok(!env.desc('Gi0/0'), 'not its parent', JSON.stringify(env.desc('Gi0/0')));
}

console.log('');
console.log('An incomplete line is a refusal too, so it changes nothing either:');
{
  const env = lab(ROUTER, 'r1');
  env.run('interface Gi0/0');
  const out = env.run('interface');
  ok(out.length === 1 && out[0] === '% Incomplete command', 'a bare `interface` is refused', JSON.stringify(out));
  ok(env.prompt() === 'r1(config-if)#', 'and the mode is the one that was already open', env.prompt());
  ok(env.cli.iface === 'Gi0/0', 'on the same port', String(env.cli.iface));
}

console.log('');
console.log('Refused at `(config)#`, the session is already where a refusal leaves it:');
{
  const env = lab(ROUTER, 'r1');
  const out = env.run('interface Gi9/9');
  ok(out.length === 1 && out[0] === '% Interface not found: Gi9/9', 'the name is refused', JSON.stringify(out));
  ok(env.prompt() === 'r1(config)#', 'and the prompt is still `(config)#`', env.prompt());
  env.run('interface Gi0/1');
  ok(env.prompt() === 'r1(config-if)#', 'a name the box can open still opens it', env.prompt());
}

console.log('');
console.log('A name it can open still moves the session:');
{
  const env = lab(SWITCH, 's1');
  env.run('interface Fa0/1');
  env.run('interface Fa0/2');
  ok(env.prompt() === 's1(config-if)#', 'the prompt stays in interface mode', env.prompt());
  ok(env.cli.iface === 'Fa0/2', 'over a different port', String(env.cli.iface));
  env.run('description on-fa02');
  ok(env.desc('Fa0/2') === 'on-fa02', 'and the next line lands there', JSON.stringify(env.desc('Fa0/2')));
  ok(!env.desc('Fa0/1'), 'leaving the first port untouched', JSON.stringify(env.desc('Fa0/1')));

  const short = env.run('int Fa0/3');
  ok(short.length === 0 && env.cli.iface === 'Fa0/3',
    'the abbreviated head moves it too', JSON.stringify({ out: short, iface: env.cli.iface }));
}

console.log('');
console.log('A subinterface opened from inside another port still reaches its own prompt:');
{
  const env = lab(ROUTER, 'r1');
  env.run('interface Gi0/0');
  env.run('interface Gi0/1');
  ok(env.prompt() === 'r1(config-if)#', 'a second physical port is entered from inside the first', env.prompt());
  env.run('interface Gi0/1.20');
  ok(env.prompt() === 'r1(config-subif)#', 'and a dotted name under it opens the subif prompt', env.prompt());
  ok(env.cli.iface === 'Gi0/1.20', 'on the object that was created', String(env.cli.iface));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
