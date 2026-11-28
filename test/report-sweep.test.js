'use strict';
// Every report must answer in words a person can read (#1399).
//
// A sweep over the catalogue for one lens - "does this command ever print a value nobody computed?" - found
// `show spanning-tree` on 1,026 of 2,038 models printing:
//
//   Bridge priority 32768, root bridge undefined priority 32768
//
// Three defects behind one word:
//   * `runStp({ bridges: [] })` answered a root object with a priority and no identity, so a topology with no
//     bridges had a root. The root of nothing. It answers `null` now;
//   * a box that is not a bridge (a router) was asked who the root was, which implies it joined an election it
//     never joined. It answers with the box's own line now - `No spanning tree instance exists.` - and never
//     with a root;
//   * `String(rootRes.key)` printed the absence instead of naming it. The root is only named when it has one.
//
// The sweep is the test: every model, every basic report, no `undefined`, no `NaN`, no `[object`. Cheap, and it
// catches this whole class - a report that renders a hole - wherever it next appears.
const path = require('path');
const { CliSession } = require('../engine/cli');
const { Topology } = require('../engine/topology');
const { Simulator } = require('../engine/simulator');
const { loadCatalog } = require('../devices/registry');
const stpLib = require('../engine/stp');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const pick = function (re) { return catalog.filter(function (s) { return re.test(s.model); })[0]; };
const SWITCH = pick(/CX 6000 24G CL4/);
const ROUTER = pick(/^ISR 4331$/);
const HOST = pick(/^Raspberry Pi 5$/);

// What a report must never render. "Infinity" is deliberately absent: Ubiquiti ships an EdgeRouter Infinity, and
// a product's own name is not a defect. The instant leaking into prose is caught by the specific pattern below.
const SMELLS = ['undefined', 'NaN', '[object'];
function smells(text) {
  const out = [];
  for (const token of SMELLS) if (String(text).indexOf(token) >= 0) out.push(token);
  if (/t=Infinity ms|at Infinity ms|Infinity %/.test(String(text))) out.push('Infinity in prose');
  return out;
}

function report(spec, cmd) {
  const t = new Topology();
  t.addDevice(spec, 'd1');
  const sim = new Simulator(t);
  sim.setRunTime(0);                       // the state an operator sees first: powered on, nothing has happened
  const session = new CliSession(t.getDevice('d1'), t, sim);
  session.run('enable');
  return (session.run(cmd).output || []).join('\n');
}

console.log('No model renders a hole, at t=0 of a run that has just started');
{
  // Three reports over the whole catalogue, and the rest over every tenth model: the sweep is the point, and the
  // catalogue is 2,038 models.
  const always = ['show spanning-tree', 'show version', 'show running-config'];
  const sampled = ['show interfaces', 'show ip interface brief', 'show mac address-table', 'show power inline',
    'show lldp neighbors', 'show inventory'];
  const bad = [];
  let runs = 0;
  for (let i = 0; i < catalog.length; i++) {
    const spec = catalog[i];
    const cmds = always.concat(i % 10 === 0 ? sampled : []);
    for (const cmd of cmds) {
      let text = '';
      try { text = report(spec, cmd); } catch (e) { bad.push(spec.model + ' ' + cmd + ' threw: ' + e.message); continue; }
      runs++;
      const s = smells(text);
      if (s.length) bad.push(spec.model + ' | ' + cmd + ' | ' + s.join(',') + ' | ' + text.split('\n').slice(0, 2).join(' / '));
    }
  }
  ok(runs > 5000, 'the sweep ran every model against the whole-catalogue reports', String(runs));
  ok(bad.length === 0, 'and no report printed a value nobody computed',
    bad.slice(0, 4).join(' ;; '));
}

console.log('');
console.log('A topology with no bridges has no root');
{
  const res = stpLib.runStp({ bridges: [] });
  ok(res && res.root === null, 'runStp with no bridges answers null, not a root with no identity',
    JSON.stringify(res && res.root));
  ok(res && JSON.stringify(res.blocked) === '[]', 'and blocks nothing', JSON.stringify(res && res.blocked));

  const one = stpLib.runStp({ bridges: [{ key: 'b1', priority: 32768, mac: '00:00:00:00:00:01', ports: [] }] });
  ok(one.root && one.root.key === 'b1', 'with a bridge, the root is that bridge and it has a key',
    JSON.stringify(one.root));
}

console.log('');
console.log('A box that is not a bridge says so, and does not answer a question it was never asked');
{
  const out = report(ROUTER, 'show spanning-tree');
  ok(/No spanning tree instance exists\./.test(out), 'a router answers with the box\'s own sentence', out);
  ok(/not running on this device/.test(out) === false, 'and not with this console\'s explanation', out);
  ok(!/root bridge/.test(out), 'and no root is named for it', out);
  ok(!/election/.test(out), 'nor does it claim an election it could never join', out);
  ok(!/enabled protocol/.test(out), 'and it does not claim to be enabled', out);
}

