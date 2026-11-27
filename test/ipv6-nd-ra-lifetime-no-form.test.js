'use strict';
// ipv6-nd-ra-lifetime-no-form.test.js -- `no ipv6 nd ra lifetime` is the way back to the default.
//
// Cisco's IPv6 command reference gives the set form and the no form as two spellings of one
// setting: `ipv6 nd ra lifetime seconds`, `no ipv6 nd ra lifetime`, "To restore the default
// lifetime, use the no form of this command", default 1800 seconds. This console read the leading
// `no` into a `negated` flag and never looked at it again on the lifetime branch, so the line
// answered with the *set* receipt and wrote the value a second time.
// research/ipv6-nd-ra-lifetime-no-form.md carries the citations.
const path = require('path');
const { Topology, runCommands, ra } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function last(out) { return out[out.length - 1]; }
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + ' (expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual) + ')');
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(vendor, model) {
  const s = catalog.find(function (x) { return x.vendor === vendor && x.model === model; });
  if (!s) throw new Error('missing spec ' + vendor + '/' + model);
  return s;
}

function cli(t, dev, cmds, exec) {
  const pre = exec ? ['enable'] : ['enable', 'configure terminal'];
  return runCommands(dev, t, null, pre.concat(cmds)).lines;
}

const t = new Topology();
const r1 = t.addDevice(spec('generic', 'generic-router'));
const sw1 = t.addDevice(spec('generic', 'generic-switch'));
r1.name = 'R1'; sw1.name = 'SW1';
const DEFAULTS = ra.DEFAULTS.routerLifetime;
eq(DEFAULTS, 1800, 'the default router lifetime is the vendor default, 1800 seconds');

// A router with a prefix to advertise, so the setting is one the box would really use.
cli(t, r1, ['interface Gi0/0', 'ipv6 address 2001:db8:aa::1/64', 'ipv6 nd prefix 2001:db8:aa::/64']);

console.log('\n`no ipv6 nd ra lifetime` restores the default:');
let out = cli(t, r1, ['ipv6 nd ra lifetime 900']);
ok(/router lifetime 900s/.test(out.join(' ')), 'the set form stores 900s');
eq(r1.config.ra.routerLifetime, 900, 'the device holds 900');

out = cli(t, r1, ['no ipv6 nd ra lifetime']);
const said = out.join(' ');
ok(/back to the default 1800s/.test(said), 'the receipt says it went back to the default, not that it was set again');
ok(/it was 900s/.test(said), 'and names the value it replaced');
eq(r1.config.ra.routerLifetime, 1800, 'the device holds 1800 again');
eq(ra.normalizeConfig(r1.config.ra).routerLifetime, 1800, 'what would go on the wire is 1800 too');

let run = cli(t, r1, ['show running-config'], true).join('\n');
ok(!/ipv6 nd ra lifetime/.test(run), 'the running-config stops printing the line (the default is not a line the config owns)');

out = cli(t, r1, ['show ipv6 nd'], true).join('\n');
ok(/router lifetime 1800s/.test(out), '`show ipv6 nd` reads 1800s');
ok(!/not a default router/.test(out), 'and no longer calls the router something other than a default router');

console.log('\nRemoving what is not there refuses and changes nothing:');
out = cli(t, r1, ['no ipv6 nd ra lifetime']);
ok(/^% No router lifetime set on R1/.test(last(out)), 'a second bare no is refused, not answered with a receipt');
ok(/it is the default, 1800s/.test(last(out)), 'the refusal names the default that is in force');
eq(r1.config.ra.routerLifetime, 1800, 'and the setting is untouched');

out = cli(t, r1, ['no ipv6 nd ra lifetime 1800']);
ok(/^% No router lifetime set on R1/.test(last(out)), 'a value naming the default is the same nothing-set refusal');
eq(r1.config.ra.routerLifetime, 1800, 'still 1800');

console.log('\nA no line names what it removes, even when the printed line is wider:');
cli(t, r1, ['ipv6 nd ra lifetime 1200']);
out = cli(t, r1, ['no ipv6 nd ra lifetime 900']);
ok(/^% No router lifetime 900s set on R1/.test(last(out)), 'a value that is not the one in force is refused');
ok(/it is 1200s/.test(last(out)), 'and the refusal names the value that really is set');
ok(/nothing was removed/.test(last(out)), 'and says so');
eq(r1.config.ra.routerLifetime, 1200, 'the 1200 survives the refused line');

out = cli(t, r1, ['no ipv6 nd ra lifetime 1200']);
ok(/back to the default 1800s/.test(out.join(' ')), 'the value that does name the setting removes it');
eq(r1.config.ra.routerLifetime, 1800, 'back to the default');

console.log('\nThe seconds field is validated whichever direction the line is written in:');
cli(t, r1, ['ipv6 nd ra lifetime 600']);
out = cli(t, r1, ['no ipv6 nd ra lifetime soon']);
ok(/^% Invalid router lifetime "soon"/.test(last(out)), 'a word in the seconds position is refused');
eq(r1.config.ra.routerLifetime, 600, 'nothing was removed by the refused line');

out = cli(t, r1, ['no ipv6 nd ra lifetime 70000']);
ok(/^% Router lifetime out of range: 70000/.test(last(out)), 'a value past the 16-bit field is refused');
eq(r1.config.ra.routerLifetime, 600, 'still nothing removed');

out = cli(t, r1, ['ipv6 nd ra lifetime 70000']);
ok(/^% Router lifetime out of range/.test(last(out)), 'the set form refuses the same number in the same words');

console.log('\n0 is a configured value, so the no form removes it:');
out = cli(t, r1, ['ipv6 nd ra lifetime 0']);
ok(/router lifetime 0s .*not a default router/.test(out.join(' ')), 'the set form accepts 0 and says what it means');
eq(r1.config.ra.routerLifetime, 0, 'the device holds 0');
run = cli(t, r1, ['show running-config'], true).join('\n');
ok(/ipv6 nd ra lifetime 0/.test(run), 'and the config owns the line, because 0 is not the default');

out = cli(t, r1, ['no ipv6 nd ra lifetime']);
ok(/back to the default 1800s/.test(out.join(' ')), 'the bare no restores 1800 from 0');
eq(r1.config.ra.routerLifetime, 1800, 'the device holds 1800');
run = cli(t, r1, ['show running-config'], true).join('\n');
ok(!/ipv6 nd ra lifetime/.test(run), 'and the line is gone from the running-config');

console.log('\nA bridge refuses the no form for the same reason it refuses the set form:');
out = cli(t, sw1, ['no ipv6 nd ra lifetime']);
ok(/^% SW1 cannot advertise: it has no l3-forward capability/.test(last(out)),
  'the refusal is the capability sentence, not a receipt for a setting it cannot hold');
eq(sw1.config.ra, null, 'and nothing is stored');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
