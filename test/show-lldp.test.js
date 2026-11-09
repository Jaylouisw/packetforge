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
  const lines = ((new CliSession(dev || env.sw, env.t, env.sim).run('show lldp').output) || [])
    .map(String);
  const headerIdx = lines.findIndex(function (l) { return /Neighbour/.test(l); });
  const header = headerIdx === -1 ? '' : lines[headerIdx];
  // Column starts come from the header, so a row is parsed by the table's own layout rather than by a
  // regex that would have passed on the unreadable output too.
  const starts = ['Neighbour', 'Local port', 'Port ID', 'Mgmt address']
    .map(function (label) { return { label: label, at: header.indexOf(label) }; });
  const body = lines.slice(headerIdx + 1).filter(function (l) {
    // The empty-state line is prose, not a row.
    return l.trim() && /^\s{2}\S/.test(l) && !/^\s*\(/.test(l);
  });
  const rows = body.map(function (line) {
    const out = {};
    starts.forEach(function (s, i) {
      if (s.at < 0) return;
      const end = (i + 1 < starts.length && starts[i + 1].at > 0) ? starts[i + 1].at : line.length;
      out[s.label] = line.slice(s.at, end).trim();
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
    return r['Neighbour'] && r['Local port'] && r['Port ID'];
  }), 'each row parses into Neighbour, Local port, Port ID, Mgmt address',
    JSON.stringify(out.rows));
  const asr = out.rows.filter(function (r) { return /ASR/.test(r['Neighbour'] || ''); })[0];
  ok(!!asr, 'the long-named router is one of them', JSON.stringify(out.rows));
  ok(asr && asr['Local port'] === 'Fa0/1',
    'and its local port is its own field - not glued to the end of the name', JSON.stringify(asr));
  ok(asr && asr['Neighbour'].length > 20,
    'the name really is longer than the old 20-character column, which is what broke it',
    String(asr && asr['Neighbour'].length));
  ok(asr && asr['Port ID'] === 'Gi0', 'its port id is separate too', JSON.stringify(asr));
  ok(asr && asr['Mgmt address'] === '10.0.0.1', 'and its management address', JSON.stringify(asr));
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
  const asr = out.rows.filter(function (r) { return /ASR/.test(r['Neighbour'] || ''); })[0];
  ok(!!asr && /\(down: link down\)/.test(asr['Local port']),
    'but the local port carries the reason', JSON.stringify(asr));
  ok(!!asr && asr['Local port'].indexOf('Fa0/1') === 0,
    'and still names the port', JSON.stringify(asr && asr['Local port']));
  // The other neighbour, on a healthy link, is untouched: the mark is per row, not per table.
  const pcRow = out.rows.filter(function (r) { return /PC/.test(r['Neighbour'] || ''); })[0];
  ok(!!pcRow && !/\(/.test(pcRow['Local port']), 'a neighbour on a healthy port is not marked',
    JSON.stringify(pcRow));

  env.sim.setLinkState(linkTo(env, 'r1', eth(env.r)[0].name).id, 'up');
  env.sim.ping('r1', '10.0.0.99', { count: 1 });
  const back = table(env).rows.filter(function (r) { return /ASR/.test(r['Neighbour'] || ''); })[0];
  ok(!!back && back['Local port'] === 'Fa0/1', 'and the mark clears when the link comes back',
    JSON.stringify(back));
}

console.log('');
console.log('The two ends of one fault say different things:');
{
  const env = lab();
  runCommands(env.sw, env.t, env.sim, ['configure terminal', 'interface Fa0/1', 'shutdown', 'end']);
  env.sim.ping('r1', '10.0.0.99', { count: 1 });
  const here = table(env).rows.filter(function (r) { return /ASR/.test(r['Neighbour'] || ''); })[0];
  ok(!!here && /administratively down/.test(here['Local port']),
    'the switch that shut the port says so itself', JSON.stringify(here));

  const env2 = lab();
  runCommands(env2.r, env2.t, env2.sim, ['configure terminal',
    'interface ' + eth(env2.r)[0].name, 'shutdown', 'end']);
  env2.sim.ping('r1', '10.0.0.99', { count: 1 });
  const there = table(env2).rows.filter(function (r) { return /ASR/.test(r['Neighbour'] || ''); })[0];
  ok(!!there && /peer shut down/.test(there['Local port']),
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
  const ghost = out.rows.filter(function (r) { return /ghost/.test(r['Neighbour'] || ''); })[0];
  ok(!!ghost, 'the row is printed', JSON.stringify(out.rows.map(function (r) { return r['Neighbour']; })));
  ok(!!ghost && /\(gone\)/.test(ghost['Local port']),
    'with the port it claimed marked gone, rather than a device invented for it', JSON.stringify(ghost));
}

console.log('');
console.log('Nothing heard says so, and says it under a header:');
{
  const env = lab();
  env.sw.lldp.clear();
  const out = table(env);
  ok(/Neighbour/.test(out.header), 'the header is still printed', out.header);
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
  const moved = table(env).rows.filter(function (r) { return /PC/.test(r['Neighbour'] || ''); });
  ok(moved.length === 2, 'a neighbour heard on a second port appears twice', JSON.stringify(moved));
  ok(moved.some(function (r) { return /\(/.test(r['Local port']); }),
    'one of them marked as unusable', JSON.stringify(moved.map(function (r) { return r['Local port']; })));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
