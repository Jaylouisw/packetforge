'use strict';
// A port name is the whole rest of the line, wherever a command takes one (#1401).
//
// `interface Port 1` has read the name as the rest of the line since #1230, and its own comment says why:
// Ubiquiti calls its ports "Port 1" and its cages "SFP+ 1", so reading only the first word looked up a port
// called "Port" and refused it. That fix reached the configuration door. The reporting doors were left behind:
//
//   show interfaces Port 1        -> % No interface Port on EdgeSwitch 24 PoE (250W)-d1
//   show power inline Port 1      -> % No interface Port on EdgeSwitch 24 PoE (250W)-d1
//   show mac address-table interface Port 1  -> every entry on the box
//
// So the operator could *configure* a port by the name printed in front of them and could not *look* at it, and
// the refusal named a port they never typed. 17 models of the catalogue name their ports this way.
//
// Three doors, one rule: the rest of the line is the name, and a filter that is accepted is applied or refused -
// never ignored.
const path = require('path');
const { CliSession } = require('../engine/cli');
const { Topology } = require('../engine/topology');
const { Simulator } = require('../engine/simulator');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const pick = function (m) { return catalog.filter(function (s) { return s.model === m; })[0]; };
const SPACED = pick('ES-24-250W');       // ports named "Port 1" ... "Port 24", cages "SFP 1"
const PLAIN = pick('ISR 4331');          // ports named Gi0/0/0 - the ordinary spelling
const HOST = pick('Raspberry Pi 5');

// A block header is the line whose next line is "  status: ..." - structure, not a guess at the port vocabulary.
function blocks(text) {
  const lines = String(text).split('\n');
  let n = 0;
  for (let i = 0; i < lines.length - 1; i++) {
    if (/^ {2}status: /.test(lines[i + 1]) && !/^ {2}/.test(lines[i]) && lines[i].trim()) n++;
  }
  return n;
}

function show(topology, devId, cmd, sim) {
  const s = new CliSession(topology.getDevice(devId), topology, sim || new Simulator(topology));
  s.run('enable');
  return (s.run(cmd).output || []).join('\n');
}
function configure(dev, topo, cmds) {
  const s = new CliSession(dev, topo, new Simulator(topo));
  s.run('enable'); s.run('configure terminal');
  for (const c of cmds) s.run(c);
  s.run('end');
}

