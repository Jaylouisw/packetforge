# `show lldp neighbors`: is the `Hold-time` column the TTL or the time left?

**Question (one, narrow).** In the one-line table `show lldp neighbors` prints, does the `Hold-time`
column carry the hold time the neighbour *advertised* in its Time To Live TLV - a constant for as long as
the sender's `lldp holdtime` is unchanged - or the time *remaining* before this box drops the entry, which
falls with every second the neighbour stays quiet?

**Verdict: it is the advertised TTL, and the countdown is a different field.** Settled by a Cisco guide
that prints the same two neighbours through both views of the command: the brief table says `120` for both
while the detail view, taken at the same time, says `Time remaining: 116 seconds` and `90 seconds` beside
`Hold Time: 120 seconds`. A brief column that counted down could not show 120 for a record with 90 s left.
The command references say the same thing twice over: the brief field table defines `Hold-time` as the time
the local device *will hold* the advertisement, and the detail field table carries **two** fields,
`Time remaining` and `Hold Time`, one view apart. A second pass settled the question this note left open -
whether classic IOS prints a detail view at all - and found that on IOS and IOS XE the detail view carries
**only** the countdown (`Time remaining`); `Hold Time` is an IOS XR line. The paired IOS capture below also
kills the remaining inference: one Catalyst prints `Hold-time 120` in the table and `Time remaining: 106
seconds` for the same neighbour in the detail view.

This is a correction to a claim this repository was making in two comments - that Cisco's brief column
"prints what is left of it" and "counts what is left of it down" - which no source supports.

## What PacketForge does today

`show lldp neighbors` prints `Neighbour`, `Local port`, `Port ID` and `Mgmt address`; there is no
`Hold-time` column at all, so nothing here was printing the wrong number. The row carries both numbers a
column would need (`lldpRows()` returns `holdTimeS` and `heardAtMs`), and the *ageing* rule is already the
TTL's: a row disappears once `now - heardAt > ttl * 1000`, and is printed unaged when no clock is set
(`engine/device.js`, `lldpRows()`; pinned by `test/lldp-hold-time.test.js`). That rule is unaffected by
this question and stays as it is.

## Evidence

