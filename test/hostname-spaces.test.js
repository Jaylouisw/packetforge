'use strict';
// Issue #19 and #21: a hostname with spaces was cut down to its first word.
//
// #19 fixed config.hostname, which made `show running-config` correct. It did not touch
// device.name, and device.name is what every surface actually renders - the canvas label,
// the inspector header, the "Selected:" line. So a device renamed to "THE BIFROST" reported
// the right hostname in the config and still showed as "THE" everywhere on screen (#21).
//
// A device must not be able to disagree with itself.
const path = require('path');
const { Topology, Simulator, CliSession } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const spec = catalog.find(function (s) { return s.vendor === 'generic' && s.model === 'generic-router'; });

const t = new Topology();
const dev = t.addDevice(spec);
const cli = new CliSession(dev, t, new Simulator(t));

console.log('A hostname with spaces survives whole:');
{
  cli.run('configure terminal');
  cli.run('hostname THE BIFROST');
  ok(dev.config.hostname === 'THE BIFROST', 'config.hostname keeps every word');
  ok(dev.name === 'THE BIFROST', 'device.name keeps every word (this is what the UI renders)');
  ok(dev.name === dev.config.hostname, 'the two cannot disagree');
  ok(cli.prompt().indexOf('THE BIFROST') === 0, 'the prompt shows the whole name');
}

console.log('\nA rename replaces the whole name rather than appending:');
{
  cli.run('hostname raft  seven');
  // The CLI tokenises, so a doubled space becomes one - the same as IOS. What must not
  // happen is a word disappearing, which is what this whole issue was.
  ok(dev.name === 'raft seven', 'a doubled space collapses, but no word is lost');
  cli.run('hostname lonely');
  ok(dev.name === 'lonely', 'a one-word name still works');
  ok(dev.config.hostname === 'lonely', 'and the config agrees');
}

console.log('\nshow running-config agrees with what is on screen:');
{
  cli.run('hostname edge router 2');
  cli.run('end');
  const out = cli.run('show running-config');
  const text = typeof out === 'string' ? out : (out && out.output) || '';
  ok(/hostname edge router 2/.test(text), 'running-config carries the full hostname');
  ok(dev.name === 'edge router 2', 'and device.name matches it');
}

console.log('\nSerialization keeps it:');
{
  const json = JSON.parse(JSON.stringify(t.serialize()));
  const back = Topology.fromJSON ? Topology.fromJSON(json) : require('../engine/topology').fromJSON(json);
  const restored = [...back.devices.values()][0];
  ok(restored.name === 'edge router 2', 'the name survives a save/load round trip');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