console.log('');
console.log('A lone bridge is the root of its own tree');
{
  const t = new Topology();
  t.addDevice(SWITCH, 'sw1');
  const sim = new Simulator(t);
  sim.setRunTime(0);
  const out = (new CliSession(t.getDevice('sw1'), t, sim).run('show spanning-tree').output || []).join('\n');
  // A lone bridge *is* its own tree, and the election answers that: one bridge, one root, itself. The sentence the
  // console reserves for "nothing has been measured" therefore does not belong here - it belongs to a lab in which
  // no bridge exists at all, which is the router case above.
  ok(/This bridge is the root/.test(out), 'a lone bridge is named as the root of its own tree', out);
  // The vendor block names the root by bridge MAC, and a box is root exactly when the two addresses it prints -
  // the Root ID one and its own Bridge ID one - are the same. No hostname on that line: a Catalyst prints none
  // (research/show-spanning-tree-header-block.md).
  const lines = out.split(String.fromCharCode(10));
  const addrAfter = function (heading) {
    const at = lines.findIndex(function (l) { return l.trim().indexOf(heading) === 0; });
    if (at === -1) return null;
    const next = lines.slice(at + 1).filter(function (l) { return l.trim().indexOf('Address') === 0; })[0];
    return next ? next.trim().split(/ +/)[1] : null;
  };
  ok(!!addrAfter('Root ID') && addrAfter('Root ID') === addrAfter('Bridge ID'),
    'and the root it names is itself, by bridge MAC', String(addrAfter('Root ID')));
  ok(!/undefined/.test(out), 'with nothing undefined in it', out);
}

console.log('');
console.log('A root is named by something a person can act on');
{
  const t = new Topology();
  for (const n of ['s1', 's2', 's3']) t.addDevice(SWITCH, n);
  const L = { mediaId: '1000base-t', speedMbps: 1000 };
  t.connect('s1', '1/1/1', 's2', '1/1/1', L);
  t.connect('s2', '1/1/2', 's3', '1/1/2', L);
  t.connect('s3', '1/1/1', 's1', '1/1/2', L);
  const sim = new Simulator(t);
  sim.setRunTime(60000);
  sim.recomputeStp();
  const rootKey = sim.stpResult.root.key;
  ok(!!rootKey, 'the election picked a root with a key', JSON.stringify(sim.stpResult.root));

  const outLines = (new CliSession(t.getDevice(rootKey), t, sim).run('show spanning-tree').output || []);
  const out = outLines.join(String.fromCharCode(10));
  ok(/This bridge is the root/.test(out), 'the root knows it is the root', outLines.slice(4, 7).join(' / '));
  ok(/  Root ID    Priority    32769/.test(out), 'and its Root ID block carries its extended bridge priority',
    outLines[4]);

  // A hostname is deliberately *not* in this block: a Catalyst prints the bridge MAC on the Address line and no
  // name at all, and this view prints the vendor's lines rather than a friendlier one beside them.
  const rootDev = t.getDevice(rootKey);
  rootDev.config.hostname = 'core-a';
  const namedLines = (new CliSession(rootDev, t, sim).run('show spanning-tree').output || []);
  const named = namedLines.join(String.fromCharCode(10));
  ok(!/core-a/.test(named), 'and no hostname is printed where the vendor prints an address', namedLines[4]);

  // The switch that actually lost a port to the tree, so the report is read where it matters.
  const blockedOn = Array.from(t.devices.keys()).filter(function (id) {
    const d = t.getDevice(id);
    return d.stp && d.stp.blocked && d.stp.blocked.size > 0;
  })[0];
  ok(!!blockedOn, 'the tree blocked a port somewhere in the triangle', String(blockedOn));
  const otherLines = (new CliSession(t.getDevice(blockedOn), t, sim).run('show spanning-tree').output || []);
  const otherOut = otherLines.join(String.fromCharCode(10));
  ok(/This bridge is the root/.test(otherOut) === false, 'a non-root does not claim to be one', otherLines[4]);
  ok(/             Cost        [0-9]+/.test(otherOut), 'and pays a cost to reach the root, printed in the Root ID block',
    otherLines[4]);
  ok(/             Port        [0-9]+ [(][^)]+[)]/.test(otherOut), 'over a named port, as a box prints it',
    otherLines[5]);
  ok(/\bAltn\s+BLK\b/.test(otherOut), 'and the blocked port carries the cells a box prints: Altn BLK', otherOut);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
