'use strict';
// lldp-stale.test.js - a neighbour table records frames that crossed the link, so it goes stale.
//
// The point of modelling LLDP rather than reading the cable out of the device spec is that the
// neighbour is a fact produced by a frame. The gap was on the other side of that: nothing took the
// entry away again. Pulling the cable out of the topology did (topology.disconnect() drops it), but
// shutting the port did not - and `show lldp neighbors detail` went further and printed
//
//   Local port state: up (the announcement is what proves the link is passing frames)
//
// about a port the administrator had shut, which is the one thing such a port certainly is not
// doing. This suite pins the rule: a row that cannot be re-learned says why, in the words
// `_ifaceState` already uses for every other table, and the sentence about frames is only printed
// when the link can actually carry one.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function saw(re, haystack, msg) {
  const text = (haystack && haystack.output) ? haystack.output.join('\n') : String(haystack);
  ok(re.test(text), msg + (re.test(text) ? '' : ' (in ' + JSON.stringify(text.slice(0, 700)) + ')'));
}
function didNotSee(re, haystack, msg) {
  const text = (haystack && haystack.output) ? haystack.output.join('\n') : String(haystack);
  ok(!re.test(text), msg + (re.test(text) ? ' (found in ' + JSON.stringify(text.slice(0, 700)) + ')' : ''));
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(v, m) { return catalog.find(function (s) { return s.vendor === v && s.model === m; }); }

// Two devices cabled, LLDP run, so both have a neighbour to go stale.
function lab(prep) {
  const t = new Topology();
  const pc = t.addDevice(spec('generic', 'generic-pc')); pc.name = 'PC1';
  const sw = t.addDevice(spec('generic', 'generic-switch')); sw.name = 'SW1';
  pc.interfaces.get('eth0').ip = '10.0.0.1';
  pc.interfaces.get('eth0').mask = '255.255.255.0';
  t.connect(pc.id, 'eth0', sw.id, 'Fa0/1');
  const sim = new Simulator(t);
  sim.ping(pc.id, '10.0.0.99');           // the frames that teach both ends
  const s = new CliSession(pc, t, sim);
  if (prep) prep({ t: t, pc: pc, sw: sw, sim: sim, s: s });
  return { t: t, pc: pc, sw: sw, sim: sim, s: s };
}
const say = (s, line) => s.run(line);

console.log('A healthy link states a fact, and says nothing about staleness:');
{
  const { pc, s } = lab();
  ok(!!pc.lldp.get('eth0'), 'the neighbour was learned over the wire');
  const out = say(s, 'show lldp neighbors');
  saw(/SW1\s+eth0/, out, 'the table lists it on the port that heard it');
  didNotSee(/was heard here, but/, out, 'and claims no staleness, because the link can still carry a frame');
  const detail = say(s, 'show lldp neighbors detail');
  saw(/Local port state: up\/up - the announcement is what proves the link is passing frames/,
    detail, 'the detail block still makes the frames claim, because here it is true');
}

console.log('\nA shut local port keeps its row but says the row is history:');
{
  const { pc, s } = lab();
  // Driven through the console rather than by touching the model, so the suite tests what an
  // operator can actually do.
  s.run('configure terminal', 'interface eth0', 'shutdown', 'end');
  ok(pc.interfaces.get('eth0').enabled === false, 'the console shut the port');
  ok(!!pc.lldp.get('eth0'), 'the entry is still there - nothing in this model ages it out');
  const out = say(s, 'show lldp neighbors');
  saw(/SW1\s+eth0/, out, 'so the table still lists it');
  saw(/eth0: SW1 was heard here, but this port is administratively down/, out,
    'and names the port, the neighbour and the reason in one line');
  saw(/Those rows are what crossed the link, not what is there now/, out,
    'saying plainly that the table is not a description of the present');
  const detail = say(s, 'show lldp neighbors detail');
  saw(/Local port state: administratively down\/down/, detail,
    'the detail block reports the state the administrator set');
  didNotSee(/proves the link is passing frames/, detail,
    'and no longer claims a shut port is passing frames');
  saw(/this port is administratively down, so this block is what was learned/, detail,
    'it says why the block is history instead');
}

console.log('\nA shut port at the far end is named too, because our port is fine:');
{
  const { sw, s } = lab();
  sw.interfaces.get('Fa0/1').enabled = false;
  const out = say(s, 'show lldp neighbors');
  saw(/eth0: SW1 was heard here, but the far port Fa0\/1 on SW1 is administratively down/, out,
    'the line names the far port and the device it is on');
  const detail = say(s, 'show lldp neighbors detail');
  saw(/Local port state: up\/up - the far port Fa0\/1 on SW1 is administratively down/, detail,
    'our own port still reads up, so the reason comes from the other end of the cable');
  didNotSee(/proves the link is passing frames/, detail,
    'and the frames claim is withdrawn even though our own port is up');
}

console.log('\nPulling the cable out of the topology still drops the entry outright:');
{
  const { t, pc, s } = lab();
  ok(pc.lldp.size === 1, 'there is a neighbour to lose');
  t.disconnect(Array.from(t.links.keys())[0]);
  ok(pc.lldp.size === 0, 'disconnect() removes the entry rather than leaving it to go stale');
  const out = say(s, 'show lldp neighbors');
  saw(/\(none - no LLDP has been heard on any port\)/, out,
    'so the table is empty, not a stale row');
  didNotSee(/was heard here, but/, out, 'and nothing pretends otherwise');
}

console.log('\nUndoing the shutdown restores the fact, so the note is not sticky:');
{
  const { pc, s } = lab();
  s.run('configure terminal', 'interface eth0', 'shutdown', 'end');
  saw(/administratively down/, say(s, 'show lldp neighbors'), 'the port is shut and the note is there');
  s.run('configure terminal', 'interface eth0', 'no shutdown', 'end');
  ok(pc.interfaces.get('eth0').enabled === true, 'the console brought the port back');
  const out = say(s, 'show lldp neighbors');
  didNotSee(/was heard here, but/, out, 'the note is gone once the port can carry a frame again');
  saw(/SW1\s+eth0/, out, 'and the neighbour is still listed');
}

console.log('\nThe per-port form carries the same sentence as the table:');
{
  const { s } = lab();
  s.run('configure terminal', 'interface eth0', 'shutdown', 'end');
  const out = say(s, 'show lldp neighbors eth0');
  saw(/eth0: SW1 was heard here, but this port is administratively down/, out,
    'filtering to the port does not filter the warning away');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
