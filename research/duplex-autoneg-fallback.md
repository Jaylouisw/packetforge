# When one end of a 10/100 link is hard-set and the other is left at `duplex auto`, what duplex does each end run?

**Question (one, narrow).** On an IOS-like switch, port A is hard-set (`speed 100` + `duplex half`, or
`duplex full`) and port B is left at its default configuration. What duplex does **B** actually run, what does
each end report, and is that link a duplex mismatch? This asks only about the *operational* duplex and the
mismatch verdict; it does not touch the `speed`/`duplex` grammar, which is already settled
(`research/speed-duplex-grammar.md`, `research/half-duplex-is-10-100.md`).

**Verdict: `duplex auto` is not "full".** A default port runs whatever the link settles on, and the vendor's
own transcripts show a defaulted port printing `Half-duplex, 100Mb/s`. Two consequences follow, and this
console gets both wrong today:

1. **auto + forced `half` is a clean half/half link.** The hard-set end kills autonegotiation on that port; the
   auto end gets no FLPs, uses parallel detection (speed only, 10/100) and falls back to **half**. Both ends
   run half, there is no mismatch and no error counter. This console calls that link a mismatch.
2. **auto + forced `full` at 10/100 is a real mismatch, but the auto end is the half-duplex one**, so the
   fault lies on the *default* port, not the configured one. This console says the opposite.

What the console does about it is in "What this console does today"; the change it would take is in "What a
minimal change would cost", and the part the evidence does not settle is at the end.

## The evidence

