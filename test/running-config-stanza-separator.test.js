'use strict';
// What closes an `interface` stanza in a printed config: a bare `!`, or `exit`?
//
// The printer used to write `exit` after every interface block. That line was added for a mechanical
// reason - the parser once read the next `interface` line while still inside the previous block, so a
// pasted config put every address on whichever port was current (#1230) - but no box prints it. Every
// published running-config separates two `interface` stanzas with a bare `!`: the Cisco 4000 Series ISR
// default configuration prints
//
//     interface GigabitEthernet0/0/0
//     no ip address
//     negotiation auto
//     !
//     interface GigabitEthernet0/0/1
//     ...
//
// and the DHCP server example closes its `ip dhcp pool` stanza with `!` before the first `interface`
// line (https://www.cisco.com/c/en/us/support/docs/ip/dynamic-address-allocation-resolution/22920-dhcp-ser.html).
// A 2960's own header comment is the only other `!` in the file. `exit` is a command that closes a
// session, not a stanza, and it appears in neither sample - `research/running-config-stanza-separator.md`
// records the samples, and which half of this question is still open.
//
// The `exit` line is not load-bearing any more: a global command at an interface prompt is applied in
// global config (the leniency #1230 documented), and an `interface` line switches blocks. So the
// separator can be the character a box prints without moving a single line of a paste.
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
const SWITCH = spec('generic-router');

function session(device) {
  const t = new Topology();
  const d = t.addDevice(device, 'r1');
  const s = new CliSession(d, t, new Simulator(t));
  return {
    t: t, d: d, s: s,
    run: function (lines) {
      const out = [];
      for (const c of [].concat(lines)) {
        let r;
        try { r = s.run(c); } catch (e) { out.push('% EXCEPTION: ' + e.message); continue; }
        for (const l of ((r && r.output) || [])) out.push(String(l));
      }
      return out;
    },
    config: function () { return this.run(['enable', 'show running-config']); }
  };
}

function configure(s) {
  s.run(['enable', 'configure terminal',
    'hostname EDGE-1',
    'interface Gi0/0', 'ip address 10.1.2.3 255.255.255.0', 'exit',
    'interface Gi0/1', 'shutdown', 'exit',
    'end']);
}
function rejections(lines) { return lines.filter(function (l) { return /^%/.test(l); }); }

console.log('');
console.log('An interface stanza closes with the separator a box prints:');
{
  const r = session(ROUTER);
  const fresh = r.config();
  const headers = fresh.filter(function (l) { return /^interface /.test(l); });
  // The header comment starts with `!`, so an exact match is the separator and nothing else.
  const seps = fresh.filter(function (l) { return l === '!'; });
  ok(headers.length > 0, 'a router prints a stanza for each port', String(headers.length));
  ok(seps.length === headers.length, 'and one `!` closes each of them',
    headers.length + ' stanzas, ' + seps.length + ' separators');
  ok(!fresh.some(function (l) { return l === 'exit'; }), 'no `exit` line appears anywhere in the file',
    JSON.stringify(fresh.filter(function (l) { return l === 'exit'; })));

  // The empty stanza is two lines, `interface X` then `!` - no indented body invented for a port with
  // nothing configured, and no missing separator either.
  const at = fresh.indexOf('interface Gi0/1');
  ok(at >= 0 && fresh[at + 1] === '!', 'an unconfigured port is its header and the separator',
    JSON.stringify(fresh.slice(at, at + 3)));
  ok(fresh[at + 2] === 'interface Gi0/2', 'and the separator ends that stanza - the next line is the next block',
    JSON.stringify(fresh.slice(at, at + 3)));
  ok(fresh[fresh.length - 2] === '!' && fresh[fresh.length - 1] === 'end',
    'the file closes the last stanza and then ends', JSON.stringify(fresh.slice(-3)));
}

console.log('');
console.log('A configured stanza keeps its lines, and closes with `!`:');
{
  const r = session(ROUTER);
  configure(r);
  const rc = r.config();
  const at = rc.indexOf('interface Gi0/0');
  ok(rc[at + 1] === '  ip address 10.1.2.3 255.255.255.0', 'the address is inside the stanza',
    JSON.stringify(rc.slice(at, at + 3)));
  ok(rc[at + 2] === '!', 'and the separator follows it', JSON.stringify(rc[at + 2]));
  const last = rc.lastIndexOf('!');
  ok(rc[last + 1] === 'end', 'the last separator sits directly above `end`',
    JSON.stringify(rc.slice(-3)));
}

console.log('');
console.log('The printed file still replays, and lands on the same ports:');
{
  const a = session(ROUTER);
  configure(a);
  const rc = a.config();
  const b = session(ROUTER);
  const out = b.run(['enable', 'configure terminal'].concat(rc).concat(['end']));
  ok(rejections(out).length === 0, 'no line is rejected on the way back in',
    JSON.stringify(rejections(out).slice(0, 3)));
  ok(b.d.interfaces.get('Gi0/0').ip === '10.1.2.3', 'the address is on Gi0/0',
    String(b.d.interfaces.get('Gi0/0').ip));
  ok(b.d.interfaces.get('Gi0/1').enabled === false, 'the shutdown is on Gi0/1',
    String(b.d.interfaces.get('Gi0/1').enabled));
  ok(b.config().join('\n') === rc.join('\n'), 'and the config is byte-identical afterwards');
}

console.log('');
console.log('A vendor-shaped config - `!` between stanzas, no `exit` - is read back:');
{
  // The shape the 4000 ISR sample prints, typed as a paste: two blocks and the `end` that closes it.
  const b = session(ROUTER);
  const out = b.run(['enable', 'configure terminal',
    'hostname PASTED',
    'interface Gi0/0', 'ip address 192.0.2.1 255.255.255.0', '!',
    'interface Gi0/1', 'shutdown', '!',
    'end']);
  ok(rejections(out).length === 0, 'the paste is accepted without a complaint',
    JSON.stringify(rejections(out)));
  ok(b.d.interfaces.get('Gi0/0').ip === '192.0.2.1', 'the first block landed on Gi0/0',
    String(b.d.interfaces.get('Gi0/0').ip));
  ok(b.d.interfaces.get('Gi0/0').enabled === true, 'and was not shut by the block after it');
  ok(b.d.interfaces.get('Gi0/1').enabled === false, 'the second block landed on Gi0/1',
    String(b.d.interfaces.get('Gi0/1').enabled));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
