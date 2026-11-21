'use strict';
// The fixed uplinks on a Catalyst 9200L are module 1, and their numbers restart at 1.
//
// Every one of the fourteen C9200L specs in the catalogue continued the downlink group instead: a 24-port
// 4X model declared its four SFP+ cages as `Te1/0/25`-`Te1/0/28`, and a 48-port 4G model its four SFP cages
// as `Gi1/0/49`-`Gi1/0/52`. That is how a Catalyst 2960-X really numbers its uplinks (`Gi1/0/25`-`Gi1/0/28`,
// which the catalogue still says, and which is right), so the continuation looks plausible and is wrong on
// the 9200 family. Cisco's 9200 interface guide states the rule, and a real C9200L-24P-4G names its cages
// `Gi1/1/1` and `Gi1/1/2` in `show inventory`:
//
//   "On a device with SFP uplink ports, the module number is 1 and the port numbers restart. For example, if
//    the device has 24 10/100/1000 ports, the SFP module ports are GigabitEthernet1/1/1 through
//    GigabitEthernet1/1/4 or TenGigabitEthernet1/1/1 through TenGigabitEthernet1/1/4."
//   - Cisco Catalyst 9200 Interface and Hardware Components Configuration Guide, "Interface Types"
//
// The visible consequence of the old numbering was a switch that claimed 52 numbered downlink positions and
// had four of them on optical cages: `show ip interface brief` said `Gi1/0/25` about a fibre port, and
// `interface Te1/1/1` - the name the operator reads off Cisco's own guide - was refused as a port that does
// not exist. research/catalyst-9200l-uplink-port-numbers.md records the evidence and the open question.
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
function lab(spec) {
  const t = new Topology();
  const d = t.addDevice(spec, 'SW');
  const sim = new Simulator(t);
  return { t: t, d: d, sim: sim,
    run: function (lines) { return runCommands(d, t, sim, lines).lines; } };
}
function names(spec) {
  const t = new Topology();
  t.addDevice(spec, 'SW');
  return Array.from(t.getDevice('SW').interfaces.keys());
}
// The optical cages are told apart by connector, not by name: the name is the thing under test.
const UPLINK_RE = /^(sfp|sfp\+|sfp28)$/;
function uplinks(spec) {
  return (spec.interfaces || []).filter(function (i) { return UPLINK_RE.test(String(i.connector || '')); });
}

console.log('');
console.log('Every C9200L uplink lives in module 1, numbered from 1:');
{
  const ls = catalog.filter(function (s) { return /^C9200L-/.test(s.model); });
  ok(ls.length === 14, 'the catalogue holds 14 C9200L specs', String(ls.length));
  const bad = [];
  for (const s of ls) {
    const up = uplinks(s);
    const want = up.map(function (_, i) { return i + 1; });
    const got = up.map(function (i) { return Number(String(i.name).split('/').pop()); });
    const mods = up.map(function (i) { return String(i.name).split('/').slice(0, 2).join('/'); });
    const wrongModule = mods.filter(function (m) { return !/^(Gi|Te|Twe)1\/1$/.test(m); });
    if (up.length !== 4 && up.length !== 2) bad.push(s.model + ': ' + up.length + ' uplinks');
    else if (wrongModule.length) bad.push(s.model + ': ' + up.map(function (i) { return i.name; }).join(','));
    else if (JSON.stringify(got) !== JSON.stringify(want)) bad.push(s.model + ': ' + got.join(','));
  }
  ok(bad.length === 0, "every model's optical cages are <type>1/1/1..n, with no gaps", bad.join(' | '));

  // The rename moved four names; it did not add or drop a socket.
  const counts = {};
  for (const s of ls) counts[s.model] = names(s).length;
  ok(counts['C9200L-24P-4X'] === 28 && counts['C9200L-48P-4G'] === 52 &&
    counts['C9200L-24PXG-2Y'] === 26 && counts['C9200L-48PXG-2Y'] === 50,
    'the 24-port models still hold 28 ports, the 48-port models 52, the 2Y models 26 and 50',
    JSON.stringify(counts));
  ok(names(specFor('C9200L-48P-4G')).indexOf('Gi1/0/49') === -1,
    'a 48-port 9200L has no Gi1/0/49: its 48 downlinks end at Gi1/0/48');
}

