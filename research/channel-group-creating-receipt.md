# `channel-group`: the line that says the bundle now exists

**Question (one, narrow).** When `channel-group <id> mode <mode>` gives a group its **first** port, what does a
Cisco-style switch print, exactly - how is the new interface spelled in that sentence, does it print for every
member or only the one that built the bundle, and does it print before the console's own confirmation?

**Verdict: settled, and adopted.** The box prints one line, `Creating a port-channel interface Port-channel 1`,
on the command that creates the interface and **not** on the ones that join it afterwards. PacketForge printed
nothing about creation at all: the one observable that says "the bundle now exists" - the object every table and
`show running-config` then name - was missing from the only command that produces it, and a reader could not tell
a group of one member from a typo that had done nothing.

## What PacketForge did

Measured on `abb01dc7` (main), 48-port `C2960X-48FPS-L`:

```
sw1(config)#interface Gi1/0/1
sw1(config-if)#channel-group 1 mode active
Interface Gi1/0/1 added to channel group 1 (mode active)
sw1(config)#interface Gi1/0/2
sw1(config-if)#channel-group 1 mode active
Interface Gi1/0/2 added to channel group 1 (mode active)
```

Two joins, two confirmations, no creation. `research/port-channel-in-interface-brief.md` had already recorded the
gap as item 10 and left it as "a second question": the brief table prints a `Port-channel1` row, the summary prints
`Po1(SU)`, and the command that made both said nothing about having made anything.

## Evidence

| Source | Says |
| --- | --- |
| [Cisco, *Configuring EtherChannel and 802.1Q Trunking Between Catalyst L2 Fixed Configuration Switches and CatOS* (doc 23408)](https://www.cisco.com/c/en/us/support/docs/switches/catalyst-4000-series-switches/23408-140.html) | The 2955 transcript, both members in one paste: `channel-group 1 mode active` -> `Creating a port-channel interface Port-channel 1`, then `interface fastethernet 0/10` / `channel-group 1 mode active` with **no** creation line. The same paste's syslog names the interface `Port-channel1` (`%LINK-3-UPDOWN: Interface Port-channel1, changed state to up`), so the receipt's space and the interface's name are two different spellings of one thing. |
| [Catalyst 2960 and 2960-S Software Configuration Guide, 12.2(55)SE, "Port-Channel Interfaces"](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/12-2_55_se/configuration/guide/scg_2960/swethchl.html) | "Use the **channel-group** interface configuration command. This command automatically creates the port-channel logical interface when the channel group gets its first physical port." The reason the receipt is once per group: the interface is created on the first port and every later port finds it. |
| [Catalyst 2960-X Layer 2 Commands, 15.2(4)E (consolidated command reference)](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_4_e/command_reference/b_1524e_consolidated_2960x_cr/b_1524e_consolidated_2960x_cr_chapter_0101.html) | The same rule in the `channel-group` Usage Guidelines: "For Layer 2 EtherChannels, the channel-group command automatically creates the port-channel interface when the channel group gets its first physical port. You do not have to use the interface port-channel command in global configuration mode to manually create a port-channel interface." |
| [0x2142, "L2 Basics: Configuring an EtherChannel" (2018)](https://www.0x2142.com/l2-basics-configuring-an-etherchannel/) | A modern (15.x-class) capture, in a range: `channel-group 1 mode active` -> `Creating a port-channel interface Port-channel 1`, and the syslog two lines later says `Interface Port-channel1, changed state to up` - receipt with the space, interface without it, in one session. |
| [NetAcad, *Packet Tracer - Configure EtherChannel*](https://contenthub.netacad.com/courses/srwe-dl/_common/6.2.4-packet-tracer---configure-etherchannel.pdf) | Teaching text states the observable as a check: "The message 'Creating a port-channel interface Port-channel 1' should appear on both switches when the channel-group is configured." The sentence is one the student is told to look for, which is what makes its absence in a simulator a teachable error and not a cosmetic one. |
| [Cisco doc 23408, second transcript (5-2950, IOS 12.1)](https://www.cisco.com/c/en/us/support/docs/switches/catalyst-4000-series-switches/23408-140.html) | The variance: `channel-group 1 mode desirable` -> `Creating a port-channel interface Port-channel1` - **no space**, on an older release. Its running-config spells the interface `interface Port-channel 1` (with a space), so the spellings are not stable in either direction across releases. |

Five captures, four of them Cisco's own, agree on the sentence, on once-per-group, and on the line arriving before
anything else. Only the space is contested, and it is contested inside a single Cisco document.

## What is inferred

* **The receipt is tied to creation, so a refused command must not print one.** No capture shows a refusal, but the
  sentence names an interface the refused command did not build; printing it before the refusal would claim
  exactly what the refusal denies.
* **A move that builds the target group prints it.** Doc 23408's rule is about the interface, and moving the last
  member of group 2 into a new group 3 creates `Port-channel3`; no capture of a move exists, so this follows the
  documented rule rather than a quoted transcript.
* **`mode on` prints it too.** The 0x2142 and doc 23408 captures cover `active` and `desirable`; the model's rule
  is creation, and `no interface port-channel` re-created with `channel-group 1 mode on` prints the line again in a
  lab transcript (studylib copy of a CCNP lab). Not a vendor page, so it is listed here as corroboration only.

## What remains unresolved

1. **The space, definitively.** 12.1 prints `Port-channel1`; 15.x prints `Port-channel 1`; one transcript's own
   running-config disagrees with its own syslog. The console adopts the spaced form because the modern captures
   are unanimous and the model speaks for 15.x-class boxes - but a 12.2/12.1 box would be more faithful without it,
   and this console keeps one sentence for the whole catalogue.
2. **`interface range`.** A box prints **one** receipt for a range that creates the bundle (`int range Eth0/0 - 1`
   in the 0x2142 capture). PacketForge has no `interface range`, so each member is its own command and the receipt
   attaches to the first - the same line, a different command count. Implementing a range is a command, not a
   wording fix, and is not part of this note.
3. **Re-creation after the group is emptied.** A box keeps `interface Port-channel1` until
   `no interface port-channel 1`, so emptying a group and refilling it prints nothing. This model's bundle exists
   only while it has members (`no channel-group` on the last member says "the group had no other members"), so the
   receipt returns. That is a consequence of the missing bundle object recorded as item 8 of
   `research/port-channel-in-interface-brief.md`, not a second spelling decision.
4. **What a stack prints.** No capture of `channel-group` on a stacked 2960X/9300 was found; the receipt's number
   is the channel-group number, and whether a stack prints the stack member anywhere in the line is unasked here.

## What changed

* `engine/lag.js`: `createReceipt(id)` next to `portChannelName()`/`portChannelIfaceName()`, so the one sentence
  whose spacing disagrees with the interface name is written where the names are, and cannot be rebuilt by hand
  somewhere else.
* `engine/cli.js` `_channelGroup()`: one line, pushed after every refusal and before the join confirmation, only
  when the group did not exist a moment ago (`!existing`).
* `test/channel-group-creating-receipt.test.js` (new, 22 checks): the sentence and the two spellings; receipt first,
  confirmation second, once only; no receipt on the second member, on a mode change, on a refused id, word, mode or
  full group; the group's own number; a move that creates its target; the empty-and-refill case; and that the line
  is a receipt and not configuration.
* `docs/CLI.md`: a "The first member creates the interface" subsection with the replayed transcript and both
  citations.

Totals: `npm test` — 393 suites, 13,190 assertions, 0 failed; `node scripts/syntax-check.js` — 473 files, all OK.
