'use strict';
// poe-admin.test.js - a PSE that could refuse a port for budget, and an operator who could not.
//
// Measured before this pass, on a switch with a 67 W budget and two 7 W access points:
//   SW1(config-if)#power inline never
//   % Unrecognized interface command: power inline never
//   % Unrecognized config command: power inline never
//
// The PoE plane was fully computed - a budget, an allocation per port, a powered device marked
// `poeUnpowered`, its frames refused with `poe-deny` - and `show power inline` reported all of it.
// The one decision an operator actually makes about PoE, whether this port feeds the thing plugged
// into it, could not be made: power was only ever withheld by a budget running out.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + (actual === expected ? '' : ' (got ' + JSON.stringify(actual) + ')'));
}
function match(re, haystack, msg) {
  const text = Array.isArray(haystack) ? haystack.join('\n') : String(haystack);
  ok(re.test(text), msg + (re.test(text) ? '' : ' (no match in ' + JSON.stringify(text.slice(0, 600)) + ')'));
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const PSE = catalog.find(function (d) { return d.model === '2530-8-PoE+ (J9780A)'; }) ||
  catalog.find(function (d) { return d.poe && d.poe.budgetW; });
const PD = catalog.find(function (d) { return d.model === 'EP-R6'; }) ||
  catalog.find(function (d) { return (d.interfaces || []).some(function (i) { return i.poeIn; }); });
const PLAIN = catalog.find(function (d) { return d.model === 'generic-switch'; });

// The PSE with two powered devices, and a plain switch that cannot source power at all.
function lab() {
  const t = new Topology();
  const pse = t.addDevice(PSE); pse.name = 'SW1';
  const ap1 = t.addDevice(PD); ap1.name = 'AP1';
  const ap2 = t.addDevice(PD); ap2.name = 'AP2';
  const plain = t.addDevice(PLAIN); plain.name = 'SW2';
  const ports = Array.from(pse.interfaces.values())
    .filter(function (i) { return i.hardware && i.hardware.poeOut; })
    .map(function (i) { return i.name; });
  t.connect(ap1.id, 'eth0', pse.id, ports[0]);
  t.connect(ap2.id, 'eth0', pse.id, ports[1]);
  const sim = new Simulator(t);
  const mk = function (d) { const s = new CliSession(d, t, sim); s.run('enable'); return s; };
  const s1 = mk(pse), sg = mk(plain);
  const cfg = function (s, port, cmds) {
    s.run('configure terminal');
    s.run('interface ' + port);
    const out = [];
    for (const c of cmds) out.push.apply(out, s.run(c).output);
    s.run('end');
    return out;
  };
  s1.run('configure terminal'); s1.run('hostname SW1'); s1.run('end');
  sg.run('configure terminal'); sg.run('hostname SW2'); sg.run('end');
  return { t: t, sim: sim, pse: pse, ap1: ap1, ap2: ap2, plain: plain,
    s1: s1, sg: sg, ports: ports, cfg: cfg };
}

console.log('\nA port can be told not to feed what is plugged into it:');
{
  const env = lab();
  const p0 = env.ports[0];
  const before = env.s1.run('show power inline').output;
  match(/Port\s+Admin\s+Powered device\s+Requested\s+Status/, before, 'the table has an Admin column');
  match(new RegExp(p0 + '\\s+auto\\s+AP1\\s+7 W\\s+on'), before, 'and both ports are auto and on');
  match(/Used\s+: 14 W/, before, 'two 7 W devices are drawn from the budget');
  const out = env.cfg(env.s1, p0, ['power inline never']);
  match(/Power inline on 1 set to never \(was auto\)/, out, 'the command reports the change');
  match(/its watts are freed for other ports/, out, 'and what the change is for');
  match(/AP1 is on this port and will lose power on the next run/, out,
    'and names the device that is about to lose power');
  eq(env.pse.interfaces.get(p0).poeAdmin, 'never', 'the port records the decision');
  const after = env.s1.run('show power inline').output;
  match(new RegExp(p0 + '\\s+never\\s+AP1\\s+7 W\\s+off \\(administratively\\)'), after,
    'the table shows it off for a reason that is not the budget');
  match(/Used\s+: 7 W/, after, 'and the freed watts are available again');
  match(/Available\s+: 60 W/, after, 'which the budget line states');
  eq(env.ap1.poeUnpowered, true, 'the powered device is marked unpowered');
  eq(env.ap2.poeUnpowered, false, 'and its neighbour is untouched');
  // The decision is on the timeline as its own event, not as a budget shortage.
  const events = (env.sim.events || []).filter(function (e) { return /poe/.test(String(e.type)); });
  ok(events.some(function (e) { return e.type === 'poe-admin-off'; }),
    'the refusal is recorded as a decision, not as a budget exhaustion');
}

console.log('\nThe device is fed again by `no power inline`:');
{
  const env = lab();
  const p0 = env.ports[0];
  env.cfg(env.s1, p0, ['power inline never']);
  const back = env.cfg(env.s1, p0, ['no power inline']);
  match(/Power inline on 1 is auto: a detected device will be powered/, back,
    '`no power inline` returns the port to auto');
  match(/whether it gets the watts still depends on the port budget/, back,
    'and does not promise the watts, only the attempt');
  eq(env.pse.interfaces.get(p0).poeAdmin, 'auto', 'the port is auto again');
  const again = env.s1.run('show power inline').output;
  match(new RegExp(p0 + '\\s+auto\\s+AP1\\s+7 W\\s+on'), again, 'and the table shows the device on');
  match(/Used\s+: 14 W/, again, 'the budget is drawn again');
  eq(env.ap1.poeUnpowered, false, 'and the device is no longer marked unpowered');
  // Idempotence, both ways.
  match(/is already auto/, env.cfg(env.s1, p0, ['no power inline']),
    'removing it twice says it is already auto');
  env.cfg(env.s1, p0, ['power inline never']);
  match(/is already never/, env.cfg(env.s1, p0, ['power inline never']),
    'and withholding twice says it is already withheld');
}

console.log('\nThe words a port cannot be given are refused by naming why:');
{
  const env = lab();
  const p0 = env.ports[0];
  const staticOut = env.cfg(env.s1, p0, ['power inline static']);
  match(/% "power inline static" \(pre-allocated power\) is not modelled/, staticOut,
    '`static` is refused rather than accepted and ignored');
  match(/grants power when a device is detected and refuses it when the budget runs out/, staticOut,
    'the refusal describes what this PSE actually does');
  match(/Power inline is auto or never, not "bogus"/, env.cfg(env.s1, p0, ['power inline bogus']),
    'a word that is neither is refused by name');
  match(/% Incomplete command: power inline <auto\|never>/,
    env.cfg(env.s1, p0, ['power inline']), 'a bare command is incomplete, not silent');
  match(/% Unexpected argument "extra" - power inline <auto\|never> takes no more/,
    env.cfg(env.s1, p0, ['power inline never extra']), 'a trailing word is refused');
  match(/% no power inline takes no word/, env.cfg(env.s1, p0, ['no power inline never']),
    'and `no power inline` takes nothing at all');
  // A device with no PoE, and a port that cannot source it, are two different refusals.
  match(/% SW2 does not source PoE, so Fa0\/1 has no power to give/,
    env.cfg(env.sg, 'Fa0/1', ['power inline never']), 'a non-PSE names itself and the port');
  const sfp = env.ports[env.ports.length - 1];
  const sfpOut = env.cfg(env.s1, sfp, ['power inline never']);
  const refused = /is not a PoE-out port/.test(sfpOut.join('\n'));
  if (refused) {
    match(/The ports that can source power are:/, sfpOut, 'a port that cannot source lists the ones that can');
  } else {
    // Some PSEs model every port as capable; then the port is configured, which is not a failure.
    ok(/set to never/.test(sfpOut.join('\n')), 'a PoE-capable port accepts the command');
    env.cfg(env.s1, sfp, ['no power inline']);
  }
}

console.log('\nThe decision survives a dump and a paste:');
{
  const env = lab();
  const p1 = env.ports[1];
  env.cfg(env.s1, p1, ['power inline never']);
  const dump = env.s1.run('show running-config').output;
  match(/power inline never/, dump, 'the dump carries the line');
  const block = dump.join('\n').split('interface ' + p1)[1] || '';
  match(/power inline never/, block, 'and carries it inside the block for that port');
  // A port nobody configured contributes no line.
  const other = dump.join('\n').split('interface ' + env.ports[2])[1] || '';
  const otherBlock = other.split(/^interface /m)[0];
  ok(!/power inline/.test(otherBlock), 'a port left at auto contributes no power line');
  // Paste it into a twin and check the decision lands.
  const t2 = new Topology();
  const twin = t2.addDevice(PSE); twin.name = 'SW1';
  const s2 = new CliSession(twin, t2, new Simulator(t2));
  s2.run('enable'); s2.run('configure terminal');
  for (const line of dump.slice(1)) {
    // Ordinary control flow: the banner and the terminator are not commands to paste.
    if (/^!/.test(line) || /^end$/.test(line)) continue;
    s2.run(line);
  }
  s2.run('end');
  eq(twin.interfaces.get(p1).poeAdmin, 'never', 'the withheld port is withheld after a paste');
  eq(twin.interfaces.get(env.ports[2]).poeAdmin, undefined, 'and the untouched port is still untouched');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
