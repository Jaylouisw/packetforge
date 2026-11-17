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
  // A trunk is the one place the parameter does nothing, so that is the one place the console has to say so.
  ok(/stored/.test(set) && /no effect/.test(set) && /access mode/.test(set),
    'a trunk says the parameter has no effect there', set.split(String.fromCharCode(10))[0]);

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
  const live = access.cfg('switchport voice vlan 20');
  ok(port(access).vlan.mode === 'access', 'setting it on an access port does not change the mode',
    String(port(access).vlan.mode));
  ok(port(access).vlan.voiceVlan === 20, 'the parameter is stored', String(port(access).vlan.voiceVlan));
  ok(!/stored/.test(live),
    'and an access port takes it into use at once, with no note about another mode',
    live.split(String.fromCharCode(10))[0]);
}

console.log('');
console.log('The classifier carries the voice VLAN:');
{
  // The voice VLAN is live on an access port: untagged data in VLAN 10, tagged voice in VLAN 20.
  const accessCfg = { mode: 'access', accessVlan: 10, voiceVlan: 20 };
  const voice = vlanLib.classifyEgress(accessCfg, 20);
  ok(voice.action === 'tagged', 'voice VLAN 20 leaves an access port tagged', voice.action);
  ok(voice.voice === true, 'and is marked as voice', String(voice.voice));
  ok(vlanLib.classifyEgress(accessCfg, 10).action === 'untagged', 'the access VLAN is still untagged');
  ok(vlanLib.classifyEgress(accessCfg, 30).action === 'drop', 'a third VLAN is still dropped');

  const inVoice = vlanLib.classifyIngress(accessCfg, { tagged: true, vid: 20 });
  ok(inVoice.action === 'accept' && inVoice.vlanId === 20, 'a tagged voice frame arrives into VLAN 20',
    JSON.stringify(inVoice));
  ok(vlanLib.classifyIngress(accessCfg, { tagged: true, vid: 30 }).reason === 'tagged-frame-on-access',
    'a tagged frame in any other VLAN is still refused by an access port');

  // On a trunk the parameter is stored and not consulted: the allowed list decides, in both directions.
  const trunkCfg = { mode: 'trunk', nativeVlan: 10, allowedVlans: [10], voiceVlan: 20 };
  ok(vlanLib.classifyEgress(trunkCfg, 20).action === 'drop',
    'a trunk whose allowed list omits the voice VLAN does not carry it');
  ok(vlanLib.classifyIngress(trunkCfg, { tagged: true, vid: 20 }).reason === 'vlan-not-allowed',
    'and refuses it on ingress for the same reason');
  const trunkCarries = { mode: 'trunk', nativeVlan: 10, allowedVlans: [10, 20], voiceVlan: 20 };
  ok(vlanLib.classifyEgress(trunkCarries, 20).action === 'tagged',
    'when the allowed list names it, the trunk carries it as an ordinary VLAN');

  // Without a voice VLAN an access port behaves exactly as before.
  const plain = { mode: 'access', accessVlan: 10 };
  ok(vlanLib.classifyEgress(plain, 20).action === 'drop', 'with no voice VLAN, VLAN 20 is dropped as before');
  ok(vlanLib.classifyIngress(plain, { tagged: true, vid: 20 }).action === 'drop',
    'and refused on ingress as before');
}

console.log('');
console.log('One sentence, two surfaces:');
{
  const accessState = { mode: 'access', accessVlan: 10, voiceVlan: 20 };
  const sentence = vlanLib.switchportSentence(accessState);
  ok(/access VLAN 10 . voice 20 \(tagged\)/.test(sentence), 'the console sentence names both VLANs', sentence);
  const app = require('fs').readFileSync(ROOT + '/web/app.js', 'utf8');
  ok(/voiceVlan/.test(app), 'and the panel computes it from the same field');
  const trunkState = { mode: 'trunk', nativeVlan: 10, allowedVlans: [10], voiceVlan: 20 };
  ok(vlanLib.switchportSentence(trunkState).indexOf('no effect on a trunk') !== -1,
    'a trunk says the parameter has no effect there', vlanLib.switchportSentence(trunkState));
  ok(vlanLib.switchportSentence({ mode: 'access', accessVlan: 1 }).indexOf('voice') === -1,
    'a port with no voice VLAN says nothing about one');
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
  // The data plane reads the classifier, so the phone VLAN and the PC VLAN both have to work from one port.
  const env = sw();
  env.cfg('switchport access vlan 10');
  env.cfg('switchport voice vlan 20');
  env.cfg('end');
  const cfg = port(env).vlan;
  ok(cfg.mode === 'access', 'the port is still an access port', String(cfg.mode));
  ok(vlanLib.classifyEgress(cfg, 20).action === 'tagged', 'a frame for VLAN 20 leaves it tagged',
    String(cfg.voiceVlan));
  ok(vlanLib.classifyIngress(cfg, { tagged: true, vid: 20 }).action === 'accept',
    'and a voice frame arriving on it lands in VLAN 20');
  ok(vlanLib.classifyIngress(cfg, { tagged: false, vid: null }).vlanId === 10,
    'while the PC behind the phone stays in VLAN 10');
  ok(vlanLib.classifyEgress(cfg, 11).action === 'drop', 'and still drops VLAN 11');
}

console.log('');
console.log('');
console.log('show vlan lists the port in both VLANs:');
{
  // The observable an operator checks: a voice port is a member of the data VLAN and of the voice VLAN, and the
  // vendor table prints it in both rows. This table listed it in the data VLAN only, because the voice VLAN was
  // treated as a stored parameter that was not in use.
  const env = sw();
  env.cfg('exit');
  env.cfg('vlan 20');
  env.cfg('end');
  env.cfg('configure terminal');
  env.cfg('interface ' + PORT);
  env.cfg('switchport access vlan 10');
  env.cfg('switchport voice vlan 20');
  env.cfg('end');
  const rows = env.run('show vlan brief').split(String.fromCharCode(10));
  const row = function (id) {
    return rows.filter(function (l) { return new RegExp('^' + id + '\\s').test(l); })[0] || '';
  };
  ok(row(10).indexOf(PORT) !== -1, 'VLAN 10 lists the port', row(10));
  ok(row(20).indexOf(PORT) !== -1, 'VLAN 20 lists it too', row(20));
}

console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
