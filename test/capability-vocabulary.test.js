'use strict';
// Every token in `CAPABILITIES` has to name a behaviour something actually reads (#1526).
//
// `engine/device.js` documented `vlan`, `lacp` and `stp` as capabilities - "supports 802.1Q",
// "supports link aggregation", "participates in spanning tree" - and no code branched on any of
// them. VLANs, LAGs and spanning tree run on every `l2-forward` box whether or not it claims the
// token, so `hasCap('vlan')` answered `false` for the 1,900 switches that forward VLAN-tagged
// frames and `true` for 125 that behaved identically, and the answer taught every caller that the
// token meant something. A capability census found the same from the data side.
//
// The test is the guard the issue asks for, in two directions:
//
//   1. Every advertised token must have a reader in `engine/` - a `hasCap()`, a
//      `_capabilityRefusal()`, an `.indexOf()`/`.includes()` on a capability list, or a
//      `SERVICE_PORTS` key. Three tokens are still declared without a reader and are listed
//      below as waiting on their own decision (`firewall`, `wireless`, `dhcp-client`), so wiring
//      or dropping one of those is a deliberate edit to this list rather than a silent decay.
//   2. Every token any spec declares must be either advertised (the engine honours it) or named
//      as a descriptive fact. A token that is neither is a typo the catalogue would otherwise
//      carry invisibly.
//
// Why the three were retired rather than wired: 125 specs declare them and 1,143 declare
// `l2-forward` without them, so gating VLANs, LAGs or STP on the token would switch the feature
// off for almost the whole catalogue. The datasheet facts stay in the specs - the importer keeps
// and names a token outside the vocabulary rather than dropping it (#1522) - but they are no
// longer advertised as engine behaviour.
const fs = require('fs');
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CAPABILITIES } = require('../engine/device');
const flow = require('../engine/flow');
const cliModule = require('../engine/cli');
const CliSession = cliModule.CliSession || cliModule;

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const ROOT = path.join(__dirname, '..');
const RETIRED = ['vlan', 'lacp', 'stp'];
// Documented as behaviour, read by nothing, and still waiting on a per-token decision (#1526).
// Listed here so the guard cannot quietly grow a fourth.
const PENDING = ['dhcp-client', 'firewall', 'wireless'];
// Real hardware facts with no behaviour behind them. They are kept in a spec exactly as the
// datasheet declared them, and the importer names them on the way in.
const DESCRIPTIVE = ['802.3af', '802.3at', '802.3bt', 'passive-poe', 'poe-injector', 'wifi-ap']
  .concat(RETIRED);

const ENGINE_DIR = path.join(ROOT, 'engine');
const ENGINE_SOURCES = fs.readdirSync(ENGINE_DIR)
  .filter(function (f) { return f.endsWith('.js'); })
  .map(function (f) { return { file: 'engine/' + f, src: fs.readFileSync(path.join(ENGINE_DIR, f), 'utf8') }; });

// A reader is a call site that passes the token as a quoted literal, or a `SERVICE_PORTS` entry -
// an object key is the only form in which `engine/flow.js` consults a capability. The calls are
// matched with their quote characters so the vocabulary's own declaration (a bare `'token',`
// line in `engine/device.js`) cannot satisfy the check for itself.
function hasReader(token) {
  const forms = [
    "hasCap('" + token + "')", 'hasCap("' + token + '")',
    "_capabilityRefusal('" + token + "'", '_capabilityRefusal("' + token + '"',
    ".indexOf('" + token + "')", '.indexOf("' + token + '")',
    ".includes('" + token + "')", '.includes("' + token + '")'
  ];
  if (ENGINE_SOURCES.some(function (s) { return forms.some(function (p) { return s.src.includes(p); }); })) return true;
  return Object.prototype.hasOwnProperty.call(flow.SERVICE_PORTS, token);
}

function specs(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push.apply(out, specs(p));
    else if (name.endsWith('.json')) out.push({ file: path.relative(ROOT, p), json: JSON.parse(fs.readFileSync(p, 'utf8')) });
  }
  return out;
}

