'use strict';
// stp-vlan-view.test.js - the operator configures spanning tree per VLAN; the console refused to
// show it that way.
//
//   SW1(config)#spanning-tree vlan 10 root primary
//   Spanning tree for VLAN 10: SW1 is set to be root primary (bridge priority 24576)
//
//   SW1#show spanning-tree vlan 10
//   % show spanning-tree takes one port, not "vlan 10"
//   % Try "show ip interface brief" for the ports this device has
//
// The second message is advice about the port list, for a command that names a VLAN the first
// message had just accepted. And `show spanning-tree root` claimed "Root bridge for VLAN 1" - a
// per-VLAN specificity the model does not have, on a VLAN nobody configured.
//
// The model runs ONE tree for every VLAN. The fix is not a per-VLAN table it cannot back; it is to
// answer the VLAN-shaped question with the tree that exists and say so.
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

function lab(prep) {
  const t = new Topology();
  const d = t.addDevice(catalog.filter(function (x) { return x.model === 'generic-switch'; })[0]);
  d.name = 'SW1';
  const s = new CliSession(d, t, new Simulator(t));
  s.run('enable'); s.run('configure terminal');
  (prep || []).forEach(function (l) { s.run(l); });
  s.run('end');
  return { t: t, d: d, s: s };
}

const CONFIGURED = ['vlan 10', 'vlan 20', 'spanning-tree vlan 10 root primary'];

console.log('\nThe VLAN the configuration names can be asked about:');
{
  const env = lab(CONFIGURED);
  const out = env.s.run('show spanning-tree vlan 10');
  absent(/takes one port/, out, '"vlan 10" is not read as a port');
  absent(/show ip interface brief/, out, 'and the port-list advice is gone');
  saw(/Spanning tree enabled protocol ieee/, out, 'the tree is shown');
  saw(/VLAN 10 - one tree covers every VLAN on this device/, out,
    'and the answer says which VLAN it was asked about, and why the table is the same one');
  saw(/Root bridge: priority/, out, 'with the root it elected');
}

console.log('\nThe same question with root or summary:');
{
  const env = lab(CONFIGURED);
  const root = env.s.run('show spanning-tree vlan 10 root');
  saw(/Root bridge for VLAN 10 \(one tree covers every VLAN on this device\)/, root,
    'the root form names the VLAN and the model fact in one line');
  absent(/for VLAN 1\b(?!\d)/, root, 'and does not claim VLAN 1');
  const sum = env.s.run('show spanning-tree vlan 20 summary');
  saw(/summary for SW1/, sum, 'the summary form works for a VLAN too');
  const plain = env.s.run('show spanning-tree root');
  saw(/Root bridge for every VLAN \(one tree\)/, plain,
    'without a VLAN, the root header speaks for every VLAN instead of inventing VLAN 1');
  absent(/for VLAN 1\b(?!\d)/, plain, 'VLAN 1 is not claimed anywhere in it');
}

console.log('\nA VLAN that is not there is named as missing, with the ones that are:');
{
  const env = lab(CONFIGURED);
  const out = env.s.run('show spanning-tree vlan 99');
  saw(/No VLAN 99 on SW1/, out, 'the VLAN is reported missing');
  saw(/The VLANs here are: .*10.*20/, out, 'and the VLANs it does have are listed');
  absent(/takes one port/, out, 'a real VLAN question does not get a port error');
}

console.log('\nA device that does not bridge still answers with its nature:');
{
  const t = new Topology();
  const r = t.addDevice(catalog.filter(function (x) { return x.model === 'generic-router'; })[0]);
  r.name = 'R1';
  const s = new CliSession(r, t, new Simulator(t)); s.run('enable');
  const out = s.run('show spanning-tree vlan 10');
  saw(/does not bridge, so it runs no spanning tree/, out, 'a router is refused by capability');
  const pc = t.addDevice(catalog.filter(function (x) { return x.model === 'generic-pc'; })[0]);
  pc.name = 'PC1';
  const ps = new CliSession(pc, t, new Simulator(t)); ps.run('enable');
  saw(/does not bridge, so it runs no spanning tree/, ps.run('show spanning-tree vlan 10'),
    'and so is a host');
}

console.log('\nThe page offers it, so the refusal above is not the only hint:');
{
  const env = lab([]);
  // The show rows live on the exec page, not the config one.
  const rows = env.s.run('?').output.join('\n');
  saw(/show spanning-tree vlan <id>/, rows, 'the VLAN form is on the page');
  // And a host is not offered it (the page follows the capability, as everywhere else).
  const t = new Topology();
  const pc = t.addDevice(catalog.filter(function (x) { return x.model === 'generic-pc'; })[0]);
  pc.name = 'PC1';
  const ps = new CliSession(pc, t, new Simulator(t)); ps.run('enable'); ps.run('configure terminal');
  absent(/show spanning-tree vlan/, ps.run('?'), 'a PC is not offered a tree it does not run');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
