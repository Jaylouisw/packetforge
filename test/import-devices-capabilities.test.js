'use strict';
// The importer must not be able to say a device is less capable than its datasheet (#1522).
//
// It used to keep its own copy of the capability vocabulary - 17 tokens against the engine's
// 15 - and the three it had never heard of (`vlan`, `lacp`, `stp`) were stripped out of every
// spec that declared them and filed under `role`. A switch declaring 802.1Q, LACP and STP
// imported as `[l2-forward, l3-forward, cli]` and the run called that a success. Three things
// have to hold or the same silence comes back:
//
//   1. The vocabulary is the engine's. Not an equal-looking copy: the engine's own list, so a
//      change there reaches this script without anyone remembering to edit a second copy.
//   2. A token the engine implements survives the import, and a datasheet fact the engine does
//      not implement - which is what `vlan`, `lacp` and `stp` became in #1526, the three it used
//      to eat - is kept and named rather than dropped.
//   3. A token the engine does not implement is named, with its model, rather than counted as
//      a "minor warning" and forgotten - and it is kept, because dropping it is data loss.
//
// Everything runs against throwaway PF_INCOMING/PF_DEVICES directories, so this test can never
// touch devices/ or research/incoming.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const engine = require('../engine');
const importer = require('../scripts/import-devices');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const SCRIPT = path.join(__dirname, '..', 'scripts', 'import-devices.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-caps-'));

// A one-file research batch in its own catalogue, so each case is measured from nothing.
function fixture(name, specs) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, 'incoming'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'devices'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'incoming', 'devices-' + name + '.json'), JSON.stringify(specs, null, 2));
  return dir;
}

function run(dir, args) {
  const env = Object.assign({}, process.env, {
    PF_INCOMING: path.join(dir, 'incoming'),
    PF_DEVICES: path.join(dir, 'devices')
  });
  const full = [SCRIPT].concat(args || []);
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, full, { encoding: 'utf8', env: env, stdio: ['ignore', 'pipe', 'pipe'] })
    };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || ''), err: String(e.stderr || '') };
  }
}

