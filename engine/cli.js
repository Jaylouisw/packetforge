'use strict';
// cli.js — vendor-agnostic management console (Cisco-like, but the same
// commands work for every vendor in the registry). The engine operates on
// capabilities, not on vendor syntax, so a Huawei router and a Cisco router
// share one consistent command set.
const net = require('./net');

const MODE_EXEC = 'exec';
const MODE_ENABLE = 'enable';
const MODE_CONFIG = 'config';
const MODE_IFACE = 'iface';
const MODE_DHCP_POOL = 'dhcp-pool';
// One port, many spellings - and one table for it. This used to be a second copy of
// engine/iface-name.js, kept in step by hand; two copies of a naming rule drift, which is the
// failure mode this repo has already been bitten by (#1247).
const { PORT_NAME_RULES, portKey, resolvePortName } = require('./iface-name');
// A console port is a line, not an interface. The predicate lives with the port model that owns `type`, so the
// three views that list interfaces and the `interface` door all ask the same question (research note cited there).
const { isConsoleLine } = require('./device');
const ifaceName = { resolvePortName };
// Rates are spelled the way the catalogue spells them, by the parser the catalogue uses: `speed 1G` and
// `speed 1000` must land on the same port rate, and a second parser here would be a second answer.
const mediaLib = require('./media');
// VLAN membership is decided by one rule (engine/vlan.js), so a table that lists members uses it rather
// than re-deriving what a port carries.
const vlanLib = require('./vlan');
// Area ids are parsed by the library that compares them, so the console and the adjacency check
// cannot disagree about what `0.0.0.1` means (#1843).
const ospfLib = require('./ospf');

// What a box says as it opens configuration mode.
//
// The sentence is furniture: every IOS and IOS XE session begins a config block with it, and this console
// opened the mode in silence - so the first line of every captured session an operator compares against a
// real box was missing, even though a real box prints it every time the mode is entered.
//
// It is ONE line, and it has TWO spaces after "line." - which is the half a reader cannot get from Cisco's
// HTML pages, because the browser collapses the run of spaces and two of the vendor's own pages wrap the
// sentence across two lines in the rendered block. The text layer of the vendor's PDF (Catalyst 3560 Switch
// Command Reference 12.2(25)SEA, "Using the Command-Line Interface") preserves both: one baseline, and the
// double space, in the Courier face the transcript is set in. The same sentence is on IOS XE 16/17
// (`cf-cli-basics`). research/config-mode-greeting.md records the pages that disagree and why they are the
// rendering, not the device.
const CONFIG_MODE_GREETING = 'Enter configuration commands, one per line.  End with CNTL/Z.';

// The one sentence both doors print for a console socket: `interface Console` and `show interfaces Console`.
//
// It names the socket the operator typed, says what it is instead, and where a box keeps its settings. The words
// are this console's own - IOS has no sentence for this, because on a box the name does not resolve to an interface
// at all (`% Invalid input detected at '^' marker.`) - so making up a caret line would claim a parser error nobody
// made. What the sentence must not do is invent a `line` mode here: there is none, and a reader told to type
// `line con 0` at this console would get `% Unrecognized command`. It is named as a fact about the box, not as an
// instruction (research/console-is-a-line-not-an-interface.md).
function consoleIsALine(name) {
  const aux = /^aux/i.test(String(name));
  return '% ' + name + ' is the ' + (aux ? 'auxiliary' : 'console') + ' line, not an interface: it carries a ' +
    'terminal at a baud rate, not frames, and a box keeps its settings under `line ' + (aux ? 'aux 0' : 'con 0') + '`';
}

// The `range` keyword of `interface range`: a real global-config command this console cannot model.
//
// `interface range {port-range | macro macro_name}` enters interface-range configuration mode and applies every
// line typed there to every port in the range - `Device(config)# interface range tengigabitethernet 1/1/1-2` /
// `Device(config-if-range)# shut` (Cisco IOS XE 17 Interface Characteristics Configuration Guide, "Example:
// Configuring a range of interfaces"). This console opens one port per line and has no range mode, so the words
// cannot do what they say. It used to read the keyword as a port name and answer `% Interface not found: range
// Fa0/1 - 3` - the sentence a misspelt socket gets, about a command the box really has, and a reader would go
// looking for a socket called `range`. The refusal names the command instead, in the same shape as the
// `vlan 10-12` list refusal: what a box does, what this console does, and that nothing changed
// (research/interface-range-refusal.md).
function interfaceRangeRefusal(tail, effect) {
  const named = String(tail || '').trim();
  // `?` is the help key, not a range: answering `interface range "?"` would quote the operator's question mark
  // back as the thing that was refused. The sentence names the command and says why it cannot run here.
  if (named === '?') {
    return '% "?" is the help key, not a value: `interface range {<first> - <last> | macro <name>}` is a ' +
      'command this console does not model - it opens one port per line';
  }
  return '% interface range' + (named ? ' "' + named + '"' : '') + ' is not modelled: a box takes ' +
    '`interface range <first> - <last>` (or `interface range macro <name>`) and applies each line to every ' +
    'port in it, and this console opens one port per line - ' + effect;
}

function pad(s, w) { s = String(s); return s + ' '.repeat(Math.max(0, w - s.length)); }

// A table cell that **fills** its field keeps the single space the field would have added, so a value as long as
// its column pushes the row along instead of running into the next cell - `vlanMediaLine()`'s rule, and the one
// every fixed-width table in this console follows. Fixed widths are the box's, and the values that land in them
// are not (a port name longer than the capture's 10 characters, a device name of any length), so the rule lives
// here once rather than in each view that prints a table.
function tableCell(v, w) {
  const t = String(v === undefined || v === null ? '' : v);
  return t.length >= w ? t + ' ' : pad(t, w);
}

// Watts to the tenth, the precision a box prints them at in `show power inline` - in the Power cell and in the
// `Available:/Used:/Remaining:` line above it, which is why the rounding lives in one place: a row and the total
// under it must add up on the printed values, not only on the unrounded ones.
function poeWatts(n) { return (Math.round(Number(n) * 10) / 10).toFixed(1); }

// The `Vlan` cell of `show mac address-table` is a four-character field with its value **right-aligned**:
// a learned entry in VLAN 1 prints as `   1`, VLAN 87 as `  87`, and the reserved block's `All` as ` All`
// - the word is a value in the same field, not a left-hand label. Two machine-recorded Catalyst sessions
// keep the leading spaces that a pasted web sample loses: ntc-templates'
// `cisco_ios_show_mac-address-table4.raw` and `...table13.raw` both print
// `Vlan    Mac Address       Type        Ports` over ` All    0100.0ccc.cccc    STATIC      CPU` and
// `   1    ...` (https://github.com/networktocode/ntc-templates/tree/master/tests/cisco_ios/show_mac-address-table).
//
// The console's table carries one column the vendor's does not (`Age`), so its Vlan column is eight characters
// wide rather than four. The value keeps the device's alignment inside that column - right-aligned to the same
// right edge, column 3, that the four-dash rule of the heading marks - so the field grew to the right and the
// cell did not change sides.
function macVlanCell(v) {
  const s = String(v);
  return ' '.repeat(Math.max(0, 4 - s.length)) + pad(s, 8 - Math.max(0, 4 - s.length));
}

// The reserved entries a Catalyst has in its forwarding table before anyone configures anything, and the reason a
// student's first `show mac address-table` on real hardware is not the empty table this console used to print.
// Every row is `All` in the Vlan column (they belong to no VLAN), `STATIC`, and `CPU` in Ports, because the box
// forwards them to its own CPU rather than out of a port - CDP's two addresses, the `0180.c200.0000`-`0010`
// group-address run (spanning tree, LACP, LLDP among them), the all-nodes broadcast - so they are on no port and
// no filter can find them.
//
// The twenty below are the block a 2960 prints, in the box's order: two `0100.0ccc.xxxx`, the `0180.c200.0000` run
// to `0010`, then the broadcast address. A real 2960-I (12.2SE) paste lists exactly these with one learned entry
// and closes `Total Mac Addresses for this criterion: 21`
// (https://brezular.com/2010/10/10/mac-flooding-attack-2/), and the CCNA "Viewing Network Device MAC Addresses"
// lab prints the same twenty over two learned rows and closes at 22. The IOS XE family prints one more -
// `0180.c200.0021` between `0010` and `ffff.ffff.ffff`, twenty-one rows - in the Catalyst 9300 16.12 command
// reference (https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/16-12/command_reference/b_1612_9300_cr/system_management_commands.html)
// and on the 9200/9400/9500/9600 pages. This console speaks one IOS-shaped table for the whole catalogue, so it
// prints the twenty every published transcript agrees on and not the one row that arrived with IOS XE;
// research/mac-table-reserved-rows.md records the split, and why the eleven-row `0000.0000.000x` sample in Cisco's
// current 2960-X/2960-L/1000 command references was not used as evidence.
const RESERVED_MAC_TABLE_ROWS = ['0100.0ccc.cccc', '0100.0ccc.cccd']
  .concat(Array.from({ length: 17 }, function (_, i) { return '0180.c200.' + i.toString(16).padStart(4, '0'); }))
  .concat(['ffff.ffff.ffff']);

// One MAC, in every notation a console meets it in. A hardware address has three spellings - `aa:bb:cc:00:00:99`,
// `aa-bb-cc-00-00-99`, and the IOS dotted `aabb.cc00.0099` that `net.formatMac()` prints on every table this
// console shows - and `net.macToInt()` already folds all three onto the same 48 bits. "Is this token a hardware
// address?" was answered three times in the DHCP console with a private shape each time (a colon-only regex in
// `host`, a `/:/.test(...)` in `no host`, a third copy in the `show ip dhcp binding` filter), so the dotted
// address the box prints itself was refused as "neither" an address nor a MAC, and a lease held by exactly that
// address was reported as "no lease holds that address" - an answer to a question nobody asked.
//
// The canonical colon form comes back, or null when the token is not a hardware address at all. An IPv4 address
// is never one, even where its digits would read as twelve hex characters (`100.100.100.100`).
function macSpelling(token) {
  const s = String(token === undefined || token === null ? '' : token).trim();
  if (!s || net.isIp(s)) return null;
  try { return net.intToMac(net.macToInt(s)); } catch (e) { return null; }
}

// IOS accepts an abbreviation down to "the number of characters that allow a unique abbreviation", and names
// `configure terminal` as its own example: "you can abbreviate the configure terminal command to config t"
// (Cisco IOS XE 16 Fundamentals Configuration Guide, Using the Cisco IOS Command-Line Interface).
// https://cisco.com/c/en/us/td/docs/ios-xml/ios/fundamentals/configuration/xe-16/fundamentals-xe-16-book/cf-cli-basics.html
//
// This console learned the rule for one word and no other: `configure` and `conf` opened config mode while
// `config t` did not (#1661), and `sh ver` - the spelling every operator's fingers type, printed as accepted in
// every Cisco community transcript that pastes a version banner (`Switch#sh ver` over the banner) - answered
// `% Unrecognized command: sh ver` on a console that has the view. (The one word it did know is pinned by the MDS
// 9000 CLI guide, which prints `switch# config t` accepted and `config ?` listing `terminal`:
// https://www.cisco.com/en/US/docs/storage/san_switches/mds9000/sw/rel_1_x/1_1_1a/san-os/configuration/guide/BforBgin.html)
// An alias list is not the rule; the rule is a prefix match against the words the console actually has, so it is
// applied here at the three positions where this console keeps a *complete* table of what may stand there: the
// first word of an EXEC line, the view word after `show`, and the first word of a config line (`host r1`,
// `sp priority 4096`) - the last one added after a real box transcript showed `int gi0/1` accepted at `(config)#`
// while this console refused every shortened config word (research/command-word-abbreviation.md).
//
// Everywhere else - the words after `show ip`, a value such as a port name, `brief` after `interface` - there is
// no complete table, so a short word cannot be told from an ambiguous one and is left exactly as it was. Guessing
// in those positions is how a console accepts a line the box it imitates would have refused, and this repo has
// paid for that mistake before (research/parse-error-caret.md).
//
// The rivals matter as much as the matches: on a box `c`, `co` and `con` are ambiguous, and so are they here,
// where `converge` shares those letters with `configure` - refused as ambiguous rather than guessed, which is the
// same call `interface` makes about a port spelling that folds onto two ports.
//
// `word` is the spelling the dispatcher tests; `spellings` are the words an operator may type for it (`run` for
// `running-config`, `tracert` for `traceroute`, `port-channel` for `etherchannel`). Both are matched by prefix, so
// `trac` reaches `traceroute` instead of becoming ambiguous with its own alias.
const EXEC_WORDS = [
  { word: 'enable', spellings: ['enable'] },
  { word: 'configure', spellings: ['configure'] },
  { word: 'converge', spellings: ['converge'] },
  { word: 'show', spellings: ['show'] },
  { word: 'ping', spellings: ['ping'] },
  { word: 'link', spellings: ['link'] },
  { word: 'links', spellings: ['links'] },
  { word: 'traceroute', spellings: ['traceroute', 'tracert'] },
  { word: 'exit', spellings: ['exit'] },
  { word: 'logout', spellings: ['logout'] },
  { word: 'quit', spellings: ['quit'] },
  { word: 'help', spellings: ['help'] }
];

// The view word after `show`, one entry per door `_show()` can open. `ver` and `run` were already answered by
// their whole spelling; `interface`, `access-list` and `port-channel` are here because IOS accepts the singular
// and the port-channel spelling of the same view.
const SHOW_VIEW_WORDS = [
  { word: 'version', spellings: ['version', 'ver'] },
  { word: 'ip', spellings: ['ip'] },
  { word: 'ipv6', spellings: ['ipv6'] },
  { word: 'interfaces', spellings: ['interfaces', 'interface'] },
  { word: 'running-config', spellings: ['running-config', 'run'] },
  { word: 'vlan', spellings: ['vlan'] },
  { word: 'spanning-tree', spellings: ['spanning-tree'] },
  { word: 'etherchannel', spellings: ['etherchannel', 'port-channel'] },
  { word: 'lldp', spellings: ['lldp'] },
  { word: 'access-lists', spellings: ['access-lists', 'access-list'] },
  { word: 'vrrp', spellings: ['vrrp'] },
  { word: 'arp', spellings: ['arp'] },
  { word: 'mac', spellings: ['mac'] },
  { word: 'power', spellings: ['power'] }
];

// The first word of a `(config)#` line, one entry per door `_configMode()` can open, plus the two words that are
// there to redirect the operator (`show` and `name`). The table is the dispatcher's own vocabulary: a word in it
// that the dispatcher did not handle would be a door the console promised and refused, so each `word` below is a
// `head ===` the dispatcher compares against. `int` is the second spelling of `interface` here for the same reason
// it is in `_ifaceMode()` - a box accepts it, and it must not become a rival of `ip`/`ipv6`; because resolution
// counts *entries* and not spellings, `in` is unique to `interface` while `i` is ambiguous between three doors,
// which is what a box says too. `host` reaches `hostname`, `sp` reaches `spanning-tree`, and `vl` reaches `vlan`.
const CONFIG_WORDS = [
  { word: 'hostname', spellings: ['hostname'] },
  { word: 'vlan', spellings: ['vlan'] },
  { word: 'interface', spellings: ['interface', 'int'] },
  { word: 'ip', spellings: ['ip'] },
  { word: 'ipv6', spellings: ['ipv6'] },
  { word: 'scion', spellings: ['scion'] },
  { word: 'router', spellings: ['router'] },
  { word: 'neighbor', spellings: ['neighbor'] },
  { word: 'bgp', spellings: ['bgp'] },
  { word: 'dns', spellings: ['dns'] },
  { word: 'ospf', spellings: ['ospf'] },
  { word: 'access-list', spellings: ['access-list'] },
  { word: 'vrrp', spellings: ['vrrp'] },
  { word: 'spanning-tree', spellings: ['spanning-tree'] },
  { word: 'no', spellings: ['no'] },
  { word: 'exit', spellings: ['exit'] },
  { word: 'end', spellings: ['end'] },
  { word: 'show', spellings: ['show'] },
  { word: 'do', spellings: ['do'] },
  { word: 'name', spellings: ['name'] },
  { word: 'help', spellings: ['help'] }
];

// The words that may stand in a `(config-if)#` line, one table per position, and every entry a word `_ifaceMode()`
// itself compares against (#fidelity). An operator spends most of a session in this mode, and a box applies the
// same uniqueness rule there as at the prompt's first word - `ip add 10.0.0.1 255.255.255.0`, `sw mo acc`,
// `desc uplink`, `no shut`, `encap dot1q 10` are all accepted. This console resolved the first word of an EXEC
// line, the view word after `show` and the first word of a config line, and refused every shortening inside an
// interface block, so the mode operators actually type in was the one mode that could not be shortened
// (research/command-word-abbreviation.md).
//
// A Cisco 2950 transcript prints the two most-typed ones the way an operator writes them:
//
//   SW2950(config)#int vlan1
//   SW2950(config-if)#ip add 192.168.1.2 255.255.255.0
//   SW2950(config-if)no shut
//   https://community.cisco.com/t5/switching/cisco-2950-switch/td-p/1007218
//
// and a router thread prints the shortening reaching the *sub-words* as well - `ip add` -> `ip address`,
// `ip na` -> `ip nat`, `ip nat ou` -> `ip nat outside` - on both a router and an 887VA:
//   https://community.cisco.com/t5/switching/cisco-887va/td-p/4749176
// The switchport pair appears in a CCNP lab transcript (`sw mo acc`, `sw ac vlan 2`, `sw acc vlan 4`):
//   https://www.scribd.com/document/814808735/Ccsi-Notepad
//
// The rule is applied at the positions where this console has a *complete* table, and nowhere else: the first
// word, the word after `no`, the word after `ip`, `ipv6`, `switchport`, `encapsulation` and `clock`, and the value
// of `switchport mode`. A VLAN id, an address, a description or a rate is a value, not a word from a table, and is
// never touched - guessing there is how a console accepts a line the box it imitates would have refused.
//
// `spanning-tree` is deliberately absent: `_ifaceMode()` does not dispatch it (an interface block falls through to
// the config-mode handler for it, exactly as `vlan 20` does), so a table of this dispatcher's own words cannot
// contain it. The consequence is stated in the research note: `sp` here is `speed` alone, where a box would also
// be weighing `spanning-tree`.
const IFACE_WORDS = [
  { word: 'interface', spellings: ['interface', 'int'] },
  { word: 'vrrp', spellings: ['vrrp'] },
  { word: 'ip', spellings: ['ip'] },
  { word: 'ipv6', spellings: ['ipv6'] },
  { word: 'switchport', spellings: ['switchport'] },
  { word: 'shutdown', spellings: ['shutdown'] },
  { word: 'encapsulation', spellings: ['encapsulation'] },
  { word: 'description', spellings: ['description'] },
  { word: 'speed', spellings: ['speed'] },
  { word: 'duplex', spellings: ['duplex'] },
  { word: 'channel-group', spellings: ['channel-group'] },
  { word: 'clock', spellings: ['clock'] },
  { word: 'show', spellings: ['show'] },
  { word: 'no', spellings: ['no'] },
  { word: 'exit', spellings: ['exit'] },
  { word: 'end', spellings: ['end'] },
  { word: 'help', spellings: ['help'] }
];

// The word after `no` in interface mode - each one a `tokens[1] ===` comparison in `_ifaceMode()`. `no sh` is
// the most-typed line in the mode (`no shut` is in the 2950 transcript above); `no s`, `no d` and `no c` are
// refused as ambiguous, which is what a box does with them too.
const IFACE_NO_WORDS = [
  { word: 'vrrp', spellings: ['vrrp'] },
  { word: 'ip', spellings: ['ip'] },
  { word: 'ipv6', spellings: ['ipv6'] },
  { word: 'shutdown', spellings: ['shutdown'] },
  { word: 'clock', spellings: ['clock'] },
  { word: 'switchport', spellings: ['switchport'] },
  { word: 'channel-group', spellings: ['channel-group'] },
  { word: 'speed', spellings: ['speed'] },
  { word: 'duplex', spellings: ['duplex'] },
  { word: 'description', spellings: ['description'] }
];

// The word after `ip` (and after `no ip`) in interface mode. `address` and `access-group` share `ip a`, so `ip a`
// is refused as ambiguous rather than guessed - the vendor's rule is that the abbreviation must be unique, and it
// is not.
const IFACE_IP_WORDS = [
  { word: 'address', spellings: ['address'] },
  { word: 'access-group', spellings: ['access-group'] },
  { word: 'ospf', spellings: ['ospf'] },
  { word: 'nat', spellings: ['nat'] }
];

// `ipv6 address` is the only form the dispatcher takes under `ipv6`.
const IFACE_IPV6_WORDS = [
  { word: 'address', spellings: ['address'] }
];

// `switchport <word>`. `access` and `trunk` also name a mode, and the mode's own values are a closed pair, so
// `sw mo acc` resolves two positions deep - which is how the CCNP transcript above writes it.
const IFACE_SWITCHPORT_WORDS = [
  { word: 'reset', spellings: ['reset'] },
  { word: 'mode', spellings: ['mode'] },
  { word: 'access', spellings: ['access'] },
  { word: 'trunk', spellings: ['trunk'] },
  { word: 'voice', spellings: ['voice'] }
];

const IFACE_SWITCHPORT_MODE_WORDS = [
  { word: 'access', spellings: ['access'] },
  { word: 'trunk', spellings: ['trunk'] }
];

// `encapsulation dot1q <vid>` and `clock rate <bps>`: one word each, so a shortening can only reach the door the
// whole spelling reaches.
const IFACE_ENCAP_WORDS = [{ word: 'dot1q', spellings: ['dot1q'] }];
const IFACE_CLOCK_WORDS = [{ word: 'rate', spellings: ['rate'] }];

// The rates a Cisco serial port's parser offers, in the order the box lists them. The IOS
// command reference for `clock rate` prints this list (1200 ... 8000000) and says a value of
// any whole number of bits per second in the parser's range is accepted; a router's own
// `clock rate ?` prints the menu and, under it, `<300-4000000> Choose clockrate from list
// above` (transcripts in research/serial-clock-menu.md). The port's declared line rates are
// the model's own hardware list and are kept alongside these; anything else inside the range
// is rounded to the nearest rate the port lists, which is what the box does and says it does.
const SERIAL_CLOCK_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 56000, 64000, 72000,
  125000, 128000, 148000, 250000, 500000, 800000, 1000000, 1300000, 2000000, 4000000, 8000000];

// The word a typed spelling means, or the words it could mean. An exact spelling wins over a longer one that
// starts with it (`link` is not made ambiguous by `links`), one prefix match is the answer IOS accepts, and more
// than one is an ambiguity for the caller to report in its own words. `word: null` means "no command of that name
// here", and the caller's existing refusal answers it, unchanged.
function resolveCommandWord(typed, table) {
  const w = String(typed === undefined || typed === null ? '' : typed).toLowerCase();
  if (!w) return { word: null, rivals: [] };
  for (const entry of table) {
    if (entry.spellings.indexOf(w) !== -1) return { word: entry.word, rivals: [] };
  }
  const hits = table.filter(function (entry) {
    return entry.spellings.some(function (s) { return s.indexOf(w) === 0; });
  });
  if (hits.length === 1) return { word: hits[0].word, rivals: [] };
  // The rivals are the spellings the operator could have meant, not the doors they open: `show p` is ambiguous
  // between `power` and `port-channel`, and naming `etherchannel` there would answer about a word they did not type.
  return { word: null, rivals: hits.map(function (e) {
    return e.spellings.filter(function (s) { return s.indexOf(w) === 0; })[0] || e.word;
  }) };
}

// `show ip interface brief` is one table with six columns, and its header is the table's first row - padded
// from the same widths, so the two cannot drift apart. They had drifted: the header put `OK?` in four columns
// while every row put `YES  ` in five, so `Method` sat one column right of the word `Method` above it and every
// row was off by one from `Status` onwards. A table an operator cannot read down is a table they have to re-parse
// by eye, and this one already gets pasted into bug reports. The widths are IOS's own.
const BRIEF_COLUMNS = [
  { head: 'Interface', width: 23 },
  { head: 'IP-Address', width: 16 },
  { head: 'OK?', width: 4 },
  { head: 'Method', width: 7 },
  { head: 'Status', width: 22 },
  { head: 'Protocol', width: 0 }
];

function briefLine(cells) {
  return cells.map(function (c, i) {
    const w = BRIEF_COLUMNS[i] ? BRIEF_COLUMNS[i].width : 0;
    const text = String(c === null || c === undefined ? '' : c);
    if (!w) return text;
    // A value wider than its column shifts the rest of the row rather than running into it, which is what a
    // real table does with a name it will not shorten.
    return text.length >= w ? text + ' ' : pad(text, w);
  }).join('');
}

// `show vlan` has a shape the vendor's own samples pin down, and this console had it three columns wide:
//
//   VLAN Name                             Status    Ports
//   ---- -------------------------------- --------- -------------------------------
//   1    default                          active    Fa0/1, Fa0/2
//   1002 fddi-default                     act/unsup
//
// Four characters of VLAN id and a space, 32 of Name and a space, nine of Status and a space, and the Ports
// list starting in column 48 - with a rule line under the header that draws those widths in dashes. This
// table padded the id to eight characters and printed no rule line at all, so `Status` sat at column 41
// instead of 38 and every row was three columns right of the word above it. The widths live in one
// list, the header, the rule and the rows are all built from it, so they cannot drift apart again.
const VLAN_COLUMNS = [
  { head: 'VLAN', width: 5, dashes: 4 },
  { head: 'Name', width: 33, dashes: 32 },
  { head: 'Status', width: 10, dashes: 9 },
  { head: 'Ports', width: 0, dashes: 31 }
];

function vlanLine(cells) {
  return cells.map(function (c, i) {
    const col = VLAN_COLUMNS[i];
    const w = col ? col.width : 0;
    const text = String(c === null || c === undefined ? '' : c);
    if (!w) return text;
    return text.length >= w ? text + ' ' : pad(text, w);
  }).join('');
}

// The Ports list is not one line. A box wraps it at the console's 80 columns, and the continuation begins back
// under the Ports heading rather than at column 0. Every transcript of a populated VLAN shows the same shape: the
// 2960-X command reference prints 48 Gi1/0/x ports three to a line, a 2950 sample prints 24 Fa0/x ports four to a
// line - and both fall out of one rule, not a per-family column count. The Ports cell has 80 - 48 = 32 columns to
// fill, each entry is joined to the last by ", ", and an entry that would overrun the window starts a new line
// indented to column 48. research/show-vlan-columns.md left this out for want of an indented transcript; the
// transcripts cited in that note reproduce these line breaks exactly.
const VLAN_TERMINAL_COLS = 80;
const VLAN_PORTS_INDENT = VLAN_COLUMNS.slice(0, 3).reduce(function (n, c) { return n + c.width; }, 0);
const VLAN_PORTS_WIDTH = VLAN_TERMINAL_COLS - VLAN_PORTS_INDENT;

function vlanRows(cells) {
  const head = vlanLine(cells.slice(0, 3));
  const raw = cells[3];
  const ports = Array.isArray(raw) ? raw.map(String)
    : String(raw === null || raw === undefined ? '' : raw).split(', ').filter(Boolean);
  const lines = [];
  let line = head;
  let used = 0;
  for (const p of ports) {
    if (!used) { line += p; used = p.length; continue; }
    if (used + 2 + p.length > VLAN_PORTS_WIDTH) {
      lines.push(line);
      line = ' '.repeat(VLAN_PORTS_INDENT) + p;
      used = p.length;
    } else {
      line += ', ' + p;
      used += 2 + p.length;
    }
  }
  lines.push(line);
  return lines;
}

// What surrounds `show etherchannel summary`: a fixed legend, two counts, and a four-column table.
//
// None of it was printed. The table started at a three-column header this console invented
// (`Group  Protocol  Ports`), so a pasted summary answered none of the questions a real one answers: which
// port-channel the group is, whether the bundle is up, and what the flags in the member list mean. The
// device's legend is fixed text - a box prints every flag it can use, not only the ones this table happens
// to contain - and the `Po1(SU)` cell is two flags in one word: S for a Layer2 port-channel, U for one in
// use, D for one no member can carry. The Protocol column names the protocol and nothing else, so a bundle
// built with `mode on`, which negotiates nothing, reads `-` there (research/etherchannel-summary-layout.md).
const ETHERCHANNEL_FLAGS = [
  'Flags:  D - down        P - bundled in port-channel',
  '        I - stand-alone s - suspended',
  '        H - Hot-standby (LACP only)',
  '        R - Layer3      S - Layer2',
  '        U - in use      f - failed to allocate aggregator',
  // The key is not one solid block. A machine-recorded Catalyst session prints a blank line between the
  // `f - failed to allocate aggregator` text and the `M - not in use` line, and the SD-WAN 26.x capture does
  // the same - both are `ntc-templates` raws (`cisco_ios/show_etherchannel_summary/…raw`), so the gap is in
  // the bytes rather than lost to HTML/PDF extraction. The block boundaries move between releases (that
  // Catalyst splits the key into three blocks, the XE one into two), and this console prints the XE line set
  // with the one gap the two captures agree on: after the `f` text, before `M`.
  // research/etherchannel-summary-layout.md, "The blank lines in the key".
  '',
  '        M - not in use, minimum links not met',
  '        u - unsuitable for bundling',
  '        w - waiting to be aggregated',
  '        d - default port'
];
// The rule is the device's, character for character: 6 dashes, '+', 13, '+', 11, '+', 47.
const ETHERCHANNEL_RULE = '------+-------------+-----------+-----------------------------------------------';
// The header is the device's, character for character - including the two columns it puts `Protocol` left of
// its own values. A row reads `Port-channel` as 16 wide and `Protocol` as 10 (so the protocol starts at column
// 23 and the member list at 33); the header says `Port-channel` in 14 and `Protocol` in 12, which is why every
// Catalyst transcript has `Protocol` two columns left of the words under it. Lining the header up with the
// rows would be tidier than the box, and wrong.
const ETHERCHANNEL_HEADER = 'Group  Port-channel  Protocol    Ports';
// `show etherchannel` is SIX views, and this console has one of them (follow-up to #1620).
//
// The vendor's syntax line is
//   show etherchannel [channel-group-number | {detail | port | port-channel | protocol | summary}]
//   ... | [detail | load-balance | port | port-channel | protocol | summary]
// and its syntax-description block gives each word its own meaning: `detail` "detailed EtherChannel
// information", `load-balance` "the load-balance or frame-distribution scheme among ports in the port
// channel", `port` "EtherChannel port information", `port-channel` "port-channel information", `protocol`
// "the protocol that is being used in the channel", `summary` "a one-line summary per channel group". The
// reference prints an *example under each heading*, and the `protocol` one is a five-line block per group
// (`Channel-group listing:` / `Group: 1` / `Protocol: LACP`), not a row in a table (Catalyst 2960-X Layer 2
// Command Reference 15.2(2)E, `show etherchannel`, pp. 36-37; the 3650 3.6E, 3850 16.3 and 9500 17.10
// references print the same syntax line and the same `show etherchannel protocol` sample).
//   https://cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_2_e/layer2/command_reference/b_Layer2_3_1522e_2960x_cr.pdf
//   https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9500/software/release/16-6/command_reference/b_166_9500_cr/b_166_9500_cr_chapter_0111.html
//
// This console answered all six with the summary table. The five it cannot answer are not small variations
// on that table: they are the bundle's internals (each member's LACP/PAgP state, admin and oper keys, the
// aggregator MAC, the age timers) or a policy this engine does not implement at all (frame distribution).
// Printing the summary for `show etherchannel detail` answers a different question without saying so - the
// one thing a console must not do quietly - so each word is refused by name and pointed at the table that
// does exist. `summary` (and `brief`, this console's own synonym for a one-line-per-group view) still
// prints it. research/etherchannel-summary-layout.md, "The other five views".
const ETHERCHANNEL_VIEW_KEYWORDS = {
  detail: 'on a box it prints each member port\'s negotiation state beside the bundle\'s counters and age timers, and this model keeps neither; `show etherchannel summary` names each group, its protocol and its members.',
  port: 'on a box it prints one block per member port with its own LACP/PAgP state; `show etherchannel summary` names the members in its Ports column.',
  'port-channel': 'on a box it prints the bundle\'s own counters and age timers; `show etherchannel summary` names the bundle and the ports that carry it.',
  protocol: 'on a box it prints each group\'s protocol in a block of its own; the Protocol column of `show etherchannel summary` is that fact, one line per group.',
  'load-balance': 'on a box it prints the frame-distribution policy, and this engine has no equivalent of it: nothing here hashes a frame across members.',
  load: 'on a box it prints the frame-distribution policy, and this engine has no equivalent of it: nothing here hashes a frame across members.'
};
const ETHERCHANNEL_COLUMNS = { group: 7, 'port-channel': 16, protocol: 10 };

// The `show spanning-tree` port table's furniture, transcribed from a machine-recorded Catalyst session
// (ntc-templates `cisco_ios_show_spanning_tree.raw`): `Interface` padded to 20, then `Role` 5, `Sts` 4,
// `Cost` 10, `Prio.Nbr` 9, `Type`. Each rule run is one dash shorter than the field above it, the rule every
// table in this console follows. This view prints the first four fields - `Prio.Nbr` and `Type` are the two
// it does not model, named as open in research/stp-port-table-cost-column.md - so the rule stops after
// `Cost` instead of running the capture's 80 characters.
const STP_TABLE_WIDTHS = { iface: 20, role: 5, sts: 4, cost: 10 };
const STP_TABLE_HEADER = pad('Interface', STP_TABLE_WIDTHS.iface) + pad('Role', STP_TABLE_WIDTHS.role) +
  pad('Sts', STP_TABLE_WIDTHS.sts) + 'Cost';
const STP_TABLE_RULE = Object.keys(STP_TABLE_WIDTHS).map(function (k) {
  return pad('-'.repeat(STP_TABLE_WIDTHS[k] - 1), STP_TABLE_WIDTHS[k]);
}).join('').replace(/\s+$/, '');

// The `show power inline` port table's furniture, transcribed from a machine-recorded session (ntc-templates
// `tests/cisco_ios/show_power_inline/cisco_ios_show_power_inline.raw`, so the runs of spaces survived):
//
//   Interface Admin  Oper       Power   Device              Class Max
//                               (Watts)
//   --------- ------ ---------- ------- ------------------- ----- ----
//   Gi1/0/1   auto   on         30.0    AIR-AP1562I-E-K9    4     30.0
//
// Interface 10 characters, Admin 7, Oper 11, Power 8, Device 20, Class 6, then Max; the unit is a line of its
// own under `Power` (column 28, the three fields before it added up), not a suffix on every cell; and the rule
// is one dash shorter than each field above it. `Interface`'s ten is the width a box uses for a port name it
// abbreviates (`Gi1/0/1`); this catalogue spells some ports in full (`GigabitEthernet1/0/1`), which is what
// `tableCell()` is for. The same three heading lines are in the Catalyst IR1800, ASR 920, IR8340 and IE3100
// configuration guides and in the 2960+ 15.0(2)SE6 transcript.
//
// This view printed its own vocabulary here - `Draw` and `Powered device`, with a ` W` suffix on every cell - so
// a table pasted into a ticket could not be diffed against the one beside it. It prints the columns it holds
// data for and stops at `Device`: `Class` needs the powered device's IEEE classification (nothing here
// negotiates one) and `Max` sits *behind* `Class` in the capture, so printing Max after Device would put a
// number under the wrong heading. research/show-power-inline-columns.md.
const POWER_TABLE_WIDTHS = { iface: 10, admin: 7, oper: 11, power: 8 };
const POWER_TABLE_HEADER = pad('Interface', POWER_TABLE_WIDTHS.iface) + pad('Admin', POWER_TABLE_WIDTHS.admin) +
  pad('Oper', POWER_TABLE_WIDTHS.oper) + pad('Power', POWER_TABLE_WIDTHS.power) + 'Device';
const POWER_TABLE_UNITS = ' '.repeat(POWER_TABLE_WIDTHS.iface + POWER_TABLE_WIDTHS.admin + POWER_TABLE_WIDTHS.oper) +
  '(Watts)';
// The capture's remaining two runs (`----- ----`, for Class and Max) are left off, so the rule ends where the
// last column printed here ends instead of trailing into nothing.
const POWER_TABLE_RULE = ['iface', 'admin', 'oper', 'power'].map(function (k) {
  return pad('-'.repeat(POWER_TABLE_WIDTHS[k] - 1), POWER_TABLE_WIDTHS[k]);
}).join('') + '-'.repeat(19);

// The `Codes:` legend above `show ip route`: nine lines of fixed text, not one line of this console's codes.
//
// A box prints the whole legend of its image on every `show ip route`, whether the table holds one code from
// it or all of them - the same rule `ETHERCHANNEL_FLAGS` above follows ("a box prints every flag it can use,
// not only the ones this table happens to set"). This console printed one 85-character line naming only the six
// codes its own table can emit (`Codes: L - local, C - connected, S - static, B - BGP, O - OSPF, * - candidate
// default`), so a reader comparing a captured table against this one found a shape no box produces: the real
// block wraps nine times and defines RIP, EIGRP, IS-IS, NHRP and ODR on a device that has never run them.
//
// The nine lines below are the block a Catalyst at IOS 15.2E prints, character for character: the first line
// carries the `Codes: ` label and the eight continuations start at column 7, aligning their code under the
// `L` (measured in ntc-templates' raw capture of this command, where the leading spaces survive:
// https://github.com/networktocode/ntc-templates/blob/master/tests/cisco_ios/show_ip_route/cisco_ios_show_ip_route.raw,
// and in Cisco's Catalyst 2960-L 15.2(5)E "Configuring IP Unicast Routing" sample:
// https://cisco.com/c/en/us/td/docs/switches/lan/catalyst2960l/software/15-2_5_e/config-guide/b_1525e_consolidated_2960l_cg/b_1525e_consolidated_2960l_cg_chapter_0111101.html).
// The wrap points are the image's, not a reflow: IOS XE 16/17 inserts `m - OMP`, the four NAT codes and the
// three NHRP ones between the lines above, which is why the same command on a 3850 at 16.12.7 prints eleven
// lines. This console speaks one IOS-shaped table for the whole catalogue, so it prints the 15.2E block the
// catalogue's access switches run; research/show-ip-route-codes-legend.md records the three variants and the
// platforms each one came from.
const IP_ROUTE_CODES_LEGEND = [
  'Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP',
  '       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area',
  '       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2',
  '       E1 - OSPF external type 1, E2 - OSPF external type 2',
  '       i - IS-IS, su - IS-IS summary, L1 - IS-IS level-1, L2 - IS-IS level-2',
  '       ia - IS-IS inter area, * - candidate default, U - per-user static route',
  '       o - ODR, P - periodic downloaded static route, H - NHRP, l - LISP',
  '       a - application route',
  '       + - replicated route, % - next hop override, p - overrides from PfR'
];

// The rule line under the header: each column draws its own width in dashes, one short of the field because
// the space between columns is not a column. The Ports window is the last one, so it runs to the end of the line.
function vlanRule() {
  return VLAN_COLUMNS.map(function (c) {
    const dashes = '-'.repeat(c.dashes);
    return c.width ? pad(dashes, c.width) : dashes;
  }).join('');
}

// `show vlan` is TWO tables, and only the first one is `show vlan brief`.
//
//   VLAN Type  SAID       MTU   Parent RingNo BridgeNo Stp  BrdgMode Trans1 Trans2
//   ---- ----- ---------- ----- ------ ------ -------- ---- -------- ------ ------
//   1    enet  100001     1500  -      -      -        -    -        0      0
//   1005 trnet 101005     1500  -      -      -        ibm  -        0      0
//
// This console sent both words to the same printer, so `show vlan` answered with the brief view and a reader
// asking which media type a VLAN is, or what its SAID is, got no column that holds the answer. The vendor's
// command reference describes `brief` as "only a single line for each VLAN, naming the VLAN, status, and
// ports" - i.e. brief is the subset, and the full view appends the media table (research/show-vlan-media-table.md).
//
// The widths are the device's: every row is 73 characters with the trailing padding trimmed, the header and
// rule are 78, and each rule run is one dash shorter than its field - the same rule the name table follows.
const VLAN_MEDIA_COLUMNS = [
  { head: 'VLAN', width: 5, dashes: 4 },
  { head: 'Type', width: 6, dashes: 5 },
  { head: 'SAID', width: 11, dashes: 10 },
  { head: 'MTU', width: 6, dashes: 5 },
  { head: 'Parent', width: 7, dashes: 6 },
  { head: 'RingNo', width: 7, dashes: 6 },
  { head: 'BridgeNo', width: 9, dashes: 8 },
  { head: 'Stp', width: 5, dashes: 4 },
  { head: 'BrdgMode', width: 9, dashes: 8 },
  { head: 'Trans1', width: 7, dashes: 6 },
  { head: 'Trans2', width: 0, dashes: 6 }
];

// The four reserved VLANs are the only rows whose media is not Ethernet, and the device gives each one a
// type, a bridge number and a spanning-tree flavour from the medium it came from: FDDI, Token Ring (tr), the
// FDDI-to-Ethernet translation bridge (fdnet, IEEE STP) and the Token Ring bridge relay function (trnet, IBM
// STP). `Stp` reads `-` for enet rows even though the box's own default stp-type for an Ethernet VLAN is
// `ieee` - the table prints the field as configured for the media, and the vendor's samples show `-`
// (research/show-vlan-media-table.md).
const VLAN_MEDIA_FIXED = {
  1002: { type: 'fddi', stp: '-', brdgMode: '-' },
  1003: { type: 'tr', stp: '-', brdgMode: '-' },
  1004: { type: 'fdnet', stp: 'ieee', brdgMode: '-' },
  1005: { type: 'trnet', stp: 'ibm', brdgMode: '-' }
};
// Ethernet MTU. A translational-bridge VLAN can carry another medium's MTU (the 6500 sample shows 4472 for
// its token-ring rows); nothing in this model bridges media, so every row it prints is an Ethernet row.
const VLAN_MEDIA_MTU = 1500;
// A VLAN's SAID is 100000 plus its id for Ethernet, and the four reserved rows keep their own (101002-101005).
const VLAN_SAID_BASE = 100000;

function vlanMediaCells(id) {
  const fixed = VLAN_MEDIA_FIXED[id];
  return [
    String(id),
    fixed ? fixed.type : 'enet',
    String(VLAN_SAID_BASE + id),
    String(VLAN_MEDIA_MTU),
    '-', '-', '-',
    fixed ? fixed.stp : '-',
    fixed ? fixed.brdgMode : '-',
    '0', '0'
  ];
}

function vlanMediaLine(cells) {
  return cells.map(function (c, i) {
    const col = VLAN_MEDIA_COLUMNS[i];
    const w = col ? col.width : 0;
    const text = String(c === null || c === undefined ? '' : c);
    if (!w) return text;
    return text.length >= w ? text + ' ' : pad(text, w);
  }).join('');
}

function vlanMediaRule() {
  return VLAN_MEDIA_COLUMNS.map(function (c) {
    const dashes = '-'.repeat(c.dashes);
    return c.width ? pad(dashes, c.width) : dashes;
  }).join('');
}

// The two sections the full view ends with. Both are printed whether or not they have contents - the box
// prints the heading and the rule and leaves the space under them empty - and neither has a model here: this
// console cannot configure an RSPAN VLAN or a private VLAN, so both sections are always empty. The RSPAN rule
// is 78 dashes on the platforms whose samples this console follows (2960-XR, 2960-L, 9200, Catalyst 1000);
// the older Supervisor-engine sample draws it 17 long, the length of the words above it.
const VLAN_RSPAN_HEADING = 'Remote SPAN VLANs';
const VLAN_SECTION_RULE = '-'.repeat(78);
const VLAN_PVLAN_HEADER = 'Primary Secondary Type              Ports';
const VLAN_PVLAN_RULE = '------- --------- ----------------- ------------------------------------------';

// The Method column answers one question - how did this port come by the address it holds - so a port with no
// address has no method at all. IOS prints `unset` there, beside `unassigned` in the IP-Address column; this
// console printed `manual` beside `unassigned`, which claims somebody configured an address that is not there.
// `DHCP` stays even before a lease arrives: asking is a method, and a client that has not been answered
// yet still read `unassigned YES DHCP` on real hardware.
function briefMethod(iface) {
  if (iface.dhcp) return 'DHCP';
  if (iface.ip) return 'manual';
  return 'unset';
}

// A subinterface is printed immediately after the port it rides on, in **both** tables that list interfaces.
//
// `show interfaces` has walked its list that way since subinterfaces were added to it - the child block follows
// the parent block - but `show ip interface brief` iterated the device's interface map and appended every
// subinterface after every physical port, so a router-on-a-stick answered:
//
//   GigabitEthernet0/0/0   unassigned   ...
//   GigabitEthernet0/0/1   unassigned   ...
//   GigabitEthernet0/0/2   unassigned   ...
//   GigabitEthernet0/0/0.10 10.10.0.1  ...
//   GigabitEthernet0/0/0.20 10.20.0.1  ...
//
// A box prints `GigabitEthernet0/0/1`, then `0/0/1.1`, `0/0/1.2`, then `0/0/2` - the child sits under its
// parent, before the next socket (research/interface-brief-subinterface-order.md). Two views of one list must
// not order it two ways, so the walk lives here and both callers use it.
//
// A child is recognised by the `parent` the engine records, and - for a subinterface whose parent field is
// missing - by the dotted name, which is how a box spells the relationship. Anything the walk cannot place (an
// orphaned child) is still printed, at the end: a row that cannot be ordered is not a row to hide.
function orderWithChildren(list) {
  const byName = new Map(list.map(function (i) { return [i.name, i]; }));
  const ordered = [];
  const placed = new Set();
  for (const i of list) {
    if (placed.has(i.name)) continue;
    ordered.push(i); placed.add(i.name);
    for (const child of list) {
      if (child === i || placed.has(child.name)) continue;
      if (child.parent === i.name || String(child.name).indexOf(i.name + '.') === 0) {
        ordered.push(child); placed.add(child.name);
      }
    }
  }
  for (const i of ordered) placed.add(i.name);
  for (const name of byName.keys()) {
    if (!placed.has(name)) ordered.push(byName.get(name));
  }
  return ordered;
}

// A `show` command that does not take an argument says so, and names the command that answers the question asked.
//
// The alternative - and what eight of these did - is to drop the words and print the whole table. That is not a
// refusal, it is a wrong answer: `show ip route 192.0.2.0/24` on a router whose table held only 10.0.0.0/24 printed
// 10.0.0.0/24, which reads as "yes, that prefix is in the table" (#1403). An operator checking whether a prefix is
// installed is checking exactly the thing the drop fabricates.
//
// `whole` says what the command does print; `instead` names the command that answers the narrower question, when
// one exists. Refusing is the truthful answer: this console has no `show ip route <prefix>`, and pretending it does
// is worse than saying so.
function showNoTail(cmd, tail, whole, instead) {
  return ['% ' + cmd + ' does not take "' + tail.join(' ') + '": ' + whole +
    (instead ? ' - ' + instead : '')];
}

// Is this string an IPv4 address, or merely the shape of one? `net.isIp()` is the shape check - three dots and
// one to three digits - so `10.0.0.999` passes it and the engine throws on the first packet. Every command that
// takes an address asks this question, so it is asked in one place: `net.ipToInt()` rejects an octet out of range.
// (A literal IPv6 address is a different question, and `ipv6.parseIpv6()` answers it.)
function isIpv4Literal(x) {
  try { net.ipToInt(String(x)); return true; } catch (e) { return false; }
}

// The words that are views under `show interfaces` in IOS, and the answer this console can give instead (#1443).
//
// Every one of these used to answer `% No interface <word> on <box>` - the same sentence a mistyped port name gets -
// so an operator who typed a command they know from IOS was told a socket did not exist. That is the wrong lesson to
// teach: the port is fine, the view is not here, and the answer should point at the command that does answer the
// question. Each entry says where to go; none of them invent a view this console does not have.
const INTERFACES_VIEW_KEYWORDS = {
  switchport: 'A port\'s own switchport line is in `show interfaces <port>`; VLAN membership is in `show vlan brief`.',
  trunk: '`show vlan brief` names each VLAN\'s ports, and `show interfaces <port>` prints the port\'s trunk settings.',
  status: '`show interfaces` prints every port\'s status and protocol, one block each.',
  description: '`show interfaces <port>` prints the port\'s description when one is set.',
  counters: '`show interfaces <port>` prints that port\'s packet and byte counters; `show interfaces` prints them for every port.',
  summary: '`show interfaces` is the summary: one block per port with status, address and counters.',
  capabilities: 'What a box can do is in `show version` and in its catalogue entry; a port\'s own facts are in `show interfaces <port>`.',
  transceiver: 'The cage and its optics are in `show interfaces <port>` and in the port\'s catalogue entry.',
  errdisable: 'A port that cannot carry a frame says why in `show interfaces <port>` and in `show interfaces`.',
  flowcontrol: 'Flow control is not simulated: there is no negotiation to report.',
  history: 'Counters are a running total, not a history: `show interfaces <port>` prints the totals since the run began.',
  stats: '`show interfaces <port>` prints the totals since the run began.',
  brief: '`show ip interface brief` is the one-line-per-port view: address, method, status and protocol.'
};

// The port-first spelling of those keywords (#1834). `show interfaces [<port>] switchport` and
// `show interfaces [<port>] counters` are IOS forms, so the port comes first and the view word follows it -
// and the port lookup read the whole line as a name, so `show interfaces Fa0/1 counters` claimed a socket
// called "Fa0/1 counters" was missing, one word after the keyword form was taught to answer honestly.
//
// The prefix is resolved by the same table `interface Fa0/1` uses, and only a tail this table knows (or the
// help key) is read as a view: `show interfaces Fa0/99 counters` and `show interfaces Fa0/1 nonsense` keep
// the missing-port sentence. The whole phrase is looked up as a port *before* this runs, so a device with a
// port genuinely called `counters` still shows its port.
function viewAfterPort(dev, typed) {
  const parts = String(typed).split(/\s+/);
  for (let i = parts.length - 1; i >= 1; i--) {
    const resolved = ifaceName.resolvePortName(dev, parts.slice(0, i).join(' '));
    if (!resolved || !dev.interfaces.get(resolved)) continue;
    const tail = parts.slice(i).join(' ');
    if (tail === '?' || /^help$/i.test(tail)) {
      return '% `show interfaces ' + resolved + '` is the whole command: nothing goes after a port name ' +
        "here, and it prints that port's status, address, switchport line and counters.";
    }
    const rest = INTERFACES_VIEW_KEYWORDS[tail.toLowerCase()] ||
      INTERFACES_VIEW_KEYWORDS[tail.split(/\s+/)[0].toLowerCase()];
    if (!rest) continue;
    // The table's advice is written for the keyword form, where no port is named, so four of its entries
    // (`status`, `summary`, `flowcontrol`, `brief`) name none. The reader named one: end on its own block.
    const answer = rest.split('<port>').join(resolved);
    const namesPort = answer.indexOf('`show interfaces ' + resolved + '`') !== -1;
    return '% `show interfaces ' + typed + '` is a view of ' + resolved + ', not a port name: this console ' +
      'has no `show interfaces ' + typed + '`. ' + answer +
      (namesPort ? '' : " The port's own block is `show interfaces " + resolved + '`.');
  }
  return null;
}

// `show ip <view>` spellings (#1447).
//
// An operator's fingers say `show ip arp`, `show ip interface`, `show ip access-lists`, `show ip vrrp` - the spellings
// IOS has taught for thirty years - and every one of them answered `% Invalid show command: ip arp` on a console that
// has the view under another name. `show ip arp` and `show arp` print the same rows from the same table, so the
// spelling should reach it rather than be refused: an alias, not a second implementation.
//
// Where no identical view exists, the refusal names the command that does answer the question, because "invalid" tells
// an operator nothing except that they guessed the wrong word.
const SHOW_IP_ALIASES = {
  arp: 'arp',
  'access-lists': 'access-lists',
  vrrp: 'vrrp'
};

// `show ip interface` alone means the per-port detail; `show ip interface brief` is a view of its own and must keep its
// own door, so this alias only answers when nothing follows it.
const SHOW_IP_BARE_ALIASES = { interface: 'interfaces' };

const SHOW_IP_POINTERS = {
  protocols: 'the protocols this box runs are in `show ip ospf`, `show ip bgp summary` and `show ip route`.',
  traffic: 'per-port counters are in `show interfaces <port>`; this console keeps no device-wide IP traffic tally.'
};

// What `show ip` can be followed by, in the console's own words. Built from the tables above so a new alias cannot be
// added without appearing here.
function showIpUsage() {
  const aliased = Object.keys(SHOW_IP_ALIASES).concat(Object.keys(SHOW_IP_BARE_ALIASES)).sort();
  const pointed = Object.keys(SHOW_IP_POINTERS).sort();
  return ['% `show ip` needs a view. This console has: route, interface brief, ospf, bgp, nat, dhcp, dns - and ' +
    aliased.join(', ') + ', each of which reaches the `show` command of the same name.',
    '  No equivalent here: ' + pointed.join(', ') + '. Type `help` for the full command list.'];
}

// What `show` may be followed by, for the operator who presses `?` instead of guessing. Built from
// `SHOW_VIEW_WORDS` - the same table the dispatcher resolves against - so the list cannot name a view that `show`
// then refuses, and each alias is printed beside the word it reaches, because `show port-channel summary` is how
// most of the world spells `etherchannel` and a list of doors without their other names sends that operator to
// `etherchannel` when they already knew the word they wanted.
// `mac` and `power` are doors that need their word - `show mac address-table`, `show power inline` - and a listing
// that printed the bare words would be advertising two commands this console refuses. Every row below is therefore
// a *completion of `show `*: what the list prints can be typed back into the session that printed it.
const SHOW_VIEW_TAILS = { mac: 'address-table', power: 'inline' };

function showViewUsage() {
  const forms = [];
  const aliases = [];
  for (const entry of SHOW_VIEW_WORDS) {
    // `ip` and `ipv6` are words followed by a view of their own; they are on the last line instead, because
    // printing `ipv6` among the completions would advertise `show ipv6`, which needs a word after it.
    if (entry.word === 'ip' || entry.word === 'ipv6') continue;
    const tail = SHOW_VIEW_TAILS[entry.word];
    forms.push(entry.word + (tail ? ' ' + tail : ''));
    for (const spelling of entry.spellings) {
      if (spelling !== entry.word) aliases.push(spelling + ' = ' + entry.word);
    }
  }
  const lines = ['Available `show` views (each row is a completion of `show `):'];
  for (let i = 0; i < forms.length; i += 4) lines.push('  ' + forms.slice(i, i + 4).join('  |  '));
  lines.push('  other spellings: ' + aliases.join(', '));
  lines.push('  `ip` and `ipv6` each take a view of their own: `show ip ?` and `show ipv6 ?` list those.');
  return lines;
}

// What `show ipv6` can be followed by. It is one word, and the position is the same one `show ip ?` already
// answers - so `show ipv6 ?` was calling the index key an invalid command while its sibling listed the views.
function showIpv6Usage() {
  return ['% `show ipv6` needs a view: this console has nd - what this device would advertise. ' +
    'Type `help` for the full command list.'];
}

// Spanning-tree sub-commands this console knows by name but does not model: the device runs one spanning tree and its
// only tunable is the bridge priority. Shared by `spanning-tree <verb>` and `no spanning-tree <verb>` so both answer
// the same way - the `no` form used to ignore the word entirely and clear the priority whatever was asked (#1501).
const STP_UNMODELLED = ['portfast', 'edge', 'bpduguard', 'bpdufilter', 'cost', 'guard', 'link-type',
  'mode', 'mst', 'loopguard', 'root', 'backbonefast', 'uplinkfast'];

// Per-VLAN spanning tree is a real IOS concept this model deliberately does not have, so both directions refuse it
// in the same words. The set form explained that and the `no` form instead called `vlan` an *unknown* sub-command,
// which tells an operator the console has never heard of per-VLAN STP - the opposite of what the other door said,
// and not true (#1509). `vlan` is not a verb, which is why hoisting the unmodelled verbs in #1501 missed it.
const STP_ONE_TREE = 'This device runs one spanning tree, not one per VLAN';

// `no` reads only the tokens it needs and ignores the rest, so a `?` typed at the end of a `no` line where the
// operator expected help was read as *another token to ignore* and the line acted (#1694): `no vlan 42 name ?`
// removed VLAN 42, `no hostname ?` cleared the name, `no description ?` cleared the port. The key is not a
// value (#1685, #1691) and it is not a trailing word either. Each entry is the branch the line would have run,
// in its own words, so the refusal names the syntax that wanted the answer instead of only complaining.
const NO_FORMS = [
  { modes: ['config'], match: ['hostname'], syntax: 'no hostname', effect: 'clears the hostname', undo: 'cleared' },
  { modes: ['config'], match: ['vlan'], syntax: 'no vlan <id>', effect: 'removes a VLAN', undo: 'removed' },
  { modes: ['config'], match: ['interface'], syntax: 'no interface <name>', effect: 'removes a subinterface', undo: 'removed' },
  { modes: ['config'], match: ['access-list'], syntax: 'no access-list <number>', effect: 'removes an access list', undo: 'removed' },
  { modes: ['config'], match: ['spanning-tree'], syntax: 'no spanning-tree', effect: 'clears the bridge priority', undo: 'cleared' },
  { modes: ['config'], match: ['ip', 'route'], syntax: 'no ip route <prefix> <mask> <gateway>', effect: 'removes a static route', undo: 'removed' },
  { modes: ['config'], match: ['ip', 'default-gateway'], syntax: 'no ip default-gateway', effect: 'clears the default gateway', undo: 'cleared' },
  { modes: ['config'], match: ['ip', 'routing'], syntax: 'no ip routing', effect: 'stops this box forwarding between networks', undo: 'disabled' },
  { modes: ['config'], match: ['ip', 'name-server'], syntax: 'no ip name-server <address>', effect: 'removes a name server', undo: 'removed' },
  { modes: ['config'], match: ['ip', 'nat', 'pool'], syntax: 'no ip nat pool <name>', effect: 'removes a NAT pool', undo: 'removed' },
  { modes: ['config'], match: ['ip', 'nat'], syntax: 'no ip nat pool <name> | no ip nat inside source', effect: 'removes a NAT pool or the last NAT rule', undo: 'removed' },
  { modes: ['config'], match: ['ip', 'dhcp', 'pool'], syntax: 'no ip dhcp pool <name>', effect: 'removes a DHCP pool', undo: 'removed' },
  { modes: ['config'], match: ['dns', 'zone'], syntax: 'no dns zone <name>', effect: 'removes a DNS zone', undo: 'removed' },
  { modes: ['config'], match: ['router', 'bgp'], syntax: 'no router bgp <as>', effect: 'removes the BGP process', undo: 'removed' },
  { modes: ['config'], match: ['neighbor'], syntax: 'no neighbor <address>', effect: 'removes a BGP neighbour', undo: 'removed' },
  { modes: ['config'], match: ['ospf'], syntax: 'no ospf <process>', effect: 'removes the OSPF process', undo: 'removed' },
  { modes: ['iface'], match: ['description'], syntax: 'no description', effect: 'clears the description on this port', undo: 'cleared' },
  { modes: ['iface'], match: ['ip', 'address'], syntax: 'no ip address [<ip> <mask>]', effect: 'clears the address on this port, or the one named when it is the one the port holds', undo: 'cleared' },
  { modes: ['iface'], match: ['ip', 'nat'], syntax: 'no ip nat inside | no ip nat outside', effect: "clears this port's NAT role", undo: 'cleared' },
  { modes: ['iface'], match: ['vrrp'], syntax: 'no vrrp <vrid>', effect: 'removes a VRRP group from this port', undo: 'removed' },
  { modes: ['iface'], match: ['shutdown'], syntax: 'no shutdown', effect: 'opens this port', undo: 'changed' },
  { modes: ['iface'], match: ['switchport'], syntax: 'no switchport', effect: "resets this port's switching", undo: 'changed' },
  { modes: ['iface'], match: ['channel-group'], syntax: 'no channel-group <id>', effect: 'removes this port from its LAG', undo: 'removed' },
  { modes: ['iface'], match: ['speed'], syntax: 'no speed', effect: 'returns this port to auto-negotiation', undo: 'changed' },
  { modes: ['iface'], match: ['duplex'], syntax: 'no duplex', effect: 'returns this port to auto-duplex', undo: 'changed' },
  { modes: ['dhcp-pool'], match: ['pool'], syntax: 'no pool', effect: 'removes this whole DHCP pool', undo: 'removed' },
  { modes: ['dhcp-pool'], match: ['network'], syntax: 'no network', effect: "clears the pool's network", undo: 'cleared' },
  { modes: ['dhcp-pool'], match: ['default-router'], syntax: 'no default-router', effect: "clears the pool's default router", undo: 'cleared' },
  { modes: ['dhcp-pool'], match: ['dns-server'], syntax: 'no dns-server', effect: "clears the pool's DNS servers", undo: 'cleared' },
  { modes: ['dhcp-pool'], match: ['range'], syntax: 'no range', effect: "clears the pool's address range", undo: 'cleared' },
  { modes: ['dhcp-pool'], match: ['lease'], syntax: 'no lease', effect: "clears the pool's lease time", undo: 'cleared' },
  { modes: ['dhcp-pool'], match: ['excluded-address'], syntax: 'no excluded-address <address>', effect: 'removes excluded addresses from the pool', undo: 'removed' },
  { modes: ['dhcp-pool'], match: ['host'], syntax: 'no host <address> [<mac>]', effect: 'removes a reservation', undo: 'removed' }
];

// The longest match wins, so `no ip nat pool <name>` is named rather than the shorter `no ip nat` beside it.
function noFormFor(words, mode) {
  const typed = words.map(function (w) { return String(w).toLowerCase(); });
  let best = null;
  for (const f of NO_FORMS) {
    if (f.modes.indexOf(mode) === -1) continue;
    if (f.match.length > typed.length) continue;
    let hit = true;
    for (let k = 0; k < f.match.length; k++) {
      if (f.match[k] !== typed[k]) { hit = false; break; }
    }
    if (hit && (!best || f.match.length > best.match.length)) best = f;
  }
  return best;
}

// The clause a real IOS appends to a ping's success-rate line, and the rule for when it cannot be printed.
//
// `Success rate is 80 percent (4/5)` is a sentence IOS never finishes there: when at least one echo comes back the
// line continues `, round-trip min/avg/max = 1/1/2 ms`, and when none does it stops exactly where this console used to
// stop. Both halves are in Cisco's own transcripts - the NAT connectivity note prints the first for a 4/5 ping, the
// ping/traceroute note prints `Success rate is 0 percent (0/5)` with nothing after it - so the clause is a
// measurement, printed if and only if there is one to report. A clause on a ping that lost every echo would be a
// figure nothing measured, which is the failure this repo keeps fixing in the other direction.
//
// The figures are this console's, not the vendor's. A real box reports whole milliseconds and truncates the
// fraction - an IOS host pinging its own link-local address prints `0/0/0 ms` - but this console's whole reason for
// having a latency model is that a 1 m patch lead (0.103 ms) and a 40 km span (0.65 ms) are different paths, and
// rounding both to `0/0/0` would put that difference back where it started. So the clause is the vendor's sentence
// in this console's units - the same `formatRttMs` figures a `traceroute` hop line prints, so the two views cannot
// spell one measurement two ways. Printing `0/0/0` there would be the vendor's spelling of the same measurement, and
// also the one thing an operator would report as a bug.
function formatRttMs(ms) {
  return ms < 1 ? ms.toFixed(3) : ms.toFixed(1);
}

function roundTripClause(replies) {
  const measured = (replies || []).filter(function (r) {
    return r && r.success && typeof r.rtt === 'number' && isFinite(r.rtt);
  }).map(function (r) { return r.rtt; });
  // No echo came back, or none of the replies carried a modelled delay: there is no round trip to report.
  if (!measured.length) return '';
  const min = Math.min.apply(null, measured);
  const max = Math.max.apply(null, measured);
  const avg = measured.reduce(function (a, b) { return a + b; }, 0) / measured.length;
  // One precision for the whole clause, chosen by its largest value, so the three figures read as one measurement
  // rather than `0.200/0.733/1.6`. The thresholds are `formatRttMs`'s, so a figure here and the same figure on a
  // traceroute hop line are never spelled two ways.
  const f = function (ms) { return ms.toFixed(max < 1 ? 3 : 1); };
  return ', round-trip min/avg/max = ' + f(min) + '/' + f(avg) + '/' + f(max) + ' ms';
}

// One traceroute probe, as the column a real trace puts it in: the round trip in `msec`, or a single `*` for a
// probe that timed out. The unit is the vendor's - IOS prints `msec` on a hop line while `ping` prints `ms` - and
// the figures are formatted by the same `formatRttMs` the ping's success-rate clause uses, so a hop and the ping
// beside it cannot spell the same measurement two ways.
// The letter a destination-unreachable puts where a probe's time would go. Cisco's traceroute
// output table names N (network unreachable), H (host unreachable), P (protocol unreachable),
// U (port unreachable) and A (administratively prohibited), and the same page's ICMP type-3
// table gives the codes behind them: 0 net, 1 host, 2 protocol, 3 port (Cisco 12778, "Understand
// Ping and Traceroute Commands"). A code that table does not name keeps `?`, its own word for
// "any other ICMP message", rather than a letter this console cannot attest.
const UNREACH_CODE_LETTER = { 0: 'N', 1: 'H', 2: 'P', 3: 'U', 13: 'A' };
function unreachLetter(code) {
  return '!' + (UNREACH_CODE_LETTER[Number(code)] || '?');
}

// One result per probe, in the order the probes were sent. A probe that came back as an ICMP
// destination-unreachable is a letter, not a time: a box prints `4 172.30.36.131 !N !N !N` for
// three refused probes and `2 10.10.20.2 !H * !H` when one of the three went missing
// (research/traceroute-hop-line.md), so the error frame's own round trip is not what the column
// shows.
// The hop-number field of a trace line: three characters wide, right-aligned.
//
// A real box prints hop 1 and hop 10 with the address in the same column - `  1 192.168.173.43` above
// ` 10 108.224.66.161` - because the number is a fixed three-character field and not "a space and the number".
// Two captured IOS-XE traces print exactly that, hops 1-15 and 1-12, with one leading space at 10 where a
// single digit carries two (research/traceroute-hop-line.md cites both). This console printed one space and
// then the number, so every hop from 10 onwards pushed its address - and the probe columns behind it - one
// character to the right: a trace long enough to cross ten routers stopped lining up in the one view a table
// is read down.
function hopNumberField(ttl) {
  const s = String(ttl);
  return s.length >= 3 ? s : ' '.repeat(3 - s.length) + s;
}

function probeCells(probes) {
  return (probes || []).map(function (p) {
    if (!p) return '*';
    if (p.errorType === net.ICMP_DEST_UNREACH) return unreachLetter(p.code);
    if (!p.answered) return '*';
    if (typeof p.rttMs !== 'number' || !isFinite(p.rttMs)) return '*';
    return formatRttMs(p.rttMs) + ' msec';
  }).join('  ');
}


class CliSession {
  constructor(device, topology, simulator) {
    this.device = device;
    this.topo = topology;
    this.sim = simulator;
    this.mode = MODE_EXEC;
    this.iface = null;
  }

  prompt() {
    const host = this.device.config.hostname || this.device.hostname || this.device.name;
    if (this.mode === MODE_CONFIG) return host + '(config)#';
    if (this.mode === MODE_IFACE) {
      // A subinterface is its own mode on a box, and says so in the prompt: `interface Gi0/0.10` answers
      // `Router(config-subif)#`, while its parent answers `Router(config-if)#`. This console called both
      // one mode and printed `(config-if)#` inside a `Gi0/0.10`, so a pasted router-on-a-stick transcript -
      // the one place subinterfaces are used - came back with a prompt no box prints. The question is asked
      // of the interface object the mode was entered on, not of the typed string, so a dotted name that is
      // not a subinterface cannot borrow the spelling.
      // Evidence: research/subinterface-prompt.md.
      const cur = this.iface ? this.device.interfaces.get(this.iface) : null;
      if (cur && cur.type === 'subinterface') return host + '(config-subif)#';
      return host + '(config-if)#';
    }
    // DHCP pool mode is the one prompt that does not follow the `(config-<thing>)#` shape: an IOS box
    // prints `Router(dhcp-config)#`, the words in the other order, and it is the only sub-mode here
    // whose prompt the vendor states in a sentence rather than printing in a capture. Three session
    // transcripts settle it - the 12.4T server guide, the IOS XE 16/17 server guide, and the 3SE
    // Catalyst 3650 guide - and so does every operator paste found; the `(config-dhcp)#` spelling
    // exists in Cisco's own command reference prose and on the CBS350 (a different OS).
    // research/dhcp-pool-prompt.md records both spellings and which one is a capture.
    if (this.mode === MODE_DHCP_POOL) return host + '(dhcp-config)#';
    if (this.mode === MODE_ENABLE) return host + '#';
    return host + '>';
  }

  run(line) {
    const out = [];
    // A pasted config begins with the comment line the printer itself writes
    // ("! PacketForge running-config"), and every CLI in the world ignores it. This one answered
    // "% Unrecognized config command" and carried on, which is how a paste starts with an error
    // before it has read a single command (#1230).
    if (/^\s*[!#]/.test(String(line == null ? '' : line))) return { output: out, actions: [] };
    const tokens = line.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return { output: out, actions: [] };
    // Reassigned in EXEC mode, where a command word may be shortened to what is still unique.
    let head = tokens[0].toLowerCase();

    try {
      if (this.mode === MODE_IFACE) {
        out.push.apply(out, this._ifaceMode(tokens));
      } else if (this.mode === MODE_DHCP_POOL) {
        out.push.apply(out, this._dhcpPoolMode(tokens));
      } else if (this.mode === MODE_CONFIG) {
        out.push.apply(out, this._configMode(tokens));
      } else {
        // exec / enable mode
        // A command word may be shortened to what is still unique: `sh ver`, `conf t`, `en`. A prefix two commands
        // share is reported, not guessed at - IOS refuses it too, and says which words it could have been.
        const spelled = resolveCommandWord(head, EXEC_WORDS);
        if (spelled.rivals.length) {
          return { output: ['% Ambiguous command "' + head + '": ' + spelled.rivals.join(' | ') +
            ' (type more characters)'], actions: [] };
        }
        if (spelled.word) head = spelled.word;
        if (head === 'enable') {
          this.mode = MODE_ENABLE;
        } else if (head === 'configure') {
          // Both words are abbreviable: `config t`, `conf term`, `configure term`. The second word is matched by
          // prefix for the same reason, because `terminal` is the only keyword this console has after `configure` -
          // so a prefix of it is unique by construction and a word that is not one is still refused with the line
          // quoted, as before.
          if (!tokens[1]) {
            out.push('% Incomplete command: configure terminal');
          } else if ('terminal'.indexOf(String(tokens[1]).toLowerCase()) === 0) {
            this.mode = MODE_CONFIG;
            // The greeting belongs to the command that opens the mode, not to the mode: a box prints it once
            // per entry, and prints nothing when the next command is `interface`, `vlan` or `router bgp`.
            out.push(CONFIG_MODE_GREETING);
          } else {
            out.push('% Invalid input: ' + line);
          }
        } else if (head === 'show') {
          out.push.apply(out, this._show(tokens.slice(1)));
        } else if (head === 'ping') {
          out.push.apply(out, this._ping(tokens.slice(1)));
        } else if (head === 'converge') {
          out.push.apply(out, this._converge(tokens.slice(1)));
        } else if (head === 'link') {
          out.push.apply(out, this._link(tokens.slice(1)));
        } else if (head === 'links') {
          out.push.apply(out, this._links());
        } else if (head === 'traceroute') {
          out.push.apply(out, this._traceroute(tokens.slice(1)));
        } else if (head === 'end' && this.mode === MODE_ENABLE) {
          // The line the printer now puts at the end of a config file, read back where a paste usually starts.
          // Cisco's CLI guide says `end` "will always take you back to EXEC mode regardless of which
          // configuration mode or configuration submode you are in", and NX-OS lists its mode as "any command
          // mode"; IOS's own `end` reference only describes it from config modes, so accepting it at `#` (and
          // saying nothing - it is already there) is inference from what the printer needs, not a captured
          // transcript. What it buys is concrete: a file pasted over an enabled session, and the `end` a
          // script appends after one, no longer answer the closing line with `% Unrecognized command: end`
          // (research/running-config-end.md).
        } else if (head === 'exit' || head === 'logout' || head === 'quit') {
          // `exit` at `>` stays at `>` - there is no login to leave. At `#` it used to do nothing at all,
          // so the prompt kept its `#` and typing it again did not help: one level up from privileged EXEC
          // is user EXEC, which is the mode this console always has underneath (#1503).
          if (this.mode === MODE_ENABLE) this.mode = MODE_EXEC;
        } else if (head === 'help' || head === '?') {
          out.push.apply(out, this._help());
        } else {
          out.push('% Unrecognized command: ' + line);
        }
      }
    } catch (e) {
      out.push('% Error: ' + e.message);
    }
    return { output: out, actions: [] };
  }

  // ---------- config mode ----------

  // A capability is a promise about what a box can do with a packet: the catalogue declares it, the engine honours
  // it in the data plane, and until now exactly one command refused configuration on a device that could not keep
  // the promise (`ipv6 nd ra`). Everything else was accepted and then silently inert - a Raspberry Pi took
  // `ip dhcp pool`, `ip route` and `ospf router-id` and created objects nothing on it could use (#1387). The
  // refusal names the capability and the consequence, in the same words the RA gate uses.
  // What to use instead of `switchport` on a box that routes. A host gets no advice, because "this port routes"
  // would be a second wrong statement in the same sentence.
  _routedPortHint() {
    return (this.device && typeof this.device.hasCap === 'function' && this.device.hasCap('l3-forward'))
      ? ' - this port routes: use `ip address <address> <mask>`'
      : '';
  }

  // Which side of a NAT translation a port is on. One setter and one clearer, so the interface command and the
  // `no` form that arrives through global config mode cannot drift apart (#1391).
  // The translation table at the instant this session is asking about, aged first. Reading `dev.natTable`
  // directly showed entries that had been idle longer than their protocol timeout, because ageing only ever ran
  // on the data path (#1393). A device that has never translated anything still has no table: creating one to
  // read it would turn "nothing has crossed" into "an empty table", which are different answers.
  _natTableAt() {
    const dev = this.device;
    if (!dev.natTable) return null;
    if (this.sim && typeof this.sim._natTableOf === 'function') return this.sim._natTableOf(dev);
    return dev.natTable;
  }

  // One sentence for "which ports are inside, and which outside", or the honest statement that nobody has said.
  _natPortsSentence() {
    const inside = [];
    const outside = [];
    this.device.interfaces.forEach(function (i) {
      if (!i || !i.natRole) return;
      if (i.natRole === 'inside') inside.push(i.name);
      else if (i.natRole === 'outside') outside.push(i.name);
    });
    if (!inside.length && !outside.length) {
      return 'Ports: no port is declared inside or outside - a rule may translate on any port';
    }
    return 'Ports: inside ' + (inside.length ? inside.join(', ') : '(none)') +
      ' - outside ' + (outside.length ? outside.join(', ') : '(none)');
  }

  _setNatRole(iface, role) {
    const was = iface.natRole || null;
    if (was === role) return ['Interface ' + iface.name + ' is already the ' + role + ' interface for NAT'];
    iface.natRole = role;
    this._controlPlaneChanged();
    return ['Interface ' + iface.name + ' is now the ' + role + ' interface for NAT' + (was ? ' (was ' + was + ')' : '')];
  }

  _clearNatRole(iface, role) {
    const was = iface.natRole || null;
    if (was !== role) {
      return ['% ' + iface.name + ' is not the ' + role + ' interface' +
        (was ? ' (it is the ' + was + ' interface)' : ' (it has no NAT role)')];
    }
    iface.natRole = null;
    this._controlPlaneChanged();
    return ['Interface ' + iface.name + ' is no longer the ' + role + ' interface for NAT'];
  }

  // A VLAN id arrives as one token, and a word is not one (#1409). `parseInt` answered NaN for it, every gate that
  // normalises before it validates turned that NaN into VLAN 1, and the console then printed the NaN it was still
  // holding - so `switchport access vlan WORD` reported "Access VLAN NaN on 1" and `vlan WORD` created a VLAN
  // numbered NaN, while `show interfaces`, `show vlan` and the saved file all said VLAN 1.
  //
  // The shape of the argument is a console concern (tokens, not values), so it is checked here; the range and the
  // reserved block stay with `validatePortConfig`, which every door shares.
  _vlanIdRefusal(token, what, alternative) {
    const lib = require('./vlan');
    const text = String(token === undefined || token === null ? '' : token).trim();
    const hint = alternative ? ' or "' + alternative + '"' : '';
    if (!text) {
      return '% Incomplete command: give a VLAN id (' + lib.VLAN_MIN + '-' + lib.VLAN_MAX + ')' + hint;
    }
    if (!/^[0-9]+$/.test(text)) {
      return '% Invalid VLAN id "' + text + '": ' + what + ' is a whole number from ' + lib.VLAN_MIN +
        ' to ' + lib.VLAN_MAX + hint;
    }
    const id = parseInt(text, 10);
    if (id < lib.VLAN_MIN || id > lib.VLAN_MAX) {
      return '% VLAN id ' + id + ' is outside ' + lib.VLAN_MIN + '-' + lib.VLAN_MAX;
    }
    return null;
  }

  // The argument of `vlan` is a LIST on a box, not an id. The command reference says so in one sentence: "You can
  // enter a single VLAN ID, a series of VLAN IDs separated by commas, or a range of VLAN IDs separated by
  // hyphens" (Catalyst 9600, IOS XE 17.7, VLAN Commands, `vlan`), the configuration guides write the syntax as
  // `vlan vlan_ID {[-vlan_ID]|[,vlan_ID]}`, and a Catalyst paste of `no vlan 2-1024` is already quoted in
  // research/default-vlan-refusal-wording.md. This console creates and removes one VLAN per command, and it
  // answered a range with `% Invalid VLAN id "10-12": a VLAN id is a whole number from 1 to 4094` - a refusal
  // that says the box's own grammar does not exist, in a sentence an operator can check and find false.
  //
  // Accepting the form is a capability (a list creates many VLANs, each with its own receipt, and `no vlan` needs
  // the same list) and this console is not adding capabilities; what it must not do is misdescribe the vendor's
  // grammar. So the form is refused in its own words, naming the box's spelling and the one-id-per-line this
  // console takes instead (research/vlan-list-argument.md). Only the two global doors use it: an access, native
  // or voice VLAN really does take a single id, and their refusals stay as they are.
  _vlanListRefusal(token, undo) {
    const text = String(token === undefined || token === null ? '' : token).trim();
    if (!/^[0-9]+([-,][0-9]+)+$/.test(text)) return null;
    return '% VLAN list "' + text + '" is not modelled: a box takes a range (10-12) or a comma-separated list ' +
      '(10,12) on `vlan`, and this console takes one id per line - nothing was ' + (undo ? 'removed' : 'changed');
  }

  // `?` is the key an operator presses to ask what goes here, and the free-text positions stored the key as the
  // text itself (#1685): `hostname ?` renamed the box to "?" and printed nothing, `dns zone ?` answered
  // "DNS zone ? ready" and wrote `dns zone ?` into the running-config, and `vlan 42 name ?` created VLAN 42
  // named "?". Every typed position already refuses the key by quoting it (`% Invalid VLAN id "?"`), because a
  // value that will not parse can be corrected; a name will take any string, so the key became the name. Only
  // the whole value is the key: a question mark inside a longer name (`edge?1`) is still part of the name.
  _helpKeyRefusal(value, syntax, consequence, what) {
    if (String(value === undefined || value === null ? '' : value).trim() !== '?') return null;
    return '% "?" is the help key, not ' + (what || 'a name') + ': `' + syntax + '`' +
      (consequence ? ' - ' + consequence : '');
  }

  // The same key, one word earlier (#1694): at the end of a `no` line it is not a question and not a value -
  // the branches read the tokens they need and ignore what follows, so `no vlan 42 name ?` removed VLAN 42,
  // `no hostname ?` cleared the name and `no description ?` cleared the port - each with a receipt shaped like
  // success, which is the defect #1497 and #1685 removed one door over. The damage is done by the words
  // *before* the key, so the check runs before any `no` branch acts, and the refusal is written in the words
  // of the branch it stopped, which is the answer the operator was asking for.
  _noHelpKeyRefusal(tokens) {
    if (!tokens.length || String(tokens[0]).toLowerCase() !== 'no') return null;
    if (String(tokens[tokens.length - 1]).trim() !== '?') return null;
    // `no ?` is the one line where the key really is a question: the word it wanted is missing, so the answer
    // is where the index is rather than a syntax for a branch that was never named.
    if (tokens.length === 2) {
      return '% Incomplete command: `no` needs the command it undoes, e.g. `no vlan <id>`; type `?` on its own' +
        ' for the index - nothing was changed';
    }
    const form = noFormFor(tokens.slice(1), this.mode);
    if (!form) {
      return '% "?" is the help key, not a value: a `no` line undoes a command that is already configured ' +
        '- nothing was changed';
    }
    return '% "?" is the help key, not a value: `' + form.syntax + '` ' + form.effect +
      ' - nothing was ' + (form.undo || 'changed');
  }

  // What is left for the shared validator to say is about the number, not the caller's word for it: the messages
  // are written for whoever validated a port object ("accessVlan 1002 is reserved..."), and the operator typed
  // `switchport access vlan 1002`. Only the field name is swapped; the reason is the validator's.
  _vlanRefusal(chk, what) {
    const first = chk && chk.errors && chk.errors[0];
    if (!first) return '% Invalid VLAN';
    return '% ' + String(first.message).replace(/^(accessVlan|nativeVlan|pvid|voiceVlan)\b/, what);
  }

  // The VLAN-table entry a port's access VLAN needs, written in the same words `vlan <id>` uses, so a VLAN
  // cannot exist only in the port configuration. Returns true when the VLAN was not there and has now been
  // made, which is the one case a real switch announces. VLAN 1 is never created: it is the default VLAN and
  // it exists on every switch before anybody types anything.
  _createVlanForPort(id) {
    const lib = require('./vlan');
    if (id === lib.VLAN_DEFAULT) return false;
    const dev = this.device;
    if (!dev.config.vlans) dev.config.vlans = {};
    if (dev.config.vlans[id]) return false;
    dev.config.vlans[id] = { name: 'VLAN' + String(id).padStart(4, '0') };
    return true;
  }

  _capabilityRefusal(cap, consequence) {
    const dev = this.device;
    if (!dev || typeof dev.hasCap !== 'function' || dev.hasCap(cap)) return null;
    return '% ' + dev.name + ' cannot ' + consequence + ': it has no ' + cap + ' capability';
  }

  // `ip routing` / `no ip routing` - the switch that turns forwarding between networks on and off (#fidelity:
  // ip routing default).
  //
  // The console had the *consequences* of this command modelled and the command itself missing. `show ip route`
  // prints two shapes - the codes legend over a routing table for a box that routes, and the
  // "Default gateway is not set" / Host-Gateway table for one that does not - and which shape a box gets was
  // decided by a catalogue capability no operator can change. So a Catalyst with L3 forwarding could not be put
  // in the state Cisco documents it leaving the factory in ("the switch is in Layer 2 switching mode and IP
  // routing is disabled", Catalyst 3560 Software Configuration Guide, Configuring IP Unicast Routing), and the
  // second shape was reachable only on a box that has no L3 hardware at all.
  //
  // The capability still decides whether the *command* exists: a Catalyst 2960 has no `ip routing` line, so the
  // refusal names the missing capability instead of pretending to store a setting. Everything the flag then
  // changes is already modelled - `Device.isL3()` is what the routing table, the IPv6 router advertisements, the
  // installed-route table and the L3 data path ask, so the four of them cannot disagree.
  _ipRouting(on, rest) {
    const dev = this.device;
    const cannotRoute = this._capabilityRefusal('l3-forward', 'route between networks');
    if (cannotRoute) return [cannotRoute];
    const form = on ? 'ip routing' : 'no ip routing';
    if (rest && rest.length) {
      return ['% `' + form + '` takes no argument: it is the whole command'];
    }
    const before = dev.ipRoutingEnabled();
    dev.config.ipRouting = on;
    if (before === on) return ['IP routing is already ' + (on ? 'enabled' : 'disabled')];
    return [on ? 'IP routing enabled' : 'IP routing disabled'];
  }

  _configMode(tokens) {
    const out = [];
    // A config command word may be shortened to what is still unique, exactly as an EXEC one may: `host r1` is
    // `hostname r1`, `sp priority 4096` is `spanning-tree priority 4096`. A box accepts all of these - the
    // transcript on connecteddots.online prints `Router(config)#int gi0/1` accepted and `do sh run` running the
    // view - while this console refused every shortened config word but `int`. Resolved against the dispatcher's
    // own vocabulary, so a shortening can only reach a door the whole spelling reaches, and a prefix two words
    // share is refused in the same sentence EXEC uses rather than guessed at.
    let head = tokens[0].toLowerCase();
    // `?` and `help` are the console's index. They answered at `>` and `#`, and in the three modes that
    // print a mode in the prompt they were a syntax error - so the one key pressed when unsure said
    // "Unrecognized config command: ?" and implied the key itself was the mistake (#1503). The index
    // already labels each row with the mode it belongs in, so the same list is the right answer here.
    if (head === 'help' || head === '?') return this._help();
    const noKeyed = this._noHelpKeyRefusal(tokens);
    if (noKeyed) return [noKeyed];
    const spelled = resolveCommandWord(head, CONFIG_WORDS);
    if (spelled.rivals.length) {
      return ['% Ambiguous config command "' + head + '": ' + spelled.rivals.join(' | ') + ' (type more characters)'];
    }
    if (spelled.word) head = spelled.word;
    if (head === 'ip' && tokens[1] && tokens[1].toLowerCase() === 'nat' &&
        tokens[2] && /^(inside|outside)$/i.test(String(tokens[2])) && tokens[3] === undefined) {
      // The keyword belongs to a port, not to the box. Saying so beats printing the pool/rule usage, which does
      // not mention inside or outside at all (#1391).
      return ['% ip nat ' + String(tokens[2]).toLowerCase() + ' belongs to an interface: enter one first, ' +
        'e.g. interface Gi0/0/1'];
    }
    if (head === 'ip' && tokens[1] && tokens[1].toLowerCase() === 'nat') {
      // engine/nat.js models static, dynamic and PAT translation, and the flow path translates and emits
      // `nat-drop` -- but nothing in the product ever wrote `config.nat`, so `_isNat()` was always false and
      // the whole mechanism was unreachable. This is the way in (#1366).
      return this._natConfig(tokens.slice(2));
    }
    if (head === 'spanning-tree') {
      // The engine has read `config.stpPriority` since STP was modelled and nothing ever wrote it, so
      // every box in every lab ran the default and the root was decided by MAC address alone. This is
      // the command that reaches it (#1364).
      const dev = this.device;
      if (tokens[1] && tokens[1].toLowerCase() === 'vlan') {
        // IOS spells this per VLAN. This model runs one spanning tree for the device, so accepting a
        // VLAN id would promise a per-VLAN election that does not exist - say so instead of quietly
        // applying it to everything.
        return ['% ' + STP_ONE_TREE + ': use `spanning-tree priority <0-61440>`'];
      }
      // Read the verb before the value. This handler used to take tokens[2] as the priority no matter what
      // tokens[1] said, so every other spanning-tree sub-command was answered as if it were `priority`:
      // `spanning-tree portfast` came back "Usage: spanning-tree priority <0-61440>" and `spanning-tree cost 19`
      // came back "19 is not a valid bridge priority", which is an answer to a question nobody asked (#1493).
      const verb = (tokens[1] || '').toLowerCase();
      if (verb && verb !== 'priority') {
        if (STP_UNMODELLED.indexOf(verb) !== -1) {
          return ['% spanning-tree ' + verb + ' is not modelled: this device runs one spanning tree, and its only ' +
            'tunable is `spanning-tree priority <0-61440 in 4096 steps>`'];
        }
        return ['% Unknown spanning-tree sub-command "' + tokens[1] + '": the only form is ' +
          '`spanning-tree priority <0-61440 in 4096 steps>`'];
      }
      const value = tokens[2];
      if (!value) return ['% Usage: spanning-tree priority <0-61440 in 4096 steps>'];
      if (!/^\d+$/.test(value)) {
        return ['% "' + value + '" is not a bridge priority: `spanning-tree priority` takes a number, ' +
          '0-61440 in steps of 4096'];
      }
      const p = Number(value);
      const stpLib = require('./stp');
      // The range was tested *last*, so the value most likely to be one step too far -
      // `spanning-tree priority 61441` - was answered with the step rule, which then offered
      // "the nearest valid values are 61440 and 65536". 65536 is not a bridge priority, so the correction
      // the console handed back led straight into a second refusal (#1505). The range is asked first, and in
      // the words the neighbouring refusals already use.
      const problem = (p < 0 || p > 61440)
        ? 'the range is 0 to 61440'
        : (p % 4096 !== 0
          ? 'it must be a multiple of 4096 (the low 12 bits are the system ID extension); the nearest valid values are ' +
            (Math.floor(p / 4096) * 4096) + ' and ' + Math.ceil(p / 4096) * 4096
          : null);
      if (problem) return ['% ' + p + ' is not a valid bridge priority: ' + problem];
      const was = dev.config.stpPriority;
      dev.config.stpPriority = p;
      out.push('Bridge priority set to ' + p + ' (lower wins the root election)' +
        (was === null || was === undefined ? '' : ', was ' + was) +
        (dev.isL2 && dev.isL2() ? '' : '; this device has no bridging ports, so no election runs here'));
      this._controlPlaneChanged();
      return out;
    }
    if (head === 'hostname') {
      // The whole remainder is the name. Taking tokens[1] silently truncated
      // "core switch 1" to "core", which is what the UI's hostname field appeared to do
      // (issue #19) - the box was fine, the parser was eating the rest of the line.
      const name = tokens.slice(1).join(' ').trim();
      // `hostname` with nothing after it used to clear the name to null and print nothing at all: a destructive
      // command with no receipt, and the one way to find out was to look at a surface that shows the name (#1497).
      if (!name) return ['% Incomplete command: hostname <name> (the name is unchanged)'];
      // The same destructive silence, one keypress away: `hostname ?` renamed the box to "?" (#1685).
      const keyed = this._helpKeyRefusal(name, 'hostname <name>', 'the name is unchanged');
      if (keyed) return [keyed];
      // The name is all digits: a real box prints `% Hostname contains one or more illegal
      // characters.` and then takes the name anyway - "the name will be accepted after an error is
      // returned", and its own transcript's prompt reads `123(config)#`. This console renamed in
      // silence, so an operator got no word that the name breaks a rule a real box enforces. The
      // sentence is the vendor's verbatim (full stop included) rather than the house `% Warning:`
      // prefix, because recognising the line is the point. It is a warning, not a refusal: no early
      // return, nothing below is skipped, and the name is stored exactly as it was before.
      if (hostnameIsAllNumeric(name)) out.push('% Hostname contains one or more illegal characters.');
      if (!this.device.config.hostname) this.device.nameBeforeHostname = this.device.name;
      this.device.config.hostname = name;
      // device.name is what the UI renders: the canvas label, the inspector header, the
      // status bar. Setting only config.hostname left a device that reported
      // "hostname THE BIFROST" while every surface still said "THE" (issue #21). Both are
      // set from the same text, so they cannot disagree.
      if (name) this.device.name = name;
    } else if (head === 'vlan') {
      const listed = this._vlanListRefusal(tokens[1], false);
      if (listed) return [listed];
      const bad = this._vlanIdRefusal(tokens[1], 'a VLAN id');
      if (bad) return [bad];
      const id = parseInt(tokens[1], 10);
      const chk = require('./vlan').validatePortConfig({ accessVlan: id });
      if (!chk.ok) return [this._vlanRefusal(chk, 'VLAN id')];
      if (!this.device.config.vlans) this.device.config.vlans = {};
      // `name` is a keyword in IOS's vlan sub-mode, not part of the name. Taken literally it stored the VLAN as
      // "name lab", which is a VLAN called "name lab" on every screen that lists names (#1493).
      const rest = tokens.slice(2);
      const usedKeyword = !!rest.length && rest[0].toLowerCase() === 'name';
      const text = (usedKeyword ? rest.slice(1) : rest).join(' ').trim();
      if (usedKeyword && !text) {
        return ['% Incomplete command: name the VLAN with `vlan ' + id + ' name <text>`'];
      }
      // A switch is born with VLAN 1, and every vendor documents it in the same terms: it is "created during
      // system initialization" (Cisco IOS), and it "cannot be created, deleted or renamed" (IOS, NX-OS,
      // Extreme). So `vlan 1` has nothing to create - and the record it used to write was a lie twice over:
      // it announced "VLAN 1 created (name: VLAN0001)" for a VLAN that `show vlan` had been listing as
      // `1 default` since power-on, and it stored a name in the config that the box does not own. The port
      // door already knew this (`_createVlanForPort` refuses to make VLAN 1, and `vlan-auto-create` asserts
      // it); the console door did not.
      if (id === vlanLib.VLAN_DEFAULT) {
        // Renaming the default VLAN is refused in the vendor's own words, as one line with no reason and no
        // suggestion: "Default VLAN 1 may not have its name changed." Five captures carry that sentence - a
        // 2960-class lab (`vlan 1` then `name TEST`), a CCNA exam question that quotes the error, a lab record,
        // a Packet Tracer exercise, and a Cisco Community thread whose subject line is the message itself - and
        // one sibling from the same family is a real box's paste, `%Default VLAN 1 may not have its operational
        // state changed.` (a 2960G). The console used to describe the box instead ("% VLAN 1 is the default
        // VLAN: it cannot be renamed (its name is "default")"), which is a sentence no switch prints and reads
        // as an answer to a question about the name. What was *not* settled is the leading `%`: the direct
        // captures of the name line start at `Default`, while both its siblings carry `%Default ...` with no
        // space after the `%`. The family's form is printed, because the words are the vendor's and the prefix
        // is the one the deletion refusal (`%Default VLAN 1 may not be deleted.`) and this console's error
        // style both use; research/default-vlan-rename-wording.md records the gap and what would close it.
        if (text && text.toLowerCase() !== 'default') {
          return ['%Default VLAN 1 may not have its name changed.'];
        }
        return ['VLAN 1 is the default VLAN: it already exists (name: default), so there was nothing to create'];
      }
      // `vlan 42 name ?` created VLAN 42 and named it "?" (#1685): a role, not just a name - the same keypress
      // that asks what a name is. Refused before the VLAN is made, so nothing is left behind either.
      const keyed = this._helpKeyRefusal(text, 'vlan <id> name <text>', 'nothing was changed');
      if (keyed) return [keyed];
      // A VLAN name is 1 to 32 characters, and the Name column of `show vlan` is exactly those 32: the field and
      // the limit are one fact. This door had no length rule at all, so `vlan 4094 name <40 characters>` stored a
      // name the table could not print - the row ran 8 columns past its cell and pushed `Status` and the ports list
      // right, on the one table an operator holds against a change record. Refused before the VLAN is made, so a
      // rejected name leaves nothing behind, and the count is the name's own so the operator can trim it without
      // counting by eye.
      const limit = vlanLib.VLAN_NAME_MAX;
      if (text.length > limit) {
        return ['% VLAN name "' + text + '" is ' + text.length + ' characters: a VLAN name is 1-' + limit +
          ' characters, so nothing was changed'];
      }
      const name = text || ('VLAN' + String(id).padStart(4, '0'));
      this.device.config.vlans[id] = { name: name };
      out.push('VLAN ' + id + ' created (name: ' + name + ')');
    } else if (head === 'no' && tokens[1] === 'ip' && tokens[2] && tokens[2].toLowerCase() === 'nat' &&
               tokens[3] && /^(inside|outside)$/i.test(String(tokens[3])) && tokens[4] === undefined &&
               this.mode === MODE_IFACE) {
      // `no ip nat inside` typed on a port clears that port's role. It reached the rule handler below, which read
      // "inside" as the start of a rule and answered with the pool/rule usage (#1391).
      return [this._clearNatRole(this.topo.getDevice(this.device.id).interfaces.get(this.iface), String(tokens[3]).toLowerCase())];
    } else if (head === 'no' && tokens[1] === 'ip' && tokens[2] && tokens[2].toLowerCase() === 'nat') {
      const nat = this.device.config.nat || { rules: [], pools: {} };
      const rest = tokens.slice(3).map(function (t) { return String(t).toLowerCase(); });
      if (rest[0] === 'pool') {
        const name = tokens[4];
        if (!name || !nat.pools || !nat.pools[name]) {
          return ['% No NAT pool called "' + (name || '') + '"' +
            (nat.pools && Object.keys(nat.pools).length ? ' (configured: ' + Object.keys(nat.pools).join(', ') + ')' : '')];
        }
        const users = (nat.rules || []).filter(function (r) { return r.pool === name; }).length;
        if (users) {
          return ['% NAT pool "' + name + '" is still used by ' + users + ' rule(s): remove those first'];
        }
        delete nat.pools[name];
        this.device.config.nat = nat;
        this._controlPlaneChanged();
        return ['NAT pool "' + name + '" removed'];
      }
      if (rest[0] === 'inside' && rest[1] === 'source') {
        const rules = nat.rules || [];
        if (!rules.length) return ['% No NAT rules configured'];
        const last = rules[rules.length - 1];
        rules.pop();
        this.device.config.nat = nat;
        this._controlPlaneChanged();
        return ['NAT rule removed: ' + require('./nat').formatRuleLine(last)];
      }
      return ['% Usage: no ip nat pool <name> | no ip nat inside source'];
    } else if (head === 'no' && tokens[1] === 'spanning-tree') {
      const dev = this.device;
      // Read the word after `spanning-tree` here too. This branch used to ignore it entirely and clear the bridge
      // priority whatever was asked, so `no spanning-tree portfast` - a port-level command with no priority in it -
      // wiped a bridge priority the operator had set, and `no spanning-tree flurbish` did the same. The set form was
      // fixed in #1493; the `no` form is the same defect pointing the other way, and it is destructive (#1501).
      const verb = (tokens[2] || '').toLowerCase();
      if (verb === 'vlan') {
        // There is no per-VLAN tree here, so there is nothing to remove - but calling the word unknown says
        // this console has never heard of the concept, while the set form explains it. Both doors answer the
        // same question, so they answer it the same way, and name the removal that does exist (#1509).
        return ['% ' + STP_ONE_TREE + ': there is no per-VLAN tree to remove, so the removal that exists is ' +
          '`no spanning-tree priority`, which takes the bridge priority off'];
      }
      if (verb && verb !== 'priority') {
        if (STP_UNMODELLED.indexOf(verb) !== -1) {
          return ['% spanning-tree ' + verb + ' is not modelled, so there is nothing to remove: this device runs ' +
            'one spanning tree, and its only tunable is `spanning-tree priority <0-61440 in 4096 steps>`'];
        }
        return ['% Unknown spanning-tree sub-command "' + tokens[2] + '": the only form here is ' +
          '`no spanning-tree` (clears the bridge priority), or `no spanning-tree priority`'];
      }
      if (!dev.config.stpPriority && dev.config.stpPriority !== 0) {
        const stpLib = require('./stp');
        return ['% No bridge priority set: the device is using the default ' + stpLib.STP_DEFAULT_PRIORITY];
      }
      const was = dev.config.stpPriority;
      dev.config.stpPriority = null;
      this._controlPlaneChanged();
      const stpLib = require('./stp');
      return ['Bridge priority cleared (was ' + was + '), back to the default ' + stpLib.STP_DEFAULT_PRIORITY];
    } else if (head === 'no' && tokens[1] === 'hostname') {
      // `hostname` was a one-way door: the console accepted it, `show running-config` printed it, and there
      // was no way to take it back short of rewriting the device. A backup you cannot edit back is half a
      // backup.
      const was = this.device.config.hostname;
      if (!was) return ['% No hostname set (the device is named ' + this.device.name + ')'];
      // Restore the name the box had before the hostname was typed, not a guess at a default: `hostname` sets
      // both config.hostname and device.name so the canvas and the console cannot disagree (#21), so undoing
      // it has to put both back or the line stays in the config and the label lies.
      const prior = this.device.nameBeforeHostname || null;
      this.device.config.hostname = null;
      if (prior) this.device.name = prior;
      this.device.nameBeforeHostname = null;
      out.push('Hostname cleared (device is now ' + this.device.name + ')');
    } else if (head === 'no' && tokens[1] === 'vlan') {
      const listed = this._vlanListRefusal(tokens[2], true);
      if (listed) return [listed];
      const bad = this._vlanIdRefusal(tokens[2], 'a VLAN id');
      if (bad) return [bad];
      const id = parseInt(tokens[2], 10);
      // `no vlan 1` answered "% VLAN 1 does not exist" - about the one VLAN that certainly does: the one
      // `show vlan` lists before anybody configures anything, and the one every access port starts in. Real
      // switches refuse the command outright, because the default VLAN is created at initialisation and
      // cannot be removed. What they print is one sentence, and it carries no space after the `%`:
      // "%Default VLAN 1 may not be deleted." Three independent transcripts give it in that shape - a lab
      // 2960-class switch, a forum answer quoting a box, and a Cisco Community thread deleting 1-4094 - and
      // the same sentence appears with 1002, 1003, 1004 and 1005 substituted, one line per VLAN
      // (research/default-vlan-refusal-wording.md). It is printed verbatim, because an operator comparing
      // this console against a box, or a script matching the refusal, has to find the vendor's string; the
      // reason the rule exists belongs in the documentation, not in a line no switch prints.
      if (id === vlanLib.VLAN_DEFAULT) {
        return ['%Default VLAN 1 may not be deleted.'];
      }
      // The other four default VLANs are un-deletable for the same reason, and this branch answered
      // "% VLAN 1002 does not exist" about the one row `show vlan` prints before anybody configures
      // anything - a refusal that contradicted the table beside it. The vendor's range table states the rule
      // and the reason in one line: "1002-1005 | Normal | Cisco defaults for FDDI and Token Ring. You cannot
      // delete VLANs 1002-1005." (Catalyst 6500 15.4SY software configuration guide, Table 26-1; the
      // Catalyst 3560 12.2(25)SEA guide carries the same table, Table 17-1), and the VLAN chapters put it
      // twice more: "VLAN IDs 1 and 1002 to 1005 are automatically created and cannot be removed" and "You
      // cannot delete the default VLANs for the different media types: Ethernet VLAN 1 and FDDI or Token Ring
      // VLANs 1002 to 1005" (Catalyst 2960-CX/3560-CX 15.2(4)E and Catalyst 3850 3.2.0SE, "Configuring
      // VLANs"). So they are not "reserved by IEEE 802.1Q" - the same table files 0 and 4095 under Reserved
      // and these four under Normal - they are Cisco's defaults for media no port here can join.
      //
      // What a real box prints for the attempt used to be unrecorded here, so this answered in the
      // console's own words. It is recorded now, and it is the VLAN 1 sentence with this VLAN's number:
      // "2960X-Gigabit(config)#no vlan 1002 / %Default VLAN 1002 may not be deleted." A range prints one
      // such line per default VLAN it could not remove ("no vlan 2-1024" yields 1002, 1003, 1004, 1005),
      // which is what per-id commands here produce anyway
      // (research/default-vlan-refusal-wording.md).
      const mediaDefault = vlanLib.RESERVED_VLANS.filter(function (r) { return r.id === id; })[0];
      if (mediaDefault) {
        return ['%Default VLAN ' + id + ' may not be deleted.'];
      }
      const have = this.device.config.vlans && this.device.config.vlans[id];
      // It used to print "VLAN 42 removed" whether or not there was one - the same sentence for work done and
      // work not done - and it would remove a VLAN that ports still carried: `show running-config` then
      // stopped printing `vlan 42` while `show vlan` still listed it from the ports, so the table and the
      // config described different switches.
      if (!have) return ['% VLAN ' + id + ' does not exist'];
      // A port that carries the VLAN does not stop the removal, because on the device it does not stop it
      // either: `no vlan 22` deletes the VLAN and the access ports on it go inactive, still assigned to 22
      // (Cisco, "Deleting a VLAN": "any ports assigned to that VLAN become inactive. They remain associated
      // with the VLAN (and thus inactive) until you assign them to a new VLAN"). This console used to refuse
      // instead, on the sound instinct that the config and `show vlan` must not describe different switches -
      // but the device keeps them agreeing a different way, by dropping the VLAN's row and the port's place in
      // it, which is what `show vlan` does now that a missing access VLAN stops adding itself to the table.
      //
      // Two kinds of port still refuse, and both are named:
      //
      //   * a trunk that carries it - whether deleting a VLAN rewrites that trunk's allowed list, leaves it
      //     exactly as typed while the VLAN drops out of the *active* list, or refuses, is not settled by any
      //     source found, so the refusal stays rather than inventing an outcome
      //     (research/trunk-allowed-vlan-on-vlan-delete.md records the evidence and the one paste that would
      //     settle it);
      //   * a port that only references it - a native VLAN or an allowed list stored on a port that is not in
      //     trunk mode yet. Those used to be missed, and removing the VLAN then rewrote the port's staged
      //     configuration in silence: `no vlan 20` said "VLAN 20 removed" and a port that had been staged for
      //     VLAN 20 quietly came back with native VLAN 1.
      const accessCarriers = [];
      const trunkCarriers = [];
      const staged = [];
      for (const i of this.device.interfaces.values()) {
        if (!i.vlan) continue;
        const verdict = vlanLib.classifyEgress(i.vlan, id);
        const action = (verdict && verdict.action) || 'drop';
        // A non-trunk port carries exactly one data VLAN, its access VLAN. The voice VLAN it carries as well is a
        // reference but not a data membership: the port is not "inactive" in the voice VLAN, so deleting that VLAN
        // is refused below rather than reported as a port that lost its VLAN.
        const isAccessVlan = i.vlan.mode !== 'trunk' && Number(i.vlan.accessVlan) === id;
        if (action !== 'drop' && (i.vlan.mode === 'trunk' || isAccessVlan)) {
          if (i.vlan.mode === 'trunk') {
            trunkCarriers.push(i.name + (action === 'untagged' ? ' (native)' : ''));
          } else {
            accessCarriers.push(i.name);
          }
          continue;
        }
        const where = [];
        if (Number(i.vlan.nativeVlan) === id) where.push('trunk native, stored');
        if (Array.isArray(i.vlan.allowedVlans) && i.vlan.allowedVlans.indexOf(id) !== -1) {
          where.push('trunk allowed, stored');
        }
        // The third reference, and the one this guard did not look at (#1701). `switchport voice vlan 20` names a
        // VLAN the port is configured with, live on an access port and stored on a trunk, so deleting the VLAN
        // would leave the port pointing at one that does not exist. The name says which of the two it is, because
        // the two are different states of the same field.
        const voice = i.vlan.voiceVlan;
        if (voice !== null && voice !== undefined && Number(voice) === id) {
          where.push(i.vlan.mode === 'trunk' ? 'voice, no effect' : 'voice');
        }
        if (where.length) staged.push(i.name + ' (' + where.join(', ') + ')');
      }
      const list = function (arr) {
        return arr.slice(0, 5).join(', ') + (arr.length > 5 ? ' (+' + (arr.length - 5) + ' more)' : '');
      };
      if (trunkCarriers.length) {
        return ['% VLAN ' + id + ' is still carried by ' + trunkCarriers.length + ' port(s): ' + list(trunkCarriers) +
          ' - move them off it first'];
      }
      if (staged.length) {
        return ['% VLAN ' + id + ' is still referenced by ' + staged.length + ' port(s): ' + list(staged) +
          ' - clear that first'];
      }
      delete this.device.config.vlans[id];
      // The entries learned in it name a VLAN that is no longer there.
      this.device.flushMacsOnVlan(id);
      out.push('VLAN ' + id + ' removed');
      if (accessCarriers.length) {
        const one = accessCarriers.length === 1;
        out.push(list(accessCarriers) + (one ? ' is' : ' are') + ' now inactive: ' + (one ? 'its' : 'their') +
          ' access VLAN no longer exists (vlan ' + id + ' ' + (one ? 'brings it back' : 'brings them back') + ')');
      }
    } else if (head === 'no' && (tokens[1] === 'interface' || tokens[1] === 'int')) {
      // `no interface range {port-range | macro name}` removes a range a box keeps only for the life of the
      // session; the keyword is refused by name rather than read as a port, like the positive form below.
      if (String(tokens[2] || '').toLowerCase() === 'range') {
        return [interfaceRangeRefusal(tokens.slice(3).join(' '), 'nothing was removed')];
      }
      const typed = tokens.slice(2).join(' ');
      const name = resolvePortName(this.device, typed);
      const vi = name ? this.device.interfaces.get(name) : null;
      if (!vi) return ['% Interface not found: ' + (typed || '')];
      if (!vi.parent) return ['% ' + typed + ' is a physical interface and cannot be removed'];
      this.device.interfaces.delete(name);
      out.push('Subinterface ' + name + ' removed');
    } else if (head === 'access-list') {
      out.push.apply(out, this._accessList(tokens.slice(1)));
    } else if (head === 'no' && tokens[1] === 'access-list') {
      const n = tokens[2];
      if (this.device.config.acls) delete this.device.config.acls[n];
      // A removed list takes its counters with it: leaving them behind would report traffic against a rule
      // that no longer exists, the moment a list of the same number is written again.
      if (this.device.aclHits) delete this.device.aclHits[String(n)];
      const binds = this.device.aclBindings || {};
      for (const k of Object.keys(binds)) {
        if (String(binds[k].in) === String(n)) delete binds[k].in;
        if (String(binds[k].out) === String(n)) delete binds[k].out;
      }
      out.push('Access list ' + n + ' removed');
    } else if (head === 'interface' || head === 'int') {
      if (!tokens[1]) return ['% Incomplete command'];
      // The range keyword is looked for before the port table, because `range` is a keyword on every IOS switch
      // and no panel names a socket `range ...`: the tail is a range or a macro name, never a port.
      if (String(tokens[1]).toLowerCase() === 'range') {
        return [interfaceRangeRefusal(tokens.slice(2).join(' '), 'no port was opened')];
      }
      // An interface name is the whole rest of the line, because some of them contain spaces:
      // Ubiquiti calls its ports "Port 1" and its cages "SFP+ 1", so `interface Port 1` was read as
      // an interface called "Port" and refused - which made those devices' own running-config
      // unreplayable (#1230).
      const typed = tokens.slice(1).join(' ');
      // Both spellings of a port resolve here: the panel name from the spec and
      // the vendor-console name the operator may have typed (issue #27).
      let name = resolvePortName(this.device, typed);
      if (!name) {
        // 'interface Gi0/0.10' creates a router subinterface on Gi0/0.
        const m = /^(.+)\.(\d+)$/.exec(typed);
        const parent = m ? resolvePortName(this.device, m[1]) : null;
        if (m && parent) {
          // The number after the dot is the subinterface's name, not a VLAN id. IOS takes 1 to
          // 4294967293 here and sets the VLAN separately with `encapsulation dot1q` (1 to 4094); the
          // number need not match it (research/subinterface-number.md). This door checked the number
          // against the VLAN range, so `interface Gi0/0.5000` - a name a box opens - was refused as
          // `% VLAN out of range: 5000`, and a `.9999` was answered with a VLAN error for a number that
          // was never a VLAN.
          const num = parseInt(m[2], 10);
          if (!(num >= 1 && num <= 4294967293)) return ['% Subinterface number out of range: ' + m[2]];
          this.device.addSubinterface(parent, num);
          name = parent + '.' + num;
          out.push('Created subinterface ' + name + ' (parent ' + parent + ')');
        } else {
          return ['% Interface not found: ' + typed];
        }
      }
      // `interface Console` opened a port a box cannot open: a console is a line, addressed with `line console 0`,
      // and no IOS `interface` name exists for it. Accepting it also let `ip address` succeed on a socket that
      // carries an operator at a baud rate, and the address then vanished from every table that lists interfaces.
      if (isConsoleLine(this.device.interfaces.get(name))) return [consoleIsALine(name)];
      this.iface = name;
      this.mode = MODE_IFACE;
    } else if (head === 'vrrp') {
      // A group belongs to an interface, so this has to be configured on one - silently attaching
      // it to whichever interface happened to be selected last would be worse than refusing.
      return ['% vrrp is configured per interface: enter an interface first, e.g. interface Gi0/0'];
    } else if (head === 'ip' && tokens[1] === 'dhcp' && tokens[2] === 'pool') {
      // A pool is a named object on the device, not a property of an interface: the same server
      // can hold several, and a client chooses by the subnet its own interface sits in.
      const name = tokens[3];
      if (!name) return ['% Incomplete command: ip dhcp pool <name>'];
      const cannotServe = this._capabilityRefusal('dhcp-server', 'serve DHCP');
      if (cannotServe) return [cannotServe];
      if (!/^[A-Za-z0-9_.-]{1,32}$/.test(name)) return ['% Invalid pool name: ' + name];
      if (!this.device.config.dhcpPools) this.device.config.dhcpPools = [];
      let pool = this.device.config.dhcpPools.filter(function (p) { return p.name === name; })[0];
      if (!pool) {
        pool = { name: name };
        this.device.config.dhcpPools.push(pool);
        out.push('Created DHCP pool ' + name);
      }
      this.pool = name;
      this.mode = MODE_DHCP_POOL;
    } else if (head === 'no' && tokens[1] === 'ip' && tokens[2] === 'dhcp' && tokens[3] === 'pool') {
      const name = tokens[4];
      if (!name) return ['% Incomplete command: no ip dhcp pool <name>'];
      const pools = this.device.config.dhcpPools || [];
      const idx = pools.findIndex(function (p) { return p.name === name; });
      if (idx === -1) return ['% No DHCP pool named ' + name];
      pools.splice(idx, 1);
      if (this.pool === name) this.mode = MODE_CONFIG;
      out.push('DHCP pool ' + name + ' removed');
    } else if (head === 'no' && tokens[1] === 'dns' && tokens[2] === 'zone') {
      const dnsLib = require('./dns');
      const apex = tokens[3];
      if (!apex) return ['% Usage: no dns zone <name>'];
      const key = dnsLib.normalizeName(apex);
      const zones = this.device.config.dnsZones || [];
      const idx = zones.findIndex(function (x) { return dnsLib.normalizeName(x.name) === key; });
      if (idx === -1) return ['% No DNS zone named ' + key];
      const gone = zones[idx];
      zones.splice(idx, 1);
      if (this._dnsZone && dnsLib.normalizeName(this._dnsZone) === key) this._dnsZone = null;
      out.push('DNS zone ' + gone.name + ' removed' +
        (gone.records && gone.records.length ? ' with ' + gone.records.length + ' record(s)' : ''));
    } else if (head === 'scion') {
      const scionLib2 = require('./scion');
      const parsed = scionLib2.parseIsdAs(tokens[1]);
      if (!parsed.valid) out.push('% Invalid SCION ISD-AS "' + (tokens[1] || '') + '" (expected e.g. 1-ff00:0:110)');
      else {
        this.device.config.scionAs = scionLib2.formatIsdAs(parsed.isd, parsed.asHex);
        out.push('SCION ' + this.device.config.scionAs +
          (scionLib2.isCore(this.device.config.scionAs) ? ' (core AS)' : ''));
      }
    } else if (head === 'no' && tokens[1] === 'scion') {
      this.device.config.scionAs = null;
      out.push('SCION membership removed');
    } else if (head === 'ipv6' && tokens[1] === 'route') {
      out.push.apply(out, this._ipv6Route(tokens.slice(2)));
    } else if (head === 'ipv6' && tokens[1] === 'gateway') {
      const v6 = require('./ipv6');
      if (!v6.validateAddress6(tokens[2]).ok) out.push('% Invalid IPv6 gateway "' + (tokens[2] || '') + '"');
      else {
        this.device.config.gateway6 = tokens[2];
        // Typed now, so the config owns it and `show running-config` may print it again.
        this.device.config.gateway6Learned = false;
        out.push('IPv6 default gateway ' + tokens[2]);
      }
    } else if (head === 'ipv6' && tokens[1] === 'nd') {
      out.push.apply(out, this._ipv6Nd(tokens.slice(2)));
    } else if (head === 'no' && tokens[1] === 'ipv6' && tokens[2] === 'nd') {
      out.push.apply(out, this._ipv6Nd(['no'].concat(tokens.slice(3))));
    } else if (head === 'no' && tokens[1] === 'ipv6') {
      this.device.config.gateway6 = null;
      this.device.config.gateway6Learned = false;
      this.device.config.routes6 = [];
      out.push('IPv6 routes cleared');
    } else if (head === 'router' && tokens[1] === 'bgp') {
      out.push.apply(out, this._bgp(['as', tokens[2]]));
    } else if (head === 'no' && tokens[1] === 'router' && tokens[2] === 'bgp') {
      this.device.config.bgp = null;
      this.device.bgpRoutes = [];
      out.push('BGP disabled');
    } else if (head === 'no' && tokens[1] === 'neighbor') {
      const addr = tokens[2];
      if (!this.device.config.bgp) out.push('% BGP is not enabled');
      else {
        const list = this.device.config.bgp.neighbors || [];
        const keep = list.filter(function (x) { return x.address !== addr; });
        this.device.config.bgp.neighbors = keep;
        out.push(keep.length === list.length ? '% No such neighbor ' + addr : 'Removed neighbor ' + addr);
      }
    } else if (head === 'neighbor') {
      out.push.apply(out, this._bgp(tokens.slice(1)));
    } else if (head === 'bgp') {
      out.push.apply(out, this._bgp(tokens.slice(1)));
    } else if (head === 'dns') {
      out.push.apply(out, this._dns(tokens.slice(1)));
    } else if (head === 'ip' && tokens[1] === 'name-server') {
      // One line carries one to six addresses, and the order typed is the order asked.
      //
      // The syntax is the vendor's own: `ip name-server server-address1 [server-address2 ... server-address6]`,
      // and the DNS configuration guide states it in words - "Specifies one or more hosts (up to six) that can
      // function as a name server", with the worked example `Device(config)# ip name-server 172.16.1.111
      // 172.16.1.2` (Cisco IOS XE 17.x IP Addressing Configuration Guide, Configuring DNS; the command
      // reference's parameter table says the same: "a maximum of six name servers"). An access-point guide
      // spells the ordering rule out: "Separate each server address with a space. The first server specified
      // is the primary server."
      //
      // This console read `tokens[2]` and nothing else, so `ip name-server 172.16.1.111 172.16.1.2` stored
      // the first address, answered "Name server 172.16.1.111", and **threw the second away without a word** -
      // a documented command form silently losing half its configuration, which is the defect class of #2004
      // (`speed 100 full` dropping the word after the value). The list is a list: appending in typed order is
      // what makes the box ask the primary first (`_domainServersFor()` walks `config.dnsServers` in order).
      //
      // Everything is checked before anything is stored, because a real console parses the whole line before
      // it executes it: one bad address in a good line configures neither. What a live IOS prints when a line
      // names a seventh server is not settled by any transcript in hand (research/ip-name-server-list.md), so
      // the refusal below is this console's own sentence, not a quoted one.
      const NAME_SERVERS_MAX = 6;
      const typed = tokens.slice(2);
      // A missing address was reported as an invalid one - `Invalid name server "": not an IPv4 address` - so a
      // half-typed line read as a bad value rather than a short line (#1497).
      if (!typed.length) {
        out.push('% Incomplete command: ip name-server <address> [<address2> ... <address6>]');
      } else {
        const bad = typed.filter(function (w) { return !net.isIp(w); });
        const list = Array.isArray(this.device.config.dnsServers) ? this.device.config.dnsServers : [];
        // An address already configured is not a second server, so typing it again cannot push the box past
        // the limit - only genuinely new addresses count towards it.
        const fresh = [];
        for (const ip of typed) {
          if (list.indexOf(ip) === -1 && fresh.indexOf(ip) === -1) fresh.push(ip);
        }
        if (bad.length) {
          out.push('% Invalid name server "' + bad[0] + '": not an IPv4 address');
        } else if (typed.length > NAME_SERVERS_MAX) {
          out.push('% ip name-server takes at most six addresses on one line, and this line names ' +
            typed.length + ': nothing was configured');
        } else if (list.length + fresh.length > NAME_SERVERS_MAX) {
          out.push('% ' + (this.device.name || 'this device') + ' already has ' + list.length +
            ' name server' + (list.length === 1 ? '' : 's') + ': `ip name-server` takes at most six, and this ' +
            'line would make ' + (list.length + fresh.length) + '. Nothing was configured');
        } else {
          this.device.config.dnsServers = list;
          for (const ip of fresh) list.push(ip);
          // One receipt per address named, in typed order - the same line each single address already got.
          for (const ip of typed) out.push('Name server ' + ip);
        }
      }
    } else if (head === 'no' && tokens[1] === 'ip' && tokens[2] === 'name-server') {
      this.device.config.dnsServers = [];
      out.push('Name servers cleared');
    } else if (head === 'ospf') {
      out.push.apply(out, this._ospfConfig(tokens.slice(1)));
    } else if (head === 'no' && tokens[1] === 'ospf') {
      this.device.config.ospf = null;
      this.device.ospfRoutes = [];
      out.push('OSPF disabled');
    } else if (head === 'ip' && tokens[1] === 'routing') {
      out.push.apply(out, this._ipRouting(true, tokens.slice(2)));
    } else if (head === 'no' && tokens[1] === 'ip' && tokens[2] === 'routing') {
      out.push.apply(out, this._ipRouting(false, tokens.slice(3)));
    } else if (head === 'ip' && tokens[1] === 'route') {
      // ip route DEST MASK GW [iface] [distance]   and   ip route DEST MASK <iface> [distance]
      // (the directly-connected form).
      //
      // The number after the next hop is the route's administrative distance, not a port name. The vendor's
      // syntax is `ip route prefix mask { ip-address | interface-type interface-number [ip-address] } [dhcp]
      // [global] [distance] [multicast] [name next-hop-name] [permanent | track number] [tag tag]`, with
      // "distance (Optional) Administrative distance. The range is 1 to 255. The default administrative
      // distance for a static route is 1" (Cisco IOS IP Routing: Protocol-Independent Command Reference,
      // `ip route`, https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/iproute_pi/command/iri-cr-book/iri-cr-a1.html).
      // This console read that slot as an interface and refused `ip route 0.0.0.0 0.0.0.0 198.51.100.1 200`
      // with `no interface called "200"` - so the one command that makes a floating static, the backup route
      // every IOS course configures, could not be typed at all (research/static-route-distance.md).
      const dest = tokens[2], mask = tokens[3];
      const cannotRoute = this._capabilityRefusal('l3-forward', 'install a route');
      if (cannotRoute) return [cannotRoute];
      let gw = tokens[4] || null;
      let iface = null;
      let distance = null;
      if (dest && !net.isIp(dest)) {
        // The word was reported as a *missing* argument when the mask was absent too, so a reader was told to add
        // a mask to a destination that is not an address at all (#1495). The shape of the destination is checked
        // first, then whether the rest of the line arrived.
        return ['% Invalid destination "' + dest + '": not an IPv4 address ' +
          '(the form is `ip route <dest> <mask> <next-hop|interface>`)'];
      }
      if (!dest || !mask) return ['% Incomplete command: ip route <dest> <mask> <gateway|interface>'];
      // The mask was "validated" by a call whose result was thrown away, and `maskToInt()` does not refuse a
      // non-contiguous mask - it turns 255.0.255.0 into an integer and `prefixOf()` then reports 8, so
      // `ip route 192.0.2.0 255.0.255.0 10.1.1.9` answered "Route added: 192.0.2.0/8" and installed a prefix
      // nobody asked for. `ip address` has refused this mask all along (#1411).
      if (!net.isContiguousMask(mask)) {
        // The port door answers this mask in the vendor's words (`Bad mask 0X... for address ...`, see
        // badMaskLine); this door keeps the sentence #1411 gave it, because the only transcript in hand is
        // an `ip address` line typed at an interface prompt and a static route's refusal for the same mask is
        // not witnessed by anything. research/ip-address-bad-mask-hex.md.
        return ['% Invalid mask: ' + mask + ' - a netmask is a run of ones then zeros (255.255.255.0, or 24)'];
      }
      // A port name used to be stored in the *gateway* field: `ip route 10.9.0.0 255.255.0.0 Gi0` kept
      // gw:"Gi0", and the route then tried to ARP for an address called "Gi0" - a route that is listed,
      // installed, printed, and cannot carry a packet, with nothing anywhere saying why. The directly
      // connected form is legal, so it is stored where routeTo() looks for it.
      if (gw) {
        const asPort = resolvePortName(this.device, gw);
        if (asPort) {
          gw = null;
          iface = asPort;
        } else if (!net.isIp(gw)) {
          return ['% ' + dest + '/' + net.prefixOf(mask) + ': "' + gw + '" is neither a next-hop address ' +
            'nor an interface on ' + this.device.name];
        }
      }
      // The words after the next hop, in either order this console accepts: an interface (the vendor's
      // `{ interface-type interface-number }` form) and the administrative distance. A port name is resolved
      // first, so a device whose ports are named by number keeps its own name; every other bare number is the
      // distance. Anything else is quoted back rather than dropped.
      //
      // The fully specified form puts the interface FIRST and the next hop *after* it - the vendor's syntax is
      // `ip route prefix mask { ip-address | interface-type interface-number [ip-address] } [distance]`
      // (Cisco IOS IP Routing: Protocol-Independent Command Reference, `ip route`,
      // https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/iproute_pi/command/iri-cr-book/iri-cr-a1.html ;
      // the same slot in the 4400 ISR guide,
      // https://cisco.com/c/en/us/td/docs/routers/access/4400/software/configuration/xe-16-5/isr4400swcfg-xe-16-5-book/bm_isr_4400_sw_config_guide_chapter_0110.html).
      // This console read every word after the fifth as a port or a distance, so the one form the vendor's own
      // table documents - and the form a CCNA lab types, `R1(config)# ip route 10.2.3.0 255.255.255.0 g0/0/0
      // 10.1.2.2` -> `S 10.2.3.0/24 [1/0] via 10.1.2.2, GigabitEthernet0/0/0`
      // (https://itexamanswers.net/6-1-2-lab-investigate-static-routes-answers.html) - was refused with
      // `no interface called "10.1.2.2"`. An address in this position is the next hop, once the interface has
      // been named and no next hop has; a second one is refused rather than replacing the first.
      for (const tok of tokens.slice(5)) {
        const asPort = resolvePortName(this.device, tok);
        if (asPort) {
          if (iface) return ['% ' + dest + '/' + net.prefixOf(mask) + ': ' + iface +
            ' is an interface, so it cannot also be followed by ' + tok];
          iface = asPort;
          continue;
        }
        if (net.isIp(tok)) {
          if (gw) return ['% ' + dest + '/' + net.prefixOf(mask) + ': a route takes one next hop, and ' +
            gw + ' is already it'];
          gw = tok;
          continue;
        }
        if (distance === null && /^\d+$/.test(tok)) {
          const n = Number(tok);
          if (!(n >= 1 && n <= 255)) {
            return ['% ' + dest + '/' + net.prefixOf(mask) + ': administrative distance ' + tok +
              ' must be 1-255 (the default is 1)'];
          }
          distance = n;
          continue;
        }
        // A word in this position is a port name that did not resolve - the commonest way to get here is a
        // typo in the interface form - so it keeps the sentence that names the misspelling. Only a second
        // number is something else, and that says what it is.
        if (/^\d+$/.test(tok)) {
          return ['% ' + dest + '/' + net.prefixOf(mask) + ': unexpected "' + tok +
            '" - a route takes one administrative distance, and it must be 1-255'];
        }
        return ['% ' + dest + '/' + net.prefixOf(mask) + ': no interface called "' + tok + '"'];
      }
      // With neither a next hop nor an interface there is nothing to send a packet to and no segment to ARP on,
      // and the route was still installed and reported as "on-link" - a route the table then describes with
      // "no next hop: ARP for the destination on that segment", naming a segment the command never mentioned.
      if (!gw && !iface) {
        return ['% Incomplete command: ip route ' + dest + ' ' + mask + ' needs a next hop or an interface'];
      }
      const route = { dest: dest, mask: mask, gw: gw || null, iface: iface };
      // Only when it was typed: an unset distance is the vendor's default of 1, and writing a 1 into every
      // static route would make the saved file differ from the one an operator typed.
      if (distance !== null) route.distance = distance;
      this.device.config.routes.push(route);
      out.push('Route added: ' + dest + '/' + net.prefixOf(mask) +
        (gw ? ' via ' + gw + (iface ? ' ' + iface : '') : (iface ? ' out ' + iface : ' on-link')) +
        (distance !== null ? ' (distance ' + distance + ')' : ''));
      if (!gw && iface) {
        // Legal, and often not what the operator wanted on a segment that is not point-to-point: with no
        // next hop the box ARPs for the *destination* on that wire, and only answers if the router in
        // between proxies ARP for it. Saying so at the moment of configuration is cheaper than letting it
        // look installed and carry nothing.
        out.push('  no next hop: this resolves by ARP on that segment, which needs proxy ARP on the far side');
      }
    } else if (head === 'no' && tokens[1] === 'ip' && tokens[2] === 'route') {
      // The words after the prefix repeat the positive form, so the distance may be named here too:
      // `no ip route 10.0.0.0 255.0.0.0 10.0.0.254 200` removes that one route and leaves a distance-1 route
      // to the same prefix alone. A bare number in the gateway slot is a distance, never a next hop.
      // The removal form repeats the words that made the route, so it reads the same three slots the positive
      // form does: an interface, a next hop, a distance - in either order the parser takes them. A port in the
      // fifth slot used to be stored as a *gateway*, so `no ip route 10.9.0.0 255.255.0.0 Gi0/0/1` matched no
      // row (every directly connected route has `gw: null`) and answered `% Route not found` for a route that
      // was in the table; and the vendor's fully specified order was not read at all.
      const dest = tokens[3], mask = tokens[4];
      let gw = tokens[5] || null;
      let iface = null;
      let distance = null;
      if (gw) {
        const asPort = resolvePortName(this.device, gw);
        if (asPort) {
          iface = asPort;
          gw = null;
        } else if (/^\d+$/.test(gw)) {
          distance = Number(gw);
          gw = null;
        }
      }
      for (const tok of tokens.slice(6)) {
        if (gw === null && net.isIp(tok)) { gw = tok; continue; }
        if (distance === null && /^\d+$/.test(tok)) { distance = Number(tok); continue; }
      }
      const before = this.device.config.routes.length;
      this.device.config.routes = this.device.config.routes.filter(function (r) {
        const rowDistance = (Number.isFinite(Number(r.distance)) && Number(r.distance) >= 1)
          ? Number(r.distance) : 1;
        return !(r.dest === dest && r.mask === mask &&
          (gw == null || r.gw === gw) &&
          (iface == null || (r.iface === iface && (gw !== null || !r.gw))) &&
          (distance == null || rowDistance === distance));
      });
      out.push(before > this.device.config.routes.length ? 'Route removed' : '% Route not found');
    } else if (head === 'ip' && tokens[1] === 'default-gateway') {
      const gw = tokens[2];
      // Accepted anything, including an address that cannot exist: the box then had a gateway no packet could
      // ever be sent to, and said "Default gateway: 300.1.1.1" (#1411).
      if (gw !== undefined && !net.isIp(gw)) {
        return ['% Invalid default gateway "' + gw + '": not an IPv4 address'];
      }
      this.device.config.defaultGateway = gw || null;
      out.push('Default gateway: ' + (gw || '(none)'));
    } else if (head === 'no' && tokens[1] === 'ip' && tokens[2] === 'default-gateway') {
      this.device.config.defaultGateway = null;
      out.push('Default gateway cleared');
    } else if (head === 'exit' || head === 'end') {
      // One level up from config mode is privileged EXEC (`#`), not user EXEC (`>`). Both `exit` and `end`
      // dropped two levels, so a script that left config mode came back with a `>` prompt - a prompt that
      // says the session lost its privileges, when it had lost nothing but a level.
      this.mode = MODE_ENABLE;
    } else if (head === 'show') {
      out.push.apply(out, this._show(tokens.slice(1)));
    } else if (head === 'do') {
      // `do` runs an EXEC command from config mode. This passed `tokens.slice(1)` to `_show()`, which expects the
      // words *after* `show` - so every `do show ...` in every config session answered
      // `% Invalid show command: show vlan`, echoing the command it had just failed to run (#1493).
      // The word after `do` is an EXEC word, so the EXEC table resolves it: a box runs `do sh run`, and `do sh`
      // is what a hand types. `do` itself takes only a `show` here, so a resolved word that is not `show` keeps
      // the refusal below rather than running an EXEC command this console only reaches from `#`.
      const inner = tokens.slice(1).slice();
      const innerSpelled = inner.length ? resolveCommandWord(inner[0], EXEC_WORDS) : { word: null, rivals: [] };
      if (innerSpelled.rivals.length) {
        return ['% Ambiguous command "' + inner[0] + '": ' + innerSpelled.rivals.join(' | ') + ' (type more characters)'];
      }
      if (innerSpelled.word) inner[0] = innerSpelled.word;
      if (inner.length && String(inner[0]).toLowerCase() === 'show') {
        out.push.apply(out, this._show(inner.slice(1)));
      } else {
        out.push('% `do` runs a show command from config mode here: `do show <command>` ' +
          '(for anything else, leave config mode with `end`)');
      }
    } else if (head === 'name') {
      // There is no vlan sub-mode in this model: a VLAN is named on the line that creates it. Typing IOS's
      // sub-mode (`vlan 20`, `name lab`) therefore meets a bare "Unrecognized config command" that says nothing
      // about where the word does belong (#1493).
      out.push('% There is no vlan sub-mode here: name the VLAN on its own line, `vlan <id> name <text>`' +
        ' (e.g. `vlan 20 name lab`)');
    } else {
      out.push('% Unrecognized config command: ' + tokens.join(' '));
    }
    return out;
  }

  // ---------- interface mode ----------
  // A port cannot hold a primary address that lands in a subnet another port on the same box already holds.
  //
  // IOS refuses the command and names the interface that owns the subnet it collided with:
  //
  //     R4(config-if)#ip address 192.168.254.32 255.255.255.192
  //     % 192.168.254.0 overlaps with FastEthernet0/0
  //
  // Three public transcripts print the same sentence with the network of the address being typed - `10.1.0.0`
  // for `10.1.1.2/16` beside `10.1.1.1/16`, and `192.168.254.0` for `.32/26` beside `.1/26` - so the number in
  // the message is the *attempted* network under the *attempted* mask, not the incumbent's:
  //   * https://learningnetwork.cisco.com/s/question/0D53i00000Kt12sCAB/can-one-subnet-be-on-opposite-sides-of-a-router
  //     (`% 192.168.254.0 overlaps with FastEthernet0/0`, and the second port is still `unassigned` afterwards)
  //   * https://learningnetwork.cisco.com/s/question/0D53i00000Ksv3lCAB/two-interfaces-on-the-same-subnet
  //     (`% 10.1.0.0 overlaps with GigabitEthernet0/0`)
  //   * https://community.cisco.com/t5/switching/why-ip-overlapping/m-p/2817656
  //
  // The refusal is the vendor's alone: nothing here explains, because a box says one line and changes nothing -
  // the address is not set, the port keeps what it had. Overlap is asked of the two ranges rather than of "same
  // subnet", because 10.1.1.1/16 and 10.1.2.1/24 are different subnets that still cover the same host, and a
  // box refuses those too.
  //
  // Two things this deliberately does not decide, and says so rather than guessing:
  //   * an interface that is administratively down still blocks the subnet here. One operator reports IOS
  //     allowing the overlap once the incumbent is shut; no vendor page or capture confirms it, so this model
  //     keeps the rule it can cite. research/ip-address-overlap.md records that.
  //   * an address learned by DHCP at run time is not compared, because the check happens while the address is
  //     typed and the lease does not exist yet.
  // An address is also refused for what it *is*, before the box compares it with anything it already holds.
  // Under the mask it was typed with, the all-zeros host part is the subnet's network address and the all-ones
  // host part is its broadcast address; neither is a host address, and a port may hold neither. IOS says the
  // same one line for both, printing the prefix length and echoing the address that was typed:
  //
  //     Router(config-if)#ip address 192.168.1.255 255.255.255.0
  //     Bad mask /24 for address 192.168.1.255
  //     Router(config-if)#ip address 192.168.0.0 255.255.255.0
  //     Bad mask /24 for address 192.168.0.0
  //
  // Four independent raw transcripts print that sentence without a leading `%`:
  //   * https://community.cisco.com/t5/switching/why-not-use-broadcast-subnet/td-p/2137545
  //     (`ip address 192.168.1.255 255.255.255.0` -> `Bad mask /24 for address 192.168.1.255`)
  //   * https://community.cisco.com/t5/switching/bad-mask/td-p/1972424
  //     (HTTS-C6K1, `ip addr 172.30.0.0 255.255.255.0` -> `Bad mask /24 for address 172.30.0.0`)
  //   * https://learningnetwork.cisco.com/s/question/0D53i00000KsxldCAB/ip-address
  //     (four network addresses in a row, each answered `Bad mask /24 for address <what was typed>`)
  //   * https://community.cisco.com/t5/switching/bad-mask-24/m-p/2128552
  //     (`192.168.4.0/24` on `interface vlan 603`, same line)
  // One teaching page prints it with the marker - `% Bad mask /30 for address 172.20.100.96` - and says why
  // the command exists at all: "A Cisco router will only allow a host address to be configured on a Layer 3
  // interface. (The only exception is a /31 Subnet Mask ...)":
  //   * https://www.connecteddots.online/resources/cisco/bad-mask-for-address
  // The unmarked form is the vendor's: the sibling refusal from the same address parser is unmarked too
  // ("Not a valid host address - 0.0.0.1", https://community.cisco.com/t5/switching/
  // what-is-the-lowest-prefix-possible-and-the-lowest-ip/td-p/1214384), so a marker on one and not the other
  // would be this console's invention. research/ip-address-not-a-host.md records the disagreement.
  //
  // **/31 is the exception, and it is documented rather than inferred.** RFC 3021 gives both addresses of a
  // 31-bit prefix to the two ends of a point-to-point link, and Cisco's own configuration guide says it in as
  // many words - "the use of a 31-bit prefix ... allows the all-zeros and all-ones IP addresses to be assigned
  // as host addresses" - with `ip address 192.168.100.4 255.255.255.254` as the worked example:
  //   * https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr_ipv4/configuration/15-s/ipv4-15-s-book/configuring_ipv4_addresses.html
  //   * https://www.cisco.com/c/en/us/support/docs/ip/routing-information-protocol-rip/13788-3.html
  //     (`R1(config-if)#ip address 192.168.1.0 255.255.255.254` - the all-zeros address of its /31, accepted)
  // The same guide says classless addressing must be on first; it is the default in every IOS this model
  // speaks for, and no `ip classless` command exists here to turn it on, so the exemption is unconditional.
  //
  // **The /32 is refused on a port, and it is documented rather than inferred.** A 32-bit mask describes a
  // subnet with exactly one address and no host space at all, so a box will not put one on a link that is
  // meant to reach another box; Cisco says why and where the value does belong: "A subnet mask of
  // 255.255.255.255 (a /32 subnet) describes a subnet with only one IPv4 host address. These subnets cannot
  // be used to assign address to network links because they always need more than one address per link. The
  // use of /32 is strictly reserved for use on links that can have only one address. The example for Cisco
  // routers is the loopback interface."
  //   * https://www.cisco.com/c/en/us/support/docs/ip/routing-information-protocol-rip/13788-3.html
  // Three independent transcripts print the refusal for a non-loopback port, on three different platforms:
  //   * a GRE tunnel on IOS 12.x - `R1(config-if) address 10.0.0.1 255.255.255.255` answers
  //     `Bad mask /32 for address 10.0.0.1`, and the accepted answer states the rule: "You cannot directly
  //     configure a /32 address on tunnel (or other physical interface). You need to configure it on a
  //     loopback interface" (https://community.cisco.com/t5/routing/tunnel-interface-32-host-mask/td-p/2134221)
  //   * a serial port on a 2811 running 15.0(1)M10 - `ip add 123.123.123.123 255.255.255.255` answers
  //     `Bad mask /32 for address 123.123.123.123`
  //     (https://www.reddit.com/r/ccna/comments/8ett29/assign_32_to_an_interface/)
  //   * a 4331's routed port on IOS XE - `ip address 12.0.0.1 255.255.255.255` answers
  //     `Bad mask /32 for address 12.0.0.1`
  //     (https://community.cisco.com/t5/routing-and-sd-wan/subnet-mask-255-255-255-255-by-dhcp/td-p/4091332)
  // The one thread this note used to cite for the physical/loopback split is the first of those, read from the
  // other side: https://learningnetwork.cisco.com/s/question/0D53i00000KswrtCAB/subnet-mask-255255255255
  // (`Bad mask /32 for address 192.168.2.1` on the port, the same mask taken on a loopback). A loopback is the
  // vendor's exception, not a hole in the rule, so the refusal stands down for an interface of that type -
  // which this model does not build - and applies to every port it does.
  // research/ip-address-not-a-host.md carries the sources.
  //
  // Two things this deliberately leaves alone:
  //   * a /0, where the network address and the broadcast address are the same address and nothing in hand
  //     says which sentence a box prints. Unchanged.
  //   * the other reserved blocks - 224/4 above all - which are a separate sentence from a separate check and
  //     are left alone because the evidence for them is one unverifiable snippet. See the section below.
  //
  // **Some addresses are not host addresses under any mask, and the box says so in its own words.** Before it
  // looks at the mask at all, IOS refuses an address in 0.0.0.0/8 or 127.0.0.0/8 - the "this network" and
  // "loopback" blocks - with a sentence that names the address and no prefix:
  //
  //     Rack1R1(config-if)#ip add 0.0.0.1 255.255.255.0
  //     Not a valid host address - 0.0.0.1
  //     Rack1R1(config-if)#ip add 0.0.0.2 255.255.255.0
  //     Not a valid host address - 0.0.0.2
  //     (https://community.cisco.com/t5/switching/what-is-the-lowest-prefix-possible-and-the-lowest-ip/td-p/1214384)
  //
  //     R1(config-if)#ip address 127.0.0.2 255.255.255.0
  //     Not a valid host address - 127.0.0.2
  //     R1(config-if)#ip address 127.1.1.1 255.255.255.0
  //     Not a valid host address - 127.1.1.1
  //     (https://learningnetwork.cisco.com/s/question/0D53i00000KsviSCAR/ping-127001-in-router-failed - on
  //     `interface loopback0`, the one type that takes a /32)
  //
  //     R2(config-if)#ip address 127.0.0.100 255.255.0.0
  //     Not a valid host address - 127.0.0.100
  //     (https://learningnetwork.cisco.com/s/question/0D53i00000KszT6CAJ/ipv6-interface-loopback-address)
  //
  // Three things the pastes establish: the sentence carries no leading `%`, like its `Bad mask` sibling; it
  // echoes the address exactly as typed; and it is the same for a /16 and a /24, which is why the range is
  // tested before the mask - the words name an address, never a prefix. The loopback transcript is the sharp
  // one: 127/8 is refused on a loopback interface, so the /32 exception above stays a *mask* rule and does not
  // reach this one.
  //
  // 0.0.0.0 itself is left out of the block on purpose. Whether a box takes `ip address 0.0.0.0 0.0.0.0` is the
  // /0 question this note has always left open, and a first-octet test would answer it by accident rather than
  // by evidence. research/ip-address-host-range.md has the sources, the ordering argument, and the two blocks
  // this rule does not cover - 224/4 and 255.255.255.255 - with what would settle each.
  _ipHostRefusal(iface, ip, dotted) {
    const netLib = require('./net');
    const text = String(ip);
    const firstOctet = Number(text.split('.')[0]);
    if ((firstOctet === 0 && text !== '0.0.0.0') || firstOctet === 127) {
      return 'Not a valid host address - ' + text;
    }
    const bits = netLib.prefixOf(dotted);
    // A /32 is the mask that says "this subnet is one address", and a box keeps it for a link that has
    // only itself to reach (the loopback); on a port it answers with the same `Bad mask` sentence the
    // network and broadcast refusals use. The type is asked of the interface rather than assumed, so the
    // vendor's exception is stated in the code and a loopback - if one is ever built - keeps its /32.
    if (bits === 32) {
      if (iface && /^loopback/i.test(String(iface.type || ''))) return null;
      return 'Bad mask /32 for address ' + ip;
    }
    if (!(bits >= 1 && bits <= 30)) return null;
    if (netLib.ipToInt(ip) === netLib.networkOf(ip, dotted) ||
        netLib.ipToInt(ip) === netLib.broadcastOf(ip, dotted)) {
      return 'Bad mask /' + bits + ' for address ' + ip;
    }
    return null;
  }

  // Whether a port is in the routing table at all, which is the thing the overlap rule is about: one
  // subnet, one wire. A port that is administratively down installs no connected route, so it neither
  // reserves its subnet nor collides with one; a subinterface whose parent is shut is in the same
  // position, because its route goes out through the parent. Read from the same `enabled` flag
  // `show interfaces` prints, not from a second copy of the state.
  _portReservesSubnet(iface) {
    if (!iface || iface.enabled === false) return false;
    if (iface.parent) {
      const parent = this.device.interfaces.get(iface.parent);
      if (parent && parent.enabled === false) return false;
    }
    return true;
  }

  _ipOverlapRefusal(iface, ip, dotted, opts) {
    const netLib = require('./net');
    const atLinkUp = !!(opts && opts.atLinkUp);
    // A shut port takes an overlapping address without a word: `no shutdown` is where the box refuses
    // (`atLinkUp` says the port is being opened, so its own admin state is what is about to change, not
    // what decides). A live port asked at `ip address` time is checked here, before anything is stored.
    if (!atLinkUp && !this._portReservesSubnet(iface)) return null;
    const start = netLib.networkOf(ip, dotted);
    const end = netLib.broadcastOf(ip, dotted);
    for (const other of this.device.interfaces.values()) {
      if (other === iface) continue;
      if (!this._portReservesSubnet(other)) continue;
      if (!other.ip || !other.mask) continue;
      if (!netLib.isContiguousMask(other.mask)) continue;
      const oStart = netLib.networkOf(other.ip, other.mask);
      const oEnd = netLib.broadcastOf(other.ip, other.mask);
      if (start <= oEnd && oStart <= end) {
        return '% ' + netLib.intToIp(start) + ' overlaps with ' + other.name;
      }
    }
    return null;
  }

  _ifaceMode(tokens) {
    const out = [];
    const iface = this.device.interfaces.get(this.iface);
    if (tokens[0] === undefined) return out;
    let head = tokens[0].toLowerCase();
    if (head === 'help' || head === '?') return this._help();
    const noKeyed = this._noHelpKeyRefusal(tokens);
    if (noKeyed) return [noKeyed];

    // What the operator typed, before any word is rewritten: a refusal at the end of this function names their
    // line, not the line it was resolved into (`sh port-c 1` answers about `show port-c`, and the same rule holds
    // here). The words themselves are rewritten in place so every handler below - each of which slices its own
    // arguments off `tokens` - sees the whole spelling.
    const typedLine = tokens.join(' ');
    const resolveAt = function (pos, table) {
      const r = resolveCommandWord(tokens[pos], table);
      if (r.rivals.length) {
        return { refuse: '% Ambiguous interface command "' + tokens.slice(0, pos + 1).join(' ') + '": ' +
          r.rivals.join(' | ') + ' (type more characters)' };
      }
      if (r.word) tokens[pos] = r.word;
      return {};
    };
    const headWord = resolveAt(0, IFACE_WORDS);
    if (headWord.refuse) return [headWord.refuse];
    head = tokens[0].toLowerCase();
    // The word after the head, at the positions where this console has a complete table (see IFACE_WORDS above).
    // A head without an entry here takes a value or a name next - a VLAN id, an address, a description - and is
    // left exactly as typed.
    const subTable = { ip: IFACE_IP_WORDS, ipv6: IFACE_IPV6_WORDS, switchport: IFACE_SWITCHPORT_WORDS,
      encapsulation: IFACE_ENCAP_WORDS, clock: IFACE_CLOCK_WORDS }[head];
    if (subTable) {
      const subWord = resolveAt(1, subTable);
      if (subWord.refuse) return [subWord.refuse];
      if (head === 'switchport' && tokens[1] === 'mode') {
        const modeWord = resolveAt(2, IFACE_SWITCHPORT_MODE_WORDS);
        if (modeWord.refuse) return [modeWord.refuse];
      }
    } else if (head === 'no') {
      const noWord = resolveAt(1, IFACE_NO_WORDS);
      if (noWord.refuse) return [noWord.refuse];
      // `no ip add` / `no ipv6 add` - the same table one position further in, so the negation reaches the form
      // the operator meant. `no ip` on its own keeps its existing answer (it takes no argument).
      if (tokens[1] === 'ip') {
        const inner = resolveAt(2, IFACE_IP_WORDS);
        if (inner.refuse) return [inner.refuse];
      } else if (tokens[1] === 'ipv6') {
        const inner = resolveAt(2, IFACE_IPV6_WORDS);
        if (inner.refuse) return [inner.refuse];
      }
    }

    // IOS treats a new `interface <name>` line inside interface mode as a mode switch, not as an
    // error. Configs copied out before #1230 rely on exactly this, because they have no `exit`
    // between blocks; the config-mode handler already knows how to open an interface (including a
    // dot1q subinterface), so reuse it.
    //
    // A name the box cannot open is a different thing from a name it opens. The parser refuses the
    // line before it runs, so nothing about the session changes - a box answers the refusal and
    // leaves the cursor on the interface it was already on. This console stepped down to
    // `(config)#` *before* asking the config-mode door, so `interface Fa9/9` at `(config-if)#`
    // printed `% Interface not found: Fa9/9` and then a prompt one level up, and the next line
    // typed - a `description`, a `no ip address` - landed nowhere instead of on the port under the
    // cursor. The step down is taken back unless a port was actually opened: the door sets
    // MODE_IFACE itself when it succeeds (a new name, a new dot1q subinterface), so a mode still
    // reading `config` after the call means the line was refused and the session never moved.
    // research/interface-refusal-mode.md has the captures.
    if (head === 'interface' || head === 'int') {
      const was = this.mode;
      this.mode = MODE_CONFIG;
      try {
        return this._configMode(tokens);
      } finally {
        if (this.mode === MODE_CONFIG) this.mode = was;
      }
    }

    if (head === 'vrrp') {
      // A virtual router answers for an address on behalf of a box that routes. Without l3-forward there is
      // nothing behind the group to answer for (#1387).
      const cannotRoute = this._capabilityRefusal('l3-forward', 'run a VRRP group');
      if (cannotRoute) return [cannotRoute];
      const res = this._vrrpIfaceCommand(tokens);
      if (res) return res;
    }
    if (head === 'no' && tokens[1] === 'vrrp') {
      const vrid = parseInt(tokens[2], 10);
      const groups = (this.device.config.vrrp || []);
      const mine = groups.filter(function (g) {
        return g.vrid === vrid && g.interface === this.iface;
      }, this);
      if (!mine.length) return ['% No VRRP group ' + tokens[2] + ' on ' + this.iface];
      // What follows the vrid decides whether the *group* goes or one *setting* does. IOS's `no` form of an
      // attribute command removes that attribute and leaves the virtual router standing: "To disable this
      // function, use the no form of this command" (Cisco IOS First Hop Redundancy Protocols Command
      // Reference, `vrrp preempt`, syntax `no vrrp group preempt`,
      // https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipapp_fhrp/command/fhp-cr-book/fhp-v1.html), and the
      // configuration guide's own sample lists `no vrrp 100 preempt` in the same interface block as
      // `vrrp 100 ip 10.1.0.100` (Cisco IOS IP Application Services Configuration Guide, Configuring VRRP).
      //
      // This branch read the vrid and nothing after it, so `no vrrp 42 preempt` deleted the group - and the
      // printer writes exactly that line for a group whose preemption is off (`  no vrrp <vrid> preempt` in
      // `_runningConfig`), so a config this console printed could not be pasted back: the paste took the
      // virtual gateway with it. A printed line must not destroy the object it describes.
      // See research/vrrp-no-form-scope.md and docs/plans/undo-granularity.md step 2.
      const undo = String(tokens[3] || '').toLowerCase();
      if (!undo) {
        this.device.config.vrrp = groups.filter(function (g) {
          return !(g.vrid === vrid && g.interface === this.iface);
        }, this);
        return ['VRRP group ' + vrid + ' removed from ' + this.iface];
      }
      const vrrpLib = require('./vrrp');
      const group = mine[0];
      if (undo === 'preempt') {
        group.preempt = false;
        return ['VRRP group ' + vrid + ' preempt disabled'];
      }
      if (undo === 'priority') {
        group.priority = vrrpLib.VRRP_DEFAULT_PRIORITY;
        return ['VRRP group ' + vrid + ' priority reset to ' + vrrpLib.VRRP_DEFAULT_PRIORITY];
      }
      if (undo === 'advertise' || undo === 'advertisement') {
        group.advertSec = vrrpLib.VRRP_DEFAULT_ADVERT_SEC;
        return ['VRRP group ' + vrid + ' advertises every ' + vrrpLib.VRRP_DEFAULT_ADVERT_SEC + ' s'];
      }
      // Anything else is a word this console cannot unset, and it is refused rather than read as the bare form:
      // the guess that costs the most is the one that answers a `no` about one setting by deleting the group.
      return ['% Unrecognized vrrp command: ' + tokens.join(' ') +
        ' (this console can unset: priority, preempt, advertise - `no vrrp ' + vrid + '` removes the group)'];
    }
    if (head === 'ip' && tokens[1] && String(tokens[1]).toLowerCase() === 'nat') {
      // `ip nat inside` / `ip nat outside` - which side of the translation this port is on. The model translated
      // on every port in both directions, so a rule for 192.168.10.0/24 rewrote the source of a packet going from
      // one inside host to another. The two words that say which side is which were missing (#1391).
      const cannotTranslate = this._capabilityRefusal('nat', 'translate addresses');
      if (cannotTranslate) return [cannotTranslate];
      const role = tokens[2] ? String(tokens[2]).toLowerCase() : '';
      if (role !== 'inside' && role !== 'outside') {
        return ['% Usage: ip nat inside | ip nat outside'];
      }
      return [this._setNatRole(iface, role)];
    }
    if (head === 'ip' && tokens[1] === 'address' && String(tokens[2] || '').indexOf('/') !== -1) {
      // `ip address 10.0.0.1/24` was answered with "% Incomplete command", which says nothing about what is
      // wrong or what would work. The address-and-prefix spelling is what almost every other tool takes, so
      // the refusal names the problem and both forms this parser accepts.
      const parts = String(tokens[2]).split('/');
      const bits = parts[1];
      const maskFromPrefix = require('./net').maskFromPrefix;
      const dotted = /^\d+$/.test(bits) && parseInt(bits, 10) <= 32
        ? maskFromPrefix(parseInt(bits, 10)) : '255.255.255.0';
      return ['% "' + tokens[2] + '" is an address with a prefix length, not an address and a mask: use ' +
        '"ip address ' + parts[0] + ' ' + dotted + '" or "ip address ' + parts[0] + ' ' + bits + '"'];
    }
    if (head === 'ip' && tokens[1] === 'address') {
      if (tokens[2] === 'dhcp') {
        // `ip address dhcp` is the whole line. A word after it was swallowed and the port was still put
        // into DHCP client mode, so `ip address dhcp 10.0.0.5` - a line somebody writes when they mean
        // `ip address 10.0.0.5` - read as a request for a leased address and said nothing about the
        // number it dropped.
        if (tokens[3]) {
          return ['% ip address dhcp takes no argument: the word "' + tokens.slice(3).join(' ') +
            '" was not used, and the port was not changed'];
        }
        // A port has one method, and this used to leave both: `ip address dhcp` set the DHCP flag while the
        // static address stayed on the interface. Three surfaces then disagreed - the port held an address it
        // did not own, `show ip interface brief` reported Method DHCP beside that address, and
        // `show running-config` printed only the static line, so a restore lost the DHCP intent entirely.
        // Setting the method displaces the other one, and says which.
        const had = iface.ip ? iface.ip + '/' + require('./net').prefixOf(iface.mask) : null;
        iface.dhcp = true;
        iface.ip = null;
        iface.mask = null;
        out.push('Interface ' + iface.name + ' set to DHCP' +
          (had ? ' (static address ' + had + ' removed)' : ''));
      } else {
        const ip = tokens[2], mask = tokens[3];
        if (!ip || !mask) return ['% Incomplete command'];
        net.ipToInt(ip);                       // an address error is reported as an address error
        // A netmask must be a run of ones then zeros, and a bad mask is reported as a *mask* - the old
        // code let maskToInt() throw and the message came out as "Invalid IPv4 address: garbage",
        // pointing at the wrong argument (#1249).
        //
        // A mask that is a dotted quad and not a run of ones is the case the box has words for, and it
        // prints them: `Bad mask 0XFF00FF00 for address 10.0.0.1`. This console said
        // `% Invalid mask: 255.0.255.0 - a netmask is a run of ones then zeros ...` instead - a sentence no
        // box prints, with the mask in the decimal spelling the box does not use here (badMaskLine, at the
        // foot of this file; research/ip-address-bad-mask-hex.md). A mask that is not a dotted quad at all (junk, a prefix length
        // out of range) keeps this console's own sentence, because the box's line quotes a mask word that does
        // not exist and nothing in hand says what it prints for junk.
        if (!net.isContiguousMask(mask)) {
          if (net.isIp(mask)) return [badMaskLine(ip, mask)];
          return ['% Invalid mask: ' + mask + ' - a netmask is a run of ones then zeros (255.255.255.0, or 24)'];
        }
        // The line documents one optional word after the mask and no more: `ip address ip-address mask
        // [secondary]` (Cisco, `ip address` command reference: "An interface can have one primary IP
        // address and multiple secondary IP addresses",
        // https://www.cisco.com/E-Learning/bulk/public/tac/cim/cib/using_cisco_ios_software/cmdrefs/ip_address.htm),
        // and any other word is a parse error rather than a success - `% Invalid input detected at '^'
        // marker.`, the message Cisco's CLI chapter defines as "you entered the command incorrectly",
        // with the caret under the word it could not read
        // (https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/fundamentals/configuration/xe-16-6/fundamentals-xe-16-6-book/cf-cli-basics.pdf).
        //
        // This console swallowed the word and applied the address anyway. For one word in particular
        // that was the wrong change and not merely a silent one: `ip address 10.0.0.2 255.255.255.0
        // secondary` on a box ADDS a second address and leaves the primary in place - Cisco's own
        // worked example prints 131.108.1.27 as primary with two `secondary` lines beside it - while
        // here it replaced the primary and reported "IP address set", so a port that had 10.0.0.1/24
        // came back holding 10.0.0.2/24 and nothing said the first address was gone.
        //
        // A second address on one port is not modelled (one address per port, the same one the front
        // panel and `show ip interface brief` print), so `secondary` cannot be honoured. It is refused
        // by name and nothing is changed, which is the honest answer: the alternative - treating it as
        // "set the primary" - is the bug this replaces.
        if (tokens[4]) {
          const extra = tokens.slice(4).join(' ');
          if (String(tokens[4]).toLowerCase() === 'secondary') {
            return ['% ip address <ip> <mask> secondary adds a second address to this port, which ' +
              'this console does not model: one address per port, and the address was not changed'];
          }
          return ['% ip address takes an address and a mask, and then only "secondary": the word "' +
            extra + '" was not used, and the address was not changed'];
        }
        // Store the dotted form whichever way it was typed: a port left holding "24" reads as /2 to
        // anything that parses a dotted mask, the front panel included.
        const dotted = net.maskFromPrefix(net.prefixOf(mask));
        // A subnet this box already holds on another port is refused, in the vendor's one line, with the port
        // keeping whatever it had. See `_ipOverlapRefusal()` for the transcripts and the two open questions.
        // What the address *is* comes before what the box already holds: a network or broadcast address is not
        // a host address under the mask it was typed with, so nothing is applied and the subnet is not
        // compared. (Which of the two validations a real box runs first is not witnessed by anything in hand;
        // the order is invisible unless a command is both, e.g. `ip address 10.0.0.0 255.255.255.0` while
        // 10.0.0.1/24 sits on another port, and there the address is wrong on its own terms.)
        const notHost = this._ipHostRefusal(iface, ip, dotted);
        if (notHost) return [notHost];
        const overlap = this._ipOverlapRefusal(iface, ip, dotted);
        if (overlap) return [overlap];
        // The other half of the same rule: a static address displaces the DHCP client, and says so, rather
        // than quietly changing the port's method.
        const wasDhcp = iface.dhcp === true;
        iface.ip = ip; iface.mask = dotted; iface.dhcp = false;
        out.push('IP address set on ' + iface.name + ': ' + ip + '/' + net.prefixOf(dotted) +
          (wasDhcp ? ' (DHCP client removed)' : ''));
      }
    } else if (head === 'no' && tokens[1] === 'ip' && tokens[2] === 'address') {
      // Two forms, not one. The bare `no ip address` removes what the port holds; the reference's `no`
      // line also takes the address being removed - `no ip address ip-address mask [secondary]`
      // (Cisco, `ip address`, https://www.cisco.com/E-Learning/bulk/public/tac/cim/cib/using_cisco_ios_software/cmdrefs/ip_address.htm,
      // whose syntax block prints both lines) - and a Cisco defect record's own workaround is an operator
      // doing exactly that on a live SVI:
      //
      //     (config-if)#no ip address 192.168.1.100 255.255.255.0
      //     (config-if)#ip address 192.168.1.100 255.255.255.0
      //
      // (CSCvr84846, https://www.findbugzero.com/operational-defect-database/vendors/cisco/defects/CSCvr84846).
      // The named address is matched, not ignored: the answer given to the same two-word form with an
      // address the port does not hold is "you need to match the current ip of the interface"
      // (https://community.spiceworks.com/t/removal-of-an-ip-from-a-vlan-in-a-cisco-switch/1057490, where
      // the box answered `Invalid address` and kept its address).
      //
      // This branch used to refuse every word here, so the documented form - and the only way to remove
      // one named address from a file replayed against a port that holds a different one - was answered
      // with a sentence claiming the command takes no argument at all. What the word did before that
      // refusal existed was worse: it was dropped and the primary was removed anyway.
      //
      // `secondary` stays refused by name: one address per port is all this model has
      // (research/ip-address-trailing-word.md), so the form that removes *only* a secondary cannot be
      // honoured.
      const netLib = require('./net');
      const named = tokens.slice(3);
      if (named.length) {
        const namedSecondary = named.length > 1 && named.slice(1).some(function (w) {
          return String(w).toLowerCase() === 'secondary';
        });
        if (namedSecondary) {
          return ['% no ip address <ip> <mask> secondary removes a secondary address, which this console ' +
            'does not model: one address per port, and nothing was removed'];
        }
        // One word is the documented form with its mask left off, which a box refuses as incomplete.
        if (named.length === 1 && netLib.isIp(named[0])) {
          return ['% Incomplete command: no ip address <address> <mask> - a named removal needs both'];
        }
        const twoWords = named.length === 2 && netLib.isIp(named[0]) && netLib.isContiguousMask(named[1]);
        if (twoWords) {
          const wantedPrefix = netLib.prefixOf(named[1]);
          // A leased address is not a configured one: a DHCP client's address is written by the box at run
          // time and never appears as an `ip address` line, so naming it here is not a removal the file
          // could have asked for. The bare form removes the client.
          if (iface.dhcp === true) {
            return ['% Invalid address: ' + named[0] + '/' + wantedPrefix + ' is not configured on ' +
              iface.name + ' (it is a DHCP client, and `no ip address` removes the client), and nothing ' +
              'was removed'];
          }
          const holds = iface.ip ? iface.ip + '/' + netLib.prefixOf(iface.mask) : null;
          const matches = !!holds && netLib.ipToInt(named[0]) === netLib.ipToInt(iface.ip) &&
            wantedPrefix === netLib.prefixOf(iface.mask);
          if (!matches) {
            // The vendor's two words are `Invalid address`; the sentence after them is this console's,
            // because no capture in hand shows more than the two words (research/no-ip-address-named-form.md).
            return ['% Invalid address: ' + iface.name + ' holds ' + (holds || 'no address') + ', not ' +
              named[0] + '/' + wantedPrefix + ' - nothing was removed'];
          }
          iface.ip = null; iface.mask = null; iface.dhcp = false;
          return ['IP address ' + holds + ' removed from ' + iface.name];
        }
        return ['% no ip address takes an address and a mask, or nothing (the word "' +
          named.join(' ') + '" was not used, and nothing was removed)'];
      }
      // "IP address removed" was the answer whether or not there was one to remove, and whether the port was
      // asking DHCP for one or not.
      const hadIp = iface.ip ? iface.ip + '/' + require('./net').prefixOf(iface.mask) : null;
      const hadDhcp = iface.dhcp === true;
      iface.ip = null; iface.mask = null; iface.dhcp = false;
      if (!hadIp && !hadDhcp) out.push('% No IP address on ' + iface.name);
      else if (hadIp && hadDhcp) out.push('IP address ' + hadIp + ' and the DHCP client removed from ' + iface.name);
      else if (hadDhcp) out.push('DHCP client removed from ' + iface.name);
      else out.push('IP address ' + hadIp + ' removed from ' + iface.name);
    } else if (head === 'shutdown' && tokens.length > 1) {
      // A word after `shutdown` was ignored and the port went administratively down, so a typo that costs a
      // link had no witness (#1495).
      return ['% `shutdown` takes no argument: it closes this port, `no shutdown` opens it' +
        ' (the word "' + tokens.slice(1).join(' ') + '" was not used)'];
    } else if (head === 'shutdown') {
      iface.enabled = false;
      // A closed port cannot be the way to an address. A real switch removes the dynamic entries it learned on
      // a port as soon as that port goes down, instead of leaving them until the ageing timer lapses
      // (research/mac-table-link-down-flush.md); this one left them, so `show mac address-table` went on naming
      // a socket nothing can be sent out of, and the row was only marked, never dropped. The count is printed
      // because a flush that quietly removed addresses would be the same kind of silence as one that kept them.
      const forgotten = this.device.flushMacsOnPort(iface.name);
      // A port coming up or going down makes STP, OSPF and VRRP do their timers again. The clock only moved for a
      // cable before this, so a board that had already converged said it still was (#1331).
      this._controlPlaneChanged();
      out.push(iface.name + ' administratively down' +
        (forgotten ? ' (' + forgotten + ' learned address' + (forgotten === 1 ? '' : 'es') + ' on it dropped)' : ''));
    } else if (head === 'no' && tokens[1] === 'shutdown') {
      // The address this port already holds is put into the routing table by opening it, so the overlap
      // question is asked again here - and a port whose address collides with a live one is refused in
      // the same one line, and stays administratively down:
      //
      //     R1(config-if)#ip address 172.20.101.1 255.255.255.0
      //     R1(config-if)#
      //     R1(config-if)#no shutdown
      //     % 172.20.101.0 overlaps with GigabitEthernet0/1
      //
      // A shut port takes an overlapping address silently, which is why this is the only place the
      // collision can surface for one: it was not a collision when the address was typed.
      if (iface.enabled === false && iface.ip && iface.mask) {
        const clash = this._ipOverlapRefusal(iface, iface.ip, iface.mask, { atLinkUp: true });
        if (clash) return [clash];
      }
      iface.enabled = true;
      this._controlPlaneChanged();
      out.push(iface.name + ' up');
    } else if (head === 'ipv6' && tokens[1] === 'address') {
      out.push.apply(out, this._ipv6Iface(tokens.slice(2), iface));
    } else if (head === 'no' && tokens[1] === 'ipv6' && tokens[2] === 'address') {
      if (String(tokens[3] || '').toLowerCase() === 'autoconfig') {
        out.push.apply(out, this._noAutoconfig(iface));
      } else {
        if (this.device.config.ip6) delete this.device.config.ip6[iface.name];
        iface.autoconfig = false;
        out.push('IPv6 address removed from ' + iface.name);
      }
    } else if (head === 'ip' && tokens[1] === 'ospf') {
      out.push.apply(out, this._ipOspf(tokens.slice(2), iface));
    } else if (head === 'no' && tokens[1] === 'ip' && tokens[2] === 'ospf') {
      out.push.apply(out, this._ipOspf(['no'].concat(tokens.slice(3)), iface));
    } else if (head === 'no' && tokens[1] === 'ip' && tokens[2] === 'access-group') {
      out.push.apply(out, this._accessGroup(['no'].concat(tokens.slice(3)), iface));
    } else if (head === 'ip' && tokens[1] === 'access-group') {
      out.push.apply(out, this._accessGroup(tokens.slice(2), iface));
    } else if (head === 'encapsulation') {
      out.push.apply(out, this._encap(tokens.slice(1), iface));
    } else if (head === 'clock') {
      out.push.apply(out, this._clock(tokens.slice(1), iface));
    } else if (head === 'no' && tokens[1] === 'clock') {
      out.push.apply(out, this._clock(['rate', 'none'], iface));
    } else if (head === 'switchport') {
      // Switching a frame is what `l2-forward` means. A router took `switchport mode trunk` and answered
      // "Switchport mode trunk on Gi0", then `show interfaces` printed nothing about it because the printer
      // knows a routed port does not switch (#1387). The command and the printer disagreed about the same box.
      const cannotSwitch = this._capabilityRefusal('l2-forward', 'switch frames');
      if (cannotSwitch) return [cannotSwitch + this._routedPortHint()];
      const changed = this._switchport(tokens.slice(1), iface);
      // A VLAN parameter changes which ports forward for which VLAN, which is exactly what STP's timers are about.
      this._controlPlaneChanged();
      out.push.apply(out, changed);
    } else if (head === 'no' && tokens[1] === 'switchport') {
      const cannotSwitch = this._capabilityRefusal('l2-forward', 'switch frames');
      if (cannotSwitch) return [cannotSwitch + this._routedPortHint()];
      // `no switchport access vlan` has to remove the access VLAN, not the whole switchport configuration.
      // Every `no switchport ...` form used to fall through to the blanket reset, so removing one leaf
      // cleared the mode, the native VLAN and the allowed list as well - five fields gone, announced as
      // "reset to defaults".
      out.push.apply(out, this._switchport(['no'].concat(tokens.slice(2)), iface));
    } else if (head === 'channel-group') {
      // A LAG is a bundle of switch ports; there is nothing to bundle on a box that does not switch.
      const cannotBundle = this._capabilityRefusal('l2-forward', 'bundle ports into a LAG');
      if (cannotBundle) return [cannotBundle];
      out.push.apply(out, this._channelGroup(tokens.slice(1), iface));
    } else if (head === 'no' && tokens[1] === 'channel-group') {
      // The id travels with the command. It used to be dropped here, so `no channel-group 9999` removed the
      // port from whatever group it was really in (#1510).
      out.push.apply(out, this._channelGroup(['remove'].concat(tokens.slice(2)), iface));
    } else if (head === 'speed') {
      out.push.apply(out, this._speed(tokens.slice(1), iface));
    } else if (head === 'no' && tokens[1] === 'speed') {
      // `no speed` is the whole command - the vendor's syntax line carries no argument - so a word after it
      // cannot be a rate to set. This line dropped the word and returned the port to autonegotiation anyway:
      // the same silence the trailing-word fixes closed elsewhere (#1495). research/speed-duplex-grammar.md.
      if (tokens[2]) {
        return ['% no speed takes no argument: it returns this port to autonegotiation' +
          ' (the word "' + tokens.slice(2).join(' ') + '" was not used, and the rate is unchanged)'];
      }
      out.push.apply(out, this._speed(['auto'], iface));
    } else if (head === 'duplex') {
      out.push.apply(out, this._duplex(tokens.slice(1), iface));
    } else if (head === 'no' && tokens[1] === 'duplex') {
      // `no duplex {auto | full | half}` does take a word - the same three the positive form takes - and the
      // default it returns to is `auto`, so the word is only a check on what was typed. Anything else was
      // swallowed and the duplex was reset anyway.
      if (tokens[2] && !['auto', 'full', 'half'].includes(String(tokens[2]).toLowerCase())) {
        return ['% no duplex takes auto, full or half: the word "' + tokens[2] + '" was not used,' +
          ' and the duplex is unchanged'];
      }
      if (tokens[3]) {
        return ['% no duplex ' + tokens[2] + ' takes no word after it: the word "' + tokens[3] + '" was' +
          ' not used, and the duplex is unchanged'];
      }
      out.push.apply(out, this._duplex(['auto'], iface));
    } else if (head === 'description') {
      // `description` with nothing after it set the port's description to the empty string and answered
      // "Description set" - a change it did not name, clearing whatever was there (#1497). Clearing a description
      // is `no description`, which says what it removed.
      if (tokens.length < 2) {
        return ['% Incomplete command: description <text> (use `no description` to clear it)'];
      }
      // The fourth free-text position, and the same defect as #1685 (#1691): `description ?` set the port's
      // description to "?" and answered "Description set: ?" - a receipt shaped exactly like the one
      // `description lab` gives, for text nobody wrote, over whatever description the port already had.
      const keyed = this._helpKeyRefusal(tokens.slice(1).join(' '), 'description <text>',
        'the description of ' + iface.name + ' is unchanged', 'a description');
      if (keyed) return [keyed];
      // No length rule here on purpose. The published maximum for this one command is 64 characters (Catalyst
      // 1200 CLI guide), 200 (IOS XE SD-WAN qualified reference), 238 (IOS Interface and Hardware Component
      // Command Reference) and 240 (Catalyst 2960-X and 3850 configuration guides), and the one transcript of an
      // over-long description is a 12.2 router taking ~200 words "with no issues" - an acceptance, not a refusal.
      // Which number this family uses, and whether the box truncates or refuses, is unknown, so no ceiling is
      // invented: research/interface-description-length.md records the four figures and what would settle it.
      iface.description = tokens.slice(1).join(' ');
      out.push('Description set: ' + iface.description);
    } else if (head === 'no' && tokens[1] === 'description') {
      // The same rule from the other side: a removal says what it removed, and does not pretend to have removed
      // something that was not there.
      const hadDescription = iface.description;
      iface.description = '';
      out.push(hadDescription
        ? 'Description removed: ' + hadDescription
        : iface.name + ' had no description');
    } else if (head === 'exit') {
      this.mode = MODE_CONFIG;
    } else if (head === 'end') {
      this.mode = MODE_ENABLE;
    } else if (head === 'show') {
      out.push.apply(out, this._show(tokens.slice(1)));
    } else {
      // Still inside an interface block, but the line may be a global config command - the last
      // block of an old running-config is followed by `ip route`, `access-list` and friends with no
      // `exit` in front of them. Try config mode before complaining, and report the interface error
      // if config mode does not recognise it either (#1230).
      const asConfig = this._configMode(tokens);
      const rejected = asConfig.length === 1 && /^% Unrecognized config command/.test(asConfig[0]);
      if (rejected) out.push('% Unrecognized interface command: ' + typedLine);
      else out.push.apply(out, asConfig);
    }
    return out;
  }

  // ---------- clock rate, on a serial interface ----------
  // A synchronous serial link is clocked by its DCE end. What the parser accepts is the
  // vendor's menu, not the port's link-speed ladder: a box offers the standard rates and,
  // under them, `<300-4000000> Choose clockrate from list above`, and a rate that is not on
  // the menu is rounded to the nearest one the hardware supports -
  //   `%Clockrate rounded to nearest value that your hardware can support.`
  // - which is the sentence the command reference prints (research/serial-clock-menu.md).
  // The port's own declared line rates stay in the menu, so a rate this model can clock is
  // still spelled its way; the top of the range is the fastest rate the port declares.
  _clock(tokens, iface) {
    const t = tokens.map(function (x) { return String(x).toLowerCase(); });
    if (t[0] !== 'rate') return ['% Usage: clock rate <bps>'];
    if (t[1] === 'none') {
      iface.clockRateBps = null;
      return ['Clock rate cleared - this end is now DTE'];
    }
    if (iface.cage !== 'serial') {
      return ['% clock rate is only configurable on a serial interface (' + iface.name + ' is ' + (iface.cage || 'unknown') + ')'];
    }
    const raw = String(t[1] === undefined ? '' : t[1]);
    let bps = null;
    const m = /^(\d+(?:\.\d+)?)([km]?)$/.exec(raw);
    if (m) {
      const n = parseFloat(m[1]);
      bps = m[2] === 'k' ? n * 1e3 : m[2] === 'm' ? n * 1e6 : n;
    }
    if (bps === null || !isFinite(bps) || bps <= 0) {
      return ['% Invalid clock rate: ' + (raw || '(none)') + ' (give bits per second, e.g. 64000)'];
    }
    const declared = (iface.speedCaps || []).filter(function (s) {
      return s <= (typeof iface.maxSpeedMbps === 'number' ? iface.maxSpeedMbps : Infinity) + 1e-9;
    }).map(function (s) { return Math.round(s * 1e6); });
    const topBps = declared.length ? Math.max.apply(null, declared) : 0;
    const menu = Array.from(new Set(declared.concat(SERIAL_CLOCK_RATES.filter(function (r) {
      return r <= topBps;
    })))).sort(function (a, b) { return a - b; });
    if (!menu.length) {
      return ['% ' + Math.round(bps) + ' bps is outside the range ' + iface.name + ' can clock (no rate is declared for this port)'];
    }
    const want = Math.round(bps);
    if (menu.indexOf(want) !== -1) {
      iface.clockRateBps = want;
      return ['Clock rate set to ' + want + ' bps on ' + iface.name + ' (this end is DCE)'];
    }
    // Outside the parser's range: below 300 bps or above what this port's hardware reaches.
    if (want < 300 || want > topBps) {
      return ['% ' + want + ' bps is outside the range ' + iface.name + ' can clock (300-' + topBps + ' bps)'];
    }
    // Inside the range but not on the menu: the box rounds it to the nearest rate it supports
    // and says so, and the config then holds the rounded rate, not the typed one.
    let nearest = menu[0];
    menu.forEach(function (r) {
      if (Math.abs(r - want) < Math.abs(nearest - want)) nearest = r;
    });
    iface.clockRateBps = nearest;
    return ['%Clockrate rounded to nearest value that your hardware can support.'];
  }

  // ---------- 802.1Q encapsulation on a router subinterface ----------
  _encap(tokens, iface) {
    const t = tokens.map(function (x) { return String(x).toLowerCase(); });
    if (t[0] !== 'dot1q') return ['% Unsupported encapsulation: ' + (t[0] || '')];
    if (!iface.isSubinterface || !iface.isSubinterface()) {
      return ['% encapsulation dot1q is only valid on a subinterface (e.g. ' + iface.name + '.10)'];
    }
    const vid = parseInt(t[1], 10);
    if (!(vid >= 1 && vid <= 4094)) return ['% VLAN out of range: ' + (t[1] || '')];
    iface.encapVid = vid;
    const parent = this.device.interfaces.get(iface.parent);
    if (parent) {
      const vlanLib = require('./vlan');
      parent.vlan = vlanLib.normalizePortConfig(Object.assign({}, parent.vlan, { mode: 'trunk' }));
    }
    return ['Subinterface ' + iface.name + ' encapsulation dot1q ' + vid];
  }

  // ---------- IPv6 ----------
  _ipv6Iface(tokens, iface) {
    const v6 = require('./ipv6');
    const spec = String(tokens[0] || '');

    // 'ipv6 address autoconfig': the address comes from a router advertisement.
    // Any address typed in by hand is removed, because two sources of truth for
    // one address is how a lab ends up "not working" with nothing to look at.
    if (spec.toLowerCase() === 'autoconfig') {
      if (this.device.config.ip6) delete this.device.config.ip6[iface.name];
      iface.autoconfig = true;
      return ['IPv6 address autoconfig on ' + iface.name +
        ' (no address until a router advertisement arrives)'];
    }

    // A bare `ipv6 address` was reported as an invalid address rather than a missing one (#1497).
    if (!spec.trim()) return ['% Incomplete command: ipv6 address <address>/<prefix> (or `ipv6 address autoconfig`)'];
    const parts = spec.split('/');
    const parsed = v6.parseIpv6(parts[0]);
    if (!parsed.valid) return ['% Invalid IPv6 address "' + parts[0] + '"'];
    const len = parts.length > 1 ? parseInt(parts[1], 10) : 64;
    if (!(len >= 0 && len <= 128)) return ['% Invalid prefix length "' + parts[1] + '"'];
    if (!this.device.config.ip6) this.device.config.ip6 = {};
    const addr = v6.formatIpv6(parsed.groups);
    // A static address cancels autoconfiguration: the operator has just said
    // what the address is, so waiting for a router to say otherwise would only
    // produce a second address nobody asked for.
    iface.autoconfig = false;
    this.device.config.ip6[iface.name] = { addr: addr, prefix: len };
    return ['IPv6 address ' + addr + '/' + len + ' on ' + iface.name];
  }

  // Withdrawing autoconfiguration has to take the learned address with it.
  // Otherwise the host keeps an address nobody refreshes any more, which is the
  // stale-address problem that makes "the ping still works but nothing else
  // does" so hard to explain.
  _noAutoconfig(iface) {
    const dev = this.device;
    const out = [];
    iface.autoconfig = false;
    const entry = dev.config.ip6 && dev.config.ip6[iface.name];
    if (entry && entry.autoconfig) {
      delete dev.config.ip6[iface.name];
      out.push('SLAAC address ' + entry.addr + '/' + entry.prefix + ' removed from ' + iface.name);
    }
    let waiting = 0;
    for (const i of dev.interfaces.values()) if (i.autoconfig) waiting++;
    if (!waiting && dev.config.gateway6 && dev.config.gateway6Iface) {
      dev.config.gateway6 = null;
      dev.config.gateway6Iface = null;
      out.push('Default IPv6 gateway (learned from a router advertisement) cleared');
    }
    out.push('IPv6 autoconfiguration disabled on ' + iface.name);
    return out;
  }

  // ---------- IPv6 neighbour discovery / router advertisements ----------
  //
  // 'ipv6 nd ...' describes a router to its link: which prefixes it owns, whether
  // hosts should configure themselves from them, and whether it may be used as a
  // default router. Only the policy lives here; the message format is engine/ra.js.
  _ipv6Nd(tokens) {
    const v6 = require('./ipv6');
    const raLib = require('./ra');
    const dev = this.device;
    const t = tokens.map(function (x) { return String(x).toLowerCase(); });

    let negated = false;
    if (t[0] === 'no') { negated = true; t.shift(); }
    if (!t.length) return ['% Incomplete command: ipv6 nd ra|prefix|suppress-ra'];

    function cfg() {
      if (!dev.config.ra) dev.config.ra = raLib.normalizeConfig(null);
      if (!Array.isArray(dev.config.ra.prefixes)) dev.config.ra.prefixes = [];
      return dev.config.ra;
    }

    // Advertising a prefix is a promise to route traffic inside it. A device
    // without l3-forward cannot keep that promise, so the configuration is
    // refused here rather than producing a link full of black holes.
    function needsRouter() {
      if (dev.hasCap('l3-forward')) return null;
      return ['% ' + dev.name + ' cannot advertise: it has no l3-forward capability, ' +
        'so it could not route the traffic a prefix would attract'];
    }

    if (t[0] === 'ra') {
      const sub = t[1] || '';
      const bad = needsRouter();
      if (bad) return bad;
      const c = cfg();

      if (sub === 'enable' || sub === 'disable') {
        // 'no ipv6 nd ra enable' reads as "stop advertising", and that is what it
        // does: the negated form flips the verb rather than being refused.
        const on = (sub === 'enable') !== negated;
        c.enabled = on;
        // A box advertises without being asked: RFC 4861 6.2.1 has a router send
        // unsolicited RAs on every link it is configured to serve, and Cisco's
        // `ipv6 nd ra suppress` reference states the default in its own words -
        // "IPv6 router advertisements are automatically sent on Ethernet and FDDI
        // interfaces if IPv6 unicast routing is enabled". So `enable` here is the
        // spelling an operator reaches for after a `disable`, not a step a fresh
        // device needs; the answer says which of the two just happened.
        return [on
          ? (negated
            ? 'IPv6 router advertisements enabled on ' + dev.name
            : 'IPv6 router advertisements are already being sent on ' + dev.name +
              ' - that is the default (`ipv6 nd ra disable` stops them)')
          : 'IPv6 router advertisements disabled on ' + dev.name];
      }
      if (sub === 'managed' || sub === 'other-config') {
        const on = !negated;
        if (sub === 'managed') c.m = on; else c.o = on;
        return ['IPv6 RA ' + (sub === 'managed' ? 'M (managed)' : 'O (other-config)') +
          ' flag ' + (on ? 'set' : 'cleared')];
      }
      if (sub === 'lifetime') {
        const val = t[2];
        if (val === undefined) return ['% Incomplete command: ipv6 nd ra lifetime <seconds>'];
        if (!/^\d{1,5}$/.test(val)) return ['% Invalid router lifetime "' + val + '" (0..65535 seconds)'];
        const n = parseInt(val, 10);
        if (n > 65535) return ['% Router lifetime out of range: ' + val + ' (0..65535)'];
        c.routerLifetime = n;
        return ['IPv6 RA router lifetime ' + n + 's' + (n === 0 ? ' (not a default router)' : '')];
      }
      return ['% Unknown IPv6 RA command: ipv6 nd ra ' + sub];
    }

    if (t[0] === 'suppress-ra') {
      const bad = needsRouter();
      if (bad) return bad;
      const c = cfg();
      c.suppress = !negated;
      return [negated
        ? 'IPv6 periodic router advertisements resume'
        : 'IPv6 router advertisements suppressed: solicited advertisements only'];
    }

    if (t[0] === 'prefix') {
      const bad = needsRouter();
      if (bad) return bad;
      const raw = t[1];
      if (!raw) return ['% Incomplete command: ipv6 nd prefix <prefix>/<len> [valid <s>] [preferred <s>]'];
      const parsed = v6.parsePrefix6(raw);
      if (!parsed.valid) return ['% Invalid IPv6 prefix "' + raw + '"'];
      const network = v6.networkAddress6(parsed);
      const c = cfg();
      const same = function (p) {
        const pp = raLib.normalizePrefixInfo(p);
        return !!(pp && pp.prefix === network && pp.prefixLen === parsed.prefixLen);
      };

      if (negated) {
        const before = c.prefixes.length;
        c.prefixes = c.prefixes.filter(function (p) { return !same(p); });
        if (c.prefixes.length === before) {
          return ['% No such advertised prefix: ' + network + '/' + parsed.prefixLen];
        }
        return ['IPv6 ND prefix ' + network + '/' + parsed.prefixLen + ' withdrawn'];
      }

      let valid = raLib.DEFAULTS.validLifetime;
      let preferred = raLib.DEFAULTS.preferredLifetime;
      const rest = t.slice(2);
      for (let i = 0; i < rest.length; i += 2) {
        const key = rest[i];
        const val = rest[i + 1];
        if (key !== 'valid' && key !== 'preferred') {
          return ['% Unexpected "' + key + '": expected [valid <seconds>] [preferred <seconds>]'];
        }
        if (val === undefined) return ['% Incomplete command: ' + key + ' needs a value in seconds'];
        if (!/^\d{1,10}$/.test(val)) return ['% Invalid lifetime "' + val + '" (whole seconds)'];
        const n = parseInt(val, 10);
        if (n > raLib.INFINITE) return ['% Lifetime out of range: ' + val + ' (0..' + raLib.INFINITE + ')'];
        if (key === 'valid') valid = n; else preferred = n;
      }
      // A preferred lifetime past the valid one is a contradiction on the wire;
      // refusing it here means the router never advertises nonsense.
      if (preferred > valid) {
        return ['% Preferred lifetime (' + preferred + 's) cannot exceed the valid lifetime (' + valid + 's)'];
      }

      // One advertisement per prefix: re-issuing the command replaces the entry,
      // which is what an operator means by running it again.
      c.prefixes = c.prefixes.filter(function (p) { return !same(p); });
      c.prefixes.push({
        prefix: network, prefixLen: parsed.prefixLen,
        onLink: true, autonomous: true,
        validLifetime: valid, preferredLifetime: preferred
      });

      const lines = ['IPv6 ND prefix ' + network + '/' + parsed.prefixLen +
        ' advertised (L=1 A=1, valid ' + valid + 's, preferred ' + preferred + 's)'];
      if (parsed.prefixLen !== 64) {
        lines.push('% note: only a /64 leaves room for a 64-bit interface identifier, ' +
          'so hosts will not form a SLAAC address from this prefix');
      }
      return lines;
    }

    return ['% Unknown IPv6 ND command: ipv6 nd ' + t.join(' ')];
  }

  _ipv6Route(tokens) {
    const v6 = require('./ipv6');
    const dest = tokens[0];
    const nh = tokens[1];
    const p = v6.parsePrefix6(dest);
    if (!p.valid) return ['% Invalid IPv6 prefix "' + (dest || '') + '"'];
    if (!v6.validateAddress6(nh).ok) return ['% Invalid IPv6 next hop "' + (nh || '') + '"'];
    if (!this.device.config.routes6) this.device.config.routes6 = [];
    const net = v6.networkAddress6(dest);
    this.device.config.routes6.push({ dest: net, prefix: p.prefixLen, nextHop: nh });
    return ['IPv6 route ' + net + '/' + p.prefixLen + ' via ' + nh];
  }

  // ---------- BGP ----------
  _bgp(tokens) {
    const dev = this.device;
    const t = tokens.map(function (x) { return String(x); });
    const isIp = function (s) { return net.isIp(String(s || '')); };

    function ensure(asn) {
      if (!dev.config.bgp) dev.config.bgp = { as: null, routerId: null, neighbors: [] };
      if (!dev.config.bgp.neighbors) dev.config.bgp.neighbors = [];
      if (asn !== undefined && asn !== null && asn !== '') dev.config.bgp.as = asn;
      return dev.config.bgp;
    }

    // router bgp <as>
    if (t[0] === 'as') {
      const asn = parseInt(t[1], 10);
      if (!(asn >= 1 && asn <= 4294967295)) return ['% Invalid AS number "' + (t[1] || '') + '"'];
      ensure(asn);
      return ['BGP enabled, local AS ' + asn];
    }

    // bgp router-id <ip>
    if (t[0] === 'router-id') {
      if (!isIp(t[1])) return ['% Invalid router-id "' + (t[1] || '') + '"'];
      if (!dev.config.bgp) return ['% BGP is not enabled (use "router bgp <as>")'];
      dev.config.bgp.routerId = t[1];
      return ['BGP router-id ' + t[1]];
    }

    // `neighbor 300.1.1.1 remote-as 65002` fell through to the generic usage line, because this form is guarded by
    // isIp(): the refusal named the whole syntax instead of the address that is not one (#1411).
    if (!isIp(t[0]) && /^[0-9.]+$/.test(String(t[0] || '')) && String(t[1] || '').toLowerCase() === 'remote-as') {
      return ['% Invalid neighbor address "' + t[0] + '": not an IPv4 address'];
    }
    // neighbor <ip> remote-as <as>
    if (isIp(t[0]) && String(t[1] || '').toLowerCase() === 'remote-as') {
      const asn = parseInt(t[2], 10);
      if (!(asn >= 1 && asn <= 4294967295)) return ['% Invalid remote AS "' + (t[2] || '') + '"'];
      if (!dev.config.bgp) return ['% BGP is not enabled (use "router bgp <as>" first)'];
      const list = dev.config.bgp.neighbors;
      let n = null;
      for (const x of list) { if (x.address === t[0]) { n = x; break; } }
      if (n) n.remoteAs = asn;
      else list.push({ address: t[0], remoteAs: asn });
      return ['BGP neighbor ' + t[0] + ' remote-as ' + asn];
    }

    return ['% Usage: router bgp <as> | bgp router-id <ip> | neighbor <ip> remote-as <as>'];
  }

  // ---------- DNS ----------
  _dns(tokens) {
    const dnsLib = require('./dns');
    const dev = this.device;
    const t = tokens.map(function (x) { return String(x); });
    if (!dev.config.dnsZones) dev.config.dnsZones = [];

    if (t[0] === 'zone') {
      const apex = t[1];
      if (!apex) return ['% Usage: dns zone <name>'];
      // `dns zone ?` opened a zone called "?" and said so (#1685): a keypress became a zone, and later `dns add`
      // lines resolved under it.
      const keyed = this._helpKeyRefusal(apex, 'dns zone <name>', 'no zone was created');
      if (keyed) return [keyed];
      const key = dnsLib.normalizeName(apex);
      let z = dev.config.dnsZones.filter(function (x) { return dnsLib.normalizeName(x.name) === key; })[0];
      if (!z) {
        z = { name: key, defaultTtl: 3600, records: [] };
        dev.config.dnsZones.push(z);
      }
      this._dnsZone = z.name;
      return ['DNS zone ' + z.name + ' ready'];
    }

    if (t[0] === 'add') {
      const name = t[1];
      const type = String(t[2] || 'A').toUpperCase();
      const value = t[3];
      if (!name || !value) return ['% Usage: dns add <name> <A|CNAME|MX|TXT> <value>'];
      if (dnsLib.RECORD_TYPES.indexOf(type) === -1) {
        return ['% Unknown record type "' + type + '" (use ' + dnsLib.RECORD_TYPES.join('/') + ')'];
      }
      let z = null;
      if (this._dnsZone) {
        z = dev.config.dnsZones.filter(function (x) { return x.name === this._dnsZone; }, this)[0];
      }
      if (!z) z = dev.config.dnsZones[dev.config.dnsZones.length - 1];
      if (!z) return ['% No zone yet - create one with "dns zone <name>"'];
      z.records.push({ name: name, type: type, ttl: z.defaultTtl, value: value });
      return ['Added ' + name + ' ' + type + ' ' + value + ' to ' + z.name];
    }

    return ['% Usage: dns zone <name> | dns add <name> <type> <value>'];
  }

  // ---------- OSPF ----------
  _ospfConfig(tokens) {
    const dev = this.device;
    const t = tokens.map(function (x) { return String(x); });
    if (!t.length) return ['% Usage: ospf router-id <ip> | ospf area <id>'];
    const cfg = dev.config.ospf || { routerId: null, areaId: 0, interfaces: [] };
    if (!cfg.interfaces) cfg.interfaces = [];

    if (t[0] === 'router-id') {
      const cannotRoute = this._capabilityRefusal('l3-forward', 'run OSPF');
      if (cannotRoute) return [cannotRoute];
      const ip = t[1] || '';
      if (!net.isIp(ip)) return ['% Invalid router-id "' + ip + '": not an IPv4 address'];
      cfg.routerId = ip;
      dev.config.ospf = cfg;
      return ['OSPF enabled, router-id ' + ip + ' area ' + (cfg.areaId || 0)];
    }
    if (t[0] === 'area') {
      // An OSPF area id is a 32-bit number and the box takes it written either way: as a decimal number
      // (0-4294967295) or as a dotted quad. `parseInt` on the typed word kept everything before the first
      // dot, so `ospf area 0.0.0.1` was stored as area 0 - two routers in *different* areas then formed a
      // full adjacency and exchanged routes - and `ospf area 0.0.0.999` was accepted as area 0, because
      // parseInt stops at the dot and never looks at the last octet. The ceiling was also wrong by half the
      // range: `area 4294967295` is a valid id (Cisco IOS XE, `ip ospf area`: "A decimal value in the range
      // from 0 to 4294967295, or an IP address in the dotted-decimal format",
      // https://www.cisco.com/c/en/us/td/docs/routers/sdwan/command/iosxe/qualified-cli-command-reference-guide/m-ip-ospf-commands.html)
      // and this console refused it. The field itself is "A 32 bit number identifying the area that this
      // packet belongs to" (RFC 2328 section 9, https://www.rfc-editor.org/rfc/rfc2328).
      //
      // The id is stored as it was written, because the box echoes the form it was given: a switch
      // configured with area 0.0.0.1 prints "Area 0.0.0.1" in `show ip ospf interface`, and one configured
      // with 0 prints "Area 0" (Dell OS9 9.14 `show ip ospf interface` keeps the dotted form in its sample,
      // https://www.dell.com/support/manuals/en-gb/dell-emc-os-9/s6000-9.14.2.6-cli-pub/show-ip-ospf-interface).
      // What decides an adjacency is the 32-bit value on the wire, not the spelling, so
      // `engine/simulator.js` compares areaOf() of the two ends rather than the strings - "0.0.0.1" and "1"
      // are one area. (IOS XR's command reference warns that its *area objects* match by format only, which
      // is a config-identity rule, not what a Hello carries:
      // https://cisco.com/c/en/us/td/docs/iosxr/cisco8000/routing/cumulative/command/reference/b-routing-cr-cisco8000/m-ospf-commands.html.)
      const raw = t[1] || '';
      const id = ospfLib.parseAreaId(raw);
      if (id === null) {
        return ['% Invalid area id "' + raw + '": an OSPF area is a 32-bit number (0-4294967295) or a ' +
          'dotted quad such as 0.0.0.1'];
      }
      cfg.areaId = /^\d+$/.test(raw) ? String(id) : raw;
      dev.config.ospf = cfg;
      return ['OSPF area ' + cfg.areaId];
    }
    return ['% Usage: ospf router-id <ip> | ospf area <id>'];
  }

  _ipOspf(tokens, iface) {
    const dev = this.device;
    if (!dev.config.ospf) return ['% OSPF is not enabled (use "ospf router-id <ip>" in config mode)'];
    const cfg = dev.config.ospf;
    if (!cfg.interfaces) cfg.interfaces = [];

    let ov = null;
    for (const x of cfg.interfaces) { if (x.name === iface.name) { ov = x; break; } }
    if (!ov) { ov = { name: iface.name }; cfg.interfaces.push(ov); }

    const t = tokens.map(function (x) { return String(x).toLowerCase(); });
    const negate = t[0] === 'no';
    const rest = negate ? t.slice(1) : t;

    if (rest[0] === 'cost') {
      if (negate) { delete ov.cost; return ['OSPF cost reset on ' + iface.name]; }
      const c = parseInt(rest[1], 10);
      if (!(c >= 1 && c <= 65535)) return ['% Cost must be 1..65535'];
      ov.cost = c;
      return ['OSPF cost ' + c + ' on ' + iface.name];
    }
    if (rest[0] === 'area') {
      if (negate) { delete ov.area; return ['OSPF area reset on ' + iface.name]; }
      // The same rule the router-level command uses, from the same function: an area is a 32-bit number,
      // written decimal or dotted (`ip ospf area`: "A decimal value in the range from 0 to 4294967295, or an
      // IP address in the dotted-decimal format", Cisco IOS XE command reference, URL above). A dotted id
      // used to be read with parseInt and became area 0, so an interface put in area 0.0.2.0 formed an
      // adjacency with a router in the backbone.
      const raw = rest[1] || '';
      const id = ospfLib.parseAreaId(raw);
      if (id === null) {
        return ['% Invalid area id "' + raw + '": an OSPF area is a 32-bit number (0-4294967295) or a ' +
          'dotted quad such as 0.0.0.2'];
      }
      ov.area = /^\d+$/.test(raw) ? String(id) : raw;
      return ['OSPF area ' + ov.area + ' on ' + iface.name];
    }
    if (rest[0] === 'priority') {
      // `ip ospf priority <0-255>`: the Router Priority field the Hello carries, which decides the DR
      // election on a multiaccess segment. IOS's default is 1, the range is 0-255, and 0 is legal and
      // means the port is "ineligible to become the designated router or backup designated router"
      // (Cisco IOS IP Routing: OSPF Command Reference, `ip ospf priority`). Both facts are stated here
      // because a reader who types 0 is otherwise entitled to read it as a typo, and this console's
      // election now honours it. On a point-to-point port the command is accepted and stored - IOS
      // accepts it too ("Router priority is configured only for interfaces to multiaccess networks")
      // - and the election simply never runs there, so `FULL/ -` is unchanged.
      if (negate) {
        const had = (typeof ov.priority === 'number') ? ov.priority : 1;
        delete ov.priority;
        return ['OSPF priority reset to 1 on ' + iface.name +
          (had === 1 ? ' (it was already the default)' : '')];
      }
      const raw = rest[1];
      if (raw === undefined) return ['% Priority must be 0..255'];
      if (!/^\d+$/.test(raw) || rest.length > 2) {
        return ['% Priority must be 0..255' +
          (rest.length > 2 ? ': the word "' + rest[2] + '" was not used' : '')];
      }
      const p = parseInt(raw, 10);
      if (!(p >= 0 && p <= 255)) return ['% Priority must be 0..255'];
      ov.priority = p;
      return ['OSPF priority ' + p + ' on ' + iface.name +
        (p === 0 ? ' (not eligible to become DR or BDR)' : '')];
    }
    if (rest[0] === 'passive') {
      ov.passive = !negate;
      return ['OSPF ' + (negate ? 'active' : 'passive') + ' on ' + iface.name];
    }
    return ['% Usage: ip ospf cost <n> | ip ospf area <id> | ip ospf priority <0-255> | ip ospf passive'];
  }

  // ---------- line rate and duplex ----------
  //
  // Both were modelled and neither was reachable: `Interface.duplex` was written as 'full' for every port
  // in the catalogue and no command could change it, so `W_DUPLEX_MISMATCH` - a warning the connector docs
  // promise - could never fire. The rule is worth having because it is the classic "the link is up but slow"
  // answer, and a simulator that cannot produce it cannot be asked the question (#1259).
  _speed(tokens, iface) {
    const want = (tokens[0] || '').toLowerCase();
    if (!want) return ['% Usage: speed auto | <mbps>'];
    // The vendor's syntax line is
    //   speed {10 | 100 | 1000 | 2500 | 5000 | auto [10 | 100 | 1000 | 2500 | 5000] | nonegotiate}
    // (Catalyst 2960-X 15.2(6)E command reference, Interface and Hardware Commands, `speed`), so exactly one
    // shape carries a second word: `auto` followed by the rates it may advertise. This handler read
    // `tokens[0]` and dropped the rest, so `speed 100 flurbish` forced 100 Mb/s and never mentioned a word a
    // real box rejects at parse time, and `speed auto 10` was answered as a plain `speed auto` - a different
    // setting on hardware, reported as the one that was typed. Both are refused here, before anything is
    // written, as `ip address` refuses the word after its mask. research/speed-duplex-grammar.md.
    const rest = tokens.slice(1).map(function (x) { return String(x); });
    // Only a word the command knows can be followed by something: `speed forced 100` is answered about
    // `forced`, which is not a rate at all, by the check below.
    const isRateWord = want === 'auto' || want === 'nonegotiate' || mediaLib.parseSpeedMbps(want) !== null;
    if (rest.length && isRateWord) {
      const notARate = rest.filter(function (x) { return mediaLib.parseSpeedMbps(x) === null; });
      if (want !== 'auto') {
        return ['% speed ' + want + ' takes one rate and nothing after it: the word "' +
          (notARate[0] || rest[0]) + '" was not used, and the rate is unchanged'];
      }
      if (notARate.length) {
        return ['% speed auto takes a rate after it, not "' + notARate[0] + '": the word "' + notARate[0] +
          '" was not used, and the rate is unchanged'];
      }
      // Real syntax, not modelled here: the subset restricts what the port offers during autonegotiation.
      return ['% speed auto ' + rest.join(' ') + ' is not modelled: a real switch autonegotiates only at the' +
        ' rates named there, this console offers the whole ladder - `speed auto` is the setting it' +
        ' has, and the rate is unchanged'];
    }
    if (want === 'nonegotiate') {
      // A real keyword - it disables autonegotiation and the port runs at 1000 Mb/s - so "Invalid rate" was
      // the wrong answer: the word is a rate setting the console has no advertisement to switch off.
      return ['% speed nonegotiate is not modelled: it is a real keyword (it stops autonegotiation and the' +
        ' port runs at 1000 Mb/s), and this console has no advertisement to turn off - the rate is' +
        ' unchanged'];
    }
    if (iface.type !== 'ethernet' && iface.type !== 'wireless') {
      return ['% ' + iface.name + ' has no line rate to set (type ' + iface.type + ')'];
    }
    if (want === 'auto') {
      // A port in half duplex can only ever run at 10 or 100 Mb/s, so handing it back to
      // autonegotiation would let it negotiate a Gigabit and undo the duplex that was just set. The
      // box keeps the duplex and refuses the rate, which is the second half of the vendor transcript
      // in research/half-duplex-is-10-100.md.
      if (iface.duplex === 'half') {
        const ladderTop = this._portLadderTopMbps(iface);
        if (ladderTop !== null && ladderTop > mediaLib.HALF_DUPLEX_MAX_MBPS) {
          return ['% ' + iface.name + ' is in half duplex, and half duplex exists only at 10 and 100 Mb/s: ' +
            'use `duplex full` before `speed auto`'];
        }
      }
      iface.speedMbps = null;
      this._renegotiate(iface);
      return ['Speed auto-negotiation on ' + iface.name];
    }
    // `speed 1000`, `speed 1G` and `speed 1g` all mean the same port rate; the parser is the one the
    // catalogue uses, so a spelling the specs accept is not refused here.
    const mbps = mediaLib.parseSpeedMbps(want);
    const caps = (iface.hardware && Array.isArray(iface.hardware.speedCaps))
      ? iface.hardware.speedCaps.slice() : [];
    if (mbps === null || !(mbps > 0)) {
      return ['% Invalid rate "' + tokens[0] + '" - give a number of Mbps or auto'];
    }
    if (caps.length && caps.indexOf(mbps) === -1) {
      return ['% ' + iface.name + ' does not support ' + mediaLib.formatSpeedMbps(mbps) +
        ' - it supports ' + caps.map(function (c) { return mediaLib.formatSpeedMbps(c); }).join(', ')];
    }
    // "Cannot change speed to 1000Mbps when in half duplex" - the vendor's own sentence. The refusal
    // comes after the ladder check so a rate the port cannot do at all is answered as that, not as a
    // duplex problem.
    if (iface.duplex === 'half' && mbps > mediaLib.HALF_DUPLEX_MAX_MBPS) {
      return ['% ' + iface.name + ' is in half duplex, and half duplex exists only at 10 and 100 Mb/s: ' +
        'use `duplex full` (or `duplex auto`) before forcing ' + mediaLib.formatSpeedMbps(mbps)];
    }
    // Nothing in the catalogue states this port's ladder, so a rate cannot be refused honestly - but it
    // can be stored, and the link verdict will say what it negotiated to.
    iface.speedMbps = mbps;
    this._renegotiate(iface);
    return ['Speed ' + mediaLib.formatSpeedMbps(mbps) + ' on ' + iface.name];
  }

  // The fastest rate this port's own ladder offers, whatever is forced right now. `null` when the
  // catalogue states neither a ladder nor a nominal rate, in which case no rate rule can be asserted
  // honestly - the same caution `_speed` takes when `speedCaps` is empty.
  _portLadderTopMbps(iface) {
    const caps = (iface && iface.hardware && Array.isArray(iface.hardware.speedCaps))
      ? iface.hardware.speedCaps.map(Number).filter(function (n) { return n > 0; }) : [];
    if (caps.length) return Math.max.apply(null, caps);
    const nominal = mediaLib.parseSpeedMbps(iface && iface.speed ? iface.speed : '');
    return (nominal && nominal > 0) ? nominal : null;
  }

  // The fastest rate this port can run at *now*: the forced rate when one is set, otherwise the top of
  // its ladder, because an autonegotiating port may reach it.
  _portTopRateMbps(iface) {
    if (iface && Number.isFinite(iface.speedMbps) && iface.speedMbps > 0) return iface.speedMbps;
    return this._portLadderTopMbps(iface);
  }

  _duplex(tokens, iface) {
    const want = (tokens[0] || '').toLowerCase();
    if (!['auto', 'full', 'half'].includes(want)) {
      return ['% Usage: duplex auto | full | half'];
    }
    // `duplex {auto | full | half}` - the syntax line has no optional word at all (Catalyst 2960-X
    // 15.2(6)E, Interface and Hardware Commands, `duplex`), so a word after the mode is a parse error and
    // nothing is set. This dropped the word and changed the duplex anyway.
    if (tokens.length > 1) {
      return ['% duplex ' + want + ' takes one mode and nothing after it: the word "' +
        String(tokens[1]) + '" was not used, and the duplex is unchanged'];
    }
    if (iface.type !== 'ethernet') {
      return ['% ' + iface.name + ' has no duplex setting (type ' + iface.type + ')'];
    }
    // Half duplex is a 10/100 setting. A port whose ladder reaches Gigabit refuses the command - the
    // vendor's "% Duplex cannot be set to half when speed autonegotiation subset contains 1Gbps..." -
    // and the refusal says which rate is in the way, because the fix is `speed 100`, not a different
    // duplex. research/half-duplex-is-10-100.md carries both transcripts and the command reference.
    if (want === 'half') {
      const top = this._portTopRateMbps(iface);
      if (top !== null && top > mediaLib.HALF_DUPLEX_MAX_MBPS) {
        return ['% ' + iface.name + ' runs at up to ' + mediaLib.formatSpeedMbps(top) +
          ', and half duplex exists only at 10 and 100 Mb/s: force `speed 100` first, or use `duplex full`'];
      }
    }
    // `auto` means "let the link decide", and what a link decides in this engine is full duplex.
    iface.duplex = (want === 'auto') ? 'full' : want;
    this._renegotiate(iface);
    return ['Duplex ' + (want === 'auto' ? 'auto (full)' : want) + ' on ' + iface.name];
  }

  // Any change to rate or duplex changes what the cable can do, so the verdict is re-run by the same rule
  // that made it. Invisible when the port is not cabled: there is no link to renegotiate.
  _renegotiate(iface) {
    if (!this.topo || typeof this.topo.renegotiate !== 'function') return null;
    const res = this.topo.renegotiate(this.device.id, iface.name);
    if (!res) return null;
    if (!res.verdict.ok) {
      const why = (res.verdict.errors || []).map(function (e) { return e.message; }).join('; ');
      return { error: why };
    }
    return res;
  }

  // ---------- switchport / VLAN membership ----------
  _switchport(tokens, iface) {
    const vlanLib = require('./vlan');
    const t = tokens.map(function (x) { return String(x).toLowerCase(); });

    if (t[0] === 'reset') {
      iface.vlan = vlanLib.normalizePortConfig({});
      this.device.flushMacsOnPort(iface.name);
      return ['Switchport reset to defaults on ' + iface.name + ' (access VLAN 1)'];
    }
    if (t[0] === 'mode') {
      const mode = t[1];
      if (mode !== 'access' && mode !== 'trunk') return ['% Usage: switchport mode access|trunk'];
      // The vendor's syntax line is one line with one keyword in it:
      //   switchport mode { access | dot1q-tunnel | dynamic { auto | desirable } | private-vlan | trunk }
      //   no switchport mode { access | dot1q-tunnel | dynamic | trunk }
      // (Catalyst 2960-S/2960-C 15.2(4)E command reference, `switchport mode`; the same line is in the
      // 2960-X 15.2(2)E/15.2(7)E books), and the reference's own error table says a word outside that set is
      // `% Invalid input detected at '^' marker.` with nothing applied. This handler read `tokens[1]` and
      // dropped the rest, so `switchport mode trunk access` - two modes in one line, the classic paste of a
      // half-typed line - silently made the port a trunk, and `switchport mode access flurbish` set access and
      // never mentioned the word. Both are refused here, before anything is written, as `duplex full <word>`
      // and `speed 100 <word>` already are (research/speed-duplex-grammar.md).
      if (t.length > 2) {
        return ['% switchport mode ' + mode + ' takes one mode and nothing after it: the word "' +
          tokens.slice(2).join(' ') + '" was not used, and the mode is unchanged'];
      }
      const next = Object.assign({}, iface.vlan, { mode: mode });
      // A trunk with no explicit allowed list must carry everything, otherwise
      // it would silently carry no VLANs at all.
      if (mode === 'trunk' && next.allowedVlans === undefined) next.allowedVlans = 'all';
      iface.vlan = vlanLib.normalizePortConfig(next);
      this.device.flushMacsOnPort(iface.name);
      return ['Switchport mode ' + mode + ' on ' + iface.name];
    }
    // A VLAN parameter is not a mode change. These three commands used to set the port's `mode` as a side
    // effect, so `switchport trunk native vlan 20` on an access port silently turned it into a trunk: a
    // different command, in a different column of the table, changed what the port forwards. Real gear stores
    // the parameter and leaves the mode alone - which is also how a trunk is staged before the cable is
    // patched - and now so does this one, saying what is stored and what it will take to use it.
    function modeNote(self, iface, wanted) {
      const current = (iface.vlan && iface.vlan.mode) || 'access';
      if (current === wanted) return '';
      return ' (stored; the port is in ' + current + ' mode - set "switchport mode ' + wanted + '" to use it)';
    }
    // ---------------------------------------------------------------- per-leaf `no`
    if (t[0] === 'no') {
      const leaf = t.slice(1);
      const cur = vlanLib.normalizePortConfig(iface.vlan || {});
      const written = function (next, message) {
        iface.vlan = vlanLib.normalizePortConfig(Object.assign({}, cur, next));
        this.device.flushMacsOnPort(iface.name);
        return [message];
      }.bind(this);

      // `no switchport` - the whole port, back to the defaults it boots with.
      if (!leaf.length) {
        // Spelled out rather than left to the normaliser: for an access port it fills an unset allowed list
        // with `[]`, which is indistinguishable from the empty list the reset would then report as a change
        // on every subsequent run. A trunk's default really is "all".
        const defaults = vlanLib.normalizePortConfig({
          mode: 'access', accessVlan: 1, nativeVlan: 1, allowedVlans: 'all', voiceVlan: null
        });
        const changed = [];
        if (cur.mode !== 'access') changed.push('mode ' + cur.mode + ' -> access');
        if (Number(cur.accessVlan) !== 1) changed.push('access VLAN ' + cur.accessVlan + ' -> 1');
        if (Number(cur.nativeVlan) !== 1) changed.push('native VLAN ' + cur.nativeVlan + ' -> 1');
        if (JSON.stringify(cur.allowedVlans) !== JSON.stringify(defaults.allowedVlans)) {
          changed.push('allowed list -> all');
        }
        if (cur.voiceVlan !== null) changed.push('voice VLAN ' + cur.voiceVlan + ' -> none');
        if (!changed.length) {
          // Nothing to do, so do not claim to have done it.
          return ['% ' + iface.name + ' already has default switchport settings (access VLAN 1)'];
        }
        iface.vlan = defaults;
        this.device.flushMacsOnPort(iface.name);
        return ['Switchport reset to defaults on ' + iface.name + ' (' + changed.join(', ') + ')'];
      }

      if (leaf[0] === 'access' && leaf[1] === 'vlan') {
        const wanted = leaf[2] === undefined ? null : parseInt(leaf[2], 10);
        if (wanted !== null && wanted !== Number(cur.accessVlan)) {
          return ['% ' + iface.name + ' access VLAN is ' + cur.accessVlan + ', not ' + wanted];
        }
        if (Number(cur.accessVlan) === 1) {
          return ['% ' + iface.name + ' access VLAN is already the default (1)'];
        }
        const was = cur.accessVlan;
        return written({ accessVlan: 1 }, 'Access VLAN ' + was + ' removed from ' + iface.name +
          ' (back to 1)');
      }
      if (leaf[0] === 'trunk' && leaf[1] === 'native' && leaf[2] === 'vlan') {
        if (Number(cur.nativeVlan) === 1) {
          return ['% ' + iface.name + ' trunk native VLAN is already the default (1)'];
        }
        const was = cur.nativeVlan;
        return written({ nativeVlan: 1 }, 'Trunk native VLAN ' + was + ' removed from ' + iface.name +
          ' (back to 1)');
      }
      if (leaf[0] === 'trunk' && leaf[1] === 'allowed' && leaf[2] === 'vlan') {
        if (cur.allowedVlans === 'all') {
          return ['% ' + iface.name + ' trunk already allows all VLANs'];
        }
        return written({ allowedVlans: 'all' }, 'Trunk on ' + iface.name + ' allows all VLANs again');
      }
      if (leaf[0] === 'voice' && leaf[1] === 'vlan') {
        if (cur.voiceVlan === null) return ['% ' + iface.name + ' has no voice VLAN'];
        const was = cur.voiceVlan;
        return written({ voiceVlan: null }, 'Voice VLAN ' + was + ' removed from ' + iface.name);
      }
      if (leaf[0] === 'mode') {
        // The `no` form takes one keyword too, and this one dropped a trailing word in the same silence:
        // `no switchport mode access flurbish` put the port back into access mode and said nothing about the
        // word. Same rule, same sentence, and the mode is left where it was.
        if (leaf.length > 2) {
          return ['% no switchport mode takes one mode and nothing after it: the word "' +
            tokens.slice(3).join(' ') + '" was not used, and the mode is unchanged'];
        }
        if (cur.mode === 'access') {
          return ['% ' + iface.name + ' is already in access mode'];
        }
        // The parameters are stored independently of the mode, so they stay - which is what makes it
        // possible to go back to a trunk later without retyping them.
        return written({ mode: 'access' },
          iface.name + ' back to access mode (trunk settings kept: native ' + cur.nativeVlan + ', allowed ' +
          (cur.allowedVlans === 'all' ? 'all'
            : (Array.isArray(cur.allowedVlans) ? vlanLib.formatVlanList(cur.allowedVlans) : 'all')) +
          ')');
      }
      return ['% Unrecognized switchport command: no ' + leaf.join(' ')];
    }

    if (t[0] === 'access' && t[1] === 'vlan') {
      const bad = this._vlanIdRefusal(tokens[2], 'an access VLAN');
      if (bad) return [bad];
      const id = parseInt(t[2], 10);
      const chk = vlanLib.validatePortConfig({ accessVlan: id });
      if (!chk.ok) return [this._vlanRefusal(chk, 'access VLAN')];
      const note = modeNote(this, iface, 'access');
      // Assigning a port to a VLAN that does not exist CREATES that VLAN. A Cisco switch says so in two
      // lines - `% Access VLAN does not exist.` then `Creating vlan 22` - applies the assignment anyway, and
      // `show vlan` lists the VLAN afterwards. That transcript is in the Catalyst 3750 software configuration
      // guide 12.2(52)SE ("Configuring IEEE 802.1Q and Layer 2 Protocol Tunneling": `interface
      // gigabitethernet1/0/7` -> `switchport access vlan 22` -> the two lines) and is still word for word the
      // same in the Catalyst 9300 Layer 2 guide from IOS XE Everest 16.9.x to 26.x.
      //
      // This console only moved the port. `show vlan` grew a row because it builds the table from the port
      // list too, so the port and its table agreed while `show running-config` printed no `vlan 22` - the gap
      // #1232 closed for VLANs somebody typed `vlan 22` for, left open on the one command that can create a
      // VLAN without anybody typing `vlan`.
      const created = this._createVlanForPort(id);
      iface.vlan = vlanLib.normalizePortConfig(Object.assign({}, iface.vlan, { accessVlan: id }));
      this.device.flushMacsOnPort(iface.name);
      const said = created ? ['% Access VLAN does not exist.', 'Creating vlan ' + id] : [];
      said.push('Access VLAN ' + id + ' on ' + iface.name + note);
      return said;
    }
    if (t[0] === 'voice' && t[1] === 'vlan') {
      // The voice VLAN was in the config shape, validated and printed, and read by nothing: a phone on a
      // port configured for voice traffic landed in the data VLAN (#1368).
      const arg = String(t[2] === undefined ? '' : t[2]).toLowerCase();
      if (arg === 'none') {
        const was = vlanLib.normalizePortConfig(iface.vlan || {}).voiceVlan;
        if (was === null) return ['% ' + iface.name + ' has no voice VLAN'];
        iface.vlan = vlanLib.normalizePortConfig(Object.assign({}, iface.vlan, { voiceVlan: null }));
        this.device.flushMacsOnPort(iface.name);
        return ['Voice VLAN ' + was + ' removed from ' + iface.name];
      }
      const bad = this._vlanIdRefusal(tokens[2], 'a voice VLAN', 'none');
      if (bad) return [bad];
      const id = parseInt(arg, 10);
      // Validate the field this command writes, not the whole port: a port whose native VLAN is not in its own
      // allowed list (legal to build, reported by `show interfaces`) must still accept a voice VLAN, and the
      // refusal has to be about the number the operator just typed.
      const chk = vlanLib.validatePortConfig({ voiceVlan: id });
      if (!chk.ok) return [this._vlanRefusal(chk, 'voice VLAN')];
      // A voice VLAN is live on an access port and inert on a trunk, which is the reverse of what this console
      // used to say. Cisco's voice VLAN is an access-port feature - the phone tags its own frames, the PC behind
      // it stays untagged in the access VLAN - while on a trunk the parameter is accepted and stored and has no
      // effect, because a trunk carries any number of VLANs as ordinary VLANs
      // (research/voice-vlan-port-mode.md, Catalyst 9200 VLAN Configuration Guide, Configuring Voice VLANs).
      const currentMode = (iface.vlan && iface.vlan.mode) || 'access';
      const note = currentMode === 'access' ? ''
        : ' (stored; a trunk carries VLANs by its allowed list, so the voice VLAN has no effect until the port ' +
          'is in access mode)';
      iface.vlan = vlanLib.normalizePortConfig(Object.assign({}, iface.vlan, { voiceVlan: id }));
      this.device.flushMacsOnPort(iface.name);
      return ['Voice VLAN ' + id + ' on ' + iface.name + note];
    }
    if (t[0] === 'trunk' && t[1] === 'native' && t[2] === 'vlan') {
      const bad = this._vlanIdRefusal(tokens[3], 'a trunk native VLAN');
      if (bad) return [bad];
      const id = parseInt(t[3], 10);
      const chk = vlanLib.validatePortConfig({ nativeVlan: id });
      if (!chk.ok) return [this._vlanRefusal(chk, 'trunk native VLAN')];
      const note = modeNote(this, iface, 'trunk');
      iface.vlan = vlanLib.normalizePortConfig(Object.assign({}, iface.vlan, { nativeVlan: id }));
      this.device.flushMacsOnPort(iface.name);
      return ['Trunk native VLAN ' + id + ' on ' + iface.name + note];
    }
    if (t[0] === 'trunk' && t[1] === 'allowed' && t[2] === 'vlan') {
      const rest = t.slice(3);
      const allowedNote = (iface.vlan && iface.vlan.mode) === 'trunk' ? ''
        : ' (stored; the port is in ' + ((iface.vlan && iface.vlan.mode) || 'access') +
          ' mode - set "switchport mode trunk" to use it)';
      // `add` and `remove` are the words IOS puts in front of a list to edit the one already there, and joining the
      // tokens with no separator ate them: `allowed vlan add 30` became the token `add30` and the console refused a
      // word nobody had typed (#1455). The verb is read from the token list, and only the list is glued together.
      //
      // `except <list>` is the command's third documented verb, and it is not an edit: it *replaces* the list with
      // the inversion of the ids named. "except lists the VLANs that should be calculated by inverting the defined
      // list of VLANs. (VLANs are added except the ones specified.)" - Catalyst 9300 17.12 command reference,
      // `switchport trunk`, vlan-list choices (research/trunk-allowed-except.md). The CCNP lab that uses it prints
      // the answer the inversion gives: `switchport trunk allowed vlan except 1,999` then `show interface trunk` ->
      // `Fa0/7  2-998,1000-4094`, one run straight through the media defaults, which is the universe this console
      // already inverts over for `remove` on a default trunk.
      const verb = String(rest[0] || '').toLowerCase();
      const editing = (verb === 'add' || verb === 'remove');
      const inverting = (verb === 'except');
      const spec = (editing || inverting ? rest.slice(1) : rest).join('');
      if (!spec) {
        return [editing || inverting
          ? '% Incomplete command: switchport trunk allowed vlan ' + verb + ' <list>'
          : '% Incomplete command'];
      }
      const refuseWord = function () {
        return ['% Unrecognized "' + String(rest[0]) + '": this console takes a list (10,20), a range (10-20), ' +
          '"all", "add <list>", "except <list>" or "remove <list>"'];
      };
      if (!editing && spec === 'all') {
        iface.vlan = vlanLib.normalizePortConfig(Object.assign({}, iface.vlan, { allowedVlans: 'all' }));
        this.device.flushMacsOnPort(iface.name);
        return ['Trunk on ' + iface.name + ' allows all VLANs' + allowedNote];
      }
      // The allowed list is read with `keepReserved`: 1002-1005 are members of every trunk's allowed list -
      // the default list is `1-4094` and a switch will not remove them - so naming one here is not the error
      // it is on an access port, where the VLAN's media cannot carry an Ethernet frame at all
      // (research/trunk-allowed-reserved-vlans.md).
      const parsed = vlanLib.parseVlanList(spec, { keepReserved: true });
      if (!parsed.ok) {
        // A word where a list belongs is a question about the command, not a VLAN token to complain about -
        // but the verb `add`/`remove` is not that word. `remove 1-4094` names a real list that the parser
        // refused on its contents (the reserved block), and it was answered `% Unrecognized "remove"`: a
        // refusal of the one word in the line that was certainly correct, hiding the reason the list was
        // refused.
        if (!editing && !inverting && /^[a-z]/i.test(String(rest[0]))) return refuseWord();
        return ['% ' + (parsed.message || 'invalid VLAN list')];
      }
      const bad = parsed.vlans.filter(function (v) { return v < 1 || v > 4094; });
      if (bad.length) return ['% VLAN out of range: ' + bad[0]];
      if (inverting) {
        // The inversion runs over the whole id space a trunk's default list covers, not over the list the port
        // carries now: `except 5` on a port allowing 10 leaves 1-4,6-4094, which is what "VLANs are added except
        // the ones specified" says and what the CCNP capture shows. The four media defaults are the one thing the
        // inversion cannot take out - a switch documents that 1002-1005 cannot be removed from a trunk - so a list
        // that names one is answered the way `remove 1002` is answered: the rule, and the list left alone
        // (research/trunk-allowed-reserved-vlans.md).
        const pinned = parsed.vlans.filter(function (v) { return vlanLib.isReservedVlan(v); });
        const named = parsed.vlans.filter(function (v) { return !vlanLib.isReservedVlan(v); });
        const next = vlanLib.allVlansExcept(named);
        // The dead-trunk question is asked first, the same order `remove` asks it in: `except 1-4094` names the
        // whole id space, and the remaining four media defaults carry no Ethernet frame, so the answer is the
        // refusal the console gives `remove 1-4094`, not a sentence about 1002 that hides a trunk carrying nothing.
        if (!next.some(function (v) { return !vlanLib.isReservedVlan(v); })) {
          return ['% that would leave the trunk allowing no VLANs: name what it should carry instead ' +
            '(switchport trunk allowed vlan <list>) or restore it with "no switchport trunk allowed vlan"' +
            allowedNote];
        }
        if (pinned.length) {
          return ['% VLANs ' + vlanLib.formatVlanList(pinned) + ' stay on every trunk: the four media defaults (' +
            vlanLib.RESERVED_VLANS[0].id + '-' + vlanLib.RESERVED_VLANS[vlanLib.RESERVED_VLANS.length - 1].id +
            ') are always allowed and cannot be removed' + allowedNote];
        }
        iface.vlan = vlanLib.normalizePortConfig(Object.assign({}, iface.vlan, { allowedVlans: next }));
        this.device.flushMacsOnPort(iface.name);
        return ['Trunk on ' + iface.name + ' allows VLANs ' + vlanLib.formatVlanList(next) +
          ' (all but ' + vlanLib.formatVlanList(named) + ')' + allowedNote];
      }
      if (!editing) {
        iface.vlan = vlanLib.normalizePortConfig(Object.assign({}, iface.vlan, { allowedVlans: parsed.vlans }));
        this.device.flushMacsOnPort(iface.name);
        return ['Trunk on ' + iface.name + ' allows VLANs ' + vlanLib.formatVlanList(parsed.vlans) + allowedNote];
      }
      const cur = iface.vlan ? iface.vlan.allowedVlans : 'all';
      const curAll = (cur === 'all' || cur === undefined || cur === null || cur === '');
      const current = curAll ? [] : (Array.isArray(cur) ? cur.slice() : []);
      if (verb === 'add') {
        if (curAll) {
          // Adding to "all" is already true; printing an explicit list of 4,094 ids would be a worse answer than
          // saying so, and storing one would turn one word into a wall of numbers.
          return ['Trunk on ' + iface.name + ' already allows all VLANs: "add" changes nothing' + allowedNote];
        }
        const added = parsed.vlans.filter(function (v) { return current.indexOf(v) === -1; });
        const next = current.concat(added).sort(function (a, b) { return a - b; });
        if (!added.length) {
          return ['Trunk on ' + iface.name + ' already allows VLANs ' + vlanLib.formatVlanList(parsed.vlans) +
            ': the list is unchanged (' + vlanLib.formatVlanList(next) + ')' + allowedNote];
        }
        iface.vlan = vlanLib.normalizePortConfig(Object.assign({}, iface.vlan, { allowedVlans: next }));
        this.device.flushMacsOnPort(iface.name);
        return ['Trunk on ' + iface.name + ' allows VLANs ' + vlanLib.formatVlanList(next) +
          ' (added ' + vlanLib.formatVlanList(added) + ')' + allowedNote];
      }
      if (curAll) {
        // A trunk still allowing the default "all" accepts `remove`: the box subtracts the named VLANs from
        // the list it is already carrying and starts printing the remainder. A Catalyst does exactly this -
        // c3550, `switchport trunk allowed vlan remove 5-10,12` then `add 7`, `show interfaces fa0/2 trunk`
        // prints `1-4,7,11,13-4094` (research/trunk-allowed-remove-from-all.md). This console used to refuse
        // ("name the list it should allow instead") because the remainder is 4,090 ids; printed the way a
        // switch prints it that is one short line, so the refusal has no reason left to exist.
        // 1002-1005 are named but not removable, so they are not subtracted: the remainder the box prints
        // runs through them (`1-4,7,11,13-4094`), and `remove 1-4094` leaves exactly the four defaults.
        const allPinned = parsed.vlans.filter(function (v) { return vlanLib.isReservedVlan(v); });
        const allGone = parsed.vlans.filter(function (v) { return !vlanLib.isReservedVlan(v); });
        const next = vlanLib.allVlansExcept(allGone);
        // "No VLANs left" is about the VLANs that can carry a frame: the four media defaults are in the
        // list but no Ethernet port can join them, so a remainder of only those is the dead trunk this
        // console refuses to build (the same refusal it gave before 1002-1005 were put back in the list).
        if (!next.some(function (v) { return !vlanLib.isReservedVlan(v); })) {
          return ['% that would leave the trunk allowing no VLANs: name what it should carry instead ' +
            '(switchport trunk allowed vlan <list>) or restore it with "no switchport trunk allowed vlan"' +
            allowedNote];
        }
        iface.vlan = vlanLib.normalizePortConfig(Object.assign({}, iface.vlan, { allowedVlans: next }));
        this.device.flushMacsOnPort(iface.name);
        return ['Trunk on ' + iface.name + ' allows VLANs ' + vlanLib.formatVlanList(next) +
          ' (removed ' + vlanLib.formatVlanList(allGone) + ')' +
          (allPinned.length ? '; ' + vlanLib.formatVlanList(allPinned) +
            ' stay: a trunk always allows the four media defaults' : '') + allowedNote];
      }
      // The four media defaults stay: a trunk's allowed list always holds them, which is why a switch
      // documents that they "cannot be removed" and why its remainder after a removal runs straight through
      // them. Removing one is answered rather than performed - the alternative was a stored list the box
      // cannot print, and every view of it would then disagree with the hardware.
      const pinned = parsed.vlans.filter(function (v) { return vlanLib.isReservedVlan(v); });
      const gone = parsed.vlans.filter(function (v) {
        return !vlanLib.isReservedVlan(v) && current.indexOf(v) !== -1;
      });
      if (!gone.length) {
        if (pinned.length) {
          return ['% VLANs ' + vlanLib.formatVlanList(pinned) + ' stay on every trunk: the four media defaults (' +
            vlanLib.RESERVED_VLANS[0].id + '-' + vlanLib.RESERVED_VLANS[vlanLib.RESERVED_VLANS.length - 1].id +
            ') are always allowed and cannot be removed' + allowedNote];
        }
        return ['% VLANs ' + vlanLib.formatVlanList(parsed.vlans) + ' are not allowed on ' + iface.name +
          ': the list is unchanged (' + (current.length ? vlanLib.formatVlanList(current) : 'none') + ')' + allowedNote];
      }
      const next = current.filter(function (v) { return gone.indexOf(v) === -1; });
      if (!next.some(function (v) { return !vlanLib.isReservedVlan(v); })) {
        return ['% that would leave the trunk allowing no VLANs: name what it should carry instead ' +
          '(switchport trunk allowed vlan <list>) or restore it with "no switchport trunk allowed vlan"'];
      }
      iface.vlan = vlanLib.normalizePortConfig(Object.assign({}, iface.vlan, { allowedVlans: next }));
      this.device.flushMacsOnPort(iface.name);
      return ['Trunk on ' + iface.name + ' allows VLANs ' + vlanLib.formatVlanList(next) +
        ' (removed ' + vlanLib.formatVlanList(gone) + ')' +
        (pinned.length ? '; ' + vlanLib.formatVlanList(pinned) +
          ' stay: a trunk always allows the four media defaults' : '') + allowedNote];
    }
    return ['% Unrecognized switchport command: ' + t.join(' ')];
  }

  // ---------- link aggregation ----------

  // A channel group id, checked on both doors of the same command.
  //
  // The set form tested a lower bound only while its own refusal stated `1-4096`, so `channel-group 4097`
  // created a bundle the console said could not exist and every view that lists bundles printed it (#1505);
  // the `no` form checked nothing at all and threw the word away (#1510). One check, both ends, both doors,
  // so a number the console prints as the range is a number it applies.
  _channelGroupId(raw) {
    const s = String(raw == null ? '' : raw);
    if (!/^\d+$/.test(s) || Number(s) < 1 || Number(s) > 4096) {
      return { id: null, error: '% Invalid channel group id "' + s + '": a channel group is identified by a ' +
        'number, 1-4096 (e.g. `channel-group 1 mode active`)' };
    }
    return { id: s, error: null };
  }

  _channelGroup(tokens, iface) {
    const lagLib = require('./lag');
    const dev = this.device;
    const t = tokens.map(function (x) { return String(x).toLowerCase(); });
    if (!dev.config.lags) dev.config.lags = {};

    if (t[0] === 'remove') {
      // It used to print "Removed Fa0/4 from any channel group" for a port that was in none - the same
      // sentence for work done and work not done.
      //
      // The id the operator named is read here rather than thrown away. `no channel-group 9999` answered
      // "Fa0/1 removed from channel group 2": the word was dropped by the dispatcher, so a technician
      // correcting a typo took the port out of the bundle that was carrying traffic, and every view then
      // agreed the port was loose (#1510). An id that is not this port's group is a refusal that names
      // both groups; it is not an action on a group the operator did not ask about.
      //
      // A bare `no channel-group` keeps its old meaning - the group the port is actually in - because that
      // is what an operator types when they do not remember the number.
      const named = (t[1] == null || t[1] === '') ? null : t[1];
      if (named !== null) {
        const chk = this._channelGroupId(tokens[1]);
        if (chk.error) return [chk.error];
      }
      const was = Object.keys(dev.config.lags).filter(function (id) {
        return (dev.config.lags[id].members || []).indexOf(iface.name) !== -1;
      }).sort(function (a, b) { return Number(a) - Number(b); });
      if (!was.length) {
        return [named !== null
          ? '% ' + iface.name + ' is not in channel group ' + named
          : '% ' + iface.name + ' is not in a channel group'];
      }
      if (named !== null && was.indexOf(named) === -1) {
        return ['% ' + iface.name + ' is not in channel group ' + named + ': it is in group ' + was.join(', ')];
      }
      const targets = named !== null ? [named] : was;
      const gone = [];
      for (const id of targets) {
        const l = dev.config.lags[id];
        if (!l) continue;
        l.members = (l.members || []).filter(function (m) { return m !== iface.name; });
        gone.push(id);
        if (!l.members.length) delete dev.config.lags[id];
      }
      return [iface.name + ' removed from channel group ' + gone.join(', ') +
        (gone.some(function (id) { return !dev.config.lags[id]; }) ? ' (the group had no other members)' : '')];
    }

    // The id was taken as whatever word was typed: `channel-group flurbish` created a group called "flurbish",
    // put the port in it, and answered "Interface Fa0/2 added to channel group flurbish (mode active)" - a typo
    // becoming configuration, with a receipt (#1495). The mode was validated and the id was not.
    const id = t[0];
    if (!id) return ['% Usage: channel-group <id> mode active|passive|on'];
    // `channel-group 4097 mode active` used to build a bundle that the refusal's own sentence says cannot
    // exist: the range printed was 1-4096 and the range that was checked was a lower bound only (#1505). Both
    // numbers are applied in `_channelGroupId`, so the range printed and the range checked cannot drift apart.
    const idChk = this._channelGroupId(tokens[0]);
    if (idChk.error) return [idChk.error];
    let typed = 'active';
    const mi = t.indexOf('mode');
    if (mi !== -1 && t[mi + 1]) typed = t[mi + 1];
    if (['active', 'passive', 'on', 'static'].indexOf(typed) === -1) {
      return ['% Invalid mode: ' + typed + ' (use active|passive|on)'];
    }
    // The console's word is translated to the model's once, here; nothing downstream should ever see "active".
    const mode = lagLib.canonicalMode(typed);
    // A port belongs to one bundle. A second `channel-group` moves it, the way IOS does; before this each
    // line added membership to another group, so one cable appeared in every bundle it had ever been joined
    // to - a state no switch can be in, invented by commands that were each typed correctly, and then
    // reported by the view that is supposed to be the truth about bundles (#1510).
    const movedFrom = Object.keys(dev.config.lags).filter(function (other) {
      if (other === id) return false;
      const l = dev.config.lags[other];
      return l && Array.isArray(l.members) && l.members.indexOf(iface.name) !== -1;
    }).sort(function (a, b) { return Number(a) - Number(b); });
    for (const other of movedFrom) {
      const l = dev.config.lags[other];
      l.members = l.members.filter(function (m) { return m !== iface.name; });
      if (!l.members.length) delete dev.config.lags[other];
    }
    const existing = dev.config.lags[id];
    // A group holds what the vendor says it holds, and the view above the config says the same number: a
    // non-negotiating (`mode on`) group takes eight members, LACP takes sixteen because eight of them can sit
    // in hot-standby ("For a PAgP EtherChannel, you can configure up to eight ports ... For a LACP EtherChannel,
    // you can configure up to 16 Ethernet ports ... Up to eight ports can be active, and up to eight ports can
    // be in standby mode", Cisco, Configuring EtherChannels). Before this the console took the ninth, the
    // twelfth and the fortieth, called every one of them `(P)`, and hashed frames across the lot - a bundle no
    // switch builds, carrying traffic no cable carries (research/etherchannel-member-limit.md).
    const cap = lagLib.maxMembers(mode);
    const capSentence = cap === lagLib.MAX_MEMBERS_LACP
      ? 'an LACP bundle holds at most ' + cap + ': 8 active links and 8 in hot-standby'
      : 'a static (`mode on`) bundle carries at most ' + cap + ' links';
    const held = (existing && Array.isArray(existing.members)) ? existing.members.length : 0;
    const alreadyIn = !!(existing && Array.isArray(existing.members) && existing.members.indexOf(iface.name) !== -1);
    // The cap is checked on every door. A join was checked, and the mode change was not - so the one path that
    // rewrites the cap a group already holds under went through unguarded: nine members fit one LACP group
    // (cap sixteen), `channel-group 1 mode on` typed on a member moved the group to `mode on`, cap eight, and
    // left all nine in it (#2033). The console then refused the next `mode on` join with "already holds 8
    // members" over a group holding nine, and told the operator the ninth was hot-standby in a bundle whose own
    // key says hot-standby is `LACP only`. Nothing is parked here: the members are refused the mode instead.
    const retuning = !!(existing && existing.mode && existing.mode !== mode);
    if (existing && alreadyIn && retuning && held > cap) {
      const keep = 'channel-group ' + id + ' mode ' + lagLib.cliMode(existing.mode);
      return ['% Channel group ' + id + ' not moved to mode ' + typed + ': it holds ' + held + ' members, and ' +
        capSentence + ', with no hot-standby to park ' + (held - cap === 1 ? 'the extra member' : 'the extra ' + (held - cap)) +
        ' in. Keep `' + keep + '`, or remove a member first. Nothing was changed.'];
    }
    if (existing && !alreadyIn && Array.isArray(existing.members) && existing.members.length >= cap) {
      // The count named here is the group's, not the cap's: with the mode changing in the same line the two
      // differ, and "already holds 8 members" over a group of nine is a sentence nobody can act on.
      return ['% ' + iface.name + ' not added: channel group ' + id + ' ' +
        (retuning ? 'holds ' + held + ' members, and `channel-group ' + id + ' mode ' + typed +
          '` would make ' + (held + 1) + ' - above the ' + cap + ' links such a bundle carries'
          : 'already holds ' + held + ' members, and ' + capSentence) +
        '. Nothing was changed.'];
    }
    const g = existing || { mode: mode, hashPolicy: 'l2', members: [] };
    const out = [];
    // A box builds the bundle on the command that gives the group its **first** port, and prints one line for
    // it before anything else: `Creating a port-channel interface Port-channel 1`. The second member joins
    // without a receipt, because the interface it would create already exists (Cisco doc 23408 prints exactly
    // that pair - two `channel-group 1 mode active` lines, one receipt). So the line belongs to the creation,
    // not to the command: a group that already exists prints nothing, and a refused join must not print it
    // either, which is why it is pushed here, after every refusal above and not before them.
    // research/channel-group-creating-receipt.md.
    if (!existing) out.push(lagLib.createReceipt(id));
    if (existing && existing.mode && existing.mode !== mode) {
      // A group is one object: its mode belongs to every member. Changing it from one port silently rewrote
      // what the other ports were configured with, and `show running-config` quietly reprinted them all with
      // the new mode. Say it.
      const others = (existing.members || []).filter(function (m) { return m !== iface.name; });
      out.push('Channel group ' + id + ' mode changed from ' + lagLib.cliMode(existing.mode) + ' to ' + typed +
        (others.length ? ' for every member: ' + others.join(', ') : ''));
    }
    g.mode = mode;
    if (!g.members) g.members = [];
    if (g.members.indexOf(iface.name) === -1) g.members.push(iface.name);
    dev.config.lags[id] = g;

    out.push(movedFrom.length
      ? 'Interface ' + iface.name + ' moved from channel group ' + movedFrom.join(', ') + ' to ' + id +
        ' (mode ' + lagLib.cliMode(mode) + ')'
      : 'Interface ' + iface.name + ' added to channel group ' + id + ' (mode ' + lagLib.cliMode(mode) + ')');
    // Above eight members the ninth is not in the channel: LACP parks it as hot-standby, and saying "added"
    // with no more than that would read as a ninth active link. The set is chosen the way the hardware chooses
    // it - lowest port numbers first - so the answer is known here and not guessed.
    if (g.mode !== 'static') {
      const standby = lagLib.standbyMembers(g.members, null);
      if (standby.indexOf(iface.name) !== -1) {
        out.push('  ' + iface.name + ' is hot-standby: the bundle already has ' + lagLib.MAX_ACTIVE_LINKS +
          ' active links, and this one takes over if an active link fails');
      }
    }
    // The port records, which nobody passed (#1524). Every per-member rule in engine/lag.js - rate, duplex,
    // VLAN set - is guarded by "do I have a record for this port", so with no records the whole section was
    // skipped and a bundle of ports that cannot carry traffic the same way was accepted with a receipt and no
    // word. The rules were written, tested in isolation, and unreachable from the console.
    // The group's name travels with it: `lags` is keyed by the number the operator typed but the object does
    // not carry it, and `validateLag()` falls back to a default id - so every warning would have named a group
    // that does not exist rather than the one just configured.
    const named = Object.assign({ id: String(id) }, g);
    const chk = lagLib.validateLag ? lagLib.validateLag(named, this._lagMemberPorts(g)) : null;
    // A group is built one port at a time, so "needs at least 2 members" is true of every bundle for as long
    // as it takes to type the second line. Warning on it turns every correct configuration into a warning
    // storm, which is how a warning stops being read. The shortfall is reported where it matters - in
    // `show etherchannel summary`, which already says the bundle is not carrying traffic and why.
    const NOT_HERE_YET = ['E_LAG_TOO_FEW'];
    const real = (chk && chk.ok === false && Array.isArray(chk.errors))
      ? chk.errors.filter(function (e) { return NOT_HERE_YET.indexOf(e.code) === -1; })
      : [];
    if (real.length) out.push('% Warning: ' + real[0].message);
    // A warning is a true statement that does not refuse the command - a shut member will carry nothing, and
    // saying so at the moment the port joins is the only time the operator is looking at that port.
    const soft = (chk && Array.isArray(chk.warnings)) ? chk.warnings : [];
    if (soft.length) out.push('% Warning: ' + soft[0].message);
    return out;
  }

  // The member records `lag.validateLag()` needs, read off the ports the bundle actually names.
  //
  // `speedMbps` is the rate the port will run at: a forced rate if one was typed, otherwise the rate the
  // catalogue gives the port. A bundle's whole point is one logical link, so members at different rates are
  // the classic half-working bundle and the check has to see the rate, not the capability.
  // `vlanCompatible` is not this function's opinion: engine/vlan.js decides whether two ports file a frame
  // the same way, and the first member is the one the rest must agree with.
  _lagMemberPorts(g) {
    const out = [];
    const members = (g && Array.isArray(g.members)) ? g.members : [];
    let ref = null;
    for (const name of members) {
      const i = this.device.interfaces.get(name);
      if (!i) continue;
      const rated = mediaLib.parseSpeedMbps(i.speed);
      const hwMax = (i.hardware && i.hardware.maxSpeedMbps) ? i.hardware.maxSpeedMbps : null;
      const rec = {
        name: name,
        speedMbps: i.speedMbps || rated || hwMax || null,
        duplex: i.duplex || null,
        enabled: i.enabled !== false
      };
      if (i.vlan) {
        if (!ref) ref = i;
        else rec.vlanCompatible = vlanLib.framesCompatible(ref.vlan, i.vlan);
      }
      out.push(rec);
    }
    return out;
  }

  // ---------- access lists ----------
  _accessList(tokens) {
    const aclLib = require('./acl');
    if (!tokens.length) return ['% Incomplete command'];
    const num = parseInt(tokens[0], 10);
    const kind = aclLib.aclKind(num);
    if (!kind) return ['% Invalid access list number: ' + tokens[0]];
    const entry = aclLib.parseEntry(tokens.slice(1).join(' '), num);
    // `parseEntry` reports a refusal as `{ code, message }`, and this printed the object: `access-list 10 permit
    // 300.1.1.0 0.0.0.255` answered `% [object Object]` (#1411). The message is the part to print.
    if (!entry || entry.error) {
      const why = entry && entry.error;
      return ['% ' + (why && why.message ? why.message : (typeof why === 'string' ? why : 'invalid entry'))];
    }
    const dev = this.device;
    if (!dev.config.acls) dev.config.acls = {};
    const key = String(num);
    if (!dev.config.acls[key]) dev.config.acls[key] = [];
    dev.config.acls[key].push(entry);
    return [kind.charAt(0).toUpperCase() + kind.slice(1) + ' access list ' + num +
      ': ' + entry.action + ' entry added'];
  }

  _accessGroup(tokens, iface) {
    const aclLib = require('./acl');
    const dev0 = this.device;
    if (String(tokens[0]).toLowerCase() === 'no') {
      // `ip access-group` had no `no` form at all: an interface could be given an access list, the config
      // printed the line, and there was no way to take it off again from the console.
      const rest = tokens.slice(1);
      const want = rest[0] != null ? parseInt(rest[0], 10) : null;
      const dir = String(rest[1] || '').toLowerCase();
      if (dir && dir !== 'in' && dir !== 'out') return ['% Usage: no ip access-group [<acl>] [in|out]'];
      const binds = (dev0.aclBindings && dev0.aclBindings[iface.name]) || {};
      const dirs = dir ? [dir] : ['in', 'out'];
      const cleared = [];
      for (const d of dirs) {
        if (binds[d] == null) continue;
        // Never unbind a different list than the one named: silently clearing whatever happened to be there
        // would take away a policy the operator did not ask about.
        if (want != null && Number(binds[d]) !== want) {
          return ['% Access list ' + binds[d] + ' is applied ' + d + ' on ' + iface.name + ', not ' + want];
        }
        delete binds[d];
        cleared.push(d);
      }
      if (!cleared.length) {
        // "No an access list applied in or out on Gi0/0" is what this said: ungrammatical, and phrased as if the
        // `no` had removed something. The house shape for "removing what is not there" is the one the sibling
        // refusals use - `No hostname set`, `No DHCP pool named nope` - so this says which list, or that there is
        // none, and where it looked (#1501).
        const where = dir || 'in or out';
        return [want != null
          ? '% No access list ' + want + ' applied ' + where + ' on ' + iface.name
          : '% No access list applied ' + where + ' on ' + iface.name];
      }
      if (dev0.aclBindings && dev0.aclBindings[iface.name] &&
          !Object.keys(dev0.aclBindings[iface.name]).length) {
        delete dev0.aclBindings[iface.name];
      }
      return ['Interface ' + iface.name + ': access list unapplied ' + cleared.join(' and ')];
    }
    const num = parseInt(tokens[0], 10);
    const dir = String(tokens[1] || '').toLowerCase();
    if (!aclLib.aclKind(num)) return ['% Invalid access list number: ' + (tokens[0] || '')];
    if (dir !== 'in' && dir !== 'out') return ['% Usage: ip access-group <acl> in|out'];
    const dev = this.device;
    if (!dev.config.acls || !dev.config.acls[String(num)]) {
      return ['% Access list ' + num + ' does not exist'];
    }
    if (!dev.aclBindings) dev.aclBindings = {};
    if (!dev.aclBindings[iface.name]) dev.aclBindings[iface.name] = {};
    dev.aclBindings[iface.name][dir] = num;
    return ['Interface ' + iface.name + ': access list ' + num + ' applied ' + dir];
  }

  // ---------- config: vrrp (per interface) ----------
  //
  // A group belongs to an interface: the vrid plus the interface is the key, which is why the same
  // vrid can exist on two interfaces of one router without them being the same group.
  _vrrpIfaceCommand(tokens) {
    const vrrpLib = require('./vrrp');
    const out = [];
    const dev = this.device;
    if (!this.iface) return ['% vrrp must be configured inside an interface'];
    const vrid = parseInt(tokens[1], 10);
    if (!Number.isInteger(vrid) || vrid < 1 || vrid > 255) {
      return ['% Invalid virtual router id: ' + (tokens[1] || '(none)') + ' (1-255)'];
    }
    if (!Array.isArray(dev.config.vrrp)) dev.config.vrrp = [];

    const find = function () {
      return dev.config.vrrp.filter(function (g) {
        return g.vrid === vrid && g.interface === this.iface;
      }, this)[0];
    }.bind(this);

    if (tokens[0] === 'no' || tokens[0] === 'no-') {
      // 'no vrrp <vrid>' is dispatched from the config mode handler, not here.
      return null;
    }

    let group = find();
    // The argument is validated BEFORE the group exists: a command that is refused must not leave
    // an empty group behind, or `show vrrp` reports a virtual gateway that was never configured.
    if (!group && !tokens[2]) return ['% Incomplete command: vrrp <vrid> ip <address>'];
    const what = (tokens[2] || '').toLowerCase();
    if (what === 'ip') {
      const ip = tokens[3];
      // `vrrp 1 ip` with no address is a short line, not a bad address (#1497).
      if (!ip) return ['% Incomplete command: vrrp <vrid> ip <address>'];
      if (!net.isIp(ip)) return ['% Invalid address "' + ip + '": not an IPv4 address'];
      // A virtual gateway is only a gateway for hosts on its own wire. Cisco refuses the line
      // ("% 10.0.0.254 is not in the subnet of Gi0/0"), and without this check the election happily
      // makes the router master of a group whose address belongs to a network it cannot reach - the
      // claim then answers ARP from the wrong segment (#1245).
      const port = dev.resolveIface(this.iface);
      if (!port) return ['% No interface ' + this.iface];
      if (!port.ip || !port.mask) {
        return ['% Interface ' + this.iface + ' has no address: a VRRP group needs one in the same subnet'];
      }
      if (!net.sameSubnet(ip, port.ip, port.mask)) {
        return ['% ' + ip + ' is not in the subnet of ' + this.iface +
          ' (' + port.ip + '/' + net.prefixOf(port.mask) + ')'];
      }
      if (!group) {
        group = { vrid: vrid, interface: this.iface, ips: [], priority: 100, preempt: true, advertSec: 1 };
        dev.config.vrrp.push(group);
      }
      if (group.ips.indexOf(ip) === -1) group.ips.push(ip);
      out.push('VRRP group ' + vrid + ' on ' + this.iface + ' owns ' + ip);
    } else if (what === 'priority') {
      if (!group) return ['% No VRRP group ' + vrid + ' on ' + this.iface + ': give it an address first'];
      const p = parseInt(tokens[3], 10);
      // 255 is not a configurable priority: on IOS the parser's own range for this keyword is 1-254
      // (`vrrp 1 priority ?` answers `<1-254>  Priority level(default 100)`), and 255 is the value the
      // group takes when this router owns the virtual address. Accepting it here let an operator type a
      // priority that means "I am the address owner" on a box that is not one.
      if (!Number.isInteger(p) || p < 1 || p > 254) return ['% Invalid priority: ' + (tokens[3] || '(none)') + ' (1-254)'];
      group.priority = p;
      out.push('VRRP group ' + vrid + ' priority ' + p);
    } else if (what === 'preempt') {
      if (!group) return ['% No VRRP group ' + vrid + ' on ' + this.iface];
      group.preempt = !(tokens[0] === 'no');
      out.push('VRRP group ' + vrid + ' preempt ' + (group.preempt ? 'enabled' : 'disabled'));
    } else if (what === 'advertise' || what === 'advertisement') {
      if (!group) return ['% No VRRP group ' + vrid + ' on ' + this.iface];
      const a = Number(tokens[3]);
      if (!Number.isFinite(a) || a <= 0) return ['% Invalid advertisement interval: ' + (tokens[3] || '(none)')];
      group.advertSec = a;
      out.push('VRRP group ' + vrid + ' advertises every ' + a + ' s');
    } else if (what === 'authentication') {
      if (!group) return ['% No VRRP group ' + vrid + ' on ' + this.iface];
      group.authText = tokens.slice(3).join(' ').slice(0, 8);
      out.push('VRRP group ' + vrid + ' authentication set');
    } else {
      return ['% Unrecognized vrrp command: ' + tokens.join(' ')];
    }

    // The library validates the group; report its judgement rather than a second opinion.
    const check = vrrpLib.validateGroup(vrrpLib.normalizeGroup(group));
    if (!check.ok && check.errors.length) {
      for (const e of check.errors) out.push('% ' + e.code + ': ' + (e.message || e.description || ''));
    }
    return out;
  }

  // show vrrp - the state after the last election, which is what an operator checks.
  _showVrrp() {
    const out = [];
    const dev = this.device;
    const groups = Array.isArray(dev.config && dev.config.vrrp) ? dev.config.vrrp : [];
    if (!groups.length) { out.push('% VRRP is not configured'); return out; }
    // The election's own verdict, when there has been one. `show vrrp` used to print this device's name
    // in the Master column for every group, so a backup router advertised itself as the master - the one
    // column an operator reads to find out which box is answering for the gateway (#1241).
    const verdicts = (this.sim && typeof this.sim.vrrpFor === 'function') ? this.sim.vrrpFor(dev.id) : [];
    const claims = (dev.vrrpClaims || []);
    // Groups where this router holds the virtual address itself. The Pri column quotes the priority the
    // group runs at, and for these that is 255 - Cisco: "If a VRRP group is the IP address owner, its
    // priority is fixed at 255", and the election here has always voted that way (#1727). Printing the
    // configured 100 next to a router that just outranked a 254 is a table arguing with its own
    // election.
    const vrrpLib = require('./vrrp');
    const ownerNotes = [];
    out.push(pad('Interface', 14) + pad('Group', 7) + pad('Pri', 5) + pad('State', 11) +
      pad('Master', 18) + pad('Virtual IP', 16) + 'Virtual MAC');
    for (const g of groups) {
      const verdict = verdicts.filter(function (v) {
        return v.vrid === g.vrid && v.iface === (g.interface || v.iface);
      })[0] || null;
      const claim = claims.filter(function (c) {
        return c.vrid === g.vrid && c.iface === g.interface;
      })[0];
      const port = dev.resolveIface(g.interface);
      // Eligible at all? An interface that is down or unaddressed cannot host the group, and neither can
      // one whose subnet does not contain the virtual address - the command refuses that now, but a
      // topology file written before it existed can still carry such a group (#1245).
      const ips = Array.isArray(g.ips) ? g.ips : [];
      const offSubnet = !!(port && port.ip && port.mask) && ips.length > 0 &&
        !ips.some(function (ip) { return net.sameSubnet(ip, port.ip, port.mask); });
      const outOfIt = !port || port.enabled === false || !port.ip || offSubnet;
      let state;
      let master;
      if (verdict) {
        state = verdict.masterId === dev.id ? 'Master' : 'Backup';
        // "elected but not yet answering" is a real, temporary state and worth showing: the winner is
        // decided, the virtual MAC is not answering ARP for it until the group converges.
        master = (verdict.masterIp || verdict.masterName) + (verdict.owning ? '' : ' (pending)');
      } else if (outOfIt) {
        // VRRP calls a router that is not participating Init. "Backup" would claim it is standing by for
        // a group its own interface cannot reach - whether it is down, unaddressed, or the address is not
        // on this wire at all.
        state = 'Init';
        master = '-';
        if (offSubnet) {
          out.push('% VRRP group ' + g.vrid + ' on ' + g.interface + ': ' + ips.join(',') +
            ' is not in the subnet of ' + port.name + ' (' + port.ip + '/' + net.prefixOf(port.mask) +
            ') - the group cannot take part');
        }
      } else {
        state = claim ? 'Master' : 'Backup';
        master = claim ? (dev.name || dev.id) : '-';
      }
      // The virtual MAC is a hardware address, so it prints in the same dotted form as every other one this
      // console shows, and in the form the device's own `show vrrp detail` uses: 0000.5e00.010a.
      const virtualMac = (verdict && verdict.mac) || (claim && claim.mac) || null;
      // The owner check is the election's own predicate, asked of this router's interface address, so
      // the column and the vote cannot disagree about which value is in force.
      const isOwner = vrrpLib.isOwner({ ip: port ? port.ip : null }, ips);
      const configured = (g.priority === undefined || g.priority === null) ? vrrpLib.VRRP_DEFAULT_PRIORITY : g.priority;
      const inForce = vrrpLib.effectivePriority({ owner: isOwner, priority: configured });
      if (isOwner) {
        ownerNotes.push('% VRRP group ' + g.vrid + ' on ' + g.interface + ': this device holds ' +
          (port && port.ip ? port.ip : ips.join(',')) + ', so it is the address owner and its priority is ' +
          inForce + ' (owner mode) - `vrrp ' + g.vrid + ' priority` cannot set that value');
      }
      out.push(pad(String(g.interface), 14) + pad(String(g.vrid), 7) +
        pad(String(inForce), 5) +
        pad(state, 11) +
        pad(master, 18) +
        pad((g.ips || []).join(','), 16) +
        (virtualMac ? net.formatMac(virtualMac) : '-'));
    }
    out.push.apply(out, ownerNotes);
    // The old note fired whenever this device held no claim, and told you to run a simulation even when
    // one had just run. Two different situations, two different sentences.
    if (!verdicts.length && !claims.length) {
      out.push(this.sim
        ? '(this device took part in no VRRP election - check that its interface is up and addressed)'
        : '(no election has run for this device - start a simulation)');
    }
    return out;
  }

  // ---------- config: ip dhcp pool ----------
  //
  // The pool is stored exactly as engine/dhcp.js normalises it at run time, and validated here so a
  // typo is caught while it is typed rather than by a client that never gets an address. The
  // validation is the library's own, not a second opinion: normalizePool() + validatePool().
  _dhcpPoolMode(tokens) {
    const out = [];
    const dhcpLib = require('./dhcp');
    const head = tokens[0].toLowerCase();
    if (head === 'help' || head === '?') return this._help();
    const noKeyed = this._noHelpKeyRefusal(tokens);
    if (noKeyed) return [noKeyed];
    const pools = (this.device.config && this.device.config.dhcpPools) || [];
    const pool = pools.filter(function (p) {
      return p.name === this.pool;
    }, this)[0];
    if (!pool) { this.mode = MODE_CONFIG; return ['% Pool no longer exists']; }

    // A pool is legitimately incomplete while it is being typed - 'network' before 'range' is not an
    // error, it is the second keystroke. Nothing is validated per command; the pool is checked once,
    // when the operator leaves the sub-mode, and again at run time where it matters.
    function incomplete(msg) {
      out.push('% ' + msg);
      return out;
    }

    const finish = (mode) => {
      // Leaving the sub-mode is the first honest moment to judge the pool.
      const check = dhcpLib.validatePool(dhcpLib.normalizePool(pool));
      if (!check.ok) {
        // Phrased as a statement about the pool, not about the command just typed: after `no range` this used
        // to read like the deletion had been rejected, when it had been carried out and left the pool
        // incomplete - which is exactly the state the operator asked for.
        for (const e of check.errors) out.push('% Pool ' + pool.name + ' is incomplete - ' + e.message +
          ' (' + e.code + ')');
      }
      this.mode = mode;
      this.pool = null;
      return out;
    };

    if (head === 'exit') return finish(MODE_CONFIG);
    if (head === 'end') return finish(MODE_ENABLE);
    if (head === 'network') {
      if (!tokens[1]) return incomplete('Incomplete command: network <network> [mask|/prefix]');
      // The usage line has always advertised the `/prefix` spelling, and the parser stored it verbatim: the
      // pool then held network "10.5.0.0/24", which the validator rejects, so a documented form of the
      // command produced a pool that could not serve. Split it here, with the one mask rule, so both
      // spellings end up as the same state.
      const slash = String(tokens[1]).indexOf('/');
      if (slash !== -1) {
        const networkPart = String(tokens[1]).slice(0, slash);
        const prefixPart = String(tokens[1]).slice(slash + 1);
        const maskFromPrefix = require('./net').maskFromPrefix;
        const mask = /^\d+$/.test(prefixPart) && parseInt(prefixPart, 10) <= 32
          ? maskFromPrefix(parseInt(prefixPart, 10)) : null;
        if (!networkPart || !mask) {
          return incomplete('Invalid network "' + tokens[1] +
            '" - use <network> <mask> or <network> <prefix-bits>');
        }
        pool.network = networkPart;
        pool.mask = mask;
      } else {
        pool.network = tokens[1];
        if (tokens[2]) pool.mask = tokens[2];
      }
    } else if (head === 'default-router') {
      if (!tokens[1]) return incomplete('Incomplete command: default-router <address>');
      pool.gateway = tokens[1];
    } else if (head === 'dns-server') {
      if (!tokens[1]) return incomplete('Incomplete command: dns-server <address...>');
      pool.dns = tokens.slice(1).join(' ');
    } else if (head === 'range') {
      if (!tokens[1] || !tokens[2]) return incomplete('Incomplete command: range <start> <end>');
      pool.rangeStart = tokens[1];
      pool.rangeEnd = tokens[2];
    } else if (head === 'excluded-address' || (head === 'excluded' && tokens[1] === 'address')) {
      const from = head === 'excluded' ? 2 : 1;
      const addrs = tokens.slice(from).filter(Boolean);
      if (!addrs.length) return incomplete('Incomplete command: excluded-address <address[-address]>');
      pool.excluded = (Array.isArray(pool.excluded) ? pool.excluded : []).concat(addrs);
    } else if (head === 'lease') {
      // Days by default, like IOS: `lease 0 12 0` is 12 hours.
      //
      // The vendor states two forms of this command and this console had one: `lease {days [hours [minutes]] |
      // infinite}` (Cisco IOS IP Addressing Services Command Reference, ipaddr-l1). The word form was refused as
      // `Incomplete command: lease <days> [hours] [minutes]` - which is the wrong diagnosis, since nothing was
      // missing; the console simply did not know the word. An operator with a printer pool therefore could not
      // ask for the lease that pool actually wants, and the refusal taught them to look for a missing number
      // (#fidelity: lease infinite). Keywords are not abbreviated in a sub-mode (research/command-word-
      // abbreviation.md states the boundary), so the whole word is what is accepted.
      const word = String(tokens[1] || '').toLowerCase();
      if (word === 'infinite') {
        if (tokens.length > 2) {
          return ['% Invalid input: "' + tokens.join(' ') + '" (lease <days> [hours] [minutes] | infinite)'];
        }
        pool.leaseSec = 'infinite';
      } else {
        const nums = tokens.slice(1).filter(function (x) { return /^\d+$/.test(x); }).map(Number);
        if (!nums.length) return incomplete('Incomplete command: lease <days> [hours] [minutes] | infinite');
        const days = nums[0] || 0, hours = nums[1] || 0, mins = nums[2] || 0;
        const sec = days * 86400 + hours * 3600 + mins * 60;
        if (sec <= 0) return incomplete('A lease must be longer than zero');
        pool.leaseSec = String(sec);
      }
    } else if (head === 'host') {
      // host <address> <hardware-address> - a reservation, which is how a printer keeps its address.
      //
      // The two tokens are told apart by shape, because `host <mac> <address>` is the same statement in the other
      // order and this handler used to store it verbatim: the reservation came out keyed by the *address*, so the
      // pool held `{"192.168.10.104": "aa:bb:cc:00:00:98"}` and said nothing until `exit` refused the whole pool
      // with "reservation key ... is not a valid MAC address" (#1373). A refusal at the point of the typo beats a
      // refusal three commands later that blames the pool.
      if (!tokens[1] || !tokens[2]) return incomplete('Incomplete command: host <address> <mac> | host <mac> <address>');
      // The two tokens are told apart by the engine's own MAC rule, not a shape of this handler's own: the
      // dotted address `show mac address-table` prints is the same 48 bits as its colon form, and a reservation
      // keyed by a spelling the printer never emits would be a second copy of one address.
      const one = macSpelling(tokens[1]), two = macSpelling(tokens[2]);
      const addr1 = net.isIp(String(tokens[1])), addr2 = net.isIp(String(tokens[2]));
      let address = null, mac = null;
      if (addr1 && two) { address = tokens[1]; mac = two; }
      else if (one && addr2) { address = tokens[2]; mac = one; }
      if (address === null || mac === null) {
        return ['% Not a reservation: give an address and a MAC, in either order ' +
          '(host ' + tokens[1] + ' ' + tokens[2] + ' is neither). A MAC is six hex pairs, as aa:bb:cc:00:00:99, ' +
          'aa-bb-cc-00-00-99 or aabb.cc00.0099.'];
      }
      if (!pool.reservations) pool.reservations = {};
      pool.reservations[mac] = address;
    } else if (head === 'no') {
      const what = (tokens[1] || '').toLowerCase();
      // These used to answer nothing at all - not even "done" - so a `no` that silently did nothing was
      // indistinguishable from one that worked, and `no network` was missing outright. Each now says what it
      // removed, or refuses and names what is not there.
      if (what === 'network') {
        if (pool.network == null && pool.mask == null) return ['% No network configured in pool ' + pool.name];
        delete pool.network;
        delete pool.mask;
        out.push('Network cleared from pool ' + pool.name);
      } else if (what === 'default-router') {
        if (pool.gateway == null) return ['% No default-router in pool ' + pool.name];
        delete pool.gateway;
        out.push('Default router cleared from pool ' + pool.name);
      } else if (what === 'dns-server') {
        if (pool.dns == null) return ['% No dns-server in pool ' + pool.name];
        delete pool.dns;
        out.push('DNS servers cleared from pool ' + pool.name);
      } else if (what === 'range') {
        if (pool.rangeStart == null) return ['% No range in pool ' + pool.name];
        delete pool.rangeStart;
        delete pool.rangeEnd;
        out.push('Range cleared from pool ' + pool.name);
      } else if (what === 'lease') {
        if (pool.leaseSec == null) return ['% No lease in pool ' + pool.name + ' (the default applies)'];
        delete pool.leaseSec;
        out.push('Lease cleared from pool ' + pool.name + ' (the default applies)');
      } else if (what === 'excluded-address' || (what === 'excluded' && tokens[2] === 'address')) {
        // Naming one address removes that one; naming none clears the list. Clearing the whole list when one
        // address was named is how a box quietly starts handing out an address that was reserved for a printer.
        const from = what === 'excluded' ? 3 : 2;
        const named = tokens.slice(from).filter(Boolean);
        const have = Array.isArray(pool.excluded) ? pool.excluded : [];
        if (!have.length) return ['% No excluded addresses in pool ' + pool.name];
        if (!named.length) {
          pool.excluded = [];
          out.push('All excluded addresses cleared from pool ' + pool.name + ' (' + have.length + ')');
        } else {
          const missing = named.filter(function (x) { return have.indexOf(x) === -1; });
          if (missing.length === named.length) {
            return ['% Not excluded in pool ' + pool.name + ': ' + named.join(', ')];
          }
          pool.excluded = have.filter(function (x) { return named.indexOf(x) === -1; });
          out.push('Excluded address removed from pool ' + pool.name + ': ' +
            named.filter(function (x) { return have.indexOf(x) !== -1; }).join(', '));
        }
      } else if (what === 'host') {
        // host <address> [<mac>] - the address may be named alone when only one reservation holds it.
        // `no host <addr>` and `no host <mac>` are both legal: a MAC address and an IPv4 address are told
        // apart by shape, so the one-token form is not mistaken for an address it can never match.
        // Same rule, same spellings: a reservation added dotted must be removable dotted, and the keys are
        // canonical, so both sides are folded before they are compared.
        const typedMac = macSpelling(tokens[2]);
        const addr = typedMac ? null : tokens[2];
        const mac = typedMac || tokens[3];
        const wantMac = macSpelling(mac);
        const res = pool.reservations || {};
        const byMac = Object.keys(res).filter(function (m) {
          if (mac) return macSpelling(m) === wantMac;
          return res[m] === addr;
        });
        if (!addr && !mac) return ['% Incomplete command: no host <address> [<mac>]'];
        if (!byMac.length) {
          // The token that was typed comes back, address or MAC: "no reservation in pool lan" leaves the reader
          // unable to tell a typo from the wrong pool.
          // The spelling that was typed, not the canonical form it folded to: a reader who typed the dotted
          // address should see the dotted address come back.
          const named = tokens[2] || tokens[3];
          return ['% No reservation' + (named ? ' for ' + named : '') + ' in pool ' + pool.name];
        }
        const gone = byMac.map(function (m) { return res[m] + ' (' + m + ')'; });
        for (const m of byMac) delete res[m];
        out.push('Reservation removed from pool ' + pool.name + ': ' + gone.join(', '));
      } else if (what === 'pool') {
        this.device.config.dhcpPools = pools.filter(function (p) { return p.name !== this.pool; }, this);
        this.mode = MODE_CONFIG;
        this.pool = null;
        out.push('Removed DHCP pool');
        return out;
      }
      return out;
    } else {
      return ['% Unrecognized DHCP pool command: ' + tokens.join(' ')];
    }

    return out;
  }

  // ---------- ping ----------
  //
  // `ping 10.0.0.2` and `ping 10.0.0.2 5 at 5000` - the last form asks the question 5 seconds after
  // power-on, which is the only way to watch a lab come up. Real hardware prints a time in
  // milliseconds; this prints the delay the engine computed from the path (propagation +
  // serialisation + store-and-forward), and falls back to the hop count if a link has no length.
  _ping(tokens) {
    const out = [];
    const ip = tokens[0];
    // The repeat count the box itself uses when nobody names one: five, the vendor's own default, so a bare
    // `ping <address>` here and on real gear send the same number of echoes (research/ping-default-repeat-count.md).
    let count = require('./simulator').PING_COUNT_DEFAULT;
    let requestedCount = null;
    let atMs = null;
    let strayToken = null;
    let atProblem = null;
    for (let i = 1; i < tokens.length; i++) {
      const tok = String(tokens[i]);
      if (tok.toLowerCase() === 'at') {
        const when = tokens[i + 1];
        if (when === undefined) { atProblem = 'Invalid instant: "at" needs a time in milliseconds'; i++; continue; }
        const t = Number(when);
        if (!Number.isFinite(t) || t < 0) { atProblem = 'Invalid instant: ' + when; i++; continue; }
        atMs = t;
        i++;
        continue;
      }
      if (/^[0-9]+$/.test(tok)) { requestedCount = Number(tok); count = requestedCount; continue; }
      if (strayToken === null) strayToken = tok;
    }
    // A hostname is a target. `Simulator.ping()` has resolved names through the lab's DNS servers since
    // #241 - it emits a dns event and distinguishes NXDOMAIN from NODATA from SERVFAIL - and this guard
    // refused the name before the engine ever saw it, so the one command everybody reaches for first could
    // not use the resolver the product already has (#1375).
    const target = String(ip === undefined || ip === null ? '' : ip);
    if (!target) return ['% Invalid ping target: (none)'];
    // The count was whatever the number after the address happened to be, so `ping 10.0.0.1 5000` sent 5000
    // echoes, `ping 10.0.0.1 0` silently sent four, and a stray word was ignored. Name the rule instead (#1379):
    // one syntax, one message per mistake.
    if (strayToken !== null) {
      return ['% Unrecognized "' + strayToken + '" (ping <address|name> [<count 1-50>] [at <ms>])'];
    }
    if (requestedCount !== null && (requestedCount < 1 || requestedCount > 50)) {
      return ['% Count must be a whole number from 1 to 50 (asked for ' + requestedCount + ')'];
    }
    if (atProblem !== null) return ['% ' + atProblem];
    // A literal IPv6 address is an address, not a name (#1461). The IPv4 test above cannot see one, so
    // `ping 2001:db8:1::1` went to the resolver and came back as a DNS failure about a "name" that is an address -
    // while the engine has had an IPv6 echo path (`Simulator.ping6`) that this console could not reach at all.
    const ipv6Lib = require('./ipv6');
    let literal6 = null;
    if (target.indexOf(':') !== -1) {
      const parsed6 = ipv6Lib.parseIpv6(target);
      if (!parsed6.valid) {
        const why = parsed6.error && parsed6.error.message ? parsed6.error.message : 'not an IPv6 address';
        return ['% Invalid IPv6 address: ' + target + ' (' + why + ')'];
      }
      literal6 = parsed6;
    }
    const namedTarget = !isIpv4Literal(target) && !literal6;
    // Digits and dots that are not an address are a typo, not a hostname: resolving 10.0.0.999 as a name would
    // answer NXDOMAIN and send the operator looking in the wrong place.
    if (namedTarget && /^[0-9.]+$/.test(target)) {
      return ['% Invalid ping target: ' + target + ' (not an IPv4 address, and not a name that could resolve)'];
    }
    if (!this.sim) return ['% Simulator not attached'];
    // The instant is a property of the question, not of the session. `setRunTime()` persists on the simulator, so
    // `ping <a> at 0` used to leave the whole console answering at t=0 - the next plain `ping`, a later
    // `show ip route`, anything - and the answer's convergence line printed `at t=null ms` because it read the
    // typed value instead of the instant used (#1383).
    const priorRunAtMs = this.sim.runAtMs;
    if (atMs !== null) {
      if (!Number.isFinite(atMs) || atMs < 0) return ['% Invalid instant: ' + tokens[tokens.indexOf('at') + 1]];
      this.sim.setRunTime(atMs);
    }
    try {
    let shownTarget = target;
    // ICMPv6 echo, when the target is a literal IPv6 address. The report is the same report - same marks line, same
    // success rate, same clause - because an operator reading a ping should not have to learn two shapes.
    if (literal6) {
      out.push('Type escape sequence to abort.');
      const shown6 = ipv6Lib.formatIpv6(literal6.groups) || target;
      out.push('Sending ' + count + ', 100-byte ICMP Echos to ' + shown6 + ', timeout is 2 seconds:' +
        (atMs !== null ? '  (at t=' + atMs + ' ms)' : ''));
      const res6 = this.sim.ping6(this.device.id, shown6, { count: count });
      return this._pingReplyLines(out, count, res6.replies || []);
    }
    if (namedTarget) {
      // Resolve first, and print the lookup in the order and shape a box prints it: the query line comes
      // BEFORE "Type escape sequence to abort.", and the address in parentheses is the server the query was
      // sent to - the configured name server, or 255.255.255.255 when none is configured, because that is the
      // broadcast address an unconfigured box sends the lookup to (Cisco 46253, "Prevent Domain Translation
      // Messages after an Invalid Command Is Entered on a Router").
      const probe = this.sim.resolveName ? this.sim.resolveName(this.device, target) : null;
      const asked = this._domainServersFor(probe);
      const queryLine = this._translationLine(target, asked);
      if (probe && probe.ok) {
        out.push(queryLine + ' [OK]');
        // No "name -> address" line: a box does not print one, and the address is on the next line anyway
        // ("Sending 5, 100-byte ICMP Echos to <address>").
        shownTarget = probe.address;
      } else if (probe) {
        // The query line is printed even when nothing came back - that is the half of the output that says
        // *what was asked and where* - but the trailing [OK] only appears when a name resolved.
        out.push(queryLine);
        Array.prototype.push.apply(out, this._resolveFailureLines(target, probe, asked));
        return out;
      }
    }
    out.push('Type escape sequence to abort.');
    out.push('Sending ' + count + ', 100-byte ICMP Echos to ' + shownTarget + ', timeout is 2 seconds:' +
      (atMs !== null ? '  (at t=' + atMs + ' ms)' : ''));
    const res = this.sim.ping(this.device.id, namedTarget ? target : ip, { count: count });
    this._pingReplyLines(out, count, res.replies);
    // "Still converging" is a statement about the path, so it is printed once, with the instant the answer was
    // given at - which is the answer's own, not the one the operator typed (#1383).
    const converging = require('./simulator').pingConvergenceSentence(res.replies);
    if (converging) {
      out.push('% ' + converging + (res.runAtMs === null ? '' : ' at t=' + res.runAtMs + ' ms'));
    }
    // And why an echo never came back, in the engine's words rather than "Request timed out" alone. The reason has
    // been recorded for every lost echo since the exchange was written; the console printed the timeout and threw
    // the reason away, which is the worst possible answer to "what went wrong" (#1485).
    const lost = require('./simulator').pingLossSentence(res.replies);
    if (lost) out.push('% ' + lost);
    return out;
    } finally {
      // Whatever the ping did or failed to do, the session is left at the instant it arrived with.
      this.sim.runAtMs = priorRunAtMs;
    }
  }

  // The addresses a `ping <name>` query names on its `Translating "x"...domain server (a) (b)` line. One answer
  // names the server that gave it; a lookup that came back with nothing names the servers it was sent to, in the
  // order the box would query them; a device with no `ip name-server` at all has one address to name, the
  // broadcast address its resolver sends to. Never a device label and never "none": a console that prints a
  // name where a box prints an address is inventing a format (#1375), and `(none)` named nothing at all.
  _domainServersFor(probe) {
    const dev = this.device || {};
    const configured = (dev.config && Array.isArray(dev.config.dnsServers)) ? dev.config.dnsServers : [];
    // No `ip name-server` at all: whatever answered did so because the query went to the broadcast address,
    // so that is the address the line names - not the address of whoever chose to reply to it.
    if (!configured.length) return ['255.255.255.255'];
    if (probe && probe.ok && probe.serverIp && configured.indexOf(probe.serverIp) !== -1) return [probe.serverIp];
    return configured.slice();
  }

  // The lookup line a box prints before it sends anything: `Translating "x"...domain server (a) (b)`.
  // The addresses are the servers the query went to, in the order it asked them (#1375). `[OK]` is not part of
  // the line - it reports that an answer came back - so the caller appends it only where one did.
  _translationLine(target, asked) {
    return 'Translating "' + target + '"...domain server ' +
      asked.map(function (a) { return '(' + a + ')'; }).join(' ');
  }

  // Why a lookup produced nothing, in the resolver's own verdict rather than as zero percent packet loss: the
  // three failures have different causes and different fixes. Shared by `ping` and `traceroute`, because they
  // ask the same resolver the same question and two renderings of one answer would eventually disagree.
  _resolveFailureLines(target, probe, asked) {
    const status = String(probe.status || 'unknown').toUpperCase();
    const why = {
      NXDOMAIN: 'no zone any server here hosts contains that name',
      NODATA: 'the name exists on ' + ((probe && probe.serverIp) || asked[0]) + ' but has no A record',
      SERVFAIL: 'no device in this lab hosts a DNS zone, or no listed server answered'
    }[status] || 'the resolver did not answer';
    // The advice has to match the address on the line above: telling an operator carrying no name server to
    // "check the zone on 255.255.255.255" points at a host that cannot be one.
    return ['% Could not resolve "' + target + '": ' + status + ' - ' + why,
      '% Nothing was sent. ' + (status === 'NODATA'
        ? 'Add an A record: dns add ' + target + ' A <address>'
        : (asked[0] === '255.255.255.255'
          ? 'No name server is configured, so the lookup went to the broadcast address - add a zone on a device ' +
            'in this lab, or configure `ip name-server <address>`.'
          : 'Check the zone on ' + asked.join(' ') + ', or the name servers this device asks.'))];
  }

  // What this port holds in the other address family: the address (typed or learned, marked), and the link-local
  // that neighbour discovery actually uses. Null when the port has no IPv6 at all, so an IPv4 lab prints exactly
  // what it printed before.
  _ipv6AddressLine(i) {
    const dev = this.device;
    const entry = dev.config && dev.config.ip6 ? dev.config.ip6[i.name] : null;
    const asked = !!(entry && entry.addr) || !!i.autoconfig;
    if (!asked) return null;
    const parts = [];
    if (entry && entry.addr) {
      // Marked, because a learned address and a typed one look identical in this block otherwise - and the
      // difference is the difference between "follow the router" and "stay put". Which router said so is
      // `show ipv6 nd`'s answer, not this line's.
      parts.push(entry.addr + '/' + entry.prefix + (entry.autoconfig ? ' (autoconfig)' : ''));
    } else if (i.autoconfig) {
      // The failure mode of SLAAC, said where the address would be rather than left as `unassigned`.
      parts.push('autoconfig, no address yet (waiting for a router advertisement)');
    }
    let linkLocal = null;
    try {
      linkLocal = require('./ipv6').linkLocalFromMac(i.mac);
    } catch (e) {
      linkLocal = null;
    }
    if (linkLocal) parts.push('link-local ' + linkLocal);
    return 'ipv6: ' + parts.join(', ');
  }

  // The report a ping prints, whichever address family answered: one marks line and the success rate, which is the
  // whole of what a box prints. Shared so `ping 10.0.0.1` and `ping 2001:db8:1::1` cannot drift into two
  // different-looking answers.
  //
  // There is deliberately no per-echo sentence after the rate. This console used to append one - `Reply from
  // <address>: bytes=100 time=<rtt> ms` for every answered echo, `Request timed out (seq N)` for every lost one -
  // and neither is IOS output. A box reports each echo as one character of the marks line (Cisco's field table:
  // `!` "Each exclamation point indicates receipt of a reply", `.` the timeout) and closes the run with the success
  // rate; the `Reply from ...: bytes=100 time<1ms TTL=126` shape is *Windows* ping (`ping -l 100`), which Cisco's
  // own troubleshooting deck prints from a `C:\>` prompt beside IOS captures. The per-echo lines therefore had this
  // console speaking one operating system's dialect on another operating system's prompt. The round trip a run
  // reports rides on the success-rate line in the vendor's clause instead (research/ping-report-shape.md).
  _pingReplyLines(out, count, replies) {
    // One character per echo, and the character says *what came back*, not merely whether an echo reply did:
    // `!` for a reply, `U` for an ICMP destination-unreachable, `.` for nothing at all (Cisco doc 12778,
    // "Possible Output Characters From the Ping Facility" - `U` "A destination unreachable error PDU was
    // received", `.` "the network server timed out as it waits for a reply"). The engine has recorded the error
    // per seq since the forwarding path learned to answer one; this line printed `.` for it, so a router saying
    // "no route" and a cable in the dark spelled the same character. A `U` is also not per code: the vendor's
    // own worked example prints `U.U.U` for a code-1 (host unreachable) answer, which is the opposite of
    // `traceroute`'s `!H`/`!N` letters (research/ping-unreachable-letter.md).
    out.push(replies.map(function (r) {
      if (r.success) return '!';
      return r.unreachable ? 'U' : '.';
    }).join(''));
    const ok = replies.filter(function (r) { return r.success; }).length;
    // The success-rate line is the vendor's, clause and all: one sentence that says how many echoes came back
    // and - when any did - how long they took. A ping that lost everything keeps the short form.
    out.push('Success rate is ' + Math.round((ok / count) * 100) + ' percent (' + ok + '/' + count + ')' +
      roundTripClause(replies));
    return out;
  }

  // ---------- converge ----------
  //
  // The answer to "when is it up?" - every process, every device, in the order they finish.
  _converge(tokens) {
    if (!this.sim) return ['% Simulator not attached'];
    // `help` has advertised `converge [at <ms>]` since the command existed, and this method read
    // `Number(tokens[0])` and nothing else - so the advertised form was not refused, it was answered as if no
    // instant had been named. `Number('at')` is `NaN`, `NaN` failed the `e.readyAtMs > atMs` comparison, and
    // every row lost its `(pending)` mark: type the spelling the console printed and it told you the lab was
    // converged when it was not. `link <up|down> <id> at <ms>` has parsed `at` since #1049, so this is the same
    // grammar and the same message for the same mistake; a word that is neither an instant nor `at` is refused
    // by name instead of being dropped, which is how the wrong form survived unnoticed.
    const args = tokens.map(String).filter(function (t) { return t !== ''; });
    let atMs = null;
    if (args.length && args[0].toLowerCase() === 'at') {
      args.shift();
      if (!args.length) return ['% Invalid instant: "at" needs a time in milliseconds'];
    }
    if (args.length) {
      const when = args[0];
      const t = Number(when);
      if (!Number.isFinite(t) || t < 0) return ['% Invalid instant: ' + when];
      atMs = t;
      args.shift();
    }
    if (args.length) return ['% Unrecognized "' + args[0] + '" (converge [<ms> | at <ms>])'];
    const sched = this.sim.getConvergence();
    const out = [];
    if (!sched.entries.length) {
      out.push('% Nothing in this lab runs a control plane that converges over time');
      return out;
    }
    // Column widths come from the data, for the reason `show lldp neighbors` does (#1265): the three fixed widths
    // here were 10/23/10, and `pad` right-pads without truncating, so any name longer than 22 characters ran into
    // the instant - `ospf      ISR 4331 branch router-r116000 ms` reads as 'r116000 ms' on a device called
    // 'router-r1'. That is the *default* catalogue name (label, a dash, four characters of the id) for 1475 of the
    // 2329 specs in devices/, so an untouched lab printed a table that could not be read field by field. The header
    // and the rows are built from the same widths so they cannot drift apart.
    const cells = sched.entries.map(function (e) {
      return {
        process: String(e.process),
        device: String(e.device.name || e.deviceId),
        ready: e.readyAtMs + ' ms',
        basis: String(e.basis || ''),
        pending: atMs !== null && Number.isFinite(atMs) && e.readyAtMs > atMs
      };
    });
    // The floors are the widths this table has always had, so a lab of short names prints exactly what it printed
    // before; a longer name widens its column instead of running into the next one.
    const width = function (key, floor, gap) {
      return Math.max(floor, cells.reduce(function (max, c) { return Math.max(max, c[key].length); }, 0) + gap);
    };
    const wProcess = width('process', 10, 3);
    const wDevice = width('device', 23, 3);
    const wReady = width('ready', 10, 2);
    out.push(pad('Process', wProcess) + pad('Device', wDevice) + pad('Ready', wReady) + 'Basis');
    for (const c of cells) {
      const mark = c.pending ? '  (pending)' : '';
      out.push((pad(c.process, wProcess) + pad(c.device, wDevice) + pad(c.ready, wReady) + c.basis + mark)
        .replace(/\s+$/, ''));
    }
    out.push('');
    out.push('Fully converged at ' + sched.convergedAtMs + ' ms.' +
      (sched.fromMs ? ' (re-based at the link change at ' + sched.fromMs + ' ms)' : ''));
    return out;
  }

  // ---------- cables ----------
  /**
   * link <up|down|state> <linkId> [at <ms>]
   *
   * The one operation a lab reaches for most often, and the one the engine had no word for: take a
   * cable down without unplugging it. `at <ms>` is when, in milliseconds since power-on, so a script
   * can say "the uplink fails at 10 s" and then ask what happens at 11 s.
   */
  _link(args) {
    if (!this.sim) return ['% Simulator not attached'];
    const out = [];
    const what = (args[0] || '').toLowerCase();
    const id = args[1];
    if (!what || what === '?') {
      return ['  link <up|down|state> <linkId> [at <ms>]',
              '  links                            - list every cable and its state'];
    }
    if (what === 'state' || what === 'show') {
      const l = this.topo.links.get(id);
      if (!l) return ['% No such link: ' + (id || '(none)')];
      out.push('Link ' + l.id + '  ' + this._endpointName(l.a) + ' <-> ' + this._endpointName(l.b));
      // "since 1200 ms" is an instant wearing a duration's clothes: it reads as "1200 ms ago", and at run time 5000
      // it is 3800 ms ago. Say both, and say plainly when the instant belongs to a run that is not this one.
      const now = (this.sim && Number.isFinite(this.sim.runAtMs)) ? this.sim.runAtMs : null;
      let when = '';
      // `l.stateSinceMs` was tested for truth, so a cable pulled at t=0 - the first change in a run - printed no
      // instant at all, while every later one did (#1385).
      if (l.stateSinceMs !== null && l.stateSinceMs !== undefined) {
        if (now === null) when = ', changed at ' + l.stateSinceMs + ' ms';
        else if (l.stateSinceMs > now) when = ', changed at ' + l.stateSinceMs + ' ms (not this run)';
        else when = ', changed at ' + l.stateSinceMs + ' ms (' + (now - l.stateSinceMs) + ' ms ago)';
      }
      out.push('  state: ' + l.state + when);
      return out;
    }
    if (what !== 'up' && what !== 'down') {
      return ['% Invalid input: link ' + args.join(' ') + ' - expected up, down or state'];
    }
    if (!id) return ['% Incomplete command: link ' + what + ' <linkId>'];

    // No `at` means "now", and "now" is wherever the session is standing - not t=0 (#1385).
    let atMs = null;
    const at = args.indexOf('at');
    if (at !== -1) {
      atMs = Number(args[at + 1]);
      if (!Number.isFinite(atMs) || atMs < 0) return ['% Invalid time: ' + (args[at + 1] || '(none)')];
    }

    const res = this.sim.setLinkState(id, what, atMs === null ? {} : { atMs: atMs });
    if (!res.ok) return ['% ' + (res.code || 'refused') + (res.detail ? ': ' + res.detail : '')];
    if (!res.changed) {
      out.push('Link ' + id + ' is already ' + what + '.');
      return out;
    }

    const link = this.topo.links.get(id);
    out.push('Link ' + id + ' (' + this._endpointName(link.a) + ' <-> ' +
      this._endpointName(link.b) + ') is now ' + what + '.');
    // The number a lab actually cares about: when the network has finished reacting.
    out.push('Network converges again at ' + res.reconvergeAtMs + ' ms.');
    return out;
  }

  _links() {
    const out = ['Link   Endpoints                                                  State'];
    for (const l of this.topo.links.values()) {
      out.push(pad(l.id, 7) + pad(this._endpointName(l.a) + ' <-> ' + this._endpointName(l.b), 59) +
        l.state);
    }
    return out;
  }

  _endpointName(end) {
    const dev = this.topo.getDevice(end.deviceId);
    return (dev ? dev.name : end.deviceId) + ':' + end.iface;
  }

  // `traceroute <address>` and `traceroute <name>` - the same command, because a box resolves the name before it
  // sends the first probe (#1484's index row promised `<address|name>` while the parser took an address only,
  // through `net.isIp()`, so `traceroute www.lab` was refused as an invalid target).
  //
  // The shape is the vendor's, and it is three lines longer than the address form, in this order:
  //
  //   Router#traceroute google.com
  //   Translating "google.com"...domain server (8.8.8.8) [OK]
  //   Type escape sequence to abort.
  //   Tracing the route to google.com (173.194.38.167)
  //   1 59.90.253.1 16 msec 16 msec 12 msec
  //
  // The lookup line comes before the abort line, exactly as `ping`'s does, and the target line carries **both**
  // names the box now holds - the name it was given and the address it resolved to, in that order
  // (`research/traceroute-name-target.md`). The hop lines name addresses only: this lab holds no PTR records, so
  // there is no second name for a hop to print.
  //
  // A name that does not resolve sends nothing, and says why in the resolver's verdict rather than in a trace of
  // zero hops - the same two sentences `ping` prints, from the same helper.
  _traceroute(tokens) {
    const out = [];
    const typed = String(tokens[0] === undefined || tokens[0] === null ? '' : tokens[0]);
    if (!typed) return ['% Invalid traceroute target: (none)'];
    const literal = isIpv4Literal(typed);
    // Digits and dots that are not an address are a typo, not a hostname - the rule `ping` already applies.
    if (!literal && /^[0-9.]+$/.test(typed)) {
      return ['% Invalid traceroute target: ' + typed +
        ' (not an IPv4 address, and not a name that could resolve)'];
    }
    // An IPv6 literal is an address, and this walk is IPv4 only - `ping` has an IPv6 path (#1461) and
    // `traceroute` does not, so handing `2001:db8::1` to the resolver would answer a DNS question about a name
    // that is an address, and read as SERVFAIL rather than as the limit it is.
    if (!literal && typed.indexOf(':') !== -1) {
      return ['% Invalid traceroute target: ' + typed + ' (this console traces IPv4 paths only)'];
    }
    if (!this.sim) return ['% Simulator not attached'];
    let target = typed;
    let shown = typed;
    if (!literal) {
      const probe = this.sim.resolveName ? this.sim.resolveName(this.device, typed) : null;
      if (!probe) return ['% Invalid traceroute target: ' + typed];
      const asked = this._domainServersFor(probe);
      if (!probe.ok) {
        out.push(this._translationLine(typed, asked));
        Array.prototype.push.apply(out, this._resolveFailureLines(typed, probe, asked));
        return out;
      }
      out.push(this._translationLine(typed, asked) + ' [OK]');
      target = probe.address;
      shown = typed + ' (' + probe.address + ')';
    }
    out.push('Type escape sequence to abort.');
    out.push('Tracing the route to ' + shown);
    const res = this.sim.traceroute(this.device.id, target);
    for (const hop of res.hops) {
      // A hop that answered prints its address and then one result per probe, in `msec` - the vendor's own
      // shape (`1 172.16.12.2 4 msec 4 msec 4 msec`). A destination-unreachable is one of those results and not
      // a sentence: the letter for the ICMP code stands in the probe's column, one per probe, with no words
      // beside it - a box prints `4 172.30.36.131 !N !N !N` for three refused probes and `2 10.10.20.2 !H *
      // !H` when one of the three timed out (`research/traceroute-hop-line.md`). A hop that answered nothing has
      // no address to print, so the three stars stand in the address column, which is what a real trace prints
      // for a silent hop.
      //
      // The number goes in the fixed field: this line was `' ' + hop.ttl`, so hop 10 was one character wider than
      // hop 9 and moved everything after it.
      if (hop.address) out.push(hopNumberField(hop.ttl) + '  ' + hop.address + '  ' + probeCells(hop.probes));
      else out.push(hopNumberField(hop.ttl) + '  ' + probeCells(hop.probes) +
        (hop.dropped ? '  (' + hop.dropped + ')' : ''));
    }
    if (!res.success) out.push('% destination not reached after ' + res.hops.length + ' hops');
    return out;
  }

  // ---------- show ----------
  // show ip bgp [summary]
  //
  // The interesting column is `State/PfxRcd`, and the interesting news is that it can be
  // something other than a prefix count: a box prints the FSM word there while the session is
  // not established. Before the session walk existed, every configured neighbour was
  // established by definition - which is the one thing a lab must not teach, because the whole
  // skill is reading Active or OpenSent and knowing what it means. The word "Established" is
  // itself never printed in this cell (research/show-ip-bgp-summary-state-cell.md).
  // `show ip dns [zone [<name>]]`.
  //
  // `dns zone` and `dns add` have been writable since DNS was modelled, and `Simulator.resolveName()` answers
  // queries from those zones - but nothing could show a zone back. So an operator could add a record and had no way
  // to see what the server would actually answer, which is the same defect `show ip dhcp pool` closed for pools
  // (#1375). The rows come from `dns.normalizeZone()` and the honesty comes from `dns.validateZone()`: a zone the
  // server would refuse to answer for says so, with the reason, instead of being printed as if it were live.
  _showDns(args) {
    const dev = this.device;
    const dnsLib = require('./dns');
    const out = [];
    const zones = (dev.config && Array.isArray(dev.config.dnsZones)) ? dev.config.dnsZones : [];
    const servers = (dev.config && Array.isArray(dev.config.dnsServers)) ? dev.config.dnsServers : [];
    const sub = String(args[0] === undefined ? '' : args[0]).toLowerCase();
    const want = args.slice(1).join(' ').trim();

    const fmtRecord = function (rec) {
      const ttl = String(rec.ttl === null || rec.ttl === undefined ? '-' : rec.ttl);
      const prio = (rec.priority === null || rec.priority === undefined) ? '' : ' (priority ' + rec.priority + ')';
      return '  ' + pad(rec.name || '@', 34) + pad(ttl, 8) + pad('IN ' + rec.type, 10) + (rec.value || '-') + prio;
    };

    if (sub === '' || sub === 'zone' || sub === 'zones') {
      if (sub === 'zone' && want) {
        const key = dnsLib.normalizeName(want);
        const raw = zones.filter(function (z) { return dnsLib.normalizeName(z.name) === key; })[0];
        if (!raw) {
          out.push('% No DNS zone ' + want + ' on this device' +
            (zones.length ? ' (zones here: ' + zones.map(function (z) { return z.name; }).join(', ') + ')' : ''));
          return out;
        }
        const z = dnsLib.normalizeZone(raw);
        const check = dnsLib.validateZone(raw);
        out.push('Zone ' + z.name + ' (default TTL ' + z.defaultTtl + ')' +
          (check.ok ? '' : ' - NOT answered: ' + check.errors[0].message));
        if (!z.records.length) out.push('  (no records: every query is NXDOMAIN)');
        for (const rec of z.records) out.push(fmtRecord(rec));
        return out;
      }

      if (!zones.length) {
        out.push('% This device is not a DNS server (no "dns zone" configured)');
      } else {
        for (const raw of zones) {
          const z = dnsLib.normalizeZone(raw);
          const check = dnsLib.validateZone(raw);
          out.push('Zone ' + z.name + ' (default TTL ' + z.defaultTtl + ') - ' + z.records.length + ' record(s)' +
            (check.ok ? '' : ' - NOT answered: ' + check.errors[0].message));
          for (const rec of z.records) out.push(fmtRecord(rec));
        }
      }
      if (servers.length) {
        out.push('');
        out.push('Name servers this device asks: ' + servers.join(', '));
      } else if (zones.length) {
        out.push('');
        out.push('Name servers this device asks: none configured - a lookup falls back to any server in the lab');
      } else {
        out.push('');
        out.push('% No name servers configured (use "ip name-server <address>" in config mode)');
      }
      return out;
    }

    out.push('% Usage: show ip dns [zone [<name>]]');
    return out;
  }

  // `show ip dhcp binding` and `show ip dhcp pool`.
  //
  // DHCP has been modelled end to end since it was: pools, ranges, exclusions, reservations, lease times, renewals
  // and expiry. The server keeps an allocation table (mac -> address, expiry) and **nothing could read it**: there
  // was no `show ip dhcp` at all, so an operator could configure a pool and could not find out which addresses had
  // been handed out, to whom, or when they come back (#1373). The bindings come from the engine's own table
  // through `Simulator.dhcpBindings()`, and the pool view is the pool the server actually answers from
  // (`normalizePool()` + `validatePool()`), not a re-reading of the config text.
  // The DHCP exchanges that never became a lease, read from the run's own event log (#1453).
  //
  // The engine has recorded every failed exchange since the exchange was written - `phase: 'failed'` with a reason
  // (`no-server`, `no-pool`, `pool-exhausted`, `nak`) and a sentence saying what went wrong - and nothing could read
  // it. So an operator whose host had no address had three views that all said nothing: `show ip dhcp binding` listed
  // only the successes, `show ip dhcp pool` counted only the successes, and the host's own `show interfaces` said
  // `ip: unassigned`. A silent no is the worst answer, and the reason was sitting in the log the whole time.
  _dhcpFailures() {
    const dev = this.device;
    const out = { asServer: [], asClient: [] };
    const events = (this.sim && Array.isArray(this.sim.events)) ? this.sim.events : [];
    for (const e of events) {
      if (!e || e.type !== 'dhcp' || e.phase !== 'failed') continue;
      if (e.server && e.server === dev.id) out.asServer.push(e);
      if (e.client && e.client === dev.id) out.asClient.push(e);
    }
    return out;
  }

  // One sentence for one failed exchange. Read on the server it is the engine's own words (the server is the box the
  // reader is at, and every detail sentence is already about its pools); read on the client it names the server that
  // stayed silent, because that is the fact the client's console cannot otherwise show.
  _dhcpFailureText(ev, asServer) {
    const detail = ev.detail || 'no offer came back';
    if (asServer) return detail;
    return detail + (ev.server ? ' (from ' + (ev.serverName || ev.server) + ')' : '');
  }

  _showDhcp(args) {
    const dev = this.device;
    const out = [];
    const dhcpLib = require('./dhcp');
    const pools = (dev.config && Array.isArray(dev.config.dhcpPools)) ? dev.config.dhcpPools : [];
    const sub = String(args[0] === undefined ? '' : args[0]).toLowerCase();
    const want = args.slice(1).join(' ').trim();

    const normalized = pools.map(function (raw) { return dhcpLib.normalizePool(raw); });
    const poolByName = function (name) {
      for (const p of normalized) { if (p.name === name) return p; }
      return null;
    };
    const human = function (sec) {
      if (sec === null || sec === undefined) return '-';
      const s = Math.max(0, Math.floor(sec));
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
      return s + 's' + (h ? ' (' + h + ':' + String(m).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0') + ')' : '');
    };
    if (sub === '' || sub === 'binding' || sub === 'bindings' || sub === 'lease' || sub === 'leases') {
      if (!pools.length) {
        out.push('% This device is not a DHCP server (no "ip dhcp pool" configured)');
        return out;
      }
      if (!this.sim) {
        out.push('% no binding state has been evaluated yet - run a simulation');
        return out;
      }
      let rows = this.sim.dhcpBindings ? this.sim.dhcpBindings(dev.id) : [];
      if (want) {
        // A MAC in any of the three spellings, so the dotted address a neighbouring view prints finds its
        // lease instead of being read as an address lookup - which answered "no lease holds that address"
        // about a token that is not an address at all.
        const wantedMac = macSpelling(want);
        const matched = rows.filter(function (r) {
          return wantedMac ? macSpelling(r.mac) === wantedMac : r.ip === want;
        });
        if (!matched.length) {
          out.push('% No binding for ' + want +
            (wantedMac ? ' (no lease is held by that MAC)' : ' (no lease holds that address)'));
          return out;
        }
        rows = matched;
      }
      const failed = this._dhcpFailures().asServer;
      // The title is the box's own line, and it is printed whether or not a row follows it. Every IOS capture
      // of this view opens with it, and the On-Demand Address Pool guide prints it above an empty table -
      // "There are no bindings shown under the Bindings from all pools not associated with VRF field because the
      // Global pool has not allocated any addresses" - so the heading is not contingent on a row. The sentence
      // is literally true here: this model has no VRF, so every pool it holds is a pool not associated with one.
      // Evidence, and the two shapes of the header line that follow it, in research/show-ip-dhcp-binding-title.md.
      out.push('Bindings from all pools not associated with VRF:');
      out.push(pad('IP address', 16) + pad('Client identifier / MAC', 30) + pad('Pool', 18) + 'Expires in');
      if (!rows.length) {
        // "nothing has asked" is only true when nothing asked. A request that was answered with silence is a
        // different fact, and it is the one an operator needs (#1453).
        out.push(failed.length
          ? '% no leases: ' + failed.length + ' request(s) were refused, none granted'
          : '% no leases: nothing has asked this server for an address yet');
        if (failed.length) {
          const last = failed[failed.length - 1];
          out.push('  ' + this._dhcpFailureText(last, true) + ' (' + (last.mac || 'unknown client') +
            (Number.isFinite(last.step) ? ', step ' + last.step : '') + ')');
        }
        return out;
      }
      // A lease's state is a fact about time, and the engine only states it when it is asked at an instant. Without
      // one, `leaseTable` returns rows with no `state` at all - and this summary used to call every one of them
      // "active", a claim about time the engine had explicitly declined to make (#1465).
      const clocked = rows.every(function (r) { return r.state !== undefined; });
      let lapsed = 0;
      for (const r of rows) {
        const pool = r.pool ? poolByName(r.pool) : null;
        const reserved = !!(pool && pool.reservations && pool.reservations[r.mac] === r.ip);
        const isExpired = r.state === 'expired';
        if (isExpired) lapsed++;
        out.push(pad(r.ip, 16) + pad(r.mac + (reserved ? ' (reserved)' : ''), 30) +
          pad(r.pool || '-', 18) +
          (isExpired ? 'lapsed (address free)'
            : (r.state === undefined ? 'no clock'
              : (r.remainingSec === Infinity ? 'Infinite' : human(r.remainingSec)))));
      }
      out.push('');
      if (clocked) {
        const active = rows.length - lapsed;
        out.push(active + ' active binding(s)' + (lapsed ? ', ' + lapsed + ' lapsed' : '') +
          '; the lease clock runs from the instant the lease was granted');
      } else {
        out.push(rows.length + ' binding(s); no clock is set, so none is lapsed or active yet - ' +
          'the expiry is counted from the instant each lease was granted');
      }
      if (failed.length) {
        const last = failed[failed.length - 1];
        out.push(failed.length + ' request(s) refused: ' + this._dhcpFailureText(last, true) +
          ' (' + (last.mac || 'unknown client') + (Number.isFinite(last.step) ? ', step ' + last.step : '') + ')');
      }
      return out;
    }

    if (sub === 'pool' || sub === 'pools') {
      if (!pools.length) {
        out.push('% No DHCP pools configured (use "ip dhcp pool <name>" in config mode)');
        return out;
      }
      const bindings = (this.sim && this.sim.dhcpBindings) ? this.sim.dhcpBindings(dev.id) : null;
      const chosen = want ? [poolByName(want)].filter(Boolean) : normalized;
      if (!chosen.length) {
        out.push('% No DHCP pool named ' + want + ' (pools on this device: ' +
          normalized.map(function (p) { return p.name; }).join(', ') + ')');
        return out;
      }
      for (const p of chosen) {
        const check = dhcpLib.validatePool(p);
        // Counted by membership, not by the recorded name: a lease row's pool is the pool it was granted from,
        // and a row without one still has an address that is inside this pool (#1429).
        const mine = bindings === null ? null : bindings.filter(function (r) {
          if (r.state === 'expired') return false;
          return r.pool === p.name || dhcpLib.ipInPool(p, r.ip);
        });
        const summary = dhcpLib.poolSummary(p, mine === null ? null : mine.map(function (r) { return r.ip; }));
        // The block a real box prints, in its own order and with its own labels, the colons in one column
        // (research/show-ip-dhcp-pool-layout.md). The console adds no field of its own here: what a pool is
        // *configured* with is `show running-config`'s answer (`network`, `range`, `default-router`,
        // `dns-server`, `lease`, `host`), and this view is IOS's answer to "how much of the subnet is left".
        const field = function (label, value) { return ' ' + pad(label, 31) + ': ' + value; };
        out.push('Pool ' + p.name + ' :');
        // `utilization mark` and `subnet size` drive on-demand address pools, which this console does not
        // model - so every pool prints the pair every published non-ODAP capture prints.
        out.push(field('Utilization mark (high/low)', '100 / 0'));
        out.push(field('Subnet size (first/next)', '0 / 0'));
        out.push(field('Total addresses', summary.total === null
          ? 'unknown (the pool has no usable subnet)' : summary.total));
        // `Leased addresses` is a measurement, and the engine only makes it when it is asked at an instant
        // (#1465): with no simulation there is no instant, so the line says that rather than printing a zero
        // that would read as "nobody has asked".
        out.push(field('Leased addresses', mine === null
          ? 'not measured (no simulation has run)' : mine.length));
        // Printed only when there is one, which is what the captures show: a /24 pool with nothing excluded
        // has no `Excluded addresses` line, one with 62 excluded does.
        if (summary.excluded) out.push(field('Excluded addresses', summary.excluded));
        out.push(field('Pending event', 'none'));
        out.push(' 1 subnet is currently in the pool :');
        if (check.ok && summary.range) {
          out.push(' ' + pad('Current index', 21) + pad('IP address range', 37) + 'Leased/Excluded/Total');
          // `Current index` reads 0.0.0.0 when the pool has nothing left to offer - the address that would be
          // allocated next, which a full pool does not have.
          const index = (summary.capacity === null) ? 'not measured'
            : (summary.index === null ? '0.0.0.0' : summary.index);
          out.push(' ' + pad(index, 21) +
            pad(summary.range.start + ' - ' + summary.range.end, 37) +
            (mine === null ? 'not measured' : mine.length) + ' / ' + summary.excluded + ' / ' + summary.total);
        }
        if (!check.ok) {
          // A pool that is not serving yet says why. It used to print `undefined`, because the verdict carries an
          // `errors` array and this read `check.error` (#1429).
          const why = (check.errors && check.errors[0] && check.errors[0].message) || check.error ||
            'this pool is not serving yet';
          out.push('% this pool is not serving yet: ' + why);
        }
        // Requests this pool turned away, with the sentence the engine recorded for the last one (#1453): a pool
        // that has handed out every address it has and a pool nobody has asked both show a `Leased addresses`
        // count, and only one of them has clients standing in the dark.
        const refusedHere = (this._dhcpFailures().asServer || []).filter(function (e) {
          return e.pool === p.name;
        });
        if (refusedHere.length) {
          out.push('% ' + refusedHere.length + ' request(s) refused: ' +
            (refusedHere[refusedHere.length - 1].detail || 'no address left to offer'));
        }
        out.push('');
      }
      return out;
    }

    out.push('% Usage: show ip dhcp [binding [<address|mac>] | pool [<name>]]');
    return out;
  }

  // The `Dead Time` cell of `show ip ospf neighbor`: how long is left before this box declares the neighbour
  // dead. It is the Router Dead Interval counting down, reset by every Hello the port receives - "the amount
  // of time that remains as the router waits to receive an OSPF hello packet from the neighbor before it
  // declares the neighbor is down" (Cisco 13688-16), and RFC 2328 A.3.2 carries the interval in the Hello.
  // The interval itself is not a second table: `convergence.ospfTimers()` is what the engine's convergence
  // schedule already runs OSPF on, so a lab with `helloSec`/`deadSec` set sees the countdown those numbers
  // produce. Hellos start at t=0 (the convergence model says so) and repeat every helloSec, so the last one
  // arrived at the last multiple of helloSec at or before the instant being asked about. A question asked at
  // `Infinity` - the converged answer - has no instant to count from and prints the interval itself, which is
  // the cell in the instant after a Hello.
  _ospfDeadTimeCell(dev) {
    const timers = require('./convergence').ospfTimers(dev);
    const nowMs = (this.sim && Number.isFinite(this.sim.runAtMs)) ? this.sim.runAtMs : null;
    const periodMs = Math.max(1, timers.helloSec * 1000);
    const sinceHello = nowMs === null ? 0 : (nowMs % periodMs) / 1000;
    const left = Math.max(0, Math.round(timers.deadSec - sinceHello));
    const hh = Math.floor(left / 3600);
    const mm = Math.floor((left % 3600) / 60);
    const ss = left % 60;
    return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
  }

  // `show ip ospf`, `show ip ospf neighbour`, `show ip ospf interface`.
  //
  // OSPF has been configurable since it was modelled - router-id, area, `ip ospf cost|area|passive` - and the
  // engine computes adjacencies and an SPF tree from those numbers. None of it could be read back: the only
  // console answer that mentioned OSPF was `show ip route` saying `O`. So an operator could set a cost and had
  // no way to see whether the engine used it, or which port an adjacency formed on (#1371).
  //
  // Every row here comes from what `computeOspf()` recorded (`dev.ospfInterfaces`, `dev.ospfNeighbors`), so the
  // console and the route table cannot disagree about the same topology.
  _showOspf(args) {
    const dev = this.device;
    const out = [];
    const cfg = dev.config && dev.config.ospf;
    if (!cfg || !cfg.routerId) {
      out.push('% OSPF is not enabled (use "ospf router-id <ip>" in config mode)');
      return out;
    }
    const sub = String(args[0] === undefined ? '' : args[0]).toLowerCase();
    const rest = args.slice(1).filter(function (t) { return String(t).toLowerCase() !== 'detail'; });
    const ifaces = dev.ospfInterfaces || [];
    const neighbours = dev.ospfNeighbors || [];
    const evaluated = ifaces.length > 0 || neighbours.length > 0;

    // `unknown` separates "a port that exists but carries no OSPF" from "no such port". Without it the neighbour
    // report described a port that does not exist as one that is "not carrying OSPF", which is a claim about a
    // socket the box does not have (#1403).
    const portWanted = function () {
      if (!rest.length) return { name: null, unknown: false };
      const name = resolvePortName(dev, rest.join(' '));
      return name ? { name: name, unknown: false } : { name: rest.join(' '), unknown: true };
    };

    // Why a link both ends address produced no adjacency. The engine records the field that disagreed
    // (`dev.ospfRejected`, filled by `computeOspf()`); without it the only thing this table could say about
    // such a port was "nothing on the other end runs OSPF", which is false - the far end is running it,
    // with a different Hello/Dead pair or in another area.
    const refusalWhy = function (r) {
      if (!r) return '';
      if (r.reason === 'timers') {
        return r.peer + ' runs OSPF with Hello ' + r.peerHellSec + ' s / Dead ' + r.peerDeadSec +
          ' s and this box with Hello ' + r.helloSec + ' s / Dead ' + r.deadSec +
          ' s: a Hello whose intervals differ from the received port is dropped (RFC 2328 10.5),' +
          ' so no adjacency forms until they match';
      }
      if (r.reason === 'area') {
        return r.peer + ' runs OSPF in area ' + r.peerArea + ' and this box in area ' + r.area +
          ': a Hello from another area is not accepted, so no adjacency forms';
      }
      if (r.reason === 'priority') {
        return 'both ends are at OSPF priority 0 (' + r.peer + ' and this box), so neither may become' +
          ' DR or BDR: no DR is elected and a pair of DROTHERs stops at 2WAY, never FULL' +
          ' (RFC 2328 9.4), so no adjacency forms and no route crosses this link';
      }
      return 'the link was refused';
    };
    const refusalOn = function (name) {
      return (dev.ospfRejected || []).filter(function (r) { return r.iface === name; })[0] || null;
    };

    if (sub === '' || sub === 'process') {
      // `ospf <areaId>` here put the *area* where a process id belongs: a real box prints the process it was
      // given in `router ospf <process-id>`. This console has no process id, so the line names the router id
      // only rather than reading `Routing Process "ospf 0.0.0.1"` to anyone who configured a dotted area.
      out.push('Routing Process with ID ' + cfg.routerId);
      // Sorted by the 32-bit value, not by the text: `0.0.0.1` and `1` are the same area and
      // `'0.0.0.1' - 0` is NaN, which would leave the list in whatever order the ports were walked in.
      const areas = Array.from(new Set(ifaces.map(function (i) { return i.area; })))
        .sort(function (a, b) { return ospfLib.areaOf(a) - ospfLib.areaOf(b); });
      out.push('  Areas: ' + (areas.length ? areas.join(', ') : String(cfg.areaId || 0)));
      const passive = ifaces.filter(function (i) { return i.passive; }).length;
      out.push('  Interfaces: ' + ifaces.length + (passive ? ' (' + passive + ' passive)' : ''));
      out.push('  Neighbours: ' + neighbours.length);
      const refused = (dev.ospfRejected || []).length;
      if (refused) out.push('  Links refused: ' + refused + ' (see `show ip ospf neighbor <port>`)');
      const installed = (dev.ospfRoutes || []).length;
      out.push('  Routes installed from OSPF: ' + installed +
        (dev.ospfConverged ? '' : ' (withheld: still converging)'));
      if (!evaluated) out.push('  (no OSPF state has been evaluated yet - run a simulation)');
      return out;
    }

    if (sub === 'neighbor' || sub === 'neighbour' || sub === 'neighbors' || sub === 'neighbours') {
      const wanted = portWanted();
      if (wanted.unknown) {
        out.push('% No interface ' + wanted.name + ' on ' + dev.name);
        return out;
      }
      const rows = wanted.name ? neighbours.filter(function (n) { return n.iface === wanted.name; }) : neighbours;
      // The device's columns, in its order and at its own columns. Every vendor sample prints
      // `Neighbor ID  Pri  State  Dead Time  Address  Interface`, and this table had four of the six in a
      // different order: the address and the port sat where the priority and the dead timer belong, so a
      // reader who knew the command looked for a countdown that was not there and found the port under
      // `Address`. The widths come from a capture whose spacing survives: ntc-templates keeps the raw CLI
      // text for this command - Neighbor ID 16, Pri right-aligned in 3, three spaces, State 16, Dead Time
      // 12, Address 16, Interface. research/ospf-neighbor-table-layout.md has the sources and the columns
      // measured off that file.
      const deadCell = this._ospfDeadTimeCell(dev);
      out.push(pad('Neighbor ID', 16) + pad('Pri', 3) + '   ' + pad('State', 16) + pad('Dead Time', 12) +
        pad('Address', 16) + 'Interface');
      if (!rows.length) {
        if (!evaluated) {
          out.push('(no OSPF state has been evaluated yet - run a simulation)');
        } else if (wanted.name) {
          // Name the port and say why nothing is on it: a passive interface forms no adjacency, and a port
          // OSPF is not running on is not in the table at all.
          const iface = ifaces.filter(function (i) { return i.name === wanted.name; })[0];
          if (!iface) {
            out.push('% ' + wanted.name + ' is not carrying OSPF' +
              (dev.interfaces.get(wanted.name) ? ' (no address, shut down, or not an OSPF interface)' : ''));
          } else if (iface.passive) {
            out.push('% ' + wanted.name + ' is passive: it advertises its prefix and forms no adjacency');
          } else {
            const why = refusalOn(wanted.name);
            out.push(why
              ? '% no neighbour on ' + wanted.name + ': ' + refusalWhy(why)
              : '% no neighbour on ' + wanted.name + ' (nothing on the other end runs OSPF here)');
          }
        } else if ((dev.ospfRejected || []).length) {
          const rejected = dev.ospfRejected;
          out.push('% no adjacencies: ' + rejected.length + ' link(s) were offered and refused');
          for (const r of rejected) out.push('  ' + r.iface + ': ' + refusalWhy(r));
        } else {
          out.push('% no adjacencies: nothing on the other end of an OSPF interface is running OSPF');
        }
        return out;
      }
      for (const n of rows) {
        // Pri is the *neighbour's* interface priority, right-aligned in three columns, and it is the value
        // configured on the far port with `ip ospf priority` (default 1). RFC 2328 puts the field in the
        // Hello packet; Cisco 13688-16 states the default ("By default, priorities are set to 1") and that
        // the field is the neighbour's, and the same number decides the role in the State cell beside it -
        // both come from the neighbour record the engine built, so the two columns cannot disagree.
        const pri = (n.priority === null || n.priority === undefined) ? 1 : n.priority;
        // The Interface cell names the port in FULL, the way the box names it in this table - not in the
        // panel spelling the catalogue stores. The capture this table's widths were measured on says so
        // (`Port-channel1`, `Vlan1000`: ntc-templates cisco_ios_show_ip_ospf_neighbor.raw), Cisco's own
        // explanation of the command shows `Ethernet0` (13688-16), and the Cisco Press OSPFv2 chapter's
        // sample runs `GigabitEthernet0/0/1`, `GigabitEthernet0/0/2`, `GigabitEthernet0/0/3` - three rows
        // that would be `Gi0/0/x` on any other page. A row is therefore wider than 80 columns when the port
        // name is long (66 + 19 = 85 for `GigabitEthernet0/0/0`), and a real box does not wrap it either.
        // `show ip ospf interface brief` is the other spelling in the same command family and it DOES
        // abbreviate (`Gi0/0`), so this is not a general rule - it is this table's.
        // research/ospf-neighbor-table-layout.md records the four captures and the one sample that
        // disagrees (`Gig0/0`, a hand-typed blog row).
        out.push(pad(n.routerId, 16) + String(pri).padStart(3, ' ') + '   ' + pad(n.state, 16) +
          pad(deadCell, 12) + pad(n.address, 16) + require('./iface-name').displayName(n.iface));
      }
      out.push('');
      out.push(rows.length + ' neighbour(s), all Fully adjacent' +
        (dev.ospfConverged ? '' : ' (routes withheld: still converging)'));
      return out;
    }

    if (sub === 'interface' || sub === 'interfaces') {
      const wanted = portWanted();
      // `brief` is a keyword of this command, not a port name. The vendor's form is
      //   show ip [ospf] [process-id] interface [type number] [brief]
      // (Cisco IOS IP Routing: OSPF Command Reference, ospf-s1.html), and its table is seven cells:
      //   Interface    PID   Area            IP Address/Mask    Cost  State Nbrs F/C
      //   Se0/0/0      1     0               192.168.12.1/30    781   P2P   1/1
      // measured off the CCNA multiarea lab PDF, which is the one capture in hand whose spacing survives
      // extraction. This console read `brief` as a port name and answered `% No interface brief on <box>` -
      // the sentence a typo gets, about a view the box really has. Two of the seven cells cannot be filled
      // honestly: PID is the id from `router ospf <pid>`, a command this console does not have (one unnamed
      // process), and State is the port's DR/BDR role, which the engine only elects across a cable with two
      // speakers. research/show-ip-ospf-interface-brief.md records the captures, which cells are derivable
      // and what would settle the rest; the console therefore names the view and the view that does answer
      // rather than printing a table with two invented columns.
      if (wanted.unknown) {
        const typed = String(wanted.name).trim().split(/\s+/);
        if (/^b(?:ri(?:e(?:f)?)?)?$/i.test(typed[typed.length - 1])) {
          out.push('% `' + wanted.name + '` is a view, not a port: this console has no `show ip ospf interface brief`.');
          out.push('  Its header is `Interface    PID   Area            IP Address/Mask    Cost  State Nbrs F/C`,');
          out.push('  and the PID cell is the id from `router ospf <pid>`, a command this console does not have.');
          out.push('  `show ip ospf interface [<port>]` prints the area, the cost and whether the port is adjacent.');
          return out;
        }
      }
      const rows = wanted.name ? ifaces.filter(function (i) { return i.name === wanted.name; }) : ifaces;
      if (!evaluated) {
        out.push('% no OSPF state has been evaluated yet - run a simulation');
        return out;
      }
      if (!rows.length) {
        if (wanted.name) {
          const port = dev.interfaces.get(wanted.name);
          if (!port) {
            // Same sentence the rest of the console uses, and the same one this report's sibling prints (#1403).
            out.push('% No interface ' + wanted.name + ' on ' + dev.name);
          } else if (!port.enabled) {
            // A shut port the process covers is still an OSPF interface, and a box prints its block - the block
            // opens with the port's own state line, not with a refusal:
            //   R1# show ip ospf interface loopback 100
            //   Loopback100 is administratively down, line protocol is down
            //   Internet Address 100.1.1.1/24, Area 0
            //   Process ID 1, Router ID 1.1.1.1, Network Type LOOPBACK, Cost: 1
            //     (howtonetwork.org, "Troubleshooting Route Advertisement" - the loopback is in area 0 and its
            //      `show ip ospf interface brief` row reads `Lo100 ... DOWN 0/0`, so OSPF did *not* drop the port
            //      from the process when it was shut)
            //   R1# show ip ospf interface
            //   FastEthernet0/0 is administratively down, line protocol is down
            //     Internet Address 192.168.100.1/24, Area 0
            //     Process ID 1, Router ID 1.1.1.1, Network Type BROADCAST, Cost: 1
            //     ...
            //     Transmit Delay is 1 sec, State DOWN, Priority 1
            //     (tech.pjin.jp, OSPF neighbour-failure drill, IOS 12.4: interface FastEthernet0/0 holds
            //      `ip address 192.168.100.1 255.255.255.0`, `ip ospf 1 area 0` and `shutdown`)
            // Two independent boxes, one the `show ip ospf interface` table and one the per-port form, both open
            // with this line at the left margin, indenting the fields under it by two spaces.
            //
            // This console used to answer with a sentence no box prints - `% Gi0/1 is administratively down: OSPF
            // runs on no shut port with an address` - and the rule inside it is false: a shut port stays an OSPF
            // interface (it cannot form an adjacency, and it is not advertised, but it is listed). The two lines
            // below are the captured head of the block. The block continues with `Process ID`, `Network Type` and
            // `State`, and this model has no process id and no network type to print, so it stops after the two
            // lines it can state rather than inventing the rest. What is still open - the rest of the block, and
            // what a shut *unaddressed* port prints - is recorded in
            // research/show-ospf-interface-shut-port.md.
            const shownName = require('./iface-name').displayName(port.name);
            if (port.ip && port.mask) {
              const ov = (dev.config.ospf.interfaces || []).filter(function (x) { return x.name === port.name; })[0];
              const area = (ov && ov.area !== undefined) ? ov.area : (dev.config.ospf.areaId || 0);
              out.push(shownName + ' is administratively down, line protocol is down');
              out.push('  Internet Address ' + port.ip + '/' + require('./net').prefixOf(port.mask) + ', Area ' + area);
            } else {
              // A shut port with no address is not an OSPF interface at all, and the same one-line message that
              // every other disqualifier draws is the only line the vendor has for that state. Inference, not a
              // capture: the captures in hand put an *up* unaddressed Serial0 on this line (Cisco 13693-22), and
              // the message is documented as carrying no reason of its own.
              out.push('%OSPF: OSPF not enabled on ' + shownName);
            }
          } else {
            // OSPF is not on this port, and a box says only that - one tagged system message, naming the port
            // in its long type spelling, with no `is` and the tag glued to the percent sign:
            //   R4-2503# show ip ospf interface s0            -> %OSPF: OSPF not enabled on Serial0
            //     (Cisco, "Initial Configurations for OSPF over Frame Relay Subinterfaces", 13693-22 - the
            //      unaddressed physical Serial0, while s0.1 on the same box prints the full block, so the line
            //      is about this port and not a missing process)
            //   R1# show ip ospf interface fastEthernet 0/0   -> %OSPF: OSPF not enabled on FastEthernet0/0
            //   R1# show ip ospf interface loopback 0         -> %OSPF: OSPF not enabled on Loopback0
            //     (networklessons.com, OSPF adjacency and route-advertisement troubleshooting)
            //   #sh ip ospf interface vlan 16                 -> %OSPF: OSPF not enabled on Vlan16
            //     (Cisco Community td-p/3398254)
            //   #sh ip ospf interface gigabitEthernet 9/1     -> %OSPF: OSPF not enabled on GigabitEthernet9/1
            //     (Cisco Community td-p/2039094 - an L2 access port with no address)
            // The reason is not part of the line: an unaddressed port, an L2 port and a port the network
            // statement never covered all draw the same sentence. This console used to distinguish them
            // ("has no address: OSPF needs one to form an adjacency", "is not in OSPF"); the distinguishing
            // facts are still readable in `show ip interface brief` and `show running-config`. The name goes
            // through the same expansion `show ip interface brief` uses, because `s0` comes back as `Serial0`.
            // research/show-ospf-interface-not-enabled.md holds the captures and the open half.
            out.push('%OSPF: OSPF not enabled on ' + require('./iface-name').displayName(port.name));
          }
        } else {
          out.push('% OSPF is enabled but no interface qualifies (needs an address and the port up)');
        }
        return out;
      }
      // The Area column was six characters wide, which fits `0` and not `0.0.0.1`: an area configured in
      // dotted form ran into the Cost column and printed as `0.0.0.11` - the area, the cost and the start of
      // the next field read as one number. Widths come from the data here, as they do in `show lldp
      // neighbors` (#1265), with the old six as the floor so every decimal-only lab is unchanged.
      const areaWidth = rows.reduce(function (w, i) { return Math.max(w, String(i.area).length + 2); }, 6);
      // `Pri` is the port's own Hello priority - the number the neighbour table prints beside the
      // other end, and the first term of the election. Without it the value could be set and read
      // back only from across the cable.
      out.push(pad('Interface', 12) + pad('IP Address', 17) + pad('Area', areaWidth) + pad('Cost', 6) + pad('Cost from', 12) +
        pad('Pri', 4) + pad('Adjacent', 10) + 'Passive');
      for (const i of rows) {
        const netLib = require('./net');
        const len = netLib.prefixOf(i.mask);
        out.push(pad(i.name, 12) + pad(i.ip + (len === null ? ' ' + i.mask : '/' + len), 17) +
          pad(String(i.area), areaWidth) + pad(String(i.cost), 6) + pad(i.costSource === 'configured' ? 'configured' : 'link rate', 12) +
          pad(String(i.priority == null ? 1 : i.priority), 4) +
          pad(i.adjacent ? 'yes' : 'no', 10) + (i.passive ? 'yes' : 'no'));
      }
      out.push('');
      out.push(rows.length + ' interface(s) in OSPF');
      return out;
    }

    out.push('% Usage: show ip ospf [process | neighbour [<port>] | interface [<port>]]');
    return out;
  }

  _showBgp(args) {
    const dev = this.device;
    const cfg = dev.config && dev.config.bgp;
    const out = [];
    // A box with no BGP process answers every one of these views with the same five words - `% BGP not active`
    // - and not the sentence this console used to print (`% BGP is not enabled`). It is the string a reader
    // pastes into a search box and the string a colleague recognises; "is not enabled" is a description of the
    // same fact in words no box prints. Three Cisco IOS/IOS XE captures, three sub-views:
    //   R12#sh ip bgp                  -> % BGP not active   (Cisco Community, "BGP Synchronization and MPLS",
    //                                                          https://community.cisco.com/t5/routing-and-sd-wan/bgp-synchronization-and-mpls/td-p/2904090)
    //   #sh ip bgp regexp ^abc         -> % BGP not active   (Cisco Community, 9800 WLC thread,
    //                                                          https://community.cisco.com/t5/wireless/automatically-apply-tag-policy-tag-rf-tag-site-on-cisco-9800-wlc/td-p/4906039)
    //   P#sh ip bgp summary            -> % BGP not active   (IOS XE lab transcript,
    //                                                          https://www.pinglabz.com/mpls-l3vpn-configuration-step-by-step/)
    // The Arista EOS spelling of the same refusal is `% BGP is not active`, one word different and a reminder
    // that this is a vendor's line rather than a universal one; this console imitates Cisco's, so it prints
    // Cisco's. research/bgp-not-active-refusal.md records the three captures and the half that is still open
    // (the config-mode refusals below are this console's own sentences and are not what a box says at all).
    if (!cfg || !cfg.as) { out.push('% BGP not active'); return out; }

    // A word after the view is refused, not silently dropped. Both spellings took no argument at all: `args` was
    // read by nobody, so `show ip bgp 10.9.9.0/24` on a box holding that route printed the whole table - the same
    // non-answer `show ip route <prefix>` gave before #1403, and the same reason it is wrong (a table with prefixes
    // in it reads as "yes"). A box refuses the word instead: `sh ip bgp neighbors br` on an IOS XE switch draws
    // `% Invalid input detected at '^' marker.` (https://community.cisco.com/t5/routing/bgp-using-layer-3-switches/td-p/5075192),
    // and neither spelling has a free positional word - `show ip bgp`'s keyword list ends at `route-map <name>` and
    // `show ip bgp summary`'s at `[slow]` (Cisco IOS IP Routing: BGP Command Reference, "show ip bgp" and "show ip
    // bgp summary", https://cisco.com/c/en/us/td/docs/ios/iproute_bgp/command/reference/irg_book/irg_bgp5.html).
    //
    // The first spelling *does* take an ip-address on a box, as a filter, so "does not take" is this console's
    // claim about itself and not a claim about IOS - the same trade `show ip route <prefix>` makes, and the reason
    // the sentence names where the answer actually is (the Network column) instead of stopping at the refusal.
    //
    // The refusal sits below the state check, not above it: with no process a box answers every one of these
    // spellings with `% BGP not active` - that is the captured behaviour this view was built to (`research/
    // bgp-not-active-refusal.md`, `test/bgp-not-active.test.js`) and it holds whatever was typed, because there is
    // no table for a word to be dropped from. research/show-ip-bgp-argument-refusal.md records the ordering
    // question that is still open (a box parses before it consults BGP state, so a junk word on a process-less box
    // draws the caret error there).
    const sub = String(args[0] || '').toLowerCase();
    if (sub && sub !== 'summary') {
      if (sub === 'neighbors' || sub === 'neighbours' || sub === 'neighbor' || sub === 'neighbour') {
        // A real view this console keeps no form of - the neighbour *detail* block (hold time, capabilities,
        // message counters). Refusing it as "does not take" would deny a command a box has; the nat console answers
        // the same shape of gap with its own sentence (`show ip nat translations has no verbose form`), so does this.
        return ['% show ip bgp ' + args.join(' ') + ' has no detail view here: every neighbour, the AS it is in, its ' +
          'state and the prefixes it sent are in the table under `show ip bgp`'];
      }
      return showNoTail('show ip bgp', args, 'every neighbour and every installed prefix are printed',
        'read the row for the prefix under the Network column');
    }
    if (sub === 'summary' && args.length > 1) {
      return showNoTail('show ip bgp summary', args.slice(1),
        'every neighbour is listed with its state and the prefixes it received');
    }

    const rows = dev.bgpNeighbors || [];
    // The election again, for the case where no pass has run over this device: `show ip bgp` printed
    // 0.0.0.0 for a box holding addresses simply because nothing had computed the identifier yet.
    const electedId = (dev.bgpRouterId || cfg.routerId ||
      require('./bgp').deriveRouterId(Array.from(dev.interfaces.values())) || '0.0.0.0');
    out.push('BGP router identifier ' + electedId +
      ', local AS number ' + cfg.as);
    out.push('');
    // The last cell is the box's `State/PfxRcd`, and it carries two different kinds of value:
    // while the session is established it is the *number of prefixes received* from that
    // neighbour, and while it is not it is the finite-state-machine word (Idle, Active,
    // Connect, OpenSent, OpenConfirm). A real box never prints the word "Established" in
    // this table - "Note that you won't see the word 'Established' in the output of the show
    // summary command: rather, you'll see the number of prefixes received from the neighbor"
    // (https://www.noction.com/blog/debugging-bgp-states), and Dell's command reference for
    // the same field says so in the field description: "If the neighbor is in Established
    // stage, the number of network prefixes received ... If the neighbor is not in
    // Established stage, the current stage is displayed"
    // (https://www.dell.com/support/manuals/en-lt/dell-emc-os-9/s4048t-on-9.14.2.6-cli-pub/show-ip-bgp-summary).
    // This table printed the word on every live row, so a reader comparing it with a capture
    // found a value the box cannot produce, and could not answer the question the column is
    // opened for: is my peer sending me anything? `State/PfxRcd` is the header the field
    // actually carries (Cisco, "Understand Basic BGP Troubleshoot",
    // https://cisco.com/c/en/us/support/docs/ip/border-gateway-protocol-bgp/220604-understand-basic-bgp-troubleshoot.html).
    // The down-state word stays `Idle`: every way this model refuses a session (a link that
    // cannot carry a frame, a shut far port, no neighbour statement) leaves the box waiting
    // to retry, and Cisco's own capture of a peer with "no connected route peer or no route
    // at all" reads `never  Idle`
    // (https://www.cisco.com/c/en/us/support/docs/ip/border-gateway-protocol-bgp/218027-troubleshoot-border-gateway-protocol-bas.html).
    // The `Reason` column beside it is this console's own teaching aid and no box prints it;
    // what the box has in the columns between (`MsgRcvd`, `MsgSent`, `TblVer`, `InQ`, `OutQ`,
    // `Up/Down`) is not modelled (research/show-ip-bgp-summary-state-cell.md).
    out.push(pad('Neighbor', 17) + pad('V', 3) + pad('AS', 8) + pad('State/PfxRcd', 16) + 'Reason');
    if (!rows.length) {
      out.push('(no neighbours have been evaluated yet - run a simulation)');
    } else {
      for (const r of rows) {
        out.push(pad(r.address, 17) + pad('4', 3) + pad(String(r.remoteAs == null ? '?' : r.remoteAs), 8) +
          pad(r.established ? String(r.received == null ? 0 : r.received) : 'Idle', 16) +
          (r.established ? (r.session === 'ibgp' ? 'iBGP' : 'eBGP') : (r.reason || r.code || '')));
      }
    }
    const up = rows.filter(function (r) { return r.established; }).length;
    out.push('');
    out.push(up + ' of ' + rows.length + ' neighbour(s) established');
    // "Installed" has to mean installed (#1407). The count was of everything a peer sent, so a prefix BGP
    // learned but the device already reaches directly - a connected route wins on distance 0 - was counted
    // here as installed while `show ip route` printed it as "not installed". Two reports, one fact, two
    // answers; the routing table is the authority because it is the one the forwarding lookup agrees with.
    const learned = (dev.bgpRoutes || []).length;
    let installed = learned, shadowed = 0;
    if (learned && this.topo) {
      const bgpRows = dev.routesTable(this.topo).filter(function (r) { return r.type === 'bgp'; });
      installed = bgpRows.filter(function (r) { return r.installed !== false; }).length;
      shadowed = bgpRows.length - installed;
    }
    out.push(installed + ' prefix(es) installed from BGP' +
      (shadowed ? ' (' + shadowed + ' more received, not installed: a better route holds the prefix)' : ''));
    if (learned) {
      // Which prefixes, from where, with what path. The count alone answered "did BGP do anything" and not
      // "which route did I get and off which peer", which is the next question and the one `show ip route`
      // sends you here with (#1269).
      out.push('');
      const netLib = require('./net');
      const cells = dev.bgpRoutes.map(function (r) {
        // The mask is stored dotted, and the prefix length is the same rule `show ip route` uses, so the two
        // tables cannot print the same route two ways.
        const len = netLib.prefixOf(r.mask);
        return {
          network: r.dest + (len === null ? ' ' + r.mask : '/' + len),
          nextHop: r.nextHop || '-',
          metric: '0',
          // LocPrf is the LOCAL_PREF attribute, and the attribute only exists on a route that crossed an
          // iBGP session: eBGP does not carry it, and neither does a locally originated network. A box
          // therefore prints 100 in this column for an iBGP-learned route and a blank cell for an
          // eBGP-learned one - the blank is not "no preference", it is "the attribute is not here"
          // (Cisco, BGP and Local Preference: "show ip bgp show values (100) for routes advertised via
          // iBGP and no values (blank) for routes advertised via eBGP",
          // https://community.cisco.com/t5/routing/bgp-and-local-preference/td-p/1082270; the sample in
          // Cisco's BGP Case Studies prints `*> 192.208.10.0 192.208.10.5 0 <blank> 0 300 i` for an
          // external route, http://www.cisco.com/c/en/us/support/docs/ip/border-gateway-protocol-bgp/26634-bgp-toc.html).
          // This console printed 100 on every row, which is a value a box never puts beside an eBGP path.
          locPrf: r.session === 'ibgp' ? '100' : '',
          weight: '0',
          path: (r.asPath && r.asPath.length ? r.asPath.join(' ') + ' ' : '') + 'i',
          via: r.iface || '-',
          session: r.session === 'ibgp' ? 'iBGP' : 'eBGP'
        };
      });
      const w = function (key, floor) {
        return Math.max(cells.reduce(function (m, c) { return Math.max(m, String(c[key]).length); }, 0) + 2,
          floor || 0);
      };
      const wNet = w('network', 17), wHop = w('nextHop', 9), wPath = w('path', 7);
      out.push(pad('Network', wNet) + pad('Next Hop', wHop) + pad('Metric', 8) + pad('LocPrf', 8) +
        pad('Weight', 8) + pad('Path', wPath) + 'Session');
      for (const c of cells) {
        out.push(pad(c.network, wNet) + pad(c.nextHop, wHop) + pad(c.metric, 8) + pad(c.locPrf, 8) +
          pad(c.weight, 8) + pad(c.path, wPath) + c.session);
      }
    }
    return out;
  }

  // "speed: 1Gb/s (auto), duplex: full" - or the forced rate, plainly marked, with what the link actually
  // negotiated when the two differ.
  // One sentence for what a port does with a frame: the mode, the VLAN an untagged frame lands in, and - when
  // a trunk parameter is stored but not in use - that it is staged rather than in force. Silent for a port
  // with no switchport configuration at all, because "switchport: none" would be a claim about a mode this
  // device does not have.
  _switchportLine(i) {
    if (!i.vlan) return null;
    // A routed port carries a `vlan` object too - the engine fills a default for every interface - but it does
    // not switch, so printing "access VLAN 1" beside a router's `ip: 10.9.9.1/24` claims a mode the device has
    // not got. The capability is what makes a port a switchport.
    const switches = Array.isArray(this.device.capabilities) &&
      this.device.capabilities.indexOf('l2-forward') !== -1;
    if (!switches) return null;
    return 'switchport: ' + require('./vlan').switchportSentence(i.vlan);
  }

  _linkRateLine(iface) {
    const rated = mediaLib.parseSpeedMbps(iface.speed);
    const forced = iface.speedMbps || null;
    const devId = this.device && this.device.id;
    const link = (this.topo && this.topo.links && iface.peer && devId)
      ? [...this.topo.links.values()].filter(function (l) {
        return (l.a.deviceId === devId && l.a.iface === iface.name) ||
          (l.b.deviceId === devId && l.b.iface === iface.name);
      })[0]
      : null;
    const negotiated = (link && link.speedMbps) ? link.speedMbps : null;
    const fmt = function (m) { return m ? mediaLib.formatSpeedMbps(m) + 'b/s' : 'unknown'; };
    let text = 'speed: ' + (forced ? fmt(forced) + ' (forced)' : fmt(rated) + ' (auto)');
    if (link && link.negotiationFailed) {
      // The two ends were forced to rates with nothing in common. Saying "1Gb/s (forced)" and moving on
      // would describe a link that is not carrying anything.
      text += ', link: down (no common rate with the peer)';
    } else if (negotiated && negotiated !== (forced || rated)) {
      text += ', link runs at ' + fmt(negotiated);
    }
    // The clock, because on a serial link it *is* the rate the line runs at and nothing else says so: the port's
    // rated speed is what the hardware could do, and the cable's rate is what the DCE is clocking. Without this an
    // operator had to remember which end they configured, and `link runs at 0Mb/s` was the only hint (#1483).
    if (iface.clockRateBps) text += ', DCE, clock rate ' + iface.clockRateBps;
    text += ', duplex: ' + (iface.duplex || 'full');
    return text;
  }

  // Where each member of one bundle stands, in one place: `show etherchannel summary` prints its letters from
  // this and `show ip interface brief` asks it whether the bundle itself is up. Two copies of the rule would let
  // the summary call a bundle `(P)` while the interface table called the same bundle `down`.
  //
  // Bundled (P) or down (D) is a statement about the link, not just about spanning tree: a member whose cable is
  // out used to read (P), i.e. "this port is carrying traffic", while it was dropping everything hashed to it
  // (#1263). A member whose two ends never negotiated is not a member - but it is not a dead port either: the
  // hardware puts it into an independent state and it goes on carrying traffic as an ordinary single link
  // (Cisco, Configuring EtherChannels). That is a third state, so the summary gives it `(I)` stand-alone - the
  // state the 2960 and 3750 chapters call "independent" - rather than `(D)` down, which would claim the cable is
  // out when it is not, or `(s)` suspended, which the key reserves for a port that is *not* carrying
  // (research/lacp-one-sided-group.md).
  _lagMemberStates(dev, l) {
    const lagLib = require('./lag');
    const raw = Array.isArray(l && l.members) ? l.members : [];
    const why = {};
    const suspended = {};
    const canCarry = (function (self, reasons, held) {
      return function (name) {
        const iface = dev.interfaces.get(name);
        if (!iface) { reasons[name] = '(no such port)'; return false; }
        if (dev.stp && dev.stp.blocked && dev.stp.blocked.has(name)) {
          reasons[name] = '(STP blocking)';
          return false;
        }
        // The same sentence `show interfaces` and `show arp` use for the same fact.
        const note = self._staleNote(iface);
        if (note) { reasons[name] = note; return false; }
        // Negotiation is asked last, of a port that could otherwise carry: a stand-alone port still forwards, so
        // "this end never negotiated" must not hide "the cable is out".
        const heldMember = lagLib.memberSuspension(dev, name, self.topo);
        if (heldMember) { held[name] = heldMember; reasons[name] = '(stand-alone: ' + heldMember.why + ')'; return false; }
        return true;
      };
    })(this, why, suspended);
    const live = lagLib.eligibleMembers(raw, canCarry);
    // A member that can carry but finds the channel already holding eight links is not down - it is the port the
    // key above the table calls `(H)` hot-standby, the letter this console printed in its key and could not print
    // in a row (research/etherchannel-member-limit.md). A static (`mode on`) group has no hot-standby in the key's
    // sense, so a ninth member that reached a saved topology is shown `(s)` suspended: up, and not in the channel.
    const standby = lagLib.standbyMembers(raw, canCarry);
    return { raw: raw, why: why, suspended: suspended, live: live, standby: standby };
  }

  // "3 drops (no route to 10.0.0.99 x2, link down x1)" - one phrasing, in engine/simulator.js `dropsSentence()`,
  // because a ping now says the same thing about the same fact and two copies drift (#1417, #1485).
  _dropSummary(drops, limit) {
    return require('./simulator').dropsSentence(drops, limit);
  }

  // "Is this port still somewhere a frame can go, and if not why" - the sentence both tables append to a
  // stale row. One helper so `show arp` and `show mac address-table` cannot describe the same port state
  // two different ways.
  // ---- NAT configuration -------------------------------------------------------------------------
  // `ip nat ...` reaches the model in engine/nat.js. Every rule is validated by `natLib.validateRule()` and
  // refused with the library's own sentence, so the console and the data path cannot disagree about what a
  // rule means. Rules live in `config.nat.rules` with their named pools in `config.nat.pools`, which is the
  // shape `Simulator._natTableOf()` already reads.
  _natConfig(args) {
    // Translating is what the `nat` capability means; a box without it can hold a table nothing consults.
    const cannotTranslate = this._capabilityRefusal('nat', 'translate addresses');
    if (cannotTranslate) return [cannotTranslate];
    const natLib = require('./nat');
    const nat = this.device.config.nat
      ? JSON.parse(JSON.stringify(this.device.config.nat))
      : { rules: [], pools: {} };
    nat.rules = Array.isArray(nat.rules) ? nat.rules : [];
    nat.pools = nat.pools && typeof nat.pools === 'object' ? nat.pools : {};
    const users = function (name) {
      return nat.rules.filter(function (r) { return r.pool === name; }).length;
    };
    const commit = function (self, said) {
      self.device.config.nat = nat;
      self._controlPlaneChanged();
      return [said];
    };
    const isIp = function (v) { return net.isIp(String(v || '')); };

    // ip nat pool <name> <start> <end> netmask <mask>
    if (String(args[0] || '').toLowerCase() === 'pool') {
      const name = args[1];
      const start = args[2];
      const end = args[3];
      const maskKw = String(args[4] || '').toLowerCase();
      const mask = args[5];
      // A pool name is free text, so the help key passed as one and made a pool called "?" (#1691): the
      // running-config printed `ip nat pool ? ...`, `show ip nat statistics` listed `(? 1.1.1.1-1.1.1.2)`, and
      // a later `pool ?` would have resolved through it. Refused before the pool exists.
      if (name) {
        const keyed = this._helpKeyRefusal(name, 'ip nat pool <name> <start> <end> netmask <mask>',
          'nothing was created');
        if (keyed) return [keyed];
      }
      if (name) {
        // A pool address that cannot exist is a typo with one obvious answer; a usage line leaves the operator
        // reading the whole syntax to find it (#1411).
        const badPool = [start, end].filter(function (x) { return x !== undefined && !isIp(x); })[0];
        if (badPool !== undefined) return ['% Invalid pool address "' + badPool + '": not an IPv4 address'];
      }
      if (!name || !isIp(start) || !isIp(end) || maskKw !== 'netmask' || !isIp(mask)) {
        return ['% Usage: ip nat pool <name> <start> <end> netmask <mask>'];
      }
      // A pool's netmask is a netmask: 255.0.255.0 is a legal dotted quad and not a mask, and every prefix rule
      // read from it would describe something the pool does not do.
      if (!net.isContiguousMask(mask)) {
        return ['% Invalid netmask: ' + mask + ' - a netmask is a run of ones then zeros (255.255.255.0, or 24)'];
      }
      if (nat.pools[name]) {
        return ['% A NAT pool called "' + name + '" already exists (' + nat.pools[name].start + ' - ' +
          nat.pools[name].end + '): remove it first with `no ip nat pool ' + name + '`'];
      }
      const a = start.split('.').reduce(function (n, o) { return n * 256 + Number(o); }, 0);
      const b = end.split('.').reduce(function (n, o) { return n * 256 + Number(o); }, 0);
      if (b < a) return ['% Pool "' + name + '" ends before it starts (' + start + ' - ' + end + ')'];
      if (b - a + 1 > 1024) {
        return ['% Pool "' + name + '" covers ' + (b - a + 1) + ' addresses: the model allows 1024 in one pool'];
      }
      nat.pools[name] = { start: start, end: end, netmask: mask };
      return commit(this, 'NAT pool "' + name + '" ' + start + ' - ' + end + ' netmask ' +
        (b - a === 0 ? '255.255.255.255' : mask));
    }

    const which = String(args[0] || '').toLowerCase();
    if (which !== 'inside' || String(args[1] || '').toLowerCase() !== 'source') {
      return ['% Usage: ip nat pool <name> <start> <end> netmask <mask> | ' +
        'ip nat inside source (static <local> <global> [tcp|udp <port>] | list <spec> (pool <name>|interface <if>) [overload])'];
    }
    const kind = String(args[2] || '').toLowerCase();

    // ip nat inside source static <local> <global> [tcp|udp <port>]
    if (kind === 'static') {
      const local = args[3];
      const global = args[4];
      const proto = String(args[5] || '').toLowerCase();
      const port = args[6];
      const badStatic = [local, global].filter(function (x) { return x !== undefined && !isIp(x); })[0];
      if (badStatic !== undefined) {
        return ['% Invalid address "' + badStatic + '" in a static NAT rule: not an IPv4 address'];
      }
      if (!isIp(local) || !isIp(global)) {
        return ['% Usage: ip nat inside source static <inside-local> <inside-global> [tcp|udp <port>]'];
      }
      if (proto && proto !== 'tcp' && proto !== 'udp') {
        return ['% A port forwarding rule needs tcp or udp, not "' + args[5] + '"'];
      }
      const rule = { type: 'static', insideLocal: local, insideGlobal: global };
      if (proto) { rule.protocol = proto; rule.port = Number(port); }
      const verdict = natLib.validateRule(rule);
      if (!verdict.ok) {
        return verdict.errors.map(function (e) { return '% ' + e.message; });
      }
      nat.rules.push(natLib.normalizeRule(rule));
      return commit(this, 'NAT rule added: ' + natLib.formatRuleLine(natLib.normalizeRule(rule)));
    }

    // ip nat inside source list <spec> (pool <name> | interface <if>) [overload]
    if (kind === 'list') {
      const spec = args[3];
      const via = String(args[4] || '').toLowerCase();
      const target = args[5];
      const overload = args.slice(4).some(function (t) { return String(t).toLowerCase() === 'overload'; });
      if (!spec || (via !== 'pool' && via !== 'interface') || !target) {
        return ['% Usage: ip nat inside source list <address spec> (pool <name>|interface <if>) [overload]'];
      }
      if (/^\d+$/.test(spec) && !spec.includes('.')) {
        // IOS takes an ACL number here. Dropping it into an address parser would make the rule silently
        // match nothing, so say what this model wants.
        return ['% ' + spec + ' is an ACL number: this model takes the inside local addresses here, ' +
          'e.g. `list 192.168.1.0/24` or `list any`'];
      }
      let global;
      let poolName = null;
      let ifaceName = null;
      if (via === 'pool') {
        const pool = nat.pools[target];
        if (!pool) {
          return ['% No NAT pool called "' + target + '"' +
            (Object.keys(nat.pools).length ? ' (configured: ' + Object.keys(nat.pools).join(', ') + ')' : '')];
        }
        const one = pool.start === pool.end;
        if (overload && !one) {
          return ['% PAT overloads one address; pool "' + target + '" holds more than one. ' +
            'Use a single-address pool for overload, or drop `overload` for a dynamic pool'];
        }
        global = one ? pool.start : (pool.start + '-' + pool.end);
        poolName = target;
      } else {
        const name = resolvePortName(this.device, args.slice(5).filter(function (t) {
          return String(t).toLowerCase() !== 'overload';
        }).join(' '));
        const iface = name ? this.device.interfaces.get(name) : null;
        if (!iface) return ['% Interface not found: ' + target];
        if (!iface.ip) {
          return ['% ' + iface.name + ' has no address: there is nothing for NAT to translate to'];
        }
        global = iface.ip;
        ifaceName = iface.name;
      }
      const rule = {
        type: overload ? 'pat' : 'dynamic',
        insideLocal: spec,
        insideGlobal: global,
        acl: spec
      };
      if (poolName) rule.pool = poolName;
      if (ifaceName) rule.iface = ifaceName;
      const verdict = natLib.validateRule(rule);
      if (!verdict.ok) return verdict.errors.map(function (e) { return '% ' + e.message; });
      const normalized = natLib.normalizeRule(rule);
      if (poolName) normalized.pool = poolName;
      if (ifaceName) normalized.iface = ifaceName;
      nat.rules.push(normalized);
      return commit(this, 'NAT rule added: ' + natLib.formatRuleLine(normalized));
    }

    return ['% Usage: ip nat inside source (static <local> <global> [tcp|udp <port>] | ' +
      'list <spec> (pool <name>|interface <if>) [overload])'];
  }

  // "The control plane has to run its timers again, from now." One place, so a command added later either calls it
  // or is caught by the test that walks the commands that change the forwarding decision (#1331).
  _controlPlaneChanged() {
    if (this.sim && typeof this.sim.markTopologyChange === 'function') this.sim.markTopologyChange();
    else if (this.topo && typeof this.topo.markChange === 'function') this.topo.markChange(0);
  }

  _staleNote(port, extra) {
    // One implementation, in the engine, because the state payload says the same thing to the browser (#1327).
    return this.device.portCarrierNote(port, this.topo, extra);
  }

  // The `Admin` column of `show power inline` is the port's PoE **administration mode**, and the vendor's own
  // field table names its three words: "Administration mode: auto, off, static" (Catalyst 2960-X 15.2(6)E and
  // 9300 17.9 both print that row). `auto` is the factory default - "The default is auto (enabled)" - and
  // `off` is what `power inline never` puts there, which a 2960 transcript shows as
  // `Fa0/24 off off 0.0 n/a n/a 15.4` after that command.
  //
  // `up`/`down` is the *link's* administrative state, a word this column never carries, and this console
  // printed it here: a shut port read `down` in Admin as though its PoE mode had been configured to something,
  // and a working port read `up`, which is not one of the three modes either. The link state belongs in the
  // `Oper` word (`off`) and in the reason column beside it, where this view already says
  // "administratively down".
  //
  // This model has no `power inline` command, so no port here can be `off` or `static`: every PSE port is in
  // the one mode a factory-default port is in. Whether a real box flips this column to `off` when a port is
  // merely shut is not settled by any transcript in hand - see research/show-power-inline-admin-column.md.
  _poeAdminMode(iface) {
    // The port is not consulted yet, and the parameter says why: the mode is per port, and the day a
    // 'power inline' line exists this is where it is read from that port.
    return 'auto';
  }

  // `show power inline [<port>]` - what the PSE is supplying, and why a powered device got nothing.
  //
  // The engine has computed this since PoE was modelled (`computePoe()`), the inspector has displayed it, and the
  // console could not answer it at all: the one mechanism whose state could only be seen in the browser. Every
  // fact below comes from the engine's own result - no second copy of the allocation rule - and the port list
  // comes from the hardware, so a port the engine leaves out of its table (shut down, unplugged, or plugged into
  // something that is not a powered device) is still named and explained.
  _showPowerInline(typed) {
    const dev = this.device;
    const out = [];
    // The port name is the whole rest of the line, not its first word: "Port 1" is a name on 17 models of the
    // catalogue, and reading only "Port" answered `% No interface Port` about a port that is right there (#1401).
    const wanted = (typed && typed.length) ? typed.join(' ') : null;

    // The PSE hardware, in port order. A port can supply power whether or not it currently does.
    let pse = [...dev.interfaces.values()].filter(function (i) { return i.poeOut; });
    if (!pse.length) {
      return ['% No PoE on ' + dev.name + ': no port on this device can supply power'];
    }
    if (wanted) {
      const name = resolvePortName(dev, wanted);
      const one = name ? dev.interfaces.get(name) : null;
      if (!one) return ['% No interface ' + wanted + ' on ' + dev.name];
      if (!one.poeOut) {
        return ['% ' + one.name + ' on ' + dev.name + ' cannot supply power (it is not a PSE port)'];
      }
      pse = [one];
    }

    // "Not measured" and "measured zero" are different answers. `sim.poe` is undefined until something has run
    // the allocation, so asking it is asking whether anything has looked.
    const table = this.sim ? this.sim.poe : null;
    if (!Array.isArray(table)) {
      return ['Not measured (no simulation run): nothing has computed the power budget yet'];
    }
    const entry = table.filter(function (p) { return p.dev === dev.id; })[0] || null;
    // A device with PSE ports and no budget is not served by the engine at all, and saying "0 W" would be a
    // measurement it never made.
    if (!entry) {
      out.push(pad('Interface', POWER_TABLE_WIDTHS.iface) + pad('Admin', POWER_TABLE_WIDTHS.admin) + 'Supplied');
      for (const i of pse) {
        out.push(tableCell(i.name, POWER_TABLE_WIDTHS.iface) +
          tableCell(this._poeAdminMode(i), POWER_TABLE_WIDTHS.admin) + 'not measured');
      }
      out.push('budget not modelled on ' + dev.name +
        ': the ports are reported, the power they could supply is not');
      return out;
    }

    const byIface = new Map((entry.ports || []).map(function (p) { return [p.iface, p]; }));
    const nameOf = function (id) {
      const d = this.topo && typeof this.topo.getDevice === 'function' ? this.topo.getDevice(id) : null;
      return d ? (d.name || d.id) : id;
    }.bind(this);

    const rows = [];
    const idle = [];
    let supplied = 0;
    for (const i of pse) {
      const p = byIface.get(i.name);
      const admin = this._poeAdminMode(i);
      if (p) {
        // A port that detected a powered device and could not give it power is in the vendor's fourth
        // Oper state: `power-deny` - "a powered device is detected, but no PoE is available" - and not in
        // `off`, which the same field table defines as "No PoE is applied" and which a box prints for a
        // socket with nothing on it. The two words answer different questions (is anything out there?), so a
        // refused port printed `off` read exactly like an empty one. The Power cell is the power ALLOCATED,
        // and a refusal allocates none: the box prints 0.0 there, and the figure the device asked for belongs
        // to the sentence under the table, where the budget arithmetic is stated.
        //   https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_7_e/command_reference/b_1527_2960x_cr/interface_and_hardware_commands.html
        //   research/show-power-inline-power-deny.md
        const oper = p.powered ? 'on' : 'power-deny';
        // One decimal and no unit: the box's Power cell is a bare number in the column the heading already
        // calls Power, and every capture prints it to a tenth (`3.3`, `13.7`, `0.0`) - the same precision the
        // `Available:/Used:/Remaining:` line above the table uses, so the row and the total agree when added.
        const draw = p.powered ? poeWatts(p.draw || 0) : '0.0';
        rows.push(tableCell(i.name, POWER_TABLE_WIDTHS.iface) + tableCell(admin, POWER_TABLE_WIDTHS.admin) +
          tableCell(oper, POWER_TABLE_WIDTHS.oper) + tableCell(draw, POWER_TABLE_WIDTHS.power) + nameOf(p.pd));
        if (p.powered) supplied += p.draw || 0;
        continue;
      }
      // Not in the engine's table: the port supplies nothing, and the reason is one of three, in the same words
      // `show interfaces` uses for a port that cannot carry a frame.
      let why;
      if (!i.enabled) why = 'administratively down';
      else {
        // The cable is found the same way `show interfaces` finds it - by asking the topology for the link that
        // touches this port - rather than by a second, private lookup.
        const link = (this.topo && typeof this.topo.linksFor === 'function')
          ? this.topo.linksFor(dev.id).filter(function (l) {
            return (l.a.deviceId === dev.id && l.a.iface === i.name) ||
                   (l.b.deviceId === dev.id && l.b.iface === i.name);
          })[0] || null
          : null;
        why = link ? 'the far end is not a powered device' : 'nothing plugged in';
      }
      if (why === 'nothing plugged in' && !wanted) {
        // A wall of "nothing plugged in" is how the one port that matters gets missed. They are still named,
        // once, below the table.
        idle.push(i.name);
        continue;
      }
      rows.push(tableCell(i.name, POWER_TABLE_WIDTHS.iface) + tableCell(admin, POWER_TABLE_WIDTHS.admin) +
        tableCell('off', POWER_TABLE_WIDTHS.oper) + tableCell('-', POWER_TABLE_WIDTHS.power) + why);
    }

    // The budget summary is the box's first line, above the port table, in the box's own words and unit.
    // A standalone Catalyst's `show power inline` opens with one line -
    //   Available:370.0(w) Used:279.9(w) Remaining:90.1(w)
    // - and only then prints the Interface/Admin/Oper table. The engine printed a `Total: ... W of ... W in
    // use, ... W left` sentence after the table, which is a different answer in a different place:
    // research/show-power-inline-summary-line.md has the captures. The stackable 2960-X instead prints a
    // per-member `Module Available Used Remaining` table here, a shape this single-box model does not have.
    //
    // Totals are the device's, so a question about one port does not get them: the number would be about
    // something else.
    if (!wanted) {
      // One decimal, and `Remaining` is `Available - Used` on the printed values - the field table's own
      // definition - so the three numbers a reader adds up agree with each other as well as with the engine.
      const round1 = function (n) { return Math.round(Number(n) * 10) / 10; };
      const watts = function (n) { return poeWatts(n) + '(w)'; };
      const avail = round1(entry.budget || 0);
      const used = round1(supplied);
      out.push('Available:' + watts(avail) + ' Used:' + watts(used) +
        ' Remaining:' + watts(avail - used));
    }
    // `Oper` is eleven characters wide, the width the box's own heading holds: "power-deny" is ten
    // characters and would otherwise push the columns behind it one word out of line on exactly the rows
    // that are hardest to read.
    out.push(POWER_TABLE_HEADER);
    out.push(POWER_TABLE_UNITS);
    out.push(POWER_TABLE_RULE);
    out.push.apply(out, rows);
    if (idle.length) {
      out.push(idle.length + ' port' + (idle.length === 1 ? '' : 's') + ' with nothing plugged in: ' +
        idle.slice(0, 5).join(', ') + (idle.length > 5 ? ' (+' + (idle.length - 5) + ' more)' : ''));
    }
    // The denial sentence is the one the timeline emitted, not a second rendering of the same arithmetic.
    for (const i of pse) {
      const p = byIface.get(i.name);
      if (p && !p.powered && p.reason) out.push('  ' + i.name + ': ' + p.reason);
    }
    return out;
  }

  // A `show` describes the lab at an instant, and the control planes are results - they are computed, not stored.
  // `show ip route` printed whatever the last `computeOspf()` left on the device, so a console with no run behind it
  // reported "no O routes" on a lab that was fully converged, and the answer to the same question depended on which
  // run happened before it (#1338). Recorded state is not the thing being asked about; the simulation is.
  _refreshControlPlane() {
    const sim = this.sim;
    if (!sim) return;
    // Recompute at the instant the session is standing at. Each of these is idempotent for a given
    // (topology, runAtMs), and each is what the packet path already runs before it sends anything.
    //
    // Only the processes this device is *configured* to run. Recomputing a process that is not configured does not
    // give the same answer twice - it erases the device's learned routes, so a `show` would quietly delete state that
    // something else installed (a test fixture, an imported lab, a future caller). A `show` may compute; it must not
    // destroy.
    const cfg = this.device.config || {};
    if (typeof sim.computeStp === 'function') sim.computeStp();
    if (cfg.vrrp && typeof sim.computeVrrp === 'function') sim.computeVrrp();
    if (cfg.ospf && typeof sim.computeOspf === 'function') sim.computeOspf();
    if (cfg.bgp && typeof sim.computeBgp === 'function') sim.computeBgp();
  }

  // The alias/pointer decision for `show ip <view>` (#1447), or null to let the existing doors answer.
  //
  // Only the two-token form is rewritten: `show ip interface brief`, `show ip ospf neighbor`, `show ip bgp summary`,
  // `show ip nat translations`, `show ip dhcp binding`, `show ip route <prefix>` and every other longer form already
  // has its own door and keeps it. `show ip arp <address>` is aliased with its argument, so the answer a reader gets is
  // the one `show arp <address>` gives - which is the useful refusal that says the whole cache is listed.
  // Returns `{ rewrite: [...tokens] }` to hand the question to the door that has the view, `{ lines: [...] }` to answer
  // it here, or null to let the existing branches see the tokens untouched.
  _showIpRedirect(tokens) {
    if (String(tokens[0] || '').toLowerCase() !== 'ip') return null;
    const rest = tokens.slice(1);
    const sub = String(rest[0] || '').toLowerCase();
    if (!sub || sub === '?') return { lines: showIpUsage() };
    if (SHOW_IP_ALIASES[sub]) return { rewrite: [SHOW_IP_ALIASES[sub]].concat(rest.slice(1)) };
    if (rest.length === 1 && SHOW_IP_BARE_ALIASES[sub]) return { rewrite: [SHOW_IP_BARE_ALIASES[sub]] };
    if (rest.length === 1 && SHOW_IP_POINTERS[sub]) {
      return { lines: ['% `show ip ' + sub + '` is not a view here: ' + SHOW_IP_POINTERS[sub]] };
    }
    return null;
  }

  _show(tokens) {
    // The view word may be shortened to what is still unique, like any command word: `sh ver`, `sh int`, `sh sp`.
    // Two things depend on the spelling that was typed rather than on the door it reached:
    //
    //  * `show port-channel summary` is how most of the world spells the table this console keeps under
    //    `show etherchannel summary` (#1449). Same door, so the two cannot disagree; the target's own argument rules
    //    then apply, which is why `show port-channel 1` gets the sentence about every group being listed. The
    //    spelling the reader typed is remembered so any refusal below names *their* command, not the one it was
    //    rewritten into: being answered about `show etherchannel` after typing `show port-channel` reads as a non
    //    sequitur.
    //  * an ambiguous prefix is refused before any door opens, because there is no door to open.
    this._showAliasFrom = null;
    const typedView = String(tokens[0] || '').toLowerCase();
    // `?` is the console's index key, and the view word after `show` is one of the two positions where a *complete*
    // table exists (see the note over EXEC_WORDS) - the one condition this console asks before it agrees to answer a
    // question about what may stand somewhere. It answered `% Invalid show command: ?` instead, calling the key
    // itself the mistake, one word after `show ip ?` had already listed the views behind `ip` (#1673). The answer
    // comes from the dispatch table rather than from a second copy of it, so the two cannot disagree.
    if (typedView === '?') return showViewUsage();
    const viewWord = resolveCommandWord(typedView, SHOW_VIEW_WORDS);
    if (viewWord.rivals.length) {
      return ['% Ambiguous command "show ' + typedView + '": ' + viewWord.rivals.join(' | ') +
        ' (type more characters)'];
    }
    if (viewWord.word && viewWord.word !== typedView) {
      if (viewWord.word === 'etherchannel') this._showAliasFrom = 'show ' + typedView;
      tokens = [viewWord.word].concat(tokens.slice(1));
    }
    // A `show ip <view>` spelling is answered by the door that has the view (#1447), before any other branch sees it.
    const redirect = this._showIpRedirect(tokens);
    if (redirect && redirect.rewrite) tokens = redirect.rewrite;
    else if (redirect) return redirect.lines;
    const what = (tokens[0] || '').toLowerCase();
    const dev = this.device;
    this._refreshControlPlane();
    const out = [];
    if (what === 'version' || what === 'ver') {
      if (tokens.length > 1) {
        return showNoTail('show version', tokens.slice(1), 'the banner is the answer');
      }
      out.push(this._banner());
      out.push('Vendor     : ' + dev.vendor);
      out.push('Model      : ' + dev.model + ' (' + dev.label + ')');
      out.push('Category   : ' + dev.category);
      out.push('Capabilities: ' + dev.capabilities.join(', '));
      out.push('Interfaces : ' + dev.interfaces.size);
      out.push('Simulator  : PacketForge 0.1.0');
    } else if (what === 'ip' && tokens[1] === 'nat') {
      // The other half of the reachability problem: a mechanism nobody can configure is invisible, and one
      // nobody can *inspect* is unverifiable. Both read the engine's own state - the rules it would apply and
      // the translations it has actually made in the traffic that crossed (#1366).
      const natLib = require('./nat');
      const natCfg = this.device.config.nat || { rules: [], pools: {} };
      const rules = Array.isArray(natCfg.rules) ? natCfg.rules : [];
      const sub = String(tokens[2] || '').toLowerCase();
      // A NAT view is one answer, and a word after it was being dropped in silence: `show ip nat translations
      // verbose` - a real IOS spelling this console keeps no verbose form of - printed the *plain* table, and
      // `... statistics flurbish` printed the counters, neither saying the request had been ignored. The reader
      // asked a different question than the one that was answered, which is the one thing a console must not do
      // quietly. The word is refused where it was typed, the way `show vlan` and `show access-lists` already
      // refuse theirs (#2097).
      const natTail = tokens.slice(3);
      if (natTail.length) {
        if (sub === 'translations' || sub === 'translation') {
          if (String(natTail[0] || '').toLowerCase() === 'verbose') {
            return ['% show ip nat translations has no verbose form: every row already carries the inside local ' +
              'and global and the outside local and global addresses, so the plain table is the whole answer'];
          }
          return showNoTail('show ip nat translations', natTail, 'every translation in the table is printed');
        }
        if (sub === 'rules') {
          return showNoTail('show ip nat rules', natTail, 'every rule is printed, one line each');
        }
        if (sub === 'statistics' || sub === 'stat') {
          return showNoTail('show ip nat statistics', natTail, 'every counter is printed');
        }
        // Any other word after `nat` is a view this console does not have: the Usage line below names the three.
      }
      if (sub === 'rules') {
        if (!rules.length) {
          out.push('% No NAT rules configured');
          const pools = Object.keys(natCfg.pools || {});
          if (pools.length) {
            out.push('  % ' + pools.length + ' pool(s) configured but no rule uses them: ' + pools.join(', '));
          }
        } else {
          for (const r of rules) out.push(natLib.formatRuleLine(r));
        }
      } else if (sub === 'translations' || sub === 'translation') {
        // `dev.natTable` is created by the first packet that needed translating, so "no table" and "no
        // translations" are different answers: the first means nothing has crossed, the second means it has
        // and nothing needed translating.
        const table = this._natTableAt();
        const rows = table ? natLib.formatTable(table) : [];
        if (!table) {
          out.push('No translations: no packet needing NAT has crossed this device' +
            (rules.length ? '' : ' (and there are no rules to need one)'));
        } else if (rows.length) {
          // The library prints the rows; the header belongs with them or the columns are unlabelled.
          out.push(natLib.TABLE_HEADER);
          out.push.apply(out, rows);
        }
        // The box closes the view with its own count and prints nothing else when the table is empty - an IOS XE
        // box with no translations answers with this one line and no headings (research/show-ip-nat-translations-total.md).
        out.push('Total number of translations: ' + rows.length);
      } else if (sub === 'statistics' || sub === 'stat') {
        // Which ports a translation may happen on. Without this line a rule that never fires has no explanation:
        // the ports say nothing and the rule looks broken (#1391).
        out.push(this._natPortsSentence());
        const pools = natCfg.pools || {};
        const names = Object.keys(pools);
        out.push('Inside source rules: ' + rules.length + ' (' +
          rules.filter(function (r) { return r.type === 'static'; }).length + ' static, ' +
          rules.filter(function (r) { return r.type === 'dynamic'; }).length + ' dynamic, ' +
          rules.filter(function (r) { return r.type === 'pat'; }).length + ' PAT overload)');
        out.push('Address pools: ' + names.length +
          (names.length ? ' (' + names.map(function (n) {
            const p = pools[n];
            return n + ' ' + p.start + (p.start === p.end ? '' : '-' + p.end);
          }).join(', ') + ')' : ''));
        // The timeouts are in force whether or not anyone asked: a dynamic translation that has been idle for
        // one is gone. Printing them is the only way to read the rule the table is being held to.
        const timeouts = natCfg.timeouts;
        // `dns` is not a protocol, so it is printed from the port that makes an entry a DNS translation -
        // the same call `expireTranslations()` makes for a UDP entry to port 53, so the line cannot drift
        // from the rule it reports.
        out.push('Timeouts (seconds): icmp ' + natLib.timeoutFor(timeouts, 'icmp') +
          ', udp ' + natLib.timeoutFor(timeouts, 'udp') +
          ', dns ' + natLib.timeoutFor(timeouts, 'udp', natLib.DNS_ALG_PORT) +
          ', tcp ' + natLib.timeoutFor(timeouts, 'tcp') +
          ', other ' + natLib.timeoutFor(timeouts, 'other'));
        const table = this._natTableAt();
        const live = table && Array.isArray(table.translations) ? table.translations.length : 0;
        out.push('Active translations: ' + live + (table ? '' : ' (nothing has needed translating yet)'));
      } else {
        out.push('% Usage: show ip nat (rules | translations | statistics)');
      }
    } else if (what === 'ip' && tokens[1] === 'interface' && tokens[2] === 'brief') {
      if (tokens.length > 3) {
        const want = tokens.slice(3).join(' ');
        // The pointer may only carry a port when the words name one this box has. It was built from whatever was
        // typed, so `show ip interface brief ZZZNOPE` advised `show interfaces ZZZNOPE` - a command whose own
        // answer is `% No interface ZZZNOPE on ...`, i.e. a refusal that ends in a second wrong answer. A word
        // that is not a port leaves the `<port>` placeholder the mac-address-table refusal already uses, so the
        // sentence teaches the shape of the command instead of inventing a spelling of it.
        const known = resolvePortName(dev, want);
        const port = known && dev.interfaces.get(known) ? want : '<port>';
        return showNoTail('show ip interface brief', tokens.slice(3), 'every interface is listed',
          'use `show interfaces ' + port + '` for one port');
      }
      out.push(briefLine(BRIEF_COLUMNS.map(function (c) { return c.head; })));
      // A console or aux socket is a line, not an interface, and a box's own table has no row for one: Cisco's
      // 2811 samples list FastEthernet0/0, FastEthernet0/1, Serial0/0/0 and Serial0/0/1 and nothing else, on a
      // router that has both a console and an aux port. This table used to print `Console unassigned YES unset
      // down down` (and `Aux0` beside it) on every model that declares one - 683 sockets on 233 models.
      // research/console-is-a-line-not-an-interface.md.
      // Rows in the device's own order, with each subinterface under its parent - the order a box prints and
      // the order `show interfaces` prints (research/interface-brief-subinterface-order.md). This table used to
      // append every subinterface after every physical port, so a router-on-a-stick listed its `.10` and `.20`
      // below ports the reader had not asked about, one screen away from the port they ride on.
      const listed = orderWithChildren([...dev.interfaces.values()]
        .filter(function (x) { return !isConsoleLine(x); }));
      for (const i of listed) {
        // The IP-Address cell is the bare dotted quad. IOS's own samples never print the mask here - the
        // field list defines the column as "IP address assigned to the interface" - and a reader comparing a
        // simulator's table against a box's would find a string the box cannot produce (research note:
        // research/interface-brief-address-cell.md). The mask is still printed where a box prints it:
        // `show interfaces` ("ip: 10.0.0.1/24") and `show running-config` ("ip address 10.0.0.1 255.255.255.0").
        const ip = i.ip || 'unassigned';
        // Status is whether the port can carry a frame, not merely whether someone shut it (#1237).
        // The topology has to be passed in: it is the only thing that knows a cable is missing.
        const link = dev.ifaceStatus(i, this.topo);
        // Method names where the address came from, and `unset` is an answer: a port with no address has no
        // method, so printing `manual` beside `unassigned` claims a configuration nobody typed. Cisco's field
        // list includes `unset - Unset`, and its sample output pairs `unassigned  YES unset  ...`.
        // briefMethod() is that rule, and briefLine() is what lands the row under its heading; the fixed-width
        // pad() chain put every row a column off because the header and the rows were counted separately (#1521).
        // The Interface cell spells the type out, as a box's own table does: every published capture
        // of this command prints `GigabitEthernet1/0/1`, not `Gi1/0/1` (research/interface-brief-name-spelling.md).
        // The stored name stays the panel's short spelling; only the printed cell is expanded, so a
        // name typed from this row still resolves.
        out.push(briefLine([require('./iface-name').displayName(i.name), ip, 'YES', briefMethod(i),
          link.status, link.protocol]));
      }
      // An EtherChannel is an interface, and a box lists it here beside the ports that make it up: every
      // published capture of this table taken on a switch with a bundle carries the row
      // `Port-channel1  unassigned  YES unset  up    up`, and one where no member joined the bundle reads
      // `down  down` (research/port-channel-in-interface-brief.md). This table listed only the member ports, so
      // the interface an operator addresses - and the one they ping - appeared in no view they open first.
      //
      // The name is the long form here, not the `Po1` the MAC table and `show etherchannel summary` print: a box
      // shortens the type word inside a table cell and spells it out where the name is the subject of the row.
      // `unassigned`/`unset` because this model builds no Layer 3 bundle, and `up` only when a member is really
      // in the bundle - the same predicate the summary's `(SU)`/`(SD)` flags and `(P)` letters come from, so the
      // two views cannot call one bundle by two states.
      const lagCfg = (dev.config && dev.config.lags) || {};
      for (const id of Object.keys(lagCfg).sort(function (a, b) { return Number(a) - Number(b); })) {
        const live = this._lagMemberStates(dev, lagCfg[id]).live;
        const state = live.length ? 'up' : 'down';
        out.push(briefLine([require('./lag').portChannelIfaceName(id), 'unassigned', 'YES', 'unset', state, state]));
      }
    } else if (what === 'ip' && tokens[1] === 'route') {
      // There is no `show ip route <prefix>` here, and the command used to answer as though there were: it printed
      // the whole table, so a prefix that is *not* installed came back looking installed (#1403).
      if (tokens.length > 2) {
        // The pointer used to say to read the row "in the table below" - and the refusal is one line, with no
        // table below it, so an operator who followed it looked past the answer for output that was never printed.
        // It names the command that does print the table instead.
        return showNoTail('show ip route', tokens.slice(2), 'the whole table is printed',
          'run `show ip route` and read the row for the prefix');
      }
      // A box that does not route has no routing table, and IOS does not print one for it. `show ip route` on a
      // Catalyst with `ip routing` off answers with the default gateway over the host/redirect cache - three
      // lines, no codes legend:
      //
      //   Default gateway is not set
      //   Host               Gateway           Last Use    Total Uses  Interface
      //   ICMP redirect cache is empty
      //
      // Two of Cisco's own configuration guides print the positive form, gateway configured and printed back
      // (the switch uses it only when no routing protocol is configured):
      //   https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst4500/12-2/18ew/configuration/guide/config/supcfg.html
      //   https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst4500/15-1-2/XE_340/configuration/guide/config/supcfg.html
      // The negative form, "Default gateway is not set", is what a 2960 and a 3560 print from the box:
      //   https://community.cisco.com/t5/switching/ip-route-0-0-versus-ip-default-gateway/td-p/812905
      //   https://community.cisco.com/t5/switching/not-sure-what-i-m-missing-switch-reaching-outside-network/td-p/3702977
      // The column layout is taken byte for byte from the `show ip redirects` command reference, which prints
      // this same table: https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipapp/command/iap-cr-book/iap-s1.html
      //
      // This console printed the router's legend and then the `S*` row for the configured gateway - a shape no
      // non-routing box produces - because it answered every device with one shape. No route rows here: the
      // box forwards nothing, so there is no table for rows to belong to. `routeTo()` still reads the gateway,
      // and `ip default-gateway` still appears in `show running-config`.
      //
      // The host cache below the header is not modelled (a real box fills it with destinations reached through
      // the gateway and with ICMP redirect targets), so it is printed empty, in the wording a box with nothing
      // cached prints. research/show-ip-route-host-table.md records what is known and what is not.
      if (typeof dev.isL3 === 'function' && !dev.isL3()) {
        const gw = dev.config && dev.config.defaultGateway;
        out.push(gw ? 'Default gateway is ' + gw : 'Default gateway is not set');
        out.push('Host               Gateway           Last Use    Total Uses  Interface');
        out.push('ICMP redirect cache is empty');
        return out;
      }

      // The legend has to name every code the table can produce: routesTable() emits O (OSPF) and B
      // (BGP) rows as well as C, S and the L (local) row for an interface address, and an undefined code in
      // the legend is a code the reader has to guess at (#1234).
      //
      // `*` is a code too. The table has printed `S*` for a candidate default since #1407 while the legend
      // above it defined only four letters, so the one mark that says "this is where unmatched traffic
      // leaves" was the one a reader could not look up. IOS's own legend carries the same line, in the same
      // place - after the protocol codes (`ia - IS-IS inter area, * - candidate default, U - per-user
      // static route`) - so it goes last here as well (research/show-ip-route-candidate-default.md).
      // `L` is first because the box's legend puts it first, and the codes after it keep the box's order rather
      // than this console's: the vendor's string runs `L - local, C - connected, S - static, R - RIP, M - mobile,
      // B - BGP, D - EIGRP, ... O - OSPF, IA - OSPF inter area ...` - B before O, which the line above had the
      // other way round because the codes were appended as the table learned to produce them
      // (https://www.cisco.com/c/en/us/support/docs/ip/ip-routing/116264-technote-ios-00.html,
      // https://www.cisco.com/c/en/us/support/docs/ip/routing-information-protocol-rip/16448-default.html).
      // The order and the first code are the box's (research/local-route-in-show-ip-route.md). The line itself
      // is not: a box prints the image's whole nine-line legend here, and this console printed one line of its
      // own six codes until #fidelity. `IP_ROUTE_CODES_LEGEND` is that block, with the captures behind it -
      // research/show-ip-route-codes-legend.md.
      out.push.apply(out, IP_ROUTE_CODES_LEGEND);
      // Every row arrives annotated by the device - displayCode, distance, and the sentence that says why it
      // cannot carry a packet - and the inspector's Routes table reads those same fields. Two surfaces printing
      // different verdicts for the same route is the defect this replaced (#1301).
      const rows = dev.routesTable(this.topo);

      // "Gateway of last resort" names the default that is actually installed - the one routeTo() would pick
      // among the candidates: lowest distance. A configured gateway (254) loses to a static default (1), and
      // printing the losing one would send the reader after a next hop no packet ever uses.
      //
      // "Installed" is not enough on its own: a default whose next hop no interface is on the subnet of is a
      // gateway no packet can reach, so the line must not name it either (#1439). `shadow` does not disqualify a
      // row - when the group's winner is unusable, the reachable candidate is the only gateway worth naming, and
      // it is the one `routeTo()` would fall through to once the unusable row cannot be used.
      // A default at distance 255 is never installed, so it is not the gateway of last resort either.
      const fallback = rows
        .filter(function (r) { return r.mask === '0.0.0.0' && r.gw && r.gw !== '-'; })
        .filter(function (r) { return !r.unusable && !(r.distance >= 255); })
        .sort(function (a, b) { return a.distance - b.distance; })[0];
      if (fallback) {
        out.push('Gateway of last resort is ' + fallback.gw + ' to network 0.0.0.0');
      } else if (typeof dev.isL3 === 'function' && dev.isL3()) {
        // A box that routes always answers the question, and Cisco's own `show ip route` samples answer it
        // negatively when nothing is installed: `Gateway of last resort is not set`, in this same place,
        // between the codes legend and the first route row. Leaving the line out made "there is no default"
        // and "this console does not talk about defaults" look identical.
        //
        // The negative form is printed whenever no reachable default exists - including when a default row is
        // listed but no packet can leave by it, which is what a real box does with a next hop that is off every
        // connected subnet: the row still carries the reason, and the line above it says the gateway is not set.
        //
        // Only for a box that routes. A Catalyst that does not run `ip routing` prints its own, different
        // `show ip route` ("Default gateway is not set" over a Host/Gateway table), which this console does
        // not model - giving it a router's sentence would answer with a shape the device never prints.
        out.push('Gateway of last resort is not set');
      }

      for (const r of rows) {
        const prefix = net.prefixOf(r.mask);
        // The destination is ONE field: `10.1.1.0/24`, not an address padded out to a column with the mask
        // hanging off it. Every IOS sample prints the pair joined - `C 10.44.192.0/24 is directly
        // connected, GigabitEthernet0/0`, `S* 0.0.0.0/0 [1/0] via 10.108.99.2` - and the web inspector's
        // Routes panel already printed `dest/len` from the same rows, so the two surfaces disagreed about
        // one fact. The padding also laid one table out in two shapes: a /24 row indented its mask to
        // column 20 while the /0 default row put its mask hard against the address.
        //   https://www.cisco.com/c/en/us/support/docs/ip/routing-information-protocol-rip/16448-default.html
        //   https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/iproute_pi/command/Cisco_IOS_IP_Routing_Protocol-Independent_Command_Reference/IP_Routing_Protocol-Independent_Commands_S_through_T.html
        const dest = r.dest + '/' + prefix;
        // The code field is four characters whatever the code is - one letter and three spaces, or `S*` and
        // two - so the prefix starts in the same column on every row. It is built once because two shapes of
        // row now share it (a connected row and a static one with no next hop).
        const codeField = r.displayCode.length === 1 ? r.displayCode + '   ' : r.displayCode + '  ';
        // A static route whose next hop is only an interface is printed by IOS as a directly connected
        // network, not with a next hop: `S 192.168.2.0/24 is directly connected, GigabitEthernet0/1`, and
        // `S* 0.0.0.0/0 is directly connected, FastEthernet0` for the default. The vendor explains why in the
        // `ip route` reference - "When the next hop of a static route points to an interface, the router
        // considers each of the hosts within the range of the route to be directly connected through that
        // interface, and therefore it will send Address Resolution Protocol (ARP) requests to any destination
        // addresses that route through the static route." This console printed the bracket form with a
        // placeholder next hop instead: `S 192.168.2.0/24  [1/0] via -  Gi0/0/0`, a row that names no next hop
        // and prices a metric for it. research/show-ip-route-static-via-interface.md has the captures.
        // `routesTable()` decides which rows take that shape, so the inspector cannot draw a different one:
        // a connected route, or a static route whose next hop is only an interface.
        if (r.directlyConnected) {
          // A connected route stays listed - it is configuration, and `routeTo()` still finds it - but a
          // port that cannot carry a frame is why the ping to that very address fails. Saying nothing left
          // the reader with a route row that reads "directly connected" about a port with no cable (#1271).
          out.push(codeField + dest + '  is directly connected, ' + (r.ifaceDisplay || r.iface) +
            (r.note ? '  ' + r.note : '') + (r.shadow ? '  ' + r.shadow : ''));
          continue;
        }
        // [administrative distance/metric], the format Cisco's `show ip route` command reference states and
        // its "Understand Administrative Distance" note reads: "the values in brackets use the format
        // [administrative distance/metric]" and "[110/2] means that the route has an administrative
        // distance of 110 and an OSPF metric of 2". The metric was the literal 0 for every row, so an OSPF
        // route read `[110/0]` however far away the network was - the distance half was right and the half
        // a reader uses to compare two paths was a placeholder (#fidelity: show ip route metric).
        //
        // The distance is half of the rule that picks the installed route (longest prefix first, then
        // lowest distance), so a table without it cannot be checked by reading. The prefix starts in the
        // same column on every row now that the address itself is not padded.
        // The interface is a comma-separated field of the row, not a column hanging off the next hop: the
        // command reference prints `P 172.16.4.0/8 [1/0] via 10.1.1.1, BRI0`, `H 172.16.99.0 [250/1] via
        // 10.1.1.99, 00:11:43, Tunnel0` and `O E2 10.110.0.0 [160/5] via 10.119.254.6, 0:01:00, Ethernet2`;
        // a fully specified static is `S 172.16.2.0/24 [1/0] via 172.16.4.2, Serial0/0/1`. Two spaces there
        // made the field look like another column and no box writes it that way
        // (research/show-ip-route-interface-spelling.md). A protocol-learned row on the hardware carries a
        // third field between the two - the route's age, `00:11:43` - which this engine does not track; the
        // note records that as the half still open rather than printing a made-up time.
        out.push(codeField + dest +
          '  [' + r.distance + '/' + r.metric + '] via ' + r.gw +
          (r.iface && r.iface !== '-' ? ', ' + (r.ifaceDisplay || r.iface) : '') +
          (r.note ? '  ' + r.note : '') + (r.shadow ? '  ' + r.shadow : ''));
      }
    } else if (what === 'ip' && tokens[1] === 'dns') {
      out.push.apply(out, this._showDns(tokens.slice(2)));
    } else if (what === 'ip' && tokens[1] === 'dhcp') {
      out.push.apply(out, this._showDhcp(tokens.slice(2)));
    } else if (what === 'ip' && tokens[1] === 'ospf') {
      out.push.apply(out, this._showOspf(tokens.slice(2)));
    } else if (what === 'ip' && tokens[1] === 'bgp') {
      out.push.apply(out, this._showBgp(tokens.slice(2)));
    } else if (what === 'ipv6' && (!tokens[1] || tokens[1] === '?')) {
      out.push.apply(out, showIpv6Usage());
    } else if (what === 'ipv6' && tokens[1] === 'nd') {
      // `show ipv6 nd <word>` printed the whole advertisement and dropped the word. The two words an operator is
      // most likely to type - `prefix` and `ra` - are commands they have already typed in config mode, so asking
      // "which prefixes am I advertising" with `show ipv6 nd prefix` looked like it had been answered by the
      // Prefixes block below, while a typo looked like a complete answer too. Every other view that takes no
      // argument refuses the tail (showNoTail, #1403/#2097); this one was the last that did not.
      if (tokens.length > 2) {
        return showNoTail('show ipv6 nd', tokens.slice(2), 'the whole advertisement is printed',
          'the Prefixes block lists every prefix it would advertise, and the Interfaces line names their ports');
      }
      out.push.apply(out, this._showIpv6Nd());
    } else if (what === 'power' && (tokens[1] || '').toLowerCase() === 'inline') {
      out.push.apply(out, this._showPowerInline(tokens.slice(2)));
    } else if (what === 'lldp') {
      const lldpSub = String(tokens[1] || '').toLowerCase();
      if (tokens.length === 1) {
        // `show lldp` is the protocol's status view, not its neighbour table. Both answers are one word away from
        // each other, and this console gave the table to both, so a technician who typed `show lldp` to find out
        // whether LLDP was even running was handed neighbours instead - and a box that had heard nothing looked
        // identical to one with the protocol off (research/lldp-default-state.md, "what is known" 3).
        //
        // The four lines are a vendor transcript, not a composition: a Catalyst 9500 prints exactly these, at this
        // indentation, in Cisco's own field notice on unknown-protocol drops
        // (https://www.cisco.com/c/en/us/support/docs/switches/catalyst-9300-series-switches/224586-troubleshoot-unknown-protocol-drops-in.html,
        // which also shows the off-case answering the one line `% LLDP is not enabled`). The numbers are the
        // protocol defaults, read from the library rather than typed twice (engine/lldp.js).
        //
        // `ACTIVE` and not the refusal, because this model always announces: `announceLldp()` walks every device
        // with a neighbour map and there is no global off switch to read. Saying so is truthful; inventing an
        // `lldp run` would be the feature this run is not allowed to add. What the vendor's default is *before*
        // anyone types it is the part the evidence does not settle, and that stays open.
        const lldpLib = require('./lldp');
        out.push('Global LLDP Information:');
        out.push('    Status: ACTIVE');
        out.push('    LLDP advertisements are sent every ' + lldpLib.DEFAULT_TX_INTERVAL_S + ' seconds');
        out.push('    LLDP hold time advertised is ' + lldpLib.DEFAULT_TTL_S + ' seconds');
        out.push('    LLDP interface reinitialisation delay is ' + lldpLib.DEFAULT_REINIT_DELAY_S + ' seconds');
        // Returned here, not left to fall through: the neighbour table below is the answer to a *different*
        // command, and letting the block run into it would print both views as one answer - the defect this
        // change exists to remove, only upside down.
        return out;
      } else if (lldpSub !== 'neighbors' && lldpSub !== 'neighbours') {
        return showNoTail('show lldp', tokens.slice(1), 'the status view takes no word',
          'neighbours are `show lldp neighbors`');
      } else if (tokens.length > 2) {
        return showNoTail('show lldp neighbors', tokens.slice(2), 'every neighbour on every port is listed',
          'the Local Intf column says which port each one is on');
      }
      // The table that answers "what is plugged into this port" - and it is honest,
      // because it is filled from LLDPDUs that actually crossed the link rather than
      // from the topology file. An empty table means nothing has announced itself.
      // The vendor's brief table, in the vendor's own shape - not this console's. The captures and the field
      // tables are in research/show-lldp-neighbors-columns.md. Four fixed columns and one variable one:
      // Device ID 20, Local Intf 15, Hold-time 11, Capability 16, then Port ID; the legend is three lines and a
      // blank line above the header, and the count is separated from the last row by a blank line.
      //
      // The table this console printed before was its own shape (`LLDP neighbours on <device>:` over Neighbour /
      // Local port / Port ID / Mgmt address, widths taken from the data). That fixed a real readability bug
      // (#1265) and answered a different question from the one a technician asks: this table gets pasted into a
      // ticket, and a pasted table whose columns no box prints cannot be compared with the one beside it. The
      // management address is not lost - it is on the neighbour record and on the port's own block - it was
      // simply never one of this view's columns.
      out.push('Capability codes:');
      out.push('    (R) Router, (B) Bridge, (T) Telephone, (C) DOCSIS Cable Device');
      out.push('    (W) WLAN Access Point, (P) Repeater, (S) Station, (O) Other');
      out.push('');
      // A neighbour is listed for as long as the TTL it advertised. The instant comes from the attached
      // simulator, whose `runAtMs` is Infinity until a caller names one - and Infinity is "no clock", in which
      // case nothing is aged rather than everything guessed stale (`device.lldpRows()`).
      const lldpNowMs = (this.sim && Number.isFinite(this.sim.runAtMs)) ? this.sim.runAtMs : null;
      const rows = dev.lldpRows(this.topo, lldpNowMs);
      // "If the device ID has more than 20 characters, the ID will be truncated to 20 characters in command output
      // because of display constraints" - IOS XR Interface and Hardware Component Command Reference, `show lldp
      // neighbors` field table. The commonest capture of it is a long hostname that ends flush against its port
      // (`long_name_swt.josh-vGi0/2`), which is also what fixes the column at exactly 20.
      const cut = function (v, w) {
        const t = String(v === undefined || v === null ? '' : v);
        return t.length > w ? t.slice(0, w) : t;
      };
      out.push(pad('Device ID', 20) + pad('Local Intf', 15) + pad('Hold-time', 11) +
        pad('Capability', 16) + 'Port ID');
      for (const r of rows) {
        // The five printed fields are the five the box prints, in their columns, and nothing else: a neighbour
        // whose local port cannot carry a frame carries the reason after the last column, because a box would
        // have aged the entry out and this model keeps it until its TTL does.
        out.push(pad(cut(r.systemName, 20), 20) + pad(cut(r.port, 15), 15) +
          pad(String(r.holdTimeS), 11) + pad(r.capabilities || '', 16) + r.portId +
          (r.note ? ' ' + r.note : ''));
      }
      if (!rows.length) {
        // Two empty tables, two answers. "No LLDP has been heard" is history and would be false about a box that
        // heard a neighbour and then watched its hold-time run out - which is exactly the state an operator
        // checking a link that just died is looking at. A box prints neither sentence, so this one line is the
        // console's own; the count under it is the box's.
        out.push(dev.lldp && dev.lldp.size
          ? '  (none - every neighbour has gone past the hold-time it advertised without a fresh LLDPDU)'
          : '  (none - no LLDP has been heard on any port)');
      }
      out.push('');
      // The line the vendor's table ends with, and what its number counts: the rows just printed.
      // A Catalyst's own configuration example prints four neighbours and then exactly this sentence -
      // `Total entries displayed: 4` - at the left margin, one line under the last row, with no blank line
      // between (Cisco, "Catalyst 3750/3750-E/3750-X Series Switches Using LLDP Configuration Example",
      // https://www.cisco.com/c/en/us/support/docs/switches/catalyst-3750-series-switches/113397-lldp-3750-switch-00.html).
      // The same sentence closes the table on NX-OS and IOS XR, and `show mac address-table` already ends its
      // own table with a count of the rows printed for the criterion asked (research/mac-table-surround.md).
      //
      // An empty table prints it too, reading `Total entries displayed: 0`. That was the open half of the
      // question when this line was first added - the pages in hand all had rows in them - and the captures
      // that settle it are a pair of Catalyst 9300s with LLDP running and no neighbour on the port asked about
      // (`Device ID Local Intf Hold-time Capability Port ID` then straight to `Total entries displayed: 0`, on
      // a 9300 whose dot1x is holding the phone's LLDPDUs back and on another asked about one port with
      // nothing on it), plus an IOS router that had just been given `lldp run` and heard nothing yet. Zero is
      // the same rule as four: the number counts the rows the view printed, and the view printed none. The
      // prose above the count stays, because it says *why* the table is empty and the number cannot - this
      // model always announces, so an empty table is never "LLDP is off" (research/lldp-total-entries.md).
      out.push('Total entries displayed: ' + rows.length);
    } else if (what === 'access-lists' || what === 'access-list') {
      if (tokens.length > 1) {
        return showNoTail('show access-lists', tokens.slice(1), 'every list is printed',
          'each list is headed by its number');
      }
      const aclLib = require('./acl');
      const acls = dev.config.acls || {};
      const ids = Object.keys(acls).sort(function (a, b) { return parseInt(a, 10) - parseInt(b, 10); });
      if (!ids.length) out.push('% No access lists configured');
      const binds = dev.aclBindings || {};
      const hits = dev.aclHits;
      for (const id of ids) {
        const kind = aclLib.aclKind(parseInt(id, 10));
        out.push((kind === 'standard' ? 'Standard' : 'Extended') + ' IP access list ' + id);
        const tally = hits ? hits[String(id)] : null;
        // Every line carries the sequence number the box shows, indented four columns under the header -
        // "the first entry is assigned a sequence number of 10, and successive entries are incremented by 10"
        // (Cisco IOS XE, IP Access List Entry Sequence Numbering, sec-acl-seq-num). This table printed 1, 2, 3
        // - an array index, not a sequence - with two spaces of indent, so a reader comparing it with a real
        // box found a column of numbers no box prints, and could not name the line to change. The order is
        // the evaluation order, from the same helper `evaluate()` uses (research/show-access-lists-numbering.md).
        // That helper also rewrites a standard list host-first, as IOS does, so the numbers here can read
        // 30, 40, 10, 20 (research/standard-ace-host-order.md).
        for (const slot of aclLib.numberedEntries(acls[id])) {
          const e = slot.entry;
          // Which line is doing the denying is the question this table is opened for. A rule that matched
          // nothing says nothing - printing "(0 matches)" beside every line of a twenty-line ACL is noise,
          // and the absence of a count is the same statement.
          // The counter is keyed by the text as it was typed, sequence number included, so the number is
          // stripped from the body rather than from the key: an entry typed as "10 permit ip any any"
          // must not print its 10 twice.
          const key = e.line || (e.action + ' ' + (e.protocol || 'ip'));
          // A standard entry is spelled the vendor's way (`permit 10.0.0.0, wildcard bits 0.0.0.255`,
          // `deny 10.0.1.10`, `permit any`), not echoed as it was typed; `aclLib.displayBody()` is the one
          // renderer and returns null for the lines it does not speak for, which keep their typed text.
          // research/show-access-lists-standard-address-form.md.
          const body = aclLib.displayBody(e);
          const ruleText = body !== null ? body : String(key).replace(/^\d+\s+(?=(?:permit|deny)\b)/i, '');
          const count = tally && tally.entries[key] ? tally.entries[key] : 0;
          out.push('    ' + slot.seq + ' ' + ruleText +
            (count ? ' (' + count + (count === 1 ? ' match' : ' matches') + ')' : ''));
        }
        if (tally && tally.implicit) {
          // The implicit deny exists whether or not anyone wrote it, and it is what drops the traffic that
          // matched nothing. Real gear prints it once it has fired.
          out.push('  (implicit deny all: ' + tally.implicit +
            (tally.implicit === 1 ? ' match' : ' matches') + ')');
        }
        if (!tally) {
          // "Nothing matched" and "nothing has looked" are different answers (#1252) - and "no run" is
          // different again from "a run, but no packet came through here".
          out.push(this.sim
            ? '  counters: no packet has been tested against this list'
            : '  counters: not measured (no simulation run)');
        }
        for (const k of Object.keys(binds)) {
          if (String(binds[k].in) === String(id)) out.push('    applied IN on ' + k);
          if (String(binds[k].out) === String(id)) out.push('    applied OUT on ' + k);
        }
      }
    } else if (what === 'vrrp') {
      // `show vrrp <group>` printed every group: the one command that reports which router holds the virtual
      // address answered a question about one group with all of them (#1403).
      if (tokens.length > 1) {
        return showNoTail('show vrrp', tokens.slice(1), 'every group is listed',
          'each group is headed by its number');
      }
      out.push.apply(out, this._showVrrp());
    } else if (what === 'vlan') {
      if (tokens.length > 1 && String(tokens[1]).toLowerCase() !== 'brief') {
        return showNoTail('show vlan', tokens.slice(1), 'every VLAN is listed',
          'the Id column is the VLAN number');
      }
      if (tokens.length > 2) {
        return showNoTail('show vlan brief', tokens.slice(2), 'every VLAN is listed');
      }
      // One table, one row per VLAN, and **access ports only** in the Ports column.
      //
      // The row set is the switch's VLAN database, not the set of VLANs some port mentions: a trunk whose
      // allowed list names a VLAN that was never created carries nothing, and the device prints no row for
      // it. The table used to add every allowed and native VLAN of every trunk, so a lab that had typed
      // `switchport trunk allowed vlan 20,30` and nothing else showed rows for two VLANs that did not exist
      // - and listed the trunk in them.
      //
      // Membership is the vendor's rule, not the data plane's: `show vlan` lists ports configured as
      // access ports, and a trunk port is in no row at all (research/vlan-brief-trunk-ports.md). Cisco's
      // command reference states it for the multi-VLAN form this console prints - "When displaying multiple
      // VLANs only non-trunk ports are displayed" (LAN Switching Command Reference, `show vlan`,
      // https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/lanswitch/command/lsw-cr-book/lsw-s2.html) - and
      // `show vlan all-ports` exists precisely because the default view leaves trunks out. The earlier rule
      // here was `classifyEgress()`, the data plane's answer (#1261), which is right about forwarding and
      // wrong about this table: a trunk forwards every VLAN it carries and appears in none of them.
      const vlanSet = new Set();
      const named = dev.config.vlans || {};
      Object.keys(named).forEach(function (k) { vlanSet.add(Number(k)); });
      vlanSet.add(1);
      for (const i of dev.interfaces.values()) {
        const v = i.vlan || {};
        if (v.mode !== 'trunk') {
          const id = Number(v.accessVlan) || 1;
          // An access port does not put its VLAN back into the table. After `no vlan 22` the port is still
          // assigned to 22 and the VLAN is gone; the device drops both the row and the port's place in it.
          // Building the table from the port list alone printed a `vlan 22` row on a switch with no VLAN 22,
          // which is why the removal used to be refused instead - the wrong fix for a real disagreement.
          if (vlanLib.vlanIsBuiltIn(id) || named[id]) vlanSet.add(id);
        }
      }
      // A switch has five VLANs before anyone configures one: the default VLAN and the four reserved Token Ring /
      // FDDI defaults, 1002-1005. They exist on the hardware, no port may belong to one, and `show vlan` prints
      // them as `act/unsup` with an empty Ports column - which is what makes `vlan 1002` being refused as
      // reserved readable rather than an arbitrary rule. The table listed VLAN 1 alone, so a factory-default
      // switch reported one VLAN where the device it imitates reports five. Only a bridge has a VLAN
      // database, so a router keeps the table it printed before (whether it should answer `show vlan` at all is
      // a separate question - a real router does not).
      const reserved = (typeof dev.isL2 === 'function' && dev.isL2()) ? vlanLib.RESERVED_VLANS : [];
      for (const r of reserved) vlanSet.add(r.id);
      const ids = Array.from(vlanSet).filter(function (id) { return Number.isFinite(id) && id >= 1; })
        .sort(function (a, b) { return a - b; });
      out.push(vlanLine(VLAN_COLUMNS.map(function (c) { return c.head; })));
      out.push(vlanRule());
      for (const id of ids) {
        // The reserved rows sort into place by id, as they do on the device: a VLAN 2000 configured by hand sits
        // after 1005, not before it.
        const fixed = reserved.filter(function (r) { return r.id === id; })[0];
        if (fixed) {
          for (const line of vlanRows([id, fixed.name, 'act/unsup', ''])) out.push(line.replace(/\s+$/, ''));
          continue;
        }
        const members = [];
        // A port is only ever a member of a VLAN if the box switches frames at all. A router's ports are
        // routed ports - `show interfaces switchport` refuses them with "is not a switchable port" - so they
        // belong to no VLAN, and a router with a switch module lists only the module's ports in this command
        // (`Router# show vlan-switch brief` -> `1 default active Fa0/2, Fa0/9, Fa0/14, Gi0/0`, Cisco, "EtherSwitch
        // Network Module"). This table used to walk every interface on every device, so a router's `show vlan`
        // printed its own routed sockets as members of VLAN 1 - a membership the hardware cannot have
        // (research/vlan-on-a-router.md).
        //
        // The same predicate guards `inactiveVlan()` on Device: a box that does not bridge has no VLAN for a
        // port to be inactive in either.
        const bridgePorts = (typeof dev.isL2 !== 'function') || dev.isL2();
        // An access EtherChannel is ONE port in this cell, named by the bundle, and its members are not
        // listed beside it. A working two-member bundle whose members are access VLAN 10 printed
        // `Fa0/2, Fa0/3` here, so the cell named the cables a frame might cross instead of the interface the
        // switch forwards on - and `show etherchannel summary` on the same box said the two cables were one
        // `Po1(SU)`. An IOU switch with `Et0/0`-`Et0/1` bundled and `switchport access vlan 10` on the members
        // prints `10 VLAN0010 active Po1` with an empty VLAN 1 cell (lkjil1224.tistory.com/70); NX-OS and
        // Arista EOS print the same (`show vlan brief` -> `1 default active Po1`), and the IOS `show
        // vlan-switch` sample in the vendor's own command reference lists `... Gi4/0, Gi4/1, Po1` - the bundle
        // named once, after the physical ports (research/show-vlan-brief-etherchannel.md).
        //
        // A member that never negotiated is not in the bundle: it forwards as an ordinary single link, so it
        // stays a port of its own, which is the rule the MAC table already applies to the same state. The
        // bundle names are appended after the physical ports, the order the `show vlan-switch` sample shows.
        const lagLib = require('./lag');
        const bundles = [];
        for (const i of (bridgePorts ? dev.interfaces.values() : [])) {
          // A trunk port is in no row: it carries the VLAN, it is not a member of it, and the vendor's
          // table lists access ports only. Emitting it in every VLAN its allowed list names made a trunk
          // read as an access member of half the database.
          if (i.vlan && i.vlan.mode === 'trunk') continue;
          const verdict = vlanLib.classifyEgress(i.vlan, id);
          if (verdict.action === 'drop') continue;
          const bundle = (typeof dev.lagFor === 'function') ? dev.lagFor(i.name) : null;
          const suspended = bundle ? lagLib.memberSuspension(dev, i.name, this.topo) : null;
          if (bundle && !suspended) {
            const bundleName = lagLib.portChannelName(bundle.id);
            if (bundles.indexOf(bundleName) === -1) bundles.push(bundleName);
            continue;
          }
          members.push(i.name);
        }
        for (const b of bundles) members.push(b);
        const name = (named[id] && named[id].name)
          || (id === 1 ? 'default' : 'VLAN' + String(id).padStart(4, '0'));
        out.push.apply(out, vlanRows([id, name, 'active', members]));
      }
      // `brief` is the subset: the vendor's syntax description says it prints "only a single line for each
      // VLAN", so the media table and the two trailing sections belong to the full view alone. A console that
      // printed them for both words would make the two commands differ in name only.
      if (!(tokens.length > 1 && String(tokens[1]).toLowerCase() === 'brief')) {
        out.push('');
        out.push(vlanMediaLine(VLAN_MEDIA_COLUMNS.map(function (c) { return c.head; })));
        out.push(vlanMediaRule());
        for (const id of ids) out.push(vlanMediaLine(vlanMediaCells(id)));
        out.push('');
        out.push(VLAN_RSPAN_HEADING);
        out.push(VLAN_SECTION_RULE);
        out.push('');
        out.push(VLAN_PVLAN_HEADER);
        out.push(VLAN_PVLAN_RULE);
      }
    } else if (what === 'spanning-tree') {
      if (tokens.length > 1) {
        return showNoTail('show spanning-tree', tokens.slice(1), 'this device\'s tree is reported',
          'the Interface column names the port each row is about');
      }
      // `dev.stp` is written by whichever Simulator computed it last, and every HTTP request builds its own - so a
      // console asked at instant 25000 could print the tree from an earlier pass at Infinity and call a port that is
      // still listening "forwarding" (#1335). The attached simulator recomputes for the instant it was given.
      if (this.sim && typeof this.sim.recomputeStp === 'function') this.sim.recomputeStp();
      const st = dev.stp || { states: {}, roles: {}, blocked: new Set(), costs: {} };
      // The rows run in **port order**, not in character order. This table sorted its keys as strings, so a box
      // with ten or more ports printed `Gi1/0/1, Gi1/0/10, Gi1/0/11, Gi1/0/12, Gi1/0/2, ...` - an order no
      // capture shows. Two live transcripts disagree with it and agree with each other: a stack member's
      // `#sh spanning-tree vlan 10` lists `Gi1/0/4, Gi1/0/5, Gi1/0/6, Gi1/0/9, Gi1/0/10, Gi1/0/11, Gi1/0/13 ...`
      // with `Prio.Nbr` 128.9 / 128.10 / 128.11 beside them (community.spiceworks.com/t/
      // dhcp-suddenly-fails-on-specific-vlan-and-specific-ports/795152, post of 30 Mar 2021), and a C9300
      // stack's `show spanning-tree` runs `Gi1/0/1, Gi1/0/2, Gi1/0/6, Gi1/0/8, Gi1/0/10, Gi1/0/11, Gi1/0/13 ...`
      // (community.cisco.com/t5/switching/td-p/4852991, SW-050) - where a string sort would have put 10, 11, 13,
      // 15, 17, 2, 20, 22 before `Gi1/0/6`. A box walks its port list, and the port list is numbered.
      //
      // A bundle row is unaffected by this: the sort is still on the internal key (`lag-1`), which lands after
      // every interface name, and `Po1` is printed last as it always was. No capture in hand shows a whole
      // `show spanning-tree` table with a bundle row in it, so that position is recorded as inferred rather than
      // settled (research/show-spanning-tree-port-order.md).
      //
      // What is left unsettled is the order *between* two kinds of port (`Fa0/1` before or after `Gi1/0/1`): a
      // box uses the platform's interface index, which is hardware-dependent, so the type word still breaks the
      // tie the way this table always did - research/show-spanning-tree-port-order.md.
      const names = Object.keys(st.states || {}).sort(function (a, b) {
        return String(a).localeCompare(String(b), undefined, { numeric: true });
      });
      const stpLib = require('./stp');
      const mine = (dev.config && dev.config.stpPriority !== null && dev.config.stpPriority !== undefined)
        ? dev.config.stpPriority : stpLib.STP_DEFAULT_PRIORITY;
      // A box that is not a bridge does not run spanning tree, and saying "no election has run" about it implies it
      // would be in one: a router answered `show spanning-tree` with a root it had never looked for (#1399).
      // `isL2()` is the predicate `computeStp()` uses to decide what may be a bridge at all, so it is the one this
      // report must ask. A router answers false: it never joins an election, so no sentence here may imply it did.
      // The sentence is the box's, not ours: an IOS/IOS XE router asked for a tree answers exactly this line and
      // nothing else - `No spanning tree instance exists.` - so the console prints the words an operator would see
      // on the hardware instead of the explanation this file used to write
      // (`research/stp-no-instance-wording.md`).
      const bridgesAtAll = (typeof dev.isL2 !== 'function') || dev.isL2();
      if (!bridgesAtAll) {
        out.push('No spanning tree instance exists.');
        return out;
      }
      out.push('Spanning tree enabled protocol ieee');
      // The bridge priority decides the election, so a tree report that omits it cannot explain itself.
      // A root with no identity is not a root: `runStp()` used to answer one for a topology with no bridges, and
      // `String(undefined)` is what came out (#1399). Two things are checked, so neither can print it again.
      const rootRes = (this.sim && this.sim.stpResult && this.sim.stpResult.root &&
        this.sim.stpResult.root.key !== undefined && this.sim.stpResult.root.key !== null)
        ? this.sim.stpResult.root : null;
      if (rootRes) {
        const rootDev = this.topo ? this.topo.getDevice(rootRes.key) : null;
        // A device's `name` is its catalogue label ("Aruba CX 6000 24G 4SFP+"), which names the model
        // three switches share, so a root report built on it named nothing. Hostname, else the id the
        // lab uses.
        const rootName = rootDev ? (rootDev.config.hostname || rootDev.id) : String(rootRes.key);
        out.push('  Bridge priority ' + mine + (rootRes.key === dev.id ? ' (this bridge is the root)' : '') +
          ', root bridge ' + rootName + ' priority ' + rootRes.priority);
      } else {
        out.push('  Bridge priority ' + mine + ', root bridge not measured (no election has run)');
      }
      if (!names.length) {
        // With nothing having run, "no ports are bridging" is a claim the command cannot make - the same
        // distinction `show interfaces` makes for its counters (#1252). Both answers used to be the same
        // sentence, so a lab that had never been simulated reported itself as loop-free (#1261).
        out.push(this.sim
          ? '  No ports are bridging: this device is not part of an L2 loop.'
          : '  Not measured (no simulation run): nothing has computed the spanning tree.');
      } else {
        // The Port column names a bundle the way every other table cell does. `Simulator` keys the tree by the
        // internal logical port name `lag-N` - one port for the whole bundle, which is the right model - and this
        // table printed that key as if it were a port: a switch with an EtherChannel answered `show spanning-tree`
        // with `lag-1`, a label no device prints. A Cisco summary table names the bundle `Po1` in the Interface
        // column (`Po1 Root FWD 100000 128.65 P2p`, C2950; `Po1 Desg FWD 10000 128.3433 P2p`, Catalyst 9600;
        // `Po1 Desg FWD 20000 128.833 P2p`, Catalyst troubleshooting guide) and spells it `Port-channel1` only
        // where the name is the subject of a sentence (`Port 27 (Port-channel1) of VLAN0001 is root forwarding`).
        // `lagLib.portChannelName()` is the one function that names a bundle in a cell - the MAC table and
        // `show etherchannel summary` already take their `Po1` from it - so this view cannot learn a third
        // spelling. research/stp-port-channel-name.md has the captures and the half still open.
        const lagLib = require('./lag');
        const portLabel = function (name) {
          const m = /^lag-(\d+)$/.exec(String(name));
          return m ? lagLib.portChannelName(m[1]) : String(name);
        };
        // The two cells are the device's abbreviations, not its detail-view sentences: a box's table prints
        // `Fa0/16  Desg FWD 19  128.18  P2p` and keeps `designated forwarding` for `show spanning-tree detail`,
        // where the port is the subject of a sentence. `stpRoleCell`/`stpStateCell` hold the mapping, so the
        // console cannot learn a second spelling, and the payload's sentence (`stpPortText`) stays the words a
        // tooltip quotes. research/stp-port-table-role-and-sts.md.
        // The header, the rule and the row widths are one capture's, character for character: a
        // Catalyst's table reads
        //   Interface           Role Sts Cost      Prio.Nbr Type
        //   ------------------- ---- --- --------- -------- --------------------------------
        //   Gi0/2               Desg FWD 4         128.3    Shr
        // (ntc-templates, tests/cisco_ios/show_spanning-tree/cisco_ios_show_spanning_tree.raw - a
        // machine-recorded session, so the spacing survived; the same header is in the Catalyst 9300 17.12
        // command reference's sample). The first column is `Interface`, not `Port`, and the Cost cell is
        // the short path-cost number the election charged (1 Gb = 4 in the capture, 100 Mb = 19 on the
        // Pearson `show spanning-tree vlan 10` rows). It is read from `computeStp()`'s own per-port record
        // rather than derived again here, so the table and the tree cannot disagree. `Prio.Nbr` and `Type`
        // are the two columns still open: the port number is the platform's interface index (that capture
        // runs Gi0/2 -> 128.3, which no name derivation reproduces) and Type needs portfast and duplex
        // detection this model does not run. research/stp-port-table-cost-column.md.
        out.push(STP_TABLE_HEADER);
        out.push(STP_TABLE_RULE);
        // A cell that fills its field keeps the space the field would have added - `tableCell()`'s rule, shared
        // with `show power inline` - so a long port name pushes the row instead of running into the next cell.
        const cell = tableCell;
        for (const n of names) {
          const cost = (st.costs && st.costs[n] !== undefined && st.costs[n] !== null) ? st.costs[n] : null;
          out.push(cell(portLabel(n), STP_TABLE_WIDTHS.iface) +
            cell(stpLib.stpRoleCell((st.roles || {})[n] || '-'), STP_TABLE_WIDTHS.role) +
            cell(stpLib.stpStateCell(st.states[n]), STP_TABLE_WIDTHS.sts) +
            (cost === null ? '-' : String(cost)));
        }
      }
    } else if (what === 'etherchannel') {
      // `show etherchannel <anything>` printed the summary whatever was asked for (#1403).
      //
      // A channel-group number in front is not an extra word: the vendor's grammar is
      // `show etherchannel [channel-group-number | {detail | port | port-channel | protocol | summary}]`, and
      // every command reference prints `show etherchannel 1 summary`. The console refused it as though the
      // number were a typo, which told an operator to read a table they had just asked to narrow. The number
      // filters the row; it does not filter the two count lines above it, which stay the device's totals - a
      // two-group box answers `show etherchannel 2 summary` with `Number of channel-groups in use: 2` and one
      // row (research/show-etherchannel-group-summary.md).
      let groupFilter = null;
      let rest = tokens.slice(1);
      if (rest.length && /^\d+$/.test(String(rest[0]))) {
        groupFilter = String(Number(rest[0]));
        rest = rest.slice(1);
      }
      {
        // One of the six views is here, the other five are refused by name (ETHERCHANNEL_VIEW_KEYWORDS).
        // A word is checked against the view list before the typo list, because `detail` is not a typo: it is
        // a real view with real content, and the operator should be told which of the two it is.
        const named = this._showAliasFrom || 'show etherchannel';
        for (const t of rest) {
          const w = String(t).toLowerCase();
          if (ETHERCHANNEL_VIEW_KEYWORDS[w]) {
            const shownWord = rest.length === 1 ? w : rest.join(' ');
            return ['% `' + named + ' ' + shownWord + '` is a view this console does not have: ' +
              ETHERCHANNEL_VIEW_KEYWORDS[w]];
          }
        }
        const known = { summary: 1, brief: 1 };
        const extra = rest.filter(function (t) { return !known[String(t).toLowerCase()]; });
        if (extra.length) {
          return showNoTail(named, extra,
            'the whole summary is printed - name a group number to narrow it',
            'e.g. `' + named + ' 1 summary`');
        }
      }
      const lags = dev.config.lags || {};
      // Bundle ids are numbers and a technician reads that column as a list; `sort()` on the keys gave
      // `10, 100, 2`. `show access-lists` already sorts with a numeric comparator (#1510).
      const ids = Object.keys(lags).sort(function (a, b) { return Number(a) - Number(b); });
      // Which rows the table keeps. The counts below still describe the box, not this filter: a group number
      // that matches nothing leaves the furniture standing with the device's own totals over an empty table,
      // the same shape a box with no groups prints (research/etherchannel-group-summary.md).
      const shownIds = groupFilter === null ? ids
        : ids.filter(function (id) { return String(Number(id)) === groupFilter; });
      {
        const lagLib = require('./lag');
        // The key comes before the table, and the two counts after it, because a summary without them is a
        // table of numbers with no legend and no total (#1620).
        for (const line of ETHERCHANNEL_FLAGS) out.push(line);
        // Both counts are the number of groups: this model builds one aggregator per port-channel, so the two
        // figures cannot differ here - on a box they can, when an aggregator outlives the group that made it.
        const countsLabel = 'Number of channel-groups in use: ';
        out.push(countsLabel + ids.length);
        out.push(pad('Number of aggregators:', countsLabel.length) + ids.length);
        // One blank line between the counts and the header. Both captures print it - the Catalyst one and the
        // SD-WAN one - so it is the device's furniture, not spacing this console chose.
        out.push('');
        // A box with no groups prints the key, two zeros, the header and the rule, and stops: the furniture
        // is not part of the answer that has nothing in it. This console used to answer
        // `% No link aggregation groups configured` - a sentence no IOS prints - which hid the view behind an
        // error and disagreed with a real empty box (research/etherchannel-summary-layout.md). Cisco's own
        // errdisable recovery document opens its port-channel example with exactly this empty table
        // (cat6k# show etherchannel summary, both counts 0, no rows), as does the community transcript
        // quoted in the note.
        out.push(ETHERCHANNEL_HEADER);
        out.push(ETHERCHANNEL_RULE);
        for (const id of shownIds) {
          const l = lags[id] || {};
          // Where each member stands comes from one rule, shared with the bundle's own row in
          // `show ip interface brief`: a bundle is up when at least one member is really in it.
          const members = this._lagMemberStates(dev, l);
          const raw = members.raw;
          const why = members.why;
          const suspended = members.suspended;
          const live = members.live;
          const standby = members.standby;
          const isLacp = lagLib.cliMode(l.mode) !== 'on';
          const shown = raw.map(function (m) {
            if (suspended[m]) return m + '(I)';
            if (live.indexOf(m) !== -1) return m + '(P)';
            if (standby.indexOf(m) !== -1) return m + (isLacp ? '(H)' : '(s)');
            return m + '(D)';
          });
          // The Port-channel cell carries the bundle's own flags, which say what the member list cannot: S is a
          // Layer2 bundle (R would be Layer3, which this model does not build) and U is a bundle in use, D one
          // with no member that can carry - the state the `bundle N is down` sentence below describes.
          const bundleFlags = 'S' + (live.length ? 'U' : 'D');
          // The column is the protocol. The *mode* is not in it: `LACP (active)` is a string no box prints, and
          // `Static` for `mode on` named a protocol that is not running - the operator chose no negotiation, and
          // the box shows that as `-`. The mode is still readable, in `show running-config`, where a box keeps
          // it, and in the `channel-group ... mode ...` line that put the port here (#1620).
          const proto = lagLib.cliMode(l.mode) === 'on' ? '-' : 'LACP';
          out.push(pad(id, ETHERCHANNEL_COLUMNS.group) +
            pad(lagLib.portChannelName(id) + '(' + bundleFlags + ')', ETHERCHANNEL_COLUMNS['port-channel']) +
            pad(proto, ETHERCHANNEL_COLUMNS.protocol) + shown.join(' '));
          // Why a member is not carrying, in the same words `show interfaces` uses, and what that means for
          // the bundle as a whole.
          for (const m of raw) {
            if (suspended[m]) {
              // The port is not lost, and saying "traffic is dropped" here would send an operator looking for
              // a cable fault that is not there.
              out.push('  ' + pad(m, 10) + 'is stand-alone ' + why[m].replace('(stand-alone: ', '(') +
                ' - the port still carries traffic, as a single link rather than as a member of Po' + id);
            } else if (standby.indexOf(m) !== -1) {
              out.push('  ' + pad(m, 10) + 'hot-standby: the bundle already holds ' + lagLib.MAX_ACTIVE_LINKS +
                ' active links');
            } else if (live.indexOf(m) === -1) {
              out.push('  ' + pad(m, 10) + 'not bundled ' + (why[m] || '(cannot carry a frame)'));
            }
          }
          // A bundle of one is not a bundle. The shortfall used to be a warning on every correct
          // `channel-group` line, which was noise; the standing view of the group is the right place for it,
          // and the only place that still reports it.
          if (raw.length === 1) {
            out.push('  group ' + id + ' has 1 member: a bundle needs at least 2 ports');
          }
          if (!live.length && raw.length) {
            // An empty bundle has three different answers, and only one of them is "traffic is dropped": a
            // stand-alone member went on forwarding on its own, so a bundle of stand-alone members still
            // carries traffic - as two single links - while a bundle of dead members carries nothing.
            const carrying = raw.filter(function (m) { return !!suspended[m]; });
            if (carrying.length === raw.length) {
              out.push('  bundle ' + id + ' is down: no member joined it (each one carries traffic as a single link)');
            } else if (carrying.length) {
              out.push('  bundle ' + id + ' is down: no member is in it (' + carrying.join(', ') +
                ' still carry traffic as single links)');
            } else {
              out.push('  bundle ' + id + ' is down: no member can carry a frame (traffic is dropped)');
            }
          } else if (live.length < raw.length - standby.length) {
            out.push('  bundle ' + id + ' is running on ' + live.length + ' of ' + (raw.length - standby.length) +
              ' members: ' + live.join(', '));
          }
          if (standby.length) {
            // Not a degradation: a bundle that holds its eight active links and parks the rest is the state the
            // vendor's own chapter describes, and the parked links take over when one fails.
            out.push('  bundle ' + id + ' carries ' + live.length + ' active links; ' + standby.join(', ') +
              (isLacp
                ? ' hot-standby (one takes over if an active link fails)'
                : ' not in the channel: a static bundle carries at most ' + lagLib.MAX_ACTIVE_LINKS + ' links'));
          }
        }
      }
    } else if (what === 'arp') {
      // No `show arp <address>`: the cache is listed whole, and asked for one neighbour it used to answer with all
      // of them, which reads as "that address is in the cache" (#1403).
      if (tokens.length > 1) {
        return showNoTail('show arp', tokens.slice(1), 'the whole cache is listed',
          'the Address column is the neighbour');
      }
      // The Interface column used to be a header over nothing - every row stopped at the MAC - so the one
      // table that tells you which port a neighbour is on could not tell you (#1253). It also presented
      // every entry as a live neighbour: an entry learned on a port that has since gone down is a stale
      // cache entry, not evidence that the address is still reachable, and that is exactly the state you
      // are in when you run this command.
      // Six columns, because that is the table: the vendor's own field list under a `show arp` sample names
      // Protocol, Address, Age (min), Hardware Addr, **Type**, Interface (Cisco IOS IP Addressing Services
      // Command Reference, `show ip arp`: "Type | ARPA | Type of encapsulation: ARPA-Ethernet, SNAP-RFC 1042,
      // SAP-IEEE 802.3"). The Type column was missing here, so a reader comparing this table against a box's
      // found a line one field short and could not tell an Ethernet binding from an encapsulated one.
      // ARPA is the only value this model can honestly print: SNAP and SAP are 802.3/RFC 1042 encapsulation on
      // non-Ethernet media (Token Ring, FDDI), and the catalogue carries no such port - the ARP here is IPv4
      // over 802.3 Ethernet, which is what ARPA names (research/show-arp-type-column.md).
      out.push(pad('Protocol', 10) + pad('Address', 17) + pad('Age (min)', 11) +
        pad('Hardware Addr', 18) + pad('Type', 8) + 'Interface');
      // Rows are the rows at the instant this session is asking about: a neighbour silent for longer than
      // ARP_AGE_MS is gone, and the Age column counts the minutes since it was heard. Until this the column was a
      // header over a hard-coded '-' on every row, on the grounds that the simulator had steps and not minutes -
      // which stopped being true when convergence gave the model an instant in milliseconds (#1397).
      const nowMs = (this.sim && Number.isFinite(this.sim.runAtMs)) ? this.sim.runAtMs : null;
      // The device's own rows, kept: the table below is formatted from them, and a contested address is a
      // property of the row rather than of the four strings it prints as.
      const deviceRows = dev.arpRows(this.topo, nowMs);
      const rows = [];
      for (const r of deviceRows) {
        const ip = r.ip, mac = r.mac;
        // The reason travels with the status here too: "down" alone sends you looking for a cable
        // when the cable is fine and the far port is shut (#1253).
        let note = r.port === '-' ? '-' : r.port + (r.note ? ' ' + r.note : '');
        // Minutes, or '-' for an entry nothing dated: a device prints '-' for what it cannot age, and so does
        // this one (#1397).
        const age = (r.age === null || r.age === undefined) ? '-' : String(r.age);
        // Dotted, because that is how the device writes a hardware address in this table: the sample in
        // Cisco's ARP guide is `001b.53e1.7201`, never a colon-separated one. The rows are formatted from the
        // engine's own values, so the table cannot disagree with the engine about who holds the address.
        rows.push([ip, net.formatMac(mac), age, note]);
      }
      // The box's own addresses are entries in this table too, and the vendor's field list says so where a reader
      // would look for it: Age (min) is "Age, in minutes, of the cache entry; a hyphen (-) means the address is
      // local". A router prints one row per interface that holds an IPv4 address, with the interface's own MAC and
      // its name in the Interface column - a Cisco TAC ARP FAQ shows `Internet 10.2.2.1 - 30e4.dbb7.7e02 ARPA
      // GigabitEthernet0/0/2` above the neighbour the article is about, and a Catalyst 2960-CX transcript shows
      // `Internet 192.168.2.1 - d42c.4461.e340 ARPA Vlan1` above the PC it serves. This table held only what the
      // box had *heard*, so the address configured on the box was absent from the box's own cache: an operator
      // looking for their gateway, or checking that the right address is on the port, found nothing at all
      // (research/show-arp-local-address.md).
      //
      // A host is not given these rows: an end station's ARP cache holds its neighbours, not itself, and `isHost()`
      // is the predicate the data plane already uses to tell the two apart. `i.mac` is set on every port this model
      // builds, subinterfaces borrowing their parent's (device.js `addSubinterface`), so an address with no hardware
      // address beside it cannot occur - the guard is there so a hand-built device cannot print `null` in that
      // column.
      if (typeof dev.isHost !== 'function' || !dev.isHost()) {
        const held = new Set(rows.map(function (r) { return r[0]; }));
        for (const i of dev.interfaces.values()) {
          if (!i.ip || !i.mac || held.has(i.ip)) continue;
          rows.push([i.ip, net.formatMac(i.mac), '-', i.name]);
          held.add(i.ip);
        }
        // An address a VRRP group holds is the box's own too, and it is the last fact this table was
        // missing about the box itself. The elected master claims the group's IPs (device.js claimVrrp()),
        // and macForIp() puts the group's virtual MAC on every reply for one, so the row is the claim
        // printed rather than a second rule. Cisco checks a first-hop group by reading exactly this row -
        // 'Internet 10.2.0.20 - 0000.0c07.ac01 ARPA Ethernet0/2' beside the group's virtual MAC (HSRP
        // guide 9234) - and a VRRP sample shows the same shape with 0000.5e00.01xx
        // (research/show-arp-vrrp-virtual-address.md). An address that is also an interface address is
        // already printed above and is not repeated: there the address is the port's, and VRRP
        // substitutes a MAC only where it is not (which is what the VRRS 'mac-address' plug-in exists to
        // do by hand). A backup gets no row: what a real backup holds is learned from the master's
        // gratuitous ARP, and this model does not install addresses from an unsolicited ARP, so it prints
        // nothing rather than a binding it never received.
        for (const claim of (Array.isArray(dev.vrrpClaims) ? dev.vrrpClaims : [])) {
          const claimIface = claim.iface ? dev.interfaces.get(claim.iface) : null;
          if (!claimIface) continue;
          for (const vip of (claim.ips || [])) {
            if (!vip || held.has(vip)) continue;
            rows.push([vip, net.formatMac(claim.mac || claimIface.mac), '-', claimIface.name]);
            held.add(vip);
          }
        }
      }
      rows.sort(function (a, b) { return String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true }); });
      for (const r of rows) {
        // Type sits between the hardware address and the interface, as the vendor table orders them.
        out.push(pad('Internet', 10) + pad(r[0], 17) + pad(r[2], 11) + pad(r[1], 18) +
          pad('ARPA', 8) + r[3]);
      }
      // An address two boxes answer for is the one row this table must not print like all the others: the binding
      // shown is simply the reply that arrived last, so traffic to it goes wherever that reply pointed - which is
      // what makes the same ping pass and fail with nothing changed (#1473). Nothing here invents a conflict: it
      // is only reported when two different hardware addresses really did answer on the same port.
      for (const r of deviceRows) {
        const clash = r.conflict;
        if (!clash || !clash.macs || clash.macs.length < 2) continue;
        out.push('');
        out.push(r.ip + ' is claimed by ' + clash.macs.length + ' hardware addresses on ' +
          (clash.port || 'this segment') + ': ' + clash.macs.map(function (m) { return net.formatMac(m); }).join(', '));
        out.push('  this row shows the one that answered last; traffic to ' + r.ip +
          ' goes to whichever answers next');
      }
    } else if (what === 'mac' && tokens[1] === 'address-table') {
      // Rows are the rows at the instant this session is asking about: a dynamic entry that has been silent for
      // longer than MAC_AGE_MS is gone, and the Age column says how long ago it was heard. Before this the table
      // never aged anything and the row carried a note explaining that it might be stale (#1395).
      const nowMs = (this.sim && Number.isFinite(this.sim.runAtMs)) ? this.sim.runAtMs : null;
      // The rest of the line is a filter, and it used to be dropped on the floor: `show mac address-table
      // interface Port 1` answered with every entry on the box, which reads as "this port has all of them".
      // An argument that is accepted and not applied is the same defect as a config command that is accepted
      // and inert (#1401), so either it filters or it is refused - never ignored.
      const tail = tokens.slice(2);
      let only = null;
      if (tail.length) {
        const word = String(tail[0]).toLowerCase();
        if (word !== 'interface' && word !== 'int') {
          return ['% show mac address-table does not take "' + tail.join(' ') +
            '": use `show mac address-table interface <port>` for one port'];
        }
        const typed = tail.slice(1).join(' ');
        if (!typed) return ['% interface needs a port: show mac address-table interface <port>'];
        const name = ifaceName.resolvePortName(dev, typed);
        if (!name) return ['% No interface ' + typed + ' on ' + (dev.name || 'this device')];
        only = name;
      }
      // The table's surround, as the device prints it: a centred title, a rule under it, the column headings and
      // their own dash underline, then one total at the end. This table used to start at the column headings and
      // stop at the last row, so the two things a printed table carries were missing: what it is, and how many
      // rows it is. On a filtered table the total is the only thing that says the count is the filter's, not the
      // box's - and an operator checking a port against a change record reads exactly that number (#1395).
      // The underline is the device's, not the heading's: four, eleven, eight and five dashes for Vlan, Mac
      // Address, Type and Ports, on a switch that prints 14-character dotted MACs above that 11-dash rule - the
      // two widths are not the same field on real hardware, so copying the heading lengths would look tidier and
      // be less true. `Age` has no counterpart in the vendor view (it is this model's column), so it is the one
      // rule mark here that is the heading's own length.
      const columns = [['Vlan', 8, 4], ['Mac Address', 20, 11], ['Type', 12, 8], ['Age', 8, 3], ['Ports', 0, 5]];
      out.push('          Mac Address Table');
      out.push('-------------------------------------------');
      out.push('');
      out.push(columns.map(function (c) { return pad(c[0], c[1]); }).join(''));
      out.push(columns.map(function (c) { return pad('-'.repeat(c[2]), c[1]); }).join(''));
      // The rows the box has learned come from the engine, so the payload the browser reads and this table cannot
      // disagree (#1327). The reserved block above them does not come from the engine because it is not state: no
      // frame ever taught the box those addresses and nothing here can forget them. It is a property of being a
      // switch, which is why a PC answering this command (this console answers every command everywhere) still
      // gets an empty table, and why a filtered view gets none of them - they are on the CPU, not on a port.
      const reserved = (only || !(dev.category === 'switch' || dev.category === 'l3-switch'))
        ? [] : RESERVED_MAC_TABLE_ROWS;
      for (const mac of reserved) {
        out.push(macVlanCell('All') + pad(mac, 20) + pad('STATIC', 12) + pad('-', 8) + 'CPU');
      }
      let rows = dev.macRows(this.topo, nowMs);
      // The filter matches the port the table names *and* the member a bundled frame arrived on: a real box
      // learned the address on the port-channel, so `interface Po1` is the filter that finds it - but `Fa0/2`
      // is the cable the frame came in on, and refusing it would answer a question the box can answer. The
      // port-channel spelling does not resolve as a port name here yet (research/mac-table-port-channel-name.md).
      if (only) rows = rows.filter(function (r) { return r.port === only || r.learnedOn === only; });
      if (only && !rows.length) {
        // An empty table for a filter is a fact about that port, and it has to say so: a bare header reads as
        // "the switch knows nothing", which is a different claim about the whole box.
        out.push('(no entry learned on ' + only + ')');
      }
      for (const r of rows) {
        // Where the entry points, and whether that is still somewhere a frame for this VLAN can go. A MAC learned
        // before its port was shut or moved says why it cannot be the way to that address (#1255).
        const age = (r.age === null || r.age === undefined) ? '-' : (r.age + 's');
        out.push(macVlanCell(r.vlan) + pad(net.formatMac(r.mac), 20) + pad('DYNAMIC', 12) + pad(age, 8) +
          r.port + (r.note ? ' ' + r.note : ''));
      }
      // The count is of the rows this view just printed - which is what the device's sentence counts: "for this
      // criterion" is the filter the operator typed, so a filtered view totals that port, not the box (a 9200
      // transcript shows `Total ...: 1` under a one-row filter on a switch holding 22 entries). An empty view
      // prints 0 rather than losing the line, which would read as a command that did not finish.
      // The reserved rows are counted, because the device counts them: the 2960 paste holds twenty CPU rows
      // and one learned address and closes at 21, and one static entry added by hand makes it 22. They are also
      // why an untouched switch no longer prints `0` (research/mac-table-reserved-rows.md).
      out.push('Total Mac Addresses for this criterion: ' + (rows.length + reserved.length));
    } else if (what === 'interfaces' || what === 'interface') {
      // `show interfaces Fa0/1` printed every port on the box: the answer to a question about one socket was
      // the whole switch, and on a 48-port model the socket asked about could be eight screens down. The name
      // is resolved by the same table `interface Fa0/1` uses, so every spelling works, and a name that
      // matches nothing is refused by name rather than answered with a list.
      //
      // The name is the **whole rest of the line**, which is the rule `interface` has used since #1230: Ubiquiti
      // calls its ports "Port 1" and its cages "SFP+ 1", so taking `tokens[1]` read the name "Port" and answered
      // `% No interface Port` about a port that exists (#1401). One door was fixed and the other left behind.
      const wanted = tokens.length > 1 ? tokens.slice(1).join(' ') : null;
      // A console or aux socket is a line, not an interface: a box prints no block for one, because `show
      // interfaces` reports interfaces and the console is configured under `line con 0`. It is filtered here rather
      // than at the by-name door so that both the listing and a name that points at it answer the same way -
      // research/console-is-a-line-not-an-interface.md.
      let shown = [...dev.interfaces.values()].filter(function (i) { return !isConsoleLine(i); });
      if (wanted) {
        const name = ifaceName.resolvePortName(dev, wanted);
        const one = name ? dev.interfaces.get(name) : null;
        if (!one) {
          // A real IOS view this console does not implement is not a misspelt port (#1443). `show interfaces
          // switchport`, `show interfaces status`, `show interfaces counters` and ten more answered
          // `% No interface switchport on <box>`, which is the same sentence a typo gets - so an operator who typed
          // a command they know from IOS was told a port did not exist, and went looking for a typo in a port name
          // instead of learning the view is not here. A word that is a keyword is reported as one.
          // Note it is checked *after* the port table: a device with a port genuinely called "status" gets its port.
          // The whole phrase is looked up first, then its first word: `show interfaces counters` was reported as a
          // view, and `show interfaces counters errors` - the same view with the word a reader adds after it - fell
          // through to `% No interface counters errors on <box>`, which claims a port is missing and sends the reader
          // looking for a typo. A phrase that starts with a view word is a question about that view (#1449).
          const typed = String(wanted).trim();
          const firstWord = typed.split(/\s+/)[0].toLowerCase();
          const keyword = INTERFACES_VIEW_KEYWORDS[typed.toLowerCase()] || INTERFACES_VIEW_KEYWORDS[firstWord];
          if (keyword) {
            return ['% `' + typed + '` is a view, not a port: this console has no `show interfaces ' + typed +
              '`. ' + keyword];
          }
          // ...and the port-first spelling of the same question (#1834): `show interfaces Fa0/1 counters` is
          // `show interfaces counters` with the port named, and it got the sentence a misspelt port name gets.
          const afterPort = viewAfterPort(dev, typed);
          if (afterPort) return [afterPort];
          // `show interfaces ?` is how a reader asks what can go here, and `% No interface ? on <box>` is the
          // worst possible answer to that question.
          if (String(wanted).trim() === '?' || /^help$/i.test(String(wanted).trim())) {
            return ['% Usage: `show interfaces` lists every port; `show interfaces <port>` prints one. ' +
              'There is no keyword form here - `help` lists the commands this console has, ' +
              '`show vlan` prints VLAN membership and `show lldp neighbors` prints what is plugged in.'];
          }
          // A bundle is an interface a box prints a block for - `show interfaces Port-channel1` is answered
          // with `Port-channel1 is up, line protocol is up` and a `Members in this channel:` line
          // (research/port-channel-show-interfaces.md) - and this console prints none. But it is not a port
          // that is missing: the name comes straight off `show etherchannel summary` (`Po1`) or off the
          // `Port-channel1` row of `show ip interface brief`, and both got the sentence a typo gets, so the
          // reader went looking for a spelling mistake in a name the session had just printed. Say what the
          // thing is, and name the view that does print it.
          const bundleId = require('./lag').bundleIdFromName(typed);
          if (bundleId !== null && dev.config && dev.config.lags && dev.config.lags[String(bundleId)]) {
            return ['% ' + require('./lag').portChannelIfaceName(bundleId) + ' is an EtherChannel bundle: ' +
              'this console has no block for one. `show etherchannel summary` lists the bundle and the ports ' +
              'that carry it.'];
          }
          // Ambiguity is refused rather than guessed, exactly as `interface` refuses it: the panel is the
          // only authority on which socket a spelling means.
          const ambiguous = portKey(wanted) !== null && [...dev.interfaces.keys()]
            .filter(function (n) { return portKey(n) === portKey(wanted); }).length > 1;
          return ['% No interface ' + wanted + ' on ' + (dev.name || 'this device') +
            (ambiguous ? ' (that spelling is ambiguous: more than one port folds onto it)' : '')];
        }
        // ...and a console socket asked for by name is answered in words, not with a block: the block used to give
        // an RS-232 line a MAC address, a 1 Gb/s link rate and a duplex, none of which a console port has.
        if (isConsoleLine(one)) return [consoleIsALine(one.name)];
        shown = [one];
      }
      // A subinterface is an interface: it can hold an address, carry traffic and be configured, so it has to
      // be in the listing. It was omitted, and `show interfaces` printed 3 of the 4 interfaces on a router -
      // the one that was missing being the one with the address on it. Children follow their parent, which is
      // the order the blocks are read in - the walk `show ip interface brief` uses as well, so the two views
      // cannot order one list two ways (`orderWithChildren`).
      if (!wanted) shown = orderWithChildren(shown);
      for (const i of shown) {
        out.push(i.name + ' (' + i.type + ', ' + i.speed + '), MAC ' + net.formatMac(i.mac));
        // The reason travels with the status: this block used to print `status: up` directly above
        // `peer: disconnected`, which is two halves of the same output disagreeing (#1237).
        const link = dev.ifaceStatus(i, this.topo);
        out.push('  status: ' + link.status +
          (link.reason ? ' (' + link.reason + ')' : '') +
          ', protocol: ' + link.protocol +
          (i.description ? ', desc: ' + i.description : ''));
        out.push('  ip: ' + (i.ip ? i.ip + '/' + net.prefixOf(i.mask) : 'unassigned') + (i.dhcp ? ' (dhcp)' : ''));
        // The other address family, which this block said nothing about: an IPv6 address lived in config.ip6 and
        // was readable only in `show running-config` - and a SLAAC address not even there, since nobody typed it.
        // The link-local is printed with it because it is the address neighbour discovery and every RS/NS uses, and
        // it is derived from the MAC, so no view could ever have shown it (#1463).
        const v6line = this._ipv6AddressLine(i);
        if (v6line) out.push('  ' + v6line);
        // A host that asked for an address and got nothing is `unassigned` too, and that is the one case where the
        // word hides the answer: the exchange failed for a stated reason, and the reason was recorded (#1453).
        if (i.dhcp && !i.ip) {
          const mine = this._dhcpFailures().asClient.filter(function (e) { return e.iface === i.name; });
          if (mine.length) {
            const last = mine[mine.length - 1];
            out.push('  dhcp: ' + mine.length + ' request(s), no address - ' + this._dhcpFailureText(last) +
              (Number.isFinite(last.step) ? ' (step ' + last.step + ')' : ''));
          }
        }
        out.push('  peer: ' + (i.peer ? i.peer.deviceId + '/' + i.peer.iface : 'disconnected'));
        // The rate the link actually runs at, and whether anybody forced it. A forced 100 on a 1G port is
        // the answer to "why is this link slow", so it belongs in the block you read to ask (#1259).
        out.push('  ' + this._linkRateLine(i));
        // What the port does with a frame, which is the other half of "what is this socket". The switchport
        // configuration was only visible in `show vlan` (membership) and `show running-config` (the lines),
        // so the command an operator opens first said `ip: unassigned` about a port whose whole job is its
        // VLAN.
        const swLine = this._switchportLine(i);
        if (swLine) out.push('  ' + swLine);
        // What has actually crossed this socket. The simulator counted it all along, per device, so the
        // command could not answer the one question it is opened for: is traffic flowing on THIS port?
        // Counted wherever a frame is enqueued and received, including frames later dropped - a frame the
        // ACL threw away was still received (#1251).
        const counters = (this.sim && typeof this.sim.portCounters === 'function')
          ? this.sim.portCounters(dev.id, i.name) : null;
        if (counters) {
          out.push('  ' + counters.packetsIn + ' packets input, ' + counters.bytesIn + ' bytes');
          out.push('  ' + counters.packetsOut + ' packets output, ' + counters.bytesOut + ' bytes');
          // What the port threw away, next to what it carried. Two datagrams dropped for want of a route
          // used to read as a quiet port: "0 packets input" beside a ping that failed twice (#1257).
          const dropped = this._dropSummary(counters.drops);
          if (dropped) out.push('  ' + dropped);
        } else {
          // "Not measured" and "measured zero" are different answers; printing zeros without a run would
          // claim the port is idle when nothing has looked.
          out.push('  counters: not measured (no simulation run)');
        }
      }
      // Drops that never named a port ("no route to 10.0.0.99" happens before an egress is chosen) belong
      // at the end of the whole table, not invented onto whichever port happens to be printed first.
      const deviceDrops = (this.sim && typeof this.sim.dropsFor === 'function')
        ? this.sim.dropsFor(dev.id) : null;
      if (deviceDrops && deviceDrops.unported) {
        const line = this._dropSummary({ total: deviceDrops.unported, byReason: deviceDrops.byReason });
        out.push('device-wide ' + line);
      }
    } else if (what === 'running-config' || what === 'run') {
      // `show running-config interface Gi0/1` used to print the entire configuration, so the narrower question got
      // the wider answer and looked like an answer (#1403).
      if (tokens.length > 1) {
        const want = tokens.slice(1).join(' ');
        return showNoTail('show running-config', tokens.slice(1), 'the whole configuration is printed',
          /^interface|^int$/i.test(String(tokens[1])) ? 'use `show interfaces ' + tokens.slice(2).join(' ') +
            '` for one port\'s state' : 'the file is the plain `show running-config`');
      }
      out.push('! PacketForge running-config');
      out.push('hostname ' + (dev.config.hostname || dev.name));
      // One space per submode level. This is the vendor's own written rule, in the words four Cisco guides use
      // for the format of a configuration file: "Start all commands on a new line with no indentation, unless
      // the command is within a configuration submode. Indent commands within a first-level configuration
      // submode one space. Indent commands within a second-level configuration submode two spaces. Indent
      // commands within subsequent submodes accordingly." The same paragraphs finish by saying that these are
      // the rules the software itself uses to create the file - "Any configuration file generated on a Cisco
      // device complies with these rules" (research/running-config-indent.md carries the four pages and the
      // two raw device captures that show it byte for byte).
      //
      // This printer used two spaces for a line inside an `interface` stanza, a DHCP pool or a `dns zone`,
      // which is the depth of a *second*-level submode: every line of a backup copied out of here differed
      // from the same box's own file, so a diff against a real device read as a total rewrite. And the two
      // lines under `router bgp` had no indentation at all, which is the more dangerous half - at the left
      // margin `bgp router-id` and `neighbor ... remote-as` read as global commands, and a reader (or a
      // parser that trusted the columns) could not tell which stanza owned them.
      const IN_SUBMODE = ' ';
      // Five features were configurable, stored, and printed nowhere: a config saved from the device came back
      // without its routing protocol, its name servers, its AS membership or its IPv6 router-advertisement
      // policy, and restoring it produced a different device. The test that was supposed to catch this
      // ("nothing configurable is left out") only ever configured the features it already knew about.
      //
      // Each line below is the exact spelling the parser takes back, printed only when it differs from the
      // default the device already assumes, in an order that replays: the OSPF router exists before the
      // interface overrides that require it.
      // The bridge priority decides who is root, and a restore that dropped it would silently move the
      // root to whichever other switch has the lower MAC.
      if (dev.config.nat && ((dev.config.nat.rules || []).length || Object.keys(dev.config.nat.pools || {}).length)) {
        const natLib = require('./nat');
        // Pools first: a rule that names one does not parse before the pool it names exists.
        for (const name of Object.keys(dev.config.nat.pools || {}).sort()) {
          const pool = dev.config.nat.pools[name];
          out.push('ip nat pool ' + name + ' ' + pool.start + ' ' + pool.end + ' netmask ' + pool.netmask);
        }
        for (const r of (dev.config.nat.rules || [])) out.push(natLib.formatRuleLine(r));
      }
      if (dev.config.stpPriority !== null && dev.config.stpPriority !== undefined) {
        out.push('spanning-tree priority ' + dev.config.stpPriority);
      }
      for (const ns of (dev.config.dnsServers || [])) out.push('ip name-server ' + ns);
      if (dev.config.scionAs) out.push('scion ' + dev.config.scionAs);
      // IPv6 is the same hole in the other address family: `ipv6 address`, `ipv6 route` and `ipv6 gateway`
      // were all accepted, stored in config.ip6/routes6/gateway6, and printed nowhere.
      // Not when a router advertisement put it there: nobody typed this line, and it is not configuration that a
      // reader could copy to another device without pinning a gateway that should keep following its router.
      if (dev.config.gateway6 && !dev.config.gateway6Learned) out.push('ipv6 gateway ' + dev.config.gateway6);
      for (const r6 of (dev.config.routes6 || [])) {
        if (r6 && r6.dest) out.push('ipv6 route ' + r6.dest + '/' + r6.prefix + ' ' + r6.nextHop);
      }
      if (dev.config.ospf) {
        if (dev.config.ospf.routerId) out.push('ospf router-id ' + dev.config.ospf.routerId);
        if (dev.config.ospf.areaId) out.push('ospf area ' + dev.config.ospf.areaId);
      }
      if (dev.config.bgp && dev.config.bgp.as != null) {
        out.push('router bgp ' + dev.config.bgp.as);
        // Both children are `(config-router)` commands on a box, so both carry the name of the mode they
        // belong to in their first column: one space. Printed flush left they claimed to be global.
        if (dev.config.bgp.routerId) out.push(IN_SUBMODE + 'bgp router-id ' + dev.config.bgp.routerId);
        for (const n of (dev.config.bgp.neighbors || [])) {
          if (n && n.address && n.remoteAs != null) {
            out.push(IN_SUBMODE + 'neighbor ' + n.address + ' remote-as ' + n.remoteAs);
          }
        }
      }
      {
        // Router advertisements: only what differs from the defaults the device already assumes, so a
        // device that never touched `ipv6 nd` prints nothing.
        const ra = require('./ra');
        const cfg = dev.config.ra ? ra.normalizeConfig(dev.config.ra) : null;
        if (cfg && (!cfg.enabled || cfg.suppress || cfg.m || cfg.o || cfg.prefixes.length ||
            cfg.routerLifetime !== ra.DEFAULTS.routerLifetime)) {
          // `enable` is the default, so it is not a line the config owns: only the
          // two ways of switching advertising off are stored, and they are stored
          // as the commands that would reproduce this box from scratch.
          if (!cfg.enabled) out.push('ipv6 nd ra disable');
          if (cfg.suppress) out.push('ipv6 nd suppress-ra');
          if (cfg.m) out.push('ipv6 nd ra managed');
          if (cfg.o) out.push('ipv6 nd ra other-config');
          if (cfg.routerLifetime !== ra.DEFAULTS.routerLifetime) {
            out.push('ipv6 nd ra lifetime ' + cfg.routerLifetime);
          }
          for (const pref of cfg.prefixes) {
            out.push('ipv6 nd prefix ' + pref.prefix + '/' + pref.prefixLen +
              ' valid ' + pref.validLifetime + ' preferred ' + pref.preferredLifetime);
          }
        }
      }
      // Definitions before the blocks that name them. An interface line is allowed to reference an
      // object - `switchport access vlan 10`, `ip access-group 101 in` - and the parser refuses the
      // reference when the object does not exist yet: `% Access VLAN does not exist.` and
      // `% Access list 101 does not exist`. Printed after the interfaces, a saved config therefore did
      // not replay: the ACL binding was dropped outright, so a restore silently un-filtered the port.
      // Both tables are plain config-mode lines with no sub-mode, so they can go first.
      //
      // The VLAN table: the ids exist because someone typed `vlan <id> <name>`, and without these
      // lines a restored config has ports in VLAN 42 with no VLAN 42 (#1232).
      const vlans = dev.config.vlans || {};
      for (const id of Object.keys(vlans).sort(function (a, b) { return Number(a) - Number(b); })) {
        const v = vlans[id] || {};
        out.push('vlan ' + id + (v.name ? ' ' + v.name : ''));
      }
      // The access lists, for the same reason: a port's binding is printed inside its interface block.
      // The lines come out in the order the box wrote them, not the order they were typed: IOS rewrites a
      // standard list so its host entries sit on top, and it does that in the configuration file as well as in
      // `show access-lists` ("in show command output and in the configuration file, the ACEs do not necessarily
      // appear in the order in which they were entered" - Catalyst 2960-X 15.2(6)E configuration guide).
      // research/standard-ace-host-order.md.
      const allAcls = dev.config.acls || {};
      const aclOrder = require('./acl');
      for (const id of Object.keys(allAcls).sort(function (a, b) { return parseInt(a, 10) - parseInt(b, 10); })) {
        for (const slot of aclOrder.numberedEntries(allAcls[id])) {
          const e = slot.entry;
          out.push('access-list ' + id + ' ' + (e.line || e.action));
        }
      }
      for (const i of dev.interfaces.values()) {
        // A console port has no interface block on a box - its settings live under `line con 0` - so printing
        // `interface Console` wrote a stanza no Cisco running-config contains and no box could read back.
        // `line con 0` is not a mode this console has, so the honest config has nothing to say here at all.
        if (isConsoleLine(i)) continue;
        // The stanza header spells the type out, the way the box's own file does: a Catalyst prints
        // `interface FastEthernet0/6`, and a 9200's own `show running-config interface gigabitethernet1/0/1`
        // comes back headed `interface GigabitEthernet1/0/1` however the command was typed. The panel name
        // stays the key (every lookup folds onto it), so only the printed header moves - and it moves through
        // the same table `show ip interface brief` uses, so one port cannot be named two ways by two views
        // (research/running-config-interface-name.md).
        out.push('interface ' + require('./iface-name').displayName(i.name));
        if (i.description) out.push(IN_SUBMODE + 'description ' + i.description);
        // Only when forced: a config that emits `speed auto` on every port is noise, and the round trip
        // already asserts that nothing configured is left out (#1259).
        if (i.speedMbps) out.push(IN_SUBMODE + 'speed ' + i.speedMbps);
        if (i.duplex && i.duplex !== 'full') out.push(IN_SUBMODE + 'duplex ' + i.duplex);
        // A serial line's DCE claim, in the config where an operator looks for it. `clock rate` was a command that
        // took effect and left no trace in running-config, so a backup of a WAN lab did not say which end clocks the
        // line - and restoring it gave an unclocked link the validation refuses (#1483).
        if (i.clockRateBps) out.push(IN_SUBMODE + 'clock rate ' + i.clockRateBps);
        // Only a subinterface that terminates a VLAN has an encapsulation line. A port named `.5000`
        // carries no tag until one is typed, and `encapsulation dot1q null` is a line no box prints
        // (research/subinterface-number.md).
        if (i.parent && i.encapVid) out.push(IN_SUBMODE + 'encapsulation dot1q ' + i.encapVid);
        // The method is printed, not the outcome. A host that has a lease holds both the `dhcp` flag and the
        // address the lease gave it, and printing the address baked a leased value into the backup: restored
        // on another network, the host claimed a stale address and never asked for a new one. A backup has to
        // describe what was configured, or restoring it changes what the device does.
        if (i.dhcp) out.push(IN_SUBMODE + 'ip address dhcp');
        else if (i.ip) out.push(IN_SUBMODE + 'ip address ' + i.ip + ' ' + i.mask);
        if (i.vlan) {
          // The mode and the VLAN parameters are separate state, and they are printed separately. The
          // parameters used to be printed only in the mode that uses them, so a trunk staged on an access
          // port - `switchport trunk native vlan 20` before the cable is patched, which is exactly why the
          // console lets you type it - vanished from the backup and never came back.
          const spMode = i.vlan.mode === 'trunk' ? 'trunk' : 'access';
          const spAccess = Number(i.vlan.accessVlan) || 1;
          const spVoice = i.vlan.voiceVlan === null || i.vlan.voiceVlan === undefined
            ? null : Number(i.vlan.voiceVlan);
          const spNative = Number(i.vlan.nativeVlan) || 1;
          const spAllowed = i.vlan.allowedVlans;
          // An empty list is the engine's "unset", not a configuration: no command can produce it
          // (`switchport trunk allowed vlan` with no list is `% Incomplete command`), so printing it would
          // emit a line the console cannot read back - which is what `no switchport` used to leave behind.
          // Printed the way a switch prints an allowed list: ranges folded together (`1,3-1001,1006-4094`),
          // not one number per VLAN. A number-per-line backup of a trunk that removed one VLAN would be a
          // 4,090-entry wall no operator wrote and no diff would survive, and a real box does not write it
          // either - a Catalyst prints `switchport trunk allowed vlan 1-3,100`
          // (research/trunk-allowed-remove-from-all.md).
          const spAllowedText = (spAllowed === 'all' || !Array.isArray(spAllowed) || spAllowed.length === 0)
            ? null : vlanLib.formatVlanList(spAllowed);
          // The lines come out in the order a real switch writes them, not the order this file happens to
          // know them in: the VLAN parameters first, then the mode they select, then the phone-facing voice
          // line. Two Cisco-published `show running-config` samples settle it
          // (research/running-config-switchport-order.md): a voice port prints `switchport access vlan 2` /
          // `switchport mode access` / `switchport voice vlan 3`, and a trunk prints
          // `switchport trunk encapsulation dot1q` / `switchport trunk native vlan 4` / `switchport mode
          // trunk`. Where the allowed-vlan line sits between those is the one placement no sample showed,
          // so it keeps the position it already had, among the parameters.
          if (spAccess !== 1) out.push(IN_SUBMODE + 'switchport access vlan ' + spAccess);
          if (spNative !== 1) out.push(IN_SUBMODE + 'switchport trunk native vlan ' + spNative);
          if (spAllowedText !== null) out.push(IN_SUBMODE + 'switchport trunk allowed vlan ' + spAllowedText);
          if (spMode === 'trunk' || spAccess !== 1) out.push(IN_SUBMODE + 'switchport mode ' + spMode);
          if (spVoice !== null) out.push(IN_SUBMODE + 'switchport voice vlan ' + spVoice);
        }
        // An IPv6 address lives in config.ip6, not on the interface object, so a printer that walked the
        // interfaces could not have found it even in principle.
        // A SLAAC address is stored in the same place as a typed one, so this block used to print an address no
        // command produced, directly under the `ipv6 address autoconfig` line that did produce it. The config keeps
        // the request; the address is operational state (`show interfaces` reports it).
        const v6a = dev.config.ip6 && dev.config.ip6[i.name];
        if (v6a && v6a.addr && !v6a.autoconfig) out.push(IN_SUBMODE + 'ipv6 address ' + v6a.addr + '/' + v6a.prefix);
        if (i.autoconfig) out.push(IN_SUBMODE + 'ipv6 address autoconfig');
        // Per-interface OSPF overrides - the same hole one level down: `ip ospf cost`, `ip ospf area` and
        // `ip ospf passive` were stored on the interface and printed nowhere.
        if (dev.config.ospf && Array.isArray(dev.config.ospf.interfaces)) {
          const ov = dev.config.ospf.interfaces.filter(function (x) { return x && x.name === i.name; })[0];
          if (ov) {
            if (ov.cost != null) out.push(IN_SUBMODE + 'ip ospf cost ' + ov.cost);
            if (ov.area != null) out.push(IN_SUBMODE + 'ip ospf area ' + ov.area);
            // The election's first tie-break, and a line the parser takes back, so a saved device
            // comes up holding the priority it had.
            if (ov.priority != null) out.push(IN_SUBMODE + 'ip ospf priority ' + ov.priority);
            if (ov.passive) out.push(IN_SUBMODE + 'ip ospf passive');
          }
        }
        const lag = dev.lagFor ? dev.lagFor(i.name) : null;
        // Printed in the console's vocabulary, which is the only spelling the parser takes back.
        if (lag) out.push(IN_SUBMODE + 'channel-group ' + lag.id + ' mode ' + require('./lag').cliMode(lag.mode));
        // Which side of the translation this port is on. A port declared inside or outside is a fact the config
        // parser accepts, so it belongs in the block that reads it back (#1391).
        if (i.natRole === 'inside' || i.natRole === 'outside') out.push(IN_SUBMODE + 'ip nat ' + i.natRole);
        const binds = dev.aclBindings && dev.aclBindings[i.name];
        if (binds && binds.in != null) out.push(IN_SUBMODE + 'ip access-group ' + binds.in + ' in');
        if (binds && binds.out != null) out.push(IN_SUBMODE + 'ip access-group ' + binds.out + ' out');
        if (!i.enabled) out.push(IN_SUBMODE + 'shutdown');
        // A VRRP group belongs to an interface, so it is printed inside that interface's block - the
        // only place the config parser will accept it. It used to be printed nowhere at all: the
        // group existed, `show vrrp` reported it, and a config saved from the device had no trace of
        // it (#1232).
        for (const g of (dev.config.vrrp || [])) {
          if (!g || g.interface !== i.name) continue;
          for (const ip of (g.ips || [])) out.push(IN_SUBMODE + 'vrrp ' + g.vrid + ' ip ' + ip);
          if (g.priority !== undefined && g.priority !== null && g.priority !== 100) {
            out.push(IN_SUBMODE + 'vrrp ' + g.vrid + ' priority ' + g.priority);
          }
          if (g.preempt === false) out.push(IN_SUBMODE + 'no vrrp ' + g.vrid + ' preempt');
          if (g.advertSec !== undefined && g.advertSec !== null && Number(g.advertSec) !== 1) {
            out.push(IN_SUBMODE + 'vrrp ' + g.vrid + ' advertise ' + g.advertSec);
          }
          if (g.authText) out.push(IN_SUBMODE + 'vrrp ' + g.vrid + ' authentication ' + g.authText);
        }
        // Close the block the way a box closes it: a bare `!` line, the stanza separator every
        // published running-config uses between two `interface` stanzas (the 4000 Series ISR default
        // configuration prints `interface GigabitEthernet0/0/0` / `no ip address` / `negotiation auto` /
        // `!` / `interface GigabitEthernet0/0/1` ... ). `exit` is not a line any box prints in this file:
        // it closes a session, not a stanza. The block still ends, because the parser reads a global
        // command at an interface prompt as global (the documented leniency) and a following `interface`
        // line switches blocks (#1230) - so the paste lands where it did with the `exit` line there.
        // research/running-config-stanza-separator.md carries the samples and the parts left open.
        out.push('!');
      }
      // DHCP pools. A pool is a sub-mode, so each one closes with `exit` before the next begins.
      for (const pool of (dev.config.dhcpPools || [])) {
        if (!pool || !pool.name) continue;
        out.push('ip dhcp pool ' + pool.name);
        if (pool.network) out.push(IN_SUBMODE + 'network ' + pool.network + (pool.mask ? ' ' + pool.mask : ''));
        if (pool.rangeStart) out.push(IN_SUBMODE + 'range ' + pool.rangeStart + (pool.rangeEnd ? ' ' + pool.rangeEnd : ''));
        if (pool.gateway) out.push(IN_SUBMODE + 'default-router ' + pool.gateway);
        if (pool.dns) out.push(IN_SUBMODE + 'dns-server ' + pool.dns);
        for (const ex of (Array.isArray(pool.excluded) ? pool.excluded : [])) out.push(IN_SUBMODE + 'excluded-address ' + ex);
        if (typeof pool.leaseSec === 'string' && pool.leaseSec.toLowerCase() === 'infinite') {
          // The word goes back out as the word: a pool saved as seconds would have to invent a number for
          // "never", and the number it invented would be a lease that ends (#fidelity: lease infinite).
          out.push(IN_SUBMODE + 'lease infinite');
        } else if (pool.leaseSec) {
          // Seconds back to the days/hours/minutes the command takes. Only whole minutes survive the
          // round trip, which is every value the command itself can express.
          //
          // The fields are optional in IOS's syntax (`lease {days [hours [minutes]] | infinite}`), and a box
          // prints only the ones the duration needs: a 12-hour pool reads back as `lease 0 12`, a 20-minute one
          // as `lease 0 0 20`, a one-day one as `lease 1`. This printed all three every time, so a saved config
          // carried `lease 0 12 0` - a line no box produces (research/dhcp-lease-running-config-form.md).
          // Trailing zeros go; the leading ones stay, because minutes cannot be printed without the hours and
          // days that hold their place.
          const sec = Number(pool.leaseSec);
          if (Number.isFinite(sec) && sec > 0) {
            const fields = [
              Math.floor(sec / 86400),
              Math.floor((sec % 86400) / 3600),
              Math.floor((sec % 3600) / 60)
            ];
            while (fields.length > 1 && fields[fields.length - 1] === 0) fields.pop();
            // A sub-minute duration has no command that can set it (the CLI takes whole minutes only), so this
            // is reachable only through a hand-edited lab file. Keep the old three-field form there instead of
            // printing a bare `lease 0`, which no box accepts and which would not replay.
            out.push(IN_SUBMODE + 'lease ' + (fields.length === 1 && fields[0] === 0 ? '0 0 0' : fields.join(' ')));
          }
        }
        // `reservations` is keyed by hardware address and holds the address it is pinned to, while the
        // command reads `host <address> <hardware-address>` - so the key is printed second.
        const reservations = pool.reservations || {};
        for (const mac of Object.keys(reservations)) out.push(IN_SUBMODE + 'host ' + reservations[mac] + ' ' + mac);
        out.push('exit');
      }

      // DNS zones and their records. `dns add` answers under the zone last named, so the zone line
      // must come first and no `exit` may come between it and its records.
      for (const z of (dev.config.dnsZones || [])) {
        if (!z || !z.name) continue;
        out.push('dns zone ' + z.name);
        for (const r of (z.records || [])) {
          if (!r || !r.name) continue;
          out.push(IN_SUBMODE + 'dns add ' + r.name + ' ' + (r.type || 'A') + ' ' + r.value);
        }
      }

      for (const r of dev.config.routes) {
        // Each shape is one the parser takes back: via a next hop (optionally out a port), out a port alone
        // (the directly-connected form), and either of those with the administrative distance last. A
        // distance that was never typed is not printed, because the box's own file does not carry the
        // default of 1 either. The old line printed an empty field for a missing gateway, leaving two spaces
        // and a line that depended on the tokenizer being forgiving.
        out.push('ip route ' + r.dest + ' ' + r.mask +
          (r.gw ? ' ' + r.gw + (r.iface ? ' ' + r.iface : '') : (r.iface ? ' ' + r.iface : '')) +
          (Number.isFinite(Number(r.distance)) && Number(r.distance) >= 1 ? ' ' + Number(r.distance) : ''));
      }
      if (dev.config.defaultGateway) out.push('ip default-gateway ' + dev.config.defaultGateway);
      // `ip routing` is printed when it differs from the platform default, in the direction it differs - the IOS
      // rule for the whole file. It is also why a router's own `show running-config` never carried the line:
      // "You can't see it with show running-config because it's enabled by default"
      // (https://networklessons.com/ip-services/cisco-router-as-host-or-server), while a Catalyst, which leaves
      // the factory in L2 mode, prints it as soon as somebody types it. A box that was never told anything
      // prints neither line, whatever its platform.
      const routingDefault = typeof dev.routingDefault === 'function' ? dev.routingDefault() : true;
      if (dev.config.ipRouting !== null && dev.config.ipRouting !== undefined &&
          !!dev.config.ipRouting !== routingDefault) {
        out.push(dev.config.ipRouting ? 'ip routing' : 'no ip routing');
      }
      // The file's last line, which every Cisco `show running-config` ends with: restoring a lab is a
      // paste into a config prompt, and on a real box the paste leaves configuration mode when the `end`
      // line is read - the config *file* carries the exit. This printer stopped at the last configured
      // value, so a pasted backup left the session at `(config)#` with nothing saying the paste was
      // finished (and a scripted restore kept typing at the wrong prompt). The vendor samples differ in
      // how many `!` lines sit above it - one in the IOS 11.2 command reference, two in the ISR 4400
      // guide - so only the line every one of them has is printed (research/running-config-end.md).
      out.push('end');
    } else {
      out.push('% Invalid show command: ' + (tokens.join(' ') || '(empty)'));
    }
    return out;
  }

  // What this device would advertise right now. A router shows its policy and the
  // exact options that would go on the wire; a host shows which interfaces are
  // waiting for a router, because "no address yet" is the failure mode of SLAAC
  // and it should be visible rather than mysterious.
  _showIpv6Nd() {
    const raLib = require('./ra');
    const dev = this.device;
    const cfg = raLib.normalizeConfig(dev.config.ra);
    const canAdvertise = dev.hasCap('l3-forward');
    const out = [];

    out.push('IPv6 router advertisements on ' + dev.name + ':');
    out.push('  Device      : ' + dev.model + (canAdvertise ? '  (l3-forward)' : '  (no l3-forward)'));
    if (!canAdvertise) {
      out.push('  Advertise   : unavailable - a device without l3-forward cannot route a prefix');
    } else if (!cfg.enabled) {
      out.push('  Advertise   : disabled  (ipv6 nd ra enable, or `no ipv6 nd ra disable`, to start)');
    } else if (cfg.suppress) {
      out.push('  Advertise   : enabled, suppressed  (solicited advertisements only)');
    } else {
      // The line a fresh device prints. It is on because that is the default, not
      // because somebody configured it - and a report that does not say so invites
      // the reader to look for the command that switched it on.
      out.push('  Advertise   : enabled  (the default; `ipv6 nd suppress-ra` stops the periodic ones)');
    }
    out.push('  Flags       : M=' + (cfg.m ? 1 : 0) + ' O=' + (cfg.o ? 1 : 0) +
      '   router lifetime ' + cfg.routerLifetime + 's' +
      (cfg.routerLifetime === 0 ? ' (not a default router)' : ''));
    out.push('  Timers      : reachable ' + cfg.reachableTime + 'ms, retrans ' + cfg.retransTimer +
      'ms, hop limit ' + cfg.curHopLimit);

    // What would actually go out: the /64 each interface holds as an address
    // (IOS advertises those without an `ipv6 nd prefix` line) plus the prefixes
    // the operator configured, with a configured entry replacing its own prefix
    // and nothing else. The advertisement builds its list from the same two
    // helpers, so this report cannot promise a prefix the wire would omit -
    // research/ipv6-ra-advertises-interface-prefix.md.
    const automatic = canAdvertise ? raLib.addressPrefixes(dev.ip6Addrs()) : [];
    const advertised = raLib.mergePrefixes(automatic, cfg.prefixes);
    const configuredKey = {};
    for (const p of cfg.prefixes) configuredKey[p.prefix + '/' + p.prefixLen] = true;
    const fromIface = advertised.filter(function (p) {
      return !configuredKey[p.prefix + '/' + p.prefixLen];
    }).length;
    if (!advertised.length) {
      out.push('  Prefixes    : none - hosts would learn a default router only');
    } else {
      out.push('  Prefixes    : ' + advertised.length +
        (fromIface
          ? '   (' + fromIface + ' from an interface address' + (fromIface === 1 ? '' : 'es') +
            (advertised.length > fromIface ? ', ' + (advertised.length - fromIface) + ' configured' : '') + ')'
          : ''));
      out.push('    ' + pad('prefix', 26) + pad('L', 3) + pad('A', 3) + pad('valid(s)', 12) +
        pad('preferred(s)', 15) + 'source');
      for (const p of advertised) {
        const key = p.prefix + '/' + p.prefixLen;
        out.push('    ' + pad(key, 26) +
          pad(p.onLink ? '1' : '0', 3) + pad(p.autonomous ? '1' : '0', 3) +
          pad(p.validLifetime, 12) + pad(p.preferredLifetime, 15) +
          (configuredKey[key] ? 'configured' : 'interface address'));
      }
    }

    if (canAdvertise) {
      const v6 = require('./ipv6');
      const ports = dev.activeInterfaces()
        .filter(function (i) { return !i.parent && i.peer; });
      const holds = function (iface, p) {
        for (const e of dev.ip6Addrs()) {
          if (e.name !== iface.name) continue;
          if (v6.prefixContains6(p.prefix + '/' + p.prefixLen, e.addr)) return true;
        }
        return false;
      };
      if (!ports.length) {
        out.push('  Interfaces  : (no cabled ports)');
      } else {
        // Which prefix would go out of which port: a router advertises a prefix
        // on the link it is attached to, not on every port it owns.
        const rows = ports.map(function (i) {
          const list = advertised.filter(function (p) { return holds(i, p); })
            .map(function (p) { return p.prefix + '/' + p.prefixLen; });
          return i.name + (list.length ? ' (' + list.join(', ') + ')' : ' (default router only)');
        });
        out.push('  Interfaces  : ' + rows.join(', '));
      }
      for (const p of cfg.prefixes) {
        if (ports.some(function (i) { return holds(i, p); })) continue;
        out.push('  % ' + p.prefix + '/' + p.prefixLen +
          ' is configured but no interface has an address inside it, so it is never advertised');
      }
    }

    const waiting = [];
    for (const i of dev.activeInterfaces()) {
      if (!i.autoconfig) continue;
      const learned = (dev.config.ip6 || {})[i.name];
      waiting.push(i.name + (learned && learned.autoconfig
        ? ' -> ' + learned.addr + '/' + learned.prefix + ' (from ' + (learned.from || 'RA') + ')'
        : ' (waiting for a router)'));
    }
    out.push('  Autoconfig  : ' + (waiting.length ? waiting.join(', ') : 'none'));
    if (dev.config.gateway6) {
      out.push('  Default gw  : ' + dev.config.gateway6 +
        (dev.config.gateway6Iface ? ' via ' + dev.config.gateway6Iface : '') +
        (dev.config.gateway6Learned ? '  (learned from a router advertisement)' : '  (configured)'));
    }
    return out;
  }

  _banner() {
    const dev = this.device;
    return 'PacketForge ' + dev.label + ' (' + dev.vendor + ' ' + dev.model + ')';
  }

  _help() {
    return [
      'Available commands:',
      '  enable / configure terminal / interface <name>',
      '  hostname <name>          ip address <ip> <mask>',
      '  ip route <dest> <mask> <gw> [iface]',
      '  ip routing / no ip routing        forward between networks, or stop',
      '  show lldp                         status: on, and the three timers it advertises',
      '  show lldp neighbors               neighbours learned over the wire',
      '  show power inline [<port>]        PoE supplied, and why a port was denied',
      '  ip default-gateway <gw>  shutdown / no shutdown',
      '  ipv6 address <addr>/<len> | autoconfig        (interface mode)',
      '  ipv6 nd ra enable|disable|managed|other-config|lifetime <s>',
      '  ipv6 nd prefix <prefix>/<len> [valid <s>] [preferred <s>]',
      '  ipv6 nd suppress-ra',
      '  show ipv6 nd                    what this device would advertise',
      '  vlan <id> [name]                       (config mode)',
      '  interface <parent>.<n>                 (creates a subinterface; n is 1-4294967293, not a VLAN id)',
      '  encapsulation dot1q <vlan>             (interface mode)',
      '  switchport mode access|trunk            (interface mode)',
      '  switchport access vlan <id>',
      '  switchport trunk native vlan <id>',
      '  switchport trunk allowed vlan <list|all>',
      '  channel-group <id> mode active|passive|on',
      '  access-list <1-2699> permit|deny ...        (config mode)',
      '  ip access-group <acl> in|out               (interface mode)',
      '  no ip access-group [<acl>] [in|out]        (interface mode)',
      '  no hostname | no vlan <id> | no ip dhcp pool <name> | no dns zone <name>',
      '  scion <isd-as> | no scion        the device SCION ISD-AS, e.g. 1-ff00:0:110  (config mode)',
      '  network <net> <mask> | range <a> <b> | default-router <gw> | lease <days> [hours] [minutes] | infinite' +
        '  (in a dhcp pool)',
      '  host <address> <mac> | excluded-address|excluded address <a> [<b>] | dns-server <address...>' +
        '  (in a dhcp pool)',
      // Two whole features were reachable and unlisted: `clock rate` (serial links, #1483) and `traceroute`
      // (#1484). `help` is how an operator finds out what the console can do, so an unlisted verb is a verb only
      // its author knows about (#1491).
      '  traceroute|tracert <address|name> [max <n>]   each hop that answers, from its own time-exceeded',
      // `speed auto|forced <mbps>` was the promise here and `_speed()` has never had a `forced` keyword: it parses
      // `auto` or a rate (`100`, `1000`, `1G`), and its own usage line says so. A documented spelling the parser
      // refuses is worse than a missing one, because the help is the thing a technician trusts first (#1501).
      '  speed auto|<mbps> | duplex half|full | description <text>   (interface mode)  e.g. `speed 100`, `speed 1G`',
      '  clock rate <bps>                       (interface mode, serial only) makes this end the DCE',
      // The index advertised a spelling the parser never read: `at` became NaN, and a NaN instant suppresses
      // the `(pending)` column rather than failing. Both spellings are now the same grammar `link` uses.
      '  converge [<ms> | at <ms>]         - when each control plane finishes',
      '  link up|down <id> [at <ms>]       - pull or replace a cable, re-converge from there',
      '  links                             - every cable and its state',
      '  show version | ip interface brief | ip route | arp',
      '  show vlan [brief] | spanning-tree | etherchannel summary',
      '  show access-lists',
      '  show mac address-table | interfaces | running-config',
      // Three protocol families were configurable and absent from this list: the console could do VRRP, OSPF
      // and BGP and the index that says what the console can do never mentioned any of them. `show vrrp` was
      // documented in prose and missing here and from the docs table.
      '  vrrp <vrid> ip <addr> | priority <1-254> | preempt      (interface mode)',
      '  show vrrp                          the group, its state, and the master it elected',
      '  ospf router-id <ip> | area <id>                        (config mode)',
      '  ip ospf cost <n> | area <id> | priority <0-255> | passive  (interface mode)',
      '  show ip ospf [neighbour | interface] [<port>]  the process, its adjacencies and what each port costs',
      '  show ip dhcp [binding | pool] [<address|mac|name>]  who holds which address, and pool utilisation',
      '  show ip dns [zone [<name>]]                   the zones this device answers for, and its resolvers',
      '  ping <address|name> [<count 1-50>] [at <ms>]   IPv4 or IPv6; a name is resolved through the lab\'s DNS servers',
      '  router bgp <as> | neighbor <ip> remote-as <as>         (config mode)',
      '  show ip bgp [summary]              neighbours, their state, and the prefixes installed'
    ];
  }
}

// Convenience: run a list of commands, returning { output, lines }.
function runCommands(device, topology, simulator, commands) {
  const session = new CliSession(device, topology, simulator);
  const lines = [];
  for (const cmd of commands) {
    lines.push(session.prompt() + cmd);
    const res = session.run(cmd);
    for (const l of res.output) lines.push(l);
  }
  return { output: lines.join('\n'), lines: lines, session: session };
}

// The one hostname rule breach a vendor document shows the *outcome* of: an all-numeric name.
//
// Every IOS and IOS XE `hostname` reference publishes the ARPANET host-label rule (start with a
// letter, end with a letter or digit, interior letters/digits/hyphens only) and then adds, of the
// numeric case alone, "Creating an all numeric hostname is not recommended but the name will be
// accepted after an error is returned" - with a transcript: `hostname 123` prints
// `% Hostname contains one or more illegal characters.` and the prompt becomes `123(config)#`.
//
// Only that case is warned about here. The reference shows the same line for `hostname \99` but
// never shows the prompt that follows, and says nothing at all about a leading digit, an underscore,
// a trailing dot, a name past 63 characters or an interior space - and half the catalogue's own
// default names (vendor model strings like "ZenWiFi ET8", "FRITZ!Box 7590") breach the rule, so
// guessing at the rest would put a warning on every replayed running-config. research/
// hostname-illegal-characters.md lists each of those open questions.
function hostnameIsAllNumeric(name) {
  return /^[0-9]+$/.test(name);
}

// How a box writes a mask that is a legal dotted quad but not a run of ones. The mask has no prefix length,
// so the sentence cannot name one; IOS prints the mask as a hex word instead:
//
//     R1(config-if)# ip address 192.168.1.254 255.255.5.0
//     Bad mask 0xFFFF0500 for address 192.168.1.254
//     (https://www.n-study.com/en/ip-addressing/cisco-ipaddress-configuration/ - one of the two refusals that
//     page prints without the `%` marker its overlap refusal carries)
//
// The hex spelling comes from the way a box renders a netmask in hex at all - "as indicated by the leading
// 0X (for example, 0XFFFFFF00)" (Cisco IOS IP Addressing Services Command Reference, `ip netmask-format`)
// - so the word is built the same way here: `0X`, the mask's four bytes, uppercase. research/
// ip-address-bad-mask-hex.md has the second transcript (`Bad mask 0XFFFFF`, a forum thread title whose
// screenshot is unreadable), the casing and zero-padding disagreement between them, and the one capture that
// would settle it.
//
// Like its `Bad mask /N` sibling this line carries no leading `%`: a box prints it unmarked (research/
// ip-address-not-a-host.md), and a marker on one mask refusal and not the other would be this console's
// invention. It explains nothing, because the box explains nothing.
function badMaskLine(ip, mask) {
  const netLib = require('./net');
  const hex = (netLib.maskToInt(mask) >>> 0).toString(16).toUpperCase().padStart(8, '0');
  return 'Bad mask 0X' + hex + ' for address ' + ip;
}

// resolvePortName / portKey are exported so the naming test can pin the alias
// rules directly, rather than only through the commands that use them.
module.exports = { CliSession, runCommands, resolvePortName, portKey };
