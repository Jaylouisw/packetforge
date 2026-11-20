'use strict';
// A stated range is the range the check applies (#1505).
//
// Every one of these handlers prints the range it accepts. The console's own word is the only specification an
// operator has, so the check behind it must be that range - no wider, and no narrower than the sentence the
// operator will read. #1495 fixed the half where a *word* became configuration (`channel-group flurbish`); this
// sweep asks the numeric half at four points per setting:
//
//   below the range  -> refused
//   the low edge     -> accepted
//   the high edge    -> accepted
//   above the range  -> refused
//
// and, because a refusal is where the range is quoted back, requires every refusal to *state* the range. A
// refusal that instead recommends a value the same check would reject is the same defect wearing a helpful face:
// `spanning-tree priority 61441` answered "the nearest valid values are 61440 and 65536", and 65536 is not a
// bridge priority at all. So any value a refusal offers as valid is probed too.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
function section(name) { console.log('\n' + name); }

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const spec = function (m) { return catalog.find(function (x) { return x.model === m; }); };

function makeEnv() {
  const t = new Topology();
  return { t: t, sw: t.addDevice(spec('Catalyst2960'), 'sw1'), r: t.addDevice(spec('ISR 4331'), 'r1') };
}
function ethPorts(dev) {
  return Array.from(dev.interfaces.values()).filter(function (p) { return p.type === 'ethernet'; })
    .map(function (p) { return p.name; });
}
function isPrompt(l) { return /^[A-Za-z0-9][A-Za-z0-9 ._\/-]*[>#]/.test(l); }

// One probe, on a device of its own: a bundle, a bridge priority or a VRRP group left behind by the previous
// probe would make "accepted" mean "accepted on top of whatever the last probe did".
function attempt(c, value) {
  const e = makeEnv();
  const dev = c.who === 'sw' ? e.sw : e.r;
  const setup = typeof c.setup === 'function' ? c.setup(e) : (c.setup || []);
  const cmds = ['enable', 'configure terminal'].concat(setup);
  if (c.exec) cmds.push('end');
  cmds.push(c.cmd(value));
  const lines = runCommands(dev, e.t, new Simulator(e.t), cmds).lines.filter(function (l) { return !isPrompt(l); });
  const refusal = lines.filter(function (l) { return (c.refusal || /^\s*%/).test(l); });
  return { lines: lines, refusal: refusal, refused: refusal.length > 0, dev: dev, e: e };
}

const ON_ROUTER_PORT = function (e) {
  return ['interface ' + ethPorts(e.r)[1], 'ip address 10.99.0.1 255.255.255.0'];
};

// probes is [below, low edge, high edge, above] - the four points at which a range can be wrong.
const CASES = [
  {
    name: 'vlan <id>', range: '1-4094', who: 'sw',
    cmd: function (v) { return 'vlan ' + v; },
    probes: [0, 1, 4094, 4095], states: /1-4094/
  },
  {
    name: 'channel-group <id>', range: '1-4096', who: 'sw',
    setup: function (e) { return ['interface ' + ethPorts(e.sw)[1]]; },
    cmd: function (v) { return 'channel-group ' + v + ' mode active'; },
    probes: [0, 1, 4096, 4097], states: /1-4096/
  },
  {
    name: 'vrrp <vrid>', range: '1-255', who: 'r',
    setup: ON_ROUTER_PORT,
    cmd: function (v) { return 'vrrp ' + v + ' ip 10.99.0.2'; },
    probes: [0, 1, 255, 256], states: /1-255/
  },
  {
    // IOS's parser answers `<1-254>  Priority level(default 100)` for this keyword: 255 belongs to the
    // address owner alone, so it is not a value an operator can type.
    name: 'vrrp <vrid> priority', range: '1-254', who: 'r',
    setup: function (e) { return ON_ROUTER_PORT(e).concat(['vrrp 7 ip 10.99.0.2']); },
    cmd: function (v) { return 'vrrp 7 priority ' + v; },
    probes: [0, 1, 254, 255], states: /1-254/
  },
  {
    name: 'spanning-tree priority', range: '0-61440 in steps of 4096', who: 'sw',
    cmd: function (v) { return 'spanning-tree priority ' + v; },
    probes: [-1, 0, 61440, 61441], states: /0(-| to )61440/
  },
  {
    name: 'ipv6 nd ra lifetime', range: '0-65535', who: 'r',
    setup: function (e) { return ['interface ' + ethPorts(e.r)[1]]; },
    cmd: function (v) { return 'ipv6 nd ra lifetime ' + v; },
    probes: [0, 65535, 65536], states: /0\.\.65535/, threePoint: true
  },
  {
    name: 'ip ospf cost', range: '1-65535', who: 'r',
    setup: function (e) { return ['ospf router-id 1.1.1.1', 'interface ' + ethPorts(e.r)[1]]; },
    cmd: function (v) { return 'ip ospf cost ' + v; },
    probes: [0, 1, 65535, 65536], states: /1\.\.65535/
  },
  {
    // 0 is a legal priority and means "never DR or BDR" (Cisco `ip ospf priority`), so the low
    // edge must be accepted - a range check written as `!v` would refuse the one value an operator
    // types deliberately.
    name: 'ip ospf priority', range: '0-255', who: 'r',
    setup: function (e) { return ['ospf router-id 1.1.1.1', 'interface ' + ethPorts(e.r)[1]]; },
    cmd: function (v) { return 'ip ospf priority ' + v; },
    probes: [-1, 0, 255, 256], states: /0\.\.255/
  },
  {
    name: 'ping <count>', range: '1-50', who: 'r', exec: true,
    setup: function (e) { return ['interface ' + ethPorts(e.r)[1], 'ip address 10.99.0.1 255.255.255.0']; },
    cmd: function (v) { return 'ping 10.99.0.1 ' + v; },
    // A ping that loses every echo also prints a line beginning with %, and that is a fact about the wire, not
    // a refusal of the count. Only the count's own refusal is the subject here.
    refusal: /Count must be a whole number/,
    probes: [0, 1, 50, 51], states: /1 to 50/
  }
];

const LABELS_4 = ['below the range', 'the low edge', 'the high edge', 'above the range'];
const WANT_4 = [true, false, false, true];
const LABELS_3 = ['the low edge', 'the high edge', 'above the range'];
const WANT_3 = [false, false, true];

for (const c of CASES) {
  section(c.name + ' (' + c.range + ')');
  const labels = c.threePoint ? LABELS_3 : LABELS_4;
  const want = c.threePoint ? WANT_3 : WANT_4;
  const results = c.probes.map(function (v) { return attempt(c, v); });

  results.forEach(function (res, i) {
    const v = c.probes[i];
    const why = res.refusal.length ? res.refusal[0].replace(/^\s*%\s*/, '')
      : (res.lines[res.lines.length - 1] || '');
    ok(res.refused === want[i],
      labels[i] + ': `' + c.cmd(v) + '` is ' + (want[i] ? 'refused' : 'accepted') +
      (res.refused === want[i] ? '' : ' - it said: ' + why));
  });

  // A refusal is where the operator reads the range back, so it has to be the range in force.
  results.forEach(function (res, i) {
    if (!res.refused) return;
    const said = res.refusal.join(' ');
    ok(c.states.test(said), 'the refusal of ' + c.probes[i] + ' states the range (' + c.range + ')',
      said.slice(0, 140));
  });

  // Anything a refusal offers as a valid value must itself be accepted - otherwise the correction it hands
  // back leads straight into a second refusal.
  results.forEach(function (res) {
    if (!res.refused) return;
    const m = /nearest valid values are (\d+) and (\d+)/.exec(res.refusal.join(' '));
    if (!m) return;
    [Number(m[1]), Number(m[2])].forEach(function (suggested) {
      const again = attempt(c, suggested);
      ok(!again.refused, 'a value a refusal suggested (' + suggested + ') is one the check accepts',
        again.refusal.join(' ').slice(0, 120));
    });
  });

  // A refused id must not leave the thing it would have created.
  if (c.name === 'channel-group <id>') {
    const above = results[3];
    const lags = above.dev.config.lags || {};
    ok(!lags['4097'], 'a refused bundle id leaves no entry in config.lags', JSON.stringify(Object.keys(lags)));
    const summary = runCommands(above.dev, above.e.t, new Simulator(above.e.t),
      ['enable', 'show etherchannel summary']).lines.join('\n');
    ok(summary.indexOf('4097') === -1, 'a refused bundle id does not appear in `show etherchannel summary`');
  }
}

// The edges are not merely "not refused": a bundle at each edge is a bundle that exists.
section('the edges still build what they say');
ok(!!(attempt(CASES[1], 1).dev.config.lags || {})['1'], 'channel-group 1 created group 1');
ok(!!(attempt(CASES[1], 4096).dev.config.lags || {})['4096'], 'channel-group 4096 created group 4096');


console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
