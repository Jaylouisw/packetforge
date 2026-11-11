'use strict';
// One tally, two places it is printed (#1417).
//
// The per-port counters exist twice: the engine keeps them in `topo.flowState` (which `fullState()` publishes as
// `runtime[id].counters.ports`, the shape any table or sparkline reads) and `show interfaces` prints them one block
// per port. Every other pair of surfaces in this codebase that reimplemented one rule has drifted - port state
// (#1238), PoE (#1293), the routes table (#1301), the switchport sentence (#1291) - and each time the drift was
// invisible until somebody compared them. Two implementations of one arithmetic is the same hazard, and counters had
// no guard at all: `web/app.js` does not read them yet, so an agreement bug here would be found by a future consumer
// rather than by us.
//
// The rule this file pins, in both directions:
//
//   * every port the console prints has a payload row whose numbers are the console's numbers;
//   * a port the payload counts is a port the console prints;
//   * every drop reason the console names appears in `drops.byReason` with the same count, and vice versa - a
//     counter that invented a reason, or a reason that was counted nowhere, would show up as a mismatch;
//   * a port that has counted nothing is either absent from the payload or zero, never absent from the console.
//
// It runs against the engine directly, so it is deterministic and fast, and it covers the four ways a frame can fail
// to arrive: nothing plugged in, a shut port, an empty table (broadcast), and a policy refusal.
const path = require('path');
const { Topology, Simulator, CliSession, runCommands, flow } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const ROOT = path.join(__dirname, '..');
const catalog = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
const spec = function (model) { return catalog.find(function (s) { return s.model === model; }); };
const SW = spec('EKI-5728I');
const R = spec('ICR-3231');

// "no route to 10.0.0.9 x2, \"ACL 101 denied (in)\" x2" -> { 'no route to 10.0.0.9': 2, 'ACL 101 denied (in)': 2 }
//
// A reason is prose, so a split on ", " only works if a reason that brings its own punctuation is quoted. That is the
// rule the console now follows, and this parser is the proof it holds: if a reason were ever emitted unquoted with a
// comma or a bracket in it, this would mis-parse and the comparison below would report the disagreement.
function parseDropSummary(text) {
  const out = {};
  let buf = '';
  let quoted = false;
  const parts = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') { quoted = !quoted; buf += ch; continue; }
    if (!quoted && ch === ',' && text[i + 1] === ' ') { parts.push(buf); buf = ''; i++; continue; }
    buf += ch;
  }
  if (buf) parts.push(buf);
  for (const part of parts) {
    const m = /^\s*(?:"([^"]+)"|(.+?))(?: x(\d+))?\s*$/.exec(part);
    if (!m) continue;
    const why = m[1] !== undefined ? m[1] : m[2];
    out[why] = Number(m[3] || 1);
  }
  return out;
}

// `show interfaces` prints one block per port: "1 (ethernet, 1G), MAC ..", then
// "  5 packets input, 285 bytes" and "  3 drops (no cable x2)". Parsed here the way an operator reads it.
function parseShowInterfaces(lines) {
  const ports = {};
  let cur = null;
  for (const raw of lines) {
    const line = String(raw);
    // A port name is the whole rest of the line, and it may have a space in it - `Port 1`, `SFP+ 1`, `LAN IN`
    // (#1401). So the name is everything before the bracketed type, anchored on the `, MAC` that follows it.
    const head = /^(.+?) \((?:ethernet|fibre|coax|console|wireless|virtual|virtual-switch)[^)]*\), MAC /.exec(line);
    if (head) { cur = head[1]; ports[cur] = { in: 0, out: 0, drops: 0, reasons: {} }; continue; }
    if (!cur) continue;
    const rx = /(\d+) packets input/.exec(line);
    const tx = /(\d+) packets output/.exec(line);
    if (rx) ports[cur].in = Number(rx[1]);
    if (tx) ports[cur].out = Number(tx[1]);
    const dr = /(\d+) drops?(?: \((.*)\))?$/.exec(line.trim());
    if (dr && !/packets/.test(line)) {
      ports[cur].drops = Number(dr[1]);
      if (dr[2]) ports[cur].reasons = parseDropSummary(dr[2]);
    }
  }
  return ports;
}
function show(session, cmd) {
  return (session.run(cmd).output || []).map(String);
}