| Source | Says |
| --- | --- |
| [Cisco NCS 1014 25.x configuration guide, "LLDP Drop"](https://www.cisco.com/c/en/us/td/docs/optical/ncs1014/25xx/configuration/ncs1014-config-guide-25xx/ncs1014-config-controllers/c-lldpsnoopdrop-ncs1014.html) | The decisive pair. `show lldp neighbors detail` for two neighbours of the same box: `Time remaining: 116 seconds` / `Hold Time: 120 seconds`, and `Time remaining: 90 seconds` / `Hold Time: 120 seconds`. The brief table for the same two ports: `Hold-time` `120` and `120`. So the brief column is not the remaining time - it is the second of the two detail fields. |
| [NetworkLessons, *Link Layer Discovery Protocol (LLDP)* - a Catalyst 3560 running 12.2(46)SE](https://networklessons.com/cisco/ccie-enterprise-infrastructure/link-layer-discovery-protocol-lldp) | The paired **IOS** capture. Brief table: `Device ID Local Intf Hold-time Capability Port ID` with `SW2 Fa0/24 120 B Fa0/24`. Detail view, same neighbour: `Chassis id: 0011.bb0b.361a` ... `Time remaining: 106 seconds` ... `System Capabilities: B,R`. So the brief column is not the countdown (120 vs 106 on one pair), and the IOS detail view has no `Hold Time:` line. |
| [Cisco NCS 4000 command reference, LLDP](https://www.cisco.com/c/en/us/td/docs/routers/ncs4000/software/reference/guide/otncommandreferenceguide/m-lldp.html) | Field tables for both views. Brief: `Hold Time` - "Time (in seconds) that the local device will hold the LLDP advertisement from a sending device before discarding it." Detail: `Time remaining` - "Displays the remaining time", and separately `Hold Time` - "the time or duration in seconds that an LLDP device maintains the neighbor information before discarding." Two fields, two names, one view each. Its sample output also prints `Total entries displayed: 1`. |
| [Cisco 8000 IOS XR Interface and Hardware Component Command Reference (PDF)](http://www.cisco.com/c/en/us/td/docs/iosxr/cisco8000/Interfaces/b-interfaces-hardware-component-cr-8000.pdf) | The same brief field table word for word, and a sample row whose `Hold-time` is `150` (`R1 Et1/0 150 R Et1/0`) - a number no local countdown could start from unless the sender advertised it. |
| [Cisco Carrier Ethernet Configuration Guide, IOS XE Everest 16.6 (ASR 1000), "Using LLDP in Multivendor Networks"](https://cisco.com/c/en/us/td/docs/ios-xml/ios/cether/configuration/xe-16-6/ce-xe-16-6-book/ce-lldp-multivend.html) | An IOS XE detail block, verbatim: `Local Intf: Gi0/1/7`, `Chassis id`, `Port id`, `Port Description`, `System Name`, `System Description`, `Time remaining: 127 seconds`, `System Capabilities`, `Enabled Capabilities`, `Management Addresses`. No `Hold Time` line - the same omission as the Cat3560 capture, from the vendor's own document. The 17.x Application Services guide and the 3850 3SE Carrier Ethernet guide print the same block. |
| [Catalyst 2960 software configuration guide 12.2(44)SE, Configuring LLDP](http://cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/12-2_44_se/configuration/guide/scg1/swlldp.html) | `show lldp neighbors` "Display information about neighbors, including device type, interface type and number, **holdtime settings**, capabilities, and port ID", with `lldp holdtime` default 120 s and `lldp timer` 30 s. The command is described as reporting the setting, not a live remainder - weaker than the paired transcript, but not contradictory. |
| IEEE 802.1AB-2016 §8.5.4 (quoted in `engine/lldp.js`) | The TTL TLV is "the number of seconds that the recipient LLDP agent is to regard the information associated with this MSAP identifier to be valid" - the sender's claim about validity, i.e. the number the brief column repeats. |

## What is known, inferred, unresolved

**Known.** On IOS XR the brief column is the advertised TTL and the countdown lives in the detail view as
`Time remaining`, beside a `Hold Time` line that repeats the TTL (102 vs 120 in the 8000 reference; 116 and
90 vs 120 on the NCS 1014). Three command references define the brief column as the hold time the record is
entitled to. On classic IOS and on IOS XE the detail view prints `Time remaining` and **no** `Hold Time`
line: the Catalyst 3560 capture and four IOS XE guides all stop at the countdown and go straight to
`System Capabilities`. A paired IOS read - `Hold-time 120` in the table, `Time remaining: 106 seconds` in
the detail view for the same neighbour - shows the table and the countdown disagreeing on IOS itself.

**Inferred.** That the Cat3560's brief `120` was the TTL SW2 advertised rather than a second countdown
started at a different moment: the two reads are separate commands, not one instant, so a value of 120
could in principle be a freshly reset countdown. The field tables and the IOS XR pairing point the same
way, and 106 is exactly what a countdown would read for a record received 14 s earlier - but the
single-instant pairing that exists for IOS XR does not exist for IOS in this evidence set.

**Unresolved.**

* Whether any IOS or IOS XE image prints `Hold Time:` in `show lldp neighbors detail`. None of the five
  captures in hand does; the field is documented, printed and explained on IOS XR, so the safest reading is
  that it is an XR line, not an IOS one.
* The detail block's first line is platform-dependent: the Cat3560 opens with `Chassis id`, the IOS XE
  guides open with `Local Intf: Gi0/1/7`, and IOS XR opens with `Local Interface: ...` after a
  `Capability codes` legend and a dashed rule. Which line an IOS switch puts first is not settled by one
  capture.
* Whether the brief `Hold-time` cell ever shows anything but the configured value while the neighbour keeps
  announcing: the Cat3560 read is a single pair, so a `120` that falls only when a refresh is late (rather
  than never) is not excluded.

**What would settle the rest.** A timed triplet on a 15.x/17.x Catalyst with `lldp timer 30` (TTL 120):
`show lldp neighbors`, then `show lldp neighbors detail`, then a third read 40 s later without touching the
neighbour. A brief holding 120 across all three, with the detail value falling between them, is the IOS XR
result confirmed on IOS. A brief that had fallen to ~80 would refute it.

## The detail view: which of the two numbers IOS prints

The question this note left open was whether classic IOS has the detail view at all. It does, and the block
is the same shape as IOS XE's:

```
SW1# show lldp neighbors detail

Chassis id: 0011.bb0b.361a
Port id: Fa0/24
Port Description: FastEthernet0/24
System Name: SW2.cisco.com

System Description:
Cisco IOS Software, C3560 Software (C3560-ADVIPSERVICESK9-M), Version 12.2(46)SE, RELEASE SOFTWARE (fc2)
...
Time remaining: 106 seconds
System Capabilities: B,R
Enabled Capabilities: B
Management Addresses - not advertised
Auto Negotiation - supported, enabled
...
---------------------------------------------

Total entries displayed: 1
```

(NetworkLessons, Catalyst 3560, 12.2(46)SE.) The IOS XE block is identical in the relevant part:

```
Device1# show lldp neighbors detail
Local Intf: Gi0/1/7
Chassis id: 10.10.0.1
Port id: C8F9F9D61BC2:P1
Port Description: SW PORT
System Name: SEPC8F9F9D61BC2
System Description:
Cisco IP Phone 7962G,V12, SCCP42.9-3-1ES27S
Time remaining: 127 seconds
System Capabilities: B,T
Enabled Capabilities: B,T
Management Addresses:
IP: 10.10.0.1
```

(Cisco, Carrier Ethernet Configuration Guide, IOS XE Everest 16.6; the 16.11, 17.x and 3850 3SE guides
print the same block.) Neither has a `Hold Time:` line. IOS XR is the platform that prints both:

```
Time remaining: 102 seconds
Hold Time: 120 seconds
```

(8000 Series Ethernet Interface Commands.) So the two fields the IOS XR field table lists are not two
fields on IOS: the brief table's `Hold-time` cell is the only place the TTL appears in an IOS view, and the
detail view's `Time remaining` is the only countdown. For this model that means a detail view, if one were
ever added, would print `Time remaining` computed from `holdTimeS` and `heardAtMs` - and must not invent a
`Hold Time` line that IOS does not print.

## What was changed

Comments only, in the two places that asserted the countdown:

* `engine/lldp.js` - the TTL comment now says the vendor's brief column repeats the advertised hold time
  and points at this note for the countdown question.
* `test/lldp-hold-time.test.js` - the same sentence in the test's header, corrected for the same reason.

### Second pass (2026-11-20)

The open question above - whether classic IOS prints the detail view and which number it carries - was
settled by the Cat3560 and IOS XE captures added to the table, and one stale claim that the first pass
missed was corrected:

* `engine/device.js`, `lldpRows()`'s header comment said the vendor's `show lldp neighbors` "prints the
  time left as `Hold-time`" - the exact claim this note refutes. It now says the column repeats the
  advertised TTL and that the countdown is the detail view's `Time remaining` field.
* This note: the verdict, the evidence table, the known/inferred/unresolved split and the detail-view
  section above.

No engine behaviour changed: the ageing rule was already the TTL's, and no `Hold-time` column was added.
A column showing `holdTimeS` would now be unambiguous to add - the value would be the TTL, not a
countdown - but that is a layout change to a table that is not the vendor's table anyway (it prints
`Neighbour`/`Local port`/`Mgmt address`, not `Device ID`/`Local Intf`/`Capability`), so it is left as its
own question rather than smuggled in with a comment fix.
