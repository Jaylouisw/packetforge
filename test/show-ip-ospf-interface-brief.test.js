'use strict';
// `show ip ospf interface brief` - the vendor's command, and the answer this console can honestly give.
//
// The command exists on every IOS box: `show ip [ospf] [process-id] interface [type number] [brief]`
// (Cisco IOS IP Routing: OSPF Command Reference, "show ip ospf interface", ospf-s1.html), and its `brief`
// view is a table of seven cells:
//
//   Interface    PID   Area            IP Address/Mask    Cost  State Nbrs F/C
//   Se0/0/0      1     0               192.168.12.1/30    781   P2P   1/1
//   Lo1          1     1               192.168.1.1/24     1     LOOP  0/0
//     (Cisco Networking Academy, "Lab - Configuring Multiarea OSPFv2", 6.2.3.8, R1/R2/R3 captures)
//
// This console read `brief` as a port name and answered `% No interface brief on <box>` - the sentence a
// misspelt port gets, about a view the box really has, which is the defect class #1443 fixed for
// `show interfaces switchport`. Two of the seven cells cannot be filled from this model: PID is the id from
// `router ospf <pid>`, a command the console does not have (one unnamed process), and State is the port's
// DR/BDR role, elected here only across a cable with two speakers. So the answer is a refusal that names
// the view, states the one cell no other view stands in for, and points at `show ip ospf interface <port>`.
// research/show-ip-ospf-interface-brief.md holds the captures and the open half.
const { loadCatalog } = require('../devices/registry');
const { Topology } = require('../engine/topology');
const { Simulator } = require('../engine/simulator');
const cliModule = require('../engine/cli');
const CliSession = cliModule.CliSession || cliModule;

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const specs = loadCatalog(require('path').join(__dirname, '..', 'devices'))
  .filter(function (s) { return !s.error; });
const ROUTER = specs.find(function (s) { return /^ISR 4331$/.test(s.model); });

// r1 --- r2 on Gi0/0/0, both in area 0, so at least one interface carries OSPF.
function lab() {
  const t = new Topology();
  ['r1', 'r2'].forEach(function (id) { t.addDevice(ROUTER, id); });
  t.connect('r1', 'Gi0/0/0', 'r2', 'Gi0/0/0', { mediaId: '1000base-t', speedMbps: 1000 });
  const addr = function (dev, port, ip) {
    const i = t.getDevice(dev).interfaces.get(port);
    i.ip = ip; i.mask = '255.255.255.0';
  };
  addr('r1', 'Gi0/0/0', '10.1.0.1');
  addr('r2', 'Gi0/0/0', '10.1.0.2');
  const s = new CliSession(t.getDevice('r1'), t);
  ['enable', 'configure terminal', 'ospf router-id 1.1.1.1', 'interface Gi0/0/0', 'ip ospf area 0']
    .forEach(function (c) { s.run(c); });
  const sim = new Simulator(t);
  sim.computeOspf();
  return { t: t, sim: sim };
}
function say(env, cmd) {
  return (new CliSession(env.t.getDevice('r1'), env.t, env.sim).run(cmd).output || []).map(String);
}

console.log('');
console.log('`brief` is refused as a view, with the view named:');
{
  const env = lab();
  const out = say(env, 'show ip ospf interface brief');
  ok(out[0] === '% `brief` is a view, not a port: this console has no `show ip ospf interface brief`.',
    'the first line names the keyword and the view, and claims no port is missing', out[0]);
  ok(!/No interface brief on/.test(out.join('\n')),
    'the sentence a misspelt port gets is gone', out.join(' | '));
  ok(/Interface {4}PID {3}Area {12}IP Address\/Mask {4}Cost {2}State Nbrs F\/C/.test(out[1]),
    'the second line prints the vendor header at the vendor widths, so the reader knows which table is missing', out[1]);
  ok(/router ospf <pid>/.test(out.join('\n')),
    'and names the one cell no other view stands in for: the process id', out.join(' | '));
  ok(/show ip ospf interface \[<port>\]` prints the area, the cost and whether the port is adjacent/.test(out.join('\n')),
    'and points at the view that does answer', out.join(' | '));
  ok(out.length === 4, 'four lines, no table and no count under it', JSON.stringify(out));
}

console.log('');
console.log('Every spelling of the keyword gets the same answer:');
{
  const env = lab();
  ['show ip ospf interface bri', 'show ip ospf interface b', 'show ip ospf interface BRIEF',
    'show ip ospf interfaces brief'].forEach(function (cmd) {
    const out = say(env, cmd);
    ok(/is a view, not a port: this console has no `show ip ospf interface brief`/.test(out[0]),
      '`' + cmd + '` is refused the same way', out[0]);
  });
}

console.log('');
console.log('A port named in front of the keyword is still not a port:');
{
  const env = lab();
  const out = say(env, 'show ip ospf interface Gi0/0/0 brief');
  ok(out[0] === '% `Gi0/0/0 brief` is a view, not a port: this console has no `show ip ospf interface brief`.',
    'the row was asked for a port that exists, and the keyword is still a view', out[0]);
}

console.log('');
console.log('The words that were already answered are unchanged:');
{
  const env = lab();
  const table = say(env, 'show ip ospf interface');
  ok(/^Interface\s+IP Address\s+Area\s+Cost\s+Cost from\s+Adjacent\s+Passive$/.test(table[0]),
    '`show ip ospf interface` still heads its one table', table[0]);
  ok(/^Gi0\/0\/0\s+10\.1\.0\.1\/24\s+0\s+1\s+link rate/.test(table[1]),
    'and still prints the port that carries OSPF', table[1]);
  const one = say(env, 'show ip ospf interface Gi0/0/0');
  ok(/^Interface\s+IP Address/.test(one[0]) && one.indexOf(table[1]) !== -1,
    '`show ip ospf interface <port>` still narrows to that port', one.join(' | '));
  const nbr = say(env, 'show ip ospf neighbour');
  ok(/^Neighbor ID\s+Pri\s+State/.test(nbr[0]),
    '`show ip ospf neighbour` is untouched', nbr[0]);
}

console.log('');
console.log('A port that really is named `brief` wins over the keyword:');
{
  const env = lab();
  env.t.getDevice('r1').interfaces.set('brief', {
    name: 'brief', type: 'ethernet', speed: '1 Gb/s', enabled: true, ip: '10.9.9.9', mask: '255.255.255.0'
  });
  const out = say(env, 'show ip ospf interface brief');
  ok(!/is a view, not a port/.test(out.join('\n')),
    'the port table is consulted first, as `show interfaces` consults it', out.join(' | '));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
