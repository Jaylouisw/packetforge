# A 100BASE-FX port's duplex before anyone configures it

**Question (one, narrow).** On a box of the family this console imitates, what duplex does a 100BASE-FX
SFP port start in — `auto`, which this model resolves to full, or `half`? The answer decides what
`show interfaces` prints for a fibre Fast Ethernet port that has never been configured, and whether
`show running-config` owes a `duplex` line on it.

**Verdict: `half`, and the default is stated per medium, not per platform.** Two releases of the same
vendor chapter say it in the same words, and three field transcripts show the port reading
`Half-duplex, 100Mb/s, media type is 100BaseFX SFP` on hardware nobody had configured. No engine code
changed: the four 100BASE-FX ports in this catalogue belong to Moxa, Planet, TP-Link and Trendnet, and
applying an IOS default to those boxes would be inventing *their* default. The rule is recorded here so
the first Cisco 100BASE-FX part (a 2960 with a GLC-FE-100FX, say) lands with it already written down.

## What the vendor says, verbatim

Both the Catalyst 2960-X 15.2(6)E and 15.2(7)E Interface and Hardware Commands chapters carry one
`duplex` page, identical in this section:

```
duplex {auto | full | half}
no duplex {auto | full | half}
```

* Command Default: "The default is **auto** for Fast Ethernet and Gigabit Ethernet ports."
* Command Default: "The default is **half** for 100BASE*-x* (where *-x* is -BX, -FX, -FX-FE, or -LX)
  SFP modules."
* Command Default: "**Duplex options are not supported** on the 1000BASE*-x* or 10GBASE*-x* (where *-x*
  is -BX, -CWDM, -LX, -SX, or -ZX) small form-factor pluggable (SFP) modules."
* Syntax Description, `half`: "Enables half-duplex mode (only for interfaces operating at 10 or 100 Mb/s).
  You cannot configure half-duplex mode for interfaces operating at 1000 or 10,000 Mb/s."

So there are three lanes, not one: 10/100/1000 copper is **auto**; a 100BASE-x fibre optic is **half**;
a 1000BASE-x or 10GBASE-x optic has no duplex setting at all. The 15.2(2)E PDF of the same chapter prints
the same three sentences, and the configuration guide for the same release adds the counterpart rule for
copper SFPs — the 1000BASE-T SFP "support[s] the same speed and duplex options as the 10/100/1000-Mb/s
ports" — which is what makes the rule a property of the *optic* rather than of the cage.

## The field transcripts

