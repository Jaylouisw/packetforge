#!/usr/bin/env node
/**
 * DOCSIS is asymmetric, and a port that declares only one direction ends up uncablable.
 *
 * A CMTS return-path port asks for its own rate. The coax cage used to offer only downstream
 * media, whose top rate is a gigabit or ten, so a 200 Mbps upstream port shared no rate with any
 * of them: the media list came out empty, the cable picker offered nothing, and the rate check
 * skipped the port with an early `continue` because a port with no medium has no rate to compare.
 * 84 ports were invisible that way across five CCAP chassis and one HFC node.
 */
'use strict';

const path = require('path');
const { Topology } = require('../engine');
const { loadCatalog } = require('../devices/registry');
const media = require('../engine/media');

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}
function t(name, fn) {
  console.log('\n' + name);
  if (typeof fn !== 'function') return;
  try { fn(); } catch (e) { failed++; console.log('  ✗ threw: ' + e.message); }
}

const specs = loadCatalog(path.join(__dirname, '..', 'devices'));
const byModel = {};
for (const s of specs) byModel[s.vendor + '/' + s.model] = s;

function devOf(key) {
  const spec = byModel[key];
  if (!spec) throw new Error('missing ' + key);
  return new Topology().addDevice(spec);
}

// ---------------------------------------------------------------------------
t('The two directions are separate media');

const ds30 = media.mediaById('docsis-30');
const us30 = media.mediaById('docsis-30-us');
const ds31 = media.mediaById('docsis-31');
const us31 = media.mediaById('docsis-31-us');

ok(!!us30 && us30.family === 'coax', 'DOCSIS 3.0 has an upstream medium');
ok(us30.speedMbps === 200, 'and its rate is the 200 Mbps return path, not the 1G downstream');
ok(!!us31 && us31.speedMbps === 1000, 'DOCSIS 3.1 upstream is 1 Gbps');
ok(ds30.speedMbps === 1000 && us30.speedMbps < ds30.speedMbps,
  'the asymmetry is real: 1G down, 200M up on the same F-connector');
ok(ds31.speedMbps === 10000 && us31.speedMbps < ds31.speedMbps, 'and 10G down, 1G up on 3.1');
ok(us30.direction === 'upstream' && ds30.direction === undefined,
  'the upstream medium says which direction it carries');

// ---------------------------------------------------------------------------
t('The coax cage offers both directions');

const offered = media.CAGE_MEDIA.coax();
ok(offered.indexOf('docsis-30-us') !== -1, 'the cage offers the upstream medium');
ok(offered.indexOf('docsis-30') !== -1, 'and the downstream one');
ok(media.CAGE_SPEEDS.coax(10000).indexOf(200) !== -1, 'and carries 200 Mbps as a rate of its own');

// ---------------------------------------------------------------------------
t('A return-path port can be cabled, and a forward-path port runs at plant rate');

const CASES = [
  ['cisco/cBR-8', 'us', 1000, 'DOCSIS 3.1 CCAP: return path is 1G'],
  ['commscope/E6000', 'us', 1000, 'DOCSIS 3.1 CCAP: return path is 1G'],
  ['casa/C3200', 'us', 200, 'DOCSIS 3.0 chassis: return path is 200M'],
  ['casa/C3200', 'ds', 1000, 'and its downstream is 1G, not the 100M it claimed'],
  ['commscope/OM6000', 'rtn', 200, 'HFC node return path is 200M'],
  ['harmonic/CableOS Reef RPS', 'us', 200, 'DOCSIS 3.0 return path is 200M']
];

for (const [key, prefix, rate, why] of CASES) {
  const dev = devOf(key);
  const ports = [...dev.interfaces.values()].filter(p => p.name.startsWith(prefix) &&
    (p.hardware.cage === 'coax' || p.hardware.cage === 'mcx'));
  ok(ports.length > 0, key + ': has ' + prefix + '* ports');
  const wrong = ports.filter(p => p.hardware.maxSpeedMbps !== rate);
  ok(wrong.length === 0, key + ': ' + why + (wrong.length ? ' (' + wrong[0].name + '=' + wrong[0].hardware.maxSpeedMbps + ')' : ''));
  const bare = ports.filter(p => !(p.hardware.media || []).length);
  ok(bare.length === 0, key + ': ' + prefix + '* ports have a medium to cable with');
}

// ---------------------------------------------------------------------------
t('MCX resolves to the coax cage rather than to nothing');

{
  const dev = devOf('commscope/E6000');
  const mcxSpec = (byModel['commscope/E6000'].interfaces || []).filter(i => i.connector === 'mcx');
  ok(mcxSpec.length > 0, 'the E6000 declares MCX connectors, as its datasheet does');
  const p = [...dev.interfaces.values()].find(x => x.name === mcxSpec[0].name);
  ok(p.hardware.cage === 'coax', 'an MCX port resolves to the coax cage (got ' + p.hardware.cage + ')');
  ok((p.hardware.media || []).length > 0, 'and can be cabled');
}

// ---------------------------------------------------------------------------
t('Coax links follow the same rules as everything else');

{
  const a = devOf('casa/C3200');
  const b = devOf('casa/C3200');
  const pa = [...a.interfaces.values()].find(p => p.name === 'us1');
  const pb = [...b.interfaces.values()].find(p => p.name === 'us2');
  const v = media.canMate(pa.hardware, pb.hardware);
  ok(v.ok === true, 'two return-path ports link');
  ok(v.speedMbps <= 200, 'at 200 Mbps, not the downstream rate');
}

{
  const cmts = devOf('cisco/cBR-8');
  const eth = media.derivePortHardware({ name: 'g0', type: 'ethernet' });
  const p = [...cmts.interfaces.values()].find(x => x.name === 'us1');
  const v = media.canMate(p.hardware, eth);
  ok(v.ok === false, 'a coax port refuses an Ethernet port');
  ok(v.code === 'E_CONNECTOR_MISMATCH' || v.code === 'E_PROTOCOL_MISMATCH',
    'with a reason rather than a crash (got ' + v.code + ')');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
