# A channel group configured at one end only: does a bundle form, and what happens to the port?

**Question (one, narrow).** With `channel-group 1 mode active` on two ports of one switch and **no channel
group at all** on the ports at the other end of those cables, does a bundle come up — and if it does not,
does the configured port stop forwarding, or does it go on carrying traffic as an ordinary single link?

**Verdict: no bundle, and the port keeps carrying.** LACP is a conversation; a far port that never configured
a channel group never sends and never answers an LACPDU, so the near end's negotiation comes back empty. The
vendor's own description of what happens next is that the port is put into an *independent* state and
"continues to carry data traffic as would any other single link". PacketForge built the bundle anyway and
hashed frames across two links the far end saw as unrelated single ports. It now does not: `show etherchannel
summary` reads `Po1(SD)` with the members `(I)` stand-alone, the ping still crosses, and the spanning tree
sees the single links that exist.

## What PacketForge did before this

Same lab as `research/lacp-passive-both-ends.md`: `a -- s1 ==(Fa0/2 + Fa0/3)== s2 -- b`, `mode active` on
s1's two ports, nothing configured on s2's:

```
1      Po1(SU)         LACP      Fa0/2(P) Fa0/3(P)      <- a bundle one end of which knows nothing about it
ping 10.0.0.10  -> 3/3 echoes, frames hashed onto lag-1
```

The mode was read for the passive/passive pair and then the rule stopped: `memberSuspension()` returned
`null` the moment the far port had no channel group, because the previous increment had recorded the
single-ended case as a separate question rather than guess at it (`research/lacp-passive-both-ends.md`,
"What is unresolved"). That left the commonest misconfiguration in a lab — one end configured, the other not
— as the one case the model got wrong.

## Evidence