| Source | Says |
| --- | --- |
| [Cisco community, "Half duplex connections"](https://community.cisco.com/t5/routing/half-duplex-connections/td-p/1340469) | "The GLC-FE-100FX does not support autonegotiation and **is set at 100/half by default**. In order to set the duplex to full, you must first use the `media-type sfp` command on the 2960, and then set the duplex to full." Then `Switch(config-if)#duplex ?` → `full Force full duplex operation` / `half Force half-duplex operation`. |
| [Cisco community, "WS-C3650-24TS and GLC-GE-100FX problem"](https://community.cisco.com/t5/switching/ws-c3650-24ts-and-glc-ge-100fx-problem/td-p/3356726) | A 3650 with a 100FX SFP: `Half-duplex, 100Mb/s, link type is auto, media type is 100BaseFX SFP`; the operator's own note: "I already checked half-duplex, **it was by default**." After `duplex full` the same port reads `Full-duplex, 10Mb/s` in the paste (a typo for 100 in a forum paste, but the duplex word is the point). `show interfaces ... capabilities` on the same port: `Type: 100BaseFX SFP / Speed: 100 / Duplex: full,half` — both modes offered, unlike a 1000BASE-x cage. |
| [Cisco community, "GLC-FE-100FX SFP causing Half Duplex"](https://community.cisco.com/t5/switching/glc-fe-100fx-sfp-causing-half-duplex/td-p/720855) | A 3560 with a `100BaseFX-FE SFP`: `Half-duplex, 100Mb/s, link type is auto, media type is 100BaseFX-FE SFP`, against a copper end at full; the mismatch is the symptoms' cause. |
| [Cisco community, "WS-C2960-24TC-L Bug"](https://community.cisco.com/t5/switching/ws-c2960-24tc-l-bug/td-p/1100803) | The same rule stated as a platform family fact: "the default setting is 'half' for the Cat4000/4500 100-Mbps fiber modules". |

None of these is a lab capture with a clock on it, so the *value* is testimony rather than measurement —
but three independent threads reporting the same word for three different parts, plus the vendor's own
per-medium default, is enough to state the rule.

## What PacketForge does today

* `Interface.duplex` is `'full'` for every port of every device (`engine/device.js:114`) — no medium is
  consulted, so a 100BASE-FX port and a 10GBASE-R port start the same way.
* `show interfaces <port>` prints `, duplex: full` from that field (`engine/cli.js:6061`).
* `show running-config` prints `duplex <mode>` only when it differs from `'full'` (`engine/cli.js:7979`),
  which is the rule a fix would have to generalise: the line a box omits is the one that matches *this
  medium's* default, not the string `full`.
* `duplex half` on a 100BASE-FX port is accepted today: the half-duplex gate refuses only when the port's
  top rate is above 100 Mb/s (`engine/cli.js:3603-3613`), and a 100FX port's top rate is 100.
* The STP `Type` cell already derives `Shr` from half duplex (`engine/cli.js:7352`,
  `stpLib.stpTypeCell`), so a port that really defaulted to half would print the `Shr` a box prints.
* The validator already warns when the two ends disagree (`engine/validation.js:889-897`,
  `W_DUPLEX_MISMATCH`), which is the real consequence of a 100FX port at half facing a copper end at
  full.

## Why no code changed

The four devices in this catalogue that carry a 100BASE-FX port are `moxa/eds-4008-2msc-lv-t` (`fx1`,
`fx2`: `connector: sc-upc`, `speedCaps: [100]`), `planet/gt-805a`, `tp-link/mc220l` and
`trendnet/tfc-1000mga`. None is a Cisco, and no Moxa, Planet, TP-Link or Trendnet manual in hand states
that vendor's own default for a fibre port. Writing the IOS default into `Interface` would therefore
change four devices on the strength of a document that is not about them — the same mistake the
catalogue work has refused for PoE budgets and port layouts. What is needed first is either one Cisco
100BASE-FX port in the catalogue (then the rule has a device it is true of) or one page per vendor
stating the default, at which point the rule belongs in the port's hardware derivation rather than in
`Interface`'s constructor.

## By-product: `duplex nonegotiate` is not a keyword

The same page closes an open item in `research/speed-duplex-grammar.md`. Every `duplex` page read for
this note — Catalyst 3550 12.2(25)SEE (the 12.2 train that item asked for), five releases of the 2960-X
book (15.2(2)E, (4)E, (5)E, (6)E, (7)E), Catalyst 1000 15.2(7)E, Catalyst 3850 3SE, Catalyst 9300 16.8
and Nexus 5000 — prints `duplex {auto | full | half}` and nothing else. The only `nonegotiate` in the
chapter belongs to **`speed`**, and only on a 1000BASE-x SFP port ("The `nonegotiate` keyword is
available only for SFP module ports"). So the reported "older 2960 pages list `nonegotiate` on both
commands" has no page behind it in hand: this console's `% Usage: duplex auto | full | half` is right in
substance, and what the hardware prints for the word is `% Invalid input detected at '^' marker.` — the
caret question, which `research/parse-error-caret.md` settled as a deliberate product decision.

## What is inferred, not measured

1. **That the rule follows the optic, not the cage.** The command reference says "100BASE-x SFP modules";
   the configuration guide says a 1000BASE-T SFP offers the copper set. A cage that can hold either
   therefore has no single default — the inserted optic decides. This model has no per-port "optic
   inserted" state, so a cage port could not carry the rule even with a Cisco device present.
2. **That `show interfaces` prints `Half-duplex, 100Mb/s` with no link.** Every transcript above has a
   link up. A box also prints `Auto-duplex, Auto-speed` for an unlinked auto port (the 2960-X pair in
   `research/duplex-autoneg-fallback.md`); no capture shows the unlinked half port's wording.
3. **That `speed` on the same port is `100` rather than `auto`.** The transcripts show `100Mb/s` on the
   line, but whether that is a configured rate or a fixed one is not separable from a single paste.

## What remains unresolved, and what would settle it

* **Each vendor's own default for these four ports.** One port-configuration page (Moxa EDS-4008 user's
  manual, "Port Settings"; Planet GT-805A; TP-Link MC220L; Trendnet TFC-1000MGA) per device. Any of them
  that says "Auto" ends the question for that device; any that says "100 Full" would make this
  catalogue's current `full` right for the wrong reason.
* **Whether a dual-purpose uplink needs `media-type sfp` before `duplex` is accepted.** Two threads say
  yes on a 2960/3560 — `duplex full` is refused until the media type is set to `sfp`. This model has
  combo ports (`comboWith`/`comboRole`) but no `media-type` command, so nothing can express it. A 2960
  transcript of `interface gi0/1` → `duplex full` before and after `media-type sfp` would settle the
  refusal wording, and is a separate question from this one.
* **Whether every IOS XE image prints the same three default sentences.** 15.2(2)E, (6)E and (7)E do; the
  CAT9K 16.8 book's `duplex` page was read only for its syntax line.

## Sources

* Catalyst 2960-X 15.2(6)E, Interface and Hardware Commands, `duplex` (syntax + Command Default):
  <http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15_2_6_e/command_reference/b_1526_2960x_cr/interface_and_hardware_commands.html>
* Catalyst 2960-X 15.2(7)E, same chapter:
  <https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_7_e/command_reference/b_1527_2960x_cr/interface_and_hardware_commands.html>
* Catalyst 2960-X 15.2(2)E, Interface and Hardware Components Command Reference (PDF), `duplex`:
  <http://cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_2_e/int_hw_components/command_reference/b_int_1522e_2960x_cr.pdf>
* Catalyst 2960-X 15.2(4)E configuration guide, "Configuring Interface Characteristics" (nonegotiate is a
  `speed` keyword only; 1000BASE-T SFPs share the copper options):
  <http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_4_e/configurationguide/b_1524e_consolidated_2960x_cg/b_1524e_consolidated_2960x_cg_chapter_010.pdf>
* Catalyst 3550 12.2(25)SEE command reference, `duplex` (`duplex {auto | full | half}`, "You cannot
  configure duplex mode on GBIC interfaces"):
  <https://www.cisco.com/c/dam/en/us/td/docs/switches/lan/catalyst3550/software/release/12-2_25_see/command/reference/3550CR.pdf>
* Catalyst 3850 3SE interface guide (`duplex {auto | full | half}`, nonegotiate under `speed` only):
  <http://cisco.com/c/en/us/td/docs/switches/lan/catalyst3850/software/release/3se/int_hw_components/configuration_guide/b_int_3se_3850_cg.pdf>
* Catalyst 9300 16.8 command reference, `duplex`:
  <https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/16-8/command_reference/b_168_9300_cr.pdf>
* Nexus 5000 interface command reference, `duplex`:
  <https://www.cisco.com/c/en/us/td/docs/switches/datacenter/nexus5000/sw/command/reference/interfaces/N5k_if_cmd_ref/n5k_if_cmds_d.html>
