'use strict';
// One prefix, one installed route (#1407).
//
// Found by asking whether a report's own summary matches the table under it. It did not, on two surfaces:
//
//   r1#show ip route
//   C   10.0.12.0      /24  is directly connected, Gi0
//   B  10.0.12.0      /24  [20/0] via 10.0.12.2  Gi0
//
// Two rows, one destination. `routeTo()` - the lookup that actually forwards - has always chosen by longest
// prefix then lowest distance, so the engine knew which one was installed; the table printed both as equals and
// said nothing. And `show ip bgp summary` counted the same prefix as "installed from BGP", because it counted
// what the peer sent rather than what survived selection.
//
// A shadowed route is not deleted: dropping it would hide what the peer sent and leave an operator asking where
// their BGP route went. It is marked, and the row that beat it is named - the same habit the table already has
// for a route whose port cannot carry a frame.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');
const net = require('../engine/net');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const spec = function (m) { return catalog.find(function (x) { return x.model === m; }); };

function cli(t, dev, cmds) { return runCommands(dev, t, null, ['enable', 'configure terminal'].concat(cmds)).lines || []; }
function show(t, dev, cmd) {
  const s = new Simulator(t);
  s.setRunTime(60000);
  return runCommands(dev, t, s, ['enable', cmd]).lines.join('\n');
}

// Two routers that are adjacent over OSPF *and* peered over BGP, so one prefix can arrive by both protocols,
// on top of a connected subnet and two statics whose prefixes are chosen to collide with them.
function build() {
  const t = new Topology();
  const r1 = t.addDevice(spec('ISR 4331'), 'r1');
  const r2 = t.addDevice(spec('ISR 4331'), 'r2');
  const p1 = Array.from(r1.interfaces.keys());
  const p2 = Array.from(r2.interfaces.keys());
  t.connect(r1.id, p1[0], r2.id, p2[0], { mediaId: '1000base-t', speedMbps: 1000 });
  cli(t, r1, ['interface ' + p1[0], 'ip address 10.0.12.1 255.255.255.0', 'no shutdown', 'exit',
    'interface ' + p1[1], 'ip address 10.1.1.1 255.255.255.0', 'no shutdown', 'exit',
    'ospf router-id 1.1.1.1']);
  cli(t, r1, ['router bgp 65001', 'neighbor 10.0.12.2 remote-as 65002']);
  // A config session of its own: leaving the BGP sub-mode ends the session, so a route command after it would
  // be typed at the enable prompt and refused (which is exactly how the first draft of this test lost its statics).
  // The next hops are on the cabled Gi0/0 subnet, not throwaway addresses: a static route whose next hop is on no
  // connected subnet cannot carry a packet at all, and `routeNote()` now says so on the row (#1439) - which would
  // make these rows faults as well as shadows, and this test is about selection, not about routing.
  cli(t, r1, ['ip route 10.0.12.0 255.255.255.0 10.0.12.9',     // shadowed by the connected route
    'ip route 10.2.2.0 255.255.255.0 10.0.12.8']);              // beats the OSPF and BGP routes for the same prefix
  cli(t, r2, ['interface ' + p2[0], 'ip address 10.0.12.2 255.255.255.0', 'no shutdown', 'exit',
    'interface ' + p2[1], 'ip address 10.3.3.1 255.255.255.0', 'no shutdown', 'exit',
    'interface ' + p2[2], 'ip address 10.2.2.1 255.255.255.0', 'no shutdown', 'exit',
    'ospf router-id 2.2.2.2']);
  cli(t, r2, ['router bgp 65002', 'neighbor 10.0.12.1 remote-as 65001']);
  const sim = new Simulator(t);
  sim.setRunTime(60000);
  sim.computeOspf();
  sim.computeBgp();
  return { t: t, r1: r1, r2: r2, sim: sim };
}
const lab = build();
const rows = lab.r1.routesTable(lab.t);

