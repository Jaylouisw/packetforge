'use strict';
// config-filters.test.js — "just this interface", asked of both configuration views.
//
// `show running-config interface Gi0/0` printed the whole configuration, and so did
// `show running-config bogus`. The argument was dropped on the floor: an answer that looks like an
// answer to the question asked, and a typo that reads as success. The saved copy inherited the same
// hole the moment it was added, which is how this was found - a new command has to be held to the
// rules the older ones were fixed to.
//
// The filter is worth more than a shorter page: asking about one port is how an operator finds out
// whether the change they just made *to that port* is in the saved copy. So the filtered startup view
// carries its own delta, and the tests below check that a port nobody touched reports nothing.
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
const strip = (lines) => lines.filter((l) => !/^[^\s#>]+[#>]\s?/.test(l));

function consoleFor(dev, t, sim) {
  const s = new CliSession(dev, t, sim);
  return {
    out: function () {
      const o = [];
      for (const cmd of Array.prototype.slice.call(arguments)) o.push.apply(o, s.run(cmd).output);
      return o;
    },
    text: function () { return this.out.apply(this, arguments).join('\n'); }
  };
}

function lab() {
  const t = new Topology();
  const r1 = t.addDevice(model('generic-router'));
  r1.name = 'R1';
  const sim = new Simulator(t);
  const c = consoleFor(r1, t, sim);
  c.out('enable', 'configure terminal', 'hostname R1', 'vlan 99 users',
    'interface Gi0/0', 'description to-core', 'ip address 10.0.1.1 255.255.255.0', 'exit',
    'interface Gi0/1', 'description uplink', 'ip address 10.0.2.1 255.255.255.0', 'exit', 'exit');
  return { t, sim, r1, c };
}

// Independent extraction of a block, written from the printed text rather than from the engine's
// helper, so the test is not comparing the helper to itself.
function blockOf(lines, port) {
  const out = [];
  let inside = false;
  for (const line of lines) {
    if (/^interface\s/i.test(line)) {
      inside = line.trim().split(/\s+/)[1] === port;
      if (inside) out.push(line);
      continue;
    }
    if (!inside) continue;
    if (!/^ /.test(line)) { inside = false; continue; }
    out.push(line);
  }
  return out;
}

console.log('The running config narrows to one interface, and the narrowing is the block:');
{
  const env = lab();
  const full = strip(env.c.out('show running-config'));
  const filtered = strip(env.c.out('show running-config interface Gi0/0'));
  eq(filtered[0], '! PacketForge running-config, interface Gi0/0', 'the answer names what was asked');
  const body = filtered.slice(1);
  eq(body.join('\n'), blockOf(full, 'Gi0/0').join('\n'), 'and the block is exactly that interface');
  ok(body[0] === 'interface Gi0/0', 'starting with the interface line');
  ok(body.some((l) => /^  ip address 10\.0\.1\.1/.test(l)), 'including its address');
  ok(body.some((l) => /^  description to-core/.test(l)), 'and its description');
  ok(!body.some((l) => /Gi0\/1|Gi0\/2|vlan 99|hostname/.test(l)),
    'and nothing from another port, a VLAN or the hostname');
  // A narrowed answer must not equal the full one - the guard against a filter that does nothing.
  ok(filtered.length < full.length, 'the filtered answer is shorter than the whole configuration');
  // The keyword is optional, and both spellings give the same answer.
  eq(strip(env.c.out('show running-config Gi0/0')).join('\n'), filtered.join('\n'),
    'the bare port spelling gives the identical answer');
}

console.log('\nA port with nothing configured still answers, with its own (empty) block:');
{
  const env = lab();
  const out = strip(env.c.out('show running-config Gi0/2'));
  eq(out.join('\n'), '! PacketForge running-config, interface Gi0/2\ninterface Gi0/2',
    'the header line is the block');
  ok(!/\%/.test(out.join('\n')), 'and it is not an error - the port exists and has no configuration');
}

console.log('\nRefusals: every argument either narrows the answer or is named:');
{
  const env = lab();
  const bogus = env.c.text('show running-config bogus');
  ok(/% No interface named bogus on R1/.test(bogus), 'an unknown port is refused by name');
  ok(/show ip interface brief/.test(bogus), 'and the refusal says where the ports are');
  ok(!/hostname R1/.test(bogus), 'nothing is printed as if it were an answer');
  const truncated = env.c.text('show running-config interface');
  ok(/needs a port after "interface"/.test(truncated),
    '"interface" with no port is refused as truncated, not answered with everything');
  const two = env.c.text('show running-config interface Gi0/0 Gi0/1');
  ok(/takes one port/.test(two), 'two ports are refused rather than guessed at');
  // The same helper serves the older commands, so the same truncated form is refused there too.
  ok(/needs a port after "interface"/.test(env.c.text('show arp interface')),
    'show arp interface is refused the same way');
}

console.log('\nThe saved copy narrows too, and answers "is my change saved?" for that port:');
{
  const env = lab();
  env.c.out('write memory');
  // Nothing changed yet: the filtered view is just the block, with no delta line at all.
  const clean = strip(env.c.out('show startup-config interface Gi0/1'));
  eq(clean[0], '! PacketForge startup-config (saved copy), interface Gi0/1', 'the header names the copy and the port');
  ok(clean.some((l) => /^  description uplink/.test(l)), 'the saved block is shown');
  ok(!/differs/.test(clean.join('\n')), 'and with nothing changed there is no delta line');

  // Change Gi0/1 only.
  env.c.out('configure terminal', 'interface Gi0/1', 'no description', 'exit', 'exit');
  const changed = strip(env.c.out('show startup-config interface Gi0/1')).join('\n');
  ok(/running-config differs for Gi0\/1: 1 line removed/.test(changed),
    'the port that changed reports its own delta: ' +
    (changed.split('\n').filter((l) => /differs/.test(l))[0] || ''));
  ok(/! -   description uplink/.test(changed), 'with the removed line named');
  // The untouched port must stay quiet: a filter that reported the whole config's delta would send an
  // operator looking at a port they never touched.
  const untouched = strip(env.c.out('show startup-config interface Gi0/0')).join('\n');
  ok(!/differs/.test(untouched), 'the port nobody touched reports no delta');
  // And the whole-config view still reports the total, so the two answers agree.
  const whole = strip(env.c.out('show startup-config')).join('\n');
  ok(/running-config differs from this copy: 1 line removed/.test(whole),
    'the full view reports the same change in total');
}

console.log('\nA filtered block is still a block: it can be pasted on its own:');
{
  const env = lab();
  const filtered = strip(env.c.out('show running-config interface Gi0/0'));
  // Comments are dropped by the parser, so a filtered dump pastes cleanly onto a bare device.
  const t2 = new Topology();
  const other = t2.addDevice(model('generic-router'));
  other.name = 'R9';
  const sim2 = new Simulator(t2);
  const c2 = consoleFor(other, t2, sim2);
  c2.out('enable', 'configure terminal');
  const refusals = [];
  for (const line of filtered) {
    for (const o of c2.out(line)) if (/^%/.test(o)) refusals.push(line + ' -> ' + o);
  }
  eq(refusals.join(' | '), '', 'no line of the filtered dump was refused');
  c2.out('exit');
  const iface = other.interfaces.get('Gi0/0');
  eq(iface.ip, '10.0.1.1', 'and the pasted block configured that port');
  eq(iface.description, 'to-core', 'including its description');
}

console.log('\nThe filter picks the block, not the first line that mentions the port:');
{
  const env = lab();
  // A port named inside a description and inside a static route must not be mistaken for its block.
  env.c.out('configure terminal', 'interface Gi0/1', 'description see Gi0/0 for the core', 'exit',
    'ip route 10.9.9.0 255.255.255.0 Gi0/0', 'exit', 'exit');
  const out = strip(env.c.out('show running-config interface Gi0/0')).join('\n');
  ok(/^interface Gi0\/0$/m.test(out), 'the block header is the interface line');
  ok(!/description see Gi0\/0/.test(out), 'a description that mentions the port is not part of it');
  ok(!/ip route 10\.9\.9\.0/.test(out), 'and neither is a global route that names it');
  ok(!/^hostname/m.test(out), 'nor the global lines above it');
  // The port whose description mentions Gi0/0 keeps its own block.
  const other = strip(env.c.out('show running-config interface Gi0/1')).join('\n');
  ok(/description see Gi0\/0 for the core/.test(other), 'the other port keeps its own block');
}

console.log('\nA number after "interface" is a port name, not an instant:');
{
  // The sweep that types every help row found this: `show mac address-table interface 22` answered
  // "MAC table at t=22 ms (control planes rebuilt for this answer)" and dropped the port entirely.
  // A trailing number is an instant only when it is the question - after `interface` it is the value.
  const t = new Topology();
  const sw = t.addDevice(model('CX 6000 24G CL4 PoE 4SFP 370W'));
  sw.name = 'SW1';
  const sim = new Simulator(t);
  const c = consoleFor(sw, t, sim);
  const asPort = c.out('show mac address-table interface 22').join('\n');
  ok(/% No interface named 22 on SW1/.test(asPort), 'the number is read as a port name and refused by name');
  ok(!/at t=22 ms/.test(asPort), 'and it is not read as an instant');
  ok(!/% Invalid/.test(asPort), 'nor as a malformed command: the shape is valid, the name is not');
  const real = c.out('show mac address-table interface 1/1/3').join('\n');
  ok(/Mac address table on 1\/1\/3/.test(real), 'a real port name still narrows the table');
  // The instant reading has to survive: it is the same trailing-number syntax, one keyword over.
  ok(/at t=5000 ms/.test(c.out('show mac address-table 5000').join('\n')),
    'a bare number with no keyword before it is still an instant');
  ok(/at t=5000 ms/.test(c.out('show spanning-tree 5000').join('\n')),
    'and so is the same number on another instant-capable show');
  ok(/at t=converged|converged/.test(c.out('show mac address-table converged').join('\n')),
    'converged is unaffected by the rule');
  // Two shows, one rule: the same shape is refused the same way where a port is expected.
  ok(/% No interface named 22/.test(c.out('show arp interface 22').join('\n')),
    'show arp interface 22 is a port question too');
}

console.log('\nThe same question works from config mode with do:');
{
  const env = lab();
  env.c.out('configure terminal');
  const out = strip(env.c.out('do show running-config interface Gi0/0')).join('\n');
  ok(/! PacketForge running-config, interface Gi0\/0/.test(out), 'do show running-config narrows too');
  ok(!/Gi0\/1/.test(out), 'and prints one block');
  env.c.out('exit');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
