'use strict';
// persistence-load.test.js - a saved copy you can never return to is a copy nobody needed.
//
// `write memory` and `copy running-config startup-config` existed, `show startup-config` existed, and
// nothing ever loaded the saved copy back:
//
//   R1#copy startup-config running-config   % copy takes running-config startup-config - the source
//                                             must be running-config
//   R1#reload                               % Unrecognized command: reload
//
// So the save was write-only. This is IOS's merge (`copy startup-config running-config`), which
// replays the saved copy through the same parser a paste uses, and reload answers with what the model
// actually is instead of a typo message.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function text(out) { return out && out.output ? out.output.join('\n') : String(out); }
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const find = function (m) { return catalog.filter(function (x) { return x.model === m; })[0]; };

function lab(model, name) {
  const t = new Topology();
  const d = t.addDevice(find(model)); d.name = name;
  const s = new CliSession(d, t, new Simulator(t));
  s.run('enable');
  return { t: t, d: d, s: s };
}
function cfg(env, lines) {
  env.s.run('configure terminal');
  (lines || []).forEach(function (l) { env.s.run(l); });
  env.s.run('end');
}

console.log('\nThe saved copy can be loaded back, and the answer says what changed:');
{
  const env = lab('generic-router', 'R1');
  cfg(env, ['interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
    'ip route 10.9.0.0 255.255.0.0 10.0.0.9']);
  ok(/Saved startup-config/.test(text(env.s.run('write memory'))), 'the configuration is saved');
  cfg(env, ['no ip route 10.9.0.0 255.255.0.0 10.0.0.9', 'ip route 10.8.0.0 255.255.0.0 10.0.0.8']);
  ok(!/10\.9\.0\.0/.test(text(env.s.run('show ip route'))), 'the saved route was removed after the save');
  const out = text(env.s.run('copy startup-config running-config'));
  ok(/6 lines applied/.test(out), 'the copy reports how many saved lines were replayed');
  ok(/1 line added/.test(out), 'and what it changed');
  ok(/this is a merge/.test(out), 'and that it is a merge, not a replace');
  const routes = text(env.s.run('show ip route'));
  ok(/10\.9\.0\.0/.test(routes), 'the saved route is back');
  ok(/10\.8\.0\.0/.test(routes), 'and the newer route the saved copy never mentioned is kept');
  const again = text(env.s.run('copy startup-config running-config'));
  ok(/did not change/.test(again), 'running it again changes nothing, and says so');
  ok(/6 lines applied/.test(again), 'while still reporting what it replayed');
}

console.log('\nNothing saved, nothing to load:');
{
  const env = lab('generic-switch', 'SW1');
  const out = text(env.s.run('copy startup-config running-config'));
  ok(/No startup-config on SW1/.test(out), 'the copy is refused, naming the device');
  ok(/"write memory" saves the running configuration first/.test(out), 'and naming the way to make one');
}

console.log('\nThe load follows the same mode rules as anything else:');
{
  const env = lab('generic-router', 'R1');
  // In configuration mode it is not "unrecognized": it is an exec command, and the refusal says so.
  const inConfig = text((function () {
    const s = env.s; s.run('configure terminal');
    const o = s.run('copy startup-config running-config'); s.run('end');
    return o;
  })());
  ok(/is an exec command, not a configuration command/.test(inConfig),
    'typed in configuration mode it is named as an exec command, not a typo');
  ok(/puts you back at privileged exec/.test(inConfig), 'and the refusal says how to get there');
  cfg(env, ['interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit']);
  env.s.run('write memory');
  const o = text(env.s.run('copy startup-config running-config'));
  ok(!/Unrecognized/.test(o), 'and it is a valid exec command');
  // The prompt must be back at privileged exec afterwards, whatever mode the walk ended in.
  ok(/#/.test(env.s.prompt()) && !/\(config/.test(env.s.prompt()),
    'the prompt is back at privileged exec after the walk (' + env.s.prompt() + ')');
}

console.log('\n`reload` is answered honestly, not as a typo:');
{
  const env = lab('generic-router', 'R1');
  const bare = text(env.s.run('reload'));
  ok(!/Unrecognized/.test(bare), 'reload is not "unrecognized"');
  ok(/nothing here boots/.test(bare), 'it says why there is no reload');
  ok(/"write memory" keeps a copy to return to/.test(bare), 'and what to do when nothing is saved');
  cfg(env, ['hostname R1']);
  env.s.run('write memory');
  const saved = text(env.s.run('reload'));
  ok(/copy startup-config running-config/.test(saved), 'with a saved copy it names the command that loads it');
  ok(/show startup-config/.test(saved), 'and the one that shows what is saved');
  ok(/nothing here boots/.test(saved), 'and still says what it cannot do');
  // Every command the refusal points at is a command the device has.
  for (const line of ['copy startup-config running-config', 'show startup-config', 'write memory']) {
    const o = text(env.s.run(line));
    ok(!/Unrecognized|Invalid/.test(o), 'the pointer "' + line + '" is a real command');
  }
}

console.log('\nThe page lists both directions:');
{
  const env = lab('generic-router', 'R1');
  const page = text(env.s.run('?'));
  ok(/copy startup-config running-config/.test(page), 'the load is on the exec page');
  ok(/write memory/.test(page), 'and the save');
  ok(/reload/.test(page), 'and reload, so its answer can be found before typing it');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