console.log('The lab holds five routes for three prefixes, from four sources');
{
  const codes = {};
  for (const r of rows) codes[r.displayCode] = (codes[r.displayCode] || 0) + 1;
  ok(codes.C === 2 && codes.S === 2 && codes.O >= 1 && codes.B >= 1,
    'connected, static, OSPF and BGP all present', JSON.stringify(codes));
  const collide = {};
  for (const r of rows) collide[r.dest + '/' + r.mask] = (collide[r.dest + '/' + r.mask] || 0) + 1;
  ok(Object.keys(collide).some(function (k) { return collide[k] > 1; }),
    'and at least one prefix is claimed by more than one source', JSON.stringify(collide));
}

console.log('');
console.log('Exactly one row per prefix is installed, and it is the one the lookup uses');
{
  const groups = {};
  for (const r of rows) {
    const k = r.dest + '/' + r.mask;
    groups[k] = groups[k] || [];
    groups[k].push(r);
  }
  const wrong = [];
  const several = [];
  for (const k of Object.keys(groups)) {
    const installed = groups[k].filter(function (r) { return r.installed; });
    if (installed.length !== 1) several.push(k + ': ' + installed.length);
    const winner = installed[0];
    if (!winner) continue;
    // The probe: an address inside the prefix, asked of the same lookup the data plane uses.
    const look = lab.r1.routeTo(winner.dest);
    if (!look) { wrong.push(k + ': routeTo returned null'); continue; }
    if (look.type !== winner.type) wrong.push(k + ': table says ' + winner.type + ', lookup took ' + look.type);
    if ((look.iface || null) !== (winner.iface === '-' ? null : winner.iface)) {
      wrong.push(k + ': table says ' + winner.iface + ', lookup used ' + look.iface);
    }
  }
  ok(several.length === 0, 'one installed row for every prefix', several.join('; '));
  ok(wrong.length === 0, 'and routeTo() agrees with every one of them, by type and by port', wrong.join('; '));

  // The losing rows must still be in the table, marked, naming the row that beat them.
  const losing = rows.filter(function (r) { return r.installed === false; });
  ok(losing.length >= 3, 'the shadowed routes are all still listed', String(losing.length));
  const unmarked = losing.filter(function (r) { return !/^\(not installed: the [A-Z*]+ route for this prefix has distance \d+\)$/.test(r.shadow); });
  ok(unmarked.length === 0, 'each one says it is not installed, and names the code and distance that beat it',
    unmarked.map(function (r) { return r.displayCode + ' ' + r.dest + ' -> ' + r.shadow; }).join(' ;; '));
  // A shadowed route is not a fault: its port is fine, it simply is not the route chosen. `note` means "this row
  // cannot carry a packet" and drives the fault styling, so it must stay empty here - a healthy candidate printed
  // as a fault is exactly what `test/routes-agreement.test.js` exists to prevent. Every next hop in this lab is on
  // a connected subnet precisely so that "healthy" is true: a row can be shadowed *and* unusable, and then the
  // note is about its own next hop, never about the route that beat it (`test/route-next-hop-unreachable.test.js`).
  ok(losing.every(function (r) { return r.unusable === false && !r.note; }),
    'and none of them is presented as a fault',
    losing.map(function (r) { return r.displayCode + ' unusable=' + r.unusable + ' note=' + JSON.stringify(r.note); }).join(' ;; '));
  ok(losing.every(function (r) { return r.shadowedBy && r.shadowedBy.code && typeof r.shadowedBy.distance === 'number'; }),
    'and carries the winning row as data, not only as prose');
}

console.log('');
console.log('What the console prints, and what the panel is served, are the same rows');
{
  const text = show(lab.t, lab.r1, 'show ip route');
  ok(/C   10\.0\.12\.0\s+\/24  is directly connected/.test(text), 'the connected row is unchanged', text.split('\n')[1]);
  ok(/B  10\.0\.12\.0\s+\/24.*\(not installed: the C route for this prefix has distance 0\)/.test(text),
    'the BGP row for the connected subnet says why it is not installed',
    text.split('\n').filter(function (l) { return /^B  /.test(l); }).join(' | '));
  ok(/S  10\.2\.2\.0\s+\/24.*\[1\/0\]/.test(text.replace(/\n/g, '\n')) && !/S  10\.2\.2\.0.*not installed/.test(text),
    'the static that wins its prefix is printed without a mark',
    text.split('\n').filter(function (l) { return /^S  /.test(l); }).join(' | '));
  ok(/O  10\.3\.3\.0\s+\/24.*\(not installed: the B route for this prefix has distance 20\)/.test(text),
    'and an OSPF route that loses to BGP says so',
    text.split('\n').filter(function (l) { return /^O  /.test(l); }).join(' | '));

  // The API hands the panel these same objects (`server/index.js` puts `routesTable(topo)` in the payload),
  // so the mark has to be data on the row rather than a string the console formats for itself.
  const served = lab.r1.routesTable(lab.t);
  ok(served.every(function (r) { return typeof r.installed === 'boolean'; }),
    'every row the panel is served carries the installed flag');
  ok(served.filter(function (r) { return !r.installed; }).every(function (r) { return r.shadowedBy; }),
    'and a losing one carries the winner');
}