// A switch with a router on port A and a host on port B - enough to make a frame cross two ports and to make one of
// them fail on purpose.
function lab(opts) {
  opts = opts || {};
  const topo = new Topology();
  const sw = topo.addDevice(SW, 'sw1');
  const r1 = topo.addDevice(R, 'r1');
  const h1 = topo.addDevice(R, 'h1');
  const eth = function (d) {
    return Array.from(d.interfaces.values()).filter(function (i) { return i.type === 'ethernet'; });
  };
  const sp = eth(sw), rp = eth(r1), hp = eth(h1);
  topo.connect(sw.id, sp[0].name, r1.id, rp[0].name, {});
  topo.connect(sw.id, sp[1].name, h1.id, hp[0].name, {});
  // Configured the way an operator configures it - through the console - so the model's own validation and
  // defaulting run, instead of the test writing fields in a shape the engine does not use.
  // `topo.flowState` is created lazily by the server (`flowStateFor`), so the lab has to make it the same way - the
  // counters live in it, and a Simulator given `undefined` quietly starts a second, private accounting.
  if (!topo.flowState) topo.flowState = flow.createFlowState();
  const sim = new Simulator(topo, { flowState: topo.flowState });
  runCommands(sw, topo, sim, ['configure terminal', 'interface ' + sp[0].name, 'switchport mode access',
    'switchport access vlan 1', 'exit', 'interface ' + sp[1].name, 'switchport mode access',
    'switchport access vlan 1', 'end']);
  runCommands(r1, topo, sim, ['configure terminal', 'interface ' + rp[0].name,
    'ip address 10.60.0.1 255.255.255.0', 'end']);
  runCommands(h1, topo, sim, ['configure terminal', 'interface ' + hp[0].name,
    'ip address 10.60.0.2 255.255.255.0', 'end']);
  return { topo: topo, sw: sw, r1: r1, h1: h1, sp: sp, rp: rp, hp: hp, sim: sim };
}
function session(env, dev) {
  return new CliSession(dev, env.topo, new Simulator(env.topo, { flowState: env.topo.flowState }));
}
// The payload's view: exactly what `fullState()` publishes for this device.
function payloadCounters(env, dev) {
  return flow.counterSnapshot(env.topo.flowState, dev.id);
}

// Compare the two, port by port and reason by reason. Returns a list of sentences describing every disagreement.
function disagreements(env, dev) {
  const payload = payloadCounters(env, dev);
  const consolePorts = parseShowInterfaces(show(session(env, dev), 'show interfaces'));
  const out = [];
  for (const name of Object.keys(consolePorts)) {
    const c = consolePorts[name];
    const p = (payload.ports || {})[name] || { packetsIn: 0, packetsOut: 0, drops: { total: 0, byReason: {} } };
    if (Number(p.packetsIn || 0) !== c.in) out.push(name + ': console says ' + c.in + ' in, payload says ' + p.packetsIn);
    if (Number(p.packetsOut || 0) !== c.out) out.push(name + ': console says ' + c.out + ' out, payload says ' + p.packetsOut);
    const pd = (p.drops && p.drops.total) || 0;
    if (pd !== c.drops) out.push(name + ': console says ' + c.drops + ' drops, payload says ' + pd);
    const byReason = (p.drops && p.drops.byReason) || {};
    for (const why of Object.keys(c.reasons)) {
      if (byReason[why] === undefined) out.push(name + ': console names "' + why + '" but the payload does not');
      else if (Number(byReason[why]) !== c.reasons[why]) {
        out.push(name + ': "' + why + '" is x' + c.reasons[why] + ' on the console and x' + byReason[why] + ' in the payload');
      }
    }
    for (const why of Object.keys(byReason)) {
      const shown = Object.keys(c.reasons).some(function (k) { return why === k || why.indexOf(k) === 0 || k.indexOf(why) === 0; });
      if (!shown) out.push(name + ': the payload counted "' + why + '" which the console never printed');
    }
  }
  for (const name of Object.keys(payload.ports || {})) {
    const p = payload.ports[name];
    if (consolePorts[name] === undefined && (p.packetsIn || p.packetsOut || (p.drops && p.drops.total))) {
      out.push(name + ': the payload counts this port but the console does not print it');
    }
  }
  return { problems: out, payload: payload, consolePorts: consolePorts };
}

