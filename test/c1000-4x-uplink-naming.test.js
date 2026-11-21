'use strict';
// A Catalyst 1000's SFP cages are named after the optic the SKU carries: Gi1/0/25 on a 1G model,
// Te1/0/1 on a 10G one.
//
// The catalogue had only the 1G convention, and applied it to the one 10G spec it holds: the
// C1000-24FP-4X-L declared its four SFP+ cages as `Gi1/0/25`-`Gi1/0/28`. So the switch said
// `Gi1/0/25 (ethernet, 10G)` about a 10-gigabit cage - a port a GigabitEthernet name cannot be - and
// refused `interface Te1/0/1`, which is the name Cisco's own guide for the 10-G models prints.
//
// Cisco's hardware installation guide pairs the two names for the same cage in its port-mapping
// tables (24-port: GigabitEthernet1/0/25 with TenGigabitEthernet1/0/1, .../28 with .../4; 48-port:
// .../49 with .../1, .../52 with .../4) and calls them the "mapped ports". That the CLI of a 10-G box
// actually uses the Te name, module 0 and starting at 1, is in the C1000 single-IP-management guide:
// every 10-G example lists `Te1/0/1`, `Te1/0/2`, `Te1/0/3` and `Te1/0/4` in `show switch hstack-ports`
// and speaks of the "10 Gigabit Ethernet 1/0/1 interface", while its 1-G examples list `Gi1/0/9`-`10`,
// `Gi1/0/17`-`18`, `Gi1/0/25`-`28` and `Gi1/0/49`-`52` - the four families' downlink groups, continued.
// research/c1000-4x-uplink-naming.md records the evidence and what is still open.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
function specFor(model) {
  const s = catalog.filter(function (x) { return x.model === model; })[0];
  ok(!!s, 'the catalogue has ' + model);
  return s;
}
function names(spec) {
  const t = new Topology();
  t.addDevice(spec, 'SW');
  return Array.from(t.getDevice('SW').interfaces.keys());
}
function lab(spec) {
  const t = new Topology();
  const d = t.addDevice(spec, 'SW');
  const sim = new Simulator(t);
  return { t: t, d: d, sim: sim,
    run: function (lines) { return runCommands(d, t, sim, lines).lines; } };
}
// An optical cage, told apart by connector rather than by name - the name is what is under test.
const CAGE_RE = /^(sfp|sfp\+|sfp28)$/;
function cages(spec) {
  return (spec.interfaces || []).filter(function (i) { return CAGE_RE.test(String(i.connector || '')); });
}
function copperCount(spec) {
  return ((spec.portTemplate && spec.portTemplate.count) || 0);
}
// A combo port's SFP half is recorded as `<copper name>-sfp`; its number is the copper port's.
function bareName(name) { return String(name).replace(/-sfp$/, ''); }

const c1000 = catalog.filter(function (s) { return /^C1000-/.test(s.model); });

