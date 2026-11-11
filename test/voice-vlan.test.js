'use strict';
// The voice VLAN, end to end (#1368).
//
// `voiceVlan` has been in the port config shape since VLANs were modelled: `normalizePortConfig` keeps it,
// `validatePortConfig` insists it be a trunk ("voice traffic is tagged") and the switchport reset lists it when
// it clears. Nothing wrote it - there was no `switchport voice vlan` - and nothing read it: `classifyEgress` and
// `classifyIngress` only ever consulted the allowed list, so a phone on a port configured for voice landed in the
// data VLAN. It was also dropped by `serialize()`, so a saved lab came back with no voice VLANs at all.
//
// These checks cover the whole path: the command and its refusals, the classifier honouring it in both
// directions, the one sentence both surfaces print, the running-config, and the save.
const { loadCatalog } = require('../devices/registry');
const { Topology } = require('../engine/topology');
const { Simulator } = require('../engine/simulator');
const vlanLib = require('../engine/vlan');
const cliModule = require('../engine/cli');
const CliSession = cliModule.CliSession || cliModule;

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const ROOT = require('path').join(__dirname, '..');
const specs = loadCatalog(ROOT + '/devices').filter(function (s) { return !s.error; });
// A real access switch, not the first box that happens to bridge: the catalogue lists consumer routers first
// and a 'wan' port is no place to test a voice VLAN.
const SWITCH = specs.find(function (s) { return /^Catalyst2960$/.test(s.model); }) ||
  specs.find(function (s) { return /^C2960X-24TS-L$/.test(s.model); });
const HOST = specs.find(function (s) { return /Raspberry Pi 5/.test(s.model); });
let PORT = null;

function sw() {
  const t = new Topology();
  t.addDevice(SWITCH, 'sw1');
  t.addDevice(HOST, 'pc1');
  if (!PORT) PORT = Array.from(t.getDevice('sw1').interfaces.keys())[0];
  t.connect('sw1', PORT, 'pc1', 'eth0', { mediaId: '100base-tx', speedMbps: 100 });
  const s = new CliSession(t.getDevice('sw1'), t, new Simulator(t));
  const run = function (c) { return ((s.run(c) || {}).output || []).join('\n'); };
  ['enable', 'configure terminal', 'interface ' + PORT].forEach(run);
  return { t: t, dev: t.getDevice('sw1'), run: run, cfg: function (c) { return run(c); } };
}
function port(env) { return env.dev.interfaces.get(PORT); }

console.log('');
console.log('The command, and what it says:');
{
  const env = sw();
  const trunk = env.cfg('switchport mode trunk');
  ok(/trunk/i.test(trunk), 'the port is put in trunk mode', trunk.slice(0, 60));

  const set = env.cfg('switchport voice vlan 20');
  ok(/Voice VLAN 20 on/.test(set), 'setting a voice VLAN names it back', set.split('\n')[0]);
  ok(port(env).vlan.voiceVlan === 20, 'and stores it', String(port(env).vlan.voiceVlan));
  ok(!/stored/.test(set), 'a trunk in use says nothing about staging');

  const cleared = env.cfg('no switchport voice vlan');
  ok(/Voice VLAN 20 removed/.test(cleared), 'removing it names the value that was in force', cleared.split('\n')[0]);
  ok(port(env).vlan.voiceVlan === null, 'and clears it', String(port(env).vlan.voiceVlan));
  ok(/has no voice VLAN/.test(env.cfg('no switchport voice vlan')), 'removing it twice refuses');

  // The refusal quotes the word and still names the whole syntax, so the `|none` affordance is not lost by
  // giving a better answer (#1409).
  ok(/Invalid VLAN id "banana".*or "none"/.test(env.cfg('switchport voice vlan banana')),
    'a non-number is refused, quoting it and naming the alternative', env.cfg('switchport voice vlan banana'));
  const outOfRange = env.cfg('switchport voice vlan 5000');
  ok(/%/.test(outOfRange) && /4094|range|invalid/i.test(outOfRange), 'an out-of-range VLAN is refused',
    outOfRange.slice(0, 90));

  // One command changes one stored fact: setting the voice VLAN must not move the port into trunk mode.
  const access = sw();
  const staged = access.cfg('switchport voice vlan 20');
  ok(port(access).vlan.mode === 'access', 'setting it on an access port does not change the mode',
    String(port(access).vlan.mode));
  ok(port(access).vlan.voiceVlan === 20, 'the parameter is stored anyway', String(port(access).vlan.voiceVlan));
  ok(/stored/.test(staged) && /set "switchport mode trunk"/.test(staged),
    'and the console says it is stored, not in use', staged.split('\n')[0]);
}

