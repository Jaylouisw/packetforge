'use strict';
// startup-config.test.js — the saved copy, and the question it exists to answer.
//
// `write memory` is the first thing an operator types after configuring a box, and this console had no
// such command: no saved copy, no `show startup-config`, nothing that answers "what was on this box
// before I started changing it". What is added here is not a boot loader - there is no `reload` in
// this lab - but the two facts that make a saved copy worth having: what was saved, and what the
// running configuration has done to it since.
//
// The suite is written around the two ways such a feature goes wrong: a diff that is a plausible
// number rather than a true one, and a dump that cannot be pasted back.
const path = require('path');
const { Topology, Simulator, runCommands, CliSession } = require('../engine');
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

// One session per device, kept alive, so mode carries over like a real console.
function consoleFor(dev, t, sim) {
  const s = new CliSession(dev, t, sim);
  return {
    run: function () {
      const out = [];
      for (const cmd of Array.prototype.slice.call(arguments)) {
        out.push.apply(out, s.run(cmd).output);
      }
      return out;
    },
    text: function () {
      return this.run.apply(this, arguments).join('\n');
    }
  };
}
const strip = (lines) => lines.filter((l) => !/^[^\s#>]+[#>]\s?/.test(l));

function lab() {
  const t = new Topology();
  const r1 = t.addDevice(model('generic-router'));
  const r2 = t.addDevice(model('generic-router'));
  r1.name = 'R1'; r2.name = 'R2';
  const sim = new Simulator(t);
  const c1 = consoleFor(r1, t, sim);
  const c2 = consoleFor(r2, t, sim);
  c1.run('enable');
  c2.run('enable');
  return { t, sim, r1, r2, c1, c2 };
}

console.log('Before anything is saved, the command says so instead of showing an empty config:');
{
  const env = lab();
  const out = env.c1.text('show startup-config');
  ok(/% No startup-config on R1/.test(out), 'the refusal names the device');
  ok(/nothing has been written in this lab/.test(out), 'and says why it is empty');
  ok(/write memory/.test(out), 'and names the command that would create one');
  ok(!/PacketForge startup-config/.test(out), 'nothing is printed as if it were a configuration');
  // Privilege: saving is a privileged action, as on a real device. A session that never enabled is how
  // user mode is reached - there is no `disable` command in this console.
  const userOnly = consoleFor(env.r1, env.t, env.sim);
  const refused = userOnly.text('write memory');
  ok(/needs enable mode/.test(refused), 'a user-mode session is told write memory needs enable');
  eq(env.r1.savedConfig, undefined, 'and nothing was saved by the refusal');
}

console.log('\nA first save stores exactly what `show running-config` prints, minus its label:');
{
  const env = lab();
  // No `exit` after `vlan`: this console's `vlan <id> <name>` is a one-liner, and `exit` from config
  // mode returns to enable - so a stray exit would end the sequence rather than the block.
  env.c1.run('configure terminal', 'hostname R1', 'vlan 99 users',
    'interface Gi0/0', 'ip address 10.0.1.1 255.255.255.0', 'exit', 'exit');
  const running = strip(env.c1.run('show running-config'));
  const saved = env.c1.run('write memory');
  ok(/Saved startup-config on R1: \d+ lines/.test(saved.join('\n')),
    'the save reports the device and the line count: "' + saved[0] + '"');
  ok(/first save/.test(saved.join('\n')), 'and says it was the first, rather than inventing a delta of zero');
  const shown = strip(env.c1.run('show startup-config'));
  eq(shown[0], '! PacketForge startup-config (saved copy)', 'the dump is labelled as the saved copy');
  // The body must be byte-identical to the running config's body. A saved copy that differs from what
  // was printed is a copy nobody can compare anything to.
  eq(shown.slice(1).join('\n'), running.slice(1).join('\n'), 'and its body is the running config exactly');
  eq(saved[0].match(/(\d+) lines/)[1], String(running.length - 1), 'the count matches the body');
}

console.log('\nAfter a change, the dump prints the delta as comments, and the counts are true:');
{
  const env = lab();
  env.c1.run('configure terminal', 'hostname R1', 'vlan 99 users',
    'interface Gi0/0', 'ip address 10.0.1.1 255.255.255.0', 'exit',
    'interface Gi0/1', 'description uplink', 'exit', 'exit');
  env.c1.run('write memory');
  const before = strip(env.c1.run('show startup-config')).slice(1);
  // Add two lines and remove one.
  env.c1.run('configure terminal', 'interface Gi0/1', 'no description', 'exit',
    'interface Gi0/2', 'ip address 192.168.9.1 255.255.255.0', 'exit', 'vlan 100 extra', 'exit');
  // (the trailing exit leaves config mode; the diff is read from a fresh command)
  const after = strip(env.c1.run('show startup-config'));
  const added = after.filter((l) => /^! \+ /.test(l)).map((l) => l.slice('! + '.length));
  const removed = after.filter((l) => /^! - /.test(l)).map((l) => l.slice('! - '.length));
  eq(added.length, 2, 'two lines are reported as added');
  eq(removed.length, 1, 'one as removed');
  // Independent check, computed here rather than trusted from the engine: multiset difference between
  // the two printed configurations.
  const count = (arr) => arr.reduce((m, l) => m.set(l, (m.get(l) || 0) + 1), new Map());
  const runningNow = strip(env.c1.run('show running-config')).slice(1);
  const b = count(before), a = count(runningNow);
  let wantAdded = 0, wantRemoved = 0;
  for (const [line, n] of a) wantAdded += Math.max(0, n - (b.get(line) || 0));
  for (const [line, n] of b) wantRemoved += Math.max(0, n - (a.get(line) || 0));
  eq(added.length, wantAdded, 'the added count equals the true line difference');
  eq(removed.length, wantRemoved, 'and so does the removed count');
  ok(added.every((l) => runningNow.indexOf(l) !== -1), 'every added line really is in the running config');
  ok(removed.every((l) => before.indexOf(l) !== -1), 'every removed line really is in the saved copy');
  ok(added.every((l) => before.indexOf(l) === -1), 'and no added line was already in the saved copy');
  ok(/running-config differs from this copy: 2 lines added, 1 line removed/.test(after.join('\n')),
    'the summary states both counts: ' + (after.filter((l) => /differs/.test(l))[0] || ''));
  // Saving again closes the gap, and then reports no change - the "no changes" state must be reachable,
  // or an operator can never tell whether the last save worked.
  const second = env.c1.run('write memory').join('\n');
  ok(/2 lines added, 1 line removed/.test(second), 'the save reports what it replaced: ' + second);
  const third = env.c1.run('write memory').join('\n');
  ok(/no changes since the previous save/.test(third), 'and a repeat save says there was nothing to do');
  ok(!/differs from this copy/.test(strip(env.c1.run('show startup-config')).join('\n')),
    'the difference is gone once it is saved');
}

console.log('\nRemoving a line the saved copy has is reported, not silently accepted:');
{
  const env = lab();
  env.c1.run('configure terminal', 'vlan 42 lab', 'exit');
  env.c1.run('write memory');
  env.c1.run('configure terminal', 'no vlan 42', 'exit');
  const out = strip(env.c1.run('show startup-config')).join('\n');
  ok(/1 line removed/.test(out), 'one line removed');
  ok(/! - vlan 42 lab/.test(out), 'and the line itself is printed as a comment: ' +
    (out.split('\n').filter((l) => /^! - /.test(l))[0] || ''));
  // The old line is still in the saved copy: that is the point of a saved copy.
  ok(/^vlan 42 lab$/m.test(out), 'the saved copy still contains the line that was removed');
}

console.log('\nDuplicate lines are counted correctly (a set difference would get this wrong):');
{
  const env = lab();
  env.c1.run('configure terminal', 'interface Gi0/0', 'description identical', 'exit',
    'interface Gi0/1', 'description identical', 'exit', 'exit');
  env.c1.run('write memory');
  env.c1.run('configure terminal', 'interface Gi0/1', 'no description', 'exit', 'exit');
  const out = strip(env.c1.run('show startup-config')).join('\n');
  ok(/1 line removed/.test(out), 'removing one of two identical lines reports one, not none and not two');
  // The survivor is still there, so the saved copy still holds one copy of the line.
  eq((out.match(/^  description identical$/gm) || []).length, 2,
    'and the saved copy still shows both of its identical lines');
}

console.log('\nThe dump can be pasted back onto a bare device and rebuilds the same configuration:');
{
  const env = lab();
  env.c1.run('configure terminal', 'vlan 10 users', 'vlan 20 voice',
    'interface Gi0/0', 'description to-core', 'ip address 10.0.1.1 255.255.255.0', 'exit',
    'interface Gi0/1', 'ip address 10.0.2.1 255.255.255.0', 'exit',
    'ip route 0.0.0.0 0.0.0.0 10.0.1.254',
    'ospf router-id 1.1.1.1', 'ospf area 0',
    'dns zone example.test', 'dns add host.example.test A 10.0.1.5',
    'ip dhcp pool lan', 'network 10.0.1.0 255.255.255.0', 'default-router 10.0.1.1',
    'range 10.0.1.10 10.0.1.200', 'exit', 'exit');
  const running = strip(env.c1.run('show running-config'));
  const dump = strip(env.c1.run('write memory') && env.c1.run('show startup-config'));
  // A fresh device of the same model, pasted into an empty config. The comments in the dump are the
  // reason this is a fair test: if the delta block were prose instead, the paste would break.
  const t2 = new Topology();
  const clone = t2.addDevice(model('generic-router'));
  clone.name = 'R1';
  const sim2 = new Simulator(t2);
  const c = consoleFor(clone, t2, sim2);
  c.run('enable', 'configure terminal');
  const refusals = [];
  for (const line of dump) {
    for (const out of c.run(line)) if (/^%/.test(out)) refusals.push(line + ' -> ' + out);
  }
  eq(refusals.join(' | '), '', 'no line of the dump was refused');
  c.run('exit');
  const rebuilt = strip(c.run('show running-config'));
  eq(rebuilt.join('\n'), running.join('\n'), 'the rebuilt running-config is identical to the original');
}

console.log('\nA pool that cannot be validated does not become configuration:');
{
  // Found by the paste test above: a pool created with `network` but no `range` used to be reported
  // as an error on `exit` and kept anyway. It then appeared in `show running-config` as a block that
  // failed its own validation when pasted back - a dump that cannot rebuild the device it came from.
  const env = lab();
  const made = env.c1.run('configure terminal', 'ip dhcp pool broken',
    'network 10.9.9.0 255.255.255.0', 'default-router 10.9.9.1', 'exit', 'exit').join('\n');
  ok(/E_DHCP_BAD_RANGE/.test(made), 'the error is still reported');
  ok(/Pool broken discarded/.test(made), 'and the invalid pool is discarded rather than kept');
  ok(!/ip dhcp pool broken/.test(strip(env.c1.run('show running-config')).join('\n')),
    'so it is not in the running configuration');
  ok(/% No DHCP pools/.test(strip(env.c1.run('show ip dhcp pool')).join('\n')) ||
    !/broken/.test(strip(env.c1.run('show ip dhcp pool')).join('\n')),
    'and no command lists it as if it existed');
  // Editing a valid pool into an invalid one restores the previous settings instead of destroying it.
  env.c1.run('configure terminal', 'ip dhcp pool good', 'network 10.0.5.0 255.255.255.0',
    'range 10.0.5.10 10.0.5.50', 'exit', 'exit');
  const edited = env.c1.run('configure terminal', 'ip dhcp pool good',
    'range 10.0.5.60 10.0.5.10', 'exit', 'exit').join('\n');
  ok(/E_DHCP_RANGE_ORDER|E_DHCP_BAD_RANGE/.test(edited), 'a backwards range is refused');
  ok(/Pool good restored to its previous configuration/.test(edited),
    'and the pool keeps the settings it had: ' + (edited.split('\n').filter((l) => /restored/.test(l))[0] || ''));
  const shown = strip(env.c1.run('show ip dhcp pool')).join('\n');
  ok(/10\.0\.5\.10/.test(shown) && /10\.0\.5\.50/.test(shown), 'the original range is still in force');
  ok(!/10\.0\.5\.60/.test(shown), 'and the rejected range is not');
}

console.log('\nBoth spellings do the same thing, and the wrong ones say what is wrong:');
{
  const env = lab();
  env.c1.run('configure terminal', 'vlan 7 seven', 'exit', 'exit');
  const viaCopy = env.c1.run('copy running-config startup-config');
  ok(/Saved startup-config on R1/.test(viaCopy.join('\n')), 'copy running-config startup-config saves');
  ok(/no changes/.test(env.c1.run('write memory').join('\n')),
    'and write memory immediately after has nothing to do, so the two are the same act');
  ok(/write takes memory/.test(env.c1.text('write terminal')),
    'write terminal is refused with the targets that exist');
  ok(/copy takes running-config startup-config/.test(env.c1.text('copy startup-config running-config')),
    'copying the saved copy back over the running config is refused by name');
  const userOnly = consoleFor(env.r1, env.t, env.sim);
  ok(/needs enable mode/.test(userOnly.text('copy running-config startup-config')),
    'and the copy spelling is privileged too');
}

console.log('\nThe saved copy belongs to the device, not to the console session:');
{
  const env = lab();
  env.c1.run('configure terminal', 'vlan 5 five', 'exit', 'exit');
  env.c1.run('write memory');
  // A brand-new session on the same device still finds it.
  const fresh = consoleFor(env.r1, env.t, env.sim);
  ok(/PacketForge startup-config/.test(fresh.text('show startup-config')), 'a new session sees the saved copy');
  // The other router was never saved.
  ok(/% No startup-config on R2/.test(env.c2.text('show startup-config')),
    'and saving R1 did not save R2');
  // It survives a whole run, which is what a saved copy is for.
  runCommands(env.r1, env.t, env.sim, ['show startup-config']);
  ok(/PacketForge startup-config/.test(env.c1.text('show startup-config')), 'and it survives a fresh run');
  // Deleting the configuration does not delete the copy - that is the entire value of it.
  env.c1.run('configure terminal', 'no vlan 5', 'hostname CHANGED', 'exit', 'exit');
  const out = env.c1.text('show startup-config');
  ok(/^vlan 5 five$/m.test(out), 'the copy still holds a line the running config no longer has');
  ok(!/^hostname CHANGED$/m.test(out), 'and does not contain a line that was never saved');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
