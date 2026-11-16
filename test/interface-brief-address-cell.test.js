'use strict';
// What the IP-Address column of `show ip interface brief` holds on a real IOS device.
//
// The table's header is IOS's, character for character (#1521), and the Method column is IOS's - but the
// address cell was this console's own invention: `10.0.0.1/24`. No IOS sample prints a prefix length there.
// The field list defines the column as "IP address assigned to the interface"; the mask appears in
// `show interfaces` ("Internet address is 10.0.0.1/24") and in `show running-config`
// (`ip address 10.0.0.1 255.255.255.0`), and nowhere in this table. A row pasted into a ticket carried a
// string the box cannot produce, which is exactly the kind of detail a reader diffs line by line.
//
// Sources, all printing a bare dotted quad in that column:
//   Cisco IOS Interface and Hardware Component Command Reference, `show ip interface brief`
//     https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/interface/command/ir-cr-book/ir-s5.html
//     ("Ethernet0 10.108.00.5 YES NVRAM up up"; field list: IP-Address = "IP address assigned to the interface")
//   Catalyst 2960 Command Reference 12.2(44)SE / 12.2(50)SE / 15.0(2)SE, interface-summary samples
//     https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/12-2_50_se/command/reference/cr/cli2.html
//     ("Vlan1 172.20.135.202 YES NVRAM up up" - a switch, with the SVI holding the address)
//   Cisco CPT Command Reference 9.3, `show ip interface brief` (PDF)
//     https://www.cisco.com/c/en/us/td/docs/optical/cpt/r9_3/command/reference/cpt93_cr/cpt93_cr_chapter_01110.pdf
//     ("GigabitEthernet0/2 192.168.190.235 YES unset up up")
//   Cisco 4000 Series ISR Software Configuration Guide, interface summary (IOS XE 16.x/17.x)
//     https://www.cisco.com/c/en/us/td/docs/routers/access/4400/software/configuration/guide/isr4400swcfg/bm_isr_4400_sw_config_guide_chapter_0111.pdf
//     ("GigabitEthernet0/0/0 10.0.0.1 YES manual down down")
//   Practitioner transcript, networklessons.com "Static IP vs Dynamic IP": `show ip interface brief` before
//   and after DHCP, both bare - "R2# show ip interface brief / Ethernet0/1 192.168.12.2 YES DHCP up up"
//     https://networklessons.com/cisco/ccna-200-301/static-ip-vs-dynamic-ip
//
// Deliberately NOT changed here: a real box says `NVRAM` for an address it read back from the saved
// configuration and `manual` for one configured in the running session. This model keeps one configuration,
// so it has no saved/unsaved distinction to report - docs/CLI.md states that as a known deviation.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
function spec(model) { return catalog.filter(function (s) { return s.model === model; })[0]; }
const ROUTER = spec('generic-router');
const SWITCH = spec('generic-switch');

// A one-device lab: ports exist once the device is in a topology, and no cable is plugged in, so the Status
// cells cannot change under the address this file is about.
function lab(deviceSpec, name) {
  const t = new Topology();
  const d = t.addDevice(deviceSpec, name || 'r1');
  const s = new CliSession(d, t, new Simulator(t));
  return {
    d: d,
    s: s,
    say: function (c) { return ((s.run(c).output) || []).map(String); },
    row: function (port) {
      return this.say('show ip interface brief').filter(function (l) { return l.indexOf(port) === 0; })[0] || '';
    },
    cfg: function () { s.run('enable'); s.run('configure terminal'); return s; }
  };
}

// The cell under the heading, not a substring of the row: a port name contains '/' too, which is why this
// splits on whitespace instead of searching for the character.
function ipCell(row) {
  return String(row).trim().split(/\s+/)[1] || '';
}

console.log('');
console.log('A configured address is printed without its prefix length:');
{
  const env = lab(ROUTER);
  env.cfg();
  env.say('interface Gi0/0');
  env.say('ip address 10.0.0.1 255.255.255.0');
  env.say('end');
  const row = env.row('Gi0/0');
  ok(ipCell(row) === '10.0.0.1', 'the cell is the bare address', ipCell(row));
  ok(row.indexOf('/24') === -1, 'and no /24 anywhere in the row', row);
  ok(/^Gi0\/0\s+10\.0\.0\.1\s+YES\s+manual(\s|$)/.test(row), 'the rest of the row is unchanged', row);
}

console.log('');
console.log('The same for a mask the reader would have had to convert:');
{
  // 255.255.255.252 is /30 - a cell that showed "/30" was still a string a box never prints.
  const env = lab(ROUTER);
  env.cfg();
  env.say('interface Gi0/1');
  env.say('ip address 192.0.2.6 255.255.255.252');
  env.say('end');
  ok(ipCell(env.row('Gi0/1')) === '192.0.2.6', 'a /30 address is bare too', ipCell(env.row('Gi0/1')));
}

console.log('');
console.log('A DHCP client shows the address and `DHCP`, both as the box writes them:');
{
  const env = lab(ROUTER);
  env.cfg();
  env.say('interface Gi0/2');
  env.say('ip address dhcp');
  env.say('end');
  ok(/^Gi0\/2\s+unassigned\s+YES\s+DHCP(\s|$)/.test(env.row('Gi0/2')),
    'before the lease: `unassigned  YES DHCP`', env.row('Gi0/2'));
  // A lease is what the client writes onto the port; the method stays `DHCP`.
  const port = [...env.d.interfaces.values()].filter(function (i) { return i.name === 'Gi0/2'; })[0];
  port.ip = '10.20.0.11'; port.mask = '255.255.255.0';
  const leased = env.row('Gi0/2');
  ok(ipCell(leased) === '10.20.0.11', 'after the lease the cell is the bare address', ipCell(leased));
  ok(/\sYES\s+DHCP(\s|$)/.test(leased), 'and the method is still DHCP', leased);
}

console.log('');
console.log('A port with no address still says `unassigned`:');
{
  const env = lab(ROUTER);
  const bare = env.row('Gi0/0');
  ok(ipCell(bare) === 'unassigned', 'one word, in the address column', ipCell(bare));
}

console.log('');
console.log('The mask moved nowhere: it is still printed where a box prints it:');
{
  const env = lab(ROUTER);
  env.cfg();
  env.say('interface Gi0/0');
  env.say('ip address 10.0.0.1 255.255.255.0');
  env.say('end');
  const run = env.say('show running-config');
  ok(run.some(function (l) { return /ip address 10\.0\.0\.1 255\.255\.255\.0/.test(l); }),
    '`show running-config` carries the dotted mask',
    run.filter(function (l) { return l.indexOf('ip address') !== -1; })[0]);
  const block = env.say('show interfaces Gi0/0');
  ok(block.some(function (l) { return /ip: 10\.0\.0\.1\/24/.test(l); }),
    'and `show interfaces` carries the prefix length',
    block.filter(function (l) { return l.indexOf('ip: ') !== -1; })[0]);
}

console.log('');
console.log('Every row of a switch table, not just the ones a test typed into:');
{
  const env = lab(SWITCH, 'sw1');
  const lines = env.say('show ip interface brief');
  const rows = lines.filter(function (l) { return /^[A-Za-z]+\d/.test(l) && l.indexOf('Interface') !== 0; });
  ok(rows.length > 0, 'the switch lists its ports', String(rows.length));
  const withPrefix = rows.filter(function (l) { return ipCell(l).indexOf('/') !== -1; });
  ok(withPrefix.length === 0, 'not one of them prints a prefix length', JSON.stringify(withPrefix.slice(0, 2)));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