| Source | What it says |
| --- | --- |
| [Cisco, *Configure and Verify Ethernet 10/100/1000Mb Half/Full Duplex Auto-Negotiation*, doc 10561, updated 2025-11-06](https://www.cisco.com/c/en/us/support/docs/lan-switching/ethernet/10561-3.html), "Auto-Negotiation on Catalyst Switches that Run Cisco IOS Software" | A Catalyst 6500 with a cleared configuration, `FastEthernet3/1` connected to a peer, no `speed`/`duplex` line in `show run`: `show interfaces fastethernet 3/1 status` gives `Fa3/1 connected routed a-half a-100 10/100BaseTX` and `show interfaces fastethernet 3/1` gives **`Half-duplex, 100Mb/s`**. The `a-` prefix "indicate[s] that this port is not hard coded (configured) for a specific duplex mode or speed". |
| same page, "Auto-Negotiation on Catalyst Switches that Run Cisco IOS Software" | "**Note**: If you hard code the speed on a port, it disables all auto-negotiation functionality on the port for speed and duplex." |
| same page, Appendix E, FAQ 5 and FAQ 6 | "Why does a port not detect the correct duplex mode when the link partner is not configured for auto-negotiation? **The port does not detect it because there is no method available to perform this.**" / "Why is it possible to have link show connected when the two ports have different duplex modes configured? ... the electrical signals the ports use to determine if they are connected do not track the status of the duplex modes." |
| same page, "Understanding Data Link Errors" | Mismatch symptoms, per counter: `Late-Col` "is seen on the half-duplex side"; `FCS-Err`, `Runts` and `Align-Err` "can also indicate a duplex mismatch". `collisions` "must not be seen on full duplex interfaces". |
| same page, duplex-mismatch message | `%CDP-4-DUPLEX_MISMATCH: duplex mismatch discovered on GigabitEthernet2/0/20 (not half duplex), with XXXXX GigabitEthernet0 (half duplex)` - and "this message is created by the Cisco Discovery Protocol (CDP), not the 802.3 auto-negotiation protocol". |
| [Cisco, *Troubleshoot Catalyst Switches to NIC Compatibility Issues*, doc 17053](http://www.cisco.com/c/en/us/support/docs/switches/catalyst-6500-series-switches/17053-46.html), "Why Do Autonegotiation and Compatibility Issues Exist?" | "a manual setup of the speed and duplex for full-duplex on one link partner results in a duplex mismatch. This happens when you disable autonegotiation on one link partner **while the other link partner defaults to a half-duplex configuration**." Also: "When autonegotiation is disabled, the default value for duplex is half-duplex, unless the 0.8 is programmed to 1". |
| [Cisco, *Troubleshooting Ethernet* (Internetworking Troubleshooting Handbook, ch. 4)](https://www.cisco.com/en/US/docs/internetworking/troubleshooting/guide/tr1904.html) | "A backup alternative, called parallel detection, works for 10/100 speeds if autonegotiation is disabled or is unsupported. ... The interface capable of autonegotiation will configure itself for bare bones 10-Mbps half-duplex operation." (10 Mb/s is the degenerate case; at 100 Mb/s parallel detection recovers the *speed* and leaves duplex at half.) |
| [Cisco, Catalyst 2960-X Consolidated Platform Command Reference 15.2(6)E, Interface and Hardware Commands, `duplex`](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15_2_6_e/command_reference/b_1526_2960x_cr/interface_and_hardware_commands.html) | "If the speed is set to **auto**, the switch negotiates with the device at the other end of the link for the speed setting and then forces the speed setting to the negotiated value. **The duplex setting remains as configured on each end of the link**, which could result in a duplex setting mismatch." Also the default: "The default is **auto** for Fast Ethernet and Gigabit Ethernet ports." |
| same book, `show interfaces` example | A down 10/100/1000 port prints `Auto-duplex, Auto-speed, media type is 10/100/1000BaseTX` - i.e. with no link the port shows the *setting*, not a rate. |

## The transcript that settles it

Doc 10561's first example, verbatim, is the whole answer to "is `auto` a synonym for full":

```
NativeIOS#show interfaces fastethernet 3/1 status

Port Name Status Vlan Duplex Speed Type
Fa3/1 connected routed a-half a-100 10/100BaseTX

NativeIOS#show run
...
!
interface FastEthernet3/1
ip address 172.16.84.110 255.255.255.0
!
NativeIOS#show interfaces fastethernet 3/1
FastEthernet3/1 is up, line protocol is up
...
Half-duplex, 100Mb/s
```

No `duplex` line under the interface, and the port runs half. So on a box, the *configured* state (`auto`), the
*negotiated* rate (`100`), and the *operational* duplex (`half`) are three different facts, and only the first
is what `show running-config` shows. `show interfaces status` reports the operational duplex with an `a-` prefix
while the port is autonegotiating (`a-half`, `a-full`), and `show interfaces` reports the operational duplex
alone.

## What this console does today

`duplex auto` is collapsed at config time into `full` - "what a link decides in this engine is full duplex"
(`engine/cli.js:3043-3044`) - so the `auto` state is not stored anywhere: `speedMbps` has a `null` meaning
"automatic", `duplex` does not. Everything downstream therefore reads "full" as "full or auto":

| Surface | Where | What it says for a defaulted port |
| --- | --- | --- |
| the port model | `Interface.duplex = 'full'` (`engine/device.js:85`), restored from a saved port at `:1604` | `full` |
| `show interfaces` | `_linkRateLine()` appends `duplex: ' + (iface.duplex \|\| 'full')` (`engine/cli.js:5175`) | `duplex: full`, whether or not there is a link |
| `show running-config` | prints the line only when it differs from `full` (`engine/cli.js:6773`) | (no line) - correct, `auto` is the default |
| link verdict | `W_DUPLEX_MISMATCH` compares the two ports' *configured* duplex strings (`engine/validation.js:889-898`, fed from `engine/topology.js:400-401`) | see below |
| the API | `duplex: i.duplex` per port (`engine/device.js:1443`) | `full` |

Measured on `1c91302c` with two `C2960X-24TS-L`, `Gi1/0/1` cabled to `Gi1/0/1`, after `speed 100` +
`duplex half` on sw1 only:

```
sw1# show interfaces Gi1/0/1
  speed: 100Mb/s (forced), duplex: half
sw2# show interfaces Gi1/0/1
  speed: 1Gb/s (auto), link runs at 100Mb/s, duplex: full
```

and the link verdict:

```
W_DUPLEX_MISMATCH  Catalyst 2960X-24TS-L/Gi1/0/1 is half-duplex but Catalyst 2960X-24TS-L/Gi1/0/1 is
                   full-duplex; the link will fall back or error.
```

Three claims in that output contradict the sources above: sw2 is not `full` (it is an autonegotiating port
with no FLP to answer it, so it is `half`); the link does not "fall back or error" - it *is* the fallback, and
it works; and the sentence blames the configured port for a mismatch that, when it happens at all, is caused
by the default port. `docs/CLI.md:968-971` states the same intent ("Force one end to half against a
full-duplex peer and it fires"), so the defect is in the rule, not in the documentation of it.

## What is inferred (the rule a simulator should keep)

1. **Configured, negotiated, operational are three fields.** Only `auto` needs a home in the model; the rate
   already has one (`speedMbps === null` means auto-negotiate, `engine/media.js`).
2. **Resolve the operational duplex per link, at the two ends separately**: a port hard-set to `full`/`half`
   keeps it (doc 10561: hard-coding speed "disables all auto-negotiation functionality ... for speed and
   duplex"; the 2960-X note: "the duplex setting remains as configured on each end"). A port at `auto` takes
   `full` if the peer is also `auto` or forced `full` at 1000 Mb/s, and **`half` if the link runs at 10/100 and
   the peer is hard-set** (parallel detection, docs 17053 and 10561 FAQ 5).
3. **The warning belongs on the resolved pair, not the typed pair** - which makes `auto` + forced `half`
   silent (both ends half) and `auto` + forced `full` a mismatch naming the `auto` end as the half-duplex one.
   The half-duplex side is where `Late-Col` climbs (`tests`/counters are out of scope here - this console has no
   collision counter).
4. **`show interfaces` should print the setting when there is no link and the operational value when there is**
   - that is the 2960-X pair `Auto-duplex, Auto-speed` (no link) versus `Half-duplex, 100Mb/s` (linked).

## What a minimal change would cost - needs Jay's approval

Storing `auto` (rather than adding a second boolean) is one field-value change with four readers:

* `engine/device.js:85` default `'full'` -> `'auto'`; `:1604` already accepts any string from a document, so a
  saved `duplex: "full"` keeps meaning *forced* full and loads as such - a behaviour change for every existing
  saved lab, which is the argument for doing this deliberately rather than in passing.
* `engine/cli.js:3044` stops rewriting `auto` to `full` (and the acknowledgement at `:3047` loses its
  `auto (full)` gloss); `:5175` and `:6752` read the resolved value and the configured value respectively.
* `engine/validation.js:893` compares resolved duplices; `engine/lag.js:459` compares configured ones (a
  member at `auto` beside a member at `full` is not a bundle inconsistency on a box - both run full - but is
  already a *speed* question the bundle's own rule answers).
* 14 test files mention `duplex`; `test/port-roundtrip.test.js:296` and `test/speed-duplex.test.js` pin the
  current `'full'` after `duplex auto`, so both need re-aiming at `'auto'` plus an operational assertion.

That is a schema decision about saved documents, so it is a step for a plan with Jay's call, not something to
land on the strength of this note.

## What remains unresolved

* **A 10/100/1000 port hard-set to `speed 1000` + `duplex full`, facing a defaulted port.** Doc 10561 says
  hard-coding *speed* disables autonegotiation on that port, which would leave the auto end with no FLPs - and
  parallel detection is a 10/100 mechanism, so nothing establishes duplex. In practice such links come up
  `a-full a-1000`. Settle it with a 2960-X pair: defaults on one end, `speed 1000` + `duplex full` on the
  other, then `show interfaces status` and `show interfaces` on both.
* **Whether two autonegotiating 10/100 ports can land on half.** Doc 10561's 6500 example shows `a-half` with
  both ends defaulted, which the "highest common capability wins" rule does not explain unless the far end
  advertised half only. A transcript naming the *peer's* setting would separate "one NIC advertised half" from
  "these switches prefer half".
* **What `duplex auto` types into `show running-config` on a 2960-X.** The default is not printed by default,
  but whether an explicitly typed `duplex auto` is stored is not shown by any transcript in hand. It decides
  whether this console's "print the line only when it differs from the default" rule is enough.
* Not researched here: collision/late-collision counters, `show interfaces counters errors`, and
  `%CDP-4-DUPLEX_MISMATCH` as a console message. Each is a separate question, and the last one needs CDP in the
  engine, which it does not have.
