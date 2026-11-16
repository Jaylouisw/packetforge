# LACP with both ends `passive`: does a bundle exist, and what do the ports do then?

**Question (one, narrow).** When both ends of a two-member channel group are configured
`channel-group 1 mode passive`, does a bundle come up - and if it does not, what happens to the two physical
ports: are they dead, or do they carry traffic on their own?

**Verdict: the bundle does not exist.** Two passive ends never negotiate, so nothing is bundled; and the
members are not lost - an unnegotiated port reverts to being an ordinary single link, so traffic still crosses
the pair, over one link rather than over a bundle. PacketForge built and used the bundle anyway; it now does
not, and the spanning tree sees the two independent links that the hardware has.

## What PacketForge did before this

Two generic switches, `a -- s1 ==(Fa0/2 + Fa0/3)== s2 -- b`, a PC at each end, both ends `mode passive`:

```
1      Po1(SU)         LACP      Fa0/2(P) Fa0/3(P)      <- a bundle that cannot exist
ping 10.0.0.10  -> 3/3 echoes, frames hashed across both members
```

`channel-group` stored the mode, validated it and printed it back, and then nothing read it when the bundle
was brought up: `show etherchannel summary` and the data plane both asked only whether the cable was up
(`engine/simulator.js` forwarding, `engine/cli.js` summary). The mode was decoration.

## Evidence

| Source | Says |
| --- | --- |
| [Catalyst 9600 config guide 16.12, Configuring EtherChannels](https://www.cisco.com/c/dam/en/us/td/docs/switches/lan/catalyst9600/software/release/16-12/configuration_guide/lyr2/configuring_etherchannels.html) | "A port in the passive mode cannot form an EtherChannel with another port that is also in the passive mode because neither port starts LACP negotiation." Also: "When no response is received from an LACP peer, ports in the port channel are moved to suspended state" (CSCtn96950, standalone mode on by default), and "In the on mode, a usable EtherChannel exists only when the devices at both ends of the link are configured in the on mode." |
| [IOS XE 17 C9000 EtherChannel configuration guide](https://www.cisco.com/c/en/us/td/docs/switches/lan/c9000/lyr2-fwd/etherchannel/etherchannel-configuration-guide/m_ethernetchannel.html) | The same two bullets: active forms with active or passive; "A port in the passive mode cannot form an EtherChannel with another port that is also in the passive mode". |
| [IE4010 15.2(4)EC config guide, Configuring EtherChannels (PDF, p.1076)](https://cisco.com/c/en/us/td/docs/switches/lan/cisco_ie4010/software/release/15-2_4_EC/configuration/guide/scg-ie4010_5000/swethchl.pdf) | What happens to the member: "Incompatible ports are put into an independent state and continue to carry data traffic as would any other single link. The port configuration does not change, but the port does not participate in the EtherChannel." And for `on`: the far end "must also be configured in the on mode; otherwise, packet loss can occur." |
| [Catalyst 3750 12.2(50)SE config guide (PDF)](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst3750/software/release/12-2_50_se/configuration/guide/scg/swethchl.pdf) | The same passive/passive rule in an IOS 12.2 document, so it is not a quirk of one release train. |
| [Catalyst 9600, same chapter, `on` mode caution](https://www.cisco.com/c/dam/en/us/td/docs/switches/lan/catalyst9600/software/release/16-12/configuration_guide/lyr2/configuring_etherchannels.html) | Why the fallback matters beyond one flow: "If the group is misconfigured, packet loss or spanning-tree loops can occur." Two independent links between the same two bridges are a loop until the tree blocks one. |
| `research/etherchannel-summary-layout.md` (this repo) | The flag key this model prints - `s - suspended`, `I - stand-alone`, `P - bundled`, `D - down` - is the device's own legend, which is what makes `(s)` the right cell for a port that negotiated nothing. |

## What is known

1. Active + passive bundles, active + active bundles, `on` + `on` bundles. Passive + passive does not.
2. The unnegotiated member is *suspended*, not disabled: its configuration stays, and it forwards as a plain
   port. So a passive/passive pair still passes traffic - the operator loses the bundle, not the link.
3. Because the member becomes a plain port again, the spanning tree sees two parallel links where the bundle
   used to be one, so one of them is blocked. That is the mechanism behind the vendor's "spanning-tree loops"
   caution for a misconfigured group.
4. A group configured at one end only is a separate question, and platform-dependent: with standalone mode
   (the default since CSCtn96950) an LACP port with no responding partner goes to the *stand-alone* state
   (`I` in the summary key) rather than to `suspended`, unless `port-channel standalone-disable` is set.

## What was changed

* `engine/lag.js`: `negotiationVerdict(myMode, peerMode)` - the one rule (passive + passive) - and
  `memberSuspension(dev, iface, topo)`, which reads the far end's channel-group mode off the cable. The rule
  applies only when **both** ends name a group.
* `engine/simulator.js`: a suspended member is not grouped into `lag-N` for forwarding, and it is its own port
  to `_logicalPortName`, so the tree sees two links and blocks one.
* `engine/cli.js`: `show etherchannel summary` prints `(s)` for a suspended member, `Po1(SD)`, a per-member
  sentence naming the mode that could not negotiate, and a bundle sentence that says the members still carry
  traffic as single links instead of "traffic is dropped".
* `test/lacp-passive-both-ends.test.js`: 22 assertions - the passive/passive picture (bundle down, `(s)`
  members, frames still crossing exactly once, no hashing, one of the two links blocked), the three modes that
  do bundle, and the single-ended group left unchanged.

## What is unresolved

* **`on` against `active`/`passive`.** The evidence is unambiguous that no *usable* EtherChannel exists ("only
  when the devices at both ends are configured in the on mode"), but the two ends disagree about the same
  cable: the `on` side shows a bundle, the negotiating side suspends. This model has one opinion per member,
  not one per end, so modelling it honestly needs per-end state - not done, and not guessed.
* **A far end in no channel group at all.** Per the LACP section a lone LACP port with no partner is either
  `suspended` or `stand-alone` (`I`), depending on `port-channel standalone-disable`. Neither the knob nor the
  `I` state is modelled; a single-ended group still comes up exactly as before. The evidence would support
  "suspended", but that changes every single-sided lab and the summary's own examples, so it is a separate
  increment with its own evidence, not a side effect of this one.
* **A member's STP cost** once it falls out of the bundle. This model gives each port its full link cost
  (`_logicalPortName` is simply the port), which is what a box does once the bundle is gone; no transcript was
  found showing the `show spanning-tree` rows for that exact transition.

## What evidence would settle it

1. One `show etherchannel summary` + `show spanning-tree` capture from a pair of switches with `mode passive`
   on both ends, before and after a cable is added - three commands.
2. The same capture for `on` + `active`, which is the asymmetry above: which side prints `(P)` and which `(s)`,
   and whether the `on` side's port-channel really stays `(SU)` while carrying nothing.
3. A factory-default capture of a single-ended `mode active` group, to see whether the port reads `(I)`
   stand-alone or `(s)` suspended on current IOS XE.
