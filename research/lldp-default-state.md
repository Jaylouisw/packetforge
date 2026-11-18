# LLDP before anyone configures it: is it running, and what does `show lldp` answer?

**Question (one, narrow).** On a real Cisco-style access switch, what is the administrative default state of
LLDP, and what exactly does `show lldp` print *before* LLDP has been enabled?

**Verdict: unresolved as a single rule.** The vendor documentation says LLDP is off by default; field reports
and one vendor's own manual say otherwise; and no source gives a per-platform answer. Nothing in the engine was
changed.

## What PacketForge does today

Verified by running the engine (two Catalyst 2960s, one cable, `sim.refreshNeighbours()`):

```
sw1# show lldp
LLDP neighbours on Catalyst 2960-sw1:
  Neighbour          Local port  Port ID  Mgmt address
  Catalyst 2960-sw2  Fa0/1       Fa0/1    -
```

`show lldp neighbors` prints byte-identical text. Three properties follow from the code:

* **Every device announces, always.** `Simulator.announceLldp()` (`engine/simulator.js:2317`) walks
  `dev.activeInterfaces()` and skips only ports that are unplugged or are subinterfaces. There is no
  global off-switch, no `lldp run`, no per-interface transmit/receive, and `Device` always constructs the
  neighbour map (`this.lldp = new Map()`, `engine/device.js:199`).
* **`show lldp` is the neighbour table**, not a status view (`engine/cli.js:3672-3688`); the two forms are
  aliased, and `docs/CLI.md` section "Reading `show lldp`" documents that as the shape.
* **The advertised hold time is 120 s** (`DEFAULT_TTL_S`, `engine/lldp.js:12`). No transmission timer is
  modelled: announcements happen at the start of a run, not every N seconds.

## Evidence