console.log('');
console.log('The cage is named after the optic the model carries:');
{
  ok(c1000.length === 9, 'the catalogue holds 9 Catalyst 1000 specs', String(c1000.length));
  const bad = [];
  for (const s of c1000) {
    const cs = cages(s);
    const n = copperCount(s);
    const tenGig = cs.filter(function (c) { return String(c.speed) === '10G'; });
    if (tenGig.length) {
      // A 10G SKU: every cage is TenGigabitEthernet, module 0, restarting at 1.
      const want = tenGig.map(function (_, i) { return 'Te1/0/' + (i + 1); });
      const got = tenGig.map(function (c) { return c.name; });
      if (JSON.stringify(got) !== JSON.stringify(want)) bad.push(s.model + ': ' + got.join(','));
    } else {
      // A 1G SKU: every cage continues the downlink group. A combo port's SFP half keeps the number
      // of the RJ-45 half it shares a socket with, so both are past the downlink group.
      const all = names(s);
      for (const c of cs) {
        const nm = bareName(c.name);
        const tail = Number(String(nm).split('/').pop());
        if (!/^Gi1\/0\//.test(nm) || !(tail > n && tail <= n + 4)) bad.push(s.model + ': ' + c.name);
        else if (/-sfp$/.test(String(c.name)) && all.indexOf(nm) === -1) {
          bad.push(s.model + ': combo ' + c.name + ' has no RJ-45 half');
        }
      }
    }
  }
  ok(bad.length === 0, 'a 1G cage is Gi1/0/<n+1...>, a 10G cage is Te1/0/1...', bad.join(' | '));

  // The four families, exactly as the vendor's port-mapping tables give them.
  const rows = {
    'C1000-8P-2G-L': ['Gi1/0/9-sfp', 'Gi1/0/10-sfp'],
    'C1000-16P-2G-L': ['Gi1/0/17', 'Gi1/0/18'],
    'C1000-24FP-4G-L': ['Gi1/0/25', 'Gi1/0/28'],
    'C1000-48P-4G-L': ['Gi1/0/49', 'Gi1/0/52'],
    'C1000-24FP-4X-L': ['Te1/0/1', 'Te1/0/4']
  };
  for (const model of Object.keys(rows)) {
    const got = (cages(specFor(model)) || []).map(function (c) { return c.name; });
    ok(got[0] === rows[model][0] && got[got.length - 1] === rows[model][1],
      model + ' names its cages ' + rows[model][0] + '..' + rows[model][1], got.join(','));
  }
}

console.log('');
console.log('The rename moved four names; it did not add or drop a socket:');
{
  const s = specFor('C1000-24FP-4X-L');
  const ns = names(s);
  ok(ns.length === 28, 'the 24-port 10G model holds 28 ports - 24 copper, 4 optical', String(ns.length));
  ok(ns.indexOf('Gi1/0/1') !== -1 && ns.indexOf('Gi1/0/24') !== -1,
    'its copper downlinks are still Gi1/0/1..Gi1/0/24');
  ok(ns.indexOf('Gi1/0/25') === -1 && ns.indexOf('Gi1/0/28') === -1,
    'and a 10G model has no Gi1/0/25..Gi1/0/28 - those are the 1G cages numbers');
  const cs = cages(s);
  ok(cs.length === 4 && cs.every(function (c) { return String(c.speed) === '10G'; }) &&
    cs.every(function (c) { return String(c.connector) === 'sfp+'; }),
    'the four cages are still SFP+ at 10G', JSON.stringify(cs.map(function (c) { return c.name; })));
  ok(cs.every(function (c) { return (c.speedCaps || []).indexOf(1000) !== -1; }),
    'and still take a 1G module as well as a 10G one');
}

console.log('');
console.log('The console answers about the cage by the name the vendor guide uses:');
{
  const env = lab(specFor('C1000-24FP-4X-L'));
  const out = env.run(['show interfaces Te1/0/1']);
  ok(out.indexOf('Te1/0/1 (ethernet, 10G), MAC 0200.0000.0018') !== -1,
    'show interfaces Te1/0/1 answers about that cage, not the whole box',
    out.slice(0, 3).join(' / '));
  const gone = env.run(['show interfaces Gi1/0/25']);
  ok(gone.filter(function (l) { return /^% No interface Gi1\/0\/25 on /.test(l); }).length === 1 &&
    !gone.some(function (l) { return /\(ethernet/.test(l); }),
    'show interfaces Gi1/0/25 - the old name - is refused, and prints no port block', gone.join(' / '));
  ok(env.run(['show interfaces tengigabitethernet1/0/4']).indexOf(
    'Te1/0/4 (ethernet, 10G), MAC 0200.0000.001b') !== -1,
    'the long spelling TenGigabitEthernet1/0/4 reaches the fourth cage');
  const brief = env.run(['show ip interface brief']);
  // The brief table abbreviates a name that would fill its 23-character field:
  // `TenGigabitEthernet1/0/1` is exactly 23 (research/interface-brief-type-abbreviation.md).
  ok(brief.some(function (l) { return /^Te1\/0\/1\s/.test(l); }) &&
    !brief.some(function (l) { return /^GigabitEthernet1\/0\/25\s/.test(l); }),
    'show ip interface brief lists Te1/0/1 and no GigabitEthernet1/0/25');
  const rows = brief.filter(function (l) { return /\s(down|up|administratively down)\s+(down|up)\s*$/.test(l); });
  ok(rows.length === 28, 'and holds 28 rows - 24 copper, 4 optical', String(rows.length));
  const atIf = env.run(['configure terminal', 'interface Te1/0/1', 'description core uplink'])
    .filter(function (l) { return /description core uplink$/.test(l); })[0] || '';
  ok(atIf.indexOf('(config-if)#description core uplink') !== -1,
    'interface Te1/0/1 puts the next command in interface configuration on that port', atIf);
  const stale = env.run(['configure terminal', 'interface Gi1/0/25']).join(' / ');
  ok(/% Interface not found: Gi1\/0\/25/.test(stale) && !/\(config-if\)#/.test(stale),
    'and interface Gi1/0/25 is refused, leaving the session in global configuration', stale);
}

console.log('');
console.log('The neighbouring platforms keep their own rule - this is not a global renumbering:');
{
  const g = (cages(specFor('C1000-24FP-4G-L')) || []).map(function (c) { return c.name; });
  ok(g[0] === 'Gi1/0/25' && g[3] === 'Gi1/0/28', 'the 4G sibling still continues the group: Gi1/0/25..28', g.join(','));
  const env = lab(specFor('C1000-24FP-4G-L'));
  ok(env.run(['show interfaces Te1/0/1']).some(function (l) { return /^% No interface Te1\/0\/1 on /.test(l); }),
    'and a 4G model refuses Te1/0/1 - it has no 10G cage');
  const x = (cages(specFor('C2960X-24TS-L')) || []).map(function (c) { return c.name; });
  ok(x[0] === 'Gi1/0/25' && x[3] === 'Gi1/0/28',
    'a 2960-X still continues the downlink group too: Gi1/0/25..Gi1/0/28', x.join(','));
  const y = (cages(specFor('C9200L-24P-4X')) || []).map(function (c) { return c.name; });
  ok(y[0] === 'Te1/1/1' && y[3] === 'Te1/1/4',
    'a 9200L 10G cage is still module 1: Te1/1/1..Te1/1/4', y.join(','));
}

console.log('');
console.log('A link can be made on the corrected name:');
{
  const t = new Topology();
  t.addDevice(specFor('C1000-24FP-4X-L'), 'A');
  t.addDevice(specFor('C9200L-24P-4X'), 'B');
  t.connect('A', 'Te1/0/1', 'B', 'Te1/1/1');
  const st = t.getDevice('A').ifaceStatus('Te1/0/1', t);
  ok(st.status === 'up', 'the C1000 cage cables to a 9200L cage and reports itself up', st.status);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