// --- a clean crossing ---------------------------------------------------------------------------------------------
console.log('A frame that crosses two ports is counted the same way twice:');
{
  const env = lab();
  const sim = env.sim;
  const result = sim.ping(env.r1.id, '10.60.0.2', { count: 3 });
  const replies = result.replies || [];
  ok(replies.filter(function (r) { return r.success; }).length === 3, 'three pings answered',
    JSON.stringify(replies.map(function (r) { return r.reason; })));
  const check = disagreements(env, env.sw);
  ok(check.problems.length === 0, 'every port agrees', check.problems.join(' ; '));
  ok(check.payload.ports[env.sp[0].name].packetsIn > 0, 'the ingress port counted something',
    JSON.stringify(check.payload.ports[env.sp[0].name]));
  ok(check.payload.ports[env.sp[1].name].packetsOut > 0, 'and the egress port counted the way out',
    JSON.stringify(check.payload.ports[env.sp[1].name]));
  ok(check.consolePorts[env.sp[0].name].in === check.payload.ports[env.sp[0].name].packetsIn,
    'the two numbers are the same number, not just both non-zero');
  // A port the console prints with nothing on it is absent from the payload, and `counted` says so.
  ok(check.consolePorts[env.sp[2].name] !== undefined, 'a spare port is still printed by the console');
  ok(check.payload.ports[env.sp[2].name] === undefined, 'and is simply absent from the payload');
  ok(check.payload.counted === true, 'while `counted` says the device has carried something', String(check.payload.counted));
}

// --- broadcast: an empty table means flooding, not forwarding ------------------------------------------------
console.log('');
console.log('A frame that has to be flooded is counted on every port it leaves:');
{
  const env = lab();
  const sim = env.sim;
  // Only the switch has learned nothing yet, so the first frame is flooded.
  sim.ping(env.r1.id, '10.60.0.2', { count: 1 });
  const check = disagreements(env, env.sw);
  ok(check.problems.length === 0, 'flood and the direct crossing agree', check.problems.join(' ; '));
  const outPorts = Object.keys(check.payload.ports).filter(function (k) { return check.payload.ports[k].packetsOut > 0; });
  ok(outPorts.length >= 2, 'the flooded frame left more than one port', JSON.stringify(outPorts));
}

// --- a policy refusing the frame --------------------------------------------------------------------------------
console.log('');
console.log('A frame a policy refuses is counted as a drop, with the reason the console prints:');
{
  const env = lab();
  env.sw.config.acls = {
    101: [
      { sequence: null, acl: 101, kind: 'extended', action: 'deny', protocol: 'ip',
        source: { ip: '10.60.0.0', wildcard: '0.0.0.255', any: false, host: false },
        destination: { ip: '0.0.0.0', wildcard: '255.255.255.255', any: true, host: false }, port: null, log: false },
      { sequence: null, acl: 101, kind: 'extended', action: 'permit', protocol: 'ip',
        source: { ip: '0.0.0.0', wildcard: '255.255.255.255', any: true, host: false },
        destination: { ip: '0.0.0.0', wildcard: '255.255.255.255', any: true, host: false }, port: null, log: false }
    ]
  };
  env.sw.aclBindings = {};
  env.sw.aclBindings[env.sp[1].name] = { in: 101 };
  const sim = env.sim;
  sim.ping(env.h1.id, '10.60.0.1', { count: 1 });
  const check = disagreements(env, env.sw);
  ok(check.problems.length === 0, 'the refusal is counted the same way twice', check.problems.join(' ; '));
  const drops = (check.payload.ports[env.sp[1].name] || {}).drops || {};
  ok((drops.total || 0) > 0, 'the ingress port of the refused frame counted a drop', JSON.stringify(drops));
  ok(Object.keys(drops.byReason || {}).length > 0, 'and the payload names a reason', JSON.stringify(drops.byReason));
  ok(Object.keys(check.consolePorts[env.sp[1].name].reasons).length > 0, 'which the console prints too',
    JSON.stringify(check.consolePorts[env.sp[1].name].reasons));
}