console.log('');
console.log('The classifier carries the voice VLAN:');
{
  // A trunk that allows 10 and nothing else, with voice on 20.
  const cfg = { mode: 'trunk', nativeVlan: 10, allowedVlans: [10], voiceVlan: 20 };
  const voice = vlanLib.classifyEgress(cfg, 20);
  ok(voice.action === 'tagged', 'voice VLAN 20 leaves the trunk tagged', voice.action);
  ok(voice.voice === true, 'and is marked as voice', String(voice.voice));
  ok(vlanLib.classifyEgress(cfg, 30).action === 'drop', 'VLAN 30, allowed by neither, is still dropped');
  ok(vlanLib.classifyEgress(cfg, 10).action === 'untagged', 'the native VLAN is still untagged');

  const inVoice = vlanLib.classifyIngress(cfg, { tagged: true, vid: 20 });
  ok(inVoice.action === 'accept' && inVoice.vlanId === 20, 'a tagged voice frame arrives into VLAN 20',
    JSON.stringify(inVoice));
  ok(vlanLib.classifyIngress(cfg, { tagged: true, vid: 30 }).reason === 'vlan-not-allowed',
    'a tagged frame in a VLAN nobody named is still refused');

  // Without a voice VLAN the same trunk must behave exactly as before.
  const plain = { mode: 'trunk', nativeVlan: 10, allowedVlans: [10] };
  ok(vlanLib.classifyEgress(plain, 20).action === 'drop', 'with no voice VLAN, VLAN 20 is dropped as before');
  ok(vlanLib.classifyIngress(plain, { tagged: true, vid: 20 }).action === 'drop',
    'and refused on ingress as before');
}

console.log('');
console.log('One sentence, two surfaces:');
{
  const state = { mode: 'trunk', nativeVlan: 10, allowedVlans: [10], voiceVlan: 20 };
  const sentence = vlanLib.switchportSentence(state);
  ok(/voice 20/.test(sentence), 'the console sentence names the voice VLAN', sentence);
  const app = require('fs').readFileSync(ROOT + '/web/app.js', 'utf8');
  ok(/voiceVlan/.test(app) && /voiceText/.test(app), 'and the panel computes it from the same field');
  const accessState = { mode: 'access', accessVlan: 1, voiceVlan: 20 };
  ok(/trunk staged: voice 20 \(not in use\)/.test(vlanLib.switchportSentence(accessState)),
    'an access port reports it as staged', vlanLib.switchportSentence(accessState));
}

console.log('');
console.log('show running-config prints it, and a reload keeps it:');
{
  const env = sw();
  env.cfg('switchport mode trunk');
  env.cfg('switchport voice vlan 20');
  const rc = env.cfg('end') === '' ? '' : null;
  const running = ((env.run('show running-config') || ''));
  ok(/switchport voice vlan 20/.test(running), 'the line is printed', (running.match(/switchport voice vlan.*/) || [''])[0]);

  const doc = JSON.parse(JSON.stringify(env.t.serialize()));
  const portDoc = doc.devices[0].interfaces.filter(function (p) { return p.name === PORT; })[0];
  ok(portDoc.vlan.voiceVlan === 20, 'the saved document carries it', JSON.stringify(portDoc.vlan));

  const back = Topology.fromJSON(doc, specs);
  const restored = back.getDevice('sw1').interfaces.get(PORT);
  ok(restored.vlan.voiceVlan === 20, 'and the reloaded port has it back', String(restored.vlan.voiceVlan));
  ok(restored.vlan.mode === 'trunk', 'with the mode it was in', String(restored.vlan.mode));

  // A port with no voice VLAN must not grow the field.
  const clean = sw();
  const cleanDoc = JSON.parse(JSON.stringify(clean.t.serialize()));
  const cleanPort = cleanDoc.devices[0].interfaces.filter(function (p) { return p.name === PORT; })[0];
  ok(!('voiceVlan' in cleanPort.vlan), 'a port with no voice VLAN writes no such field',
    JSON.stringify(cleanPort.vlan));
}

console.log('');
console.log('A phone and a PC on one port:');
{
  // The data plane reads the classifier, so a voice-tagged frame must actually cross the trunk.
  const env = sw();
  env.cfg('switchport mode trunk');
  env.cfg('switchport trunk allowed vlan 10');
  env.cfg('switchport voice vlan 20');
  env.cfg('end');
  const cfg = port(env).vlan;
  const verdict = vlanLib.classifyEgress(cfg, 20);
  ok(verdict.action === 'tagged', 'the port in the lab carries VLAN 20 even though only 10 is allowed',
    verdict.action);
  ok(vlanLib.classifyEgress(cfg, 11).action === 'drop', 'and still drops VLAN 11');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
