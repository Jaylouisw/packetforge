# `switchport mode`: how many words does the command take, and what happens to a second one?

**Question (one, narrow).** `switchport mode` sets a port's VLAN membership mode. Every command reference
prints its syntax as a single keyword choice - but this console read the second word and dropped the rest, so
`switchport mode trunk access` made the port a trunk and `switchport mode access flurbish` set access, both in
silence. Does a real box take a second word, and if not, what does it do with one - refuse the line, or act on
the first word and ignore the rest?

**Verdict: one keyword, and a second word is a parse error - nothing is applied.** The syntax line has no
optional word in either form, the reference's own error table names the answer for a word outside the set
(`% Invalid input detected at '^' marker.`, the caret on the offending word), and the line is discarded rather
than half-applied: an operator who typed two modes in one line (the shape a paste of a half-edited line
produces) got no mode change at all. Changed here: the console refuses a tail on both the positive and the `no`
form, quotes the words it did not use, and leaves the port exactly where it was.

## The evidence

| Source | Says |
| --- | --- |
| [Catalyst 2960-S and 2960-C Cisco IOS Commands, 15.2(4)E (`shutdown` through `vtp`, PDF)](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/15-2_4_e/command/reference/cr_2960/cli3.pdf) | `switchport mode {access \| dot1q-tunnel \| dynamic {auto \| desirable} \| private-vlan \| trunk}` and `no switchport mode {access \| dot1q-tunnel \| dynamic \| trunk}`. One keyword from the set, no trailing optional word. The same book's error-message table gives `% Invalid input detected at '^' marker.` for "You entered the command incorrectly. The caret (^) marks the point of the error." |
| [Catalyst 2960-XR Layer 2/3 Command Reference, 15.2(5)E (PDF)](http://cisco.com/c/en/us/td/docs/switches/lan/catalyst2960xr/software/15-2_5_e/command_reference/b_1525e_consolidated_2960xr_cr/m_layer2_2960xr_cr.pdf) | The same line, laid out over two rows (`mode` / `{access \| dot1q-tunnel \| dynamic {auto \| desirable} \| private-vlan \| trunk}`), and the four examples that show the accepted shapes one at a time: `switchport mode access`, `switchport mode dynamic desirable`, `switchport mode trunk`, `switchport mode dot1q-tunnel`. No example prints two values on one line. |
| [Catalyst 2960-XR Consolidated Platform Command Reference, 15.2(2)E (PDF)](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960xr/software/15-2_2_e/consolidated_guide/command_reference/b_consolidated_2960-xr_1522e_cr/b_consolidated_2960-xr_1522e_cr_chapter_0100.pdf) | The identical syntax line and the identical four examples, in the other 2960-XR book - so the grammar is not one release's slip. |
| [Cisco Community, "Unable to configure trunk port on cisco 2960 x series"](https://community.cisco.com/t5/switching/unable-to-configure-trunk-port-on-cisco-2960-x-series/td-p/2930507) | A live session where a line refused for another reason is followed by `switchport mode trunk` typed alone, three times, each accepted only in that one-word form - the practice the syntax line predicts. |
| [Cisco Community, "not getting switchport trunk 4948E"](https://community.cisco.com/t5/switching/not-getting-switchport-trunk-4948e/td-p/4455792) | The parse-error shape on a neighbouring interface keyword: `switchport trunk encapsulation dot1q` on a box without the keyword prints `^` under the word and `% Invalid input detected at '^' marker.`, and the port's own `show run` is unchanged. |

## What is inferred

* **That a second word is refused rather than ignored.** The syntax line and `switchport mode ?` both close the
  value set after one keyword, and the reference's error table is the documented outcome of a word outside it.
  No capture read here shows `switchport mode trunk access` actually typed on a box; the inference is from the
  grammar plus the parse-error table, which is the same pair the neighbouring `speed`/`duplex` refusals rest on
  (`research/speed-duplex-grammar.md`).
* **That a fixed-width refusal is this console's to word.** The house sentence is
  `% switchport mode <mode> takes one mode and nothing after it: the word "<x>" was not used, and the mode is
  unchanged` - the shape `duplex <mode> <word>` and `speed <rate> <word>` already use, rather than the caret
  line, because this console reports the word it dropped and the state it left. The device's own text for the
  case is only ever `% Invalid input detected at '^' marker.`, which names no word and no state.
* **That `dynamic auto`/`dynamic desirable` stay outside.** They are two-word values in the vendor's line, but
  this console models two modes (`access`, `trunk`), so `switchport mode dynamic auto` keeps the usage refusal
  that lists the modes it has - it is not a "second word" case, and the refusal must not claim `auto` was a
  typo for something.

## What changed

* `engine/cli.js`, `_switchport()`: the `mode` branch refuses `tokens[2..]` before writing anything, and the
  `no` branch (`no switchport mode <mode> <word>`) does the same. The quote is the words as typed, joined, so
  `switchport mode access flurbish murmur` reads `"flurbish murmur"`.
* `test/switchport-mode-grammar.test.js` (23 checks): the receipt for `trunk access` (one line, exact text), the
  port still `access`, `show running-config` unmoved, the mirrored case on a trunk (a refused
  `switchport mode access flurbish` leaves the trunk a trunk), case-preserving quotes, the `no` form, and three
  controls (both single-word forms still work and still carry `allowedVlans: all`; `dynamic auto` still gets the
  usage line).
* `test/no-command-swallows-a-word.test.js`: two cases added to the "a word after a value the command already
  has" sweep, and `attempt()`'s state snapshot now includes each interface's switchport settings - the config
  object alone could not see `iface.vlan.mode`, so that sweep could not have caught a "refuse and obey" fix.
  Pre-fix the two cases report `Switchport mode trunk on Fa0/2` and the suite fails.

## What remains unresolved

* **No raw capture of the two-word line.** The verdict rests on the syntax line and the error table, not on a
  transcript of `switchport mode trunk access`. A paste of that line from a physical box (or an IOSv/IOS XE
  console log) would turn the inference into an observation; the code change is one `if` either way.
* **Whether a refused line leaves a half-typed mode anywhere.** On hardware there is nothing to store - the
  parser rejects the line before the mode is set. Here the refusal returns before `iface.vlan` is touched, and
  the sweep asserts nothing was written, but that is this engine's guarantee, not a device measurement.
* **`switchport mode private-vlan` and `dot1q-tunnel`.** Both are in the vendor's set and neither is modelled;
  they are refused today by the usage line naming the two modes this console has. Whether that sentence should
  name the two missing keywords (as `speed nonegotiate` does) is a separate, small question.
