# Is a subinterface's number the VLAN it terminates?

**Question (one, narrow).** `interface Gi0/0.5000` - is 5000 a name a box opens, or a VLAN id it refuses?
This console checked the number after the dot against the 802.1Q range and answered
`% VLAN out of range: 5000`, so the question is whether the number in a subinterface name and the VLAN in
`encapsulation dot1q` are one value or two.

**Verdict: two values, with different ranges.** The subinterface number is a name in the range
**1 to 4294967293**; the VLAN it terminates is set by `encapsulation dot1q`, whose range is **1 to 4094**,
and the two need not match. `interface Gi0/0.5000` therefore opens on a box, and it is
`encapsulation dot1q 5000` - not the name - that is refused.

## Evidence

| Source | Says |
| --- | --- |
| [Cisco IOS `interface` command reference (TAC cmdref)](https://www.cisco.com/E-Learning/bulk/public/tac/cim/cib/using_cisco_ios_software/cmdrefs/interface.htm) | "`.subinterface-number` — Subinterface number in the range 1 to 4294967293." |
| [Cisco IOS XE SD-WAN qualified command reference, `interface`](http://cisco.com/c/en/us/td/docs/routers/sdwan/command/iosxe/qualified-cli-command-reference-guide/m-interface-commands.html) | The same range, in the current IOS XE grammar: 1 to 4294967293, "the number that precedes the period must match the number to which this subinterface belongs" (a rule about the *parent* number, not about VLANs). |
| [Cisco, IP Manager syntax checks (PDF)](https://www.cisco.com/en/US/docs/net_mgmt/ip_manager/1.0/user/guide/app_syntax_cks.pdf) | "Invalid subinterface number. Must be in the range from 1 through 4294967293." A config checker, so this is the range it accepts from a box. |
| [Cisco Press, *VLAN Routing with Router 802.1Q Trunks* (Odom)](https://www.ciscopress.com/articles/article.asp?p=2990405&seqNum=2) | "These numbers can be any number from 1 up through a very large number (over 4 billion). ... the subinterface number does not even have to match the associated VLAN ID. (The `encapsulation` command, and not the subinterface number, defines the VLAN ID associated with the subinterface.)" |
| [networkacademy.io, *Router on a stick*](https://www.networkacademy.io/ccna/ethernet/router-on-a-stick) | A captured help line from a box: `Router1(config-subif)#encapsulation dot1Q ?` → `<1-4094> IEEE 802.1Q VLAN ID`. The tag's range, printed by the command that sets it. |
| [Cisco, *LAN Switching Configuration Guide*, IOS XE 16.6 (Q-in-Q)](http://www.cisco.com/c/en/us/td/docs/ios-xml/ios/lanswitch/configuration/xe-16-6/lanswitch-xe-16-6-book.pdf) | Table 3 maps `GigabitEthernet1/0/0.4` to **many** inner VLAN ids (1-99, 101-199, ... 601-4095). One subinterface number, a whole set of VLANs - the two cannot be the same value. |
| [Cisco, *Configure ASA VLAN Subinterfaces*](https://edge.ci.cdo.cisco.com/content/docs/t-configure-vlan-subinterfaces.html) | Two separate fields on one dialog: "VLAN ID ... between 1 and 4094" and "Subinterface ID ... between 1 and 4294967293". |
| [Cisco, *Catalyst IR8340* guide](https://www.cisco.com/c/en/us/td/docs/routers/ir8340/software/configuration/1718x/b_ir8340_cg_17-18-x.pdf) | `Router(config)#interface g0/0/0.?` → `<1-4294967295>`, i.e. a platform whose ceiling is two higher than the classic range. |
| [Cisco, *Configuring Ethernet Interfaces*, ASR 9000 (IOS XR)](http://cisco.com/c/en/us/td/docs/routers/asr9000/software/24xx/interfaces/configuration/guide/b-interfaces-hardware-component-cg-asr9000-24xx/configuring-ethernet-interfaces.pdf) | IOS XR: "The subinterface number must be a positive integer from zero to some high value", and its example creates `GigabitEthernet 0/5/0/0.0` then `encapsulation dot1q 100`. A different platform, and it allows 0. |

## What is inferred

* **The range to implement.** 1-4294967293 is the classic IOS figure, stated by three Cisco documents
  (command reference, IOS XE reference, config checker). The IR8340's 4294967295 is a platform ceiling, not
  a contradiction of the shape; the model takes the classic range and refuses above it.
* **That the refusal of an out-of-range number is the parser's.** No capture of a caret on `interface
  Gi0/0.0` was found. This project does not print carets (`research/parse-error-caret.md`), so the console
  says `% Subinterface number out of range: 0` - its own sentence, naming the number, not a VLAN.
* **That a subinterface above 4094 carries no tag.** A box creates the interface with no encapsulation
  configured, and `show running-config` prints only `interface GigabitEthernet0/0.5000`; frames are not
  tagged until `encapsulation dot1q` is typed. That is the documented default ("no encapsulation") rather
  than a transcript, so what is modelled is the absence of a line, not a particular output.

## Unresolved, and what would settle it

* **Whether classic IOS opens `.0`.** IOS XR does (ASR 9000 above), and IOS' own command reference starts
  at 1. The model refuses 0, matching the documented range; a capture of `interface Gi0/0.0` on 15.2 or
  17.x would settle it.
* **Whether a *switch* port takes a subinterface name at all.** This run only moved the range check for
  names the console already creates (parents that exist on any device). A Catalyst 2960 answers
  `interface Gi1/0/1.5` with something - caret, or an L2 refusal - and no capture was found; nothing here
  changes that door.
* **The 4094 ceiling for the tag on IOS XE with `second-dot1q`.** Q-in-Q inner ids reach 4095 in the table
  above. Not modelled: this console has one tag per subinterface.

## What changed

* `engine/device.js` - `addSubinterface(parent, number, encapVid)`: the number is the name (1-4294967293);
  `encapVid` is a separate field, seeded from the number only when the number could be a VLAN id, so the
  one-line router-on-a-stick form (`.10` with no `encapsulation` line) keeps working. An explicit third
  argument - including `null` - overrides the seed. `fromJSON` now rebuilds a subinterface from its *name*,
  not from `encapVid`, so a `.5000` port whose tag is absent comes back on load.
* `engine/cli.js` - the `interface <parent>.<n>` door checks 1-4294967293 and says
  `% Subinterface number out of range: <n>`; `encapsulation dot1q` keeps the 1-4094 check and its
  `% VLAN out of range` sentence. `show running-config` prints an `encapsulation dot1q` line only for a
  subinterface that has a tag.
* `test/subinterface-number.test.js` - 8 checks: the name opens at 5000 and at the 4294967293 ceiling;
  no tag is invented above 4094; `encapsulation dot1q 100` on `.5000` is stored and printed as typed
  (number and tag decoupled); 0, 4294967294, 4095 and 5000 are refused as number/VLAN respectively;
  the `.10` one-line form still prints `encapsulation dot1q 10`; the port is listed with its address in
  `show ip interface brief`; and a `.5000` (tagged 100) plus a `.6000` (untagged) survive save/load.
* `test/l3.test.js` and `test/interface-refusal-mode.test.js` - the scenarios that used `.9999`/`.5000` as
  "an out-of-range VLAN" now pin the new rule (the name opens; the VLAN is refused at `encapsulation`;
  the refusal-mode scenario uses `.0`, which is still a refusal).
* `docs/CLI.md` - the command table, the `no interface` prose and the "subinterface is a VLAN tag"
  paragraph say which range belongs to which value.

## Why this is fidelity and not a new feature

Subinterfaces, `encapsulation dot1q`, the two commands' refusals and running-config's stanza already
existed. The only question was which range the number after the dot is checked against, and what the
config says when it is not a VLAN id. Nothing new is configurable, no view gains a column, and the
router-on-a-stick form this model documents keeps its one-line habit.