// What actually landed on disk, or null when the importer refused the spec.
function written(dir, vendor, model) {
  const p = path.join(dir, 'devices', vendor, model + '.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const PORTS = [
  { name: 'Gi0/1', type: 'ethernet', speed: '1G' },
  { name: 'Gi0/2', type: 'ethernet', speed: '1G' }
];

console.log('The importer does not own the capability vocabulary:');
{
  const ours = new Set(importer.CAPABILITIES);
  const theirs = new Set(engine.CAPABILITIES);
  const sameSize = ours.size === theirs.size;
  const sameMembers = Array.from(ours).every(function (c) { return theirs.has(c); }) &&
    Array.from(theirs).every(function (c) { return ours.has(c); });
  ok(sameSize && sameMembers, 'the importer accepts exactly the capabilities the engine lists',
    'importer [' + Array.from(ours).join(',') + '] engine [' + Array.from(theirs).join(',') + ']');
  // Set equality alone would still pass for a hand-maintained copy that happens to agree
  // today, which is the drift this issue is about, so the identity is asserted too.
  ok(importer.CAPABILITIES === engine.CAPABILITIES,
    'it is the engine\'s list object, not a second copy that agrees for now');
  ok(engine.CAPABILITIES.length > 0, 'and the engine does list something (' + engine.CAPABILITIES.length + ' tokens)');

  // An alias is a second way to name a capability, so it is a second way to drift.
  const aliases = importer.CAPABILITY_ALIASES;
  const strays = Object.keys(aliases).filter(function (k) { return theirs.has(aliases[k]) === false; });
  ok(strays.length === 0, 'every alias lands on a token the engine implements', strays.join(','));
  ok(importer.normaliseCapabilities(['wifi-ap','ipv4-host']).join(',') === 'wireless,host',
    'a researcher\'s word for it still maps onto the engine\'s word for it');
}

console.log('\nA switch that declares capabilities the engine honours keeps every one of them:');
{
  const declared = ['l2-forward', 'l3-forward', 'cli', 'poe-pse', 'dhcp-client'];
  const dir = fixture('stacked-switch', [{
    vendor: 'acme', model: 'SW-24G', label: 'Acme SW-24G', category: 'switch',
    description: '24-port managed gigabit switch with PoE and a DHCP client',
    capabilities: declared, interfaces: PORTS
  }]);
  const r = run(dir, ['--apply']);
  const spec = written(dir, 'acme', 'sw-24g');
  ok(r.code === 0, 'the import succeeds');
  ok(!!spec, 'the spec was written');
  const got = (spec && spec.capabilities) || [];
  const missing = declared.filter(function (c) { return got.indexOf(c) === -1; });
  ok(missing.length === 0, 'every declared capability is still in the file', missing.join(','));
  ok(got.length === declared.length, 'and nothing was added to it (' + got.length + ' of ' + declared.length + ')');
  ok(!spec || spec.role === undefined, 'no capability was moved into role');
  ok(!/warnings|REFUSED/.test(r.out), 'and the run does not report a capability problem');
}

console.log('\nA datasheet fact outside the vocabulary is kept and named, not stripped:');
{
  // `vlan`, `lacp` and `stp` were the three the importer's own smaller copy used to eat (#1522).
  // They are now descriptive tokens (#1526) - the same class as `802.3at` - so what has to hold
  // is that the declaration survives and is named on the way in, not that it is honoured.
  const declared = ['l2-forward', 'vlan', 'lacp', 'stp'];
  const dir = fixture('retired-tokens', [{
    vendor: 'acme', model: 'SW-48G', label: 'Acme SW-48G', category: 'switch',
    description: '48-port managed gigabit switch with 802.1Q, LACP and STP',
    capabilities: declared, interfaces: PORTS
  }]);
  const r = run(dir, ['--apply']);
  const spec = written(dir, 'acme', 'sw-48g');
  ok(r.code === 0, 'the import succeeds');
  const got = (spec && spec.capabilities) || [];
  const missing = declared.filter(function (c) { return got.indexOf(c) === -1; });
  ok(missing.length === 0, 'every declared token is still in the file, honoured or not', missing.join(','));
  ok(!spec || spec.role === undefined, 'none of them was moved into role');
  ok(['vlan', 'lacp', 'stp'].every(function (t) { return new RegExp(t).test(r.out); }),
    'and the run names all three as tokens the engine does not implement');
  ok(!/REFUSED/.test(r.out), 'without refusing the device');
}

console.log('\nA token the engine does not implement is named, not counted and forgotten:');
{
  // '802.3at' is a real, common power descriptor that this engine has no concept of. It is
  // the same class of token that used to disappear without a word.
  const declared = ['l2-forward', 'cli', 'poe-pse', '802.3at', 'flux-capacitor'];
  const dir = fixture('unknown-token', [{
    vendor: 'acme', model: 'POE-8', label: 'Acme PoE-8', category: 'switch',
    description: '8-port PoE switch', capabilities: declared, interfaces: PORTS
  }]);
  const r = run(dir, ['--apply']);
  const spec = written(dir, 'acme', 'poe-8');
  ok(r.code === 0, 'the spec still imports - an unknown label is not a reason to lose a device');
  ok(/802\.3at/.test(r.out), 'the output names the token');
  ok(/acme\/POE-8/.test(r.out), 'the output names the model it belongs to');
  ok(/flux-capacitor/.test(r.out), 'and names every unknown token, not just the first');
  ok(!/capability "poe-pse" is not one of/.test(r.out),
    'a token the engine does implement is not reported');
  const got = (spec && spec.capabilities) || [];
  const missing = declared.filter(function (c) { return got.indexOf(c) === -1; });
  ok(missing.length === 0, 'the unknown tokens are kept, exactly as declared', missing.join(','));
}

console.log('\nThe machine-readable report carries the same names:');
{
  // A separate batch, because a second import of the same model is a duplicate and a
  // duplicate is not re-reported - the warning belongs to the run that first saw it.
  const dir = fixture('unknown-token-json', [{
    vendor: 'acme', model: 'POE-8', label: 'Acme PoE-8', category: 'switch',
    description: '8-port PoE switch',
    capabilities: ['l2-forward', 'cli', 'poe-pse', '802.3at'], interfaces: PORTS
  }]);
  const asJson = run(dir, ['--json']);
  let report = null;
  try { report = JSON.parse(asJson.out); } catch (e) { /* asserted below */ }
  ok(!!report, '--json prints one parsable report');
  const named = (report && report.warnings && report.warnings[0]) || null;
  ok(!!named && named.model === 'POE-8', 'the report names the model');
  ok(!!named && named.warnings.some(function (w) { return /802\.3at/.test(w); }),
    'and carries the token in its warnings');
  ok(Array.isArray(report && report.losses) && report.losses.length === 0,
    'nothing was recorded as dropped');
}

console.log('\nNothing is allowed to leave the importer less capable than it arrived:');
{
  // The guard the write path runs. It is a pure function so it can be measured without
  // re-introducing the strip that used to make it necessary.
  ok(importer.capabilitiesLost(['vlan','lacp','stp'], ['vlan','lacp','stp']).length === 0,
    'an unchanged list loses nothing');
  ok(importer.capabilitiesLost(['vlan','lacp','stp'], ['l2-forward']).join(',') === 'vlan,lacp,stp',
    'a shrunken list names every token that went missing');
  ok(importer.capabilitiesLost([], ['cli']).length === 0, 'an empty declaration loses nothing');

  // And the validator: what it hands back as "declared" is what the source said, so the
  // write path has something honest to compare against.
  const spec = {
    vendor: 'acme', model: 'SW-8', category: 'switch', description: 'switch',
    capabilities: ['l2-forward', 'cli', 'poe-pse', 'poe-pd', '802.3at'], interfaces: PORTS
  };
  const v = importer.validateSpec(JSON.parse(JSON.stringify(spec)));
  ok(v.ok, 'a spec declaring an unknown power token validates');
  ok(v.declared.length === 5 && spec.capabilities.every(function (c) { return v.declared.indexOf(c) !== -1; }),
    'declared is all five tokens, unknown one included', v.declared.join(','));
  ok(v.described.join(',') === '802.3at', 'and only the token the engine lacks is marked as described');

  // A near-miss is still refused: it is a typo, not a description, and swallowing it would
  // cost the device the behaviour it meant to claim.
  const typo = importer.validateSpec({
    vendor: 'acme', model: 'SW-9', category: 'switch', description: 'switch',
    capabilities: ['l2-forward', 'l3-foward'], interfaces: PORTS
  });
  ok(!typo.ok, 'a near-miss of a real capability is still an error');
  ok(typo.errors.some(function (e) { return /looks like a typo of/.test(e); }), 'and says so by name');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
