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
`Time remaining` and `Hold Time`, one view apart.

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
| [Cisco NCS 4000 command reference, LLDP](https://www.cisco.com/c/en/us/td/docs/routers/ncs4000/software/reference/guide/otncommandreferenceguide/m-lldp.html) | Field tables for both views. Brief: `Hold Time` - "Time (in seconds) that the local device will hold the LLDP advertisement from a sending device before discarding it." Detail: `Time remaining` - "Displays the remaining time", and separately `Hold Time` - "the time or duration in seconds that an LLDP device maintains the neighbor information before discarding." Two fields, two names, one view each. Its sample output also prints `Total entries displayed: 1`. |
| [Cisco 8000 IOS XR Interface and Hardware Component Command Reference (PDF)](http://www.cisco.com/c/en/us/td/docs/iosxr/cisco8000/Interfaces/b-interfaces-hardware-component-cr-8000.pdf) | The same brief field table word for word, and a sample row whose `Hold-time` is `150` (`R1 Et1/0 150 R Et1/0`) - a number no local countdown could start from unless the sender advertised it. |
| [Catalyst 2960 software configuration guide 12.2(44)SE, Configuring LLDP](http://cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/12-2_44_se/configuration/guide/scg1/swlldp.html) | `show lldp neighbors` "Display information about neighbors, including device type, interface type and number, **holdtime settings**, capabilities, and port ID", with `lldp holdtime` default 120 s and `lldp timer` 30 s. The command is described as reporting the setting, not a live remainder - weaker than the paired transcript, but not contradictory. |
| IEEE 802.1AB-2016 §8.5.4 (quoted in `engine/lldp.js`) | The TTL TLV is "the number of seconds that the recipient LLDP agent is to regard the information associated with this MSAP identifier to be valid" - the sender's claim about validity, i.e. the number the brief column repeats. |

## What is known, inferred, unresolved

**Known.** On IOS XR the brief column is the advertised TTL and the countdown lives in the detail view as
`Time remaining`. Three command references define the brief column as the hold time the record is entitled
to, and one transcript shows the two views disagreeing by design (120 vs 116/90) on the same box.

**Inferred.** Classic IOS on a Catalyst behaves the same way: its field tables use the same words and no
Catalyst transcript printing both views of one neighbour at different instants was found. This is the
weakest link, and it is the one that matters here, because this model's switches are Catalyst-shaped.

**Unresolved.** Whether classic IOS prints `Time remaining` in `show lldp neighbors detail` at all - the
field is documented for IOS XR and for NX-OS-style CLIs, and older 12.2 Catalyst detail output that this
repository has seen does not carry it. A simulator that added a detail view would need that answer first,
and would still be adding a view, not fixing one.

**What would settle it.** On any Catalyst running 15.x or 17.x with `lldp timer 30` (TTL 120): read
`show lldp neighbors`, wait 40 s without touching the neighbour, read it again, then read
`show lldp neighbors detail`. Brief holding 120 across both reads, with the detail line below it, is the
IOS XR result confirmed on IOS. A brief value that had fallen to ~80 would refute it and make the
countdown the right number to print.

## What was changed

Comments only, in the two places that asserted the countdown:

* `engine/lldp.js` - the TTL comment now says the vendor's brief column repeats the advertised hold time
  and points at this note for the countdown question.
* `test/lldp-hold-time.test.js` - the same sentence in the test's header, corrected for the same reason.

No engine behaviour changed: the ageing rule was already the TTL's, and no `Hold-time` column was added.
A column showing `holdTimeS` would now be unambiguous to add - the value would be the TTL, not a
countdown - but that is a layout change to a table that is not the vendor's table anyway (it prints
`Neighbour`/`Local port`/`Mgmt address`, not `Device ID`/`Local Intf`/`Capability`), so it is left as its
own question rather than smuggled in with a comment fix.