console.log('');
console.log('The type word follows the optic the model carries:');
{
  const rows = {
    'C9200L-24P-4G': ['Gi1/1/1', 'Gi1/1/4'],
    'C9200L-48P-4X': ['Te1/1/1', 'Te1/1/4'],
    'C9200L-24PXG-2Y': ['Twe1/1/1', 'Twe1/1/2']
  };
  for (const model of Object.keys(rows)) {
    const up = uplinks(specFor(model)).map(function (i) { return i.name; });
    ok(up[0] === rows[model][0] && up[up.length - 1] === rows[model][1],
      model + ' names its uplinks ' + rows[model][0] + '..' + rows[model][1], up.join(','));
  }
}

console.log('');
console.log('The neighbouring platforms keep their own rule - this is not a global renumbering:');
{
  const x = uplinks(specFor('C2960X-24TS-L')).map(function (i) { return i.name; });
  ok(x[0] === 'Gi1/0/25' && x[3] === 'Gi1/0/28',
    'a 2960-X still continues the downlink group: Gi1/0/25..Gi1/0/28', x.join(','));
  const y = names(specFor('C9300-24T')).filter(function (n) { return /^Gi1\/1\//.test(n); });
  ok(y.length === 8, "a 9300 switch's network-module ports are still module 1", y.join(','));
}

console.log('');
console.log('The console answers about the port by the name the vendor guide uses:');
{
  const env = lab(specFor('C9200L-24P-4X'));
  const out = env.run(['show interfaces Te1/1/1']);
  ok(out.some(function (l) { return /^Te1\/1\/1 \(ethernet, 10G\)/.test(l); }),
    'show interfaces Te1/1/1 answers about that cage, not the whole box',
    out.slice(0, 3).join(' / '));
  const gone = env.run(['show interfaces Te1/0/25']);
  const refused = gone.filter(function (l) { return /^% No interface Te1\/0\/25 on /.test(l); });
  ok(refused.length === 1 && !gone.some(function (l) { return /\(ethernet/.test(l); }),
    'show interfaces Te1/0/25 - the old name - is refused, and prints no port block',
    gone.join(' / '));
  const brief = env.run(['show ip interface brief']);
  // A live 9200 prints `Te1/1/1` in this table while its running-config says
  // `interface TenGigabitEthernet1/1/1`: the 23-character name fills the Interface field, so the type
  // word is abbreviated here (research/interface-brief-type-abbreviation.md).
  ok(brief.some(function (l) { return /^Te1\/1\/1\s/.test(l); }) &&
    !brief.some(function (l) { return /^TenGigabitEthernet1\/0\/25\s/.test(l); }),
    'show ip interface brief lists Te1/1/1 and no TenGigabitEthernet1/0/25');
  const rows = brief.filter(function (l) { return /\s(down|up|administratively down)\s+(down|up)\s*$/.test(l); });
  ok(rows.length === 28, 'and holds 28 rows - 24 copper, 4 optical', String(rows.length));
  const entered = env.run(['configure terminal', 'interface Te1/1/1', 'description core uplink']);
  const atIf = entered.filter(function (l) { return /description core uplink$/.test(l); })[0] || '';
  ok(atIf.indexOf('(config-if)#description core uplink') !== -1,
    'interface Te1/1/1 puts the next command in interface configuration on that port', atIf);
}
{
  // A 4G model carries 1G cages, so the short spelling is Gi, and Te names nothing there.
  const env = lab(specFor('C9200L-24P-4G'));
  ok(env.run(['show interfaces Gi1/1/1']).some(function (l) { return /^Gi1\/1\/1 \(ethernet, 1G\)/.test(l); }),
    'a 4G model answers on Gi1/1/1');
  ok(env.run(['show interfaces Te1/1/1']).some(function (l) { return /^% No interface Te1\/1\/1 on /.test(l); }),
    'and refuses TenGigabitEthernet1/1/1 - it has no 10G cage');
}

console.log('');
console.log('A link can be made on the corrected name:');
{
  const t = new Topology();
  t.addDevice(specFor('C9200L-24P-4G'), 'A');
  t.addDevice(specFor('C2960X-24TS-L'), 'B');
  t.connect('A', 'Gi1/1/1', 'B', 'Gi1/0/25');
  const st = t.getDevice('A').ifaceStatus('Gi1/1/1', t);
  ok(st.status === 'up', 'the 9200L uplink cables to a 2960-X uplink and reports itself up', st.status);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
