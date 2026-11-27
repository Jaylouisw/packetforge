# The Netgear multi-gig copper ports: RJ-45, and a ladder that stops where the hardware stops

**Question (one, narrow).** Issue #1398 counts template ports whose connector nothing declares.
Four Netgear specs were on that list — GS110EMX, GS728TPv3, MS510TXM and GS748T — and three of them
generate ports from a `portTemplate` that named only a rate (`type: ethernet, speed: 1G` or `2.5G`)
with no `connector` and no `speedCaps`. Their multi-gig copper uplinks were explicit ports that
named a rate and nothing else, so `inferCage()` decided both the cage and the ladder.

Does the spec say what the jack is, and does every port train at every rate the inference gave it?

**Verdict: the cage inference was right; the ladder was not.** These are copper boxes, so
`inferCage()` guessing RJ-45 never contradicted anything visible — which is the point of #1398. But
the inferred ladder is `CAGE_SPEEDS.rj45` from bottom to top, so a multi-gig port that starts at
100 Mb/s was handed **10BASE-T** as well. Before this pass, cabling a 10BASE-T-only device into
`GS110EMX/port9` *succeeded at 10 Mb/s* on a port that cannot train below 100 Mb/s:

```
PRE-FIX  port9 caps [10,100,1000,2500,5000,10000]  ->  10BASE-T link: ok, 10 Mbps
```

A silent declaration does not stay silent; it becomes a capability the hardware does not have.

## Evidence

There is no new datasheet fetch in this pass, and no URL is cited, because none was needed: the
interface rows are already transcribed in each spec's own `description` (from
`research/incoming/smb-switches.json` and `research/incoming/devices-switches-2.json`), and they
are specific about the media. What was missing was the transcription into the port itself.

| Spec | Description's Interfaces row | Template declares |
| --- | --- | --- |
| `devices/netgear/gs110emx.json` | "8x 1G RJ45 plus 2x multi-gig 100M/1G/2.5G/5G/10G RJ45 uplinks" | `rj45`, `[10,100,1000]` (8); `port9-10`: `rj45`, `[100,1000,2500,5000,10000]` |
| `devices/netgear/gs728tpv3.json` | "24x 1G RJ45 PoE+ … plus 4x dedicated 1G SFP uplinks" | `rj45`, `[10,100,1000]` (24); SFP unchanged |
| `devices/netgear/ms510txm.json` | "4x 100M/1G/2.5G and 4x 100M/1G/2.5G/5G/10G copper ports plus 2x 1G/10G SFP+ uplinks" | `rj45`, `[100,1000,2500]` (4); `port5-8`: `rj45`, `[100,1000,2500,5000,10000]` |

The two ladders agree with the media the descriptions name: `1000base-t`, `2.5gbase-t`, `5gbase-t`
and `10gbase-t` are the `engine/media.js` rows for those rates, all defined over twisted pair, and
none of them is 10BASE-T. On GS110EMX the 8 access jacks do go down to 10, which is why the template
keeps `[10,100,1000]` and the two uplinks do not.

## What was changed

* `GS110EMX` — 8-port access template gains `connector: rj45` + `[10,100,1000]`; `port9`/`port10`
  gain `connector: rj45` + `[100,1000,2500,5000,10000]`. The 10G ports are 10GBASE-T, so the spec
  now says copper at 10G instead of leaving `inferCage()` to guess at a rate it treats as ambiguous.
* `GS728TPv3` — 24-port PoE+ template gains `connector: rj45` + `[10,100,1000]`. Nothing else
  changes: `poeOut: 30` per port, the 190 W chassis budget and the four declared 1G SFP uplinks are
  untouched, and the switch still powers a PD through a copper jack.
* `MS510TXM` — 4-port 2.5G template gains `connector: rj45` + `[100,1000,2500]`; `port5`-`port8`
  gain `connector: rj45` + `[100,1000,2500,5000,10000]`. The two SFP+ uplinks already declared
  `sfp+`/`[1000,10000]` and are not touched.

`test/netgear-copper-ports.test.js` pins the declarations, the resolved ports, and the two links
that the old inference allowed and the hardware does not: 10BASE-T into GS110EMX `port9` and into
MS510TXM `port1` are now `E_NO_COMMON_SPEED`, while 10GBASE-T between the two switches still comes up
at 10000 Mb/s and a fibre cord into a copper uplink is still `E_CONNECTOR_MISMATCH`.

## What is left open

* **GS748T is deliberately not in this pass.** Its description says "48x 1G RJ45 with 2 dedicated
  1G SFP uplinks (a further 2 SFP slots are combo/shared with RJ45 ports 47-48)". If that shared
  claim holds, ports 47-48 are `combo` cages, not `rj45`: declaring them `rj45` would make the spec
  refuse a transceiver in a slot that takes one — the same class of lie as the 10BASE-T link above,
  in the opposite direction. The cage for those two positions has to be settled from a datasheet
  row first, so the report entry stays and `test/netgear-copper-ports.test.js` carries it as the one
  documented exception rather than quietly skipping it.
* **`hardware.media` is not filtered by `speedCaps`.** A port capped at `[100,1000]` still lists
  `10base-t` in `hardware.media`; `canMate()` intersects the ladders and refuses correctly
  (`E_NO_COMMON_SPEED`), so nothing wrong is accepted, but a UI or help text that prints the media
  list advertises a rate the port will not take. Engine-wide, and not this issue.