| Source | Says |
| --- | --- |
| [Catalyst 2960 configuration guide 12.2(46)SE, *Configuring EtherChannels* (PDF)](http://cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/12-2_46_se/configuration/guide/scg1/swethchl.pdf) | "When you configure one end of an EtherChannel in either PAgP or LACP mode, the system negotiates with the other end of the channel to determine which ports should become active. Incompatible ports are suspended. Beginning with Cisco IOS Release 12.2(35)SE, instead of a suspended state, the local port is put into an independent state and continues to carry data traffic as would any other single link. The port configuration does not change, but the port does not participate in the EtherChannel." |
| [Catalyst 3750X configuration guide 15.2(1)E (PDF)](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst3750x_3560x/software/release/15-2_1_e/configuration/guide/scg3750x/swethchl.pdf) | The same sentence on a second IOS platform: "If the remote port cannot negotiate an EtherChannel, the local port is put into an independent state and continues to carry data traffic as would any other single link." Also the standalone knob: "When LACP standalone is disabled on the EtherChannel, all traffic arriving on A is blocked (the default behavior on a switch)" — so `suspended` there means blocked, not forwarding. |
| [Catalyst 2960-X configuration guide 15.2(5)E (PDF)](https://cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_5_e/configuration_guide/b_1525e_consolidated_2960x_cg/b_1525e_consolidated_2960x_cg_chapter_010010.pdf) | The pair rule for the other protocol, and the caution for `on`: "In the **on** mode, a usable EtherChannel exists only when the switches at both ends of the link are configured in the **on** mode ... otherwise, packet loss can occur." |
| [Catalyst 9300 Layer 2 configuration guide 17.17, *Configuring EtherChannels*](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-17/configuration_guide/lyr2/b_1717_lyr2_9300_cg/configuring_etherchannels.html) | IOS XE words the same event differently: "When no response is received from an LACP peer, ports in the port channel are moved to suspended state." And, of the knob that changes it: "In the standalone mode the port is not bundled in an EtherChannel. The port functions as a standalone data port and it can send and receive BPDUs and data traffic." The same page says both "With CSCtn96950, by default, standalone mode is enabled" and, in a note, "LACP standalone mode is disabled by default". |
| [Catalyst 9200 17.14, same chapter](https://cisco.com/c/en/us/td/docs/switches/lan/catalyst9200/software/release/17-14/configuration_guide/lyr2/b_1714_lyr2_9200_cg/configuring_etherchannels.html) / [Catalyst 9600 17.13](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9600/software/release/17-13/configuration_guide/lyr2/b_1713_lyr2_9600_cg/configuring_etherchannels.html) | The same paragraphs in both release trains, so the IOS XE wording is not one document's slip. The 9200 page also carries the summary sample with the key line `I - stand-alone s - suspended`. |
| [`show etherchannel summary` flag key, Catalyst SD-WAN 26.x interface guide](http://cisco.com/c/en/us/td/docs/routers/sdwan/26x-later/interfaces/interfaces-configuration-guide/ether-channels/monitor-configured-etherchannel-using-cli.html) | The key this console prints, from the vendor: `I - stand-alone  s/susp - suspended`. Two letters, two states. |
| Practitioner troubleshooting table, [netstuts, *Troubleshooting EtherChannel on Cisco IOS*](https://netstuts.com/StepbyStepTut/troubleshooting-etherchannel) | A capture of the shape this rule predicts: `1 Po1(SD) LACP Gi0/1(I) Gi0/2(I) Gi0/3(I) Gi0/4(I)` — "all member ports show (I) — stand-alone ... the classic signature of a negotiation failure". Cited as corroboration only: a third-party page is not the authority the vendor guides above are. |

## What is known

1. **No partner, no bundle.** Every source above describes one end negotiating with the *other end*; a port
   in no channel group does not run LACP at all, so there is nothing to negotiate with. `Po1` therefore
   stays down (`SD`) however many members are configured on the near side.
2. **The port is not disabled.** The 2960 and 3750 chapters both state that it moves to an independent
   state and keeps carrying traffic as a single link; the port's configuration is unchanged, it simply does
   not take part in the bundle. This is also why the model's spanning tree has to see two links, not one:
   the loop a misconfigured group makes is real, and is the reason the same chapters warn about "spanning-tree
   loops".
3. **`on` is a different mode, not a different amount of the same thing.** It negotiates nothing, so the
   switch forces the bundle up regardless of the far end, and the vendor's warning for that pair is "packet
   loss can occur" rather than "no bundle". A one-ended `on` group therefore still reads `Po1(SU)` here, and
   the loss it causes in this model (frames hashed onto a member the spanning tree has blocked at the far
   end) is the vendor's caution happening.
4. **The two platform generations disagree about the flag, not about the bundle.** IOS 12.2/15.2 on the
   2960/3750 calls the forwarding state *independent* (`I - stand-alone` in the key); IOS XE 17.x calls the
   non-negotiated member *suspended* and blocks its traffic unless `no port-channel standalone-disable` is
   configured. The model follows the 2960/3750 generation on the behaviour — the port forwards — so it uses
   the letter that generation uses for it, `(I)`. `(s)` is the key's word for a member that is *not*
   carrying, and this model's member is.

## What changed

* `engine/lag.js` — `memberSuspension()` no longer returns `null` when the far port has no channel group. If
  the member's own mode is `active` or `passive` the member is out of the bundle, with the reason "the far
  end is in no channel group: nothing there answers LACP". `mode on` is untouched: it never asked a question.
* `engine/cli.js` — the summary prints `(I)` for a member that is out of the bundle and the note line reads
  "is stand-alone ... - the port still carries traffic, as a single link rather than as a member of Po1".
  The same letter is used for the passive/passive pair, which is the same physical state reached another way.
* `test/lacp-one-sided-group.test.js` — 34 assertions: both negotiating modes singled-ended (bundle down,
  both members `(I)`, the reason naming the missing group, the ping still crossing exactly once, no hashing,
  the tree blocking one of the two parallel links, the far end counting no groups, the mode still in the
  configuration); one-sided `on` still `(SU)` with `(P)`; two configured ends still bundling and still
  hashing; and a member whose peer is a PC (a port that cannot name a group at all).
* `test/lacp-passive-both-ends.test.js` (20 assertions) and `test/etherchannel-summary-layout.test.js`
  (34 assertions) — the first follows the `(I)` letter, the second now configures its far end so its layout
  assertions still describe a working bundle. `test/lag-mode.test.js` likewise configures both ends.
* `docs/CLI.md` — the "negotiated nothing" section covers both ways to lose the negotiation and states why the
  letter is `I`; `docs/SIMULATION.md`'s fidelity table names both test files.

## What remains unresolved

* **The letter on IOS XE-generation platforms.** A 9300 with default settings suspends the member and blocks
  it, which is `(s)` and no traffic — the opposite pair from the 2960/3750 pair this model chose. Nothing
  public says which generation an "IOS-like" simulator should follow, so this stayed a documented choice
  rather than a rule: the model forwards, therefore it prints `I`.
* **`port-channel standalone-disable`.** The knob that selects between the two states is not modelled, and
  neither is `lacp suspend-individual` on Nexus. Adding either means a per-platform default, which is the
  decision above.
* **Why the far end is not a partner.** This rule treats "no channel group", "a PC", "a router port" and "an
  unconfigured switch port" alike, which is right for LACP, but it does not model the other ways two
  configured members can fail to bundle: mismatched LACP keys (different group numbers), mismatched speeds,
  different access VLANs, mismatched trunk settings. Those are `(s)`-and-blocked cases on a real box, and
  `validateLag()` warns about some of them without the data plane acting on it.
* **A one-ended `on` group.** Each end has its own opinion of the same cable (the `on` side shows `(SU)` with
  `(P)` members, the far side shows a plain access port), which needs per-end state this model does not have
  — the same asymmetry `research/lacp-passive-both-ends.md` records.
* **The spanning tree's cost for the stand-alone link.** The port falls back to its own link cost; no
  transcript was found showing the `show spanning-tree` rows across that transition.

## What evidence would settle it

1. `show etherchannel summary` from a factory-default 2960 (or 2960-X on 15.2) with `channel-group 1 mode
   active` on two ports facing an unconfigured switch: does it read `(I)` or `(s)`? That single capture
   settles both the letter and the state, and would either confirm this change or replace `I` with `s` in one
   place (`engine/cli.js`) plus the two tests.
2. The same capture from a Catalyst 9300 on 17.x with default settings, to see whether the standalone knob is
   on or off out of the box — the one point where the vendor's own page contradicts itself.
3. A capture of the one-ended `on` case, for the per-end asymmetry above: which side reads `(SU)` and what the
   far end's port shows while it is dropping hashed frames.
