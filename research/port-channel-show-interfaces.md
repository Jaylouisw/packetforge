# `show interfaces Port-channel1`: the bundle's own block, and what this console said instead

**Question (one, narrow).** A switch that has built an EtherChannel has an interface whose name is
`Port-channel1`. What does `show interfaces Port-channel1` print - and, since this console prints no block
for one, what must it say when the name is typed? It said `% No interface Port-channel1 on <box>`, the
sentence a misspelt *physical* port gets, about an interface two other views in the same session print
(`show ip interface brief` lists a `Port-channel1` row; `show etherchannel summary` lists `Po1(SU)`).

**Verdict: the bundle has a block of its own, headed `Port-channel1 is up, line protocol is up`, carrying a
`Members in this channel: <ports>` line and a bandwidth that is the sum of its members. PacketForge has no
such block. This run did not add one - it changed the refusal so it stops calling an existing interface
missing, and records what the block must contain for the run that does add it.**

## Evidence

| Source | What it prints |
| --- | --- |
| [Cisco, *Cross-Stack EtherChannel on a Catalyst 3750 Switch Configuration Example* (doc 69979, IOS)](https://www.cisco.com/c/en/us/support/docs/switches/catalyst-3750-series-switches/69979-cross-stack-etherchannel.html) | `3750switchstackA#show interfaces port-channel 1` → `Port-channel1 is up, line protocol is up (connected)` / `Hardware is EtherChannel, address is 0015.c6c1.3003 (bia 0015.c6c1.3003)` / `MTU 1500 bytes, BW 300000 Kbit, DLY 100 usec,` / `Full-duplex, 100Mb/s, link type is auto, media type is unknown` / **`Members in this channel: Gi1/0/4 Gi1/0/5 Gi2/0/3`**. Three 100 Mb/s members, and `BW 300000 Kbit` - the block's rate is the aggregate, not one member's. The same page's `show etherchannel summary` reads `1 Po1(SU) - Gi1/0/4(P) Gi1/0/5(P) Gi2/0/3(P)` and later `1 Po1(SU) LACP Gi1/0/4(P) Gi1/0/5(P) Gi2/0/3(P)` - one bundle, printed under both protocol words by the same page. |
| [Cisco, *EtherChannel Between Catalyst 3550/3560/3750 Series Switches and Catalyst 6500/6000* (doc 12033-89)](https://www.cisco.com/c/en/us/support/docs/lan-switching/etherchannel/12033-89.html) | `Cat3550#show interface port-channel 1` → `Port-channel1 is up, line protocol is up` (no `(connected)` suffix on this release) / `Hardware is EtherChannel, address is 0002.4b28.db02 (bia 0002.4b28.db02)` / `MTU 1500 bytes, BW 200000 Kbit, DLY 1000 usec,` / **`Members in this channel: Gi0/1 Gi0/2`**; and `Cat6500#show interface port-channel 1` → `Members in this channel: Fa3/1 Fa3/2`, `BW 200000 Kbit`. Two 100 Mb/s members again, `BW 200000`. Both blocks sit beside `show etherchannel 1 summary` → `1 Po1(SU) Gi0/1(P) Gi0/2(P)`. |
| [Cisco, *Sample Configuration: EtherChannel Between Catalyst Switches Running CatOS and Cisco IOS Software* (doc 12029-71, PDF)](https://www.cisco.com/c/en/us/support/docs/lan-switching/etherchannel/12029-71.pdf) | `Cat6509# show interfaces port-channel 1` → `Port-channel1 is up, line protocol is up` / `Hardware is EtherChannel, address is 0009.1267.27d9 (bia 0009.1267.27d9)` / `Full-duplex, 100Mb/s` / **`Members in this channel: Fa6/1 Fa6/2`**. The page's own caption: "This command checks the status of the port channel. It also tells you which ports form this channel." |
| [Cisco, *Interface and Hardware Component Command Reference* (IOS XE 3SE, PDF)](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/interface/command/ir-xe-3se-3850-cr-book.pdf) | the router-side spelling of the same line: `No. of active members in this channel: 4` / `Member 0 : Fast Ethernet1/0/0` / `Member 1 : Fast Ethernet1/1/0` … - one member per line, and the count is of **active** members. So "which ports form this channel" is a field with two shapes, one per platform family. |

## What is known

1. The bundle is an interface with a block of its own, and the block's status line is the same
   `is up, line protocol is up` form a physical port uses.
2. The block names its members on one line on Catalyst switches, space-separated, in the shortened type
   spelling the `show etherchannel summary` Ports column also uses (`Gi1/0/4`, not
   `GigabitEthernet1/0/4`).
3. The block's `BW` is the sum of the members' rates (3 x 100 Mb/s -> `300000 Kbit`; 2 x 100 Mb/s ->
   `200000 Kbit`), not one member's rate and not the port-channel's configured cap.
4. The block carries a hardware address (`Hardware is EtherChannel, address is <mac> (bia <mac>)`), so a
   bundle is addressable in a way a bare name is not.

## What is inferred, not known

5. **The `(connected)` suffix is generation-dependent.** The 3750 sample has it, the 3550 and 6500 samples
   of the same command do not. Nothing in the pages read explains the split; this note does not pick one.
6. **The member line lists bundled members, not every configured member.** Every sample read has all
   members `(P)` in the summary printed beside the block, so no capture shows a configured-but-standalone
   member `(I)` or a suspended one `(s)` in this line. The router form's word is *active* members, which
   suggests the line counts what is carrying traffic, but the switch form's wording (`Members in this
   channel`) does not say so.

## Unresolved

7. **A partial bundle.** No transcript read shows `show interfaces Port-channel1` while one member is
   `(I)`/`(s)` in `show etherchannel summary`: does the line list it, drop it, or list it with a marker?
   This is the one question that decides whether the line can be derived from `_lagMemberStates().live`.
8. **Bare `show interfaces`.** No sample read shows whether a box with a bundle prints the Port-channel
   block in the bare listing, and if so where (before the members, after them, or at the end). IOS orders
   interfaces by type then number, which would put `Port-channel` before `Vlan` and after the physical
   types; no capture in hand proves it for this command.
9. **Whether a member's own block names the bundle.** None of the samples read shows the member's block,
   and this console already prints its own `channel-group <id> mode <mode>` line there (engine/cli.js:7004),
   which is this model's line rather than a quoted one.
10. **Where the bundle's MAC comes from.** The samples show a MAC and a `bia` equal to it; none shows which
    member's address it was borrowed from.

## What PacketForge does today

Measured on this branch, two-switch LACP bundle (1/1/1 + 1/1/2, `channel-group 1 mode active`, both ends):

```
s1#show etherchannel summary
1      Po1(SU)         LACP      1/1/1(P) 1/1/2(P)
s1#show ip interface brief
...
Port-channel1          unassigned      YES unset  up                    up
s1#show interfaces                 <- 30 physical blocks, no Port-channel1 block
s1#show interfaces Po1
% No interface Po1 on <box>
s1#show interfaces Port-channel1
% No interface Port-channel1 on <box>
s1#show interfaces Port-channel 1
% No interface Port-channel 1 on <box>
```

Three views name the bundle and the view that would describe it says it does not exist. The
`No interface` sentence is the one a typo gets, so an operator who typed a name they had just read off
`show etherchannel summary` went looking for a spelling mistake.

## What this run changed

The refusal now recognises the two spellings a bundle has (`Po1`, `Port-channel1`/`Port-channel 1`) when a
group with that id is configured, and answers with the noun and the command that does print it:

```
s1#show interfaces Po1
% Port-channel1 is an EtherChannel bundle: this console has no block for one. `show etherchannel summary` lists the bundle and the ports that carry it.
```

(replies to `Po1`, `po1`, `Port-channel1`, `Port-channel 1`, `port-channel 1` and `portchannel1` alike; the long
form is used in the answer whatever was typed, because the answer is about the interface.)
`test/port-channel-name-refusal.test.js` locks the spellings, the unbundled-name case, the near-miss names
(`pod1`, `po`, `po-1`), that no block is invented, and that the member block, `show running-config`,
`show etherchannel summary` and `show ip interface brief` still print what they printed.

A name whose group is not configured still gets `% No interface ...`, which is true. No block was printed:
items 7-10 above decide its content, and two of them (the partial bundle and the bare-listing order) have no
evidence in hand. The naming gap is the same one `research/mac-table-port-channel-name.md` item 6 records -
a bundle is not a port object in this model - and this change deliberately does not close it.

## Evidence that would settle 6-10

On one Catalyst with a three-member bundle: `show interfaces Port-channel1` and `show etherchannel summary`,
then shut one member and print both again (does the line keep it?), then `show interfaces` and note where the
Port-channel block sits relative to the physical blocks, then `show interfaces Gi1/0/4` on a member. One
session answers all five.