| Source | Says |
| --- | --- |
| [Catalyst 2960 config guide 12.2(44)SE, Configuring LLDP](http://cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/12-2_44_se/configuration/guide/scg1/swlldp.html) | Default table: `LLDP global state - Disabled`, `LLDP interface state - Disabled`, `LLDP transmit - Disabled`, `LLDP receive - Disabled`; holdtime 120 s, timer 30 s, reinit delay 2 s. "LLDP is disabled by default." |
| [Catalyst 9600 17.18 config guide (PDF)](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9600/software/release/17-18/configuration_guide/int_hw/b_1718_int_and_hw_9600_cg/configuring_lldp__lldp_med__and_wired_location_service.pdf) | Same default table, same values, fifteen years later - and `show lldp` is described as "global information, such as frequency of transmissions, the holdtime ... and the delay time before LLDP initializes", **not** neighbours. |
| [Cisco field notice: unknown-protocol drops on Catalyst 9000](https://www.cisco.com/c/en/us/support/docs/switches/catalyst-9300-series-switches/224586-troubleshoot-unknown-protocol-drops-in.html) | Both halves of the observable on IOS-XE switches: `C9500-1#show lldp` -> `Global LLDP Information:` / `Status: ACTIVE` / "advertisements are sent every 30 seconds" / "hold time advertised is 120 seconds" / "reinitialisation delay is 2 seconds"; and `C9300#show lldp` -> `% LLDP is not enabled`. |
| [NX-OS 9000 System Management guide 10.2(x)](https://cisco.com/c/en/us/td/docs/dcn/nx-os/nexus9000/102x/configuration/system-management/cisco-nexus-9000-series-nx-os-system-management-configuration-guide-102x/m-configuring-lldp.html) | Requires `feature lldp`; "LLDP is disabled by default." |
| [IOS-XR 8000, Enable LLDP globally](https://www.cisco.com/c/en/us/td/docs/iosxr/cisco8000/interfaces-and-hardware-component/configuration-guide/interfaces-and-hardware-component-config-cisco8000/lldp-overview/enable-lldp-globally.html) | The same refusal string from a router OS: `% LLDP is not enabled`. |
| [Arista EOS LLDP chapter](https://www.arista.com/en/um-eos/eos-link-layer-discovery-protocol) | "The `lldp run` command globally enables LLDP"; "When enabling LLDP, it is enabled on all interfaces by default." |
| [Arista EOS CVX chapter](https://www.arista.com/en/um-eos/eos-cloudvision-exchange-cvx) | The contradiction, in Arista's own words: "ensure that LLDP is enabled on each client switch using the `lldp run` command" **and** "Note: LLDP is enabled by default on Arista switches." |
| [NetworkJutsu, "Link Layer Discovery Protocol"](https://networkjutsu.com/lldp/) (practitioner transcript) | "While CDP is enabled by default, LLDP is not - at least that's what it says on Cisco's documentation. When I tried it on a Catalyst 3750, the LLDP was globally enabled by default." Transcript of the off case: `Switch>sho lldp neigh` -> `% LLDP is not enabled`. |

## What is known

1. The enabling command is global and separate from any interface config (`lldp run` on IOS and EOS,
   `feature lldp` on NX-OS, `lldp` on IOS-XR), and the per-interface knobs are `lldp transmit` /
   `lldp receive` - disabled by default even when LLDP is globally on.
2. The refusal for the off case is one line, `% LLDP is not enabled`, with no caret line and no neighbour
   table - on IOS-XE, IOS-XR and (per the transcript) IOS 12.2 on a 3750 alike.
3. `show lldp` is the **status** command: four lines of global information (`Status: ACTIVE`, advertisement
   interval, advertised hold time, reinitialisation delay). Neighbours are `show lldp neighbors`, which
   opens with the `Capability codes:` legend and closes with `Total entries displayed: N`.
4. The documented defaults - holdtime 120 s, timer 30 s - agree with the 120 s hold time PacketForge
   already advertises (an accidental but real match), and PacketForge has no timer to be wrong about.

## What is inferred

* A lab simulator that defaulted LLDP to *off* would answer every "what is plugged into this port?"
  question with `% LLDP is not enabled`, which defeats the tool - and the catalogue is not Cisco-only, so
  a Cisco default would have to be a per-vendor default. Always-on is a defensible simplification, but it
  is currently an **unstated** one: nothing in `docs/CLI.md` says "this model never has LLDP off".
* Because `show lldp` is aliased to the neighbour table, the simulator cannot express the status view at
  all, so it also cannot express "enabled, nothing heard yet" - an empty table and a disabled protocol
  read identically to a user who knows real IOS.

## What is unresolved

* Whether the 3750 report is a platform quirk, a release quirk, or a mis-scoped observation (that page
  itself says it does not matter operationally). No second transcript was found.
* IOS 15.x/17.x on a fixed-config Catalyst 9200/9300: `show lldp` -> `% LLDP is not enabled` is documented
  (field notice), but there is no transcript of the post-`lldp run` `show lldp` block on the same box from
  a primary source.
* Arista EOS factory default: enabled (CVX page) or disabled (LLDP chapter)? Both pages are current.
* Whether the status form, once enabled but with nothing heard, says `Total entries displayed: 0` or
  nothing extra.

## What evidence would settle it

1. One `show lldp` / `show lldp neighbors` capture from a factory-default Catalyst 9200 or 9300, before
   and after `lldp run` - three commands, one paste.
2. The same pair from an out-of-the-box EOS box (`show running-config | include lldp` decides the default
   in one line), plus an Aruba/ProCurve `show lldp` for a third vendor family.
3. A per-vendor statement in a vendor's *default configuration* reference rather than a chapter that
   assumes `lldp run` has already been typed.

## Smallest honest increment if the evidence lands

Not done here (thin and contradictory). It is three changes at once, so it is a plan rather than a
one-liner: a per-device `lldp: on|off` default in `docs/DEVICE_SCHEMA.md` (with a capability token, so
`lldp run` on a box that cannot run it is refused), a status form for `show lldp` with the table kept on
`show lldp neighbors` (39 `show lldp` call sites in `test/`), and one sentence in `docs/CLI.md` naming the
default PacketForge chose and why.

## What changed since: the status view, without the default (2026-11-17)

The two halves of this note were not equally uncertain, and the simulator only had to be wrong about one of them.
`show lldp` answering with the neighbour table is **not** a contested default - it is a view the vendor documents
and transcribes, and the console had it missing. So the status form was implemented on its own, under the
"fidelity of an existing command" rule rather than as a feature:

* `show lldp` now prints the four lines, byte for byte from the field-notice transcript quoted above -
  `Global LLDP Information:` / `    Status: ACTIVE` / advertisements every 30 s / hold time 120 s /
  reinitialisation delay 2 s (Cisco, "Troubleshoot Unknown Protocol Drops in Catalyst 9000 Switches", doc 224586,
  updated 2025-08-25). The three numbers come from `engine/lldp.js` (`DEFAULT_TX_INTERVAL_S`,
  `DEFAULT_TTL_S`, `DEFAULT_REINIT_DELAY_S`) and the test asserts `DEFAULT_TTL_S === DEFAULT_TX_INTERVAL_S * 4`,
  which is the `lldp timer` x hold-multiplier relation the TTL TLV already depended on.
* `show lldp neighbors` keeps the table, unchanged, including `Total entries displayed: N`.
* `show lldp <anything else>` refuses in one line and names `show lldp neighbors`, so the word that used to be
  silently irrelevant is now either the table or an answer.
* `Status: ACTIVE` is a statement about *this model*, not about a Cisco box out of the box: `announceLldp()` walks
  every device and there is no global switch to read. docs/CLI.md says so in as many words.

What is still open is exactly the part the evidence does not settle: whether a factory-default Cisco access switch
runs LLDP before `lldp run`, and therefore whether the honest answer for a Cisco entry in the catalogue is
`% LLDP is not enabled`. That needs a per-device `lldp on|off` in the schema plus a capability token for `lldp run`,
and it stays undone until a `show lldp` / `show lldp neighbors` / `show running-config | include lldp` capture from
one factory-default box arrives. The evidence list in "What evidence would settle it" above is unchanged.