console.log('A capability that no code reads is not a capability:');
{
  for (const token of RETIRED) {
    ok(CAPABILITIES.indexOf(token) === -1, '`' + token + '` is not advertised in CAPABILITIES',
      'CAPABILITIES still lists it');
  }
  const unread = CAPABILITIES.filter(function (t) { return !hasReader(t); });
  ok(unread.length === 0 || unread.every(function (t) { return PENDING.indexOf(t) !== -1; }),
    'every advertised capability has a reader in engine/ (or is a documented pending decision)',
    'unread: ' + unread.join(','));
  ok(unread.slice().sort().join(',') === PENDING.slice().sort().join(','),
    'and the only unread tokens are the three this test names as pending (' + PENDING.join(', ') + ')',
    'actually unread: ' + (unread.join(',') || 'none'));
  ok(DESCRIPTIVE.every(function (t) { return CAPABILITIES.indexOf(t) === -1; }),
    'no descriptive hardware token is advertised as behaviour',
    DESCRIPTIVE.filter(function (t) { return CAPABILITIES.indexOf(t) !== -1; }).join(','));
}

console.log('\nThe catalogue declares only tokens that are honoured or named as facts:');
{
  const catalogue = specs(path.join(ROOT, 'devices'));
  const declared = new Set();
  for (const spec of catalogue) {
    for (const c of (spec.json.capabilities || [])) declared.add(c);
  }
  const strays = Array.from(declared).filter(function (c) {
    return CAPABILITIES.indexOf(c) === -1 && DESCRIPTIVE.indexOf(c) === -1;
  });
  ok(strays.length === 0,
    'all ' + declared.size + ' tokens declared across ' + catalogue.length + ' specs are either honoured or named as facts',
    strays.join(','));
  const declaredRetired = catalogue.filter(function (spec) {
    return (spec.json.capabilities || []).some(function (c) { return RETIRED.indexOf(c) !== -1; });
  });
  ok(declaredRetired.length > 0,
    'the datasheet facts survive in the specs that declare them (' + declaredRetired.length + ' specs)');
}

console.log('\nRemoving the three changes nothing a box does:');
{
  // A switch whose datasheet says 802.1Q, LACP and STP, and one that stays silent about all
  // three. Both forward tagged frames, both bundle, both run the tree - that is the whole point
  // of the retirement, so it is asserted rather than assumed.
  function build(caps) {
    const t = new Topology();
    t.addDevice({
      vendor: 'Acme', model: 'SW-24G', label: 'Acme SW-24G', category: 'switch',
      capabilities: caps,
      interfaces: [
        { name: 'Gi0/1', type: 'ethernet', speed: '1G' },
        { name: 'Gi0/2', type: 'ethernet', speed: '1G' }
      ]
    }, 'd1');
    const sim = new Simulator(t);
    const dev = t.getDevice('d1');
    return { t: t, sim: sim, dev: dev, cli: new CliSession(dev, t, sim) };
  }
  const claimed = build(['l2-forward', 'cli'].concat(RETIRED));
  const plain = build(['l2-forward', 'cli']);

  ok(claimed.dev.capabilities.join(',') === 'l2-forward,cli,vlan,lacp,stp',
    'a spec that declares the retired tokens keeps them verbatim',
    claimed.dev.capabilities.join(','));
  // `hasCap()` reads the *device's* declared list, so a spec that still says "802.1Q" still answers
  // true - a descriptive token is kept, not honoured (#1522). What the retirement removes is the
  // engine's claim that the token means behaviour; the identical console output below is the proof
  // that it never did.
  ok(RETIRED.every(function (t) { return claimed.dev.hasCap(t) === true; }) &&
    RETIRED.every(function (t) { return plain.dev.hasCap(t) === false; }),
    'a declared token is still visible to hasCap() on the spec that declares it, and absent on one that does not',
    RETIRED.map(function (t) { return t + '=' + claimed.dev.hasCap(t) + '/' + plain.dev.hasCap(t); }).join(','));

  function trunk(s) {
    const out = [];
    for (const cmd of ['enable', 'configure terminal', 'interface Gi0/1', 'switchport mode trunk', 'end']) {
      const r = s.cli.run(cmd);
      out.push.apply(out, (r && r.output) || []);
    }
    return out.join('\n');
  }
  const a = trunk(claimed);
  const b = trunk(plain);
  ok(/Switchport mode trunk on Gi0\/1/.test(a), 'a trunk is accepted on the box that declares the token', a);
  ok(/Switchport mode trunk on Gi0\/1/.test(b), 'and on the identical box that declares none of them', b);
  ok(a === b, 'with the same console output either way', a + ' != ' + b);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
