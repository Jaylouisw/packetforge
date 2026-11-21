'use strict';
// A Catalyst 1300's four SFP+ cages: `Gi1/0/25`, or `Te1/0/1`?
//
// The catalogue gave every C1300 four-10G model the downlink group continued - `Gi1/0/25`-`28` on a
// 24-port, `Gi1/0/49`-`52` on a 48-port, `Gi1/0/17`-`20` on the 16-port - on the strength of a datasheet
// that prints "28 Ethernet ports". A port count says nothing about how the CLI numbers the cages. Cisco's
// Catalyst 1300 CLI guide says it twice: the "Managing Ports Via CLI" section names the 10-gigabit ports
// `TenGigabitEthernetX/0/Y` with Y the *uplink* port number, 1-4, and the `show interfaces status` sample
// prints a `te1/0/1` row at `10G-Copper` beside `gi1/0/N` copper rows. So a 4X box's cages are
// `Te1/0/1`-`Te1/0/4` in module 0, restarting at 1 - the same rule the Catalyst 1000 -4X models follow
// (research/c1000-4x-uplink-naming.md), on a platform with its own document (research/c1300-4x-uplink-naming.md).
//
// The 1G siblings are untouched: a `-4G` or `-2G` model's SFP cages continue the downlink group
// (`Gi1/0/25`-`28`, `Gi1/0/17`-`18`, ...), which is what the same guide's Z range (1-48) describes for the
// gigabit interfaces. This test holds both halves so a later sweep cannot renumber the family wholesale.
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
// A cage is told apart by its connector, not by its name - the name is what is under test.
const CAGE_RE = /^(sfp|sfp\+|sfp28)$/;
function cages(spec) {
  return (spec.interfaces || []).filter(function (i) { return CAGE_RE.test(String(i.connector || '')); });
}
function copperCount(spec) {
  return ((spec.portTemplate && spec.portTemplate.count) || 0);
}

const c1300 = catalog.filter(function (s) { return /^C1300-/.test(s.model); });
const with4x = c1300.filter(function (s) { return /-4X$/.test(s.model); });
const with1g = c1300.filter(function (s) { return /-4G$|-2G$/.test(s.model); });

console.log('');
console.log('A 10G cage is named after the optic the model carries:');
{
  ok(c1300.length === 19, 'the catalogue holds 19 Catalyst 1300 specs', String(c1300.length));
  ok(with4x.length === 7, 'seven of them are -4X models with four 10G cages', String(with4x.length));
  const bad = [];
  for (const s of with4x) {
    const want = ['Te1/0/1', 'Te1/0/2', 'Te1/0/3', 'Te1/0/4'];
    const got = cages(s).map(function (c) { return c.name; });
    if (JSON.stringify(got) !== JSON.stringify(want)) bad.push(s.model + ': ' + got.join(','));
    else if (!cages(s).every(function (c) { return String(c.speed) === '10G' && String(c.connector) === 'sfp+'; })) {
      bad.push(s.model + ': cage media');
    }
  }
  ok(bad.length === 0, 'every -4X cage is Te1/0/1..Te1/0/4, SFP+ at 10G', bad.join(' | '));

  // The 16-port family restarts at 1 as well - it does not start at the copper group's 17.
  const sixteen = cages(specFor('C1300-16P-4X')).map(function (c) { return c.name; });
  ok(sixteen.join(',') === 'Te1/0/1,Te1/0/2,Te1/0/3,Te1/0/4',
    'C1300-16P-4X names its cages Te1/0/1..4, not Gi1/0/17..20', sixteen.join(','));
}

console.log('');
console.log('The rename moved four names; it did not add or drop a socket:');
{
  const s = specFor('C1300-24P-4X');
  const ns = names(s);
  ok(ns.length === copperCount(s) + 5, 'the 24-port 10G model holds 24 copper, 4 cages and a console',
    String(ns.length));
  ok(ns.indexOf('Gi1/0/1') !== -1 && ns.indexOf('Gi1/0/24') !== -1,
    'its copper downlinks are still Gi1/0/1..Gi1/0/24');
  ok(ns.indexOf('Gi1/0/25') === -1 && ns.indexOf('Gi1/0/28') === -1,
    'and the downlink group is not continued by four phantom copper ports');
  const cs = cages(s);
  ok(cs.every(function (c) { return (c.speedCaps || []).indexOf(1000) !== -1; }),
    'the cages still take a 1G module as well as a 10G one',
    JSON.stringify(cs.map(function (c) { return c.speedCaps; })));
}

