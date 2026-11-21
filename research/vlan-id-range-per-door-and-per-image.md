# The VLAN id range: one number for every door, or one per door and per image?

**Question (one, narrow).** This console keeps one constant - a VLAN id is a whole number from 1 to 4094 -
and uses it at every door that names a VLAN (`vlan`, `no vlan`, `switchport access vlan`, `switchport trunk
native vlan`, `switchport voice vlan`, `switchport trunk allowed vlan`, `encapsulation dot1q`). Is that one
number right for all of them, and what does a box actually print when the number is outside its range? Two
sibling notes both call the answer "this console's own sentence" without a source
([interface-refusal-mode.md](interface-refusal-mode.md#unresolved-and-what-would-settle-it),
[subinterface-number.md](subinterface-number.md)) - this run went looking for the source.

**Verdict: the range is a parser property, and the parser's range is the *image's*, not a number in the
standard.** Two raw console pastes in one Cisco Community thread show the same command door advertising two
different ranges on two 2960s, and the refusal for an id outside that range is the generic invalid-input
error - not any VLAN-specific sentence. Nothing was coded: for the images this model speaks for, 1-4094 is
the documented range, and the wording difference is the console's settled no-caret policy
([parse-error-caret.md](parse-error-caret.md)), not a VLAN bug.

## The evidence

All four lines below are one thread,
[How to add Vlan 4030 in cisco 2960 Series switch](https://community.cisco.com/t5/switching/how-to-add-vlan-4030-in-cisco-2960-series-switch/td-p/1733869).
Two different switches appear in it, and they disagree about the range - which is the whole point.

**(a) A LAN Lite 2960, `vlan ?` and `vlan 4030`** (the asker's WS-C2960S-48TD-L; the thread's diagnosis, after
some back and forth about "Standard/Enhanced" vs "LAN Lite/LAN Base", is that it runs the smaller image):

```
Switch(config)#vlan ?
 <1-1005> ISL VLAN IDs 1-1005
Switch(config)#vlan 4030
 ^
% Invalid input detected at '^' marker.
```

**(b) A LAN Base 2960, `switchport access vlan ?`** (a different poster's WS-C2960-48TT-L,
`C2960-LANBASEK9-M` 12.2(52)SE, in the same thread's `show version`):

```
ecr-b01-sw03(config-if)#swi ac vla ?
<1-4094> VLAN ID of the VLAN when this port is in access mode
dynamic When in access mode, this interfaces VLAN is controlled by VMPS
```

**(c) The vendor's range for `vlan`**, stated twice in the 2960-X VLAN Command Reference and again for the
Catalyst 9300: "The range is 1 to 4094", and the behaviour - "If you enter an invalid VLAN ID, you receive an
error message and do not enter VLAN configuration mode."
* https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_3_e/command_reference/vlan/b-vlan-1523e-2960x.pdf
* https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/16-5/command_reference/b_165_9300_cr/b_165_9300_cr_chapter_010101.html

**(d) The vendor's range for `switchport access vlan`**: "VLAN ID of the access mode VLAN; the range is 1 to
4094" (Catalyst 3650 Layer 2/3 Command Reference, IOS XE 3.6E),
https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst3650/software/release/3e/layer2/command_reference/b_Layer2_3_3e_3650_cr.pdf
- the same figure the box's own `?` menu prints in (b).

**(e) The reserved ends.** The vendor's range table in nearly every Catalyst software guide has the row
`0, 4095 | Reserved | For system use only. You cannot see or use these VLANs.` (quoted, with the guide URLs,
in [vlan-media-defaults.md](vlan-media-defaults.md)). So 0 and 4095 are refused for a *reason*, and 4095 is
not "a big VLAN id" in 802.1Q at all - it is the reserved all-ones tag.

## What is known

1. **Two doors, two menus, verified on real consoles.** `vlan ?` printed `<1-1005>` on one 2960 and
   `switchport access vlan ?` printed `<1-4094>` on another. The range a door accepts is what its parser
   advertises, and that number is a property of the running image.
2. **The refusal is the parser's, and it is not VLAN-flavoured.** `vlan 4030` on the LAN Lite box answered
   with the caret error, no VLAN id in the sentence, and - per the vendor sentence in (c) - no entry into
   VLAN configuration mode. Nothing was created.
3. **1-4094 is the documented range for the two doors that create and assign VLANs** (`vlan`,
   `switchport access vlan`), on every platform guide checked, and 4094 is likewise what the tag door
   advertises: `encapsulation dot1Q ?` -> `<1-4094> IEEE 802.1Q VLAN ID` (captured in
   [subinterface-number.md](subinterface-number.md)).
4. **The model speaks for LAN Base and up.** No device in `devices/` is a LAN Lite part (measured: zero
   catalogue files mention LAN Lite/LANBASE-L), so the 1005 ceiling has no device to apply to.

## What is inferred rather than witnessed

* **That a full-range image answers `vlan 5000` the same way** - with the caret error - because 5000 is
  outside its parser range exactly as 4030 was outside the LAN Lite one. The vendor sentence in (c)
  ("you receive an error message and do not enter VLAN configuration mode") is consistent, but no paste of
  `vlan 5000` on a 1-4094 image was found, so the *words* are inferred, not read.
* **That 0 and 4095 are refused as reserved, not as out of range.** The range tables say "cannot see or use";
  no capture of either on a console was found.

## Unresolved, and what would settle it

* **The exact sentence for an id above 4094 on a full-range image.** One paste of `vlan 5000` (or
  `vlan 4095`) with the following lines, on 15.2(7)E or 17.x, would settle whether the caret error is
  universal or whether some release prints a VLAN sentence (`% Failed to create VLANs`, the sentence that
  belongs to the *extended-range VTP* failure in
  [extended-vlan-creation-vtp.md](extended-vlan-creation-vtp.md), is the obvious candidate to be confused
  with it, and on the evidence in hand it is a different failure).
* **0 versus 4095.** A paste of each, on one switch, would show whether the box distinguishes "reserved"
  from "out of range" in words.
* **Whether the *grammar* is per release too.** The LAN Lite menu offers a single id (`<1-1005>`), while the
  2960-X reference describes comma lists and hyphen ranges. A `vlan 10,20` on the same box would say whether
  the menu is merely terse or the release really takes one id.
* **What a LAN Lite box does to an *extended* id it can parse.** 1006-4094 is inside the LAN Base range and
  outside the LAN Lite one; whether a LAN Lite box calls that a range error or a VTP-mode error is not in
  hand.

## What the model does now, measured on this branch

```
sw1(config)#vlan 5000                          % VLAN id 5000 is outside 1-4094
sw1(config)#vlan 4095                          % VLAN id 4095 is outside 1-4094
sw1(config)#vlan 0                             % VLAN id 0 is outside 1-4094
sw1(config-if)#switchport access vlan 5000     % VLAN id 5000 is outside 1-4094
sw1(config-if)#switchport trunk native vlan 4095   % VLAN id 4095 is outside 1-4094
sw1(config-if)#switchport voice vlan 4095      % VLAN id 4095 is outside 1-4094
sw1(config-if)#switchport trunk allowed vlan 5000  % VLAN 5000 is outside 1-4094
sw1(config-if)#encapsulation dot1q 5000        % VLAN out of range: 5000   (on a subinterface)
sw1(config)#vlan ?                             % Invalid VLAN id "?": a VLAN id is a whole number from 1 to 4094
sw1(config)#interface ?                        % Interface not found: ?
sw1(config)#switchport ?                      % Unrecognized config command: switchport ?
```

* One constant, `1-4094`, in `_vlanIdRefusal()` (`engine/cli.js:1255`) and again in `_encap()`
  (`engine/cli.js:2940`) and the trunk-list check (`engine/cli.js:3800`). Behaviour matches the captures
  where it can be compared: nothing is created, the mode does not move, and the port keeps what it had.
* **The `?` key is answered as a bad value in every config door measured** (`interface`, `vlan`,
  `switchport`, `ip`) while the EXEC side prints a view table. The captures above show a box printing a
  one-line menu there instead. That gap is a whole missing surface, not a wording fix, and is recorded here
  rather than half-built - the menu text for the 1-4094 case (`<1-4094> VLAN ID ...`, or
  `<1-1005> ISL VLAN IDs 1-1005` on the smaller image) is exactly what a per-image range would have to
  generate.

## Why no engine code changed

* The **range** is right for every device the catalogue holds; giving the model a per-image ceiling would be
  a new capability, and adding a LAN Lite device is a different job with its own census.
* The **sentence** is this console's house voice for a refused number
  (`% Subinterface number out of range: ...`, `% Router lifetime out of range: ...`), and the box's own
  words are a caret error this project has decided not to print
  ([parse-error-caret.md](parse-error-caret.md)). Rewriting one refusal into a caret sentence would make the
  console inconsistent with itself on the strength of a single paste.
