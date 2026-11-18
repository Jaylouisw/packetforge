'use strict';
// The line above `show ip dhcp binding`'s columns: `Bindings from all pools not associated with VRF:`
//
// The table's furniture was audited for `show mac address-table` (a centred title, a rule, a total) and for
// `show etherchannel summary` (a nine-line legend, two counts, a rule), but the DHCP binding view was left
// starting at its column headings. A box opens that table with a title naming which pools the rows came from,
// and it prints the title even when no row follows it, so the two cases this file pins are "a row follows" and
// "none does". Evidence: research/show-ip-dhcp-binding-title.md.
//
// The columns themselves are NOT the box's (this console prints `Client identifier / MAC`, `Pool` and
// `Expires in` where a box prints a three-deep `Client-ID/ / Hardware address/ / User name` header and an
// absolute lease expiry), so nothing here asserts the width or the wording of the header - only that the title
// sits above it, verbatim, and that it is not printed for a question the console refuses outright.
const { loadCatalog } = require('../devices/registry');
const { Topology } = require('../engine/topology');
const { Simulator } = require('../engine/simulator');
const cliModule = require('../engine/cli');
const CliSession = cliModule.CliSession || cliModule;

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const ROOT = require('path').join(__dirname, '..');
const specs = loadCatalog(ROOT + '/devices').filter(function (s) { return !s.error; });
const ROUTER = specs.find(function (s) { return /^ISR 4331$/.test(s.model); }) ||
  specs.find(function (s) { return /ISR 4331/.test(s.model); });
const HOST = specs.find(function (s) {
  return /^(pc|host|endpoint|workstation)/i.test(s.category || '') && s.model;
}) || specs.find(function (s) { return /endpoint|host|PC/i.test((s.category || '') + s.model); });

const TITLE = 'Bindings from all pools not associated with VRF:';
const POOL = ['ip dhcp pool lan', 'network 192.168.10.0 255.255.255.0', 'default-router 192.168.10.1',
  'range 192.168.10.100 192.168.10.110', 'lease 0 0 1', 'exit'];

function lab(poolCmds, ask) {
  const t = new Topology();
  t.addDevice(ROUTER, 'r1');
  t.addDevice(HOST, 'h1');
  t.addDevice(HOST, 'h2');
  const firstFree = function (id) {
    return Array.from(t.getDevice(id).interfaces.keys()).filter(function (n) {
      return !/^(mgmt|console|aux)/i.test(n);
    })[0];
  };
  t.connect('r1', 'Gi0/0/1', 'h1', firstFree('h1'), { mediaId: '1000base-t', speedMbps: 1000 });
  t.connect('r1', 'Gi0/0/2', 'h2', firstFree('h2'), { mediaId: '1000base-t', speedMbps: 1000 });
  const up = t.getDevice('r1').interfaces.get('Gi0/0/1');
  up.ip = '192.168.10.1'; up.mask = '255.255.255.0';
  const up2 = t.getDevice('r1').interfaces.get('Gi0/0/2');
  up2.ip = '192.168.10.1'; up2.mask = '255.255.255.0';

  const s = new CliSession(t.getDevice('r1'), t, null);
  ['enable', 'configure terminal'].concat(poolCmds || []).forEach(function (c) { s.run(c); });
  if (ask) {
    t.getDevice('h1').interfaces.get(firstFree('h1')).dhcp = true;
    t.getDevice('h2').interfaces.get(firstFree('h2')).dhcp = true;
  }
  return t;
}
function lines(t, sim, cmd) {
  return ((new CliSession(t.getDevice('r1'), t, sim).run(cmd) || {}).output || []);
}

console.log('');
console.log('A table with rows opens with the title, on the line above the header:');
{
  const t = lab(POOL, true);
  const sim = new Simulator(t);
  sim.runAtMs = 1000;
  sim.computeDhcp();
  const out = lines(t, sim, 'show ip dhcp binding');
  ok(out[0] === TITLE, 'the first line is the title, verbatim', out[0]);
  ok(/^IP address/.test(out[1] || ''), 'and the column headings come next', out[1]);
  ok(out.filter(function (l) { return l === TITLE; }).length === 1, 'the title is printed once, not per row');
  ok(out.some(function (l) { return /192\.168\.10\.10[0-9]/.test(l); }), 'the rows are still below it');
  ok(out[0].slice(-1) === ':' && out[0] === out[0].trim(), 'and it ends in a colon with no trailing space');
}

console.log('');
console.log('A table with no rows still carries the title:');
{
  // A pool exists, a simulation ran, and no client asked - the case a box prints as the title plus the
  // headings and nothing else.
  const t = lab(POOL, false);
  const sim = new Simulator(t);
  sim.runAtMs = 1000;
  sim.computeDhcp();
  const out = lines(t, sim, 'show ip dhcp binding');
  ok(out[0] === TITLE, 'the title is printed above an empty table too', out[0]);
  ok(/^IP address/.test(out[1] || ''), 'with the headings under it', out[1]);
  ok(out.some(function (l) { return /no leases/.test(l); }), 'and the reason there is no row');
  ok(out.filter(function (l) { return l === TITLE; }).length === 1, 'still exactly once');
}

console.log('');
console.log('A filtered table keeps its title:');
{
  const t = lab(POOL, true);
  const sim = new Simulator(t);
  sim.runAtMs = 1000;
  sim.computeDhcp();
  const held = sim.dhcpBindings('r1')[0];
  const out = lines(t, sim, 'show ip dhcp binding ' + held.ip);
  ok(out[0] === TITLE, 'the title is the first line of the filtered view', out[0]);
}

console.log('');
console.log('A refusal is not a table, and does not get a title:');
{
  // No pool: the console refuses with its own sentence, and a title above a refusal would claim a table
  // that was never printed.
  const t = lab([], false);
  const out = lines(t, null, 'show ip dhcp binding');
  ok(out.every(function (l) { return l !== TITLE; }), 'a device that is not a server prints no title', out.join(' | '));
  ok(/not a DHCP server/.test(out.join('\n')), 'it refuses in its own words instead');

  // A pool but no run: the answer is "nothing has been evaluated yet", again without a table.
  const t2 = lab(POOL, false);
  const none = lines(t2, null, 'show ip dhcp binding');
  ok(none.every(function (l) { return l !== TITLE; }), 'and neither does a server with no simulation behind it');
  ok(/no binding state has been evaluated yet/.test(none.join('\n')), 'which says what it is waiting for');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
