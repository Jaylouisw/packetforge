'use strict';
// Six Palo Alto specs generated their data ports from a portTemplate that said only
// `type: ethernet, speed: 1G` - no connector, no ladder - so the cage was inferred from the
// port name (issue #1398). Three of them also carried explicit interfaces whose connector was
// either silent or wrong: the PA-3220's MGT and HA1-A/HA1-B ports were declared 10G SFP+ and
// the PA-820's MGT and HA ports were declared SFP, on hardware where all of them are RJ-45.
//
// The vendor's own front-panel tables give the jack and the ladder for every row:
//
//   PA-220 HIG: "Eight RJ-45 10/100/1000Mbps ports for network traffic"; MGT "10/100/1000Mbps".
//   PA-400 HIG (PA-440/450, identical front panels): "Eight RJ-45 10/100/1000Mbps ports";
//     management "Ethernet 1Gbps port".
//   PA-800 HIG: 1/1-1/4 "RJ-45 (10Mbps/100Mbps/1Gbps)", 1/5-1/12 "SFP (1Gbps)";
//     "HA1 HA2 RJ-45 (10Mbps/100Mbps/1Gbps)"; MGT RJ-45 (10/100/1000).
//   PA-3200 HIG: "Twelve RJ-45 10Mbps/100Mbps/1Gbps ports"; PA-3220 "Ports 13 through 16 are SFP
//     (1Gbps) and ports 17 through 20 are SFP or SFP+ (10Gbps)"; HA1-A/B and MGT "RJ-45".
//   PA-1400 HIG: PA-1420 "Ports 1 through 4 - 10Mbps/100Mbps/1Gbps"; "Ports 5 through 12 -
//     10Mbps/100Mbps/1Gbps/2.5Gbps/5Gbps" (9-12 PoE); "Ports 13 and 14 - 1Gbps"; "Ports 15
//     through 22 - 1Gbps/10Gbps"; HSCI "One SFP+ (10Gbps) port (supports both SFP and SFP+
//     transceivers)"; HA1-A/B and MGT RJ-45.
//
// research/paloalto-firewall-copper-ports.md carries the sources and what is left open.
const path = require('path');
const { Topology } = require('../engine');
const media = require('../engine/media');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  OK ' + msg); }
  else { failed++; console.error('  FAIL ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
function section(name) { console.log('\n' + name); }

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
function spec(model) {
  const s = catalog.filter(function (x) { return x.vendor === 'paloalto' && x.model === model; })[0];
  if (!s) throw new Error('missing spec ' + model);
  return s;
}
function dev(model) {
  const t = new Topology();
  return t.addDevice(spec(model), 'FW');
}

// [model, prefix, count, speedCaps]
const ACCESS = [
  ['PA-220', 'ethernet1/', 8, [10, 100, 1000]],
  ['PA-440', 'ethernet1/', 8, [10, 100, 1000]],
  ['PA-450', 'ethernet1/', 8, [10, 100, 1000]],
  ['PA-820', 'ethernet1/', 4, [10, 100, 1000]],
  ['PA-3220', 'ethernet1/', 12, [10, 100, 1000]],
  ['PA-1420', 'ethernet1/', 4, [10, 100, 1000]]
];

section('The template declares the jack and the ladder, not just a rate');
for (const row of ACCESS) {
  const model = row[0];
  const tpl = spec(model).portTemplate || {};
  ok(tpl.connector === 'rj45', model + ': portTemplate declares connector rj45',
    'connector=' + String(tpl.connector));
  ok(JSON.stringify(tpl.speedCaps) === JSON.stringify(row[3]),
    model + ': portTemplate declares speedCaps ' + JSON.stringify(row[3]),
    JSON.stringify(tpl.speedCaps));
  ok(tpl.count === row[2] && tpl.prefix === row[1], model + ': the same ' + row[2] + ' ports, same names',
    tpl.prefix + tpl.start + ' x' + tpl.count);
}

section('Every generated port resolves to an RJ-45 cage with that ladder');
for (const row of ACCESS) {
  const model = row[0], prefix = row[1], count = row[2];
  const fw = dev(model);
  const first = fw.interfaces.get(prefix + 1);
  const last = fw.interfaces.get(prefix + count);
  ok(first && first.cage === 'rj45', model + ': ' + prefix + '1 is an RJ-45 cage', first && first.cage);
  ok(last && last.cage === 'rj45', model + ': ' + prefix + count + ' exists and is RJ-45', last && last.cage);
  ok(JSON.stringify(first && first.hardware.speedCaps) === JSON.stringify(row[3]),
    model + ': ' + prefix + '1 trains at ' + JSON.stringify(row[3]),
    JSON.stringify(first && first.hardware.speedCaps));
}

section('The management port is copper on all six');
for (const row of ACCESS) {
  const model = row[0];
  const name = model === 'PA-1420' ? 'management' : 'mgmt';
  const p = dev(model).interfaces.get(name);
  ok(p && p.cage === 'rj45', model + ': ' + name + ' is an RJ-45 cage', p && p.cage);
  ok(JSON.stringify(p && p.hardware.speedCaps) === JSON.stringify([10, 100, 1000]),
    model + ': ' + name + ' trains at 10/100/1000', JSON.stringify(p && p.hardware.speedCaps));
}

section('PA-3220: 1/13-1/16 are 1G SFP, 1/17-1/20 are SFP+, HA1 is copper');
{
  const fw = dev('PA-3220');
  for (const n of ['ethernet1/13', 'ethernet1/14', 'ethernet1/15', 'ethernet1/16']) {
    const p = fw.interfaces.get(n);
    ok(p.cage === 'sfp', 'PA-3220: ' + n + ' is an SFP cage', p.cage);
    ok(JSON.stringify(p.hardware.speedCaps) === JSON.stringify([1000]),
      'PA-3220: ' + n + ' trains at 1G only', JSON.stringify(p.hardware.speedCaps));
  }
  for (const n of ['ethernet1/17', 'ethernet1/20']) {
    const p = fw.interfaces.get(n);
    ok(p.cage === 'sfp+', 'PA-3220: ' + n + ' is an SFP+ cage', p.cage);
    ok(JSON.stringify(p.hardware.speedCaps) === JSON.stringify([1000, 10000]),
      'PA-3220: ' + n + ' trains at 1/10G', JSON.stringify(p.hardware.speedCaps));
  }
  for (const n of ['ha1-a', 'ha1-b']) {
    const p = fw.interfaces.get(n);
    ok(p.cage === 'rj45', 'PA-3220: ' + n + ' is copper, not SFP+', p.cage);
    ok(JSON.stringify(p.hardware.speedCaps) === JSON.stringify([10, 100, 1000]),
      'PA-3220: ' + n + ' trains at 10/100/1000', JSON.stringify(p.hardware.speedCaps));
  }
  ok(fw.interfaces.get('ha2').cage === 'sfp+', 'PA-3220: ha2 (HSCI) stays an SFP+ cage',
    fw.interfaces.get('ha2').cage);
  const fibreIntoCopper = media.canMate(fw.interfaces.get('ethernet1/13').hardware,
    fw.interfaces.get('mgmt').hardware);
  ok(fibreIntoCopper.ok === false && fibreIntoCopper.code === 'E_CONNECTOR_MISMATCH',
    'PA-3220: an SFP uplink will not cable into the MGT RJ-45',
    fibreIntoCopper.code + ': ' + fibreIntoCopper.message);
}

section('PA-820: 1/5-1/12 are SFP, MGT and HA are copper');
{
  const fw = dev('PA-820');
  for (const n of ['ethernet1/5', 'ethernet1/7', 'ethernet1/8', 'ethernet1/12']) {
    const p = fw.interfaces.get(n);
    ok(p.cage === 'sfp', 'PA-820: ' + n + ' is an SFP cage', p.cage);
    ok(JSON.stringify(p.hardware.speedCaps) === JSON.stringify([1000]),
      'PA-820: ' + n + ' trains at 1G', JSON.stringify(p.hardware.speedCaps));
  }
  for (const n of ['ha1', 'ha2']) {
    ok(fw.interfaces.get(n).cage === 'rj45', 'PA-820: ' + n + ' is copper, not SFP', fw.interfaces.get(n).cage);
  }
}

section('PA-1420: the copper block is 10/100 and goes up to 5G; SFP is 1G; HSCI is SFP+');
{
  const fw = dev('PA-1420');
  for (const n of ['ethernet1/5', 'ethernet1/8', 'ethernet1/9', 'ethernet1/12']) {
    const p = fw.interfaces.get(n);
    ok(p.cage === 'rj45', 'PA-1420: ' + n + ' is an RJ-45 cage', p.cage);
    ok(JSON.stringify(p.hardware.speedCaps) === JSON.stringify([10, 100, 1000, 2500, 5000]),
      'PA-1420: ' + n + ' trains at 10M-5G (hardware reference, not the datasheet shorthand)',
      JSON.stringify(p.hardware.speedCaps));
  }
  for (const n of ['ethernet1/13', 'ethernet1/14']) {
    const p = fw.interfaces.get(n);
    ok(p.cage === 'sfp', 'PA-1420: ' + n + ' is an SFP cage', p.cage);
    ok(JSON.stringify(p.hardware.speedCaps) === JSON.stringify([1000]),
      'PA-1420: ' + n + ' trains at 1G', JSON.stringify(p.hardware.speedCaps));
  }
  const h = fw.interfaces.get('hsci');
  ok(h.cage === 'sfp+', 'PA-1420: HSCI is an SFP+ cage', h.cage);
  ok(JSON.stringify(h.hardware.speedCaps) === JSON.stringify([1000, 10000]),
    'PA-1420: HSCI takes SFP or SFP+ (1G/10G)', JSON.stringify(h.hardware.speedCaps));
}

section('Behaviour: copper meets copper at the slower side; fibre into copper is refused');
{
  const r = media.canMate(dev('PA-1420').interfaces.get('ethernet1/1').hardware,
    dev('PA-220').interfaces.get('ethernet1/1').hardware);
  ok(r.ok === true && r.speedMbps === 1000, 'PA-1420 port 1 to PA-220 meets at 1G',
    r.code + ' ' + r.speedMbps);

  const fibre = dev('PA-1420').interfaces.get('ethernet1/13').hardware;
  const b = dev('PA-3220');
  const bad = media.canMate(fibre, b.interfaces.get('ha1-a').hardware);
  ok(bad.ok === false && bad.code === 'E_CONNECTOR_MISMATCH',
    'an SFP transceiver will not cable into PA-3220 ha1-a', bad.code + ': ' + bad.message);

  const r2 = media.canMate(dev('PA-1420').interfaces.get('ethernet1/8').hardware,
    dev('PA-440').interfaces.get('ethernet1/1').hardware);
  ok(r2.ok === true && r2.speedMbps === 1000, 'the 5G port meets a 1G port at 1G',
    r2.code + ' ' + r2.speedMbps);

  const r3 = media.canMate(dev('PA-220').interfaces.get('ethernet1/1').hardware,
    dev('PA-3220').interfaces.get('ethernet1/12').hardware);
  ok(r3.ok === true && r3.speedMbps === 1000, 'PA-220 to PA-3220 meets at 1G',
    r3.code + ' ' + r3.speedMbps);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