// --- a port that cannot carry anything --------------------------------------------------------------------------
console.log('');
console.log('A shut port counts nothing, and says so on both sides:');
{
  const env = lab();
  env.sp[1].enabled = false;
  const sim = env.sim;
  sim.ping(env.r1.id, '10.60.0.2', { count: 2 });
  const check = disagreements(env, env.sw);
  ok(check.problems.length === 0, 'a shut port agrees on zero', check.problems.join(' ; '));
  ok(check.consolePorts[env.sp[1].name].out === 0, 'the shut port sent nothing',
    String(check.consolePorts[env.sp[1].name].out));
  ok((check.payload.ports[env.sp[1].name] === undefined) ||
     (check.payload.ports[env.sp[1].name].packetsOut === 0), 'and the payload agrees it sent nothing');
}

// --- a reset zeroes both views, not one ------------------------------------------------------------------------
console.log('');
console.log('A reset clears the console and the payload together:');
{
  const env = lab();
  const sim = env.sim;
  sim.ping(env.r1.id, '10.60.0.2', { count: 2 });
  const before = payloadCounters(env, env.sw);
  ok(Object.keys(before.ports || {}).length > 0, 'something was counted before the reset',
    JSON.stringify(Object.keys(before.ports || {})));
  flow.resetFlowState(env.topo.flowState);
  const after = payloadCounters(env, env.sw);
  ok(Object.keys(after.ports || {}).length === 0, 'the payload counts nothing after it',
    JSON.stringify(after.ports));
  const check = disagreements(env, env.sw);
  ok(check.problems.length === 0, 'and the console agrees with that', check.problems.join(' ; '));
  ok(Object.keys(check.consolePorts).every(function (k) {
    return check.consolePorts[k].in === 0 && check.consolePorts[k].out === 0;
  }), 'every port reads zero on the console', JSON.stringify(check.consolePorts));
}

