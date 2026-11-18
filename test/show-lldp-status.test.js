'use strict';
// `show lldp` answered with the neighbour table, so the protocol's own status view could not be asked for at all.
//
// On IOS the two commands are different questions one word apart: `show lldp` prints the global information block
// (`Status: ACTIVE`, advertisement interval, advertised hold time, reinitialisation delay) and `show lldp neighbors`
// prints the table. Handing the table to both meant a technician could not tell "LLDP is running and has heard
// nothing" from "LLDP is off" - and the console's own docs documented the wrong shape.
//
// The four lines below are a vendor transcript, not a composition: a Catalyst 9500 prints them byte for byte, at
// four spaces of indent, in Cisco's field notice on unknown-protocol drops (the same page shows the off-case as the
// single line `% LLDP is not enabled`):
//   https://www.cisco.com/c/en/us/support/docs/switches/catalyst-9300-series-switches/224586-troubleshoot-unknown-protocol-drops-in.html
// research/lldp-default-state.md records what the evidence does and does not settle about the default state.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const lldpLib = require('../engine/lldp');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];
const PC = catalog.filter(function (s) { return s.model === 'generic-pc'; })[0];
const eth = function (d) {
  return [...d.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
};

function show(dev, t, sim, cmd) {
  return ((new CliSession(dev, t, sim).run(cmd).output) || []).map(String);
}

// One cable, so `show lldp neighbors` has something to print and the two views are demonstrably different answers.
function lab() {
  const t = new Topology();
  const sw = t.addDevice(SWITCH, 'sw');
  const pc = t.addDevice(PC, 'pc');
  t.connect('pc', 'eth0', 'sw', 'Fa0/1');
  const sim = new Simulator(t);
  sim.refreshNeighbours();
  return { t: t, sim: sim, sw: sw };
}

console.log('');
console.log('`show lldp` is the global information block, in the vendor\'s own words');
{
  const env = lab();
  const out = show(env.sw, env.t, env.sim, 'show lldp');
  const want = [
    'Global LLDP Information:',
    '    Status: ACTIVE',
    '    LLDP advertisements are sent every 30 seconds',
    '    LLDP hold time advertised is 120 seconds',
    '    LLDP interface reinitialisation delay is 2 seconds'
  ];
  ok(out.length === want.length, 'five lines, no table under them', JSON.stringify(out));
  want.forEach(function (line, i) {
    ok(out[i] === line, 'line ' + (i + 1) + ' is exactly ' + JSON.stringify(line), JSON.stringify(out[i]));
  });
  ok(!/Total entries displayed/.test(out.join('\n')), 'and no neighbour count: that line belongs to the table');
}

console.log('');
console.log('The two views are two answers');
{
  const env = lab();
  const status = show(env.sw, env.t, env.sim, 'show lldp').join('\n');
  const table = show(env.sw, env.t, env.sim, 'show lldp neighbors').join('\n');
  ok(status !== table, '`show lldp` and `show lldp neighbors` are not the same output');
  ok(/Neighbour/.test(table) && !/Neighbour/.test(status), 'the table is under the word `neighbors` only');
  ok(/Global LLDP Information/.test(status) && !/Global LLDP Information/.test(table),
    'the status block is under the bare command only');
  ok(/Total entries displayed: 1/.test(table), 'and the table still ends with its count', table.split('\n').slice(-1)[0]);
}

console.log('');
console.log('Enabled with nothing heard is not the same as off');
{
  // No cable and no simulation traffic: nothing has been heard, and the status view still says the protocol is up.
  const t = new Topology();
  const sw = t.addDevice(SWITCH, 'sw');
  const sim = new Simulator(t);
  const out = show(sw, t, sim, 'show lldp');
  ok(out[0] === 'Global LLDP Information:' && out[1] === '    Status: ACTIVE',
    'a box with no neighbours still reports LLDP as ACTIVE', JSON.stringify(out.slice(0, 2)));
  const table = show(sw, t, sim, 'show lldp neighbors').join('\n');
  ok(/\(none - no LLDP has been heard on any port\)/.test(table),
    'and the table says why it is empty, which is a different sentence', table);
}

console.log('');
console.log('The numbers are the protocol\'s defaults, read from one place');
{
  const env = lab();
  const out = show(env.sw, env.t, env.sim, 'show lldp');
  ok(lldpLib.DEFAULT_TX_INTERVAL_S === 30, 'the advertisement interval is 30 s', String(lldpLib.DEFAULT_TX_INTERVAL_S));
  ok(lldpLib.DEFAULT_REINIT_DELAY_S === 2, 'the reinitialisation delay is 2 s', String(lldpLib.DEFAULT_REINIT_DELAY_S));
  // `lldp holdtime` is `lldp timer` x the hold multiplier 4, which is why the two numbers are tied rather than
  // independently chosen - the same relation engine/device.js relies on when a record arrives without a TTL.
  ok(lldpLib.DEFAULT_TTL_S === lldpLib.DEFAULT_TX_INTERVAL_S * 4,
    'the advertised hold time is four advertisement intervals', lldpLib.DEFAULT_TTL_S + ' vs ' + lldpLib.DEFAULT_TX_INTERVAL_S);
  const hold = out.filter(function (l) { return /hold time/.test(l); })[0] || '';
  ok(hold.indexOf(String(lldpLib.DEFAULT_TTL_S)) !== -1,
    'and the line prints the library\'s value, so the two cannot drift', hold);
}

console.log('');
console.log('A word the view does not take is refused, and the table is named');
{
  const env = lab();
  const out = show(env.sw, env.t, env.sim, 'show lldp bogus');
  ok(out.length === 1 && /^% /.test(out[0]), 'one refusal line', JSON.stringify(out));
  ok(out[0].indexOf('"bogus"') !== -1, 'quoting the word that was typed', out[0]);
  ok(out[0].indexOf('show lldp neighbors') !== -1, 'naming the command that does print neighbours', out[0]);
  ok(!/Global LLDP Information/.test(out.join('\n')), 'and not answering the question it refused');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