console.log('');
console.log('The console answers about the cage by the name the vendor guide uses:');
{
  const env = lab(specFor('C1300-24P-4X'));
  const one = env.run(['show interfaces Te1/0/1']);
  ok(one.some(function (l) { return /^Te1\/0\/1 \(ethernet, 10G\), MAC /.test(l); }),
    'show interfaces Te1/0/1 answers about that cage, not the whole box', one.slice(0, 3).join(' / '));
  const long = env.run(['show interfaces tengigabitethernet1/0/4']);
  ok(long.some(function (l) { return /^Te1\/0\/4 \(ethernet, 10G\), MAC /.test(l); }),
    'the long spelling TenGigabitEthernet1/0/4 reaches the fourth cage', long.slice(0, 3).join(' / '));
  const gone = env.run(['show interfaces Gi1/0/25']);
  ok(gone.filter(function (l) { return /^% No interface Gi1\/0\/25 on /.test(l); }).length === 1 &&
    !gone.some(function (l) { return /\(ethernet/.test(l); }),
    'show interfaces Gi1/0/25 - the old name - is refused, and prints no port block', gone.join(' / '));
  const brief = env.run(['show ip interface brief']);
  // `TenGigabitEthernet1/0/1` is 23 characters, the field width, so the brief row abbreviates it
  // (research/interface-brief-type-abbreviation.md).
  ok(brief.some(function (l) { return /^Te1\/0\/1\s/.test(l); }) &&
    !brief.some(function (l) { return /^GigabitEthernet1\/0\/25\s/.test(l); }),
    'show ip interface brief lists Te1/0/1 and no GigabitEthernet1/0/25');
  const rows = brief.filter(function (l) { return /\s(down|up|administratively down)\s+(down|up)\s*$/.test(l); });
  ok(rows.length === 28, 'and holds 28 rows - 24 copper, 4 optical', String(rows.length));
  const atIf = env.run(['configure terminal', 'interface Te1/0/1', 'description core uplink']);
  ok(atIf.join('\n').indexOf('(config-if)#description core uplink') !== -1,
    'interface Te1/0/1 puts the next command in interface configuration on that port', atIf.slice(-2).join(' / '));
  const stale = env.run(['configure terminal', 'interface Gi1/0/25']).join(' / ');
  ok(/% Interface not found: Gi1\/0\/25/.test(stale) && !/\(config-if\)#/.test(stale),
    'and interface Gi1/0/25 is refused, leaving the session in global configuration', stale);
}

console.log('');
console.log('The gigabit siblings keep the continued numbering - this is not a family-wide renumbering:');
{
  const g = cages(specFor('C1300-24P-4G')).map(function (c) { return c.name; });
  ok(g.join(',') === 'Gi1/0/25,Gi1/0/26,Gi1/0/27,Gi1/0/28',
    'the -4G sibling still continues the group: Gi1/0/25..28', g.join(','));
  const g16 = cages(specFor('C1300-16P-2G')).map(function (c) { return c.name; });
  ok(g16.join(',') === 'Gi1/0/17,Gi1/0/18',
    'and a 16-port -2G continues it too: Gi1/0/17..18', g16.join(','));
  const env = lab(specFor('C1300-24P-4G'));
  ok(env.run(['show interfaces Te1/0/1']).some(function (l) { return /^% No interface Te1\/0\/1 on /.test(l); }),
    'a -4G model refuses Te1/0/1 - it has no 10G cage');
}

console.log('');
console.log('The neighbouring platforms keep their own rule:');
{
  const c1000 = cages(specFor('C1000-24FP-4X-L')).map(function (c) { return c.name; });
  ok(c1000[0] === 'Te1/0/1' && c1000[3] === 'Te1/0/4',
    'a Catalyst 1000 -4X is still Te1/0/1..4, module 0', c1000.join(','));
  const c9200 = cages(specFor('C9200L-24P-4X')).map(function (c) { return c.name; });
  ok(c9200[0] === 'Te1/1/1' && c9200[3] === 'Te1/1/4',
    'a 9200L 10G cage is still module 1: Te1/1/1..1/4', c9200.join(','));
}

console.log('');
console.log('A link can be made on the corrected name:');
{
  const t = new Topology();
  t.addDevice(specFor('C1300-24P-4X'), 'A');
  t.addDevice(specFor('C1300-24T-4X'), 'B');
  t.connect('A', 'Te1/0/1', 'B', 'Te1/0/4');
  const st = t.getDevice('A').ifaceStatus('Te1/0/1', t);
  ok(st.status === 'up', 'the cage cables to another C1300 cage and reports itself up', st.status);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
