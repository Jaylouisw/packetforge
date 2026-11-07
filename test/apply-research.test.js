'use strict';
// The research applier is the gate between an agent's datasheet reading and the
// catalogue, so its two silent failure modes matter more than its happy path:
//
//   1. It could not express "the last N ports of the template are optical", so
//      it refused SRX300, SRX345 and the VSP 4450 - the three devices whose port
//      splits were guesses for the longest. It now splits the template.
//   2. It counted interfaces rather than physical positions, so a combo cage
//      looked like two ports. Worse, when a combo device DID pass the count, the
//      typing loop walked the raw interface list and painted the copper half of
//      the combo optical. AR2220 lost its RJ45 face that way and every copper
//      link to it became physically impossible.
//
// Both run against a throwaway fixture catalogue via PF_DEVICES/PF_INCOMING.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-apply-'));
const devicesDir = path.join(tmp, 'devices');
const incomingDir = path.join(tmp, 'incoming');
fs.mkdirSync(path.join(devicesDir, 'acme'), { recursive: true });
fs.mkdirSync(path.join(devicesDir, 'combo'), { recursive: true });
fs.mkdirSync(incomingDir, { recursive: true });

// A templated switch: 24 ports generated, all copper by default.
fs.writeFileSync(path.join(devicesDir, 'acme', 'templated.json'), JSON.stringify({
  vendor: 'acme', model: 'TEMPLATED-24', label: 'Templated 24', category: 'switch',
  capabilities: ['l2-forward', 'cli'],
  portTemplate: { prefix: 'Gi0/1/', start: 1, count: 24, type: 'ethernet', speed: '1G' },
  interfaces: []
}, null, 2));

// A combo device: three physical positions, the third is RJ45/SFP.
fs.writeFileSync(path.join(devicesDir, 'combo', 'threeport.json'), JSON.stringify({
  vendor: 'combo', model: 'THREEPORT', label: 'Three port', category: 'router',
  capabilities: ['l3-forward', 'cli'],
  interfaces: [
    { name: 'Gi0/0/1', type: 'ethernet', speed: '1G' },
    { name: 'Gi0/0/2', type: 'ethernet', speed: '1G' },
    { name: 'Gi0/0/3', type: 'ethernet', speed: '1G', comboWith: 'Gi0/0/3-sfp', comboRole: 'rj45' },
    { name: 'Gi0/0/3-sfp', type: 'ethernet', speed: '1G', connector: 'sfp',
      speedCaps: [1000], comboWith: 'Gi0/0/3', comboRole: 'sfp' }
  ]
}, null, 2));

fs.writeFileSync(path.join(incomingDir, 'optics-fixture.json'), JSON.stringify({
  ports: [
    { vendor: 'acme', model: 'TEMPLATED-24', rj45Count: 20, sfpCount: 4, sfpType: 'sfp',
      sfpSpeedsMbps: [1000], sfpSharedWithRj45: false, sourceUrl: 'https://example.com/acme.pdf' },
    { vendor: 'combo', model: 'THREEPORT', rj45Count: 2, sfpCount: 1, sfpType: 'sfp',
      sfpSpeedsMbps: [1000], sfpSharedWithRj45: true, sourceUrl: 'https://example.com/combo.pdf' },
    { vendor: 'acme', model: 'DOES-NOT-EXIST', rj45Count: 4, sfpCount: 0, sfpType: 'sfp',
      sourceUrl: 'https://example.com/nope.pdf' }
  ]
}, null, 2));

const env = Object.assign({}, process.env, { PF_DEVICES: devicesDir, PF_INCOMING: incomingDir });
// The applier exits non-zero when any entry is rejected - that is the point of
// the gate - so its stdout has to be read off the thrown error as well.
let report = '';
try {
  report = execFileSync(process.execPath,
    [path.join(__dirname, '..', 'scripts', 'apply-research.js'),
      path.join(incomingDir, 'optics-fixture.json')],
    { env: env, encoding: 'utf8' });
} catch (e) {
  report = (e.stdout || '') + (e.stderr || '');
}

const switchSpec = JSON.parse(fs.readFileSync(path.join(devicesDir, 'acme', 'templated.json'), 'utf8'));
const comboSpec = JSON.parse(fs.readFileSync(path.join(devicesDir, 'combo', 'threeport.json'), 'utf8'));

console.log('A template can be split into copper then optical:');
{
  ok(/Applied 2/.test(report), 'both resolvable entries applied');
  ok(switchSpec.portTemplate && switchSpec.portTemplate.count === 20,
    'the template shrank to the 20 copper ports (' + (switchSpec.portTemplate || {}).count + ')');
  ok(switchSpec.interfaces.length === 4, 'the optical tail is 4 explicit interfaces');
  const names = switchSpec.interfaces.map(function (i) { return i.name; });
  ok(JSON.stringify(names) === JSON.stringify(['Gi0/1/21', 'Gi0/1/22', 'Gi0/1/23', 'Gi0/1/24']),
    'tail continues the template numbering (' + names.join(',') + ')');
  ok(switchSpec.interfaces.every(function (i) { return i.connector === 'sfp'; }),
    'and every tail port is an SFP cage');
}

console.log('\nA combo device keeps both of its faces:');
{
  const rj = comboSpec.interfaces.find(function (i) { return i.name === 'Gi0/0/3'; });
  const sfp = comboSpec.interfaces.find(function (i) { return i.name === 'Gi0/0/3-sfp'; });
  ok(rj && !rj.connector, 'the copper half is still copper (otherwise no copper link could mate)');
  ok(sfp && sfp.connector === 'sfp', 'the optical half is still a cage');
  ok(comboSpec.interfaces.length === 4, 'the combo is still two interfaces for one position');
}

console.log('\nUnverifiable entries are refused, not guessed:');
{
  ok(/REJECTED acme\/DOES-NOT-EXIST/.test(report), 'a model with no spec is rejected');
  ok(/rejected 1/.test(report), 'and the run reports it');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
