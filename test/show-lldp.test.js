'use strict';
// `show lldp` presented stale neighbours as current, and its fixed columns ran together (#1265).
//
// Two defects in one small table:
//
//   1. An LLDP neighbour whose port had gone was listed identically to one that was still there. Pull the
//      cable, or shut the far port, and the answer to "what is on that port" did not change - forever.
//   2. The Neighbour column was 20 characters wide and a real device name is 55, so the row read
//      `...router-r1Fa0/1`: the system name and the local port ran together and the table could not be read
//      field by field, which is the only thing it is for.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.filter(function (s) { return /ASR 1001-X/.test(s.model); })[0];
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];
const PC = catalog.filter(function (s) { return s.model === 'generic-pc'; })[0];
const eth = function (d) {
  return [...d.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
};

// r1 -- sw -- pc, so the switch has two neighbours of very different name lengths.
function lab() {
  const t = new Topology();
  const r = t.addDevice(ROUTER, 'r1');
  const sw = t.addDevice(SWITCH, 'sw');
  const pc = t.addDevice(PC, 'pc');
  t.connect('r1', eth(r)[0].name, 'sw', 'Fa0/1');
  t.connect('pc', 'eth0', 'sw', 'Fa0/2');
  const sim = new Simulator(t);
  runCommands(r, t, sim, ['configure terminal', 'interface ' + eth(r)[0].name,
    'ip address 10.0.0.1 255.255.255.0', 'end']);
  sim.ping('r1', '10.0.0.99', { count: 1 });          // anything to make LLDP flow
  return { t: t, sim: sim, r: r, sw: sw, pc: pc };
}

function table(env, dev) {
  const lines = ((new CliSession(dev || env.sw, env.t, env.sim).run('show lldp neighbors').output) || [])
    .map(String);
  const headerIdx = lines.findIndex(function (l) { return /^Device ID/.test(l); });
  const header = headerIdx === -1 ? '' : lines[headerIdx];
  // The five columns start where the box's heading puts them - the widths are the vendor's, not the data's
  // (research/show-lldp-neighbors-columns.md), so a row is parsed by offset and a row whose fields have run
  // together cannot parse.
  const cols = [
    { label: 'Device ID', at: 0, width: 20 },
    { label: 'Local Intf', at: 20, width: 15 },
    { label: 'Hold-time', at: 35, width: 11 },
    { label: 'Capability', at: 46, width: 16 },
    { label: 'Port ID', at: 62, width: null }
  ];
  const body = lines.slice(headerIdx + 1).filter(function (l) {
    return l.trim() && !/^\s{2}\(/.test(l) && !/^Total entries displayed:/.test(l) && l !== '';
  });
  const rows = body.map(function (line) {
    const out = {};
    cols.forEach(function (c) {
      out[c.label] = c.width === null
        ? line.slice(c.at).trim()
        : line.slice(c.at, c.at + c.width).trim();
    });
    return out;
  });
  return { lines: lines, header: header, rows: rows, body: body };
}

function linkTo(env, deviceId, port) {
  return [...env.t.links.values()].filter(function (l) {
    return (l.a.deviceId === deviceId && l.a.iface === port) || (l.b.deviceId === deviceId && l.b.iface === port);
  })[0];
}

console.log('');
console.log('Every row reads field by field, however long the neighbour\'s name is:');
{
  const env = lab();
  const out = table(env);
  ok(out.rows.length === 2, 'both neighbours are listed', String(out.rows.length));
  ok(out.rows.every(function (r) {
    return r['Device ID'] && r['Local Intf'] && r['Port ID'];
  }), 'each row parses into Device ID, Local Intf, Hold-time, Capability, Port ID',
    JSON.stringify(out.rows));
  const asr = out.rows.filter(function (r) { return /ASR 1001/.test(r['Device ID'] || ''); })[0];
  ok(!!asr, 'the long-named router is one of them', JSON.stringify(out.rows));
  ok(asr && asr['Local Intf'] === 'Fa0/1',
    'and its local port is its own field - not glued to the end of the name', JSON.stringify(asr));
  ok(asr && asr['Device ID'] === 'ASR 1001-X aggregati',
    'a name longer than the column is cut at 20 characters, the box\'s own rule',
    String(asr && asr['Device ID']));
  ok(asr && asr['Hold-time'] === '120', 'the hold-time it advertised is its own column', JSON.stringify(asr));
  ok(asr && asr['Capability'] === 'R', 'the capability letter its own bitmap carried', JSON.stringify(asr));
  ok(asr && asr['Port ID'] === 'Gi0', 'its port id is separate too', JSON.stringify(asr));
  // No row may contain a name and a port run together: the failure looked exactly like a neighbour called
  // "...router-r1Fa0/1".
  ok(!/r1Fa0\/1/.test(out.body.join('\n')), 'nothing is concatenated', out.body.join(' | '));
}

console.log('');
console.log('A neighbour whose port has gone is marked, not presented as current:');
{
  const env = lab();
  env.sim.setLinkState(linkTo(env, 'r1', eth(env.r)[0].name).id, 'down');
  env.sim.ping('r1', '10.0.0.99', { count: 1 });

  const out = table(env);
  ok(out.rows.length === 2, 'the entry is still listed - LLDP keeps it until its hold-time expires',
    String(out.rows.length));
  const asr = out.rows.filter(function (r) { return /ASR 1001/.test(r['Device ID'] || ''); })[0];
  ok(!!asr && /\(down: link down\)/.test(asr['Port ID']),
    'but the local port carries the reason', JSON.stringify(asr));
  ok(!!asr && asr['Local Intf'] === 'Fa0/1',
    'and still names the port in its own column', JSON.stringify(asr && asr['Local Intf']));
  // The other neighbour, on a healthy link, is untouched: the mark is per row, not per table.
  const pcRow = out.rows.filter(function (r) { return /PC/.test(r['Device ID'] || ''); })[0];
  ok(!!pcRow && !/\(/.test(pcRow['Port ID']), 'a neighbour on a healthy port is not marked',
    JSON.stringify(pcRow));

  env.sim.setLinkState(linkTo(env, 'r1', eth(env.r)[0].name).id, 'up');
  env.sim.ping('r1', '10.0.0.99', { count: 1 });
  const back = table(env).rows.filter(function (r) { return /ASR 1001/.test(r['Device ID'] || ''); })[0];
  ok(!!back && back['Port ID'] === 'Gi0', 'and the mark clears when the link comes back',
    JSON.stringify(back));
}

console.log('');
console.log('The two ends of one fault say different things:');
{
  const env = lab();
  runCommands(env.sw, env.t, env.sim, ['configure terminal', 'interface Fa0/1', 'shutdown', 'end']);
  env.sim.ping('r1', '10.0.0.99', { count: 1 });
  const here = table(env).rows.filter(function (r) { return /ASR 1001/.test(r['Device ID'] || ''); })[0];
  ok(!!here && /administratively down/.test(here['Port ID']),
    'the switch that shut the port says so itself', JSON.stringify(here));

  const env2 = lab();
  runCommands(env2.r, env2.t, env2.sim, ['configure terminal',
    'interface ' + eth(env2.r)[0].name, 'shutdown', 'end']);
  env2.sim.ping('r1', '10.0.0.99', { count: 1 });
  const there = table(env2).rows.filter(function (r) { return /ASR 1001/.test(r['Device ID'] || ''); })[0];
  ok(!!there && /peer shut down/.test(there['Port ID']),
    'and the switch looking at a shut far port says that instead', JSON.stringify(there));
}

console.log('');
console.log('A neighbour recorded against a port that no longer exists:');
{
  const env = lab();
  env.sw.lldp.set('Fa9/9', {
    chassisId: '02:00:00:00:00:99', portId: 'eth9', systemName: 'ghost', mgmtIp: null
  });
  const out = table(env);
  const ghost = out.rows.filter(function (r) { return /ghost/.test(r['Device ID'] || ''); })[0];
  ok(!!ghost, 'the row is printed', JSON.stringify(out.rows.map(function (r) { return r['Device ID']; })));
  ok(!!ghost && /\(gone\)/.test(ghost['Port ID']),
    'with the port it claimed marked gone, rather than a device invented for it', JSON.stringify(ghost));
}

console.log('');
console.log('Nothing heard says so, and says it under a header:');
{
  const env = lab();
  env.sw.lldp.clear();
  const out = table(env);
  ok(/^Device ID/.test(out.header), 'the header is still printed', out.header);
  ok(/\(none - no LLDP has been heard on any port\)/.test(out.lines.join('\n')),
    'with the honest empty state', out.lines.join(' | '));
  ok(out.rows.length === 0, 'and no rows');
}

console.log('');
console.log('The table does not invent or drop neighbours when a port changes state:');
{
  const env = lab();
  const before = table(env).rows.length;
  env.sim.setLinkState(linkTo(env, 'pc', 'eth0').id, 'down');
  runCommands(env.pc, env.t, env.sim, ['configure terminal', 'interface eth0', 'shutdown', 'end']);
  env.sim.ping('r1', '10.0.0.99', { count: 1 });
  const after = table(env).rows.length;
  ok(after === before, 'the set of neighbours is unchanged by a link going down',
    JSON.stringify({ before: before, after: after }));

  // A neighbour that moves port keeps both rows: the old one is marked, the new one is live. That is what a
  // switch that has not aged the old entry out actually reports.
  env.sw.lldp.set('Fa0/5', Object.assign({}, env.sw.lldp.get('Fa0/2'), { localPort: 'Fa0/5' }));
  const moved = table(env).rows.filter(function (r) { return /PC/.test(r['Device ID'] || ''); });
  ok(moved.length === 2, 'a neighbour heard on a second port appears twice', JSON.stringify(moved));
  ok(moved.some(function (r) { return /\(/.test(r['Port ID']); }),
    'one of them marked as unusable', JSON.stringify(moved.map(function (r) { return r['Port ID']; })));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
