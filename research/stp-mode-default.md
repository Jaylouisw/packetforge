# `show spanning-tree`'s first line: which protocol is a modelled Catalyst actually running?

**Question (one, narrow).** The console prints `Spanning tree enabled protocol ieee` on every device. Is
`ieee` — 802.1D PVST+ — the mode a modelled Catalyst is in *before any configuration*, and what does a real
box print on that line?

**Verdict: known, and not adopted.** Every Catalyst in this catalogue that Cisco documents at release
15.2(4)E or later — and every Catalyst 9000 — ships in **Rapid PVST+**, and a box in that mode prints
`Spanning tree enabled protocol rstp`. `ieee` is the word a **PVST+** box prints. PacketForge prints `ieee`
for all of them *and* times every port at two forward delays (30 s), which is the 802.1D PVST+ transition.
So both halves of the answer describe a mode Cisco stopped shipping as the default on the 2960-X in 2014 and
never shipped as the default on the 9000 series. No engine code changed: the remedy is a second protocol
mode — its transition rules, per-VLAN instances and a `spanning-tree mode` command — which is a feature, and
swapping the word alone would make the console claim RSTP while converging like 802.1D, which is a worse
answer than the one it gives now. Details below.

## What the vendor documents: the default mode

| Platform / release | Says | Source |
|---|---|---|
| Catalyst 2960-X, IOS 15.2(2)E | `Spanning-tree mode` default **PVST+** — "PVST+ ... is the default spanning-tree mode used on all Ethernet port-based VLANs" | [Layer 2 Configuration Guide, 15.2(2)E](http://cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_2_e/layer2/configuration_guide/b_layer2_1522e_2960x_cg/b_layer2_1522e_2960x_cg_chapter_01.html) |
| Catalyst 2960-X, IOS 15.2(5a)E | Table 3 gives `Spanning-tree mode` = **Rapid PVST+**, with the note "**Beginning in Cisco IOS Release 15.2(4)E, the default STP mode is Rapid PVST+**" | [Consolidated Platform Configuration Guide, 15.2(5a)E](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_5a_e/configuration_guide/b_1525ae_consolidated_2960x_cg/b_1525ae_consolidated_2960x_cg_chapter_01111.html) |
| Catalyst 2960-X, IOS 15.2(7)E | Same table, same note | [Consolidated Platform Configuration Guide, 15.2(7)E](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_7_e/configuration_guide/b_1527e_consolidated_2960x_cg/m_lay2_stp_cg_old.html) |
| Catalyst 9200, IOS XE 17.18.x | "Rapid PVST+ is the default STP mode on your device"; Table 3 row `Spanning-tree mode` = **Rapid PVST+ (PVST+ and MSTP are disabled)**; "By default, the device runs the Rapid PVST+ protocol" | [Layer 2 Configuration Guide, 17.18.x](https://cisco.com/c/en/us/td/docs/switches/lan/catalyst9200/software/release/17-18/configuration_guide/lyr2/b_1718_lyr2_9200_cg/configuring_spanning_tree_protocol.html) |

The 9200's own default table is also where the trap is: `Hello time 2 s`, `Forward-delay 15 s`,
`Maximum-aging time 20 s` — **the same three numbers in both modes**. RSTP kept the 802.1D timer values and
changed what a port does with them, so a timer table cannot tell you which mode a box is in, and neither can
a convergence figure that only counts forward delays.

## What the box prints, in each mode

| Mode | First line | Evidence |
|---|---|---|
| Rapid PVST+ (802.1w) | `Spanning tree enabled protocol rstp` | Cisco Press, *Spanning Tree Configuration*: "The statement 'Spanning tree enabled protocol rstp' indicates that S1 is running Rapid PVST+." ([ciscopress.com](https://www.ciscopress.com/articles/article.asp?p=2832407&seqNum=6)) |
| Rapid PVST+ on the 9000 series | the same | Cisco's own loop-troubleshooting note for the Catalyst 9200/9300 family: four captures, `ACCESS-SWITCH1`, `ACCESS-A`, `DISTRO-A` and `CORE`, every one of them opening `VLAN0001` / `Spanning tree enabled protocol rstp` ([doc 221191](https://www.cisco.com/c/en/us/support/docs/switches/catalyst-9200-series-switches/221191-troubleshoot-layer-2-loops.html)) |
| Rapid PVST+ on the 2960-X | the same | *Configuring Optional Spanning-Tree Features*, 15.2(6)E: `Switch#show spanning-tree vlan 200` gives `VLAN0200` / `Spanning tree enabled protocol rstp` ([PDF](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15_2_6_e/configuration_guide/b_1526e_consolidated_2960x_cg/m_lay2_stpopt_cg_old.pdf)) |
| PVST+ (802.1D) - the mode this console prints | `Spanning tree enabled protocol ieee` | this console, `engine/cli.js:5843` |

One further detail in those captures is a question of its own and is **not** part of this one: the 9000
series prints a `VLAN0001` heading and a per-VLAN block, while this console prints one tree for the device
(the per-VLAN spelling is refused by design, `docs/CLI.md` "Setting the root").

## What PacketForge does today (measured in this worktree)

Three devices, one fresh session each, `enable` only - no configuration:

```
C9200L-24T-4G    Spanning tree enabled protocol ieee   ...   converge: 30000 ms
C2960X-24TS-L    Spanning tree enabled protocol ieee   ...   converge: 30000 ms
C9300-24T        Spanning tree enabled protocol ieee   ...   converge: 30000 ms
generic-switch   Spanning tree enabled protocol ieee   ...   converge: 30000 ms
```

Census of the catalogue: **17** models matching `C9[23]00*` and **2** `C2960X*`, all of which answer `ieee`
and 30 s. The two halves come from different files and agree with each other, which is why neither looks
wrong on its own:

* the word is a literal - `engine/cli.js:5843`;
* the duration is `2 x forward delay` - `engine/convergence.js:18` ("one forward-delay each (802.1D
  defaults: 15 s + 15 s)") and `:29` ("802.1D defaults (§17.14)"), surfaced as the `basis` string
  `listening + learning (15 s forward-delay each)`.

`docs/CONVERGENCE.md` says this out loud - "Only 802.1D timers are modelled: RSTP's sub-second
proposal/agreement is not, so a simulated re-convergence costs the same 30 s as a boot" - and
`docs/SIMULATION.md` §2.4 lists RSTP/MSTP/PVST/PVRST as **Absent**. What no page says is that the *word on
the first line* is a claim about the mode, and that the claim is wrong for the platforms the catalogue
models. Only one test touches the line at all, and it checks that the command runs
(`test/l2.test.js:205`, `/Spanning tree enabled/`), so nothing pins `ieee`.

## Known, inferred, unresolved

**Known.** The default mode per platform and release (tables above); the word each mode prints on a
Catalyst; that the 802.1D timers survive unchanged into Rapid PVST+.

**Inferred.** That a Catalyst 9300 at 17.x is in Rapid PVST+ for the same reason the 9200 is - Cisco's
9300 guide states it, but the 9300 default table itself was not opened for this note, so the 9300 row is
carried by the 9200 evidence and by its captures in doc 221191 rather than by its own table.

**Unresolved, and this is the part that blocks an implementation.**

1. **What a 9200 does with an edge port at boot, in seconds.** RSTP's proposal/agreement makes a
   point-to-point port forward in the order of a couple of seconds, and no capture with timestamps was
   found to pin it. 30 s is certainly wrong for the default mode; "2 s" would be a guess.
2. **Whether `spanning-tree mode pvst` changes the printed word to `ieee`.** Very likely, and unsourced:
   no capture of the same box in both modes was found.
3. **Whether the 9000 series prints a bare block with no `VLAN0001` heading in any view.** Every capture in
   hand is per-VLAN.

**What would settle it.** A boot-to-forwarding capture from a Catalyst 9200 or 2960-X at a release at or
after 15.2(4)E, default configuration, with `show spanning-tree` taken before the first port forwards and
again after: the word settles 2, the timing settles 1. Then `spanning-tree mode pvst` on the same box, and
the same command again.

## Why no engine code changed

1. **The word and the duration are one claim.** Printing `rstp` while keeping `2 x forward delay` would say
   "I am RSTP" and then converge like 802.1D - and because RSTP re-uses the same hello/max-age/forward-delay
   numbers, no timing test could catch the mismatch. Fixing the word without the model makes the console
   less truthful, not more.
2. **The model is the feature.** RSTP transition rules (edge immediate, P2P proposal/agreement, sync),
   per-VLAN instances and a `spanning-tree mode` command are additions, and this loop is barred from adding
   features. `docs/SIMULATION.md` §2.4 and `docs/CONVERGENCE.md` already declare the gap; this note is the
   missing half of that declaration - that the *default* of the modelled platforms is the mode the model
   does not have.
3. **The catalogue cannot answer it per device anyway.** The 2960-X changed its default mid-life
   (15.2(2)E PVST+, 15.2(4)E Rapid PVST+), and a device entry carries no software release. So the smallest
   correct slice needs a new field - `stpDefaultMode`, or a `softwareVersion` the mode can be derived from -
   before any engine line can consult it.

## One adjacent observation, recorded not acted on

The 9200's default port-cost row in the same table is the **long** method's numbers (1 Gb = 20000,
10 Gb = 2000), while the 2960-X 15.2(2)E table is the **short** method's (1 Gb = 4, 100 Mb = 19).
`engine/stp.js` implements the short table, pinned for the Catalyst class by `research/stp-path-cost.md`.
That is a second default that differs between the platforms in this catalogue, found in the same table, and
it deserves its own question rather than being folded into this one.