console.log('A port whose name contains a space can be looked at');
{
  const t = new Topology();
  t.addDevice(SPACED, 'sw1');
  const sim = new Simulator(t);
  sim.setRunTime(60000);
  const one = show(t, 'sw1', 'show interfaces Port 1', sim);
  ok(blocks(one) === 1, 'show interfaces "Port 1" prints one block', String(blocks(one)));
  ok(/^Port 1 \(/.test(one), 'and it is the port that was named', one.split('\n')[0]);
  ok(!/No interface/.test(one), 'with no refusal in it', one.split('\n')[0]);

  const short = show(t, 'sw1', 'show interface Port 1', sim);
  ok(blocks(short) === 1 && /^Port 1 \(/.test(short), 'show interface (singular) agrees', short.split('\n')[0]);

  const cage = show(t, 'sw1', 'show interfaces SFP 1', sim);
  ok(blocks(cage) === 1 && /^SFP 1 \(/.test(cage), 'and a cage named "SFP 1" resolves too', cage.split('\n')[0]);
}

console.log('');
console.log('A name that matches nothing is refused by the name that was typed');
{
  const t = new Topology();
  t.addDevice(SPACED, 'sw1');
  const out = show(t, 'sw1', 'show interfaces Port 99');
  ok(/% No interface Port 99 on /.test(out), 'the refusal quotes the whole name', out);
  ok(!/% No interface Port on /.test(out), 'not its first word', out);

  const noName = show(t, 'sw1', 'show interfaces');
  ok(blocks(noName) === 26, 'and the bare command still prints every port', String(blocks(noName)));
}

console.log('');
console.log('The reporting door and the configuration door agree about what a port is');
{
  const t = new Topology();
  t.addDevice(SPACED, 'sw1');
  const sim = new Simulator(t);
  sim.setRunTime(60000);
  configure(t.getDevice('sw1'), t, ['interface Port 3', 'ip address 10.9.9.1 255.255.255.0']);
  const out = show(t, 'sw1', 'show interfaces Port 3', sim);
  ok(/10\.9\.9\.1/.test(out), 'an address set through `interface Port 3` is read back through show', out.split('\n').slice(0, 4).join(' | '));
  ok(/Port 3/.test(out.split('\n')[0]), 'on the port that was configured', out.split('\n')[0]);
}

console.log('');
console.log('`show power inline` takes the same name');
{
  const t = new Topology();
  t.addDevice(SPACED, 'sw1');
  const H = pick('Raspberry Pi 5');
  t.addDevice(H, 'h1');
  const sim = new Simulator(t);
  sim.setRunTime(60000);
  t.connect('h1', 'eth0', 'sw1', 'Port 1', { mediaId: '1000base-t', speedMbps: 1000 });
  sim.computePoe();
  const out = show(t, 'sw1', 'show power inline Port 1', sim);
  ok(!/No interface Port on/.test(out), 'the refusal about a port called "Port" is gone', out.split('\n')[0]);
  ok(/Port 1/.test(out), 'and the answer names Port 1', out.split('\n').slice(0, 3).join(' | '));
  const missing = show(t, 'sw1', 'show power inline Port 99', sim);
  ok(/% No interface Port 99/.test(missing), 'a name that matches nothing is refused by name', missing);
}

console.log('');
console.log('A filter the command accepts is applied, not dropped');
{
  const t = new Topology();
  t.addDevice(SPACED, 'sw1'); t.addDevice(HOST, 'h1'); t.addDevice(HOST, 'h2');
  const L = { mediaId: '1000base-t', speedMbps: 1000 };
  t.connect('h1', 'eth0', 'sw1', 'Port 1', L);
  t.connect('h2', 'eth0', 'sw1', 'Port 2', L);
  configure(t.getDevice('h1'), t, ['interface eth0', 'ip address 10.0.0.1 255.255.255.0']);
  configure(t.getDevice('h2'), t, ['interface eth0', 'ip address 10.0.0.2 255.255.255.0']);
  const sim = new Simulator(t);
  sim.setRunTime(60000);
  sim.ping('h1', '10.0.0.2', { count: 1 });

  const all = show(t, 'sw1', 'show mac address-table', sim);
  ok(/Port 1/.test(all) && /Port 2/.test(all), 'the unfiltered table holds both ports', all);

  const one = show(t, 'sw1', 'show mac address-table interface Port 1', sim);
  ok(/Port 1/.test(one), 'the filtered table holds Port 1', one);
  ok(!/Port 2/.test(one), 'and not Port 2', one);
  ok(one.split('\n').length === 2, 'it is one row under a header', one.replace(/\n/g, ' | '));

  const intForm = show(t, 'sw1', 'show mac address-table int Port 2', sim);
  ok(/Port 2/.test(intForm) && !/Port 1/.test(intForm), 'the abbreviation filters too', intForm);

  const empty = show(t, 'sw1', 'show mac address-table interface Port 9', sim);
  ok(/no entry learned on Port 9/.test(empty), 'a filter that matches nothing says so about that port', empty);
  ok(!/Port 1/.test(empty), 'instead of printing the box', empty);

  const bogus = show(t, 'sw1', 'show mac address-table vlan 1', sim);
  ok(/^% show mac address-table does not take/.test(bogus), 'a filter it does not implement is refused', bogus);
  const noName = show(t, 'sw1', 'show mac address-table interface', sim);
  ok(/^% interface needs a port/.test(noName), 'and a missing name is asked for', noName);
  const noPort = show(t, 'sw1', 'show mac address-table interface Port 99', sim);
  ok(/% No interface Port 99/.test(noPort), 'an unknown port is refused by name', noPort);
}

console.log('');
console.log('A single-word name still works, and every model can be looked at port by port');
{
  const t = new Topology();
  t.addDevice(PLAIN, 'r1');
  const sim = new Simulator(t);
  sim.setRunTime(60000);
  const out = show(t, 'r1', 'show interfaces Gi0/0/0', sim);
  ok(blocks(out) === 1 && /^Gi0\/0\/0 \(/.test(out), 'show interfaces Gi0/0/0 answers about Gi0/0/0', out.split('\n')[0]);

  // The sweep that found this: for every model, the first three ports it lists must be answerable by name.
  const bad = [];
  let checked = 0;
  for (const spec of catalog) {
    let tt = null, d = null, ss = null;
    try {
      tt = new Topology();
      tt.addDevice(spec, 'd1');
      d = tt.getDevice('d1');
      ss = new Simulator(tt);
      ss.setRunTime(60000);
    } catch (e) { bad.push(spec.model + ' setup threw'); continue; }
    for (const name of Array.from(d.interfaces.keys()).slice(0, 3)) {
      let text = '';
      try { text = show(tt, 'd1', 'show interfaces ' + name, ss); } catch (e) { bad.push(spec.model + ' ' + name + ' threw: ' + e.message); continue; }
      checked++;
      if (blocks(text) !== 1) bad.push(spec.model + ' | ' + name + ' | ' + blocks(text) + ' blocks');
    }
  }
  ok(checked > 5000, 'every model, three ports each', String(checked));
  ok(bad.length === 0, 'each one namable, and each answer about exactly that port', bad.slice(0, 5).join(' ;; '));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