// --- the summary is machine-readable ----------------------------------------------------------------------
console.log('');
console.log('A drop summary can be read back into the reasons it names:');
{
  const env = lab();
  // Two causes on one port: a policy refusal, whose reason brings its own brackets, against frames for a
  // neighbour that is not there. Printed as one bracketed list, the reason's own brackets closed the list early
  // - `2 drops (ACL 101 denied (in) x2)` - so a reader (or a script) could not tell where the reason ended.
  env.sw.config.acls = {
    101: [
      { sequence: null, acl: 101, kind: 'extended', action: 'deny', protocol: 'ip',
        source: { ip: '10.60.0.0', wildcard: '0.0.0.255', any: false, host: false },
        destination: { ip: '0.0.0.0', wildcard: '255.255.255.255', any: true, host: false }, port: null, log: false }
    ]
  };
  env.sw.aclBindings = {};
  env.sw.aclBindings[env.sp[0].name] = { in: 101 };
  const sim = env.sim;
  sim.ping(env.h1.id, '10.60.0.1', { count: 1 });
  const payload = payloadCounters(env, env.sw);
  const port = payload.ports[env.sp[0].name] || { drops: { total: 0, byReason: {} } };
  ok(port.drops.total > 0, 'the port counted drops', JSON.stringify(port.drops));
  ok(Object.keys(port.drops.byReason).some(function (k) { return /[()]/.test(k); }),
    'and one of the reasons brings its own brackets', JSON.stringify(Object.keys(port.drops.byReason)));

  const lines = show(session(env, env.sw), 'show interfaces ' + env.sp[0].name);
  const summaryLine = lines.filter(function (l) { return /\d drops? \(/.test(l); })[0] || '';
  ok(!!summaryLine, 'the console prints a summary line', lines.join(' | '));
  const inner = /\((.*)\)$/.exec(summaryLine.trim());
  ok(!!inner, 'the summary is one bracketed list', summaryLine);
  const parsed = parseDropSummary(inner ? inner[1] : '');
  const expected = port.drops.byReason;
  const sameKeys = Object.keys(parsed).length === Object.keys(expected).length &&
    Object.keys(parsed).every(function (k) { return expected[k] !== undefined; });
  ok(sameKeys, 'every reason the payload counted is named in the summary, to the character',
    JSON.stringify(parsed) + ' vs ' + JSON.stringify(expected));
  ok(Object.keys(parsed).every(function (k) { return Number(parsed[k]) === Number(expected[k]); }),
    'with the same count against each', JSON.stringify(parsed) + ' vs ' + JSON.stringify(expected));
  ok(summaryLine.indexOf('"') !== -1, 'and a reason that brings brackets is quoted rather than nested',
    summaryLine.trim());

  // The rule holds the other way too: quoting must not be applied to reasons that need none.
  const plain = lab();
  plain.sim.ping(plain.r1.id, '10.199.199.199', { count: 1 });   // no route to it: a reason with no brackets
  const plainLines = show(session(plain, plain.r1), 'show interfaces ' + plain.rp[0].name);
  const plainSummary = plainLines.filter(function (l) { return /\d drops? \(/.test(l); })[0] || '';
  const plainParsed = /\((.*)\)$/.exec(plainSummary.trim());
  ok(!!plainParsed && Object.keys(parseDropSummary(plainParsed[1])).length > 0,
    'a summary of plain reasons reads back too', plainSummary.trim());
  ok(plainSummary.indexOf('"') === -1, 'and is not quoted for no reason', plainSummary.trim());
}

// --- every model, so the parser above is not the only thing being tested ------------------------------------
console.log('');
console.log('The two surfaces agree on every switch in the catalogue:');
{
  let checked = 0;
  let noConsole = 0;
  const bad = [];
  for (const swSpec of catalog.filter(function (s) { return s.category === 'switch'; })) {
    // A box with no configuration interface has no `show` command to print blocks with. That is the capability
    // gate doing its job, not a counters disagreement, and it is pinned in capability-gates.test.js.
    if ((swSpec.capabilities || []).indexOf('cli') === -1) { noConsole++; continue; }
    const eths = (swSpec.interfaces || []).filter(function (i) { return i.type === 'ethernet'; });
    if (eths.length < 2) continue;   // needs at least two ports to be a switch worth sweeping
    const topo = new Topology();
    let dev;
    try { dev = topo.addDevice(swSpec, 'sw1'); } catch (e) { continue; }
    const ports = Array.from(dev.interfaces.values()).filter(function (i) { return i.type === 'ethernet'; });
    const console_ = parseShowInterfaces(show(session({ topo: topo }, dev), 'show interfaces'));
    const payload = flow.counterSnapshot(topo.flowState, dev.id);
    const printed = Object.keys(console_).length;
    // `show interfaces` prints one block per interface, and a switch has more than its ethernet ports - a console
    // port, a coax port, a radio. Comparing against the ethernet count alone would call a correct report wrong.
    if (printed !== dev.interfaces.size) {
      bad.push(swSpec.model + ': console prints ' + printed + ' of ' + dev.interfaces.size + ' interfaces');
      continue;
    }
    // Nothing has crossed, so every printed port must be zero and the payload must have no rows.
    const nonZero = Object.keys(console_).filter(function (k) { return console_[k].in || console_[k].out || console_[k].drops; });
    if (nonZero.length) { bad.push(swSpec.model + ': a quiet switch printed traffic'); continue; }
    if (Object.keys(payload.ports || {}).length) { bad.push(swSpec.model + ': a quiet switch has payload rows'); continue; }
    checked++;
  }
  ok(checked > 100, 'the sweep reached the catalogue', String(checked) + ' switches with a console, ' + noConsole + ' without one');
  ok(bad.length === 0, 'every switch prints one block per port and counts nothing when nothing crossed',
    bad.slice(0, 4).join(' ; '));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
