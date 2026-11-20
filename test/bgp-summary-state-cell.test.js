'use strict';
// `show ip bgp summary`'s last cell holds a number while the session is up (#fidelity).
//
// The table printed the word `Established` in that cell on every live row. No IOS image does: the column is
// `State/PfxRcd`, and it carries the prefixes received from that neighbour while the session is established,
// and the FSM word while it is not - "you won't see the word 'Established' in the output of the show ...
// summary command: rather, you'll see the number of prefixes received from the neighbor"
// (https://www.noction.com/blog/debugging-bgp-states; Dell's field description says the same,
// https://www.dell.com/support/manuals/en-lt/dell-emc-os-9/s4048t-on-9.14.2.6-cli-pub/show-ip-bgp-summary).
// research/show-ip-bgp-summary-state-cell.md has the captures.
//
// The count is of what the peer *sent*, not what this box installed: a prefix already covered by a connected
// route loses the best-path decision and is still a prefix the neighbour sent.
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
const eth = function (d) {
  return [...d.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
};

// r1 (AS65001) -- r2 (AS65002), eBGP over one cable. Each side originates its one connected /24, so each
// receives exactly one prefix - and each already reaches that prefix directly, so neither installs it.
function lab() {
  const t = new Topology();
  const r1 = t.addDevice(ROUTER, 'r1');
  const r2 = t.addDevice(ROUTER, 'r2');
  t.connect('r1', eth(r1)[0].name, 'r2', eth(r2)[0].name);
  const sim = new Simulator(t);
  runCommands(r1, t, sim, ['configure terminal', 'interface ' + eth(r1)[0].name,
    'ip address 10.0.0.1 255.255.255.0', 'end', 'configure terminal',
    'router bgp 65001', 'neighbor 10.0.0.2 remote-as 65002', 'end']);
  runCommands(r2, t, sim, ['configure terminal', 'interface ' + eth(r2)[0].name,
    'ip address 10.0.0.2 255.255.255.0', 'end', 'configure terminal',
    'router bgp 65002', 'neighbor 10.0.0.1 remote-as 65001', 'end']);
  sim.ping('r1', '10.0.0.2', { count: 1 });
  return { t: t, sim: sim, r1: r1, r2: r2 };
}

function summary(env, dev) {
  return ((new CliSession(dev, env.t, env.sim).run('show ip bgp summary').output) || []).map(String);
}

function rowFor(lines, address) {
  const line = lines.filter(function (l) { return l.split(/\s+/)[0] === address; })[0] || '';
  return line.trim().split(/\s+/);
}

console.log('');
console.log('The cell is headed State/PfxRcd, as the box heads it:');
{
  const env = lab();
  const lines = summary(env, env.r1);
  const head = lines.filter(function (l) { return /^Neighbor/.test(l); })[0] || '';
  ok(/State\/PfxRcd/.test(head), 'the header names the field: ' + head.trim());
  ok(!/\bState\s+PfxRcd|\bState\s+Reason/.test(head), 'the bare word State is not the header');
}

console.log('');
console.log('An established session prints what the peer sent, not the word Established:');
{
  const env = lab();
  const text = summary(env, env.r1).join('\n');
  ok(!/Established/.test(text), 'the word Established appears nowhere in the table', text);
  const cells = rowFor(summary(env, env.r1), '10.0.0.2');
  // Neighbor V AS State/PfxRcd Reason
  ok(cells[3] === '1', 'one prefix received reads 1', cells.join(' '));
  ok(cells[4] === 'eBGP', 'and the session kind stays in the column beside it', cells.join(' '));
  ok(/^1 of 1 neighbour\(s\) established/.test(summary(env, env.r1).filter(function (l) {
    return /neighbour\(s\) established/.test(l);
  })[0] || ''), 'the closing count still uses the word, as the console\'s own teaching line');
}

console.log('');
console.log('The count is of prefixes received, not prefixes installed:');
{
  const env = lab();
  const lines = summary(env, env.r1);
  ok(/^0 prefix\(es\) installed from BGP \(1 more received, not installed/.test(
    lines.filter(function (l) { return /prefix\(es\) installed/.test(l); })[0] || ''),
  'this lab installs none of them - the connected route wins', lines.join('\n'));
  ok(rowFor(lines, '10.0.0.2')[3] === '1', 'and the peer still reads 1 prefix received');
}

console.log('');
console.log('A session with no path to the peer reads Idle in that cell:');
{
  const env = lab();
  env.sim.setLinkState([...env.t.links.values()][0].id, 'down');
  env.sim.ping('r1', '10.0.0.2', { count: 1 });
  const lines = summary(env, env.r2);
  const cells = rowFor(lines, '10.0.0.1');
  ok(cells[3] === 'Idle', 'the cell is the FSM word, not a count', cells.join(' '));
  ok(!/Established/.test(lines.join('\n')), 'and nothing claims Established');
  ok(/cannot carry a frame \(link down\)/.test(cells.slice(4).join(' ')),
    'the reason still names the fault beside it', cells.join(' '));
}

console.log('');
if (failed) { console.log(failed + ' failed, ' + passed + ' passed'); process.exit(1); }
console.log(passed + ' passed, 0 failed');