console.log('');
console.log('`show ip bgp summary` counts installed routes, not received ones');
{
  const text = show(lab.t, lab.r1, 'show ip bgp summary');
  const bgpRows = rows.filter(function (r) { return r.type === 'bgp'; });
  const installedBgp = bgpRows.filter(function (r) { return r.installed; }).length;
  const shadowedBgp = bgpRows.length - installedBgp;
  ok(bgpRows.length > installedBgp, 'BGP received more prefixes than it installed', bgpRows.length + ' vs ' + installedBgp);
  ok(new RegExp('^' + installedBgp + ' prefix\\(es\\) installed from BGP', 'm').test(text),
    'the count is of installed prefixes (' + installedBgp + ')', text.split('\n').filter(function (l) { return /installed/.test(l); }).join(' | '));
  ok(new RegExp(shadowedBgp + ' more received, not installed').test(text),
    'and it accounts for the rest rather than dropping them', text.split('\n').filter(function (l) { return /installed/.test(l); }).join(' | '));

  // The count and the table are two reports of one fact, and they must agree.
  const installedInTable = show(lab.t, lab.r1, 'show ip route').split('\n')
    .filter(function (l) { return /^B  /.test(l) && !/not installed/.test(l); }).length;
  ok(installedInTable === installedBgp, 'the summary count equals the unmarked B rows in the table',
    installedInTable + ' rows vs ' + installedBgp);
}

console.log('');
console.log('Longest prefix match is not selection: a longer route is installed beside a shorter one');
{
  const t = new Topology();
  const r1 = t.addDevice(spec('ISR 4331'), 'r1');
  const r2 = t.addDevice(spec('ISR 4331'), 'r2');
  const p1 = Array.from(r1.interfaces.keys());
  const p2 = Array.from(r2.interfaces.keys());
  t.connect(r1.id, p1[0], r2.id, p2[0], { mediaId: '1000base-t', speedMbps: 1000 });
  cli(t, r1, ['interface ' + p1[0], 'ip address 10.0.12.1 255.255.255.0', 'no shutdown', 'exit',
    'interface ' + p1[1], 'ip address 10.1.1.1 255.255.255.0', 'no shutdown', 'exit']);
  cli(t, r1, ['router bgp 65001', 'neighbor 10.0.12.2 remote-as 65002']);
  cli(t, r1, ['ip route 10.1.1.128 255.255.255.128 10.0.12.7']);
  cli(t, r2, ['interface ' + p2[0], 'ip address 10.0.12.2 255.255.255.0', 'no shutdown', 'exit']);
  cli(t, r2, ['router bgp 65002', 'neighbor 10.0.12.1 remote-as 65001']);
  const sim = new Simulator(t);
  sim.setRunTime(60000);
  sim.computeBgp();
  const table = r1.routesTable(t);
  const connected = table.filter(function (r) { return r.type === 'connected' && r.dest === '10.1.1.0'; })[0];
  const longer = table.filter(function (r) { return r.type === 'static' && r.dest === '10.1.1.128'; })[0];
  ok(connected && connected.installed, 'the /24 is installed');
  ok(longer && longer.installed, 'and so is the /25 inside it - different prefixes, both used',
    longer ? String(longer.installed) : '(missing)');
  const inHalf = r1.routeTo('10.1.1.200');
  const inOther = r1.routeTo('10.1.1.10');
  ok(inHalf && inHalf.type === 'static', 'an address in the /25 takes the static', inHalf && inHalf.type);
  ok(inOther && inOther.type === 'connected', 'an address outside it stays on the connected route', inOther && inOther.type);
}

