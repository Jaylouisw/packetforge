'use strict';
// A BGP session across an unplugged cable kept calling itself Established (#1269).
//
// `_bgpReachable()` asked whether the egress port was shut (`enabled`) and nothing else - not whether the
// cable was in, not whether the link was up, not whether the far port was shut. So:
//
//   pull the cable -> show ip bgp: 1 of 1 neighbour(s) established
//                     show ip route: B  10.0.0.0 /24  [20/0] via 10.0.0.1  Gi0
//
// a route whose next hop could not be reached, and a session that had been dead since the cable came out.
// And `show ip bgp` printed a count of prefixes with no way to see which ones or off which peer.
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

// r1 (AS65001) -- r2 (AS65002), eBGP over one cable.
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

function show(env, dev, cmd) {
  return ((new CliSession(dev, env.t, env.sim).run(cmd).output) || []).map(String).join('\n');
}

function established(env, dev) {
  const text = show(env, dev, 'show ip bgp');
  const m = /(\d+) of (\d+) neighbour\(s\) established/.exec(text);
  return { text: text, up: m ? Number(m[1]) : null, of: m ? Number(m[2]) : null };
}

function bRows(env, dev) {
  return show(env, dev, 'show ip route').split('\n').filter(function (l) { return /^B/.test(l); });
}

console.log('');
console.log('A session over a live cable is established, and its prefixes are listed:');
{
  const env = lab();
  const up = established(env, env.r2);
  ok(up.up === 1 && up.of === 1, 'one neighbour, established', up.text);
  const rows = bRows(env, env.r2);
  ok(rows.length === 1, 'the peer installed a B row', rows.join(' | '));
  ok(/10\.0\.0\.0\s+\/24/.test(rows.join('\n')), 'for the advertised prefix', rows.join(' | '));

  // The prefix table: which prefix, off which next hop, with what path - the question the count could not
  // answer.
  const text = up.text;
  ok(/Network\s+Next Hop/.test(text), 'show ip bgp prints a prefix table', text);
  ok(/10\.0\.0\.0\/24\s+10\.0\.0\.1/.test(text), 'naming the prefix and its next hop', text);
  ok(/65001 i/.test(text), 'and the AS path with the origin code', text);
  ok(/eBGP/.test(text), 'and which kind of session it came over', text);
}

console.log('');
console.log('A cable out ends the session and withdraws its routes:');
{
  const env = lab();
  env.sim.setLinkState([...env.t.links.values()][0].id, 'down');
  env.sim.ping('r1', '10.0.0.2', { count: 1 });

  const down = established(env, env.r2);
  ok(down.up === 0, 'zero neighbours established', down.text);
  ok(/Idle/.test(down.text), 'the neighbour reads Idle', down.text);
  ok(/cannot carry a frame \(link down\)/.test(down.text),
    'and says the wire cannot carry a frame, not that someone shut a port', down.text);
  ok(!/Established/.test(down.text), 'nothing still claims Established', down.text);
  ok(/0 prefix\(es\) installed/.test(down.text), 'and the prefixes are withdrawn', down.text);
  ok(bRows(env, env.r2).length === 0, 'so show ip route has no B row left', bRows(env, env.r2).join(' | '));

  // And the data plane agrees: there is no path.
  const r = env.sim.ping('r2', '10.0.0.1', { count: 1 });
  ok(r.replies.every(function (x) { return !x.success; }), 'and a ping across the dead cable fails',
    r.replies.map(function (x) { return x.success; }).join(','));
}

console.log('');
console.log('A shut far port is a different sentence from a pulled cable:');
{
  const env = lab();
  runCommands(env.r1, env.t, env.sim, ['configure terminal', 'interface ' + eth(env.r1)[0].name,
    'shutdown', 'end']);
  env.sim.computeBgp();
  const down = established(env, env.r2);
  ok(down.up === 0, 'the session is down', down.text);
  ok(/peer shut down/.test(down.text), 'and the reason names the far end', down.text);
  ok(bRows(env, env.r2).length === 0, 'with no B row left behind', bRows(env, env.r2).join(' | '));
}

console.log('');
console.log('Restoring the cable brings the session and the routes back:');
{
  const env = lab();
  const link = [...env.t.links.values()][0];
  env.sim.setLinkState(link.id, 'down');
  env.sim.ping('r1', '10.0.0.2', { count: 1 });
  ok(established(env, env.r2).up === 0, 'down while the cable is out');
  env.sim.setLinkState(link.id, 'up');
  env.sim.ping('r1', '10.0.0.2', { count: 1 });
  ok(established(env, env.r2).up === 1, 'established again once it is back');
  ok(bRows(env, env.r2).length === 1, 'and the prefix is installed again', bRows(env, env.r2).join(' | '));
}

console.log('');
console.log('The two tables cannot disagree about the same prefix:');
{
  const env = lab();
  const bgp = show(env, env.r2, 'show ip bgp');
  const rows = bRows(env, env.r2);
  // Whatever `show ip bgp` lists as installed must be exactly what `show ip route` prints as a B row.
  const listed = bgp.split('\n')
    .map(function (l) { return /^(\d+\.\d+\.\d+\.\d+\/\d+)\s+(\d+\.\d+\.\d+\.\d+)/.exec(l); })
    .filter(Boolean)
    .map(function (m) { return { prefix: m[1], hop: m[2] }; });
  ok(listed.length === rows.length, 'one prefix listed for one B row',
    JSON.stringify({ listed: listed, rows: rows }));
  listed.forEach(function (entry, i) {
    const parts = entry.prefix.split('/');
    ok(rows[i].indexOf(parts[0]) !== -1 && rows[i].indexOf(entry.hop) !== -1,
      'prefix ' + entry.prefix + ' appears in its route row with next hop ' + entry.hop, rows[i]);
    // The prefix length must be printed the same way in both tables - one mask rule (#1249).
    ok(rows[i].indexOf('/' + parts[1]) !== -1,
      'and the same prefix length (' + parts[1] + ') as show ip bgp', rows[i]);
  });
}

console.log('');
console.log('No prefixes installed means no empty table:');
{
  const env = lab();
  runCommands(env.r1, env.t, env.sim, ['configure terminal', 'interface ' + eth(env.r1)[0].name,
    'shutdown', 'end']);
  env.sim.computeBgp();
  const text = show(env, env.r2, 'show ip bgp');
  ok(/0 prefix\(es\) installed from BGP/.test(text), 'the count says zero', text);
  ok(!/Network\s+Next Hop/.test(text), 'and no header is printed over nothing', text);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
