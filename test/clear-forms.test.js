'use strict';
// clear-forms.test.js - the `clear` family read every argument as a port.
//
// IOS spells these with keywords, and this console answered:
//
//   SW1#clear mac address-table dynamic
//   % No interface named dynamic on SW1
//
//   R1#clear arp 10.0.0.9
//   % No interface named 10.0.0.9 on R1
//
// Both are the argument being *misread*, not missing: the keyword exists and the address exists.
// The same probe found `show logging summary last 3` printing "Event summary (67 of 67 events)" -
// the window was parsed and then dropped on the summary branch.
//
// Each form is checked against the table itself, because "cleared 2 entries" is only true if the
// rows are gone afterwards.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function saw(re, haystack, msg) {
  const text = (haystack && haystack.output) ? haystack.output.join('\n') : String(haystack);
  ok(re.test(text), msg + (re.test(text) ? '' : ' (in ' + JSON.stringify(text.slice(0, 500)) + ')'));
}
function absent(re, haystack, msg) {
  const text = (haystack && haystack.output) ? haystack.output.join('\n') : String(haystack);
  ok(!re.test(text), msg + (re.test(text) ? ' (unexpectedly matched ' + JSON.stringify(text.slice(0, 300)) + ')' : ''));
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function model(m) { return catalog.filter(function (x) { return x.model === m; })[0]; }

// A switch with two hosts that have talked: the MAC table has two dynamic entries.
function switchLab() {
  const t = new Topology();
  const sw = t.addDevice(model('generic-switch')); sw.name = 'SW1';
  const h1 = t.addDevice(model('generic-pc')); h1.name = 'PC1';
  const h2 = t.addDevice(model('generic-pc')); h2.name = 'PC2';
  const ports = Array.from(sw.interfaces.values());
  t.connect(h1.id, 'eth0', sw.id, ports[0].name);
  t.connect(h2.id, 'eth0', sw.id, ports[1].name);
  const sim = new Simulator(t);
  const sess = function (d) { const s = new CliSession(d, t, sim); s.run('enable'); return s; };
  const a = sess(h1), b = sess(h2), swc = sess(sw);
  a.run('configure terminal'); a.run('interface eth0');
  a.run('ip address 10.0.20.1 255.255.255.0'); a.run('end');
  b.run('configure terminal'); b.run('interface eth0');
  b.run('ip address 10.0.20.2 255.255.255.0'); b.run('end');
  a.run('ping 10.0.20.2');
  return { t: t, sw: sw, swc: swc, ports: ports, sess: sess, sim: sim };
}

console.log('\nclear mac address-table takes the IOS keywords:');
{
  const env = switchLab();
  const before = env.swc.run('show mac address-table').output.join('\n');
  ok(/DYNAMIC/.test(before), 'the table has learned entries to clear');
  const dyn = env.swc.run('clear mac address-table dynamic');
  saw(/cleared on SW1/, dyn, '"dynamic" is a keyword, not a port name');
  absent(/No interface named dynamic/, dyn, 'and is not misread as a port');
  const after = env.swc.run('show mac address-table').output.join('\n');
  absent(/DYNAMIC/, after, 'the entries are gone from the table, not just from the message');
  // Nothing left: the second clear says so rather than inventing an entry count.
  saw(/already empty/, env.swc.run('clear mac address-table dynamic'),
    'clearing an empty table says it was empty');
}

console.log('\nA VLAN narrows it, and a VLAN with no table says so once:');
{
  const env = switchLab();
  const out = env.swc.run('clear mac address-table vlan 99');
  saw(/No MAC address table for VLAN 99/, out, 'a VLAN with nothing learned is named');
  absent(/already empty/, out, 'and the refusal is not followed by a second, empty message');
  const v1 = env.swc.run('clear mac address-table vlan 1');
  saw(/cleared on SW1 in VLAN 1/, v1, 'VLAN 1 clears its own table');
  absent(/DYNAMIC/, env.swc.run('show mac address-table').output.join('\n'), 'and the rows are gone');
}

console.log('\nA single address can be cleared, and a static one cannot:');
{
  const env = switchLab();
  const mac = (env.swc.run('show mac address-table').output.join('\n').match(/([0-9a-f]{2}:){5}[0-9a-f]{2}/i) || [])[0];
  ok(!!mac, 'a learned address is available (' + mac + ')');
  const out = env.swc.run('clear mac address-table address ' + mac);
  saw(/cleared on SW1/, out, 'the address form clears one entry');
  absent(new RegExp(mac, 'i'), env.swc.run('show mac address-table').output.join('\n'),
    'and exactly that one is gone');
  saw(/no static entries/, env.swc.run('clear mac address-table static'),
    '"static" reports that this table holds only learned addresses');
  saw(/port-security/, env.swc.run('clear mac address-table static'),
    'and points at where a pinned address does live');
}

console.log('\nA router has no MAC table to clear, and says which table it has:');
{
  const t = new Topology();
  const r = t.addDevice(model('generic-router')); r.name = 'R1';
  const s = new CliSession(r, t, new Simulator(t)); s.run('enable');
  const out = s.run('clear mac address-table dynamic');
  saw(/does not bridge, so it has no MAC address table/, out, 'the capability is named');
  saw(/show arp/, out, 'with the table it does have');
}

console.log('\nclear arp takes an address as well as a port:');
{
  const t = new Topology();
  const r1 = t.addDevice(model('generic-router')); r1.name = 'R1';
  const r2 = t.addDevice(model('generic-router')); r2.name = 'R2';
  t.connect(r1.id, 'Gi0/0', r2.id, 'Gi0/0');
  const sim = new Simulator(t);
  const a = new CliSession(r1, t, sim); a.run('enable');
  const b = new CliSession(r2, t, sim); b.run('enable');
  a.run('configure terminal'); a.run('interface Gi0/0');
  a.run('ip address 10.0.0.1 255.255.255.0'); a.run('exit');
  a.run('arp 10.0.0.9 00:11:22:33:44:55');
  a.run('end');
  b.run('configure terminal'); b.run('interface Gi0/0');
  b.run('ip address 10.0.0.2 255.255.255.0'); b.run('end');
  a.run('ping 10.0.0.2');
  const before = a.run('show arp').output.join('\n');
  ok(/10\.0\.0\.2/.test(before), 'the ping left a learned entry');
  const one = a.run('clear arp 10.0.0.2');
  saw(/10\.0\.0\.2 .*cleared/, one, 'the address form clears that entry');
  absent(/No interface named 10\.0\.0\.2/, one, 'and the address is not read as a port');
  absent(/10\.0\.0\.2/, a.run('show arp').output.join('\n'), 'the entry is gone from the cache');
  const st = a.run('clear arp 10.0.0.9');
  saw(/is a static entry/, st, 'a pinned entry is refused by name');
  saw(/no arp 10\.0\.0\.9/, st, 'with the verb that does remove it');
  ok(/10\.0\.0\.9/.test(a.run('show arp').output.join('\n')), 'and the pinned entry is still there');
  saw(/No ARP entry for 10\.0\.0\.77/, a.run('clear arp 10.0.0.77'),
    'an address the cache never held says so');
}

console.log('\nshow logging summary honours "last <n>":');
{
  const env = switchLab();
  const all = env.swc.run('show logging summary');
  saw(/Event summary \(\d+ of \d+ events\)/, all, 'the unfiltered summary counts every event');
  const few = env.swc.run('show logging summary last 3');
  saw(/Event summary \(last 3 of \d+ events\)/, few, 'the windowed summary says it is the last three');
  const rows = few.output.filter(function (l) { return /^ {2}\S/.test(l); });
  ok(rows.length < all.output.filter(function (l) { return /^ {2}\S/.test(l); }).length,
    'and it is shorter than the whole log');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