console.log('');
console.log('Two routes of one type for one prefix: one is installed, and the lookup picks the same one');
{
  const t = new Topology();
  const r1 = t.addDevice(spec('ISR 4331'), 'r1');
  const p1 = Array.from(r1.interfaces.keys());
  cli(t, r1, ['interface ' + p1[0], 'ip address 10.0.12.1 255.255.255.0', 'no shutdown', 'exit',
    'ip route 192.0.2.0 255.255.255.0 10.0.12.9',
    'ip route 192.0.2.0 255.255.255.0 10.0.12.8']);
  const table = r1.routesTable(t);
  const statics = table.filter(function (r) { return r.type === 'static' && r.dest === '192.0.2.0'; });
  ok(statics.length === 2, 'both statics are in the table', String(statics.length));
  ok(statics.filter(function (r) { return r.installed; }).length === 1, 'exactly one is installed');
  const winner = statics.filter(function (r) { return r.installed; })[0];
  const look = r1.routeTo('192.0.2.1');
  ok(look && look.via === winner.gw, 'and routeTo() takes that one\'s next hop', (look && look.via) + ' vs ' + winner.gw);
}

console.log('');
console.log('The default route follows the same rule');
{
  const t = new Topology();
  const r1 = t.addDevice(spec('ISR 4331'), 'r1');
  const p1 = Array.from(r1.interfaces.keys());
  cli(t, r1, ['interface ' + p1[0], 'ip address 10.0.12.1 255.255.255.0', 'no shutdown', 'exit',
    'ip default-gateway 10.0.12.1', 'ip route 0.0.0.0 0.0.0.0 10.0.12.9']);
  const table = r1.routesTable(t);
  const defaults = table.filter(function (r) { return r.mask === '0.0.0.0' && r.gw && r.gw !== '-'; });
  ok(defaults.length >= 1, 'the table holds the default candidates', String(defaults.length));
  ok(defaults.filter(function (r) { return r.installed; }).length === 1,
    'exactly one of them is installed', defaults.map(function (r) { return r.displayCode + ' via ' + r.gw + ' d=' + r.distance + ' ' + (r.installed ? 'IN' : 'out'); }).join(' | '));
  const winner = defaults.filter(function (r) { return r.installed; })[0];
  const look = r1.routeTo('198.51.100.7');
  ok(look && look.via === winner.gw, 'and an unrelated destination leaves through it', (look && look.via) + ' vs ' + winner.gw);
}

console.log('');
console.log('Every model in the catalogue marks one route per prefix, and the lookup agrees');
{
  const bad = [];
  let checked = 0;
  for (const s of catalog) {
    if (s.error) continue;
    let t, d;
    try {
      t = new Topology();
      d = t.addDevice(s, 'd1');
    } catch (e) { continue; }
    const ports = Array.from(d.interfaces.values()).filter(function (p) { return p.type === 'ethernet'; });
    if (!ports.length) continue;
    const port = ports[0].name;
    cli(t, d, ['interface ' + port, 'ip address 10.0.12.1 255.255.255.0', 'no shutdown', 'exit',
      'ip route 10.0.12.0 255.255.255.0 10.0.12.9',
      'ip route 192.0.2.0 255.255.255.0 10.0.12.5']);
    const table = d.routesTable(t);
    checked++;
    const groups = {};
    for (const r of table) {
      const k = r.dest + '/' + r.mask;
      groups[k] = groups[k] || [];
      groups[k].push(r);
    }
    for (const k of Object.keys(groups)) {
      const win = groups[k].filter(function (r) { return r.installed; });
      if (win.length !== 1) { bad.push(s.model + ' ' + k + ': ' + win.length + ' installed'); continue; }
      const look = d.routeTo(win[0].dest);
      if (!look || look.type !== win[0].type) {
        bad.push(s.model + ' ' + k + ': table ' + win[0].type + ', lookup ' + (look && look.type));
      }
    }
  }
  ok(checked > 1500, 'the sweep covered the catalogue', String(checked));
  ok(bad.length === 0, 'and every model agrees with itself', bad.slice(0, 5).join(' ;; '));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
