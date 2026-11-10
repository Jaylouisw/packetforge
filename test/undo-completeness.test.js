'use strict';
// undo-completeness.test.js - every verb a page prints has a way back, and the way back restores
// what was there before it.
//
// Found by sweeping the help page: type each config row with its placeholders filled, then type the
// same words behind `no`, and compare the running-config to the baseline. Two rows failed, both in
// the same way - the removal half was missing or did the opposite of removing:
//
//   R1(config)#no hostname              % Unrecognized config command: no hostname LAB
//   R1(config)#ipv6 nd ra lifetime 10   IPv6 RA router lifetime 10s
//   R1(config)#no ipv6 nd ra lifetime 10  IPv6 RA router lifetime 10s   <- set it again, and said so
//   R1(config)#no ipv6 nd ra lifetime   % Incomplete command: ipv6 nd ra lifetime <seconds>
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

function lab(model, name, prep) {
  const t = new Topology();
  const d = t.addDevice(find(model)); d.name = name;
  const s = new CliSession(d, t, new Simulator(t));
  s.run('enable');
  s.run('configure terminal');
  (prep || []).forEach(function (l) { s.run(l); });
  s.run('end');
  return { t: t, d: d, s: s };
}
function dump(env) { return text(env.s.run('show running-config')); }
function cfg(env, line) { env.s.run('configure terminal'); const o = env.s.run(line); env.s.run('end'); return o; }

console.log('\n`no hostname` exists, and it restores the default name:');
{
  const env = lab('generic-router', 'R1');
  const def = env.d.label + '-' + String(env.d.id).slice(-4);
  ok(env.d.name === 'R1', 'the device starts with the label the lab gave it');
  const none = text(cfg(env, 'no hostname'));
  ok(/No hostname is configured/.test(none), 'with nothing configured it says so rather than refusing the verb');
  ok(new RegExp('called R1').test(none), 'and names what the device is actually called');
  ok(/its label, not a hostname it was given/.test(none), 'and why it is not a hostname to clear');
  cfg(env, 'hostname LAB');
  ok(env.d.name === 'LAB', 'hostname LAB renames the device');
  const out = text(cfg(env, 'no hostname'));
  ok(/Hostname cleared/.test(out), 'no hostname clears it');
  ok(new RegExp('called ' + def.replace(/[()]/g, '\\$&') + ' again').test(out),
    'and the name is the default for this model (' + def + ')');
  ok(env.d.name === def, 'device.name follows, so the canvas and the config agree');
  ok(new RegExp('hostname ' + def.replace(/[()]/g, '\\$&')).test(dump(env)),
    'the running-config names the default, not the cleared name');
  ok(!/hostname LAB/.test(dump(env)), 'and LAB is gone from it');
  const extra = text(cfg(env, 'no hostname FOO'));
  ok(/Unexpected argument "FOO"/.test(extra), 'an argument to no hostname is refused');
  ok(/Usage: no hostname/.test(extra), 'with the usage line');
}

console.log('\n`no ipv6 nd ra lifetime` resets instead of setting it again:');
{
  const env = lab('generic-router', 'R1', ['ipv6 unicast-routing']);
  const set = text(cfg(env, 'ipv6 nd ra lifetime 10'));
  ok(/lifetime 10s/.test(set), 'the positive form still sets 10s');
  ok(/ipv6 nd ra lifetime 10/.test(dump(env)), 'and the value is in the running-config');
  const clear = text(cfg(env, 'no ipv6 nd ra lifetime'));
  ok(/back to the default 1800s/.test(clear), 'the bare removal resets to the protocol default');
  ok(/was 10s/.test(clear), 'and says what it was');
  ok(!/ipv6 nd ra lifetime/.test(dump(env)), 'the line leaves the running-config, so a paste round-trips');
  cfg(env, 'ipv6 nd ra lifetime 20');
  const withArg = text(cfg(env, 'no ipv6 nd ra lifetime 20'));
  ok(/back to the default 1800s/.test(withArg), 'the form carrying the old value removes as well');
  ok(/was 20s/.test(withArg), 'and reports the value it removed');
  ok(!/ipv6 nd ra lifetime/.test(dump(env)), 'and leaves nothing behind');
  const again = text(cfg(env, 'no ipv6 nd ra lifetime'));
  ok(/was not set/.test(again), 'clearing a value that is not there says so, and is not an error');
  const junk = text(cfg(env, 'no ipv6 nd ra lifetime abc'));
  ok(/% (Unexpected argument|Invalid)/.test(junk), 'a word where a value goes is refused');
}

console.log('\nThe rule, checked across the config page: positive then no-form returns to the baseline:');
{
  // Each entry: a line, and how to type its removal. The removal must leave the running-config
  // exactly as it was before the positive line ran.
  const cases = [
    ['generic-router', ['ip domain-name lab.local']],
    ['generic-router', ['ip name-server 8.8.8.8']],
    ['generic-router', ['ip route 10.9.0.0 255.255.0.0 10.0.0.9']],
    ['generic-router', ['ipv6 route 2001:db8:9::/64 2001:db8:1::9']],
    ['generic-router', ['ipv6 nd ra lifetime 10']],
    ['generic-switch', ['vlan 77']],
    ['generic-switch', ['spanning-tree vlan 10 root primary']],
    ['generic-switch', ['spanning-tree vlan 10 priority 4096']]
    // Not in the battery, and why: `ip domain-lookup` and `ipv6 unicast-routing` are on by default
    // here, so the positive line changes no configuration (their removal is the interesting half);
    // `snmp-server location` is not a command this model has, so there is nothing to undo.
  ];
  for (const [model, lines] of cases) {
    const env = lab(model, 'X1', model === 'generic-router'
      ? ['interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit'] : []);
    const base = dump(env);
    let okAll = true, detail = '';
    for (const line of lines) {
      const pOut = text(cfg(env, line));
      if (/^%/.test(pOut.trim())) { okAll = false; detail = line + ' was refused: ' + pOut.slice(0, 80); break; }
      const after = dump(env);
      if (after === base) { okAll = false; detail = line + ' changed nothing in the running-config'; break; }
      const nOut = text(cfg(env, 'no ' + line));
      const back = dump(env);
      if (/^% (Unrecognized|Invalid)/.test(nOut.trim())) {
        okAll = false; detail = 'no ' + line + ' -> ' + nOut.split('\n')[0]; break;
      }
      if (back !== base) {
        const residue = back.split('\n').filter(function (l) { return l.trim() && base.split('\n').indexOf(l) === -1; });
        okAll = false; detail = 'no ' + line + ' left ' + JSON.stringify(residue.slice(0, 2)); break;
      }
    }
    ok(okAll, model + ': ' + lines.join('; ') + ' round-trips through its no-form' + (okAll ? '' : ' (' + detail + ')'));
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
