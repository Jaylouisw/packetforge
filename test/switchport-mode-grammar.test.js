'use strict';
// What may follow `switchport mode` - and what the `no` form takes.
//
// The vendor's syntax line is one line with one keyword in it (Catalyst 2960-S/2960-C 15.2(4)E command
// reference, `switchport mode`; the same line is printed by the 2960-X 15.2(2)E and 15.2(7)E books):
//
//   switchport mode { access | dot1q-tunnel | dynamic { auto | desirable } | private-vlan | trunk }
//   no switchport mode { access | dot1q-tunnel | dynamic | trunk }
//
// and the reference's own error-message table names what a word outside that set gets - `% Invalid input
// detected at '^' marker.`, the caret on the offending word - with nothing applied.
//
// This console read the second word and dropped the rest, and two shapes lied in silence:
//
//   `switchport mode trunk access`  made the port a trunk - two modes in one line, and the port followed the
//                                   first one - which is the worst kind of drop: a paste of a half-typed line
//                                   turned a server port into a trunk and said nothing
//   `switchport mode access flurbish`  set access and never mentioned the word
//   `no switchport mode access flurbish`  put the port back into access mode and never mentioned the word
//
// Every refusal below names the word back, says what it did not do, and leaves the port exactly as it was -
// the rule `duplex full <word>` and `speed 100 <word>` already follow (research/speed-duplex-grammar.md), and
// the one `test/no-command-swallows-a-word.test.js` sweeps for.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
function section(name) { console.log('\n' + name); }

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.filter(function (s) { return s.model === 'Catalyst2960'; })[0];

function lab() {
  const t = new Topology();
  const d = t.addDevice(SWITCH, 'sw');
  const sim = new Simulator(t);
  const port = [...d.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; })[0].name;
  const run = function (lines) {
    return runCommands(d, t, sim, ['enable', 'configure terminal', 'interface ' + port]
      .concat(lines).concat(['end'])).lines;
  };
  return {
    t: t, d: d, sim: sim, port: port, run: run,
    cfg: function () { return runCommands(d, t, sim, ['show running-config']).lines.join('\n'); },
    iface: function () { return d.interfaces.get(port); },
    // The refusal said, and whether the port moved while it was saying it.
    probe: function (lines) {
      const before = this.cfg();
      const said = this.run(lines).filter(function (l) { return /^\s*%/.test(l); });
      return { said: said, changed: before !== this.cfg(), mode: this.iface().vlan.mode };
    }
  };
}

// ---------------------------------------------------------------------------
section('a second mode word is a parse error, and the port does not follow either of them');
{
  const e = lab();
  ok(e.iface().vlan.mode === 'access', 'the port starts in access mode', String(e.iface().vlan.mode));

  const bad = e.probe(['switchport mode trunk access']);
  ok(bad.said.length === 1, 'exactly one line is printed', JSON.stringify(bad.said));
  ok(bad.said[0] === '% switchport mode trunk takes one mode and nothing after it: the word "access" was not used, and the mode is unchanged',
    'the sentence names the second mode and what it did not do', bad.said[0]);
  ok(bad.mode === 'access', 'the port is still an access port - the first word was not obeyed either', bad.mode);
  ok(bad.changed === false, 'and `show running-config` is unchanged');

  // The other order, on a trunk: the trunk must stay a trunk. A drop here would take a working uplink down
  // to a single VLAN, which is the failure this refusal exists to prevent.
  const e2 = lab();
  e2.run(['switchport mode trunk']);
  const trunkBefore = e2.cfg();
  ok(e2.iface().vlan.mode === 'trunk', 'the control port really is a trunk', e2.iface().vlan.mode);
  const bad2 = e2.probe(['switchport mode access flurbish']);
  ok(bad2.said[0] === '% switchport mode access takes one mode and nothing after it: the word "flurbish" was not used, and the mode is unchanged',
    'a junk word after a real mode is quoted back', bad2.said[0]);
  ok(bad2.mode === 'trunk', 'and the trunk is still a trunk', bad2.mode);
  ok(bad2.changed === false && e2.cfg() === trunkBefore, 'the running configuration did not move');
}

section('the word is quoted as it was typed, and a longer tail is quoted whole');
{
  const e = lab();
  const loud = e.probe(['switchport mode access FLURBISH']);
  ok(loud.said[0] === '% switchport mode access takes one mode and nothing after it: the word "FLURBISH" was not used, and the mode is unchanged',
    'the typed spelling is the one quoted', loud.said[0]);
  const two = e.probe(['switchport mode access flurbish murmur']);
  ok(/the word "flurbish murmur" was not used/.test(two.said[0]),
    'two junk words are quoted as the one run they were typed as', two.said[0]);
  ok(two.mode === 'access', 'and the port is where it was');
}

section('the `no` form takes one mode too');
{
  const e = lab();
  e.run(['switchport mode trunk']);
  ok(e.iface().vlan.mode === 'trunk', 'control: the port is a trunk');
  const bad = e.probe(['no switchport mode access flurbish']);
  ok(bad.said[0] === '% no switchport mode takes one mode and nothing after it: the word "flurbish" was not used, and the mode is unchanged',
    'the `no` form refuses a trailing word in the same words', bad.said[0]);
  ok(bad.mode === 'trunk', 'and the port did not fall back to access', bad.mode);
  ok(bad.changed === false, 'nothing in the configuration moved');

  // The control: without the trailing word the command still does its job.
  const okRun = e.run(['no switchport mode trunk']);
  ok(okRun.some(function (l) { return /back to access mode/.test(l); }),
    'the bare `no switchport mode trunk` still returns the port to access', JSON.stringify(okRun));
  ok(e.iface().vlan.mode === 'access', 'and the mode really changed', e.iface().vlan.mode);
}

section('the single-keyword forms are untouched');
{
  const e = lab();
  const trunk = e.run(['switchport mode trunk']);
  ok(trunk.some(function (l) { return l === 'Switchport mode trunk on ' + e.port; }),
    '`switchport mode trunk` still prints its receipt', JSON.stringify(trunk));
  ok(e.iface().vlan.allowedVlans === 'all', 'and still starts the trunk carrying every VLAN',
    String(e.iface().vlan.allowedVlans));
  const access = e.run(['switchport mode access']);
  ok(access.some(function (l) { return l === 'Switchport mode access on ' + e.port; }),
    '`switchport mode access` still prints its receipt', JSON.stringify(access));
  ok(e.iface().vlan.mode === 'access', 'and still sets the mode');
  // `dynamic auto` is a real keyword pair this console does not model: it must stay a usage refusal, not
  // be mistaken for a mode with a trailing word.
  const dyn = e.probe(['switchport mode dynamic auto']);
  ok(dyn.said[0] === '% Usage: switchport mode access|trunk',
    'an unmodelled mode pair is still answered with the two modes this console has', dyn.said[0]);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
